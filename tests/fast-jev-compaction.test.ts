import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  applyWithRails,
  RAIL_TIERS,
  batchCalls,
  briefInput,
  reproducible,
  factLines,
  factStubText,
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
    const kept = applyDecisions(messages, decisions, calls, 300, false);

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
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300, false);
    expect(shortKept[2]).toBe(shortMessages[4]);
    expect(shortKept[3]).toBe(shortMessages[5]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const kept = applyDecisions(messages, decisions, calls, 50, false);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[fast-jev-compaction truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0, false);
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

  it('rejects malformed answers', async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Jev answer/,
    );
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

describe('fact stubs', () => {
  it('keeps error, path, version, id, endpoint and count lines of an omitted middle', () => {
    const middle = [
      'plain filler line without anything',
      '-rw-r--r-- 1 user user 179655 Sep 29 03:59 agents-index.ts',
      'GET https://mcp.unframer.co/.well-known/oauth-authorization-server HTTP 404',
      '@codex-codegraph | live | node.exe | pid 43748',
      'figma-desktop err=Failed to connect to 127.0.0.1:3845',
      'node_modules/partyserver 0.4.1',
      '27b19d7f3962fec8 *agents-index.ts',
    ].join('\n');
    const text = `${'h'.repeat(300)}\n${'filler\n'.repeat(500)}${middle}\n${'filler\n'.repeat(500)}${'t'.repeat(200)}`; // > SMALL_KEEP
    const stub = factStubText(text, false, 300, 600);
    for (const fact of ['179655', 'oauth-authorization-server HTTP 404', 'pid 43748', '127.0.0.1:3845', 'partyserver 0.4.1', '27b19d7f3962fec8']) {
      expect(stub).toContain(fact);
    }
    expect(stub).not.toContain('plain filler line');
    expect(stub.startsWith('h'.repeat(300))).toBe(true);
    expect(stub.endsWith('t'.repeat(120))).toBe(true);
    expect(stub.length).toBeLessThan(text.length / 2);
  });

  it('keeps short results whole, errors longer, and a dropped call as a brief stub instead of erasing it', () => {
    expect(factStubText('short', false, 300, 600)).toBe('short');
    const error = `Traceback\n${'e'.repeat(1_900)}`;
    expect(factStubText(error, true, 300, 600)).toBe(error);
    const messages = transcript();
    messages[7]!.toolResults![0]!.text = `${'x'.repeat(2_000)}\nFAIL b.test.ts expected 2 to be 3\n${'x'.repeat(2_000)}`;
    const calls = collectToolCalls(messages, 0);
    const decisions = calls.map((call) => decideCall(call, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5 }));
    const kept = applyDecisions(messages, decisions, calls, 300);
    expect(kept).toHaveLength(messages.length);
    expect(kept[7]?.toolResults?.[0]?.text).toContain('FAIL b.test.ts expected 2 to be 3');
    expect(kept[0]).toBe(messages[0]);
    expect(briefInput({ command: 'a'.repeat(500), n: 1 }, 300)).toEqual({ command: `${'a'.repeat(300)}…[200 chars]`, n: 1 });
  });
});

describe('fact stubs: drop what a re-run gives back', () => {
  it('tells reproducible reads of files from observations of the world and side effects', () => {
    const yes = [
      ['Read', { file_path: 'src/a.ts' }],
      ['Grep', { pattern: 'x' }],
      ['Bash', { command: 'ls F:/Temp/ucp 2>&1 | head -40; echo ---; find F:/Temp/ucp -maxdepth 3 -type d' }],
      ['Bash', { command: 'cd F:/Temp/ucp && sha256sum *.ts | cut -c1-16' }],
      ['Bash', { command: 'git log --oneline | head -5' }],
      ['PowerShell', { command: "rg -l -i 'x' 'C:/st' 2>&1 | Select-Object -First 20" }],
    ] as const;
    const no = [
      ['Bash', { command: 'curl -s https://mcp.unframer.co/mcp' }],
      ['Bash', { command: 'timeout 60 mcpc --json 2>&1 | head -c 12000' }],
      ['Bash', { command: 'netstat -ano | grep 3845; tasklist' }],
      ['Bash', { command: 'ls > listing.txt' }],
      ['Bash', { command: 'ls -la F:/Temp/ucp 2>&1 | head -40' }],
      ['Bash', { command: "sed -i 's/a/b/' f.txt" }],
      ['Bash', { command: 'npm test' }],
      ['Write', { file_path: 'a.ts', content: 'x' }],
      ['mcp__srv__fetch', { url: 'https://x.org' }],
    ] as const;
    for (const [tool, input] of yes) expect(reproducible(tool, input as Record<string, unknown>), `${tool} ${JSON.stringify(input)}`).toBe(true);
    for (const [tool, input] of no) expect(reproducible(tool, input as Record<string, unknown>), `${tool} ${JSON.stringify(input)}`).toBe(false);
  });

  it('shrinks a dropped reproducible read to one line but keeps an observation as a fact stub', () => {
    const big = `${'x'.repeat(3_500)}\nGET https://a.example/.well-known/oauth HTTP 404\n${'x'.repeat(3_500)}`; // > readKeep and small
    const messages: Message[] = [
      { role: 'user', text: 'audit', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'src/a.ts' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: big }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'curl -s https://a.example/.well-known/oauth' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: big }] },
    ];
    const calls = collectToolCalls(messages, 0);
    const decisions = calls.map((call) => decideCall(call, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5 }));
    const kept = applyDecisions(messages, decisions, calls, 200);
    expect(kept[2]?.toolResults?.[0]?.text).toMatch(/^\[fast-jev-compaction omitted \d+ chars: a reproducible read/);
    expect(kept[1]?.toolUses[0]?.input).toEqual({ file_path: 'src/a.ts' });
    expect(kept[4]?.toolResults?.[0]?.text).toContain('HTTP 404');
  });
});

