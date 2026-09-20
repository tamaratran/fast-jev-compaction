#!/usr/bin/env node
/**
 * jev-compact — Hermes-tailored verbatim compaction CLI.
 * Built on tamaratran/fast-jev-compaction (MIT). Jev via OpenRouter
 * /api/alpha/decisions with an OPENROUTER_API_KEY (no TypeSafe key needed).
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node cli/jev-compact.mjs transcript.json -o dump.md
 *
 * transcript.json: array of messages:
 *   { "role": "user"|"assistant", "text": "...",
 *     "toolUses":    [{ "tool_use_id":"t1","tool":"terminal","input":{...},"text":"optional outcome" }],
 *     "toolResults": [{ "tool_use_id":"t1","text":"..." }] }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { compactMessages } from '../dist/index.js';

const args = process.argv.slice(2);
const inFile = args[0];
const outIdx = args.indexOf('-o');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
const preserve = (() => {
  const i = args.indexOf('--preserve');
  return i !== -1 ? Number(args[i + 1]) : 4;
})();

if (!inFile) {
  console.error('usage: node cli/jev-compact.mjs transcript.json [-o dump.md] [--preserve N]');
  process.exit(2);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(inFile, 'utf8'));
const messages = raw.map((m) => ({ ...m, toolUses: m.toolUses ?? [], toolResults: m.toolResults ?? [] }));

const result = await compactMessages(messages, {
  apiKey,
  model: process.env.JEV_MODEL || 'typesafe/jev-1.13',
  baseUrl: process.env.JEV_BASE_URL || 'https://openrouter.ai/api/alpha/decisions',
  preserveRecentMessages: preserve,
});

// Render a human-readable markdown dump.
const fmt = (s) => (s ?? '').replace(/\r?\n/g, ' ⏎ ').slice(0, 400);
const lines = [];
lines.push(`# jev-compact dump — ${new Date().toISOString()}`);
lines.push('');
const s = result.stats;
const usage = result.usage ?? {};
lines.push(`Stats: ${s.messagesBefore}→${s.messagesAfter} msgs · ${s.charsBefore}→${s.charsAfter} chars · calls ${s.calls} (kept ${s.kept}, resultsDropped ${s.resultsDropped}, dropped ${s.callsDropped}, pinned ${s.pinned}) · ${s.requests} request(s) in ${s.ms} ms · state ~${s.stateTokens} tok`);
if (usage.input_tokens) lines.push(`Jev usage: ${usage.input_tokens} in / ${usage.output_tokens} out · cost ${usage.cost}`);
lines.push('');

for (const [i, m] of result.messages.entries()) {
  const orig = messages[i];
  lines.push(`## [${i}] ${m.role}`);
  if (m.text?.trim()) lines.push(m.text.trim());
  for (const tu of m.toolUses ?? []) {
    const d = result.decisions.find((x) => x.tool_use_id === tu.tool_use_id);
    const act = d ? d.action : 'pinned';
    lines.push(`- **${act}** \`${tu.tool}\` ${JSON.stringify(tu.input).slice(0, 300)}`);
    if (act === 'keep' || act === 'pinned') {
      const res = (m.toolResults ?? []).find((r) => r.tool_use_id === tu.tool_use_id);
      if (res?.text?.trim()) lines.push(`  - result: ${fmt(res.text)}`);
      if (tu.text?.trim()) lines.push(`  - note: ${fmt(tu.text)}`);
    }
  }
  lines.push('');
}

const md = lines.join('\n');
if (outFile) {
  writeFileSync(outFile, md, 'utf8');
  console.log(`written ${outFile}`);
} else {
  console.log(md);
}
