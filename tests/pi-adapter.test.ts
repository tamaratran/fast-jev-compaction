import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  compact,
  reductionRatio,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';
import {
  applyPiEdits,
  compactPiMessages,
  projectPiMessages,
  type PiEdit,
} from '../pi/adapter.js';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}

function toolCall(
  id: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'toolCall', id, name: 'read', arguments: { path: `${id}.ts` }, ...extras };
}

function assistant(content: unknown[], extras: Record<string, unknown> = {}): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage,
    stopReason: 'toolUse',
    timestamp: 2,
    ...extras,
  } as AgentMessage;
}

function toolResult(
  id: string,
  text: string,
  extras: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 3,
    ...extras,
  } as AgentMessage;
}

function fakeJev(
  answer: (question: string) => number,
  seen: string[] = [],
  states: unknown[] = [],
): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      states.push(state);
      const names = Object.keys(questions);
      seen.push(...names);
      return {
        answers: Object.fromEntries(
          names.map((name) => [name, { type: 'noul' as const, noul: answer(name) }]),
        ),
      };
    },
  };
}

function resultText(messages: readonly Message[], id: string): string | undefined {
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (result.tool_use_id === id) return result.text;
    }
  }
  return undefined;
}

function rawResult(messages: readonly AgentMessage[], id: string): Record<string, unknown> {
  const message = messages.find(
    (candidate) => candidate.role === 'toolResult' && candidate.toolCallId === id,
  );
  expect(message).toBeDefined();
  return message as unknown as Record<string, unknown>;
}

