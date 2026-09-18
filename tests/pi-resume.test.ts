import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { SessionManager, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { createCheckpoint, renderCheckpoint, restoreCheckpoints } from '../pi/checkpoint.js';

it.each(['legacy', 'source'] as const)('restores a %s checkpoint after closing and reopening a real Pi JSONL session', format => {
  const directory = mkdtempSync(join(tmpdir(), 'fast-jev-pi-resume-'));
  try {
    const session = SessionManager.create(process.cwd(), directory);
    const messages: Message[] = [
      { role: 'user', content: 'Keep the exact constraint after resume.', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Retained reasoning.', thinkingSignature: 'opaque-provider-signature' },
          { type: 'text', text: 'The retained answer.' },
        ],
        api: 'openai-responses', provider: 'openai', model: 'gpt-6-astra',
        usage: {
          input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop', timestamp: 2,
      },
    ];
    const sourceIds = messages.map(message => session.appendMessage(message));
    const checkpoint = createCheckpoint(messages, {
      messagesBefore: 2, messagesAfter: 2, charsBefore: 100, charsAfter: 100,
      calls: 0, kept: 0, resultsDropped: 0, callsDropped: 0, pinned: 0,
      stateTokens: 0, stateStage: '', requests: 0, ms: 0,
    }, { read: new Set(), written: new Set(), edited: new Set() }, messages, undefined,
    format === 'source' ? sourceIds[0] : undefined);
    const boundary = session.appendCustomEntry('fast-jev-pi-boundary', { checkpointId: checkpoint.id });
    session.appendCompaction(renderCheckpoint(checkpoint), checkpoint.sourceStartId ?? boundary, 100, checkpoint, true);

    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeDefined();
    const reopened = SessionManager.open(sessionFile!);
    const context = reopened.buildContextEntries().flatMap(sessionEntryToContextMessages);
    expect(context).toHaveLength(format === 'source' ? messages.length + 1 : 1);
    expect(context[0]?.role).toBe('compactionSummary');
    expect(restoreCheckpoints(context, reopened.getBranch())).toEqual(messages);
  } finally {
    // Only remove the exact temporary directory created by this test.
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fast-jev-pi-resume-')) {
      throw new Error('Refusing to remove an unexpected test directory');
    }
    rmSync(target, { recursive: true, force: true });
  }
});
