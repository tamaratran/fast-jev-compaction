import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bashExecutionToText,
  convertBranch,
  jevCompactionForPi,
  loadConfig,
  serializeOldRegion,
  EXTENSION_VERSION,
  type ResolvedFastJevConfig,
} from '../pi/core.ts';
import { collectToolCalls, type JevAsker, type JevQuestions, type JevResponse } from '../src/index.js';

// ---------------------------------------------------------------------------
// A synthetic pi session branch (structural SessionEntry objects)
// ---------------------------------------------------------------------------

interface TextPart {
  type: 'text';
  text: string;
}
interface ThinkingPart {
  type: 'thinking';
  thinking: string;
}
interface ToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type AgentMessage =
  | { role: 'user'; content: string | TextPart[]; timestamp: number }
  | {
      role: 'assistant';
      content: (TextPart | ThinkingPart | ToolCallPart)[];
      api: string;
      provider: string;
      model: string;
      usage: unknown;
      stopReason: string;
      timestamp: number;
    }
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: string;
      content: TextPart[];
      isError: boolean;
      timestamp: number;
    };

type SessionEntry = { type: 'message'; id: string; parentId: string; timestamp: Date; message: AgentMessage };

const ts = Date.now();
const fileA = 'export const a = 1;\n'.repeat(100); // 2000 chars
const globOut = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`).join('\n');
const grepOut = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts: match number ${i}`).join('\n');
const bashOut = 'PASS 12 tests\nFAIL b.test.ts: expected 2 to be 3\n';

function buildEntries(): { entries: SessionEntry[]; keptEntryId: string } {
  const entries: SessionEntry[] = [];
  let parentId: string | undefined;
  let n = 0;
  const add = (message: AgentMessage): string => {
    const id = `e${++n}`;
    entries.push({ type: 'message', id, parentId, timestamp: new Date(ts), message });
    parentId = id;
    return id;
  };

  add({ role: 'user', content: 'Fix the failing test. Never edit src/generated.', timestamp: ts });
  add({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'I should read the file first.' },
      { type: 'text', text: 'Reading the file.' },
      { type: 'toolCall', id: 'call_read_a', name: 'read', arguments: { path: 'src/a.ts' } },
    ],
    api: 'test', provider: 'test', model: 'test', usage: {}, stopReason: 'toolUse', timestamp: ts,
  });
  add({ role: 'toolResult', toolCallId: 'call_read_a', toolName: 'read', content: [{ type: 'text', text: fileA }], isError: false, timestamp: ts });
  add({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Searching for usages.' },
      { type: 'toolCall', id: 'call_glob', name: 'glob', arguments: { pattern: '**/*.ts' } },
      { type: 'toolCall', id: 'call_grep', name: 'grep', arguments: { pattern: 'foo' } },
    ],
    api: 'test', provider: 'test', model: 'test', usage: {}, stopReason: 'toolUse', timestamp: ts,
  });
  add({ role: 'toolResult', toolCallId: 'call_glob', toolName: 'glob', content: [{ type: 'text', text: globOut }], isError: false, timestamp: ts });
  add({ role: 'toolResult', toolCallId: 'call_grep', toolName: 'grep', content: [{ type: 'text', text: grepOut }], isError: false, timestamp: ts });
  add({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running the tests.' },
      { type: 'toolCall', id: 'call_bash', name: 'bash', arguments: { command: 'npm test' } },
    ],
    api: 'test', provider: 'test', model: 'test', usage: {}, stopReason: 'toolUse', timestamp: ts,
  });
  add({ role: 'toolResult', toolCallId: 'call_bash', toolName: 'bash', content: [{ type: 'text', text: bashOut }], isError: false, timestamp: ts });
  add({
    role: 'assistant',
    content: [{ type: 'text', text: 'The failure is in b.test.ts; fixing now.' }],
    api: 'test', provider: 'test', model: 'test', usage: {}, stopReason: 'stop', timestamp: ts,
  });
  const keptEntryId = add({ role: 'user', content: 'go ahead', timestamp: ts });
  add({
    role: 'assistant',
    content: [{ type: 'text', text: 'Done, all tests pass now.' }],
    api: 'test', provider: 'test', model: 'test', usage: {}, stopReason: 'stop', timestamp: ts,
  });
  return { entries, keptEntryId };
}

