import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  type HookFetch,
} from '../hooks/fast-laya.ts';
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

type Sent = {
  url: string;
  body: { model: string; state: { call: { tool: string } }; questions: Record<string, unknown> };
};

function layaFetch(keep: (tool: string) => number, sent: Sent[] = []): HookFetch {
  return async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as Sent['body'];
    sent.push({ url, body });
    const p = keep(body.state.call.tool);
    const probabilities = { keep: p, truncate: 0, drop: 1 - p };
    const answers = { fate: { type: 'choice', choice: p >= 0.5 ? 'keep' : 'drop', confidence: 1, probabilities } };
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      model: 'laya',
      baseUrl: 'http://127.0.0.1:8000/v1/systemone',
    });
    expect(
      resolveHookConfig({
        keepThreshold: 0.3,
        maxStateTokens: 900,
        concurrency: 2,
        model: 'laya-multilingual',
        baseUrl: 'http://gpu-box:8000/v1/systemone',
        goal: 'g',
        compactAtPercent: 'no',
        apiKey: 'ignored',
      }),
    ).toEqual({
      keepThreshold: 0.3,
      maxStateTokens: 900,
      concurrency: 2,
      model: 'laya-multilingual',
      baseUrl: 'http://gpu-box:8000/v1/systemone',
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
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-plugin truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-plugin truncated 1700 chars`),
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
  it('asks the configured laya-serve once per call and reports the outcome', async () => {
    const sent: Sent[] = [];
    const config = {
      ...resolveHookConfig({ preserveRecentMessages: 1 }),
      model: 'laya-multilingual',
      baseUrl: 'http://gpu-box:8000/v1/systemone',
    };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      layaFetch((tool) => (tool === 'Bash' ? 0.9 : 0.1), sent),
    );
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.url === 'http://gpu-box:8000/v1/systemone')).toBe(true);
    expect(sent.every((s) => s.body.model === 'laya-multilingual')).toBe(true);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(
      /^\d+% reduction; 1 kept, 1 call_dropped; 2 request\(s\), largest state ~\d+ tokens$/,
    );
    expect(summarize({ ...output, stats: { ...output.stats, truncatedRequests: 1 } })).toMatch(
      /, 1 cut by Laya$/,
    );
    expect(decisionLog(output)).toBe(
      't1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90',
    );
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    const { result: output } = await compactSession(transcript(), config, layaFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on failed or unreachable requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(
      compactSession(transcript(), config, async () => ({ status: 503, ok: false, text: 'busy' })),
    ).rejects.toThrow(/503/);
    await expect(
      compactSession(transcript(), config, async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

type Handler = (...args: unknown[]) => Promise<unknown>;

function compactHook(options: Record<string, unknown>, fetchFn: HookFetch) {
  const handlers = new Map<string, Handler>();
  register(((name: string, handler: Handler) => handlers.set(name, handler)) as never, options as never);
  const logs: string[] = [];
  const $ = {
    http: { fetch: fetchFn },
    ui: { log: (text: string) => logs.push(text), toast: () => {} },
  };
  return async () => {
    let fellBack = false;
    const out = await handlers.get('session.compact')!($, { messages: transcript() }, async () => {
      fellBack = true;
      return { native: true };
    });
    return { out, fellBack, logs };
  };
}

describe('session.compact hook', () => {
  it('replaces the history when Laya trims enough', async () => {
    const run = compactHook({ preserveRecentMessages: 1 }, layaFetch(() => 0.1));
    const { out, fellBack, logs } = await run();
    expect(fellBack).toBe(false);
    expect((out as { messages: unknown[] }).messages).toHaveLength(3);
    expect(logs.at(-1)).toMatch(/^kept 3\/7 messages, no summary/);
  });

  it('falls back to the native summary when Laya is down', async () => {
    const run = compactHook({ preserveRecentMessages: 1 }, async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
    });
    const { out, fellBack, logs } = await run();
    expect(fellBack).toBe(true);
    expect(out).toEqual({ native: true });
    expect(logs.at(-1)).toBe('fallback to built-in summary (connect ECONNREFUSED 127.0.0.1:8000)');
  });

  it('falls back when the reduction is below minReductionRatio', async () => {
    const run = compactHook({ preserveRecentMessages: 1 }, layaFetch(() => 0.9));
    const { fellBack, logs } = await run();
    expect(fellBack).toBe(true);
    expect(logs.at(-1)).toMatch(/^fallback to built-in summary \(below 25% minimum/);
  });
});