describe('Pi adapter native parity', () => {
  it('projects visible assistant text without leaking reasoning or signatures', () => {
    const raw = [
      user('inspect this'),
      assistant([
        { type: 'thinking', thinking: 'First consider the caller.', thinkingSignature: 'opaque-thinking' },
        { type: 'text', text: 'Then read the file.', textSignature: 'opaque-text' },
        toolCall('read', { thoughtSignature: 'opaque-tool' }),
      ]),
      toolResult('read', 'source'),
    ];

    const projected = projectPiMessages(raw, 0);
    expect(projected[1]).toMatchObject({
      role: 'assistant',
      text: 'Then read the file.',
      toolUses: [{ tool_use_id: 'read', tool: 'read', input: { path: 'read.ts' } }],
    });
    expect(JSON.stringify(projected)).not.toContain('opaque-thinking');
    expect(JSON.stringify(projected)).not.toContain('opaque-text');
    expect(JSON.stringify(projected)).not.toContain('opaque-tool');
  });

  it('matches native decisions, truncation, stats, and reduction ratio with GPT thinking and signed blocks', async () => {
    const gone = toolCall('gone', { thoughtSignature: 'signed-tool-call' });
    const trim = toolCall('trim');
    const thinking = { type: 'thinking', thinking: 'reason through the files', thinkingSignature: 'signed-thinking' };
    const signedText = { type: 'text', text: 'I will inspect both files.', textSignature: 'signed-text' };
    const longError = 'failure detail '.repeat(100);
    const raw = [
      user('Fix the requested issue.'),
      assistant([thinking, signedText, gone, trim]),
      toolResult('gone', 'obsolete read output '.repeat(80), { custom: 'gone-result' }),
      toolResult('trim', longError, { isError: true, details: { source: 'tool' }, custom: 'trim-result' }),
      user('Continue.'),
    ];
    const answers = (question: string): number => {
      if (question === 'call_t1' || question === 'result_t1') return 0.1;
      if (question === 'call_t2') return 0.9;
      return 0.1;
    };
    const options = { preserveRecentMessages: 0, truncateHeadChars: 40 };
    const native = await compact(projectPiMessages(raw, 0), fakeJev(answers), options);
    const adapted = await compactPiMessages(raw, fakeJev(answers), options);

    expect(adapted.decisions).toEqual(native.decisions);
    const { ms: _nativeMs, ...nativeStats } = native.stats;
    const { ms: _adaptedMs, ...adaptedStats } = adapted.stats;
    expect(adaptedStats).toEqual(nativeStats);
    expect(reductionRatio({ stats: adapted.stats })).toBe(reductionRatio(native));
    expect(projectPiMessages(adapted.messages, 0)).toEqual(native.messages);
    expect(adapted.edits.map((edit) => [edit.toolCallId, edit.action])).toEqual([
      ['gone', 'drop_call'],
      ['trim', 'drop_result'],
    ]);

    const outputAssistant = adapted.messages[1] as unknown as Record<string, unknown>;
    const outputContent = outputAssistant.content as unknown[];
    expect(outputContent).toEqual([thinking, signedText, trim]);
    expect(outputContent[0]).toBe(thinking);
    expect(outputContent[1]).toBe(signedText);
    expect(adapted.messages.some((message) => message.role === 'toolResult' && message.toolCallId === 'gone')).toBe(false);

    const changed = rawResult(adapted.messages, 'trim');
    expect(changed.isError).toBe(true);
    expect(changed.details).toEqual({ source: 'tool' });
    expect(changed.custom).toBe('trim-result');
    expect(changed.content).toEqual([{ type: 'text', text: resultText(native.messages, 'trim') }]);
    expect(resultText(native.messages, 'trim')).toContain('(error)');
  });

  it('scores thinking, signatures, errors, multimodal output, and deferred-tool metadata instead of excluding them', async () => {
    const ids = ['thinking', 'signed', 'error', 'media', 'deferred', 'preserved'];
    const preservedCall = toolCall('preserved', { thoughtSignature: 'keep-tool-s' });
    const raw = [
      user('start'),
      assistant([{ type: 'thinking', thinking: 'reasoning', thinkingSignature: 's' }, toolCall('thinking')]),
      toolResult('thinking', 't'.repeat(500)),
      assistant([{ type: 'text', text: 'signed', textSignature: 's' }, toolCall('signed', { thoughtSignature: 's' })]),
      toolResult('signed', 's'.repeat(500)),
      assistant([toolCall('error')], { stopReason: 'error' }),
      toolResult('error', 'e'.repeat(500), { isError: true }),
      assistant([toolCall('media')]),
      {
        role: 'toolResult', toolCallId: 'media', toolName: 'read',
        content: [{ type: 'text', text: 'image caption' }, { type: 'image', data: 'base64-secret', mimeType: 'image/png' }],
        isError: false, timestamp: 3,
      } as AgentMessage,
      assistant([toolCall('deferred')]),
      toolResult('deferred', 'd'.repeat(500), { addedToolNames: ['later-tool'] }),
      assistant([{ type: 'thinking', thinking: 'keep reasoning', thinkingSignature: 'keep-s' }, preservedCall]),
      toolResult('preserved', 'p'.repeat(500)),
    ];
    const seen: string[] = [];
    const output = await compactPiMessages(raw, fakeJev((question) => {
      if (question === 'call_t6') return 0.9;
      return 0.1;
    }, seen), { preserveRecentMessages: 0, truncateHeadChars: 30 });

    expect(seen).toHaveLength(ids.length * 2);
    expect(output.edits.map((edit) => edit.toolCallId)).toEqual(ids);
    for (const id of ids.filter((id) => id !== 'preserved')) {
      expect(output.messages.some((message) => message.role === 'toolResult' && message.toolCallId === id)).toBe(false);
    }
    expect(output.messages.some(
      (message) => message.role === 'assistant' && (message as any).content?.[0]?.thinking === 'reasoning',
    )).toBe(false);
    const thinkingAssistant = output.messages.find(
      (message) => message.role === 'assistant' && (message as any).content?.[0]?.thinking === 'keep reasoning',
    ) as any;
    expect(thinkingAssistant.content).toEqual([
      { type: 'thinking', thinking: 'keep reasoning', thinkingSignature: 'keep-s' },
      preservedCall,
    ]);
    expect(rawResult(output.messages, 'preserved').content).toEqual([
      { type: 'text', text: expect.stringContaining('[fast-jev-compaction truncated ') },
    ]);
  });

  it('uses a non-leaking multimodal projection and removes images when native truncation changes the result', async () => {
    const imageData = 'TOP-SECRET-IMAGE-BYTES';
    const multi = {
      role: 'toolResult',
      toolCallId: 'media',
      toolName: 'read',
      content: [
        { type: 'text', text: 'first text '.repeat(50) },
        { type: 'image', data: imageData, mimeType: 'image/png' },
        { type: 'text', text: 'second text '.repeat(50) },
      ],
      details: { retained: true },
      addedToolNames: ['loaded-later'],
      isError: false,
      timestamp: 3,
    } as AgentMessage;
    const raw = [user('start'), assistant([toolCall('media')]), multi, user('continue')];
    const states: unknown[] = [];
    const options = { preserveRecentMessages: 0, truncateHeadChars: 30 };
    const native = await compact(
      projectPiMessages(raw, 0),
      fakeJev((question) => (question.startsWith('call_') ? 0.9 : 0.1)),
      options,
    );
    const output = await compactPiMessages(
      raw,
      fakeJev((question) => (question.startsWith('call_') ? 0.9 : 0.1), [], states),
      options,
    );

    expect(JSON.stringify(states)).not.toContain(imageData);
    const changed = rawResult(output.messages, 'media');
    expect(changed.content).toEqual([{ type: 'text', text: resultText(native.messages, 'media') }]);
    expect(JSON.stringify(changed.content)).not.toContain(imageData);
    expect(changed.details).toEqual({ retained: true });
    expect(changed.addedToolNames).toEqual(['loaded-later']);
  });

  it('keeps short multimodal results when native drop_result is a no-op, and when Jev keeps them', async () => {
    const image = { type: 'image', data: 'short-image-bytes', mimeType: 'image/png' };
    const raw = [
      user('start'),
      assistant([toolCall('short-media')]),
      {
        role: 'toolResult',
        toolCallId: 'short-media',
        toolName: 'read',
        content: [{ type: 'text', text: 'short caption' }, image],
        isError: false,
        timestamp: 3,
      } as AgentMessage,
      user('continue'),
    ];
    const options = { preserveRecentMessages: 0, truncateHeadChars: 30 };
    const noOp = await compactPiMessages(
      raw,
      fakeJev((question) => (question.startsWith('call_') ? 0.9 : 0.1)),
      options,
    );
    const kept = await compactPiMessages(raw, fakeJev(() => 0.9), options);

    expect(noOp.decisions[0]?.action).toBe('drop_result');
    expect(noOp.edits).toEqual([]);
    expect(noOp.messages[2]).toBe(raw[2]);
    expect((rawResult(noOp.messages, 'short-media').content as unknown[])[1]).toBe(image);
    expect(kept.decisions[0]?.action).toBe('keep');
    expect(kept.edits).toEqual([]);
    expect(kept.messages[2]).toBe(raw[2]);
  });

  it('uses the native no-op result decision and native stats for short output', async () => {
    const raw = [user('start'), assistant([toolCall('short')]), toolResult('short', 'small'), user('continue')];
    const options = { preserveRecentMessages: 0 };
    const answer = (question: string): number => question.startsWith('call_') ? 0.9 : 0.1;
    const native = await compact(projectPiMessages(raw, 0), fakeJev(answer), options);
    const output = await compactPiMessages(raw, fakeJev(answer), options);

    expect(native.decisions[0]?.action).toBe('drop_result');
    expect(output.edits).toEqual([]);
    const { ms: _nativeMs, ...nativeStats } = native.stats;
    const { ms: _outputMs, ...outputStats } = output.stats;
    expect(outputStats).toEqual(nativeStats);
    expect(output.stats.resultsDropped).toBe(1);
    expect(output.messages.every((message, index) => message === raw[index])).toBe(true);
  });

  it('only skips non-unique or out-of-order ids; a mismatched display name is still a valid pair', async () => {
    const raw = [
      user('start'),
      toolResult('early', 'e'.repeat(500)),
      assistant([toolCall('early')]),
      assistant([toolCall('mismatch')]),
      toolResult('mismatch', 'm'.repeat(500), { toolName: 'different-name' }),
      assistant([toolCall('duplicate'), toolCall('duplicate')]),
      toolResult('duplicate', 'd'.repeat(500)),
      assistant([toolCall('pinned')]),
      toolResult('pinned', 'p'.repeat(500)),
    ];
    const seen: string[] = [];
    const output = await compactPiMessages(raw, fakeJev(() => 0.1, seen), {
      preserveRecentMessages: 2,
    });

    expect(seen).toEqual(['call_t1', 'result_t1']);
    expect(output.edits).toEqual([expect.objectContaining({ toolCallId: 'mismatch', action: 'drop_call' })]);
    expect(output.messages.some((message) => message.role === 'toolResult' && message.toolCallId === 'early')).toBe(true);
    expect(output.messages.some((message) => message.role === 'toolResult' && message.toolCallId === 'duplicate')).toBe(true);
    expect(output.messages.some((message) => message.role === 'toolResult' && message.toolCallId === 'pinned')).toBe(true);
  });

  it('rejects stale paired content and forged cached result replacements', async () => {
    const raw = [user('start'), assistant([toolCall('safe')]), toolResult('safe', 'z'.repeat(600)), user('continue')];
    const compacted = await compactPiMessages(
      raw,
      fakeJev((question) => (question.startsWith('call_') ? 0.9 : 0.1)),
      { preserveRecentMessages: 0, truncateHeadChars: 20 },
    );
    const cached = compacted.edits[0]!;
    expect(cached.action).toBe('drop_result');

    const changed = [...raw];
    changed[2] = toolResult('safe', 'changed '.repeat(100));
    const stale = applyPiEdits(changed, [cached], 0);
    expect(stale.every((message, index) => message === changed[index])).toBe(true);

    const forged: PiEdit = { ...cached, text: 'arbitrary replacement' };
    const untouched = applyPiEdits(raw, [forged], 0);
    expect(untouched.every((message, index) => message === raw[index])).toBe(true);
  });
});
