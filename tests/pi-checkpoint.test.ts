import { describe, expect, it } from 'vitest';

import { SessionManager, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { createCheckpoint, isJevCheckpoint, renderCheckpoint, restoreCheckpoints } from '../pi/checkpoint.js';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const stats = {
  messagesBefore: 8,
  messagesAfter: 5,
  charsBefore: 12_000,
  charsAfter: 3_000,
  calls: 2,
  kept: 0,
  resultsDropped: 1,
  callsDropped: 1,
  pinned: 1,
  stateTokens: 900,
  stateStage: 'full',
  requests: 1,
  ms: 4,
};

function messages(): AgentMessage[] {
  const long = `FULL-RETAINED-TEXT:${'the full retained transcript survives native fallback '.repeat(70)}`;
  return [
    { role: 'user', content: long, timestamp: 1 } as AgentMessage,
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'typed Astra reasoning', thinkingSignature: 'astra-signature' },
        { type: 'text', text: 'Provider fields and exact content must survive.' },
      ],
      api: 'openai-responses',
      provider: 'openai',
      model: 'gpt-6-astra',
      responseId: 'astra-response',
      usage,
      stopReason: 'stop',
      timestamp: 2,
    } as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: 'retained-tool',
      toolName: 'read',
      content: [{ type: 'image', data: 'base64-image-data', mimeType: 'image/png' }],
      isError: false,
      details: { source: 'fixture' },
      timestamp: 3,
    } as AgentMessage,
    {
      role: 'bashExecution',
      command: 'npm test',
      output: 'one failed test',
      exitCode: 1,
      cancelled: false,
      truncated: true,
      fullOutputPath: 'C:/tmp/full-output.txt',
      timestamp: 4,
    } as AgentMessage,
  ];
}

function contextMessages(session: SessionManager): AgentMessage[] {
  return session.buildContextEntries().flatMap(sessionEntryToContextMessages) as AgentMessage[];
}

function addValidCompaction(session: SessionManager, checkpoint = createCheckpoint(messages(), stats, {
  read: new Set(['src/a.ts']),
  written: new Set<string>(),
  edited: new Set(['src/b.ts']),
})) {
  const root = session.appendMessage({ role: 'user', content: 'pre-checkpoint root', timestamp: 0 } as any);
  const boundary = session.appendCustomEntry('fast-jev-pi-boundary', { checkpointId: checkpoint.id });
  const summary = renderCheckpoint(checkpoint);
  const compaction = session.appendCompaction(summary, boundary, 12_345, checkpoint, true);
  return { checkpoint, root, boundary, summary, compaction };
}

