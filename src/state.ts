import type { CallState, FittedState, Message, ResolvedCompactOptions, ToolCall } from './types.js';

export const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. This state describes one tool call: the messages around it, its input, and the start of its output. Anything not kept is deleted, but the assistant can re-run the tool.';

/**
 * Successive character caps for each part of a call's state, roomiest first.
 * `fitCallState` takes the first level whose estimate fits.
 */
export const STATE_LEVELS = [
  { goal: 600, text: 500, messages: 2, input: 400, preview: 600, later: 8 },
  { goal: 400, text: 300, messages: 2, input: 250, preview: 350, later: 6 },
  { goal: 300, text: 200, messages: 1, input: 160, preview: 200, later: 4 },
  { goal: 200, text: 120, messages: 1, input: 100, preview: 100, later: 3 },
  { goal: 120, text: 80, messages: 1, input: 60, preview: 40, later: 2 },
] as const;

type Level = (typeof STATE_LEVELS)[number];

const TOKEN_PIECES = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+|\s+|[^\sA-Za-z\d]/g;

/**
 * Estimates Laya tokens (the ModernBERT BPE tokenizer of every checkpoint)
 * without loading it. Text is split into word parts (a capitalised run or an
 * uppercase run, so camelCase splits), digit runs, whitespace runs and single
 * symbols. A word part costs one token, a digit run 1.55, a whitespace run
 * holding a newline one, other whitespace runs 0.6 (a lone space is free, it
 * merges into the next token) and a symbol 0.65, all raised 15%. Fitted by
 * least squares on 1.4k code, JSON and prose samples counted with the real
 * tokenizer: the median lands 4% above the true count, 90% of samples within
 * -7%/+14%, the worst at -17% (base64 hashes) and +22%. The Jev-calibrated
 * estimate it replaces ranged -34%/+26% on the same samples.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += 1.55;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1;
    else if (piece === ' ') continue;
    else if (/^\s+$/.test(piece)) tokens += piece.includes('\n') ? 1 : 0.6;
    else tokens += 0.65;
  }
  return Math.ceil(tokens * 1.15);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; text: string; isError: boolean }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, {
        index,
        text: result.text,
        isError: result.isError ?? false,
      });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultText: found.text,
        resultChars: found.text.length,
        isError: found.isError,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

function isProse(message: Message | undefined): message is Message {
  return message !== undefined && message.text.trim().length > 0;
}

/** Texts of the `count` nearest prose messages before `from`, oldest first. */
function textsBefore(messages: readonly Message[], from: number, count: number, limit: number): string[] {
  const found: string[] = [];
  for (let i = from - 1; i >= 0 && found.length < count; i -= 1) {
    const message = messages[i];
    if (isProse(message)) found.unshift(`${message.role}: ${truncate(message.text, limit)}`);
  }
  return found;
}

/** Texts of the `count` nearest prose messages after `from`, oldest first. */
function textsAfter(messages: readonly Message[], from: number, count: number, limit: number): string[] {
  const found: string[] = [];
  for (let i = from + 1; i < messages.length && found.length < count; i += 1) {
    const message = messages[i];
    if (isProse(message)) found.push(`${message.role}: ${truncate(message.text, limit)}`);
  }
  return found;
}

function callLine(call: ToolCall, inputChars: number): string {
  const outcome = call.isError ? 'error' : 'ok';
  return `${call.tool} ${inputText(call.input, inputChars)} -> ${outcome}`;
}

function buildState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  call: ToolCall,
  goal: string,
  level: Level,
): CallState {
  const later = calls
    .filter((other) => other.callIndex > call.callIndex)
    .slice(0, level.later)
    .map((other) => callLine(other, 80));
  return {
    context: STATE_CONTEXT,
    goal: truncate(goal, level.goal),
    before: textsBefore(messages, call.callIndex, level.messages, level.text),
    call: {
      tool: call.tool,
      input: inputText(call.input, level.input),
      outcome: `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars`,
      output_preview: truncate(call.resultText, level.preview),
    },
    after: textsAfter(messages, call.resultIndex, level.messages, level.text),
    later_calls: later,
  };
}

/**
 * Builds the state for one call: the goal, the nearest messages around it,
 * its input, a short preview of its output and the calls made after it. Takes
 * the roomiest `STATE_LEVELS` entry that fits `maxStateTokens`, or the
 * smallest one when none does (`laya-serve` then cuts the tail and says so).
 * The key order puts what matters most first, since the tail is cut first.
 */
export function fitCallState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  call: ToolCall,
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'goal'>,
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  let fitted: FittedState | undefined;
  for (const [level, caps] of STATE_LEVELS.entries()) {
    const state = buildState(messages, calls, call, goal, caps);
    fitted = { state, tokens: estimateTokens(JSON.stringify(state)), level };
    if (fitted.tokens <= options.maxStateTokens) return fitted;
  }
  return fitted!;
}
