import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  batchCalls,
  buildJevRequest,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  estimateTokens,
  fitState,
  JevClient,
  parseJevResponse,
  reductionRatio,
  resolveOptions,
  type HistoryToolCall,
  type JevAsker,
  JevRequestError,
  JevTransportError,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../src/index.js';

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

type Seen = { state: unknown; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: 'fix the test',
};

describe('options', () => {
  it('fills in defaults and ignores non-finite values', () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 300,
    });
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
    })).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });
});

describe('token estimate', () => {
  it('charges words, digits and symbols separately and never undercounts JSON badly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
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
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('state fitting', () => {
  it('sends the whole history with tool results replaced by a note', () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit);
    expect(stage).toBe('full');
    const json = JSON.stringify(state);
    expect(json).not.toContain('export const a = 1;');
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
      id: 't1',
      tool: 'Read',
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect((state.history[4]?.tool_calls?.[0] as HistoryToolCall).result).toMatch(/^error, /);
  });

  it('defaults the goal to the latest user prompts', () => {
    const { state } = fitState(transcript(), [], { ...fit, goal: '' });
    expect(state.goal).toContain('Fix the failing test');
    expect(state.goal).toContain('go ahead');
  });

  it('truncates tool inputs before touching message text', () => {
    const messages = [
      message('user', 'start'),
      call('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) }, 'ok'),
      result('w', 'ok'),
      message('assistant', 'written'),
    ];
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 300,
    });
    expect(stage).toBe('inputs<=200');
    expect(tokens).toBeLessThanOrEqual(300);
    expect(state.history[0]?.text).toBe('start');
    expect((state.history[1]?.tool_calls?.[0] as HistoryToolCall).input.length).toBeLessThanOrEqual(200);
  });

  it('shrinks old tool calls to one line each when nothing else is left to cut', () => {
    const messages = [message('user', 'start')];
    for (let i = 0; i < 40; i += 1) {
      messages.push(call(`c${i}`, 'Read', { file_path: `/repo/src/module-${i}.ts` }, 'x'), result(`c${i}`, 'x'));
    }
    messages.push(message('assistant', 'done'));
    const calls = collectToolCalls(messages, 1);
    const full = fitState(messages, calls, { ...fit, preserveRecentMessages: 1 });
    const compacted = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.8),
    });
    expect(compacted.stage).toBe('old calls compacted');
    expect(compacted.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
    expect(compacted.tokens).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(compacted.state)));
    expect(compacted.state.history[1]?.tool_calls?.[0]).toBe(
      't1 Read file_path=/repo/src/module-0.ts → ok 1ch',
    );
    expect(compacted.state.history.at(-1)?.text).toBe('done');

    const merged = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.45),
    });
    expect(merged.stage).toBe('old calls merged');
    expect(merged.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.45));
    expect(merged.state.history).toHaveLength(3);
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
    expect(merged.state.history[1]?.tool_calls?.[39]).toMatch(/^t40 Read /);
    expect(merged.state.history[0]?.text).toBe('start');
    expect(merged.state.history[2]?.text).toBe('done');
  });

  it('abridges long texts oldest-first and collapses old messages last', () => {
    const long = (n: number) => `${n} ` + 'lorem ipsum '.repeat(300);
    const messages = [
      message('user', long(0)),
      message('assistant', long(1)),
      message('user', long(2)),
      message('assistant', long(3)),
      message('user', 'latest'),
    ];
    const abridged = fitState(messages, [], { ...fit, maxStateTokens: 1800, preserveRecentMessages: 1 });
    expect(abridged.stage).toBe('texts abridged');
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain('chars omitted');
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe('latest');

    const collapsed = fitState(messages, [], { ...fit, maxStateTokens: 420, preserveRecentMessages: 1 });
    expect(collapsed.stage).toBe('old messages collapsed');
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain('lorem');
    expect(collapsed.state.history[4]?.text).toBe('latest');
  });

  it('throws when the history cannot be fitted', () => {
    const messages = [message('user', 'a'.repeat(2000)), message('assistant', 'b')];
    expect(() => fitState(messages, [], { ...fit, maxStateTokens: 50 })).toThrow(/too large/);
  });
});

