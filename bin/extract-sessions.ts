/**
 * Builds bench fixtures from OpenCode's own session store.
 *
 * The interesting part is the label: the last user prompt of a session is
 * followed by an assistant turn that actually used the history. Everything
 * that turn referenced (a file it read, a command it ran, an error line it
 * quoted) is a probe. If a probe lived in a tool result of the history, that
 * result was needed later, and dropping it is a dangerous decision — which is
 * exactly what the bench measures.
 *
 *   tsx bin/extract-sessions.ts --limit 10
 *   tsx bin/extract-sessions.ts --db ~/.local/share/opencode/opencode.db --max-calls 30
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolResult, ToolUse } from '../src/index.js';
import type { BenchCase, CallExpectation, Probe } from '../bench/types.js';

interface SessionRow {
  id: string;
  title: string;
  directory: string;
}

interface Step {
  role: 'user' | 'assistant';
  text: string;
  calls: { toolUseID: string; tool: string; input: Record<string, unknown>; result: string; isError: boolean }[];
}

const TARGET_KEYS = [
  'file_path',
  'path',
  'filePath',
  'notebook_path',
  'pattern',
  'command',
  'query',
  'url',
] as const;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
}

function query<T>(db: string, sql: string): T[] {
  const output = execFileSync('sqlite3', ['-json', db, sql], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
  return output.trim().length === 0 ? [] : (JSON.parse(output) as T[]);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function partText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) =>
      part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? ((part as { text: string }).text)
        : '',
    )
    .filter((text) => text.length > 0)
    .join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Stored messages -> turns: an assistant turn carries its calls and results. */
function stepsFrom(rows: { type: string; data: string }[]): Step[] {
  const steps: Step[] = [];
  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type === 'user') {
      const text = typeof data.text === 'string' ? data.text : '';
      if (text.trim().length > 0) steps.push({ role: 'user', text, calls: [] });
      continue;
    }
    if (row.type !== 'assistant') continue;

    const content = Array.isArray(data.content) ? data.content : [];
    const texts: string[] = [];
    const calls: Step['calls'] = [];
    for (const raw of content) {
      const part = asRecord(raw);
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        texts.push(part.text);
        continue;
      }
      if (part.type !== 'tool') continue;
      const state = asRecord(part.state);
      if (state.status === 'error') {
        const error = asRecord(state.error);
        calls.push({
          toolUseID: typeof part.id === 'string' ? part.id : '',
          tool: typeof part.name === 'string' ? part.name : 'tool',
          input: asRecord(state.input),
          result:
            typeof error.message === 'string'
              ? error.message
              : typeof state.error === 'string'
                ? state.error
                : 'tool failed',
          isError: true,
        });
        continue;
      }
      if (state.status !== 'completed') continue;
      const input = asRecord(state.input);
      const result = partText(state.content);
      calls.push({
        toolUseID: typeof part.id === 'string' ? part.id : '',
        tool: typeof part.name === 'string' ? part.name : 'tool',
        input,
        result,
        isError: state.metadata !== undefined && asRecord(state.metadata).isError === true,
      });
    }
    const text = texts.join('\n');
    if (text.trim().length === 0 && calls.length === 0) continue;
    steps.push({ role: 'assistant', text, calls });
  }
  return steps;
}

