import { describe, expect, it } from 'vitest';
import {
  compactSession,
  createAsker,
  decisionLog,
  decisionLogLines,
  jevAsker,
  resolveHookConfig,
  resolveTarget,
  summarize,
  toSessionMessages,
  type HookFetch,
  type HookFetchInit,
} from '../hooks/fast-jev.ts';
import { gatewayAsker, toGatewayQuestion, toNoulAnswer } from '../hooks/gateway-asker.ts';
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

type Recorded = { url: string; init?: HookFetchInit };

/** A Gateway fetch that answers every question with the same `boolean` probability. */
function gatewayFetch(answer: (name: string) => number, requests: Recorded[] = []): HookFetch {
  return async (url, init) => {
    requests.push({ url, init });
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'boolean', probability: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

/** A Gateway fetch that replays one fixed response body. */
function stubFetch(text: string, status = 200, requests: Recorded[] = []): HookFetch {
  return async (url, init) => {
    requests.push({ url, init });
    return { status, ok: status >= 200 && status < 300, text };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      provider: 'auto',
    });
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
      provider: 'auto',
    });
  });

  it('accepts either spelling of a provider and ignores an unknown one', () => {
    expect(resolveHookConfig({ provider: 'gateway' }).provider).toBe('gateway');
    expect(resolveHookConfig({ provider: 'Vercel' }).provider).toBe('gateway');
    expect(resolveHookConfig({ provider: 'systemone' }).provider).toBe('systemone');
    expect(resolveHookConfig({ provider: 'typesafe' }).provider).toBe('systemone');
    expect(resolveHookConfig({ provider: 'system-one' }).provider).toBe('systemone');
    expect(resolveHookConfig({ provider: 'nonsense' }).provider).toBe('auto');
    expect(resolveHookConfig({ baseUrl: 'https://jev.internal/v1' }).baseUrl).toBe(
      'https://jev.internal/v1',
    );
  });
});

describe('provider selection', () => {
  const auto = resolveHookConfig({});

  it('takes a configured provider over everything else', () => {
    expect(resolveTarget(resolveHookConfig({ provider: 'systemone' }), 'gateway-env')).toEqual({
      provider: 'systemone',
      model: 'jev-latest',
      url: 'https://api.typesafe.ai/v1/systemone',
    });
    expect(resolveTarget(resolveHookConfig({ provider: 'gateway' }), 'typesafe-env')).toEqual({
      provider: 'gateway',
      model: 'typesafe-ai/jev',
      url: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
    });
  });

  it('follows the key name when the provider is auto', () => {
    expect(resolveTarget(auto, 'gateway-env').provider).toBe('gateway');
    expect(resolveTarget(auto, 'typesafe-env').provider).toBe('systemone');
    // A TYPESAFE_API_KEY install from before the Gateway move keeps its model.
    expect(resolveTarget(auto, 'typesafe-env').model).toBe('jev-latest');
  });

  it('falls back to the model shape, then to the Gateway, for a key with no name', () => {
    expect(resolveTarget(resolveHookConfig({ model: 'typesafe-ai/jev' }), 'option').provider).toBe(
      'gateway',
    );
    expect(resolveTarget(resolveHookConfig({ model: 'jev-latest' }), 'option').provider).toBe(
      'systemone',
    );
    expect(resolveTarget(auto, 'option').provider).toBe('gateway');
    expect(resolveTarget(auto, 'none').provider).toBe('gateway');
  });

  it('keeps a configured model and endpoint for either provider', () => {
    expect(
      resolveTarget(resolveHookConfig({ provider: 'gateway', model: 'typesafe-ai/jev-mini' }), 'none'),
    ).toMatchObject({ model: 'typesafe-ai/jev-mini' });
    expect(
      resolveTarget(
        resolveHookConfig({ provider: 'systemone', baseUrl: 'https://jev.internal/v1' }),
        'none',
      ),
    ).toEqual({
      provider: 'systemone',
      model: 'jev-latest',
      url: 'https://jev.internal/v1',
    });
  });

  it('builds the matching asker for each provider', async () => {
    const requests: Recorded[] = [];
    const fetchFn = stubFetch(JSON.stringify({ answers: {} }), 200, requests);
    const questions = { call_t1: { type: 'noul', instructions: 'keep?' } } as const;

    await createAsker(fetchFn, 'k', resolveTarget(auto, 'gateway-env')).ask('s', questions);
    await createAsker(fetchFn, 'k', resolveTarget(auto, 'typesafe-env')).ask('s', questions);

    expect(requests.map((r) => r.url)).toEqual([
      'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
      'https://api.typesafe.ai/v1/systemone',
    ]);
    // The Gateway takes the model in a header and calls the primitive `boolean`;
    // System One takes the model in the body and calls it `noul`.
    expect(requests[0]!.init?.headers?.['ai-model-id']).toBe('typesafe-ai/jev');
    expect(JSON.parse(requests[0]!.init!.body!)).toEqual({
      state: 's',
      questions: { call_t1: { type: 'boolean', instructions: 'keep?' } },
    });
    expect(requests[1]!.init?.headers?.['ai-model-id']).toBeUndefined();
    expect(JSON.parse(requests[1]!.init!.body!)).toEqual({
      model: 'jev-latest',
      state: 's',
      questions,
    });
  });

  it('refuses to send a request without a key, whichever provider it is', () => {
    const refuse: HookFetch = async () => {
      throw new Error('no request may go out without a key');
    };
    expect(() => createAsker(refuse, '', resolveTarget(auto, 'none'))).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() =>
      createAsker(refuse, '', resolveTarget(resolveHookConfig({ provider: 'systemone' }), 'none')),
    ).toThrow(/TYPESAFE_API_KEY/);
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
      jevAsker(
        jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
        config.apiKey,
        config.model,
      ),
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
    const { result: output } = await compactSession(
      transcript(),
      config,
      jevAsker(jevFetch(() => 0.1), config.apiKey),
    );
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
    const refuse: HookFetch = async () => {
      throw new Error('no request may go out without a key');
    };
    expect(() => gatewayAsker(refuse, '')).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() => jevAsker(refuse, '')).toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(
        transcript(),
        { ...config, apiKey: 'k' },
        jevAsker(async () => ({ status: 500, ok: false, text: 'x' }), 'k'),
      ),
    ).rejects.toThrow(/500/);
  });
});