describe('question batching', () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));
  const options = { maxRequestTokens: 30_000 };

  it('puts everything in one request when it fits', () => {
    expect(batchCalls(calls, 1000, options)).toHaveLength(1);
  });

  it('splits questions across requests when the state leaves little room', () => {
    const batches = batchCalls(calls, 29_600, options);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it('throws when a single question does not fit', () => {
    expect(() => batchCalls(calls, 29_990, options)).toThrow(/no room/);
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
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[2]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
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
      `${original.slice(0, 50)}\n[fast-jev-compaction truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[fast-jev-compaction truncated ${total} chars of this tool result; re-run the tool if needed]`,
    );
  });
});

describe('compact', () => {
  it('resends the full state with every batch and merges the answers', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: '',
      preserveRecentMessages: 1,
    }).tokens;
    const output = await compact(
      messages,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen),
      { preserveRecentMessages: 1, maxRequestTokens: stateTokens + 150 },
    );

    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.flatMap((r) => r.questions).sort()).toEqual([
      'call_t1',
      'call_t2',
      'call_t3',
      'result_t1',
      'result_t2',
      'result_t3',
    ]);
    expect(new Set(seen.map((r) => JSON.stringify(r.state))).size).toBe(1);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 3, kept: 0, callsDropped: 0, pinned: 0 });
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeJev(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: '', calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports a tiny reduction when Jev wants everything kept', async () => {
    const output = await compact(transcript(), fakeJev(() => 0.95), { preserveRecentMessages: 1 });
    expect(output.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers, naming every bad question, without a retry', async () => {
    let asked = 0;
    const broken: JevAsker = {
      ask: async () => { asked++; return { answers: { call_t1: { noul: 0.5 }, result_t1: { noul: 'x' } } }; },
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Jev answer for result_t1, call_t2, result_t2/,
    );
    expect(asked).toBe(1);
  });
});

