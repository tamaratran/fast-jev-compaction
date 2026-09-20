import { describe, expect, it } from 'vitest';
import {
  applyActions,
  describeOutcome,
  describeProvider,
  missingKey,
  readPrunerOptions,
  renderTranscript,
  SessionPruner,
  transcriptTokens,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';
import * as v1 from '../src/opencode/v1.ts';
import * as v2 from '../src/opencode/v2.ts';
import server from '../src/opencode/server.ts';

const big = (char: string) => `${char}`.repeat(3000);

function fakeJev(answer: (name: string) => number, seen: string[][] = []): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      seen.push(Object.keys(questions));
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

/** A `fetch` that answers Jev questions, for the end-to-end plugin tests. */
function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return (async (_url: string | URL | Request, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    bodies.push(body);
    const { questions } = JSON.parse(body || '{}') as { questions?: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions ?? {}).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: async () => JSON.stringify({ answers }) };
  }) as unknown as typeof fetch;
}

function libTranscript(): Message[] {
  return [
    { role: 'user', text: 'Fix the failing test.', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'c1', tool: 'read', input: { path: 'a.ts' }, text: big('a') }],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: big('a') }] },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'c2', tool: 'read', input: { path: 'b.ts' }, text: big('b') }],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c2', text: big('b') }] },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'c3', tool: 'bash', input: { command: 'npm test' }, text: 'FAIL' }],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c3', text: 'FAIL', isError: true }] },
    { role: 'user', text: 'go ahead', toolUses: [] },
  ];
}

describe('readPrunerOptions', () => {
  it('fills defaults, reads the key from the environment and ignores malformed values', () => {
    const resolved = readPrunerOptions({ keepThreshold: 'no', contextTokens: NaN }, { TYPESAFE_API_KEY: 'env-key' });
    expect(resolved).toMatchObject({
      apiKey: 'env-key',
      model: 'jev-latest',
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      compactAtPercent: 60,
      contextTokens: 200_000,
      checkpointTokens: 40_000,
      truncateHeadChars: 300,
    });
    expect(readPrunerOptions({}, {}).apiKey).toBeUndefined();
  });

  it('reaches TypeSafe with a key and OpenCode Zen without one', () => {
    expect(readPrunerOptions({}, { TYPESAFE_API_KEY: 'k' })).toMatchObject({ provider: 'typesafe', apiKey: 'k', model: 'jev-latest' });
    expect(readPrunerOptions({}, { TYPESAFE_API_KEY: 'k' }).baseUrl).toBeUndefined();
    const zen = readPrunerOptions({}, {});
    expect(zen).toMatchObject({ provider: 'opencode', model: 'jev-1.13-free', baseUrl: 'https://opencode.ai/zen/v1/systemone', cooldownMs: 60_000 });
    expect(zen.apiKey).toBeUndefined();
    expect(readPrunerOptions({}, { OPENCODE_API_KEY: 'z' })).toMatchObject({ provider: 'opencode', apiKey: 'z' });
    expect(readPrunerOptions({ provider: 'opencode', model: 'jev-1.13' }, { TYPESAFE_API_KEY: 'k', OPENCODE_API_KEY: 'z' })).toMatchObject({ provider: 'opencode', apiKey: 'z', model: 'jev-1.13' });
    expect(readPrunerOptions({ provider: 'typesafe' }, {})).toMatchObject({ provider: 'typesafe', model: 'jev-latest' });
    expect(readPrunerOptions({ provider: 'typesafe' }, {}).apiKey).toBeUndefined();
    expect(describeProvider(zen)).toBe('jev-1.13-free at https://opencode.ai/zen/v1/systemone (no key)');
    // Environment stand-ins for plugin-directory installs, and OpenCode-style model names.
    expect(readPrunerOptions({}, { TYPESAFE_API_KEY: 'k', FAST_JEV_PROVIDER: 'opencode' })).toMatchObject({ provider: 'opencode', model: 'jev-1.13-free' });
    expect(readPrunerOptions({}, { TYPESAFE_API_KEY: 'k', FAST_JEV_PROVIDER: 'opencode' }).apiKey).toBeUndefined();
    expect(readPrunerOptions({}, { TYPESAFE_API_KEY: 'k', FAST_JEV_MODEL: 'opencode/jev-1.13', OPENCODE_API_KEY: 'z' })).toMatchObject({ provider: 'opencode', model: 'jev-1.13', apiKey: 'z' });
    expect(readPrunerOptions({ model: 'opencode/jev-1.13-free' }, { TYPESAFE_API_KEY: 'k' })).toMatchObject({ provider: 'opencode', model: 'jev-1.13-free' });
    expect(readPrunerOptions({ provider: 'typesafe', model: 'opencode/jev-1.13' }, { TYPESAFE_API_KEY: 'k' })).toMatchObject({ provider: 'typesafe', model: 'jev-1.13' });
    expect(readPrunerOptions({ provider: 'typesafe' }, { FAST_JEV_PROVIDER: 'opencode', TYPESAFE_API_KEY: 'k' })).toMatchObject({ provider: 'typesafe', apiKey: 'k' });
    expect(missingKey(readPrunerOptions({ provider: 'typesafe' }, {}))).toBe(true);
    expect(missingKey(zen)).toBe(false);
  });

  it('prefers explicit options', () => {
    expect(
      readPrunerOptions(
        { apiKey: 'k', model: 'jev-x', baseUrl: 'http://jev', goal: 'g', compactAtPercent: 40, checkpointTokens: 10 },
        { TYPESAFE_API_KEY: 'env-key' },
      ),
    ).toMatchObject({ apiKey: 'k', model: 'jev-x', baseUrl: 'http://jev', goal: 'g', compactAtPercent: 40, checkpointTokens: 10 });
  });
});

