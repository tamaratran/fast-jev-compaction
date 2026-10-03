import { describe, expect, it } from 'vitest';
import {
  classifySessionDepth,
  compactSession,
  decisionLog,
  decisionLogLines,
  depthLogLine,
  providerFor,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import {
  applyDecisions,
  collectToolCalls,
  decideCall,
  isOpenRouterKey,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_JEV_MODEL,
  type Message,
} from '../src/index.js';

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
    urls.push(url);
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
      depthClassification: true,
      depthThreshold: 0.5,
    });
    expect(
      resolveHookConfig({
        apiKey: 'k',
        keepThreshold: 0.3,
        maxStateTokens: 1000,
        model: 'jev-x',
        goal: 'g',
        compactAtPercent: 'no',
        depthClassification: false,
        depthThreshold: 0.8,
      }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      depthClassification: false,
      depthThreshold: 0.8,
    });
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
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(
      /TYPESAFE_API_KEY|OPENROUTER_API_KEY/,
    );
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });

  it('routes an OpenRouter key to the decisions endpoint with the Jev model', async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'sk-or-v1-test' };
    await compactSession(transcript(), config, jevFetch(() => 0.1, bodies, urls));
    expect(urls[0]).toBe(OPENROUTER_DECISIONS_URL);
    expect(JSON.parse(bodies[0]!).model).toBe(OPENROUTER_JEV_MODEL);
  });
});

function deepTranscript(): SessionMessage[] {
  const messages: SessionMessage[] = [
    message('user', 'Refactor the auth module and fix the root cause of the migration bug.', {
      handle: 'h-0',
    }),
  ];
  const files = ['src/auth.ts', 'src/session.ts', 'src/db.ts', 'src/migrate.ts'];
  files.forEach((file, i) => {
    const id = `edit-${i}`;
    messages.push(call(id, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, 'ok'));
    messages.push(result(id, i % 2 === 0 ? 'error: type mismatch' : 'ok', i % 2 === 0));
  });
  messages.push(message('assistant', 'Working through it.', { handle: 'h-last' }));
  return messages;
}

describe('depth classification', () => {
  it('classifies a short read-and-fix session as quick', () => {
    const config = resolveHookConfig({});
    const depth = classifySessionDepth(transcript(), config);
    expect(depth.depth).toBe('quick');
    expect(depth.score).toBeLessThan(config.depthThreshold);
    expect(depthLogLine(depth)).toMatch(/^depth: quick \(score/);
  });

  it('classifies a multi-file, error-heavy refactor as deep', () => {
    const config = resolveHookConfig({});
    const depth = classifySessionDepth(deepTranscript(), config);
    expect(depth.depth).toBe('deep');
    expect(depth.score).toBeGreaterThanOrEqual(config.depthThreshold);
    expect(depth.reasons.join(' ')).toMatch(/files touched/);
    expect(depth.reasons.join(' ')).toMatch(/edit\/write calls/);
    expect(depth.reasons.join(' ')).toMatch(/deep-work keyword/);
  });

  it('respects a lower or higher depthThreshold', () => {
    const messages = deepTranscript();
    expect(classifySessionDepth(messages, resolveHookConfig({ depthThreshold: 0.99 })).depth).toBe(
      'quick',
    );
    expect(classifySessionDepth(messages, resolveHookConfig({ depthThreshold: 0.05 })).depth).toBe(
      'deep',
    );
  });
});

function fakeEngine(fetchFn: (url: string, init?: { body?: string }) => Promise<{ status: number; ok: boolean; text: string }>) {
  const logs: string[] = [];
  const toasts: string[] = [];
  return {
    logs,
    toasts,
    $: {
      env: { get: async (name: string) => (name === 'OPENROUTER_API_KEY' ? 'sk-or-v1-test' : undefined) },
      settings: { read: async () => ({}) },
      http: { fetch: async (url: string, init?: { body?: string }) => {
        const r = await fetchFn(url, init);
        return { status: r.status, ok: r.ok, text: r.text };
      } },
      ui: {
        log: (text: string) => logs.push(text),
        toast: (text: string) => toasts.push(text),
      },
    },
  };
}

describe('register session.compact routing', () => {
  it('skips Jev and calls next() for a deep session', async () => {
    let handler: ((...args: unknown[]) => unknown) | undefined;
    register(
      (event, hook) => {
        if (event === 'session.compact') handler = hook as typeof handler & object;
      },
      {},
    );
    const engine = fakeEngine(jevFetch(() => 1));
    let nextCalled = false;
    const next = (event: unknown) => {
      nextCalled = true;
      return event;
    };
    const outcome = await (handler as (
      $: unknown,
      event: { messages: SessionMessage[] },
      next: typeof next,
    ) => Promise<unknown>)(engine.$, { messages: deepTranscript() }, next);
    expect(nextCalled).toBe(true);
    expect(outcome).toEqual({ messages: deepTranscript() });
    expect(engine.logs.some((line) => line.startsWith('depth: deep'))).toBe(true);
    expect(engine.toasts.some((line) => line.includes('routed to built-in summary'))).toBe(true);
  });

  it('runs Jev as usual for a quick session', async () => {
    let handler: ((...args: unknown[]) => unknown) | undefined;
    register(
      (event, hook) => {
        if (event === 'session.compact') handler = hook as typeof handler & object;
      },
      { preserveRecentMessages: 1 },
    );
    const engine = fakeEngine(jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1)));
    const next = () => {
      throw new Error('next() should not be called for a quick session');
    };
    const outcome = (await (handler as (
      $: unknown,
      event: { messages: SessionMessage[] },
      next: typeof next,
    ) => Promise<{ messages: SessionMessage[] }>)(engine.$, { messages: transcript() }, next)) as {
      messages: SessionMessage[];
    };
    expect(outcome.messages.length).toBeGreaterThan(0);
    expect(engine.logs.some((line) => line.startsWith('depth: quick'))).toBe(true);
  });
});

describe('provider routing', () => {
  it('detects OpenRouter keys', () => {
    expect(isOpenRouterKey('sk-or-v1-abc')).toBe(true);
    expect(isOpenRouterKey('ts-live-abc')).toBe(false);
    expect(isOpenRouterKey('')).toBe(false);
    expect(isOpenRouterKey(undefined)).toBe(false);
  });

  it('maps an OpenRouter key to the decisions endpoint and default Jev model', () => {
    expect(providerFor('sk-or-v1-abc', 'jev-latest')).toEqual({
      baseUrl: OPENROUTER_DECISIONS_URL,
      model: OPENROUTER_JEV_MODEL,
    });
  });

  it('keeps an explicit model override for an OpenRouter key', () => {
    expect(providerFor('sk-or-v1-abc', 'typesafe/jev-1.13-20260917')).toEqual({
      baseUrl: OPENROUTER_DECISIONS_URL,
      model: 'typesafe/jev-1.13-20260917',
    });
  });

  it('leaves a TypeSafe key on the default System One endpoint', () => {
    expect(providerFor('ts-live-abc', 'jev-latest')).toEqual({ baseUrl: undefined, model: 'jev-latest' });
  });
});