// ---------------------------------------------------------------------------
// Fake Jev: per-call keep probabilities keyed by short id (t1..t4)
// ---------------------------------------------------------------------------

const fakeAnswers: Record<string, { keepCall: number; keepResult: number }> = {
  t1: { keepCall: 0.9, keepResult: 0.9 }, // read → keep
  t2: { keepCall: 0.1, keepResult: 0.1 }, // glob → drop_call
  t3: { keepCall: 0.9, keepResult: 0.1 }, // grep → drop_result
  t4: { keepCall: 0.8, keepResult: 0.6 }, // bash → keep
};

const fakeJev: JevAsker = {
  ask: async (_state, questions: JevQuestions): Promise<JevResponse> => {
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const key of Object.keys(questions)) {
      const shortId = key.replace(/^(call|result)_/, '');
      const answer = fakeAnswers[shortId];
      if (!answer) throw new Error(`unexpected question ${key}`);
      answers[key] = {
        type: 'noul',
        noul: key.startsWith('call_') ? answer.keepCall : answer.keepResult,
      };
    }
    return { answers, usage: { input_tokens: 1000, output_tokens: 7 } };
  },
};

const CONFIG: ResolvedFastJevConfig = {
  keepThreshold: 0.5,
  maxStateTokens: Number.POSITIVE_INFINITY,
  maxRequestTokens: Number.POSITIVE_INFINITY,
  truncateHeadChars: 300,
  minOldReduction: 0.25,
  dropThinking: false,
  notify: true,
  disabled: false,
};

describe('convertBranch', () => {
  const { entries, keptEntryId } = buildEntries();

  it('splits old and kept regions at firstKeptEntryId', () => {
    const transcript = convertBranch(entries as never, keptEntryId);
    expect(transcript).toBeDefined();
    if (!transcript) return;
    expect(transcript.messages[transcript.oldCount - 1]?.text).toBe(
      'The failure is in b.test.ts; fixing now.',
    );
    expect(transcript.messages[transcript.oldCount]?.text).toBe('go ahead');
    expect(transcript.messages[transcript.messages.length - 1]?.text).toBe(
      'Done, all tests pass now.',
    );
  });

  it('captures assistant thinking in metas and tool names on results', () => {
    const transcript = convertBranch(entries as never, keptEntryId);
    if (!transcript) return;
    expect(transcript.metas.some((m) => m.thinking === 'I should read the file first.')).toBe(true);
    expect(transcript.metas.some((m) => m.toolNames.includes('read'))).toBe(true);
  });

  it('pins exactly the kept region', () => {
    const transcript = convertBranch(entries as never, keptEntryId);
    if (!transcript) return;
    const calls = collectToolCalls(
      transcript.messages,
      transcript.messages.length - transcript.oldCount,
    );
    expect(calls.map((c) => c.tool)).toEqual(['read', 'glob', 'grep', 'bash']);
    expect(calls.every((c) => !c.pinned)).toBe(true);
  });

  it('returns undefined when firstKeptEntryId is not on the branch', () => {
    expect(convertBranch(entries as never, 'nope')).toBeUndefined();
  });
});

describe('bashExecutionToText', () => {
  it('matches pi rendering', () => {
    expect(
      bashExecutionToText({ command: 'ls', output: 'a\nb', exitCode: 0, cancelled: false, truncated: false }),
    ).toBe('Ran `ls`\n```\na\nb\n```');
    expect(
      bashExecutionToText({ command: 'ls', output: '', exitCode: 2, cancelled: false, truncated: false }),
    ).toBe('Ran `ls`\n(no output)\n\nCommand exited with code 2');
  });
});

