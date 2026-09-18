import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  applyDecisions,
  collectToolCalls,
  compact,
  isPinned,
  resolveOptions,
  type CallDecision,
  type CompactOptions,
  type CompactResult,
  type JevAsker,
  type Message,
  type ToolCall,
} from '../src/index.js';

/** A serialisable change to apply to a raw Pi transcript. */
export interface PiEdit {
  toolCallId: string;
  fingerprint: string;
  action: 'drop_call' | 'drop_result';
  /** The core-derived replacement for a dropped result. Required for `drop_result`. */
  text?: string;
}

type ObjectRecord = Record<string, unknown>;

interface CallLocation {
  index: number;
  message: ObjectRecord;
  block: ObjectRecord;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ResultProjection {
  /** Text-only surrogate used by the text-centric core compactor. */
  text: string;
  isError: boolean;
}

interface ResultLocation {
  index: number;
  message: ObjectRecord;
  id: string;
  projection: ResultProjection;
}

interface PiPair {
  id: string;
  call: CallLocation;
  result: ResultLocation;
  pinned: boolean;
  fingerprint: string;
}

interface PiProjection {
  messages: Message[];
  pairs: Map<string, PiPair>;
}

const TRUNCATION_PREFIX = '[fast-jev-compaction truncated ';

const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const COMPACTION_SUMMARY_SUFFIX = '\n</summary>';
const BRANCH_SUMMARY_PREFIX =
  'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n';
const BRANCH_SUMMARY_SUFFIX = '</summary>';

function isRecord(value: unknown): value is ObjectRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentOf(message: AgentMessage): unknown[] | undefined {
  const record = isRecord(message) ? message : undefined;
  return record && Array.isArray(record.content) ? record.content : undefined;
}

function roleOf(message: AgentMessage): string | undefined {
  const record = isRecord(message) ? message : undefined;
  return record && typeof record.role === 'string' ? record.role : undefined;
}

function toolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (value === undefined) return {};
  return { value };
}

function textAndMediaProjection(content: unknown): { text: string } {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return { text: '' };

  const text: string[] = [];
  let images = 0;
  let other = 0;
  for (const block of content) {
    if (!isRecord(block)) {
      other++;
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
    } else if (block.type === 'image') {
      images++;
    } else {
      other++;
    }
  }
  if (images > 0) text.push(`[${images} image${images === 1 ? '' : 's'} omitted from Jev scoring]`);
  if (other > 0) text.push(`[${other} non-text output block${other === 1 ? '' : 's'} omitted from Jev scoring]`);
  return { text: text.join('\n') };
}

/**
 * The native transcript has one visible assistant-text field and no thinking
 * field. Keep Pi reasoning out of that projection: it is replayed verbatim
 * when its assistant row survives, never rewritten as visible text.
 */
function assistantTextProjection(content: readonly unknown[]): string {
  const text: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
  }
  return text.join('\n');
}

function resultProjection(message: ObjectRecord): ResultProjection {
  const projected = textAndMediaProjection(message.content);
  return {
    text: projected.text,
    isError: message.isError === true,
  };
}