describe('fact stubs: receipts survive', () => {
  it('keeps a receipt line of a non-idempotent call deep in an omitted middle', () => {
    const text = `${'y'.repeat(1_500)}\nmessage_id: 8f3e2a-ticket sent to 3 recipients\n${'y'.repeat(1_500)}`;
    expect(factStubText(text, false, 200, 360)).toContain('message_id: 8f3e2a-ticket sent');
  });
});

describe('fact stubs: hard rails', () => {
  it('never cuts a short observation, keeps whole lines at the tail, and says where the full output is', () => {
    const short = `${'a'.repeat(1200)}\ntable vec_episodes no such module: vec0\n${'b'.repeat(1200)}`;
    expect(factStubText(short, false, 200, 360)).toBe(short); // under 3000 chars: kept whole
    const body = Array.from({ length: 800 }, (_, i) => `row ${i} ok`).join('\n');
    const long = `${body}\n36220 32.02000\nend`;
    const stub = factStubText(long, false, 200, 360, 'toolu_X');
    expect(stub).toContain('36220 32.02000'); // the line at the tail boundary is not split
    expect(stub).toContain('the full output stays in this session\'s transcript under toolu_X');
    expect(stub).not.toContain('re-run the tool');
  });

  it('gives long dumps a fact budget proportional to their size', () => {
    const dump = Array.from({ length: 300 }, (_, i) => `pid ${10000 + i} port ${3000 + i} status failed`).join('\n');
    const kept = factStubText(dump, false, 200, 360).split('\n').filter((l) => l.startsWith('pid ')).length;
    expect(kept).toBeGreaterThan(40); // 20% of ~12k chars, not 360 chars (about 8 lines)
  });
});

describe('fact stubs: logs are observations', () => {
  it('never treats a read of a log, a JSONL ledger or a followed stream as reproducible', () => {
    expect(reproducible('Bash', { command: 'tail -c 1500 C:/ops/app/restic.log' })).toBe(false);
    expect(reproducible('Read', { file_path: 'C:/ops/jev-net/ledger/screen.jsonl' })).toBe(false);
    expect(reproducible('Bash', { command: 'tail -f /var/log/syslog' })).toBe(false);
    expect(reproducible('PowerShell', { command: 'Get-Content app.txt -Tail 50' })).toBe(false);
    expect(reproducible('Bash', { command: 'docker logs web' })).toBe(false);
    expect(reproducible('Read', { file_path: 'C:/src/app.ts' })).toBe(true); // source files still re-read
    expect(reproducible('Bash', { command: 'tail -n 20 src/app.ts' })).toBe(true);
  });
});

describe('fact stubs: rail tiers, dense dumps, failed reads', () => {
  const obs = (id: string, text: string, command = 'curl -s https://x.org') => [
    { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command } }] },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] },
  ];
  const run = (messages: any[]) => {
    const calls = collectToolCalls(messages, 0);
    const decisions = calls.map((c: any) => ({ id: c.id, tool: c.tool, action: 'drop_call' as const, reason: 'call_dropped' as const, keepCall: 0.1, keepResult: 0.1 }));
    return applyWithRails(messages, decisions, calls, 200);
  };

  it('gives up rails tier by tier instead of falling under the reduction floor', () => {
    const five = Array.from({ length: 120 }, (_, i) => `line ${i} plain words here`).join('\n'); // ~3.4k, under tier 0 small
    const out = run([{ role: 'user', text: 'go', toolUses: [] }, ...obs('toolu_A', five), ...obs('toolu_B', five)]);
    expect(out.tier).toBeGreaterThan(0); // tier 0 keeps both whole: no reduction
  });

  it('keeps a dense table whole at tier 0 and turns a failed short read into an observation', () => {
    const table = Array.from({ length: 300 }, (_, i) => `F:/Projects/p${i} ${3000 + i} ${19602045188 + i}`).join('\n'); // ~12k, all facts
    const big = 'x'.repeat(40_000); // plenty of reducible filler elsewhere
    const out = run([{ role: 'user', text: 'go', toolUses: [] }, ...obs('toolu_T', table), ...obs('toolu_X', big),
      ...obs('toolu_F', "find: '/c/nope': No such file or directory\nCommand did not complete within its 120s timeout", 'find /c/nope -name x')]);
    expect(out.tier).toBe(0);
    const text = (id: string) => out.messages.flatMap((m: any) => m.toolResults ?? []).find((r: any) => r.tool_use_id === id)?.text ?? '';
    expect(text('toolu_T')).toContain('F:/Projects/p150 3150'); // dense dump kept whole
    expect(text('toolu_F')).toContain('120s timeout'); // not a re-run line
    expect(RAIL_TIERS[0]!.denseKeep).toBeGreaterThan(0);
  });
});