describe('gateway translation', () => {
  it('renames noul questions to boolean and leaves choice and score alone', () => {
    expect(
      toGatewayQuestion({ type: 'noul', instructions: 'keep?', criteria: { true: 'y', false: 'n' } }),
    ).toEqual({ type: 'boolean', instructions: 'keep?', criteria: { true: 'y', false: 'n' } });

    const choice = { type: 'choice', instructions: 'which?', criteria: { a: 'A', b: 'B' } } as const;
    expect(toGatewayQuestion(choice)).toEqual(choice);

    const score = { type: 'score', instructions: 'how much?', criteria: ['low', 'high'] } as const;
    expect(toGatewayQuestion(score)).toEqual(score);
  });

  it('reads the boolean probability back as noul', () => {
    expect(toNoulAnswer({ type: 'boolean', probability: 0.82 })).toEqual({ type: 'noul', noul: 0.82 });
    expect(toNoulAnswer({ type: 'boolean', probability: 0 })).toEqual({ type: 'noul', noul: 0 });

    const choice = { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } } as const;
    expect(toNoulAnswer(choice)).toEqual(choice);
  });
});

describe('gateway asker over $.http.fetch', () => {
  const state = { context: 'c', goal: 'g', history: [] };
  const questions = {
    call_t1: { type: 'noul', instructions: 'keep the call?' },
    pick: { type: 'choice', instructions: 'which?', criteria: { a: 'A', b: 'B' } },
  } as const;

  it('posts the evaluation-model contract and reads boolean answers back as noul', async () => {
    const requests: Recorded[] = [];
    const answers = {
      call_t1: { type: 'boolean', probability: 0.82 },
      pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } },
    };
    const asker = gatewayAsker(stubFetch(JSON.stringify({ answers }), 200, requests), 'key-123');

    const response = await asker.ask(state, questions);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    expect(requests[0]!.init?.method).toBe('POST');
    expect(requests[0]!.init?.headers).toEqual({
      authorization: 'Bearer key-123',
      'content-type': 'application/json',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-gateway-auth-method': 'api-key',
      'ai-evaluation-model-specification-version': '4',
      'ai-model-id': 'typesafe-ai/jev',
    });
    // The model rides in the header, and every `noul` question goes out as `boolean`.
    expect(JSON.parse(requests[0]!.init!.body!)).toEqual({
      state,
      questions: {
        call_t1: { type: 'boolean', instructions: 'keep the call?' },
        pick: { type: 'choice', instructions: 'which?', criteria: { a: 'A', b: 'B' } },
      },
    });
    expect(response).toEqual({
      model: 'typesafe-ai/jev',
      answers: {
        call_t1: { type: 'noul', noul: 0.82 },
        pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } },
      },
    });
  });

  it('sends a configured model as the ai-model-id header', async () => {
    const requests: Recorded[] = [];
    const asker = gatewayAsker(
      stubFetch(JSON.stringify({ answers: {} }), 200, requests),
      'k',
      'typesafe-ai/jev-mini',
    );
    const response = await asker.ask(state, {});
    expect(requests[0]!.init?.headers?.['ai-model-id']).toBe('typesafe-ai/jev-mini');
    expect(response.model).toBe('typesafe-ai/jev-mini');
  });

  it('throws on a failed request, malformed JSON, and a body without answers', async () => {
    await expect(gatewayAsker(stubFetch('nope', 500), 'k').ask(state, {})).rejects.toThrow(
      /Jev request failed \(500\): nope/,
    );
    await expect(gatewayAsker(stubFetch('<html>', 200), 'k').ask(state, {})).rejects.toThrow(
      /malformed JSON/,
    );
    await expect(gatewayAsker(stubFetch('{"warnings":[]}', 200), 'k').ask(state, {})).rejects.toThrow(
      /missing answers/,
    );
  });

  it('drives a whole compaction over the Gateway HTTP path', async () => {
    const requests: Recorded[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      gatewayAsker(
        gatewayFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), requests),
        config.apiKey,
      ),
    );
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]!.init!.body!) as {
      model?: string;
      questions: Record<string, { type: string }>;
    };
    expect(body.model).toBeUndefined();
    expect(Object.values(body.questions).every((q) => q.type === 'boolean')).toBe(true);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
  });
});
