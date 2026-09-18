import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  getApiKey,
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

function jevFetch(answer: (name: string) => number, bodies: string[] = [], urls: string[] = []) {
  return async (url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    urls.push(url);
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({ retries: 1, retryDelayMs: 0 })).toMatchObject({ retries: 1, retryDelayMs: 0 });
    expect(resolveHookConfig({})).toEqual({
      onBatchFailure: 'throw',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      model: 'jev-latest',
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      apiKeyEnv: 'TYPESAFE_API_KEY',
    });
    expect(
      resolveHookConfig({
        apiKey: 'k',
        keepThreshold: 0.3,
        maxStateTokens: 1000,
        model: 'jev-x',
        goal: 'g',
        compactAtPercent: 'no',
        baseUrl: 'https://gateway.example/v1/systemone',
        apiKeyEnv: 'GATEWAY_KEY',
        onBatchFailure: 'keep',
      }),
    ).toEqual({
      apiKey: 'k',
      onBatchFailure: 'keep',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      baseUrl: 'https://gateway.example/v1/systemone',
      apiKeyEnv: 'GATEWAY_KEY',
    });
  });

  it('ignores an empty baseUrl or apiKeyEnv and keeps the defaults', () => {
    expect(resolveHookConfig({ baseUrl: '', apiKeyEnv: '' })).toMatchObject({
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      apiKeyEnv: 'TYPESAFE_API_KEY',
    });
  });
});