describe('retries and batch failure', () => {
  function flaky(failures: Map<string, number[]>, statuses: number[], calls: string[] = []): JevAsker {
    // fails a batch (identified by the question names it carries) with the next status in `statuses`
    return {
      async ask(_state, questions: JevQuestions) {
        const names = Object.keys(questions);
        calls.push(names.join(','));
        for (const [marker, left] of failures) {
          if (names.includes(marker) && left.length > 0) {
            const status = left.shift()!;
            throw new JevRequestError(status, `status ${status}`);
          }
        }
        return {
          answers: Object.fromEntries(names.map((n) => [n, { type: 'noul' as const, noul: 0.1 }])),
        };
      },
    };
  }
  const noWait = { retryDelayMs: 0 };

  it('retries a transient failure with backoff and reports it', async () => {
    const waits: number[] = [];
    const calls: string[] = [];
    const output = await compact(
      transcript(),
      flaky(new Map([['call_t1', [503]]]), [], calls),
      { preserveRecentMessages: 1, retryDelayMs: 500, sleep: async (ms) => { waits.push(ms); } },
    );
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([500]);
    expect(output.stats).toMatchObject({ requests: 1, retries: 1, failedBatches: 0 });
    expect(output.decisions.every((d) => d.action === 'drop_call')).toBe(true);
  });

  it('gives up after the retries with tripled waits', async () => {
    const waits: number[] = [];
    const calls: string[] = [];
    await expect(
      compact(transcript(), flaky(new Map([['call_t1', [503, 502, 429, 500]]]), [], calls), {
        preserveRecentMessages: 1,
        retries: 2,
        retryDelayMs: 100,
        sleep: async (ms) => { waits.push(ms); },
      }),
    ).rejects.toThrow(/Jev request failed \(429\)/);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 300]);
  });

  it('does not retry a 4xx other than 429, nor a malformed answer', async () => {
    const calls: string[] = [];
    await expect(
      compact(transcript(), flaky(new Map([['call_t1', [402]]]), [], calls), { preserveRecentMessages: 1, ...noWait }),
    ).rejects.toThrow(/\(402\)/);
    expect(calls).toHaveLength(1);
    let asked = 0;
    const malformed: JevAsker = { ask: async () => { asked++; return { answers: { nope: { noul: 1 } } }; } };
    await expect(compact(transcript(), malformed, { preserveRecentMessages: 1, ...noWait })).rejects.toThrow(/Invalid Jev answer/);
    expect(asked).toBe(1);
  });

  it('retries a JevTransportError but not any other thrown error', async () => {
    let asked = 0;
    const asker: JevAsker = {
      async ask(_s, questions: JevQuestions) {
        asked++;
        if (asked === 1) throw new JevTransportError(new TypeError('fetch failed'));
        return { answers: Object.fromEntries(Object.keys(questions).map((n) => [n, { noul: 0.9 }])) };
      },
    };
    const output = await compact(transcript(), asker, { preserveRecentMessages: 1, ...noWait });
    expect(asked).toBe(2);
    expect(output.stats.retries).toBe(1);

    let plain = 0;
    const waits: number[] = [];
    const broken: JevAsker = { ask: async () => { plain++; throw new Error('TYPESAFE_API_KEY is not configured'); } };
    await expect(
      compact(transcript(), broken, { preserveRecentMessages: 1, sleep: async (ms) => { waits.push(ms); } }),
    ).rejects.toThrow(/not configured/);
    expect(plain).toBe(1);
    expect(waits).toEqual([]);
  });

  it('the HTTP client wraps a throwing fetch in JevTransportError, but a failed status stays a request error', async () => {
    const client = new JevClient({
      apiKey: 'k',
      fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    });
    await expect(client.ask('s', {})).rejects.toBeInstanceOf(JevTransportError);
    const unreadable = new JevClient({
      apiKey: 'k',
      fetch: (async () => ({ status: 401, ok: false, text: async () => { throw new Error('socket closed'); } })) as unknown as typeof fetch,
    });
    await expect(unreadable.ask('s', {})).rejects.toMatchObject({ name: 'JevRequestError', status: 401 });
  });

  it('with onBatchFailure=keep, a dead batch is kept whole and the other batches still apply', async () => {
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), { ...fit, goal: '', preserveRecentMessages: 1 }).tokens;
    const batched = { preserveRecentMessages: 1, maxRequestTokens: stateTokens + 150, retries: 1, ...noWait };
    const calls: string[] = [];
    const dead = () => flaky(new Map([['call_t1', [503, 503, 503]]]), [], calls);

    await expect(compact(messages, dead(), batched)).rejects.toThrow(/\(503\)/);

    calls.length = 0;
    const output = await compact(messages, dead(), { ...batched, onBatchFailure: 'keep' });
    expect(output.stats.requests).toBeGreaterThan(1);
    expect(output.stats.failedBatches).toBe(1);
    expect(output.stats.retries).toBe(1); // the dead batch's spent retry still counts
    const byId = new Map(output.decisions.map((d) => [d.id, d]));
    expect(byId.get('t1')).toMatchObject({ action: 'keep', keepCall: 1, keepResult: 1 });
    const others = output.decisions.filter((d) => d.id !== 't1' && d.reason !== 'pinned');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((d) => d.action === 'drop_call')).toBe(true);
    // the dead batch was attempted 1 + retries times; the live ones once
    expect(calls.filter((c) => c.includes('call_t1'))).toHaveLength(2);
  });
});