describe('SessionPruner', () => {
  const options = readPrunerOptions({ apiKey: 'k', contextTokens: 100, preserveRecentMessages: 1 }, {});

  it('does nothing under the threshold', async () => {
    const seen: string[][] = [];
    const pruner = new SessionPruner(fakeJev(() => 0, seen), readPrunerOptions({ apiKey: 'k' }, {}));
    const outcome = await pruner.prune('s', libTranscript());
    expect(outcome.reason).toBe('under_threshold');
    expect(outcome.actions.size).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('asks once above the threshold, remembers the actions and re-asks only for new calls', async () => {
    const seen: string[][] = [];
    let answers = (name: string) => (name === 'call_t1' ? 0.1 : name === 'result_t1' ? 0.1 : name === 'result_t2' ? 0.1 : 0.9);
    const pruner = new SessionPruner(fakeJev((n) => answers(n), seen), options);
    const messages = libTranscript();

    const first = await pruner.prune('s', messages);
    expect(first.reason).toBe('pruned');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(['call_t1', 'result_t1', 'call_t2', 'result_t2', 'call_t3', 'result_t3']);
    expect([...first.actions]).toEqual([
      ['c1', 'drop_call'],
      ['c2', 'drop_result'],
    ]);
    expect(first.tokensAfter).toBeLessThan(first.tokensBefore);
    const applied = applyActions(messages, first.actions, options.truncateHeadChars);
    expect(applied.map((m) => m.toolUses.map((t) => t.tool_use_id))).toEqual([[], ['c2'], [], ['c3'], [], []]);
    expect(applied[1]?.toolUses[0]?.text).toMatch(/^b{300}\n\[fast-jev-compaction truncated 2700 chars/);

    const again = await pruner.prune('s', messages);
    expect(again.reason).toBe('no_new_calls');
    expect(seen).toHaveLength(1);

    // A new call: everything still there is asked again; c2 cannot come back but can be dropped entirely.
    answers = (name) => (name.endsWith('_t1') ? 0.1 : 0.9);
    const grown: Message[] = [
      ...messages.slice(0, -1),
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c4', tool: 'read', input: { path: 'c.ts' }, text: big('c') }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c4', text: big('c') }] },
      { role: 'user', text: 'and now?', toolUses: [] },
    ];
    const third = await pruner.prune('s', grown);
    expect(third.reason).toBe('pruned');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(['call_t1', 'result_t1', 'call_t2', 'result_t2', 'call_t3', 'result_t3']);
    expect([...third.actions]).toEqual([
      ['c1', 'drop_call'],
      ['c2', 'drop_call'],
    ]);
    expect(pruner.actions('s')).toBe(third.actions);
    expect(pruner.actions('other').size).toBe(0);
    expect(describeOutcome(third)).toMatch(/^2 kept, 1 calls dropped; ~\d+ → ~\d+ tokens \(threshold 60\) in 1 request\(s\)$/);
  });

  it('forces a pass and reports transcripts without candidates', async () => {
    const seen: string[][] = [];
    const pruner = new SessionPruner(fakeJev(() => 0.9, seen), options);
    const messages = libTranscript();
    expect((await pruner.prune('s', messages)).reason).toBe('pruned');
    expect((await pruner.prune('s', messages, { force: true })).reason).toBe('pruned');
    expect(seen).toHaveLength(2);
    const noCalls: Message[] = [
      { role: 'user', text: big('q'), toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ];
    expect((await pruner.prune('t', noCalls)).reason).toBe('no_candidates');
    expect(describeOutcome(await pruner.prune('t', noCalls))).toMatch(/^no_candidates; /);
  });

  it('pauses after a failure for the cooldown and resumes afterwards', async () => {
    let clock = 1_000;
    let fail = true;
    const seen: string[][] = [];
    const asker: JevAsker = {
      async ask(state, questions) {
        if (fail) throw new Error('down');
        return fakeJev(() => 0.1, seen).ask(state, questions);
      },
    };
    const pruner = new SessionPruner(asker, readPrunerOptions({ apiKey: 'k', contextTokens: 100, preserveRecentMessages: 1, cooldownMs: 500 }, {}), () => clock);
    await expect(pruner.prune('s', libTranscript())).rejects.toThrow('down');
    expect(pruner.coolingDown()).toBe(true);
    fail = false;
    expect((await pruner.prune('s', libTranscript())).reason).toBe('cooldown');
    expect((await pruner.prune('s', libTranscript(), { force: true })).reason).toBe('pruned');
    clock += 600;
    expect(pruner.coolingDown()).toBe(false);
    expect((await pruner.prune('t', libTranscript())).reason).toBe('pruned');
    expect(seen).toHaveLength(2);
  });

  it('uses the host-reported context window and clears state on forget', async () => {
    const seen: string[][] = [];
    const pruner = new SessionPruner(fakeJev(() => 0.1, seen), options);
    expect((await pruner.prune('s', libTranscript(), { contextTokens: 1_000_000 })).reason).toBe('under_threshold');
    expect((await pruner.prune('s', libTranscript())).reason).toBe('pruned');
    pruner.forget('s');
    expect(pruner.actions('s').size).toBe(0);
  });
});

describe('transcript helpers', () => {
  it('estimates tokens and renders a transcript from tool_use texts', () => {
    const messages = libTranscript();
    expect(transcriptTokens(messages)).toBeGreaterThan(1000);
    const text = renderTranscript(applyActions(messages, new Map([['c1', 'drop_call'], ['c2', 'drop_call']]), 300));
    expect(text).toBe(
      [
        '[User]: Fix the failing test.',
        '[Assistant tool call]: bash({"command":"npm test"})',
        '[Tool result]: FAIL',
        '[User]: go ahead',
      ].join('\n\n'),
    );
  });
});

type Loose = Record<string, unknown>;

function v1Messages(): v1.SessionMessage[] {
  const tool = (callID: string, tool: string, input: Loose, state: Loose): Loose => ({
    id: `p-${callID}`,
    sessionID: 'ses',
    messageID: `m-${callID}`,
    type: 'tool',
    callID,
    tool,
    state,
  });
  return [
    {
      info: { id: 'u1', sessionID: 'ses', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } },
      parts: [
        { id: 't1', sessionID: 'ses', messageID: 'u1', type: 'text', text: 'Fix the failing test.' },
        { id: 't2', sessionID: 'ses', messageID: 'u1', type: 'text', text: 'hidden', ignored: true },
        { id: 'f1', sessionID: 'ses', messageID: 'u1', type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:' },
      ],
    },
    {
      info: { id: 'a1', sessionID: 'ses', role: 'assistant', parentID: 'u1', modelID: 'm', providerID: 'p', mode: 'build', path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2 } },
      parts: [
        { id: 's1', sessionID: 'ses', messageID: 'a1', type: 'step-start' },
        { id: 'x1', sessionID: 'ses', messageID: 'a1', type: 'text', text: 'Reading.' },
        tool('c1', 'read', {}, { status: 'completed', input: { path: 'a.ts' }, output: big('a'), title: 'a.ts', metadata: {}, time: { start: 1, end: 2 } }),
        tool('c2', 'read', {}, { status: 'completed', input: { path: 'b.ts' }, output: big('b'), title: 'b.ts', metadata: {}, time: { start: 1, end: 2, compacted: 3 } }),
        tool('c3', 'bash', {}, { status: 'error', input: { command: 'npm test' }, error: 'FAIL', time: { start: 1, end: 2 } }),
        tool('c4', 'bash', {}, { status: 'running', input: { command: 'sleep' }, time: { start: 1 } }),
        { id: 's2', sessionID: 'ses', messageID: 'a1', type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      ],
    },
    {
      info: { id: 'u2', sessionID: 'ses', role: 'user', time: { created: 3 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } },
      parts: [{ id: 't3', sessionID: 'ses', messageID: 'u2', type: 'text', text: 'go ahead' }],
    },
  ] as unknown as v1.SessionMessage[];
}

describe('OpenCode 1 adapter', () => {
  it('maps session messages to library messages and back to pin counts', () => {
    const transcript = v1.toTranscript(v1Messages());
    expect(transcript.origins).toEqual([0, 1, 1, 2]);
    expect(transcript.messages[0]).toEqual({ role: 'user', text: 'Fix the failing test.\n[Attached image/png: shot.png]', toolUses: [] });
    expect(transcript.messages[1]?.text).toBe('Reading.');
    expect(transcript.messages[1]?.toolUses.map((t) => [t.tool_use_id, t.tool, t.text?.length, t.isError])).toEqual([
      ['c1', 'read', 3000, false],
      ['c2', 'read', v1.CLEARED_OUTPUT.length, false],
      ['c3', 'bash', 4, true],
    ]);
    expect(transcript.messages[2]?.toolResults?.map((r) => r.tool_use_id)).toEqual(['c1', 'c2', 'c3']);
    expect(transcript.messages[2]?.toolResults?.[2]).toMatchObject({ text: 'FAIL', isError: true });
    expect(v1.preserveFor(transcript, 3, 1)).toBe(1);
    expect(v1.preserveFor(transcript, 3, 2)).toBe(3);
  });

  it('removes dropped tool parts and truncates dropped results without touching the rest', () => {
    const messages = v1Messages();
    const out = v1.applyToSession(messages, new Map([['c1', 'drop_call'], ['c2', 'drop_result'], ['c3', 'drop_result']]), 300);
    expect(out[0]).toBe(messages[0]);
    expect(out[2]).toBe(messages[2]);
    expect(out[1]).not.toBe(messages[1]);
    expect(out[1]?.info).toBe(messages[1]?.info);
    const parts = out[1]!.parts as unknown as Loose[];
    expect(parts.map((p) => p.type)).toEqual(['step-start', 'text', 'tool', 'tool', 'tool', 'step-finish']);
    expect(parts.map((p) => p.callID)).toEqual([undefined, undefined, 'c2', 'c3', 'c4', undefined]);
    expect(parts[2]).toBe((messages[1]!.parts as unknown as Loose[])[3]);
    expect(parts[3]).toBe((messages[1]!.parts as unknown as Loose[])[4]);
    const truncated = v1.applyToSession(messages, new Map([['c1', 'drop_result']]), 300)[1]!.parts as unknown as Loose[];
    expect((truncated[2]!.state as Loose).output).toMatch(/^a{300}\n\[fast-jev-compaction truncated 2700 chars/);
    expect(v1.applyToSession(messages, new Map(), 300)[1]).toBe(messages[1]);
  });

  it('runs as a plugin: prunes the transform output in place, logs and toasts', async () => {
    const logs: string[] = [];
    const toasts: string[] = [];
    const input = {
      client: {
        app: { log: async (o: { body: { message: string } }) => void logs.push(o.body.message) },
        tui: { showToast: async (o: { body: { message: string } }) => void toasts.push(o.body.message) },
      },
    } as unknown as Parameters<typeof v1.server>[0];
    const bodies: string[] = [];
    const hooks = await v1.server(input, {
      apiKey: 'k',
      contextTokens: 1_000_000,
      preserveRecentMessages: 1,
      fetch: jevFetch((name) => (name.endsWith('_t1') ? 0.1 : 0.9), bodies),
    });
    await hooks['chat.params']!(
      { sessionID: 'ses', model: { limit: { context: 100 } } } as unknown as Parameters<NonNullable<typeof hooks['chat.params']>>[0],
      {} as never,
    );
    const messages = v1Messages();
    const output = { messages };
    await hooks['experimental.chat.messages.transform']!({}, output);
    expect(output.messages).toBe(messages);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).questions).toHaveProperty('call_t1');
    const parts = messages[1]!.parts as unknown as Loose[];
    expect(parts.map((p) => p.callID ?? p.type)).toEqual(['step-start', 'text', 'c2', 'c3', 'c4', 'step-finish']);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe('Jev compaction enabled: jev-latest at TypeSafe (with key)');
    expect(toasts).toEqual([logs[1]]);
    expect(logs[1]).toMatch(/^2 kept, 1 calls dropped; ~\d+ → ~\d+ tokens \(threshold 60\) in 1 request\(s\)$/);

    // Second request: the remembered action is re-applied without asking again.
    const again = { messages: v1Messages() };
    await hooks['experimental.chat.messages.transform']!({}, again);
    expect(bodies).toHaveLength(1);
    expect((again.messages[1]!.parts as unknown as Loose[]).map((p) => p.callID ?? p.type)).toEqual(['step-start', 'text', 'c2', 'c3', 'c4', 'step-finish']);
    expect(logs).toHaveLength(2);
  });

  it('logs and leaves the history alone when Jev fails, then pauses for the cooldown', async () => {
    const logs: string[] = [];
    const input = {
      client: { app: { log: async (o: { body: { message: string } }) => void logs.push(o.body.message) }, tui: { showToast: async () => undefined } },
    } as unknown as Parameters<typeof v1.server>[0];
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      return { status: 500, ok: false, text: async () => 'boom' };
    }) as unknown as typeof fetch;
    const hooks = await v1.server(input, { apiKey: 'k', contextTokens: 100, preserveRecentMessages: 1, fetch: failing });
    const output = { messages: v1Messages() };
    await hooks['experimental.chat.messages.transform']!({}, output);
    expect(output.messages[1]!.parts).toHaveLength(7);
    expect(logs).toEqual(['Jev compaction enabled: jev-latest at TypeSafe (with key)', 'left the history alone (Jev request failed (500): boom)']);
    await hooks['experimental.chat.messages.transform']!({}, { messages: v1Messages() });
    expect(calls).toBe(1);
    expect(logs).toHaveLength(2);
  });

  it('falls back to OpenCode Zen without a TypeSafe key and disables itself only when TypeSafe is forced', async () => {
    const logs: string[] = [];
    const input = {
      client: { app: { log: async (o: { body: { message: string } }) => void logs.push(o.body.message) }, tui: { showToast: async () => undefined } },
    } as unknown as Parameters<typeof v1.server>[0];
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const hooks = await v1.server(input, {});
      expect(Object.keys(hooks)).toEqual(['chat.params', 'experimental.chat.messages.transform']);
      expect(logs[0]).toBe('Jev compaction enabled: jev-1.13-free at https://opencode.ai/zen/v1/systemone (no key)');
      expect(await v1.server(input, { provider: 'typesafe' })).toEqual({});
      expect(logs[1]).toMatch(/TYPESAFE_API_KEY is not configured/);
    } finally {
      if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
    }
  });
});