describe('metadata, long lines, dense tables', () => {
  it('treats file metadata as an observation, alone or inside a compound command', () => {
    for (const command of [
      'cd /x && wc -l pin.mjs && sed -n 1,140p pin.mjs',
      'cat card.xtml; echo; ls -la /x /x/reports 2>&1',
      'stat a.txt',
      'du -sh /x',
    ]) expect(reproducible('Bash', { command }), command).toBe(false);
    expect(reproducible('PowerShell', { command: 'Get-ChildItem C:/x | Select-Object -First 5' })).toBe(false);
    expect(reproducible('Bash', { command: 'cat a.txt | head -40' })).toBe(true);
  });

  it('splits a long line into pieces, so a fact deep inside it is still found', () => {
    const sep = '\\n'; // an escaped newline inside a JSON string: the line itself has no real line break
    const filler = Array.from({ length: 60 }, () => `\\"content\\": \\"note ${'y'.repeat(120)}\\"`).join(sep);
    const line = `{"text": "${filler}${sep}  \\"id\\": \\"f46101ab4a1ecfd2\\"${sep}${filler}"}`;
    expect(line.includes('\n')).toBe(false);
    expect(line.length).toBeGreaterThan(10_000);
    expect(factLines(line, 3_000).some((l) => l.includes('f46101ab4a1ecfd2'))).toBe(true);
  });

  it('keeps a dense table up to 32k chars whole', () => {
    const table = Array.from(
      { length: 150 },
      (_, i) => `b${i} server-${i}.exe.bak-b${i}-20260930 | wave W${i} | ['drafts:events.json', 'live:agent-${i}.jsonl'] | ${'z'.repeat(60)}`,
    ).join('\n');
    expect(table.length).toBeGreaterThan(20_000);
    expect(table.length).toBeLessThan(32_000);
    expect(factStubText(table, false, 200, 360)).toBe(table);
  });
});

describe('windowed states when the history does not fit', () => {
  function long(n: number): Message[] {
    const out: Message[] = [message('user', 'Fix the failing build; never touch src/generated.')];
    for (let i = 0; i < n; i++) {
      out.push(message('assistant', `Step ${i}: ${'checking the next module and its callers '.repeat(6)}`));
      out.push(call(`w${i}`, 'Bash', { command: `npm test -- module${i}` }, ''));
      out.push(result(`w${i}`, `module${i}: 3 passed, 1 failed (exit code 1)\n${'x'.repeat(400)}`));
    }
    out.push(message('user', 'go on'));
    return out;
  }
  const options = { maxStateTokens: 3_000, maxRequestTokens: 6_000, preserveRecentMessages: 2 };

  it('splits into windows that each fit, and every candidate gets a Jev answer', async () => {
    const messages = long(400);
    const calls = collectToolCalls(messages, 2);
    expect(() => fitState(messages, calls, resolveOptions(options))).toThrow(/history too large/);
    const seen: Seen[] = [];
    const result = await compact(messages, fakeJev(() => 0.1, seen), options);
    expect(result.stats.stateStage).toMatch(/^windows:\d+$/);
    expect(result.stats.stateTokens).toBeLessThanOrEqual(options.maxStateTokens);
    const asked = new Set(seen.flatMap((s) => s.questions).filter((q) => q.startsWith('call_')));
    expect(asked.size).toBe(calls.filter((c) => !c.pinned).length);
    expect(result.stats.requests).toBe(seen.length);
  });

  it('sends a call no window can fit to the fact rails without Jev instead of throwing', async () => {
    const messages = long(5);
    const seen: Seen[] = [];
    const result = await compact(messages, fakeJev(() => 0.9, seen), { ...options, maxStateTokens: 200, goal: 'g'.repeat(5_000) });
    expect(seen.length).toBe(0);
    expect(result.stats.stateStage).toMatch(/floor:\d+/);
    expect(result.decisions.filter((d) => d.action === 'drop_call').length).toBe(collectToolCalls(messages, 2).filter((c) => !c.pinned).length);
  });
});
