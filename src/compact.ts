import { applyDecisions, messageChars } from './apply.js';
import { mapLimit } from './limit.js';
import { choiceProbabilities, wasTruncated } from './request.js';
import { collectToolCalls, fitCallState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  LayaAsker,
  LayaQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 400,
  truncateHeadChars: 300,
  concurrency: 4,
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function wholeAtLeast(value: number | undefined, fallback: number, min: number): number {
  return Math.max(min, Math.floor(finite(value, fallback)));
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: wholeAtLeast(
      options.preserveRecentMessages,
      DEFAULT_OPTIONS.preserveRecentMessages,
      0,
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    truncateHeadChars: wholeAtLeast(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars, 0),
    concurrency: wholeAtLeast(options.concurrency, DEFAULT_OPTIONS.concurrency, 1),
  };
}

export const FATES = ['keep', 'truncate', 'drop'] as const;

/**
 * The one `choice` question asked about every call; the state says which
 * call. A choice spreads its probabilities far more than two `noul` questions
 * did on Laya, and one question per call halves the inference time.
 */
export const CALL_QUESTIONS: LayaQuestions = {
  fate: {
    type: 'choice',
    instructions: 'What should happen to this tool call when the conversation is compacted?',
    criteria: {
      keep: 'Keep the call and its full output: the assistant still needs the output contents',
      truncate: 'Keep the call but cut its output: knowing it ran matters, the contents no longer do',
      drop: 'Delete the call and its output: it is obsolete, superseded by a later call, or unrelated to the goal',
    },
  },
};

/** Maps the choice onto the two keep probabilities the decision rule reads. */
export function answerFromFate(fate: Record<(typeof FATES)[number], number>): CallAnswer {
  return { keepCall: fate.keep + fate.truncate, keepResult: fate.keep };
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

type Asked = { id: string; answer: CallAnswer; tokens: number; truncated: boolean };

async function askCall(
  asker: LayaAsker,
  messages: readonly Message[],
  calls: readonly ToolCall[],
  call: ToolCall,
  options: ResolvedCompactOptions,
): Promise<Asked> {
  const fitted = fitCallState(messages, calls, call, options);
  const response = await asker.ask(fitted.state, CALL_QUESTIONS);
  const fate = choiceProbabilities(response.answers, 'fate', FATES);
  return {
    id: call.id,
    answer: answerFromFate(fate),
    tokens: fitted.tokens,
    truncated: wasTruncated(response),
  };
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Laya, for every tool call outside the pinned
 * first and newest messages, whether to keep it, cut its output or drop it. Each call gets its own small state (goal, nearby messages, input,
 * output preview, later calls) so it fits the checkpoint window, and the
 * requests run `concurrency` at a time. Throws when any request fails; the
 * caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: LayaAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  const asked = await mapLimit(candidates, resolved.concurrency, (call) =>
    askCall(asker, messages, calls, call, resolved),
  );
  const answers = new Map(asked.map((a) => [a.id, a.answer]));

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      maxStateTokens: Math.max(0, ...asked.map((a) => a.tokens)),
      requests: asked.length,
      truncatedRequests: asked.filter((a) => a.truncated).length,
      ms: Date.now() - started,
    },
  };
}
