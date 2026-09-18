import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { sessionEntryToContextMessages, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { CompactResult } from '../src/types.js';

export const CHECKPOINT_FORMAT = 'fast-jev-pi-context-v1';
const SOURCE_CHECKPOINT_FORMAT = 'fast-jev-pi-context-v2';
const MARKER = '[fast-jev-compaction checkpoint ';

export interface JevCheckpoint {
  format: typeof CHECKPOINT_FORMAT | typeof SOURCE_CHECKPOINT_FORMAT;
  id: string;
  messages: AgentMessage[];
  stats: CompactResult['stats'];
  decisions?: CompactResult['decisions'];
  readFiles: string[];
  modifiedFiles: string[];
  /** Original entries kept available to Pi's pre-hook compaction preparation. */
  sourceStartId?: string;
  /** Pi also removes this failed source response from live state before retry. */
  omittedRetryResponse?: boolean;
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: Record<string, unknown>) => {
    if (part.type === 'text') return String(part.text ?? '');
    if (part.type === 'thinking') return `[Thinking]\n${String(part.thinking ?? '')}`;
    if (part.type === 'toolCall') return `[Tool call ${part.id}: ${part.name}]\n${JSON.stringify(part.arguments)}`;
    // Pi budgets each image as 1200 tokens (4800 characters). Keep the same
    // reservation in its textual checkpoint estimate without copying base64.
    if (part.type === 'image') return `[Image: ${part.mimeType}; data retained in checkpoint]${' '.repeat(4800)}`;
    return `[${String(part.type)} content preserved in checkpoint]`;
  }).join('\n');
}

/**
 * Pi requires a summary string even for a custom compaction. Store a full,
 * deterministic transcript here, not a generated summary or a tiny placeholder.
 * Pi can budget it and its default summarizer can consume it on a later fallback.
 * The context hook restores the exact typed messages from details before inference.
 */
export function renderCheckpoint(checkpoint: JevCheckpoint): string {
  const transcript = checkpoint.messages.map(message => {
    if (message.role === 'bashExecution') {
      if (message.excludeFromContext) return '';
      const outcome = message.cancelled ? '\n(command cancelled)'
        : message.exitCode != null && message.exitCode !== 0 ? `\nCommand exited with code ${message.exitCode}` : '';
      const truncated = message.truncated && message.fullOutputPath
        ? `\n[Output truncated. Full output: ${message.fullOutputPath}]` : '';
      return `[Bash: ${message.command}]\n${message.output || '(no output)'}${outcome}${truncated}`;
    }
    if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
      return `[${message.role}]\n${message.summary}`;
    }
    const label = message.role === 'toolResult'
      ? `Tool result ${message.toolCallId}: ${message.toolName}${message.isError ? ' (error)' : ''}`
      : message.role;
    return `[${label}]\n${'content' in message ? textContent(message.content) : ''}`;
  }).filter(Boolean).join('\n\n');
  // Pi intentionally ignores file metadata in fromHook details on a later
  // native compaction. Include the same file appendix in the readable input.
  const files = [
    checkpoint.readFiles.length ? `<read-files>\n${checkpoint.readFiles.join('\n')}\n</read-files>` : '',
    checkpoint.modifiedFiles.length ? `<modified-files>\n${checkpoint.modifiedFiles.join('\n')}\n</modified-files>` : '',
  ].filter(Boolean).join('\n\n');
  return `${MARKER}${checkpoint.id}]\nRetained conversation, verbatim. No generated summary.\n\n${transcript}${files ? `\n\n${files}` : ''}`;
}

