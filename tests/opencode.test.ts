import { describe, expect, it } from 'vitest';
import type { Message as AiMessage } from '@opencode/ai/effect';
import {
  applyDecisionsToMessages,
  createAsker,
  createCompactionHook,
  providerAsker,
  providerQuestions,
  resolvePluginConfig,
  toJevMessages,
  type CompactionEvent,
  type TrialEntry,
} from '../src/opencode/index.js';
import {
  parseJevResponse,
  resolveTransport,
  transportLimits,
  withTransportLimits,
  type JevAsker,
  type JevQuestions,
} from '../src/index.js';

function user(text: string): AiMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as AiMessage;
}

function assistant(...content: unknown[]): AiMessage {
  return { role: 'assistant', content } as unknown as AiMessage;
}

function tool(...content: unknown[]): AiMessage {
  return { role: 'tool', content } as unknown as AiMessage;
}

function callPart(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool-call', id, name, input };
}

function resultPart(id: string, name: string, value: string, failed = false) {
  return {
    type: 'tool-result',
    id,
    name,
    result: { type: failed ? 'error' : 'text', value },
  };
}

const longResult = `${'x'.repeat(2000)}\nend`;
const longResultB = `${'y'.repeat(2000)}\nend`;

/** Two calls outside the pinned first message, so both are candidates. */
function transcript(): AiMessage[] {
  return [
    user('Fix the failing test. Never edit src/generated.'),
    assistant({ type: 'reasoning', text: 'thinking' }, callPart('c1', 'read', { file_path: 'a.ts' })),
    tool(resultPart('c1', 'read', longResult)),
    assistant({ type: 'text', text: 'now b.ts' }, callPart('c2', 'read', { file_path: 'b.ts' })),
    tool(resultPart('c2', 'read', longResultB)),
  ];
}

function tryAsker(answer: (name: string) => number | undefined): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      const entries = Object.keys(questions).map((name) => [name, answer(name)]);
      return {
        answers: Object.fromEntries(
          entries.map(([name, value]) => [
            name as string,
            { type: 'noul' as const, noul: value ?? 0.9 },
          ]),
        ),
      };
    },
  };
}

describe('OpenCode message adapter', () => {
  it('maps roles, text, calls and results at the same indices', () => {
    const view = toJevMessages(transcript());
    expect(view).toHaveLength(5);
    expect(view[1]).toMatchObject({ role: 'assistant', text: '' });
    expect(view[1]?.toolUses).toEqual([
      { tool_use_id: 'c1', tool: 'read', input: { file_path: 'a.ts' } },
    ]);
    expect(view[2]?.toolResults).toEqual([{ tool_use_id: 'c1', text: longResult }]);
    expect(view[3]).toMatchObject({ role: 'assistant', text: 'now b.ts' });
    expect(view[4]?.toolResults).toEqual([{ tool_use_id: 'c2', text: longResultB }]);
  });

  it('drops a call together with its result and truncates a dropped result', () => {
    const messages = transcript();
    const kept = applyDecisionsToMessages(
      messages,
      new Map([
        ['c1', 'drop_call' as const],
        ['c2', 'drop_result' as const],
      ]),
      100,
    );
    // The text and reasoning of the assistant messages stay; only tool parts go.
    expect(kept).toHaveLength(4);
    expect(kept[0]).toBe(messages[0]);
    const first = kept[1] as unknown as { content: { type: string }[] };
    expect(first.content.map((part) => part.type)).toEqual(['reasoning']);
    const last = kept[3] as unknown as { content: { type: string; result?: { value: string } }[] };
    expect(last.content[0]?.type).toBe('tool-result');
    expect(last.content[0]?.result?.value).toContain('fast-jev-compaction truncated');
  });

  it('keeps untouched messages by identity', () => {
    const messages = transcript();
    const kept = applyDecisionsToMessages(messages, new Map([['c2', 'drop_result']]), 10);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[1]).toBe(messages[1]);
    expect(kept[2]).toBe(messages[2]);
    expect(kept[3]).toBe(messages[3]);
    expect(kept[4]).not.toBe(messages[4]);
  });
});

