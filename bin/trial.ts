/**
 * Reads the plugin's trial log and prints the numbers that decide whether the
 * compaction is worth keeping.
 *
 *   tsx bin/trial.ts
 *   tsx bin/trial.ts --since 2026-11-20 --log ~/.local/share/opencode/fast-jev-compaction/trial.jsonl
 *   tsx bin/trial.ts --json
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Entry {
  at: string;
  session: string;
  backend: string;
  transport: string;
  ok: boolean;
  reason?: string;
  error?: string;
  ms: number;
  reduction?: number;
  stats?: {
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    charsBefore: number;
    charsAfter: number;
    stateTokens: number;
    stateStage: string;
    requests: number;
  };
  decisions?: { action: string; tool: string }[];
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

function defaultLog(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? join(xdg, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
  return join(base, 'fast-jev-compaction', 'trial.jsonl');
}

const path = arg('log', defaultLog());
const since = arg('since', '');
const asJson = process.argv.includes('--json');

let lines: string[];
try {
  lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
} catch {
  console.error(`no trial log at ${path}`);
  process.exit(1);
}

const entries = lines
  .map((line) => JSON.parse(line) as Entry)
  .filter((entry) => since.length === 0 || entry.at >= since)
  .sort((a, b) => a.at.localeCompare(b.at));

if (entries.length === 0) {
  console.log(`no entries${since ? ` since ${since}` : ''} in ${path}`);
  process.exit(0);
}

const count = (pick: (entry: Entry) => string): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const entry of entries) totals[pick(entry)] = (totals[pick(entry)] ?? 0) + 1;
  return totals;
};
const charsBefore = entries.reduce((sum, entry) => sum + (entry.stats?.charsBefore ?? 0), 0);
const charsAfter = entries.reduce((sum, entry) => sum + (entry.stats?.charsAfter ?? 0), 0);
const saved = charsBefore === 0 ? 0 : 1 - charsAfter / charsBefore;
const calls = entries.reduce((sum, entry) => sum + (entry.stats?.calls ?? 0), 0);
const actions = count((entry) => entry.ok ? 'ok' : (entry.reason ?? 'failed'));

const summary = {
  log: path,
  since: since || undefined,
  attempts: entries.length,
  outcomes: actions,
  backends: count((entry) => entry.backend),
  calls,
  charactersBefore: charsBefore,
  charactersAfter: charsAfter,
  saved,
  meanReduction:
    entries.reduce((sum, entry) => sum + (entry.reduction ?? 0), 0) / entries.length,
  meanMs: entries.reduce((sum, entry) => sum + entry.ms, 0) / entries.length,
  requests: entries.reduce((sum, entry) => sum + (entry.stats?.requests ?? 0), 0),
  stages: count((entry) => entry.stats?.stateStage || 'none'),
  errors: count((entry) =>
    entry.reason === 'error' ? (entry.error ?? 'unknown').slice(0, 80) : '',
  ),
};

if (asJson) {
  console.log(JSON.stringify({ summary, entries }, null, 2));
  process.exit(0);
}

console.log(`log         ${path}`);
if (since) console.log(`since       ${since}`);
console.log(`attempts    ${summary.attempts}`);
for (const [outcome, total] of Object.entries(actions).sort()) {
  console.log(`  ${outcome.padEnd(16)} ${total}`);
}
console.log(`backends    ${Object.entries(summary.backends).map(([name, total]) => `${name} (${total})`).join(', ')}`);
console.log(`calls       ${summary.calls}`);
console.log(`saved       ${(summary.saved * 100).toFixed(0)}% of characters, mean decision reduction ${(summary.meanReduction * 100).toFixed(0)}%`);
console.log(`latency     mean ${summary.meanMs.toFixed(0)} ms`);
console.log(`requests    ${summary.requests}`);
console.log(`fittings    ${Object.entries(summary.stages).map(([stage, total]) => `${stage}: ${total}`).join(', ')}`);
const errors = Object.entries(summary.errors).filter(([message]) => message.length > 0);
if (errors.length > 0) {
  console.log('errors');
  for (const [message, total] of errors.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(total).padStart(3)} ${message}`);
  }
}

const recent = entries.slice(-8).reverse();
console.log('');
console.log('recent');
for (const entry of recent) {
  const savedPart =
    entry.stats && entry.stats.charsBefore > 0
      ? `${Math.round((1 - entry.stats.charsAfter / entry.stats.charsBefore) * 100)}%`
      : '-';
  console.log(
    `  ${entry.at}  ${entry.ok ? 'ok' : (entry.reason ?? 'failed')}  ${entry.backend}  ${savedPart}  ${entry.ms} ms`,
  );
}