function fingerprintPart(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

/**
 * Bind cached edits to the particular, uniquely paired call and result. This
 * is integrity validation only: it never makes a pair ineligible for scoring.
 */
function pairFingerprint(call: CallLocation, result: ResultLocation): string {
  const encoded = JSON.stringify([
    2,
    call.id,
    call.index,
    result.index,
    fingerprintPart(call.block),
    fingerprintPart(result.message),
  ]);
  return createHash('sha256').update(encoded).digest('hex');
}

/**
 * A Pi transcript is safe to edit when an id occurs once on each side and the
 * result follows its call. Pi's toolCallId is the pairing authority; result
 * tool names are display metadata and are deliberately not used as a filter.
 */
function collectPiPairs(messages: readonly AgentMessage[], preserveRecentMessages: number): Map<string, PiPair> {
  const calls = new Map<string, CallLocation[]>();
  const results = new Map<string, ResultLocation[]>();

  messages.forEach((message, index) => {
    const source = isRecord(message) ? message : undefined;
    if (!source) return;

    if (roleOf(message) === 'assistant') {
      const content = contentOf(message);
      if (!content) return;
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'toolCall' || typeof block.id !== 'string') continue;
        const entries = calls.get(block.id) ?? [];
        entries.push({
          index,
          message: source,
          block,
          id: block.id,
          name: typeof block.name === 'string' ? block.name : 'unknown-tool',
          input: toolInput(block.arguments),
        });
        calls.set(block.id, entries);
      }
      return;
    }

    if (roleOf(message) === 'toolResult' && typeof source.toolCallId === 'string') {
      const entries = results.get(source.toolCallId) ?? [];
      entries.push({
        index,
        message: source,
        id: source.toolCallId,
        projection: resultProjection(source),
      });
      results.set(source.toolCallId, entries);
    }
  });

  const pairs = new Map<string, PiPair>();
  for (const [id, callEntries] of calls) {
    const resultEntries = results.get(id);
    if (callEntries.length !== 1 || resultEntries?.length !== 1) continue;
    const call = callEntries[0]!;
    const result = resultEntries[0]!;
    if (result.index <= call.index) continue;
    pairs.set(id, {
      id,
      call,
      result,
      pinned:
        isPinned(call.index, messages.length, preserveRecentMessages) ||
        isPinned(result.index, messages.length, preserveRecentMessages),
      fingerprint: pairFingerprint(call, result),
    });
  }
  return pairs;
}