describe('decision transports', () => {
  it('translates noul and choice questions to the provider shape', () => {
    const questions = providerQuestions({
      call_t1: { type: 'noul', instructions: 'keep the call' },
      pick: { type: 'choice', instructions: 'which', criteria: { a: 'first', b: null } },
    });
    expect(questions).toEqual([
      { type: 'predicate', name: 'call_t1', instructions: 'keep the call' },
      {
        type: 'choice',
        name: 'pick',
        instructions: 'which',
        choices: [{ value: 'a', description: 'first' }, { value: 'b' }],
      },
    ]);
  });

  it('reads the provider answer array as the native map', async () => {
    const asker = providerAsker({ kind: 'provider', providerID: 'opencode', modelID: 'jev-1.13-free' }, async () => ({
      answers: [
        { type: 'predicate', name: 'a', probability: 0.91 },
        { type: 'predicate', name: 'b', probability: 0.2 },
      ],
      cost: 0,
    }));
    const response = await asker.ask('state', {
      a: { type: 'noul', instructions: 'a' },
      b: { type: 'noul', instructions: 'b' },
    });
    expect(response.answers).toEqual({
      a: { type: 'noul', noul: 0.91 },
      b: { type: 'noul', noul: 0.2 },
    });
  });

  it('fails closed on an error answer', async () => {
    const asker = providerAsker({ kind: 'provider', providerID: 'opencode', modelID: 'jev-1.13-free' }, async () => ({
      answers: [{ type: 'error', name: 'a', reason: 'unsupported' }],
    }));
    await expect(
      asker.ask('state', { a: { type: 'noul', instructions: 'a' } }),
    ).rejects.toThrow(/unsupported/);
  });

  it('refuses a provider transport without a route', async () => {
    const asker = createAsker({
      kind: 'provider',
      providerID: 'opencode',
      modelID: 'jev-1.13-free',
    });
    await expect(
      asker.ask('state', { a: { type: 'noul', instructions: 'a' } }),
    ).rejects.toThrow(/decision route/);
  });

  it('needs no key for a local server but refuses a remote one', async () => {
    let sent: Record<string, string> = {};
    const local = createAsker(
      { kind: 'http', baseUrl: 'http://127.0.0.1:8000/v1/systemone', model: 'local-model' },
      {
        fetch: (async (_url: string, init?: { headers?: Record<string, string> }) => {
          sent = init?.headers ?? {};
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.5 } } }),
          };
        }) as never,
      },
    );
    const answer = await local.ask('state', { a: { type: 'noul', instructions: 'a' } });
    expect(answer.answers.a).toEqual({ type: 'noul', noul: 0.5 });
    expect(sent.authorization).toBeUndefined();
    const remote = createAsker({ kind: 'http', baseUrl: 'https://example.com/v1/systemone', model: 'x' });
    await expect(
      remote.ask('state', { a: { type: 'noul', instructions: 'a' } }),
    ).rejects.toThrow(/API key/);
  });

  it('normalizes array answers in a response body', () => {
    const response = parseJevResponse(200, true, JSON.stringify({
      answers: [{ type: 'predicate', name: 'x', probability: 0.7 }],
    }));
    expect(response.answers.x).toEqual({ type: 'noul', noul: 0.7 });
  });
});

