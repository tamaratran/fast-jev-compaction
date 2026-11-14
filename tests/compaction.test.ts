import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  buildLayaRequest,
  CALL_QUESTIONS,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  estimateTokens,
  fitCallState,
  LayaClient,
  parseLayaResponse,
  reductionRatio,
  resolveOptions,
  STATE_LEVELS,
  wasTruncated,
  type CallState,
  type LayaAsker,
  type LayaQuestions,
  type Message,
  answerFromFate,
} from '../src/index.js';
import { mapLimit } from '../src/limit.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

type Seen = { state: CallState; questions: string[] };

type Fate = { keep: number; truncate: number; drop: number };

function fate(keep: number, truncate: number): Fate {
  return { keep, truncate, drop: 1 - keep - truncate };
}

function fakeLaya(answer: (state: CallState) => Fate, seen: Seen[] = []): LayaAsker {
  return {
    async ask(state, questions: LayaQuestions) {
      const callState = state as CallState;
      seen.push({ state: callState, questions: Object.keys(questions) });
      const probabilities = answer(callState);
      return {
        answers: {
          fate: { type: 'choice' as const, choice: 'keep', confidence: 1, probabilities },
        },
      };
    },
  };
}

describe('options', () => {
  it('fills in defaults and ignores non-finite values', () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 400,
      truncateHeadChars: 300,
      concurrency: 4,
    });
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
      concurrency: 0,
    })).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
      concurrency: 1,
    });
  });
});