function bashExecutionText(message: ObjectRecord): string {
  if (message.excludeFromContext === true) return '';
  const command = typeof message.command === 'string' ? message.command : '[unknown command]';
  const output = typeof message.output === 'string' ? message.output : '';
  let text = `Ran \`${command}\`\n`;
  text += output ? `\`\`\`\n${output}\n\`\`\`` : '(no output)';
  if (message.cancelled === true) text += '\n\n(command cancelled)';
  else if (typeof message.exitCode === 'number' && message.exitCode !== 0) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated === true && typeof message.fullOutputPath === 'string') {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

function projectionText(role: string | undefined, message: ObjectRecord): string {
  if (role === 'compactionSummary' && typeof message.summary === 'string') {
    return `${COMPACTION_SUMMARY_PREFIX}${message.summary}${COMPACTION_SUMMARY_SUFFIX}`;
  }
  if (role === 'branchSummary' && typeof message.summary === 'string') {
    return `${BRANCH_SUMMARY_PREFIX}${message.summary}${BRANCH_SUMMARY_SUFFIX}`;
  }
  if (role === 'bashExecution') return bashExecutionText(message);
  return textAndMediaProjection(message.content).text;
}

/** Pi's projection gives summaries user-shaped engine rows, so derive the goal first. */
function goalFromPiMessages(messages: readonly AgentMessage[]): string {
  return messages
    .filter((message) => roleOf(message) === 'user')
    .map((message) => {
      const source = isRecord(message) ? message : undefined;
      return source ? textAndMediaProjection(source.content).text : '';
    })
    .filter((text) => text.trim().length > 0)
    .slice(-3)
    .map((text) => text.slice(0, 500))
    .join('\n');
}

function buildProjection(messages: readonly AgentMessage[], preserveRecentMessages: number): PiProjection {
  const pairs = collectPiPairs(messages, preserveRecentMessages);
  const projected = messages.map((message) => {
    const role = roleOf(message);
    const source = isRecord(message) ? message : undefined;
    const content = contentOf(message);

    if (role === 'assistant' && source && content) {
      const toolUses = content.flatMap((block) => {
        if (!isRecord(block) || block.type !== 'toolCall' || typeof block.id !== 'string') return [];
        const pair = pairs.get(block.id);
        if (!pair || pair.call.block !== block) return [];
        return [{ tool_use_id: pair.id, tool: pair.call.name, input: pair.call.input }];
      });
      return { role: 'assistant' as const, text: assistantTextProjection(content), toolUses };
    }

    if (role === 'toolResult' && source && typeof source.toolCallId === 'string') {
      const pair = pairs.get(source.toolCallId);
      if (pair?.result.message === source) {
        return {
          role: 'user' as const,
          text: '',
          toolUses: [],
          toolResults: [{
            tool_use_id: pair.id,
            text: pair.result.projection.text,
            isError: pair.result.projection.isError,
          }],
        };
      }
      return { role: 'user' as const, text: '', toolUses: [] };
    }

    return {
      role: role === 'assistant' ? 'assistant' as const : 'user' as const,
      text: source ? projectionText(role, source) : '',
      toolUses: [],
    };
  });
  return { messages: projected, pairs };
}

/**
 * Returns the text-only transcript given to the native compactor. It is useful
 * for parity tests and explains the unavoidable multimodal adaptation: images
 * become non-leaking count placeholders for Jev, while raw Pi messages remain
 * untouched unless Jev selects that result for removal.
 */
export function projectPiMessages(
  messages: readonly AgentMessage[],
  preserveRecentMessages = 6,
): Message[] {
  const preserve = resolveOptions({ preserveRecentMessages }).preserveRecentMessages;
  return buildProjection(messages, preserve).messages;
}

/** Use the native core formatter rather than maintaining a second truncation implementation. */
function coreDroppedResultText(text: string, isError: boolean, headChars: number): string {
  const miniMessages: Message[] = [
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'pi-result', tool: 'pi', input: {} }],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 'pi-result', text, isError }],
    },
  ];
  const call: ToolCall = {
    id: 't1',
    tool_use_id: 'pi-result',
    tool: 'pi',
    input: {},
    callIndex: 0,
    resultIndex: 1,
    resultChars: text.length,
    isError,
    pinned: false,
  };
  const decision: CallDecision = {
    id: 't1',
    tool: 'pi',
    keepCall: 1,
    keepResult: 0,
    action: 'drop_result',
    reason: 'result_dropped',
  };
  return applyDecisions(miniMessages, [decision], [call], headChars)[1]?.toolResults?.[0]?.text ?? text;
}

function isCoreDerivedReplacement(pair: PiPair, replacement: string): boolean {
  if (replacement === pair.result.projection.text) return false;
  const markerAt = replacement.lastIndexOf(TRUNCATION_PREFIX);
  if (markerAt < 0) return false;
  const beforeMarker = replacement.slice(0, markerAt);
  const headChars = beforeMarker === ''
    ? 0
    : beforeMarker.endsWith('\n')
      ? beforeMarker.length - 1
      : undefined;
  return headChars !== undefined &&
    replacement === coreDroppedResultText(
      pair.result.projection.text,
      pair.result.projection.isError,
      headChars,
    );
}

/**
 * Applies only complete, current, non-pinned edits. A stale or malformed edit
 * returns the original transcript so cached decisions never cross a branch or
 * pairing boundary.
 */
