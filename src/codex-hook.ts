import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { JevClient } from './client.js';
import { compact } from './compact.js';
import {
  codexRecordsToMessages,
  recordFromCodexHook,
  renderCodexContext,
  type CodexRecord,
} from './codex.js';

type HookInput = {
  session_id?: unknown;
  hook_event_name?: unknown;
  source?: unknown;
};

function integer(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function number(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function sessionFile(pluginData: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return join(pluginData, 'sessions', `${digest}.jsonl`);
}

async function stdinJson(): Promise<unknown> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  return JSON.parse(raw);
}

async function appendRecord(path: string, record: CodexRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function readRecords(path: string): Promise<CodexRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: CodexRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CodexRecord);
    } catch {
      // Ignore an incomplete final append; hooks must never block Codex.
    }
  }
  return records;
}

async function run(): Promise<void> {
  const input = await stdinJson() as HookInput;
  if (typeof input.session_id !== 'string' || typeof input.hook_event_name !== 'string') return;
  const pluginData = process.env.PLUGIN_DATA;
  if (!pluginData) return;
  const path = sessionFile(pluginData, input.session_id);

  const record = recordFromCodexHook(input);
  if (record) {
    await appendRecord(path, record);
    return;
  }
  if (input.hook_event_name !== 'SessionStart' || input.source !== 'compact') return;

  const records = await readRecords(path);
  if (records.length === 0) return;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stdout.write(JSON.stringify({
      systemMessage: 'Fast Jev Compaction skipped context restoration because TYPESAFE_API_KEY is not configured.',
    }));
    return;
  }

  const clientOptions: { apiKey: string; model?: string } = { apiKey };
  if (process.env.FAST_JEV_MODEL) clientOptions.model = process.env.FAST_JEV_MODEL;
  const result = await compact(
    codexRecordsToMessages(records),
    new JevClient(clientOptions),
    {
      keepThreshold: number(process.env.FAST_JEV_KEEP_THRESHOLD, 0.5, 0),
      preserveRecentMessages: integer(process.env.FAST_JEV_PRESERVE_RECENT_MESSAGES, 6, 0),
      maxStateTokens: integer(process.env.FAST_JEV_MAX_STATE_TOKENS, 25_000, 1),
      maxRequestTokens: integer(process.env.FAST_JEV_MAX_REQUEST_TOKENS, 30_000, 1),
      truncateHeadChars: integer(process.env.FAST_JEV_TRUNCATE_HEAD_CHARS, 300, 0),
    },
  );
  const additionalContext = renderCodexContext(
    result,
    integer(process.env.FAST_JEV_CODEX_MAX_CONTEXT_CHARS, 18_000, 1),
  );
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
  await writeFile(path, '', 'utf8');
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fast-jev-compaction Codex hook: ${message}\n`);
  process.exitCode = 0;
});
