/**
 * Replays every Jev compaction round of a Claude Code session transcript
 * through `compact()` and prints, per round, what the plugin saw and what the
 * hook would have decided. Reads the JSONL the engine writes; the input of a
 * round is everything logged since the previous compaction boundary (the
 * retained set the engine re-logs, then the new messages), deduplicated.
 *
 *   npx tsx scripts/replay-transcript.mts <session.jsonl> [--jev] [--keep-unscored]
 *
 * Without `--jev` every answer is 0 (drop everything), which is within a point
 * of what Jev answers at the default threshold; with it, Jev is asked.
 */
import { readFileSync } from 'node:fs';
import { JevClient } from '../src/client.js';
import { compact, reductionBound, reductionRatio } from '../src/compact.js';
import type { JevAsker, Message, ToolResult, ToolUse } from '../src/types.js';
import { verdict } from '../hooks/fast-jev.js';

type Row = Record<string, unknown> & { line: number };

function rows(file: string): Row[] {
  const out: Row[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      out.push({ ...(JSON.parse(raw) as Record<string, unknown>), line: i + 1 });
    } catch {
      /* skip */
    }
  });
  return out;
}

type Boundary = { line: number; index: number; kind: 'jev' | 'summary'; at: string };

/**
 * Compaction boundaries, once each. The engine re-logs the whole chain of
 * boundaries and retained sets when a session resumes, so a boundary appears
 * several times; the first occurrence is the one followed by its retained set.
 */
function boundaries(all: Row[]): Boundary[] {
  const seen = new Set<string>();
  const found: Boundary[] = [];
  all.forEach((row, index) => {
    if (row['subtype'] !== 'compact_boundary') return;
    const at = String(row['timestamp']);
    if (seen.has(at)) return;
    seen.add(at);
    const meta = (row['compactMetadata'] ?? {}) as Record<string, unknown>;
    found.push({ line: row.line, index, kind: 'preservedSegment' in meta ? 'summary' : 'jev', at });
  });
  return found;
}

/**
 * The input of the round that ended at `to`: the retained set the engine
 * re-logged right after the previous boundary (rows with timestamps at or
 * before it, contiguous), then every message logged between the two.
 */
function roundInput(all: Row[], from: Boundary | undefined, to: Boundary): Row[] {
  const input: Row[] = [];
  const isMessage = (row: Row): boolean => row['type'] === 'user' || row['type'] === 'assistant';
  const stamp = (row: Row): string => String(row['timestamp'] ?? '');
  let i = from ? from.index + 1 : 0;
  if (from) {
    for (; i < to.index; i += 1) {
      const row = all[i]!;
      if (!stamp(row)) continue;
      if (stamp(row) > from.at) break;
      if (isMessage(row)) input.push(row);
    }
  }
  for (; i < to.index; i += 1) {
    const row = all[i]!;
    if (!isMessage(row)) continue;
    const at = stamp(row);
    if (from && at <= from.at) continue;
    if (at >= to.at) continue;
    input.push(row);
  }
  return input;
}

/** The engine hands the hook one message per content block. */
function toMessages(slice: Row[]): Message[] {
  const messages: Message[] = [];
  const seen = new Set<string>();
  for (const row of slice) {
    const type = row['type'];
    if (type !== 'user' && type !== 'assistant') continue;
    if (row['isSidechain']) continue;
    const message = row['message'] as { content?: unknown } | undefined;
    const content = message?.content;
    const key = `${String(row['timestamp'])}|${type}|${JSON.stringify(content).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (typeof content === 'string') {
      messages.push({ role: type, text: content, toolUses: [] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block['type'] === 'text') {
        messages.push({ role: type, text: String(block['text'] ?? ''), toolUses: [] });
      } else if (block['type'] === 'tool_use') {
        const use: ToolUse = {
          tool_use_id: String(block['id']),
          tool: String(block['name']),
          input: (block['input'] ?? {}) as Record<string, unknown>,
        };
        messages.push({ role: 'assistant', text: '', toolUses: [use] });
      } else if (block['type'] === 'tool_result') {
        const raw = block['content'];
        const text =
          typeof raw === 'string'
            ? raw
            : ((raw ?? []) as Record<string, unknown>[]).map((x) => String(x['text'] ?? '')).join('\n');
        const result: ToolResult = {
          tool_use_id: String(block['tool_use_id']),
          text,
          isError: block['is_error'] === true,
        };
        messages.push({ role: 'user', text: '', toolUses: [], toolResults: [result] });
      }
    }
  }
  return messages;
}

const [file, ...flags] = process.argv.slice(2);
if (!file) throw new Error('usage: replay-transcript.mts <session.jsonl> [--jev] [--keep-unscored]');
const useJev = flags.includes('--jev');
const keepUnscored = flags.includes('--keep-unscored');
const asker: JevAsker = useJev
  ? new JevClient()
  : {
      ask: async (_state, questions) => ({
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0 }])),
      }),
    };

const all = rows(file);
const marks = boundaries(all);
const config = { minReductionRatio: 0.25, compactAtPercent: 60 };
console.log(`${file}\n${marks.length} compaction boundaries (${marks.filter((m) => m.kind === 'jev').length} jev)\n`);
console.log('round | actual  | msgs | chars   | text% | cands | bound | reduction | unscored | stage                  | new verdict');
let previous: Boundary | undefined;
let round = 0;
for (const mark of marks) {
  const slice = roundInput(all, previous, mark);
  previous = mark;
  round += 1;
  const messages = toMessages(slice);
  if (messages.length === 0) {
    console.log(`${String(round).padStart(5)} | ${mark.kind.padEnd(7)} | (no input found before ${mark.at})`);
    continue;
  }
  let line: string;
  try {
    const result = await compact(messages, asker, { keepUnscored });
    const chars = result.stats.charsBefore;
    const textChars = messages.reduce((s, m) => s + m.text.length, 0);
    const out = verdict(result, config, undefined);
    line = `${String(messages.length).padStart(4)} | ${String(chars).padStart(7)} | ${String(Math.round((100 * textChars) / chars)).padStart(4)}% | ${String(result.stats.calls - result.stats.pinned).padStart(5)} | ${(100 * reductionBound(result)).toFixed(0).padStart(4)}% | ${(100 * reductionRatio(result)).toFixed(0).padStart(8)}% | ${String(result.stats.unscored).padStart(8)} | ${result.stats.stateStage.padEnd(22)} | ${out.kind}`;
  } catch (error) {
    line = `${String(messages.length).padStart(4)} | throws: ${(error as Error).message}`;
  }
  console.log(`${String(round).padStart(5)} | ${mark.kind.padEnd(7)} | ${line}`);
}