function toView(steps: Step[]): Message[] {
  const messages: Message[] = [];
  for (const step of steps) {
    if (step.role === 'user') {
      messages.push({ role: 'user', text: step.text, toolUses: [] });
      continue;
    }
    const toolUses: ToolUse[] = step.calls.map((call) => ({
      tool_use_id: call.toolUseID,
      tool: call.tool,
      input: call.input,
    }));
    messages.push({ role: 'assistant', text: step.text, toolUses });
    if (step.calls.length > 0) {
      const toolResults: ToolResult[] = step.calls.map((call) => ({
        tool_use_id: call.toolUseID,
        text: call.result,
        ...(call.isError ? { isError: true } : {}),
      }));
      messages.push({ role: 'user', text: '', toolUses: [], toolResults });
    }
  }
  return messages;
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Facts the next turn used: tool targets and quoted evidence. */
function probesFromNextTurn(steps: Step[]): string[] {
  const probes = new Set<string>();
  const add = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length < 8 || trimmed.length > 300) return;
    // Pure numbers and punctuation are shell noise, not a fact the next turn used.
    if (!/[a-zа-яё]/iu.test(trimmed)) return;
    probes.add(trimmed);
  };
  for (const step of steps) {
    for (const call of step.calls) {
      for (const key of TARGET_KEYS) {
        const value = call.input[key];
        if (typeof value === 'string') add(value);
      }
    }
    for (const line of step.text.split('\n')) {
      for (const match of line.matchAll(/`([^`]{8,200})`/gu)) add(match[1] ?? '');
      if (/\b(?:error|expected|received|failed|assert|traceback)\b/iu.test(line)) add(line);
    }
  }
  return [...probes].slice(0, 8);
}

interface Origin {
  origin: Probe['origin'];
  call?: Step['calls'][number];
  toolUseID?: string;
}

function findOrigin(steps: Step[], probe: string): Origin | undefined {
  const needle = normalize(probe);
  for (const step of steps) {
    for (const call of step.calls) {
      if (normalize(call.result).includes(needle)) {
        return { origin: 'result', call, toolUseID: call.toolUseID };
      }
    }
  }
  for (const step of steps) {
    for (const call of step.calls) {
      if (normalize(JSON.stringify(call.input)).includes(needle)) {
        return { origin: 'call', call, toolUseID: call.toolUseID };
      }
    }
  }
  for (const step of steps) {
    if (normalize(step.text).includes(needle)) return { origin: 'text', toolUseID: undefined };
  }
  return undefined;
}

function buildCase(
  session: SessionRow,
  rows: { type: string; data: string }[],
  maxCalls: number,
  minCalls: number,
): BenchCase | undefined {
  const steps = stepsFrom(rows);
  if (steps.length < 4) return undefined;

  // The last assistant turn is the "next turn"; the prompt before it is history.
  let nextStart = steps.length - 1;
  while (nextStart > 0 && !(steps[nextStart]?.role === 'assistant' && steps[nextStart]?.calls.length > 0)) {
    nextStart -= 1;
  }
  if (nextStart <= 1) return undefined;

  const next = steps.slice(nextStart, nextStart + 3);
  const probeTexts = probesFromNextTurn(next);
  if (probeTexts.length === 0) return undefined;

  let history = steps.slice(0, nextStart);
  let calls = history.reduce((sum, step) => sum + step.calls.length, 0);
  if (calls < minCalls) return undefined;
  while (calls > maxCalls && history.length > 2) {
    history = history.slice(1);
    calls = history.reduce((sum, step) => sum + step.calls.length, 0);
  }
  if (history[0]?.role !== 'user') {
    const firstUser = history.findIndex((step) => step.role === 'user');
    if (firstUser === -1) return undefined;
    history = history.slice(firstUser);
  }

  const expect: Record<string, CallExpectation> = {};
  const probes: Probe[] = [];
  for (const text of probeTexts) {
    const origin = findOrigin(history, text);
    if (!origin) continue;
    const probe: Probe = { text, origin: origin.origin };
    if (origin.toolUseID) probe.toolUseID = origin.toolUseID;
    if (origin.call) probe.call = origin.call.toolUseID;
    probes.push(probe);
    if (origin.origin === 'result' && origin.call) {
      expect[origin.call.toolUseID] = {
        ...(expect[origin.call.toolUseID] ?? {}),
        keepResult: true,
        source: 'next-turn',
      };
    } else if (origin.origin === 'call' && origin.call) {
      expect[origin.call.toolUseID] = {
        ...(expect[origin.call.toolUseID] ?? {}),
        keepCall: true,
        source: 'next-turn',
      };
    }
  }
  if (probes.length === 0) return undefined;

  return {
    id: `session-${session.id.replace(/^ses_/u, '').slice(0, 12)}`,
    note: `${probes.length} probe(s) from the turn after this history`,
    source: 'session',
    session: session.id,
    title: session.title,
    messages: toView(history),
    expect,
    probes,
  };
}

function main(): void {
  const db = arg('db', join(opencodeDataDir(), 'opencode.db'));
  const out = arg('out', 'bench/fixtures');
  const limit = Number(arg('limit', '10'));
  const maxCalls = Number(arg('max-calls', '25'));
  const minCalls = Number(arg('min-calls', '3'));
  const minMessages = Number(arg('min-messages', '12'));
  const scan = Number(arg('scan', '80'));

  mkdirSync(out, { recursive: true });
  const sessions = query<SessionRow>(
    db,
    `select s.id, s.title, s.directory, count(m.id) as n
     from session_v2 s join session_message m on m.session_id = s.id
     where m.type in ('user', 'assistant')
     group by s.id having n >= ${minMessages}
     order by n desc limit ${scan}`,
  );

  let written = 0;
  for (const session of sessions) {
    if (written >= limit) break;
    const rows = query<{ type: string; data: string }>(
      db,
      `select type, data from session_message where session_id = ${quote(session.id)} order by seq`,
    );
    const built = buildCase(session, rows, maxCalls, minCalls);
    if (!built) continue;
    writeFileSync(join(out, `${built.id}.json`), `${JSON.stringify(built, null, 2)}\n`);
    written += 1;
    console.log(`${built.id}: ${built.messages.length} messages, ${Object.keys(built.expect).length} labels, ${built.probes?.length ?? 0} probes`);
  }
  console.log(`\n${written} fixture(s) in ${out}`);
}

main();
