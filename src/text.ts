import { isPinned, truncate } from './state.js';
import type {
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  TextAnswer,
  TextBlock,
  TextDecision,
  TextKind,
} from './types.js';

/** Characters a block must repeat to be dropped as a duplicate without asking Jev. */
const DUPLICATE_MIN_CHARS = 200;
const REPLY_HEAD = 600;
const REPLY_TAIL = 300;

type Pattern = { kind: TextKind; regex: RegExp };

/**
 * Text the harness injects into user turns: command echoes, skill bodies,
 * the `/context` report and system reminders. Anything else a user message
 * holds is what the person typed and is never a candidate.
 */
const INJECTED: readonly Pattern[] = [
  { kind: 'skill', regex: /Base directory for this skill:[^\n]*\n[\s\S]*?(?=\nARGUMENTS:|$)/g },
  { kind: 'context_report', regex: /## Context Usage\n[\s\S]*?(?=\n<local-command-caveat>|\n<command-name>|$)/g },
  { kind: 'command_output', regex: /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g },
  { kind: 'system_reminder', regex: /<system-reminder>[\s\S]*?<\/system-reminder>/g },
];

function labelOf(kind: TextKind, content: string): string {
  if (kind === 'skill') {
    const dir = /Base directory for this skill:\s*(\S+)/.exec(content)?.[1] ?? '';
    const name = dir.replace(/\/+$/, '').split('/').filter(Boolean);
    const skill = name[name.length - 1] ?? 'unknown';
    return `skill ${skill === 'SKILL.md' ? (name[name.length - 2] ?? skill) : skill}`;
  }
  if (kind === 'context_report') return '/context report';
  if (kind === 'reply') return 'assistant reply';
  const inner = content.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
  const firstLine = inner
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const name = kind === 'command_output' ? 'command output' : 'system reminder';
  return firstLine ? `${name} "${truncate(firstLine, 60)}"` : name;
}

function injectedRanges(text: string): { kind: TextKind; start: number; end: number }[] {
  const found: { kind: TextKind; start: number; end: number }[] = [];
  for (const { kind, regex } of INJECTED) {
    for (const match of text.matchAll(regex)) {
      const start = match.index ?? 0;
      found.push({ kind, start, end: start + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: typeof found = [];
  for (const range of found) {
    const last = ranges[ranges.length - 1];
    if (last && range.start < last.end) continue;
    ranges.push(range);
  }
  return ranges;
}

/**
 * Finds the text blocks that may go: injected blocks in user turns and long
 * assistant replies. Blocks in pinned messages are listed but never touched;
 * an earlier block whose exact content appears again later is a duplicate.
 */
export function collectTextBlocks(
  messages: readonly Message[],
  options: Pick<ResolvedCompactOptions, 'preserveRecentMessages' | 'injectedMinChars' | 'replyMinChars'>,
): TextBlock[] {
  const blocks: TextBlock[] = [];
  const add = (block: Omit<TextBlock, 'id' | 'duplicate'>): void => {
    blocks.push({ ...block, id: `x${blocks.length + 1}`, duplicate: false });
  };
  messages.forEach((message, index) => {
    const pinned = isPinned(index, messages.length, options.preserveRecentMessages);
    if (message.role === 'user' && options.injectedMinChars > 0) {
      for (const range of injectedRanges(message.text)) {
        const content = message.text.slice(range.start, range.end);
        if (content.length < DUPLICATE_MIN_CHARS) continue;
        add({
          index,
          kind: range.kind,
          start: range.start,
          end: range.end,
          chars: content.length,
          label: labelOf(range.kind, content),
          pinned,
        });
      }
    }
    if (
      message.role === 'assistant' &&
      options.replyMinChars > 0 &&
      message.text.length >= Math.max(options.replyMinChars, REPLY_HEAD + REPLY_TAIL + 200)
    ) {
      add({
        index,
        kind: 'reply',
        start: 0,
        end: message.text.length,
        chars: message.text.length,
        label: 'assistant reply',
        pinned,
      });
    }
  });

  const seen = new Set<string>();
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === 'reply') continue;
    const content = messages[block.index]!.text.slice(block.start, block.end);
    if (seen.has(content)) block.duplicate = true;
    else seen.add(content);
  }
  return blocks;
}

/** Blocks Jev is asked about: not pinned, not a duplicate, and big enough. */
export function textCandidates(
  blocks: readonly TextBlock[],
  options: Pick<ResolvedCompactOptions, 'injectedMinChars'>,
): TextBlock[] {
  return blocks.filter(
    (block) =>
      !block.pinned &&
      !block.duplicate &&
      (block.kind === 'reply' || block.chars >= options.injectedMinChars),
  );
}

export function textQuestionsFor(block: TextBlock): JevQuestions {
  const instructions =
    block.kind === 'reply'
      ? `The full text of assistant reply ${block.id} (message ${block.index}, ${block.chars} chars) should stay in the history verbatim: the assistant still needs its exact wording; otherwise only its opening and closing are kept`
      : `Block ${block.id} in message ${block.index} (${block.label}, ${block.chars} chars) should stay in the history verbatim: the assistant still needs its exact contents for what it does next; otherwise only a one-line note remains`;
  return { [`text_${block.id}`]: { type: 'noul', instructions } };
}

export function decideText(
  block: TextBlock,
  answer: TextAnswer | undefined,
  options: Pick<ResolvedCompactOptions, 'keepThreshold' | 'injectedMinChars'>,
): TextDecision {
  const base = { id: block.id, kind: block.kind, label: block.label, keep: answer?.keep ?? 1 };
  if (block.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (block.duplicate) return { ...base, keep: 0, action: 'remove', reason: 'duplicate' };
  if (!answer) return { ...base, action: 'keep', reason: 'small' };
  if (answer.keep >= options.keepThreshold) return { ...base, action: 'keep', reason: 'kept' };
  return block.kind === 'reply'
    ? { ...base, action: 'abridge', reason: 'abridged' }
    : { ...base, action: 'remove', reason: 'removed' };
}

function replacement(block: TextBlock, decision: TextDecision, text: string): string {
  if (decision.action === 'abridge') {
    const omitted = text.length - REPLY_HEAD - REPLY_TAIL;
    return `${text.slice(0, REPLY_HEAD)}\n[fast-jev-compaction abridged ${omitted} chars of this reply]\n${text.slice(-REPLY_TAIL)}`;
  }
  const why = decision.reason === 'duplicate' ? 'repeated later' : `${block.chars} chars`;
  return `[fast-jev-compaction removed ${block.label}: ${why}]`;
}

/**
 * Rewrites the text of every message with a removed or abridged block.
 * Untouched messages come back as the same objects, and a rebuilt message
 * keeps its tool uses and results as the same objects.
 */
export function applyTextDecisions(
  messages: readonly Message[],
  blocks: readonly TextBlock[],
  decisions: readonly TextDecision[],
): Message[] {
  const actions = new Map(decisions.map((decision) => [decision.id, decision]));
  const byMessage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (actions.get(block.id)?.action === 'keep') continue;
    const list = byMessage.get(block.index) ?? [];
    list.push(block);
    byMessage.set(block.index, list);
  }
  return messages.map((message, index) => {
    const touched = byMessage.get(index);
    if (!touched) return message;
    let text = message.text;
    for (const block of [...touched].sort((a, b) => b.start - a.start)) {
      const decision = actions.get(block.id)!;
      const original = text.slice(block.start, block.end);
      text = text.slice(0, block.start) + replacement(block, decision, original) + text.slice(block.end);
    }
    const rebuilt: Message = { role: message.role, text, toolUses: message.toolUses };
    if (message.toolResults) rebuilt.toolResults = message.toolResults;
    return rebuilt;
  });
}
