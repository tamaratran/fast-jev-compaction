import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  mayUseBuiltin,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      model: 'jev-latest',
      builtinFallback: 'auto',
    });
    expect(
      resolveHookConfig({
        apiKey: 'k',
        keepThreshold: 0.3,
        maxStateTokens: 1000,
        model: 'jev-x',
        goal: 'g',
        compactAtPercent: 'no',
        builtinFallback: 'sometimes',
      }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      builtinFallback: 'auto',
    });
    expect(resolveHookConfig({ builtinFallback: 'never' }).builtinFallback).toBe('never');
    expect(resolveHookConfig({ builtinFallback: 'always' }).builtinFallback).toBe('always');
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

type Hook = ($: unknown, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>;

/** The hooks `register` installs, keyed by event, with the given plugin options. */
function hooks(options: Record<string, unknown> = {}): Record<string, Hook> {
  const registered: Record<string, Hook> = {};
  const on = (event: string, hook: Hook) => {
    registered[event] = hook;
  };
  (register as unknown as (on: unknown, options: unknown) => void)(on, options);
  return registered;
}

function host(fetch: ReturnType<typeof jevFetch>) {
  const notices: string[] = [];
  const $ = {
    env: { get: async (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k' : undefined) },
    settings: { read: async () => ({}) },
    http: { fetch },
    ui: { log: (text: string) => notices.push(text), toast: () => {} },
  };
  return { $, notices };
}

const CORE = { messages: ['built-in summary'] };

async function compactWith(
  trigger: string,
  fetch: ReturnType<typeof jevFetch>,
  options: Record<string, unknown> = {},
) {
  const { $, notices } = host(fetch);
  let delegated = false;
  const out = await hooks({ preserveRecentMessages: 1, ...options })['session.compact']!(
    $,
    { trigger, messages: transcript() },
    async () => {
      delegated = true;
      return CORE;
    },
  );
  return { out, delegated, notices };
}

const failing = async () => ({ status: 500, ok: false, text: 'upstream error' });

describe('built-in summary fallback', () => {
  it('is only for the engine auto compaction by default', () => {
    expect(mayUseBuiltin('auto', 'auto')).toBe(true);
    for (const trigger of ['manual', 'plugin', 'precompute', undefined]) {
      expect(mayUseBuiltin(trigger, 'auto')).toBe(false);
      expect(mayUseBuiltin(trigger, 'always')).toBe(true);
      expect(mayUseBuiltin(trigger, 'never')).toBe(false);
    }
    expect(mayUseBuiltin('auto', 'never')).toBe(false);
  });

  it('installs a Jev result that clears the minimum on any trigger', async () => {
    for (const trigger of ['manual', 'auto']) {
      const { out, delegated, notices } = await compactWith(trigger, jevFetch(() => 0.1));
      expect(delegated).toBe(false);
      expect((out as { messages: unknown[] }).messages.length).toBeLessThan(transcript().length);
      expect(notices.at(-1)).toMatch(/^kept \d+\/7 messages, no summary/);
    }
  });

  it('leaves a /compact that Jev cannot shrink as it is', async () => {
    const { out, delegated, notices } = await compactWith('manual', jevFetch(() => 0.9));
    expect(delegated).toBe(false);
    expect(out).toEqual({
      skip: expect.stringMatching(/^fast-jev-compaction: below 25% minimum: 0% reduction; .*; conversation left as it is$/),
    });
    expect(notices.at(-1)).toMatch(/^not compacted, no built-in summary \(below 25% minimum/);
  });

  it('hands an engine auto compaction that Jev cannot shrink to the built-in summary', async () => {
    const { out, delegated, notices } = await compactWith('auto', jevFetch(() => 0.9));
    expect(delegated).toBe(true);
    expect(out).toBe(CORE);
    expect(notices.at(-1)).toMatch(/^fallback to built-in summary \(below 25% minimum/);
  });

  it('skips on a Jev failure unless the engine itself is compacting', async () => {
    for (const trigger of ['manual', 'plugin', 'precompute']) {
      const { out, delegated } = await compactWith(trigger, failing);
      expect(delegated).toBe(false);
      expect(out).toEqual({ skip: expect.stringMatching(/500.*; conversation left as it is$/) });
    }
    const { out, delegated } = await compactWith('auto', failing);
    expect(delegated).toBe(true);
    expect(out).toBe(CORE);
  });

  it('keeps the skip notice to one short line', async () => {
    const long = async () => ({ status: 403, ok: false, text: `<!DOCTYPE html>${'x'.repeat(2000)}` });
    const { out } = await compactWith('manual', long);
    expect((out as { skip: string }).skip.length).toBeLessThan(300);
  });

  it('follows builtinFallback always and never', async () => {
    expect((await compactWith('manual', jevFetch(() => 0.9), { builtinFallback: 'always' })).out).toBe(CORE);
    expect((await compactWith('auto', jevFetch(() => 0.9), { builtinFallback: 'never' })).out).toEqual({
      skip: expect.stringMatching(/conversation left as it is$/),
    });
  });
});

describe('turn.complete request', () => {
  function driver() {
    const turnComplete = hooks()['turn.complete']!;
    const state = { percent: 0, answer: { skip: 'nothing to prune' } as { skip?: string }, requested: [] as number[] };
    const $ = {
      session: {
        usage: async () => ({ context: { percent: state.percent } }),
        compact: async () => {
          state.requested.push(state.percent);
          return state.answer;
        },
      },
      ui: { log: () => {} },
    };
    const turn = async (percent: number) => {
      state.percent = percent;
      await turnComplete($, {}, async () => ({}));
    };
    return { state, turn };
  }

  it('asks again after a skipped request only once the context has grown', async () => {
    const { state, turn } = driver();
    for (const percent of [50, 61, 65, 70, 71]) await turn(percent);
    state.answer = {};
    for (const percent of [81, 62]) await turn(percent);
    expect(state.requested).toEqual([61, 71, 81, 62]);
  });

  it('forgets the wait once the context drops below compactAtPercent', async () => {
    const { state, turn } = driver();
    for (const percent of [61, 65, 30, 61]) await turn(percent);
    expect(state.requested).toEqual([61, 61]);
  });
});