describe('jevCompactionForPi', () => {
  const { entries, keptEntryId } = buildEntries();

  it('serializes the old region verbatim with decisions applied', async () => {
    const outcome = await jevCompactionForPi({
      branchEntries: entries as never,
      firstKeptEntryId: keptEntryId,
      tokensBefore: 12_345,
      asker: fakeJev,
      config: CONFIG,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const summary = outcome.summary;
    expect(summary).toContain('<fast-jev-compaction>');
    expect(summary).toContain('[User]\nFix the failing test. Never edit src/generated.');
    expect(summary).toContain('[Assistant thinking]\nI should read the file first.');
    expect(summary).toContain('[Tool call read]');
    expect(summary).toContain(`[Tool result read — verbatim, ${fileA.length} chars]`);
    expect(summary).toContain('export const a = 1;');
    expect(summary).not.toContain('[Tool call glob]');
    expect(summary).not.toContain('src/file29.ts');
    expect(summary).toContain('[Tool call grep]');
    expect(summary).toContain('[Tool result grep — truncated]');
    expect(summary).toContain('[fast-jev-compaction truncated');
    expect(summary).toContain('src/file0.ts: match number 0');
    expect(summary).toContain('FAIL b.test.ts: expected 2 to be 3');
    expect(summary).toContain('The failure is in b.test.ts; fixing now.');
    expect(summary).not.toContain('go ahead');
    expect(summary).not.toContain('Done, all tests pass now.');
  });

  it('reports decisions, usage and reduction', async () => {
    const outcome = await jevCompactionForPi({
      branchEntries: entries as never,
      firstKeptEntryId: keptEntryId,
      tokensBefore: 12_345,
      asker: fakeJev,
      config: CONFIG,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const d = outcome.details.fastJev;
    expect(d.version).toBe(EXTENSION_VERSION);
    expect(d.decisions.map((x) => x.action)).toEqual(['keep', 'drop_call', 'drop_result', 'keep']);
    expect(d.jev.inputTokens).toBe(1000);
    expect(d.jev.outputTokens).toBe(7);
    expect(outcome.usage?.input).toBe(1000);
    expect(outcome.usage?.totalTokens).toBe(1007);
    expect(outcome.oldReduction).toBeGreaterThan(0.25);
    expect(outcome.tokensBefore).toBe(12_345);
    expect(outcome.firstKeptEntryId).toBe(keptEntryId);
    expect(outcome.report).toContain('no LLM summary');
  });

  it('drops thinking when configured', async () => {
    const outcome = await jevCompactionForPi({
      branchEntries: entries as never,
      firstKeptEntryId: keptEntryId,
      tokensBefore: 12_345,
      asker: fakeJev,
      config: { ...CONFIG, dropThinking: true },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).not.toContain('[Assistant thinking]');
  });

  it('falls back when Jev fails', async () => {
    const failing: JevAsker = { ask: async () => { throw new Error('boom'); } };
    const outcome = await jevCompactionForPi({
      branchEntries: entries as never,
      firstKeptEntryId: keptEntryId,
      tokensBefore: 1,
      asker: failing,
      config: CONFIG,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fallback).toContain('Jev failed: boom');
  });

  it('falls back when reduction is below the minimum', async () => {
    const outcome = await jevCompactionForPi({
      branchEntries: entries as never,
      firstKeptEntryId: keptEntryId,
      tokensBefore: 1,
      asker: fakeJev,
      config: { ...CONFIG, minOldReduction: 0.99 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fallback).toContain('insufficient reduction');
  });

  it('falls back when there are no tool calls to evaluate', async () => {
    const outcome = await jevCompactionForPi({
      branchEntries: entries.slice(-3) as never,
      firstKeptEntryId: keptEntryId,
      tokensBefore: 1,
      asker: fakeJev,
      config: CONFIG,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fallback).toContain('no tool calls to evaluate');
  });

  it('falls back when firstKeptEntryId is not on the branch', async () => {
    const outcome = await jevCompactionForPi({
      branchEntries: entries as never,
      firstKeptEntryId: 'missing',
      tokensBefore: 1,
      asker: fakeJev,
      config: CONFIG,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fallback).toContain('not found on branch');
  });
});

describe('serializeOldRegion', () => {
  const { entries, keptEntryId } = buildEntries();

  it('maps decision ids onto tool_use_ids standalone', () => {
    const transcript = convertBranch(entries as never, keptEntryId);
    if (!transcript) return;
    const calls = collectToolCalls(
      transcript.messages,
      transcript.messages.length - transcript.oldCount,
    );
    const ser = serializeOldRegion(
      transcript,
      [
        { id: 't2', tool: 'glob', keepCall: 0.1, keepResult: 0.1, action: 'drop_call', reason: 'call_dropped' },
        { id: 't3', tool: 'grep', keepCall: 0.9, keepResult: 0.1, action: 'drop_result', reason: 'result_dropped' },
      ],
      calls,
      { truncateHeadChars: 50, dropThinking: false },
    );
    expect(ser.text).not.toContain('[Tool call glob]');
    expect(ser.text).toContain('src/file0.ts: match number 0');
    expect(ser.charsAfter).toBeLessThanOrEqual(ser.charsBefore);
    expect(ser.messagesKept).toBeGreaterThan(0);
    expect(ser.messagesKept).toBeLessThanOrEqual(transcript.oldCount);
  });
});

describe('loadConfig', () => {
  it('layers defaults, files and environment', () => {
    const tmpA = mkdtempSync(join(tmpdir(), 'fj-global-'));
    const tmpB = mkdtempSync(join(tmpdir(), 'fj-proj-'));
    mkdirSync(join(tmpB, '.pi'), { recursive: true });
    writeFileSync(
      join(tmpA, 'fast-jev-compaction.json'),
      JSON.stringify({ apiKey: 'global-key', keepThreshold: 0.7, notify: false }),
    );
    writeFileSync(
      join(tmpB, '.pi', 'fast-jev-compaction.json'),
      JSON.stringify({ keepThreshold: 0.8, dropThinking: true }),
    );

    const cfg = loadConfig({
      agentDir: tmpA,
      cwd: tmpB,
      configDirName: '.pi',
      env: { TYPESAFE_API_KEY: 'env-key' },
    });
    expect(cfg.apiKey).toBe('global-key');
    expect(cfg.keepThreshold).toBe(0.8);
    expect(cfg.notify).toBe(false);
    expect(cfg.dropThinking).toBe(true);

    const cfgEnv = loadConfig({
      agentDir: tmpA,
      cwd: tmpB,
      configDirName: '.pi',
      env: {
        TYPESAFE_API_KEY: 'env-key',
        FAST_JEV_KEEP_THRESHOLD: '0.9',
        FAST_JEV_DISABLE: '1',
        FAST_JEV_NOTIFY: '0',
      },
    });
    expect(cfgEnv.keepThreshold).toBe(0.9);
    expect(cfgEnv.disabled).toBe(true);

    const tmpC = mkdtempSync(join(tmpdir(), 'fj-env-'));
    expect(
      loadConfig({
        agentDir: tmpC,
        cwd: tmpC,
        configDirName: '.pi',
        env: { FAST_JEV_API_KEY: 'specific', TYPESAFE_API_KEY: 'generic' },
      }).apiKey,
    ).toBe('specific');
    expect(
      loadConfig({
        agentDir: tmpC,
        cwd: tmpC,
        configDirName: '.pi',
        env: { TYPESAFE_API_KEY: 'generic' },
      }).apiKey,
    ).toBe('generic');
  });
});