export function applyPiEdits(
  messages: readonly AgentMessage[],
  edits: readonly PiEdit[],
  preserveRecentMessages?: number,
): AgentMessage[] {
  if (edits.length === 0) return [...messages];

  const preserve = resolveOptions({ preserveRecentMessages }).preserveRecentMessages;
  const pairs = collectPiPairs(messages, preserve);
  const actions = new Map<string, PiEdit>();
  for (const edit of edits) {
    if (
      !edit ||
      typeof edit.toolCallId !== 'string' ||
      typeof edit.fingerprint !== 'string' ||
      (edit.action !== 'drop_call' && edit.action !== 'drop_result') ||
      actions.has(edit.toolCallId)
    ) {
      return [...messages];
    }
    const pair = pairs.get(edit.toolCallId);
    if (!pair || pair.pinned || pair.fingerprint !== edit.fingerprint) return [...messages];
    if (edit.action === 'drop_result' &&
      (typeof edit.text !== 'string' || !isCoreDerivedReplacement(pair, edit.text))) {
      return [...messages];
    }
    actions.set(edit.toolCallId, edit);
  }

  const output: AgentMessage[] = [];
  for (const message of messages) {
    const role = roleOf(message);
    const source = isRecord(message) ? message : undefined;
    const content = contentOf(message);

    if (role === 'assistant' && source && content) {
      const nextContent = content.filter((block) => {
        if (!isRecord(block) || block.type !== 'toolCall' || typeof block.id !== 'string') return true;
        return actions.get(block.id)?.action !== 'drop_call';
      });
      if (nextContent.length === content.length) output.push(message);
      // A native row with no visible text and no remaining calls disappears.
      // Applying that rule to Pi also removes a now-orphaned signed thinking
      // block, which some providers reject when it has no following item.
      else if (
        assistantTextProjection(content).trim().length > 0 ||
        nextContent.some((block) => isRecord(block) && block.type === 'toolCall')
      ) {
        output.push({ ...source, content: nextContent } as AgentMessage);
      }
      continue;
    }

    if (role === 'toolResult' && source && typeof source.toolCallId === 'string') {
      const edit = actions.get(source.toolCallId);
      if (edit?.action === 'drop_call') continue;
      if (edit?.action === 'drop_result') {
        output.push({
          ...source,
          content: [{ type: 'text', text: edit.text }],
        } as AgentMessage);
        continue;
      }
    }
    output.push(message);
  }
  return output;
}

function compactedResultText(messages: readonly Message[], toolUseId: string): string | undefined {
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (result.tool_use_id === toolUseId) return result.text;
    }
  }
  return undefined;
}

/**
 * Runs the native compactor over a faithful text projection, then applies the
 * exact decisions to Pi's raw blocks. Thinking, signatures, errors, and other
 * metadata are not eligibility filters; only unique ordered pairs and the
 * core first/recent pinning rule constrain edits.
 */
export async function compactPiMessages(
  messages: readonly AgentMessage[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<{
  messages: AgentMessage[];
  edits: PiEdit[];
  stats: CompactResult['stats'];
  decisions: CompactResult['decisions'];
}> {
  const resolved = resolveOptions(options);
  const projection = buildProjection(messages, resolved.preserveRecentMessages);
  const projectedCalls = collectToolCalls(projection.messages, resolved.preserveRecentMessages);
  const callsByDecisionId = new Map(projectedCalls.map((call) => [call.id, call]));
  const compacted = await compact(projection.messages, asker, {
    ...options,
    goal: options.goal ?? goalFromPiMessages(messages),
  });

  const edits: PiEdit[] = [];
  for (const decision of compacted.decisions) {
    if (decision.action === 'keep') continue;
    const projectedCall = callsByDecisionId.get(decision.id);
    if (!projectedCall) continue;
    const pair = projection.pairs.get(projectedCall.tool_use_id);
    if (!pair || pair.pinned) continue;

    if (decision.action === 'drop_call') {
      edits.push({ toolCallId: pair.id, fingerprint: pair.fingerprint, action: 'drop_call' });
      continue;
    }

    const text = compactedResultText(compacted.messages, projectedCall.tool_use_id);
    if (text !== undefined && text !== pair.result.projection.text) {
      edits.push({ toolCallId: pair.id, fingerprint: pair.fingerprint, action: 'drop_result', text });
    }
  }

  return {
    messages: applyPiEdits(messages, edits, resolved.preserveRecentMessages),
    edits,
    // The native compactor's projected characters and decision counts are the
    // only honest basis for parity and reduction reporting. Image payload bytes
    // are intentionally never counted or sent to Jev.
    stats: compacted.stats,
    decisions: compacted.decisions,
  };
}