class Msg {
  constructor(input: Loose) {
    Object.assign(this, input);
  }
}

class Strict {
  constructor(input: Loose) {
    if (!('signed' in input)) throw new Error('missing field');
    Object.assign(this, input);
  }
}

function v2Messages(): v2.LLMMessage[] {
  const m = (input: Loose) => new Msg(input);
  return [
    m({ role: 'system', content: [{ type: 'text', text: 'Be terse.' }] }),
    m({ role: 'user', content: [{ type: 'text', text: 'Fix the failing test.' }, { type: 'media', mediaType: 'image/png', data: 'x', filename: 'shot.png' }] }),
    m({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool-call', id: 'c1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool-call', id: 'c2', name: 'read', input: 'b.ts' },
      ],
    }),
    m({ role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read', result: { type: 'text', value: big('a') } }] }),
    m({ role: 'tool', content: [{ type: 'tool-result', id: 'c2', name: 'read', result: { type: 'content', value: [{ type: 'text', text: big('b') }, { type: 'media', mime: 'image/png', name: 'b.png' }] } }] }),
    m({ role: 'assistant', content: [{ type: 'tool-call', id: 'c3', name: 'bash', input: { command: 'npm test' } }] }),
    m({ role: 'tool', content: [{ type: 'tool-result', id: 'c3', name: 'bash', result: { type: 'error', value: { message: 'FAIL' } } }] }),
    m({ role: 'user', content: [{ type: 'compaction', provider: 'p', text: 'earlier summary' }, { type: 'text', text: 'go ahead' }] }),
  ] as unknown as v2.LLMMessage[];
}

describe('OpenCode 2 adapter', () => {
  it('maps model messages to library messages', () => {
    const transcript = v2.toTranscript(v2Messages());
    expect(transcript.origins).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(transcript.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', '[System] Be terse.'],
      ['user', 'Fix the failing test.\n[Attached image/png: shot.png]'],
      ['assistant', 'Reading.'],
      ['user', ''],
      ['user', ''],
      ['assistant', ''],
      ['user', ''],
      ['user', '[Conversation checkpoint]\nearlier summary\ngo ahead'],
    ]);
    expect(transcript.messages[2]?.toolUses).toEqual([
      { tool_use_id: 'c1', tool: 'read', input: { path: 'a.ts' }, text: big('a') },
      { tool_use_id: 'c2', tool: 'read', input: { input: 'b.ts' }, text: `${big('b')}\n[Attached image/png: b.png]` },
    ]);
    expect(transcript.messages[5]?.toolUses).toEqual([
      { tool_use_id: 'c3', tool: 'bash', input: { command: 'npm test' }, text: '{"message":"FAIL"}', isError: true },
    ]);
    expect(transcript.messages[6]?.toolResults).toEqual([{ tool_use_id: 'c3', text: '{"message":"FAIL"}', isError: true }]);
    expect(v2.preserveFor(transcript, 8, 2)).toBe(2);
  });

  it('applies actions while keeping message prototypes and untouched objects', () => {
    const messages = v2Messages();
    const out = v2.applyToMessages(messages, new Map([['c1', 'drop_call'], ['c2', 'drop_result'], ['c3', 'drop_result']]), 300);
    expect(out).toHaveLength(7);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).not.toBe(messages[2]);
    expect(out[2]).toBeInstanceOf(Msg);
    expect((out[2] as unknown as Loose).content).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool-call', id: 'c2', name: 'read', input: 'b.ts' },
    ]);
    // c1's result message lost its only part and is gone; c2's result became truncated text.
    const c2 = out[3] as unknown as { content: Array<{ id: string; result: { type: string; value: string } }> };
    expect(c2).toBeInstanceOf(Msg);
    expect(c2.content[0]?.id).toBe('c2');
    expect(c2.content[0]?.result.type).toBe('text');
    expect(c2.content[0]?.result.value).toMatch(/^b{300}\n\[fast-jev-compaction truncated \d+ chars of this tool result; re-run/);
    expect(out[4]).toBe(messages[5]);
    // A short error result is left as it is.
    expect(out[5]).toBe(messages[6]);
    expect(out[6]).toBe(messages[7]);
    expect(v2.applyToMessages(messages, new Map(), 300).every((m, i) => m === messages[i])).toBe(true);
  });

  it('keeps a truncated error result an error', () => {
    const messages = [
      new Msg({ role: 'assistant', content: [{ type: 'tool-call', id: 'e1', name: 'bash', input: {} }] }),
      new Msg({ role: 'tool', content: [{ type: 'tool-result', id: 'e1', name: 'bash', result: { type: 'error', value: { message: big('e') } } }] }),
    ] as unknown as v2.LLMMessage[];
    const out = v2.applyToMessages(messages, new Map([['e1', 'drop_result']]), 100);
    const result = (out[1] as unknown as { content: Array<{ result: { type: string; value: string } }> }).content[0]!.result;
    expect(result.type).toBe('error');
    expect(result.value).toMatch(/^\{"message":"e+\n\[fast-jev-compaction truncated \d+ chars of this tool result \(error\)/);
    expect(result.value.indexOf('\n')).toBe(100);
  });

  it('copies through the prototype when the constructor refuses the fields', () => {
    const strict = new Strict({ role: 'assistant', content: [{ type: 'text', text: 'x' }], signed: true }) as unknown as v2.LLMMessage;
    const copy = v2.withContent(strict, []);
    expect(copy).toBeInstanceOf(Strict);
    expect(copy.content).toEqual([]);
    const plain = { role: 'assistant', content: [{ type: 'text', text: 'x' }] } as unknown as v2.LLMMessage;
    expect(v2.withContent(plain, []).content).toEqual([]);
  });

  async function setupHooks(options: Loose) {
    const hooks: Record<string, (event: unknown) => Promise<void> | void> = {};
    const ctx = {
      options,
      session: {
        hook: async (name: string, callback: (event: unknown) => Promise<void> | void) => {
          hooks[name] = callback;
          return { dispose: async () => undefined };
        },
      },
    } as unknown as Parameters<typeof v2.setup>[0];
    await v2.setup(ctx);
    return hooks;
  }

  it('prunes the context of every request and supplies a verbatim checkpoint on compaction', async () => {
    const bodies: string[] = [];
    const hooks = await setupHooks({
      apiKey: 'k',
      contextTokens: 100,
      preserveRecentMessages: 1,
      fetch: jevFetch((name) => (name.endsWith('_t1') ? 0.1 : name === 'result_t2' ? 0.1 : 0.9), bodies),
    });
    expect(Object.keys(hooks)).toEqual(['context', 'compaction']);

    const messages = v2Messages();
    const event = { sessionID: 'ses', messages } as unknown as v2.ContextEvent;
    await hooks['context']!(event);
    expect(bodies).toHaveLength(1);
    expect(event.messages).not.toBe(messages);
    expect(event.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
    expect((event.messages[2] as unknown as Loose).content).toHaveLength(3);

    // A fresh session, so the pass is not shaped by the actions remembered above.
    const compaction = { sessionID: 'ses2', messages: v2Messages().slice(0, 7) } as unknown as v2.CompactionEvent;
    await hooks['compaction']!(compaction);
    expect(bodies).toHaveLength(2);
    expect(compaction.result?.summary.startsWith(v2.CHECKPOINT_HEADER)).toBe(true);
    expect(compaction.result?.summary).toContain('[User]: Fix the failing test.');
    expect(compaction.result?.summary).toContain('[Assistant tool call]: bash({"command":"npm test"})');
    expect(compaction.result?.summary).not.toContain(big('a'));
    expect(compaction.result?.summary).toContain(`${'b'.repeat(300)}\n[fast-jev-compaction truncated`);
    expect(compaction.result?.metadata).toMatchObject({ 'fast-jev-compaction': { messages: 6, requests: 1 } });

    // Same session as the context pass: remembered drops carry over, the newest head messages stay pinned.
    const same = { sessionID: 'ses', messages: v2Messages().slice(0, 7) } as unknown as v2.CompactionEvent;
    await hooks['compaction']!(same);
    expect(bodies).toHaveLength(3);
    expect(same.result?.summary).toContain('[Assistant tool call]: bash({"command":"npm test"})');
    expect(same.result?.summary).not.toContain(big('a'));
    expect(JSON.parse(bodies[2]!).questions).not.toHaveProperty('call_t3');

    const tooBig = await setupHooks({ apiKey: 'k', checkpointTokens: 10, fetch: jevFetch(() => 0.9) });
    const kept = { sessionID: 'ses', messages: v2Messages() } as unknown as v2.CompactionEvent;
    await tooBig['compaction']!(kept);
    expect(kept.result).toBeUndefined();
  });

  it('registers nothing when TypeSafe is forced without a key and survives a failing Jev', async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(Object.keys(await setupHooks({ provider: 'typesafe' }))).toEqual([]);
      expect(Object.keys(await setupHooks({}))).toEqual(['context', 'compaction']);
    } finally {
      if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
    }
    const failing = (async () => ({ status: 500, ok: false, text: async () => 'boom' })) as unknown as typeof fetch;
    const hooks = await setupHooks({ apiKey: 'k', contextTokens: 100, preserveRecentMessages: 1, fetch: failing });
    const messages = v2Messages();
    const event = { sessionID: 'ses', messages } as unknown as v2.ContextEvent;
    await hooks['context']!(event);
    expect(event.messages).toBe(messages);
    const compaction = { sessionID: 'ses', messages } as unknown as v2.CompactionEvent;
    await hooks['compaction']!(compaction);
    expect(compaction.result).toBeUndefined();
  });
});

describe('server entry', () => {
  it('default-exports one object both OpenCode lines accept', () => {
    expect(server.id).toBe('fast-jev-compaction');
    expect(server.server).toBe(v1.server);
    expect(server.setup).toBe(v2.setup);
  });
});
