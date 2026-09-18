import { JevError, JevResponseError, hasNoul } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAnswer,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  Sleep,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  retries: 2,
  retryDelayMs: 500,
  onBatchFailure: 'throw',
  sleep: defaultSleep,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/** A timer where the host has one; no wait at all where it does not. */
function defaultSleep(ms: number): Promise<void> {
  const host = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };
  const timer = host.setTimeout;
  const nothingToWait = ms <= 0;
  const noTimer = typeof timer !== 'function';
  if (nothingToWait || noTimer) return Promise.resolve();
  return new Promise((resolve) => timer(resolve, ms));
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A finite value no smaller than `min`, or the fallback. */
function atLeast(min: number, value: number | undefined, fallback: number): number {
  return Math.max(min, finite(value, fallback));
}

/** A finite whole number no smaller than `min`, or the fallback. */
function wholeAtLeast(min: number, value: number | undefined, fallback: number): number {
  return Math.max(min, Math.floor(finite(value, fallback)));
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const d = DEFAULT_OPTIONS;
  return {
    goal: options.goal ?? d.goal,
    keepThreshold: finite(options.keepThreshold, d.keepThreshold),
    preserveRecentMessages: wholeAtLeast(0, options.preserveRecentMessages, d.preserveRecentMessages),
    maxStateTokens: atLeast(1, options.maxStateTokens, d.maxStateTokens),
    maxRequestTokens: atLeast(1, options.maxRequestTokens, d.maxRequestTokens),
    truncateHeadChars: wholeAtLeast(0, options.truncateHeadChars, d.truncateHeadChars),
    retries: wholeAtLeast(0, options.retries, d.retries),
    retryDelayMs: atLeast(0, options.retryDelayMs, d.retryDelayMs),
    onBatchFailure: options.onBatchFailure === 'keep' ? 'keep' : d.onBatchFailure,
    sleep: options.sleep ?? d.sleep,
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
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
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/**
 * A failure worth another attempt: a 429/5xx, or the transport failing before
 * a status came back (not an abort, not an unparsable URL). A missing key, a
 * malformed body, any other 4xx, or an unrecognised error is not.
 */
function transient(error: unknown): boolean {
  return error instanceof JevError && error.retryable;
}

/** What `onBatchFailure: 'keep'` may keep: a hiccup that outlived its retries, or a bad answer. */
function keepable(error: unknown): boolean {
  return transient(error) || error instanceof JevResponseError;
}

type Asked =
  | { ok: true; answers: Record<string, JevAnswer>; retries: number }
  | { ok: false; error: unknown; retries: number };

/** One attempt: the answers, or whatever the asker threw. */
async function attemptAsk(
  asker: JevAsker,
  state: CompactionState,
  questions: JevQuestions,
): Promise<{ answers: Record<string, JevAnswer> } | { error: unknown }> {
  try {
    const { answers } = await asker.ask(state, questions);
    return { answers };
  } catch (error) {
    return { error };
  }
}

/** Waits `ms`; resolves with the rejection when the wait is interrupted. */
async function waitOrInterrupt(sleep: Sleep, ms: number): Promise<unknown> {
  try {
    await sleep(ms);
    return undefined;
  } catch (interrupted) {
    return interrupted;
  }
}

/** One request with its retries; never throws, the retries spent are reported either way. */
async function askWithRetries(
  asker: JevAsker,
  state: CompactionState,
  questions: JevQuestions,
  options: Pick<ResolvedCompactOptions, 'retries' | 'retryDelayMs' | 'sleep'>,
): Promise<Asked> {
  let delay = options.retryDelayMs;
  for (let attempt = 0; ; attempt++) {
    const attempted = await attemptAsk(asker, state, questions);
    if ('answers' in attempted) return { ok: true, answers: attempted.answers, retries: attempt };
    const exhausted = attempt >= options.retries;
    const giveUp = exhausted || !transient(attempted.error);
    if (giveUp) return { ok: false, error: attempted.error, retries: attempt };
    const interrupted = await waitOrInterrupt(options.sleep, delay);
    if (interrupted !== undefined) return { ok: false, error: interrupted, retries: attempt };
    delay *= 3;
  }
}

/** One call's two answers, or the names of the ones that are missing or malformed. */
function readCallAnswer(
  answers: Record<string, JevAnswer>,
  call: ToolCall,
): { answer: CallAnswer } | { invalid: string[] } {
  const callName = `call_${call.id}`;
  const resultName = `result_${call.id}`;
  const invalid = [callName, resultName].filter((name) => !hasNoul(answers[name]));
  if (invalid.length > 0) return { invalid };
  return {
    answer: {
      keepCall: (answers[callName] as { noul: number }).noul,
      keepResult: (answers[resultName] as { noul: number }).noul,
    },
  };
}

type Batched =
  | { ok: true; answers: Map<string, CallAnswer>; retries: number }
  | { ok: false; error: unknown; retries: number };

/**
 * One batch: its questions asked, its answers read. A batch is all-or-nothing:
 * one missing or malformed answer fails the whole batch with the names listed.
 */
async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'retries' | 'retryDelayMs' | 'sleep'>,
): Promise<Batched> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const asked = await askWithRetries(asker, state, questions, options);
  if (!asked.ok) return asked;
  const answers = new Map<string, CallAnswer>();
  const invalid: string[] = [];
  for (const call of batch) {
    const read = readCallAnswer(asked.answers, call);
    if ('answer' in read) answers.set(call.id, read.answer);
    else invalid.push(...read.invalid);
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      retries: asked.retries,
      error: new JevResponseError(`Invalid Jev answer for ${invalid.join(', ')}`, invalid),
    };
  }
  return { ok: true, answers, retries: asked.retries };
}