describe('token estimate', () => {
  it('lands near the Laya tokenizer counts', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('compactSession estimateTokens')).toBe(5);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(30);
    expect(estimateTokens(json)).toBeLessThanOrEqual(45);
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
    expect(calls[0]?.resultText).toBe(fileA);
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('per-call state', () => {
  const options = { maxStateTokens: 400, goal: '' };

  it('describes one call with its neighbours, a preview and the later calls', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const { state, level, tokens } = fitCallState(messages, calls, calls[1]!, options);
    expect(tokens).toBeLessThanOrEqual(400);
    expect(state.goal).toContain('Fix the failing test');
    expect(state.goal).toContain('go ahead');
    expect(state.before).toEqual([
      'user: Never edit anything under src/generated. Fix the failing test.',
      'assistant: a.ts looks fine; checking b.ts',
    ]);
    expect(state.call).toMatchObject({
      tool: 'Read',
      input: '{"file_path":"src/b.ts"}',
      outcome: `ok, ${fileB.length} chars`,
    });
    expect(state.call.output_preview.startsWith('export const b = 2;')).toBe(true);
    expect(state.call.output_preview.length).toBeLessThanOrEqual(STATE_LEVELS[level]!.preview);
    expect(state.after).toEqual([
      'assistant: The failure is in b.test.ts; fixing now.',
      'user: go ahead',
    ]);
    expect(state.later_calls).toEqual(['Bash {"command":"npm test"} -> error']);
    expect(JSON.stringify(state)).not.toContain(fileB);
  });

  it('shrinks to a smaller level when the budget is tight', () => {
    const long = 'lorem ipsum dolor '.repeat(200);
    const messages = [
      message('user', long),
      message('assistant', long),
      call('w', 'Write', { file_path: 'x.ts', content: long }, long),
      result('w', long),
      message('assistant', long),
    ];
    const calls = collectToolCalls(messages, 0);
    const roomy = fitCallState(messages, calls, calls[0]!, { ...options, maxStateTokens: 10_000 });
    const tight = fitCallState(messages, calls, calls[0]!, { ...options, maxStateTokens: 250 });
    expect(roomy.level).toBe(0);
    expect(tight.level).toBeGreaterThan(0);
    expect(tight.tokens).toBeLessThanOrEqual(250);
    expect(tight.tokens).toBeLessThan(roomy.tokens);
  });

  it('returns the smallest level when nothing fits', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const fitted = fitCallState(messages, calls, calls[0]!, { ...options, maxStateTokens: 5 });
    expect(fitted.level).toBe(STATE_LEVELS.length - 1);
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, n));
      active -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

describe('decisions', () => {
  const options = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('keeps, drops the result, or drops the call based on the keep probabilities', () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action).toBe('drop_call');
    expect(decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });

  it('removes dropped calls and truncates dropped results', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      'a.ts looks fine; checking b.ts',
      'tool-2',
      'tool-2',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[2]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-plugin truncated 1700 chars`),
    );
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-plugin truncated 1700 chars`),
    );
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[3]).not.toBe(messages[5]);
    expect(kept[4]).toBe(messages[6]);
    expect(kept[5]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300);
    expect(shortKept[2]).toBe(shortMessages[4]);
    expect(shortKept[3]).toBe(shortMessages[5]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const kept = applyDecisions(messages, decisions, calls, 50);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[fast-laya-plugin truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[fast-laya-plugin truncated ${total} chars of this tool result; re-run the tool if needed]`,
    );
  });
});

describe('compact', () => {
  it('sends one request per candidate call, each with its own state', async () => {
    const seen: Seen[] = [];
    const output = await compact(
      transcript(),
      fakeLaya(() => fate(0.1, 0.8), seen),
      { preserveRecentMessages: 1 },
    );

    expect(seen).toHaveLength(3);
    expect(output.stats.requests).toBe(3);
    expect(seen.every((r) => r.questions.join() === 'fate')).toBe(true);
    expect(seen.map((r) => r.state.call.input).sort()).toEqual([
      '{"command":"npm test"}',
      '{"file_path":"src/a.ts"}',
      '{"file_path":"src/b.ts"}',
    ]);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(10);
    expect(output.stats).toMatchObject({ resultsDropped: 3, kept: 0, callsDropped: 0, pinned: 0, truncatedRequests: 0 });
    expect(output.stats.maxStateTokens).toBeGreaterThan(0);
    expect(output.stats.maxStateTokens).toBeLessThanOrEqual(400);
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('decides each call from its own answer', async () => {
    const output = await compact(
      transcript(),
      fakeLaya((state) => (state.call.tool === 'Bash' ? fate(0.9, 0) : fate(0.05, 0.1))),
      { preserveRecentMessages: 1 },
    );
    expect(output.decisions.map((d) => [d.id, d.action])).toEqual([
      ['t1', 'drop_call'],
      ['t2', 'drop_call'],
      ['t3', 'keep'],
    ]);
  });

  it('counts requests Laya reports as truncated', async () => {
    const asker: LayaAsker = {
      ask: async () => ({
        answers: { fate: { choice: 'keep', confidence: 1, probabilities: fate(0.9, 0) } },
        usage: { truncated: true },
      }),
    };
    const output = await compact(transcript(), asker, { preserveRecentMessages: 1 });
    expect(output.stats.truncatedRequests).toBe(3);
  });

  it('keeps everything without calling Laya when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeLaya(() => fate(0, 0), seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, maxStateTokens: 0, calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports no reduction when Laya wants everything kept', async () => {
    const output = await compact(transcript(), fakeLaya(() => fate(0.95, 0)), { preserveRecentMessages: 1 });
    expect(output.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers', async () => {
    const broken: LayaAsker = {
      ask: async () => ({ answers: { fate: { choice: 'keep', confidence: 1, probabilities: { keep: 0.5 } } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Laya answer for fate/,
    );
    const noul: LayaAsker = { ask: async () => ({ answers: { fate: { noul: 0.5 } } }) };
    await expect(compact(transcript(), noul, { preserveRecentMessages: 1 })).rejects.toThrow(/Invalid Laya answer/);
  });

  it('reads keep as keeping the result and keep plus truncate as keeping the call', () => {
    expect(answerFromFate({ keep: 0.2, truncate: 0.5, drop: 0.3 })).toEqual({ keepCall: 0.7, keepResult: 0.2 });
  });
});

describe('HTTP client', () => {
  it('builds a keyless request to the local laya-serve by default', () => {
    const request = buildLayaRequest({}, { a: 1 }, CALL_QUESTIONS);
    expect(request.url).toBe('http://127.0.0.1:8000/v1/systemone');
    expect(request.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(request.body)).toEqual({ model: 'laya', state: { a: 1 }, questions: CALL_QUESTIONS });
    const custom = buildLayaRequest({ baseUrl: 'http://box:9000/v1/systemone', model: 'laya-multilingual' }, 's', {});
    expect(custom.url).toBe('http://box:9000/v1/systemone');
    expect(JSON.parse(custom.body).model).toBe('laya-multilingual');
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseLayaResponse(503, false, 'busy')).toThrow(/503/);
    expect(() => parseLayaResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseLayaResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseLayaResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  it('reads the truncation flag in both of its forms', () => {
    expect(wasTruncated({ answers: {} })).toBe(false);
    expect(wasTruncated({ answers: {}, usage: { truncated: false } })).toBe(false);
    expect(wasTruncated({ answers: {}, usage: { truncated: true } })).toBe(true);
    expect(wasTruncated({ answers: {}, usage: { truncated: 2 } })).toBe(true);
  });

  it('asks over fetch and surfaces an unreachable server', async () => {
    const urls: string[] = [];
    const client = new LayaClient({
      baseUrl: 'http://local/v1/systemone',
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const response = await client.ask('state', { q: { type: 'noul', instructions: 'x' } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    expect(urls).toEqual(['http://local/v1/systemone']);

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      compactMessages(transcript(), { fetch: down, preserveRecentMessages: 1 }),
    ).rejects.toThrow(/fetch failed/);
  });
});
