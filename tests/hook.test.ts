import { describe, expect, it, vi } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
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

type HookHandler = (host: any, event: any, next: (event: any) => unknown) => Promise<unknown>;

function registeredHooks(options: Record<string, unknown> = {}): Map<string, HookHandler> {
  const handlers = new Map<string, HookHandler>();
  const on = ((name: string, ...args: unknown[]) => {
    handlers.set(name, args.at(-1) as HookHandler);
    return {};
  }) as never;
  register(on, options as never);
  return handlers;
}

function turnComplete(overrides: Record<string, unknown> = {}) {
  return {
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
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
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('registered compaction hooks', () => {
  it('does not send speculative precompute transcripts to Jev', async () => {
    const hooks = registeredHooks();
    const handler = hooks.get('session.compact')!;
    const next = vi.fn(async (event) => event);
    const host = {
      env: { get: vi.fn() },
      settings: { read: vi.fn() },
      http: { fetch: vi.fn() },
      ui: { log: vi.fn(), toast: vi.fn() },
    };
    const event = { trigger: 'precompute', messages: [] };

    const result = await handler(host, event, next);

    expect(result).toMatchObject({ skip: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
    expect(host.http.fetch).not.toHaveBeenCalled();
  });

  it('passes subagent and fork compactions through without calling Jev', async () => {
    const hooks = registeredHooks();
    const handler = hooks.get('session.compact')!;
    const next = vi.fn(async (event) => ({ messages: event.messages }));
    const host = {
      env: { get: vi.fn() },
      settings: { read: vi.fn() },
      http: { fetch: vi.fn() },
      ui: { log: vi.fn(), toast: vi.fn() },
    };
    const events = [
      { trigger: 'manual', agentId: 'agent-1', messages: [] },
      { trigger: 'precompute', agentId: 'fork-1', messages: [] },
    ];

    for (const event of events) await handler(host, event, next);

    expect(next).toHaveBeenNthCalledWith(1, events[0]);
    expect(next).toHaveBeenNthCalledWith(2, events[1]);
    expect(host.http.fetch).not.toHaveBeenCalled();
  });

  it('only auto-compacts completed main-agent answers', async () => {
    const hooks = registeredHooks({ compactAtPercent: 1 });
    const handler = hooks.get('turn.complete')!;
    const usage = vi.fn(async () => ({ context: { percent: 100 } }));
    const compact = vi.fn(async () => ({}));
    const next = vi.fn(async (event) => event);
    const host = { session: { usage, compact }, ui: { log: vi.fn() } };

    for (const event of [
      turnComplete({ reason: 'aborted', isAborted: true }),
      turnComplete({ reason: 'refusal' }),
      turnComplete({ reason: 'error' }),
      turnComplete({ agentId: 'agent-1' }),
    ]) {
      await handler(host, event, next);
    }

    expect(usage).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('auto-compacts a main-session answer when usage reaches the configured threshold', async () => {
    const hooks = registeredHooks({ compactAtPercent: 60 });
    const handler = hooks.get('turn.complete')!;
    const event = turnComplete();
    const usage = vi.fn(async () => ({ context: { percent: 75 } }));
    const compact = vi.fn(async () => ({}));
    const next = vi.fn(async (received) => received);
    const host = { session: { usage, compact }, ui: { log: vi.fn() } };

    const result = await handler(host, event, next);

    expect(usage).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(event);
    expect(result).toBe(event);
  });

  it('claims the auto-compaction guard before awaiting usage and releases it after completion', async () => {
    const hooks = registeredHooks({ compactAtPercent: 60 });
    const handler = hooks.get('turn.complete')!;
    const firstUsage = deferred<{ context: { percent: number } }>();
    const secondUsage = deferred<{ context: { percent: number } }>();
    const usage = vi.fn().mockReturnValueOnce(firstUsage.promise).mockReturnValueOnce(secondUsage.promise);
    const compact = vi.fn(async () => ({}));
    const next = vi.fn(async (event) => event);
    const host = { session: { usage, compact }, ui: { log: vi.fn() } };

    const first = handler(host, turnComplete(), next);
    const concurrent = handler(host, turnComplete({ turnId: 'turn-2' }), next);
    firstUsage.resolve({ context: { percent: 30 } });
    secondUsage.resolve({ context: { percent: 30 } });
    await Promise.all([first, concurrent]);

    expect(usage).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();

    const afterRelease = handler(host, turnComplete({ turnId: 'turn-3' }), next);
    expect(usage).toHaveBeenCalledTimes(2);
    secondUsage.resolve({ context: { percent: 30 } });
    await afterRelease;
  });
});