/**
 * Asks every batch (askBatch never rejects) and merges what came back. Under
 * `keep` a batch that outlived its retries or came back malformed is counted
 * and its calls are left unanswered (so kept); anything else, and every
 * failure under `throw`, rejects with the actionable error first.
 */
async function askBatches(
  asker: JevAsker,
  state: CompactionState,
  batches: readonly ToolCall[][],
  options: ResolvedCompactOptions,
): Promise<{ answers: Map<string, CallAnswer>; retries: number; failedBatches: number }> {
  const outcomes = await Promise.all(
    batches.map((batch) => askBatch(asker, state, batch, options)),
  );
  const answers = new Map<string, CallAnswer>();
  const failures: unknown[] = [];
  let retries = 0;
  let failedBatches = 0;
  for (const outcome of outcomes) {
    retries += outcome.retries;
    if (outcome.ok) {
      for (const [id, answer] of outcome.answers) answers.set(id, answer);
      continue;
    }
    const salvageable = options.onBatchFailure === 'keep' && keepable(outcome.error);
    if (salvageable) failedBatches++;
    else failures.push(outcome.error);
  }
  if (failures.length > 0) {
    const actionable = failures.find((error) => !transient(error));
    throw actionable ?? failures[0];
  }
  return { answers, retries, failedBatches };
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

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  let asked = { answers: new Map<string, CallAnswer>(), retries: 0, failedBatches: 0 };
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    asked = await askBatches(asker, state.state, batches, resolved);
  }
  const decisions = calls.map((call) =>
    decideCall(call, asked.answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      ...countMessages(messages, kept, charsBefore),
      ...countDecisions(calls, decisions),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      retries: asked.retries,
      failedBatches: asked.failedBatches,
      ms: Date.now() - started,
    },
  };
}

function countMessages(
  before: readonly Message[],
  after: readonly Message[],
  charsBefore: number,
): Pick<CompactResult['stats'], 'messagesBefore' | 'messagesAfter' | 'charsBefore' | 'charsAfter'> {
  return {
    messagesBefore: before.length,
    messagesAfter: after.length,
    charsBefore,
    charsAfter: after.reduce((sum, message) => sum + messageChars(message), 0),
  };
}

function countDecisions(
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
): Pick<CompactResult['stats'], 'calls' | 'kept' | 'resultsDropped' | 'callsDropped' | 'pinned'> {
  return {
    calls: calls.length,
    kept: count(decisions, 'kept'),
    resultsDropped: count(decisions, 'result_dropped'),
    callsDropped: count(decisions, 'call_dropped'),
    pinned: count(decisions, 'pinned'),
  };
}
