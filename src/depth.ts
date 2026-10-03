import type { Message } from './types.js';
import { collectToolCalls, goalFromMessages } from './state.js';

/**
 * Tool names whose calls mutate the workspace; their tool_use/tool_result
 * pairs are the ones most costly to lose to a wrong Jev keep/drop score.
 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Case-insensitive whole-word signals that the goal describes work where a
 * dropped tool call or truncated result (a file path, an exact error, a
 * constraint) is likely to matter later, not just now.
 */
const DEEP_KEYWORDS = [
  'refactor',
  'architecture',
  'migrat',
  'debug',
  'root cause',
  'design',
  'implement',
  'security',
  'multi-file',
  'systematic',
  'investigat',
  'race condition',
  'regression',
] as const;

export interface DepthSignals {
  messageCount: number;
  toolCallCount: number;
  distinctFiles: number;
  errorCount: number;
  writeToolCount: number;
  goalKeywordHits: number;
}

export type Depth = 'quick' | 'deep';

export interface DepthResult {
  depth: Depth;
  score: number;
  threshold: number;
  signals: DepthSignals;
  reasons: string[];
}

function filePathOf(input: Record<string, unknown>): string | undefined {
  const value = input['file_path'] ?? input['path'] ?? input['notebook_path'];
  return typeof value === 'string' ? value : undefined;
}

/** Reads the signals a depth score is built from. Never throws on odd input. */
export function collectDepthSignals(
  messages: readonly Message[],
  goal: string,
): DepthSignals {
  const calls = collectToolCalls(messages, 0);
  const files = new Set<string>();
  let errorCount = 0;
  let writeToolCount = 0;
  for (const call of calls) {
    const path = filePathOf(call.input);
    if (path) files.add(path);
    if (call.isError) errorCount += 1;
    if (WRITE_TOOLS.has(call.tool)) writeToolCount += 1;
  }
  const goalLower = goal.toLowerCase();
  let goalKeywordHits = 0;
  for (const keyword of DEEP_KEYWORDS) {
    if (goalLower.includes(keyword)) goalKeywordHits += 1;
  }
  return {
    messageCount: messages.length,
    toolCallCount: calls.length,
    distinctFiles: files.size,
    errorCount,
    writeToolCount,
    goalKeywordHits,
  };
}

/** Each signal's contribution to the deep-work score, clamped to [0, 1] before weighting. */
function scoreSignals(signals: DepthSignals): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const parts: number[] = [];

  const files = Math.min(signals.distinctFiles / 5, 1);
  parts.push(files * 0.3);
  if (signals.distinctFiles >= 3) reasons.push(`${signals.distinctFiles} files touched`);

  const writes = Math.min(signals.writeToolCount / 6, 1);
  parts.push(writes * 0.25);
  if (signals.writeToolCount >= 3) reasons.push(`${signals.writeToolCount} edit/write calls`);

  const errors = Math.min(signals.errorCount / 3, 1);
  parts.push(errors * 0.2);
  if (signals.errorCount >= 2) reasons.push(`${signals.errorCount} tool errors (debugging)`);

  const calls = Math.min(signals.toolCallCount / 20, 1);
  parts.push(calls * 0.1);
  if (signals.toolCallCount >= 15) reasons.push(`${signals.toolCallCount} tool calls`);

  const keywords = Math.min(signals.goalKeywordHits / 2, 1);
  parts.push(keywords * 0.15);
  if (signals.goalKeywordHits > 0) reasons.push(`goal matches ${signals.goalKeywordHits} deep-work keyword(s)`);

  const score = parts.reduce((sum, part) => sum + part, 0);
  return { score, reasons };
}

/**
 * Classifies a session as `quick` (safe for Jev's default aggressive
 * compaction) or `deep` (files/edits/errors/keywords suggest a dropped tool
 * call or truncated result would cost more than the context it frees;
 * caller should skip Jev and fall back to the built-in summary instead).
 * Pure function over the transcript: no network call, deterministic, and the
 * cheapest thing to get wrong is over-triggering `deep`, which only costs a
 * richer built-in summary instead of Jev's reduction.
 */
export function classifyDepth(
  messages: readonly Message[],
  goal: string | undefined,
  threshold = 0.5,
): DepthResult {
  const resolvedGoal = goal || goalFromMessages(messages);
  const signals = collectDepthSignals(messages, resolvedGoal);
  const { score, reasons } = scoreSignals(signals);
  const depth: Depth = score >= threshold ? 'deep' : 'quick';
  return { depth, score, threshold, signals, reasons };
}
