import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  resolveHookConfig,
  stripOlderToText,
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
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, textOnlyAfter: 20, model: 'jev-latest' });
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
      textOnlyAfter: 20,
    });
    expect(resolveHookConfig({ textOnlyAfter: 0 }).textOnlyAfter).toBe(0);
    expect(resolveHookConfig({ textOnlyAfter: -3.5 }).textOnlyAfter).toBe(0);
  });
});

describe('text-only for older messages', () => {
  it('rebuilds the messages before a prompt of the person without their handle', () => {
    const { messages, stripped } = stripOlderToText(transcript(), 1);
    expect(stripped).toBe(6);
    expect(messages.map((m) => m.handle)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 'h-6']);
    expect(messages[0]).toEqual({ role: 'user', text: 'Fix the failing test.', toolUses: [] });
    expect(messages[1]?.toolUses[0]?.tool_use_id).toBe('tool-1');
    expect(messages[2]?.toolResults?.[0]?.tool_use_id).toBe('tool-1');
  });

  it('moves the cut back to a prompt so a tool call keeps its result', () => {
    expect(stripOlderToText(transcript(), 2).stripped).toBe(0);
  });

  it('merges the rows of one response and drops thinking-only rows', () => {
    const input = [
      message('user', 'read both', { handle: 'p' }),
      message('assistant', '', { handle: 'think' }),
      message('assistant', '', { toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }], handle: 'ua' }),
      message('assistant', '', { toolUses: [{ tool_use_id: 'b', tool: 'Read', input: {} }], handle: 'ub' }),
      message('user', '', { toolResults: [{ tool_use_id: 'a', text: 'A', isError: false }], handle: 'ra' }),
      message('user', '', { toolResults: [{ tool_use_id: 'b', text: '', isError: false }], handle: 'rb' }),
      message('assistant', 'done', { handle: 'd' }),
      message('user', 'next', { handle: 'n' }),
    ];
    const { messages, stripped } = stripOlderToText(input, 1);
    expect(stripped).toBe(7);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages[1]?.toolUses.map((u) => u.tool_use_id)).toEqual(['a', 'b']);
    expect(messages[1]?.text).toBe('');
    expect(messages[3]?.text).toBe('done');
    expect(messages[2]?.toolResults?.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
    expect(messages[2]?.toolResults?.[1]?.text).toBe('[fast-jev-compaction: an image or other non-text content was here; it was seen and then removed to save context]');
    expect(input[5]?.toolResults?.[0]?.text).toBe('');
  });

  it('keeps an image-only prompt as a placeholder instead of an empty turn', () => {
    const input = [message('user', '', { handle: 'img' }), message('assistant', 'ok', { handle: 'a' }), message('user', 'go', { handle: 'g' })];
    const { messages } = stripOlderToText(input, 1);
    expect(messages[0]?.text).toBe('[fast-jev-compaction: an image or other non-text content was here; it was seen and then removed to save context]');
    expect(messages[0]?.handle).toBeUndefined();
  });

  it('leaves everything whole at 0 or when the transcript is short', () => {
    expect(stripOlderToText(transcript(), 0).stripped).toBe(0);
    expect(stripOlderToText(transcript(), 50).stripped).toBe(0);
  });

  it('compactSession applies it after the Jev decisions', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, textOnlyAfter: 1 }), apiKey: 'k' };
    const { messages, stripped } = await compactSession(transcript(), config, jevFetch(() => 0.9));
    expect(stripped).toBe(6);
    expect(messages.at(-1)?.handle).toBe('h-6');
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