describe('plugin configuration', () => {
  it('defaults to the free Console provider', () => {
    const config = resolvePluginConfig({}, {});
    expect(config.enabled).toBe(true);
    expect(config.transport).toEqual({
      kind: 'provider',
      providerID: 'opencode',
      modelID: 'jev-1.13-free',
    });
    expect(config.minReductionRatio).toBe(0.25);
  });

  it('turns baseUrl into an HTTP transport with a model', () => {
    const config = resolvePluginConfig({ baseUrl: 'http://127.0.0.1:8000/v1/systemone', model: 'local-model' }, {});
    expect(config.transport).toMatchObject({
      kind: 'http',
      baseUrl: 'http://127.0.0.1:8000/v1/systemone',
      model: 'local-model',
    });
  });

  it('takes the preset from the environment and applies its limits', () => {
    const config = resolvePluginConfig({}, { FAST_JEV_TRANSPORT: 'openjev', FAST_JEV_CONTEXT_WINDOW: '4096' });
    expect(config.transport).toMatchObject({ kind: 'http', model: 'openjev-1.7b' });
    expect(config.maxRequestTokens).toBeLessThan(4_096);
    expect(config.maxCallsPerBatch).toBe(0);
    expect(config.maxConcurrentRequests).toBe(0);
  });

  it('honours explicit limits over the preset', () => {
    const config = resolvePluginConfig({ transport: 'openjev', maxStateTokens: 900 }, {});
    expect(config.maxStateTokens).toBe(900);
  });

  it('resolves presets and environment overrides', () => {
    expect(resolveTransport('opencode-paid', {})).toMatchObject({ modelID: 'jev-1.13' });
    expect(resolveTransport('typesafe', { FAST_JEV_BASE_URL: 'http://localhost:1/v1/systemone' }))
      .toMatchObject({ baseUrl: 'http://localhost:1/v1/systemone' });
    expect(transportLimits({ kind: 'http', baseUrl: 'http://x', model: 'm' }))
      .toEqual({ maxStateTokens: 25_000, maxRequestTokens: 30_000 });
    expect(withTransportLimits({ maxStateTokens: 5 }, {
      kind: 'http', baseUrl: 'http://x', model: 'm', contextWindow: 1000,
    })).toEqual({ maxStateTokens: 5, maxRequestTokens: 950 });
  });
});

describe('compaction hook', () => {
  function hook(asker: JevAsker, config = resolvePluginConfig({ preserveRecentMessages: 0 }, {})) {
    const entries: TrialEntry[] = [];
    return {
      entries,
      run: createCompactionHook({
        config,
        asker: () => asker,
        record: async (entry) => {
          entries.push(entry);
        },
        now: () => 1,
      }),
    };
  }

  it('replaces the summary with the pruned native window', async () => {
    const { run, entries } = hook(tryAsker(() => 0.1));
    const event: CompactionEvent = { sessionID: 'ses_1', messages: transcript() };
    await run(event);
    expect(event.result?.summary).toContain('fast-jev-compaction');
    expect(event.result?.summary).toContain('2 calls dropped');
    const native = event.result?.native as { messages: AiMessage[] };
    // Only the user turn and the two assistant texts remain: tool parts are gone.
    expect(native.messages).toHaveLength(3);
    expect(JSON.stringify(native.messages)).not.toContain('tool-call');
    expect(entries[0]).toMatchObject({ ok: true, session: 'ses_1', transport: 'provider' });
    expect(entries[0]?.stats?.callsDropped).toBe(2);
  });

  it('keeps the built-in summary when nothing is dropped', async () => {
    const { run, entries } = hook(tryAsker(() => 0.99));
    const event: CompactionEvent = { sessionID: 'ses_2', messages: transcript() };
    await run(event);
    expect(event.result).toBeUndefined();
    expect(entries[0]).toMatchObject({ ok: false, reason: 'low_reduction' });
  });

  it('falls back on an asker error', async () => {
    const failing: JevAsker = {
      async ask() {
        throw new Error('HTTP 451: region');
      },
    };
    const { run, entries } = hook(failing);
    const event: CompactionEvent = { sessionID: 'ses_3', messages: transcript() };
    await run(event);
    expect(event.result).toBeUndefined();
    expect(entries[0]).toMatchObject({ ok: false, reason: 'error', error: expect.stringContaining('451') });
  });

  it('leaves a result another plugin already wrote', async () => {
    const { run, entries } = hook(tryAsker(() => 0.1));
    const event: CompactionEvent = {
      sessionID: 'ses_4',
      messages: transcript(),
      result: { summary: 'existing' },
    };
    await run(event);
    expect(event.result.summary).toBe('existing');
    expect(entries[0]).toMatchObject({ reason: 'already_compacted' });
  });

  it('does nothing when every call is pinned', async () => {
    const { run, entries } = hook(tryAsker(() => 0.1), resolvePluginConfig({ preserveRecentMessages: 10 }, {}));
    const event: CompactionEvent = { sessionID: 'ses_5', messages: transcript() };
    await run(event);
    expect(event.result).toBeUndefined();
    expect(entries[0]).toMatchObject({ reason: 'nothing_to_drop' });
  });
});
