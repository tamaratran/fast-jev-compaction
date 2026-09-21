// Replay a Claude Code transcript (.jsonl) through compactMessages and report
// what each dropCalls setting would have kept. Reads TYPESAFE_API_KEY from the
// environment. Usage: tsx examples/replay.ts <transcript.jsonl> [stopAtLine]
import { readFileSync } from 'node:fs';
import { compactMessages, reductionRatio, type Message, type ToolUse, type ToolResult } from '../src/index.js';

const [file, stopAtArg] = process.argv.slice(2);
if (!file) throw new Error('usage: tsx examples/replay.ts <transcript.jsonl> [stopAtLine]');
const stopAt = stopAtArg ? Number(stopAtArg) : Infinity;

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c as Block).text ?? '')).join('\n');
  return '';
}

const lines = readFileSync(file, 'utf8').split('\n');
const messages: Message[] = [];
const results = new Map<string, ToolResult>();
const seen = new Set<string>();
lines.forEach((line, i) => {
  if (i + 1 > stopAt || !line) return;
  let d: any;
  try { d = JSON.parse(line); } catch { return; }
  if (d.type !== 'user' && d.type !== 'assistant') return;
  const m = d.message ?? {};
  const content: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
  // Claude Code writes one line per content block under the same message id;
  // dedupe on the block itself, not the id, or every tool_use after the text is lost.
  if (d.type === 'assistant' && m.id) {
    const k = m.id + ':' + JSON.stringify(content).slice(0, 200);
    if (seen.has(k)) return;
    seen.add(k);
  }
  const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  const toolUses: ToolUse[] = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ tool_use_id: b.id!, tool: b.name!, input: b.input ?? {} }));
  const toolResults: ToolResult[] = content
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({ tool_use_id: b.tool_use_id!, text: blockText(b.content), isError: b.is_error }));
  for (const r of toolResults) results.set(r.tool_use_id, r);
  if (!text && toolUses.length === 0 && toolResults.length === 0) return;
  const msg: Message = { role: d.type, text, toolUses };
  if (toolResults.length) msg.toolResults = toolResults;
  messages.push(msg);
});
for (const m of messages) for (const t of m.toolUses) {
  const r = results.get(t.tool_use_id);
  if (r) { t.text = r.text; t.isError = r.isError; }
}

const chars = (ms: Message[]) =>
  ms.reduce((n, m) => n + m.text.length + m.toolUses.reduce((a, t) => a + JSON.stringify(t.input).length, 0) + (m.toolResults ?? []).reduce((a, r) => a + r.text.length, 0), 0);
// Assistant turns = runs of messages between two user prompts (tool_result-only
// user messages do not end a turn). Counts turns that contain narration, and how
// many of those still show at least one tool call: the #65 pattern is narration
// whose calls are gone.
const turnStats = (ms: Message[]) => {
  let turns = 0, withCall = 0, hasText = false, hasCall = false;
  const close = () => { if (hasText) { turns++; if (hasCall) withCall++; } hasText = false; hasCall = false; };
  for (const m of ms) {
    if (m.role === 'user' && m.text) { close(); continue; }
    if (m.role === 'assistant') { if (m.text) hasText = true; if (m.toolUses.length) hasCall = true; }
  }
  close();
  return `${withCall}/${turns} narrated turns still show a tool call`;
};
const approxTokens = (ms: Message[]) => Math.round(chars(ms) / 3.6 / 1000);

console.log(`input: ${messages.length} messages, ~${approxTokens(messages)}k tokens of history, ${messages.reduce((n, m) => n + m.toolUses.length, 0)} tool calls, ${turnStats(messages)}`);
for (const dropCalls of [true, false]) {
  const t0 = Date.now();
  const result = await compactMessages(messages, { dropCalls } as any);
  const acts = result.decisions.reduce<Record<string, number>>((a, d) => ((a[d.action] = (a[d.action] ?? 0) + 1), a), {});
  const kept = result.messages;
  console.log(
    `dropCalls=${dropCalls}: ${((Date.now() - t0) / 1000).toFixed(1)}s, chars saved ${(reductionRatio(result) * 100).toFixed(1)}%,` +
      ` messages ${result.stats.messagesBefore} -> ${result.stats.messagesAfter}, actions ${JSON.stringify(acts)},` +
      ` ~${approxTokens(kept)}k tokens left, tool calls left ${kept.reduce((n, m) => n + m.toolUses.length, 0)}, ${turnStats(kept)}`,
  );
}