export function createCheckpoint(
  messages: AgentMessage[],
  stats: CompactResult['stats'],
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
  sourceMessages: readonly AgentMessage[] = messages,
  previous?: Pick<JevCheckpoint, 'readFiles' | 'modifiedFiles'>,
  sourceStartId?: string,
): JevCheckpoint {
  // Unlike Pi's normal prefix compaction, this checkpoint consumes the complete
  // effective context. Track file operations in its tail as well as its prefix.
  const read = new Set([...fileOps.read, ...(previous?.readFiles ?? [])]);
  const modified = new Set([...fileOps.written, ...fileOps.edited, ...(previous?.modifiedFiles ?? [])]);
  for (const message of sourceMessages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall' || typeof block.arguments?.path !== 'string' || !block.arguments.path) continue;
      if (block.name === 'read') read.add(block.arguments.path);
      else if (block.name === 'write' || block.name === 'edit') modified.add(block.arguments.path);
    }
  }
  // Checkpoints must survive Pi's JSONL persistence, not retain mutable runtime references.
  return {
    format: sourceStartId ? SOURCE_CHECKPOINT_FORMAT : CHECKPOINT_FORMAT,
    ...(sourceStartId ? { sourceStartId } : {}),
    id: randomUUID(),
    messages: JSON.parse(JSON.stringify(messages)) as AgentMessage[],
    stats,
    readFiles: [...read].filter(path => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export function isJevCheckpoint(data: unknown): data is JevCheckpoint {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<JevCheckpoint>;
  const stats = value.stats;
  if (!stats || typeof stats !== 'object' || ![
    'messagesBefore', 'messagesAfter', 'charsBefore', 'charsAfter', 'calls', 'kept',
    'resultsDropped', 'callsDropped', 'pinned', 'stateTokens', 'requests', 'ms',
  ].every(key => {
    const number = (stats as unknown as Record<string, unknown>)[key];
    return typeof number === 'number' && Number.isFinite(number) && number >= 0;
  })) return false;
  if (value.decisions !== undefined && (!Array.isArray(value.decisions) || !value.decisions.every(decision =>
    decision && typeof decision.id === 'string' && typeof decision.tool === 'string' &&
    typeof decision.action === 'string' && Number.isFinite(decision.keepCall) && Number.isFinite(decision.keepResult)))) return false;
  if (value.omittedRetryResponse !== undefined && typeof value.omittedRetryResponse !== 'boolean') return false;
  return (value.format === CHECKPOINT_FORMAT ||
    value.format === SOURCE_CHECKPOINT_FORMAT && typeof value.sourceStartId === 'string') &&
    typeof value.id === 'string' &&
    Array.isArray(value.readFiles) && value.readFiles.every(path => typeof path === 'string') &&
    Array.isArray(value.modifiedFiles) && value.modifiedFiles.every(path => typeof path === 'string') &&
    Array.isArray(value.messages) && value.messages.every(message =>
      message && typeof message === 'object' && typeof message.role === 'string');
}

/** Validate both the commit boundary and the exact source interval on this branch. */
export function checkpointAt(branch: readonly SessionEntry[], index: number): {
  checkpoint: JevCheckpoint;
  source: AgentMessage[];
} | undefined {
  const entry = branch[index];
  if (entry?.type !== 'compaction' || !isJevCheckpoint(entry.details) ||
      !entry.summary.startsWith(`${MARKER}${entry.details.id}]\n`)) return;
  const start = branch.findIndex(candidate => candidate.id === entry.firstKeptEntryId);
  if (start < 0 || start >= index) return;
  const withSource = entry.details.format === SOURCE_CHECKPOINT_FORMAT;
  const boundary = branch[withSource ? index - 1 : start];
  if (boundary?.type !== 'custom' || boundary.customType !== 'fast-jev-pi-boundary' ||
      !boundary.data || typeof boundary.data !== 'object' ||
      !('checkpointId' in boundary.data) || boundary.data.checkpointId !== entry.details.id ||
      withSource && entry.firstKeptEntryId !== entry.details.sourceStartId) return;
  return {
    checkpoint: entry.details,
    source: withSource ? branch.slice(start, index).flatMap(sessionEntryToContextMessages) : [],
  };
}

/**
 * Pi prepares compaction before extensions run, so v2 leaves the source entries
 * addressable. Replace that entire committed interval here, never concatenate it
 * with the retained snapshot. Only entries after the checkpoint are new context.
 */
export function restoreCheckpoints(messages: readonly AgentMessage[], branch: readonly SessionEntry[]): AgentMessage[] {
  const checkpoints = new Map<string, number>();
  for (const [index, entry] of branch.entries()) {
    if (entry.type === 'compaction') checkpoints.set(entry.summary, index);
  }
  const restored: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const checkpointIndex = message.role === 'compactionSummary' ? checkpoints.get(message.summary) : undefined;
    const binding = checkpointIndex === undefined ? undefined : checkpointAt(branch, checkpointIndex);
    const matches = (source: readonly AgentMessage[]) => source.every((item, offset) =>
      JSON.stringify(item) === JSON.stringify(messages[index + 1 + offset]));
    let covered = binding?.source;
    if (binding && covered && !matches(covered) && binding.checkpoint.omittedRetryResponse) {
      const last = covered[covered.length - 1];
      if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'length')) {
        covered = covered.slice(0, -1);
      }
    }
    if (binding && covered && matches(covered)) {
      restored.push(...structuredClone(binding.checkpoint.messages));
      index += covered.length;
    } else {
      // Preserve readable fallback if a checkpoint or its selected source is invalid.
      restored.push(message);
    }
  }
  return restored;
}
