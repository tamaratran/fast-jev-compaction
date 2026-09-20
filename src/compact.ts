import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.15,
  keepCallThreshold: 0.05,
  keepResultThreshold: 0.15,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 64_000,
  truncateHeadChars: 300,
  maxMessageTextChars: 2000,
  compactDialogue: 'auto',
  minReductionRatio: 0.20,
  cacheFriendly: true,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const keepThreshold = finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold);
  const maxStateTokens = Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens));
  if (maxStateTokens > 32_000) {
    throw new Error(`maxStateTokens (${maxStateTokens}) exceeds Jev limit of 32000 tokens`);
  }
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold,
    keepCallThreshold: finite(options.keepCallThreshold, DEFAULT_OPTIONS.keepCallThreshold),
    keepResultThreshold: finite(options.keepResultThreshold, keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens,
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    maxMessageTextChars: Math.max(
      100,
      Math.floor(finite(options.maxMessageTextChars, DEFAULT_OPTIONS.maxMessageTextChars)),
    ),
    compactDialogue: options.compactDialogue ?? DEFAULT_OPTIONS.compactDialogue,
    minReductionRatio: Math.max(
      0,
      finite(options.minReductionRatio, DEFAULT_OPTIONS.minReductionRatio),
    ),
    cacheFriendly: options.cacheFriendly ?? DEFAULT_OPTIONS.cacheFriendly,
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call \`${call.id}\` (\`${call.tool}\`) should stay in the history: knowing this call was made with its input still matters for what the assistant does next`,
      criteria: {
        true: `The call changed state (file edit/write, git mutation, shell command with side effects), failed with an active error being debugged, or is necessary context for what the assistant does next.`,
        false: `The call was an informational query (search, file read, directory listing, status check) whose information has already been acted on, superseded, or is no longer needed.`,
      },
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call \`${call.id}\` (\`${call.tool}\`, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
      criteria: {
        true: `The verbatim output contains specific error diagnostics being addressed, active diffs, unique generated data, or outputs that cannot be re-fetched without side effects.`,
        false: `The output is routine success logs, spent file content that has since been modified or superseded, or data that is readily re-fetched if needed.`,
      },
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'> &
    Partial<Pick<ResolvedCompactOptions, 'keepCallThreshold' | 'keepResultThreshold'>>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  const resultThreshold = options.keepResultThreshold ?? options.keepThreshold;
  const callThreshold = options.keepCallThreshold ?? DEFAULT_OPTIONS.keepCallThreshold;
  if (answer.keepResult >= resultThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= callThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/** Abridges long unpinned message text with an omitted note, preserving head and tail. */
function abridgeMessageText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = 400;
  const tail = 200;
  if (text.length <= head + tail + 50) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[... fast-jev-compaction omitted ${omitted} chars of dialogue text ...]\n${text.slice(-tail)}`;
}

export function compactDialogueMessages(
  messages: readonly Message[],
  preserveRecentMessages: number,
  maxMessageTextChars: number,
): Message[] {
  const total = messages.length;
  return messages.map((msg, index) => {
    if (index === 0 || index >= total - preserveRecentMessages) {
      return msg;
    }
    if (msg.text.length <= maxMessageTextChars) {
      return msg;
    }
    const text = abridgeMessageText(msg.text, maxMessageTextChars);
    if (text === msg.text) return msg;
    return {
      ...msg,
      text,
    };
  });
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. When tool compaction achieves
 * less than `minReductionRatio` or tool candidates are exhausted, unpinned
 * dialogue text can be abridged to break text-floor deadlocks.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages, {
    cacheFriendly: resolved.cacheFriendly,
  });
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);
  const textCharsBefore = messages.reduce((sum, message) => sum + message.text.length, 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  let kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  let charsAfter = kept.reduce((sum, message) => sum + messageChars(message), 0);
  let ratio = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
  let dialogueCompacted = false;

  const shouldCompactDialogue =
    resolved.compactDialogue === true ||
    (resolved.compactDialogue === 'auto' &&
      (ratio < resolved.minReductionRatio || candidates.length === 0) &&
      textCharsBefore > resolved.maxMessageTextChars);

  if (shouldCompactDialogue) {
    const textKept = compactDialogueMessages(
      kept,
      resolved.preserveRecentMessages,
      resolved.maxMessageTextChars,
    );
    const newCharsAfter = textKept.reduce((sum, message) => sum + messageChars(message), 0);
    if (newCharsAfter < charsAfter) {
      kept = textKept;
      charsAfter = newCharsAfter;
      dialogueCompacted = true;
    }
  }
  const textCharsAfter = kept.reduce((sum, message) => sum + message.text.length, 0);

  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter,
      textCharsBefore,
      textCharsAfter,
      dialogueCompacted,
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