describe('keep mode scope and error choice', () => {
  const batched = (messages: Message[]) => ({
    preserveRecentMessages: 1,
    maxRequestTokens: fitState(messages, collectToolCalls(messages, 1), { ...fit, goal: '', preserveRecentMessages: 1 }).tokens + 150,
    retries: 1,
    retryDelayMs: 0,
    onBatchFailure: 'keep' as const,
  });
  function failing(error: (names: string[]) => unknown): JevAsker {
    return {
      async ask(_s, questions: JevQuestions) {
        const names = Object.keys(questions);
        const e = error(names);
        if (e) throw e;
        return { answers: Object.fromEntries(names.map((n) => [n, { noul: 0.1 }])) };
      },
    };
  }

  it('keep still throws a 4xx other than 429: the request is at fault, not the gateway', async () => {
    const messages = transcript();
    await expect(
      compact(messages, failing((n) => (n.includes('call_t1') ? new JevRequestError(401, 'invalid_api_key') : null)), batched(messages)),
    ).rejects.toThrow(/\(401\)/);
  });

  it('keep still throws a plain error and an abort', async () => {
    const messages = transcript();
    await expect(
      compact(messages, failing((n) => (n.includes('call_t1') ? new Error('boom') : null)), batched(messages)),
    ).rejects.toThrow(/boom/);
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    let asked = 0;
    const aborting: JevAsker = { ask: async () => { asked++; throw new JevTransportError(abort); } };
    await expect(
      compact(messages, aborting, { preserveRecentMessages: 1, retries: 2, retryDelayMs: 0, onBatchFailure: 'keep' }),
    ).rejects.toThrow(/aborted/);
    expect(asked).toBe(1); // one batch, and an abort is never retried
  });

  it('keep keeps a malformed batch whole and applies the rest', async () => {
    const messages = transcript();
    const asker: JevAsker = {
      async ask(_s, questions: JevQuestions) {
        const names = Object.keys(questions);
        return {
          answers: Object.fromEntries(names.map((n) => [n, n === 'result_t1' ? { noul: 'bad' } : { noul: 0.1 }])),
        };
      },
    };
    const output = await compact(messages, asker, batched(messages));
    expect(output.stats.failedBatches).toBe(1);
    const t1 = output.decisions.find((d) => d.id === 't1');
    expect(t1).toMatchObject({ action: 'keep', keepCall: 1, keepResult: 1 });
    expect(output.decisions.filter((d) => d.id !== 't1' && d.reason !== 'pinned').every((d) => d.action === 'drop_call')).toBe(true);
  });

  it('throw mode surfaces the actionable error over a hiccup when several batches fail', async () => {
    const messages = transcript();
    const asker = failing((n) => (n.includes('call_t1') ? new JevRequestError(503, 'down') : new JevRequestError(402, 'insufficient_quota')));
    await expect(compact(messages, asker, { ...batched(messages), onBatchFailure: 'throw' })).rejects.toThrow(/\(402\)/);
  });

  it('a transport error from an unparsable URL is not retried', async () => {
    let asked = 0;
    const bad = { ask: async () => { asked++; throw new JevTransportError(Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' })); } };
    await expect(compact(transcript(), bad, { preserveRecentMessages: 1, retryDelayMs: 0 })).rejects.toThrow(/Invalid URL/);
    expect(asked).toBe(1);
  });

  it('uses a real timer when no sleep is injected', async () => {
    let asked = 0;
    const asker: JevAsker = {
      async ask(_s, questions: JevQuestions) {
        asked++;
        if (asked === 1) throw new JevRequestError(503, 'down');
        return { answers: Object.fromEntries(Object.keys(questions).map((n) => [n, { noul: 0.9 }])) };
      },
    };
    const started = Date.now();
    const output = await compact(transcript(), asker, { preserveRecentMessages: 1, retries: 1, retryDelayMs: 25 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(output.stats.retries).toBe(1);
  });
});

describe('HTTP client', () => {
  it('builds a System One request', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { a: 1 }, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(request.body)).toEqual({
      model: 'jev-latest',
      state: { a: 1 },
      questions: { q: { type: 'noul', instructions: 'x' } },
    });
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseJevResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseJevResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseJevResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseJevResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  it('asks over fetch and refuses to run without a key', async () => {
    const bodies: string[] = [];
    const client = new JevClient({
      apiKey: 'k',
      model: 'jev-test',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const response = await client.ask('state', { q: { type: 'noul', instructions: 'x' } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    expect(JSON.parse(bodies[0]!).model).toBe('jev-test');

    const keyless = new JevClient({ apiKey: '' });
    await expect(keyless.ask('s', {})).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactMessages(transcript(), { apiKey: '', preserveRecentMessages: 1 }),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});
