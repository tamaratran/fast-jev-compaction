import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  dotenvKey,
  getApiKey,
  jevAsker,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { parseEnv } from '../src/dotenv.js';
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

  it('carries the endpoint and the key file through', () => {
    expect(
      resolveHookConfig({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', envFile: '/tmp/.env' }),
    ).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/alpha/decisions',
      envFile: '/tmp/.env',
    });
    expect(resolveHookConfig({ baseUrl: '', envFile: '' })).not.toHaveProperty('baseUrl');
  });
});

/** A `$` stand-in holding only what `getApiKey` reaches for. */
function keyEngine(options: {
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  return {
    env: { get: async (name: string) => options.env?.[name] },
    settings: { read: async () => options.settings ?? {} },
    fs: {
      read: async (path: string) => {
        const text = options.files?.[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
    },
  };
}

describe('api key resolution', () => {
  it('prefers the option, then the environment, then the settings', async () => {
    const config = resolveHookConfig({});
    expect(await getApiKey(keyEngine({ env: { TYPESAFE_API_KEY: 'env' } }), { ...config, apiKey: 'opt' })).toBe('opt');
    expect(await getApiKey(keyEngine({ env: { TYPESAFE_API_KEY: 'env' } }), config)).toBe('env');
    expect(await getApiKey(keyEngine({ env: { OPENROUTER_API_KEY: 'or' } }), config)).toBe('or');
    expect(
      await getApiKey(keyEngine({ settings: { env: { TYPESAFE_API_KEY: 'set' } } }), config),
    ).toBe('set');
    expect(await getApiKey(keyEngine({}), config)).toBeUndefined();
  });

  it('falls back to the dotenv file, and past a file it cannot read', async () => {
    const config = { ...resolveHookConfig({}), envFile: '/tmp/.env' };
    const engine = keyEngine({ files: { '/tmp/.env': 'OPENROUTER_API_KEY=from-file\n' } });
    expect(await getApiKey(engine, config)).toBe('from-file');
    // A missing file is not an error: the key is simply not there.
    expect(await getApiKey(keyEngine({}), config)).toBeUndefined();
    expect(await getApiKey(keyEngine({}), { ...config, envFile: undefined })).toBeUndefined();
  });
});

describe('dotenv reading', () => {
  it('reads assignments, skips comments and blanks, honours quotes', () => {
    const text = [
      '# a comment',
      '',
      'OPENROUTER_API_KEY=sk-or-v1-abc',
      'QUOTED="sk with spaces"',
      "SINGLE='sk-single'",
      'TRAILING=sk-value # not part of it',
      'EMPTY=',
      'BROKEN LINE',
      'OPENROUTER_API_KEY=last-wins',
    ].join('\n');
    expect(parseEnv(text)).toEqual({
      OPENROUTER_API_KEY: 'last-wins',
      QUOTED: 'sk with spaces',
      SINGLE: 'sk-single',
      TRAILING: 'sk-value',
      EMPTY: '',
    });
  });

  it('prefers the TypeSafe name over the OpenRouter one', async () => {
    const engine = keyEngine({
      files: { '.env': 'TYPESAFE_API_KEY=ts\nOPENROUTER_API_KEY=or\n' },
    });
    expect(await dotenvKey(engine, '.env')).toBe('ts');
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

  it('sends the request to the configured endpoint', async () => {
    const urls: string[] = [];
    const openrouter = 'https://openrouter.ai/api/alpha/decisions';
    await jevAsker(async (url) => {
      urls.push(url);
      return { status: 200, ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 0.9 } } }) };
    }, 'k', 'jev-x', openrouter).ask('state', { call_t1: { type: 'noul', instructions: 'keep?' } });
    expect(urls).toEqual([openrouter]);

    // The whole chain, so the config option really reaches the request.
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', baseUrl: openrouter };
    await compactSession(transcript(), config, async (url, init) => {
      urls.push(url);
      return jevFetch(() => 0.9)(url, init);
    });
    expect(urls).toEqual([openrouter, openrouter]);
  });

  it('reaches the TypeSafe endpoint when no baseUrl is set', async () => {
    const urls: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    await compactSession(transcript(), config, async (url, init) => {
      urls.push(url);
      return jevFetch(() => 0.1)(url, init);
    });
    expect(urls).toEqual(['https://api.typesafe.ai/v1/systemone']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});