describe('Pi checkpoint persistence', () => {
  it('replaces the v2 source interval exactly once and keeps only messages after its commit', () => {
    const session = SessionManager.inMemory(process.cwd());
    const root = session.appendMessage({ role: 'user', content: 'SOURCE-ORIGINAL', timestamp: 0 } as any);
    const checkpoint = createCheckpoint(messages(), stats, {
      read: new Set(), written: new Set(), edited: new Set(),
    }, messages(), undefined, root);
    session.appendCustomEntry('fast-jev-pi-boundary', { checkpointId: checkpoint.id });
    const summary = renderCheckpoint(checkpoint);
    session.appendCompaction(summary, root, 100, checkpoint, true);
    const next = { role: 'user', content: 'New context.', timestamp: 9 } as const;
    session.appendMessage(next);
    const native = contextMessages(session);
    expect(native).toHaveLength(3);
    expect(restoreCheckpoints(native, session.getBranch())).toEqual([...checkpoint.messages, next]);
    expect(JSON.stringify(restoreCheckpoints(native, session.getBranch()))).not.toContain('SOURCE-ORIGINAL');

    session.branch(root);
    session.appendMessage({ role: 'user', content: 'Sibling.', timestamp: 10 });
    expect(restoreCheckpoints(native, session.getBranch())).toEqual(native);
  });

  it('uses a real custom cutoff and restores a deep-cloned typed checkpoint', () => {
    const session = SessionManager.inMemory(process.cwd());
    const { checkpoint, boundary, summary } = addValidCompaction(session);
    const native = contextMessages(session);

    expect(isJevCheckpoint(checkpoint)).toBe(true);
    expect(session.getBranch().find(entry => entry.id === boundary)).toMatchObject({
      type: 'custom',
      customType: 'fast-jev-pi-boundary',
      data: { checkpointId: checkpoint.id },
    });
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({ role: 'compactionSummary', summary });
    expect(summary).toContain('FULL-RETAINED-TEXT:');
    expect(summary).toContain('Command exited with code 1');
    expect(summary).toContain('[Output truncated. Full output: C:/tmp/full-output.txt]');
    expect(summary).toContain('[Image: image/png; data retained in checkpoint]');

    const restored = restoreCheckpoints(native, session.getBranch());
    expect(restored).toEqual(checkpoint.messages);
    expect(restored[0]).not.toBe(checkpoint.messages[0]);
    expect(restored[1]).toMatchObject({
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-6-astra',
      responseId: 'astra-response',
      content: expect.arrayContaining([expect.objectContaining({ type: 'thinking', thinkingSignature: 'astra-signature' })]),
    });
  });

  it('fails closed when the compaction has no matching boundary or has invalid checkpoint details', () => {
    const noBoundary = SessionManager.inMemory(process.cwd());
    const rawCheckpoint = createCheckpoint(messages(), stats, {
      read: new Set<string>(),
      written: new Set<string>(),
      edited: new Set<string>(),
    });
    const root = noBoundary.appendMessage({ role: 'user', content: 'root', timestamp: 0 } as any);
    const summary = renderCheckpoint(rawCheckpoint);
    noBoundary.appendCompaction(summary, root, 100, rawCheckpoint, true);
    const native = contextMessages(noBoundary);
    expect(restoreCheckpoints(native, noBoundary.getBranch())).toEqual(native);

    const invalidDetails = SessionManager.inMemory(process.cwd());
    const invalidRoot = invalidDetails.appendMessage({ role: 'user', content: 'root', timestamp: 0 } as any);
    const invalidBoundary = invalidDetails.appendCustomEntry('fast-jev-pi-boundary', { checkpointId: rawCheckpoint.id });
    invalidDetails.appendCompaction(summary, invalidBoundary || invalidRoot, 100, {
      ...rawCheckpoint,
      stats: { ...stats, requests: Number.NaN },
    }, true);
    const invalidNative = contextMessages(invalidDetails);
    expect(restoreCheckpoints(invalidNative, invalidDetails.getBranch())).toEqual(invalidNative);
    expect(isJevCheckpoint({ ...rawCheckpoint, readFiles: [42] })).toBe(false);
    expect(isJevCheckpoint({ ...rawCheckpoint, modifiedFiles: [42] })).toBe(false);
  });

  it('carries file operations from the full effective context and writes them into native fallback text', () => {
    const sourceMessages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'read-source', name: 'read', arguments: { path: 'src/source-read.ts' } },
          { type: 'toolCall', id: 'write-source', name: 'write', arguments: { path: 'src/source-write.ts' } },
          { type: 'toolCall', id: 'edit-source', name: 'edit', arguments: { path: 'src/source-edit.ts' } },
          { type: 'toolCall', id: 'read-overwritten', name: 'read', arguments: { path: 'src/source-write.ts' } },
        ],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-6-astra',
        usage,
        stopReason: 'toolUse',
        timestamp: 12,
      } as AgentMessage,
    ];
    const checkpoint = createCheckpoint(
      messages(),
      stats,
      {
        read: new Set(['src/prefix-read.ts', 'src/prefix-written.ts']),
        written: new Set(['src/prefix-written.ts']),
        edited: new Set(['src/prefix-edit.ts']),
      },
      sourceMessages,
      { readFiles: ['src/previous-read.ts', 'src/previous-written.ts'], modifiedFiles: ['src/previous-written.ts'] },
    );

    expect(checkpoint.readFiles).toEqual([
      'src/prefix-read.ts',
      'src/previous-read.ts',
      'src/source-read.ts',
    ]);
    expect(checkpoint.modifiedFiles).toEqual([
      'src/prefix-edit.ts',
      'src/prefix-written.ts',
      'src/previous-written.ts',
      'src/source-edit.ts',
      'src/source-write.ts',
    ]);
    const summary = renderCheckpoint(checkpoint);
    expect(summary).toContain('<read-files>\nsrc/prefix-read.ts\nsrc/previous-read.ts\nsrc/source-read.ts\n</read-files>');
    expect(summary).toContain('<modified-files>\nsrc/prefix-edit.ts\nsrc/prefix-written.ts');
  });

  it('never restores a checkpoint from a sibling branch', () => {
    const session = SessionManager.inMemory(process.cwd());
    const { checkpoint, root, compaction, summary } = addValidCompaction(session);
    session.branch(compaction);
    const onCheckpointBranch = contextMessages(session);
    expect(restoreCheckpoints(onCheckpointBranch, session.getBranch())).toEqual(checkpoint.messages);

    session.branch(root);
    session.appendMessage({ role: 'user', content: 'sibling branch message', timestamp: 9 } as any);
    const sibling = session.getBranch();
    const foreignSummary = [{ role: 'compactionSummary', summary, tokensBefore: 12_345, timestamp: 10 } as AgentMessage];
    expect(restoreCheckpoints(foreignSummary, sibling)).toEqual(foreignSummary);
  });
});