describe('getApiKey', () => {
  function host(env: Record<string, string>, settingsEnv: Record<string, unknown> = {}) {
    return {
      env: { get: async (name: string) => env[name] },
      settings: { read: async () => ({ env: settingsEnv })},
    };
  }

  it('reads the default TYPESAFE_API_KEY from the process, then from settings.env', async () => {
    const config = { apiKeyEnv: 'TYPESAFE_API_KEY' };
    await expect(getApiKey(host({ TYPESAFE_API_KEY: 'from-env' }, { TYPESAFE_API_KEY: 'x' }), config)).resolves.toBe('from-env');
    await expect(getApiKey(host({}, { TYPESAFE_API_KEY: 'from-settings' }), config)).resolves.toBe('from-settings');
    await expect(getApiKey(host({}, {}), config)).resolves.toBeUndefined();
  });

  it('reads a custom apiKeyEnv from settings.env only, never the default variable', async () => {
    const config = { apiKeyEnv: 'GATEWAY_KEY' };
    await expect(getApiKey(host({ TYPESAFE_API_KEY: 'wrong' }, { GATEWAY_KEY: 'from-settings' }), config)).resolves.toBe('from-settings');
    await expect(getApiKey(host({ TYPESAFE_API_KEY: 'wrong' }, { TYPESAFE_API_KEY: 'wrong' }), config)).resolves.toBeUndefined();
    await expect(getApiKey(host({ GATEWAY_KEY: 'process-only' }, {}), config)).resolves.toBeUndefined();
  });

  it('prefers the sensitive apiKey option over any variable', async () => {
    await expect(getApiKey(host({ GATEWAY_KEY: 'from-env' }), { apiKey: 'opt', apiKeyEnv: 'GATEWAY_KEY' })).resolves.toBe('opt');
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
    const urls: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies, urls),
    );
    expect(bodies).toHaveLength(1);
    expect(urls).toEqual(['https://api.typesafe.ai/v1/systemone']);
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

  it('posts to the configured baseUrl with the configured model', async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const config = {
      ...resolveHookConfig({
        preserveRecentMessages: 1,
        baseUrl: 'https://gateway.example/v1/systemone',
        model: 'typesafe/jev-latest',
      }),
      apiKey: 'k',
    };
    await compactSession(transcript(), config, jevFetch(() => 0.9, bodies, urls));
    expect(urls).toEqual(['https://gateway.example/v1/systemone']);
    expect(JSON.parse(bodies[0]!).model).toBe('typesafe/jev-latest');
  });

  it('retries a throwing engine fetch, then gives up', async () => {
    let calls = 0;
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', retries: 1, retryDelayMs: 0 };
    await expect(
      compactSession(transcript(), config, async () => { calls++; throw new Error('ECONNRESET'); }),
    ).rejects.toThrow(/Jev transport failed: ECONNRESET/);
    expect(calls).toBe(2);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), resolveHookConfig({ preserveRecentMessages: 1, apiKeyEnv: 'GATEWAY_KEY' }), jevFetch(() => 0)),
    ).rejects.toThrow(/GATEWAY_KEY is not configured/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k', retryDelayMs: 0 }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('register', () => {
  type Hook = (...args: any[]) => Promise<unknown>;
  function registered(options: Record<string, unknown> = {}) {
    const hooks: Record<string, Hook> = {};
    (register as any)((event: string, hook: Hook) => { hooks[event] = hook; }, { apiKey: 'k', ...options });
    return hooks;
  }
  function engine(fetchFn: ReturnType<typeof jevFetch>) {
    const logs: string[] = [];
    const toasts: string[] = [];
    const compactCalls: unknown[] = [];
    const $ = {
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
      http: {
        fetch: async (url: string, init?: { body?: string }) => {
          const r = await fetchFn(url, init);
          return { ...r, headers: {} };
        },
      },
      ui: { log: (t: string) => logs.push(t), toast: (t: string) => toasts.push(t) },
      session: {
        usage: async () => ({ context: { percent: 100 } }),
        compact: async (...args: unknown[]) => { compactCalls.push(args); return { messages: [] }; },
      },
    };
    return { $, logs, toasts, compactCalls };
  }

  it('toasts a manual compaction but only logs a precompute', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const next = async () => ({ messages: [] });
    const manual = engine(jevFetch(() => 0.1));
    const out = (await hooks['session.compact']!(manual.$, { trigger: 'manual', messages: transcript() }, next)) as { messages: unknown[] };
    expect(out.messages).toHaveLength(3);
    expect(manual.toasts).toHaveLength(1);
    expect(manual.toasts[0]).toMatch(/^kept 3\/7 messages/);

    const pre = engine(jevFetch(() => 0.1));
    const outPre = (await hooks['session.compact']!(pre.$, { trigger: 'precompute', messages: transcript() }, next)) as { messages: unknown[] };
    expect(outPre.messages).toHaveLength(3);
    expect(pre.toasts).toEqual([]);
    expect(pre.logs.some((l) => l.startsWith('kept 3/7 messages'))).toBe(true);
  });

  it('waits through $.clock.sleep bound to the dispatch signal, and vetoes an interrupted compaction', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    let fetches = 0;
    const flaky = async (url: string, init?: { body?: string }) => {
      fetches++;
      if (fetches === 1) return { status: 503, ok: false, text: 'down' };
      return jevFetch(() => 0.1)(url, init);
    };
    const e = engine(flaky);
    const sleeps: Array<{ ms: number; signal: unknown }> = [];
    const controller = new AbortController();
    const $ = { ...e.$, clock: { sleep: async (ms: number, o?: { signal?: AbortSignal }) => { sleeps.push({ ms, signal: o?.signal }); } } };
    const next = Object.assign(async () => ({ messages: [] }), { signal: controller.signal });
    (register as any)((event: string, hook: Hook) => { hooks[event] = hook; }, { apiKey: 'k', preserveRecentMessages: 1, minReductionRatio: 0, retries: 1, retryDelayMs: 7 });
    const out = (await hooks['session.compact']!($, { trigger: 'manual', messages: transcript() }, next)) as { messages: unknown[] };
    expect(out.messages).toHaveLength(3);
    expect(fetches).toBe(2);
    expect(sleeps).toEqual([{ ms: 7, signal: controller.signal }]);

    // the same hook, interrupted while it waits: no toast, no fallback, a skip
    const aborted = new AbortController();
    let nexts = 0;
    const nextAborted = Object.assign(async () => { nexts++; return { messages: [] }; }, { signal: aborted.signal });
    fetches = 0;
    const e2 = engine(flaky);
    const $2 = { ...e2.$, clock: { sleep: async () => { aborted.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } } };
    const out2 = await hooks['session.compact']!($2, { trigger: 'manual', messages: transcript() }, nextAborted);
    expect(out2).toEqual({ skip: 'fast-jev-compaction: interrupted' });
    expect(nexts).toBe(0);
    expect(e2.toasts).toEqual([]);
  });

  it('a precompute stays quiet on the fallback paths too', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 1 });
    const next = async () => ({ messages: [] });
    const below = engine(jevFetch(() => 0.1));
    await hooks['session.compact']!(below.$, { trigger: 'precompute', messages: transcript() }, next);
    expect(below.toasts).toEqual([]);
    expect(below.logs.some((l) => l.startsWith('fallback to built-in summary (below'))).toBe(true);
    const failing = engine(async () => ({ status: 401, ok: false, text: 'nope' }));
    await hooks['session.compact']!(failing.$, { trigger: 'precompute', messages: transcript() }, next);
    expect(failing.toasts).toEqual([]);
    expect(failing.logs.some((l) => l.includes('(401)'))).toBe(true);
  });

  it('logs a warning when baseUrl is not https', async () => {
    const hooks = registered({ preserveRecentMessages: 1, baseUrl: 'http://gateway.internal/v1/systemone' });
    const e = engine(jevFetch(() => 0.1));
    await hooks['session.compact']!(e.$, { trigger: 'manual', messages: transcript() }, async () => ({ messages: [] }));
    expect(e.logs.some((l) => l.includes('is not https'))).toBe(true);
    const https = engine(jevFetch(() => 0.1));
    (register as any)((event: string, hook: Hook) => { hooks[event] = hook; }, { apiKey: 'k', preserveRecentMessages: 1 });
    await hooks['session.compact']!(https.$, { trigger: 'manual', messages: transcript() }, async () => ({ messages: [] }));
    expect(https.logs.some((l) => l.includes('is not https'))).toBe(false);
  });

  it('does not request compaction from a subagent turn', async () => {
    const hooks = registered({ compactAtPercent: 50 });
    let nextCalls = 0;
    const next = async (e: unknown) => { nextCalls++; return e; };
    const sub = engine(jevFetch(() => 0.1));
    await hooks['turn.complete']!(sub.$, { agentId: 'agent-1', turnId: 't', isAborted: false }, next);
    expect(sub.compactCalls).toEqual([]);
    const main = engine(jevFetch(() => 0.1));
    await hooks['turn.complete']!(main.$, { turnId: 't', isAborted: false }, next);
    expect(main.compactCalls).toHaveLength(1);
    expect(nextCalls).toBe(2);
  });
});
