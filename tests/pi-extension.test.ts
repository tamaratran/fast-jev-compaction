import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionManager, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

type AnyRecord = Record<string, any>;
type Handler = (event: AnyRecord, ctx: AnyRecord) => Promise<unknown> | unknown;
type Command = { description?: string; handler: (args: string, ctx: AnyRecord) => Promise<void> | void };

interface Harness {
  session: SessionManager;
  pi: AnyRecord;
  ctx: AnyRecord;
  handlers: Map<string, Handler>;
  flags: Map<string, AnyRecord>;
  commands: Map<string, Command>;
  appended: AnyRecord[];
  setFlag(name: string, value: string | boolean | undefined): void;
}

const usage = {
  input: 11,
  output: 7,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 18,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = 1): AgentMessage {
  return { role: 'user', content: text, timestamp } as AgentMessage;
}

function assistant(content: AnyRecord[], extras: AnyRecord = {}): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-6-astra',
    responseId: 'response-fixture',
    usage,
    stopReason: 'stop',
    timestamp: 2,
    ...extras,
  } as AgentMessage;
}

function toolResult(id: string, text: string, extras: AnyRecord = {}): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    details: { source: 'runtime-fixture' },
    usage,
    isError: false,
    timestamp: 3,
    ...extras,
  } as AgentMessage;
}

function appendTranscript(session: SessionManager, includeOverflowError = false): {
  messages: AgentMessage[];
  retainedText: string;
  droppedOutput: string;
  rootId: string;
} {
  const retainedText = `RETAINED-TEXT:${'same retained user text '.repeat(130)}`;
  const droppedOutput = `OLD-TOOL-OUTPUT:${'this can be recomputed '.repeat(700)}`;
  const messages: AgentMessage[] = [
    user('Keep src/generated unchanged.'),
    assistant([
      {
        type: 'thinking',
        thinking: 'Astra reasoning block must remain a typed assistant content block.',
        thinkingSignature: 'provider-signed-thinking',
      },
      { type: 'text', text: 'I will preserve the provider metadata as well.' },
    ], { responseId: 'astra-response-1' }),
    user(retainedText, 3),
    assistant([
      { type: 'text', text: 'Reading an old generated report.' },
      { type: 'toolCall', id: 'old-read', name: 'read', arguments: { path: 'reports/old.txt' } },
    ], { stopReason: 'toolUse', timestamp: 4 }),
    toolResult('old-read', droppedOutput, { timestamp: 5 }),
    assistant([{ type: 'text', text: 'I have enough information to continue.' }], { timestamp: 6 }),
    user('Continue with the targeted fix.', 7),
  ];
  if (includeOverflowError) {
    messages.push(assistant(
      [{ type: 'text', text: 'OVERFLOW-ERROR-TRAILING-PAYLOAD' }],
      { stopReason: 'error', errorMessage: 'OVERFLOW-ERROR-TRAILING-PAYLOAD', timestamp: 8 },
    ));
  }
  const ids = messages.map(message => session.appendMessage(message as any));
  return { messages, retainedText, droppedOutput, rootId: ids[0]! };
}

function makeHarness(overrides: Record<string, string | boolean | undefined> = {}): Harness {
  const session = SessionManager.inMemory(process.cwd());
  const handlers = new Map<string, Handler>();
  const flags = new Map<string, AnyRecord>();
  const commands = new Map<string, Command>();
  const values = new Map<string, string | boolean | undefined>(Object.entries(overrides));
  const appended: AnyRecord[] = [];
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    log: vi.fn(),
  };
  const ctx: AnyRecord = {
    hasUI: true,
    mode: 'tui',
    cwd: process.cwd(),
    sessionManager: session,
    model: { contextWindow: 200_000 },
    scopedModels: [],
    signal: undefined,
    ui,
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    abort: vi.fn(),
    shutdown: vi.fn(),
    getSystemPrompt: vi.fn(() => ''),
    getContextUsage: vi.fn(() => ({ tokens: 60_000, contextWindow: 100_000, percent: 0 })),
    compact: vi.fn(),
    waitForIdle: vi.fn(async () => undefined),
  };
  const pi: AnyRecord = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerFlag: vi.fn((name: string, options: AnyRecord) => flags.set(name, options)),
    getFlag: vi.fn((name: string) => values.has(name) ? values.get(name) : flags.get(name)?.default),
    registerCommand: vi.fn((name: string, command: Command) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      const id = session.appendCustomEntry(customType, data);
      appended.push({ id, customType, data });
    }),
  };
  return {
    session,
    pi,
    ctx,
    handlers,
    flags,
    commands,
    appended,
    setFlag(name, value) {
      values.set(name, value);
    },
  };
}

async function register(harness: Harness): Promise<void> {
  const { default: registerPiExtension } = await import('../pi/extension.js');
  registerPiExtension(harness.pi as any);
}

async function fire(harness: Harness, name: string, event: AnyRecord): Promise<unknown> {
  const handler = harness.handlers.get(name);
  if (!handler) throw new Error(`Missing ${name} handler`);
  return handler(event, harness.ctx);
}

async function start(harness: Harness, reason = 'startup'): Promise<void> {
  await fire(harness, 'session_start', { type: 'session_start', reason });
}

function preparation(session: SessionManager): AnyRecord {
  return {
    firstKeptEntryId: session.getBranch()[0]?.id ?? 'first-entry',
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 12_345,
    fileOps: {
      read: new Set(['reports/old.txt']),
      written: new Set<string>(),
      edited: new Set(['src/fix.ts']),
    },
    settings: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 },
  };
}

async function beforeCompact(
  harness: Harness,
  options: {
    reason?: 'manual' | 'threshold' | 'overflow';
    willRetry?: boolean;
    signal?: AbortSignal;
    customInstructions?: string;
  } = {},
): Promise<unknown> {
  return fire(harness, 'session_before_compact', {
    type: 'session_before_compact',
    preparation: preparation(harness.session),
    branchEntries: harness.session.getBranch(),
    reason: options.reason ?? 'manual',
    willRetry: options.willRetry ?? false,
    signal: options.signal ?? new AbortController().signal,
    customInstructions: options.customInstructions,
  });
}

async function command(harness: Harness, args: string): Promise<void> {
  const registered = harness.commands.get('jev');
  if (!registered) throw new Error('Missing /jev command');
  await registered.handler(args, harness.ctx);
}

function scoringFetch(score: (question: string) => number, bodies: AnyRecord[] = []) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as AnyRecord;
    bodies.push(body);
    return new Response(JSON.stringify({
      answers: Object.fromEntries(Object.keys(body.questions ?? {}).map(question => [
        question,
        { type: 'noul', noul: score(question) },
      ])),
    }), { status: 200 });
  });
}

function contextMessages(session: SessionManager): AgentMessage[] {
  return session.buildContextEntries().flatMap(sessionEntryToContextMessages) as AgentMessage[];
}

describe('Pi native compaction extension', () => {
  beforeEach(() => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key-only');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers native compaction defaults and never installs the obsolete turn_end trigger', async () => {
    const harness = makeHarness();
    await register(harness);

    expect(Object.fromEntries(harness.flags)).toEqual({
      'jev-compact-at-percent': expect.objectContaining({ type: 'string', default: '60' }),
      'jev-min-reduction-ratio': expect.objectContaining({ type: 'string', default: '0.25' }),
      'jev-keep-threshold': expect.objectContaining({ type: 'string', default: '0.5' }),
      'jev-preserve-recent': expect.objectContaining({ type: 'string', default: '6' }),
      'jev-max-state-tokens': expect.objectContaining({ type: 'string', default: '25000' }),
      'jev-max-request-tokens': expect.objectContaining({ type: 'string', default: '30000' }),
      'jev-truncate-head-chars': expect.objectContaining({ type: 'string', default: '300' }),
      'jev-timeout-ms': expect.objectContaining({ type: 'string', default: '0' }),
      'jev-model': expect.objectContaining({ type: 'string', default: 'jev-latest' }),
      'jev-disabled': expect.objectContaining({ type: 'boolean', default: false }),
    });
    expect([...harness.commands.keys()]).toEqual(['jev']);
    expect(harness.commands.get('jev')?.description).toMatch(/status, decisions, compact, on, off/);
    expect(harness.handlers.has('session_before_compact')).toBe(true);
    expect(harness.handlers.has('agent_settled')).toBe(true);
    expect(harness.handlers.has('turn_end')).toBe(false);
  });

  it('replaces native summarization with a typed checkpoint behind a real session boundary', async () => {
    const bodies: AnyRecord[] = [];
    const fetcher = scoringFetch(() => 0.1, bodies);
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-preserve-recent': '0' });
    await register(harness);
    await start(harness);
    const fixture = appendTranscript(harness.session);

    const result = await beforeCompact(harness) as AnyRecord;

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result?.compaction).toEqual(expect.objectContaining({
      tokensBefore: 12_345,
      summary: expect.stringContaining('[fast-jev-compaction checkpoint '),
    }));
    const boundary = harness.session.getLeafEntry() as AnyRecord;
    expect(boundary).toMatchObject({
      type: 'custom',
      customType: 'fast-jev-pi-boundary',
      data: expect.objectContaining({ checkpointId: expect.any(String) }),
    });
    expect(result.compaction.firstKeptEntryId).toBe(fixture.rootId);

    const details = result.compaction.details as AnyRecord;
    expect(details).toMatchObject({
      format: 'fast-jev-pi-context-v2',
      sourceStartId: fixture.rootId,
      id: boundary.data.checkpointId,
      readFiles: ['reports/old.txt'],
      modifiedFiles: ['src/fix.ts'],
      stats: expect.objectContaining({ callsDropped: 1 }),
    });
    expect(details.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-6-astra',
      responseId: 'astra-response-1',
      content: expect.arrayContaining([expect.objectContaining({ type: 'thinking', thinkingSignature: 'provider-signed-thinking' })]),
    }));
    expect(details.messages.some((message: AnyRecord) => message.role === 'toolResult' && message.toolCallId === 'old-read')).toBe(false);
    expect(result.compaction.summary).toContain(fixture.retainedText);

    const savedCompactionId = harness.session.appendCompaction(
      result.compaction.summary,
      result.compaction.firstKeptEntryId,
      result.compaction.tokensBefore,
      details,
      true,
    );
    const savedCompaction = harness.session.getEntry(savedCompactionId) as AnyRecord;
    await fire(harness, 'session_compact', {
      type: 'session_compact',
      compactionEntry: savedCompaction,
      fromExtension: true,
      reason: 'manual',
      willRetry: false,
    });
    await command(harness, 'decisions');
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('drop_call'), 'info');
    await fire(harness, 'session_compact', {
      type: 'session_compact',
      compactionEntry: { type: 'compaction', details: undefined },
      fromExtension: false,
      reason: 'manual',
      willRetry: false,
    });
    await command(harness, 'decisions');
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith('Jev: no decisions yet', 'info');
    const nativeContext = contextMessages(harness.session);
    expect(nativeContext).toHaveLength(fixture.messages.length + 1);
    expect(nativeContext[0]).toMatchObject({ role: 'compactionSummary', summary: result.compaction.summary });

    const restored = await fire(harness, 'context', { type: 'context', messages: nativeContext }) as AnyRecord;
    expect(restored.messages).toEqual(details.messages);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await command(harness, 'off');
    const withNewUser = [...nativeContext, user('Now inspect the deployment script.', 99)];
    const afterOff = await fire(harness, 'context', { type: 'context', messages: withNewUser }) as AnyRecord;
    expect(afterOff.messages).toEqual([...details.messages, withNewUser.at(-1)]);
    expect(afterOff.messages.some((message: AnyRecord) => message.role === 'toolResult' && message.toolCallId === 'old-read')).toBe(false);
    expect(JSON.stringify(afterOff.messages)).not.toContain(fixture.droppedOutput);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back to Pi native compaction for missing credentials, low reduction, request failure, and timeout', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const missingKey = makeHarness({ 'jev-preserve-recent': '0' });
    await register(missingKey);
    await start(missingKey);
    appendTranscript(missingKey.session);
    await expect(beforeCompact(missingKey)).resolves.toBeUndefined();
    expect(missingKey.appended).toHaveLength(0);

    vi.stubEnv('TYPESAFE_API_KEY', 'test-key-only');
    const lowReductionFetcher = scoringFetch(() => 0.99);
    vi.stubGlobal('fetch', lowReductionFetcher);
    const lowReduction = makeHarness({ 'jev-preserve-recent': '0' });
    await register(lowReduction);
    await start(lowReduction);
    appendTranscript(lowReduction.session);
    await expect(beforeCompact(lowReduction)).resolves.toBeUndefined();
    expect(lowReductionFetcher).toHaveBeenCalledTimes(1);
    expect(lowReduction.appended).toHaveLength(0);

    const failingFetcher = vi.fn(async () => new Response('private transcript must stay out of UI', { status: 500 }));
    vi.stubGlobal('fetch', failingFetcher);
    const failing = makeHarness({ 'jev-preserve-recent': '0' });
    await register(failing);
    await start(failing);
    appendTranscript(failing.session);
    await expect(beforeCompact(failing)).resolves.toBeUndefined();
    expect(failing.appended).toHaveLength(0);
    expect(JSON.stringify(failing.ctx.ui.notify.mock.calls)).not.toContain('private transcript');

    vi.useFakeTimers();
    const slowFetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>(() => undefined),
    }) as Response);
    vi.stubGlobal('fetch', slowFetcher);
    const timeout = makeHarness({ 'jev-preserve-recent': '0', 'jev-timeout-ms': '5' });
    await register(timeout);
    await start(timeout);
    appendTranscript(timeout.session);
    const pending = beforeCompact(timeout);
    const assertion = expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    expect(timeout.appended).toHaveLength(0);
  });

  it('cancels only when Pi aborts the actual compaction signal', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, _init?: RequestInit) => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-preserve-recent': '0' });
    await register(harness);
    await start(harness);
    appendTranscript(harness.session);
    const controller = new AbortController();
    const pending = beforeCompact(harness, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new Error('Pi cancelled compaction'));

    await expect(pending).resolves.toEqual({ cancel: true });
    expect(harness.appended).toHaveLength(0);
  });

  it('forwards explicit /compact instructions as the Jev scoring goal', async () => {
    const bodies: AnyRecord[] = [];
    const fetcher = scoringFetch(() => 0.1, bodies);
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-preserve-recent': '0' });
    await register(harness);
    await start(harness);
    appendTranscript(harness.session);

    await expect(beforeCompact(harness, {
      customInstructions: 'Focus only on the deployment rollback files.',
    })).resolves.toEqual(expect.objectContaining({ compaction: expect.any(Object) }));

    expect(bodies[0]?.state.goal).toBe('Focus only on the deployment rollback files.');
  });

  it('falls back to Pi when a retained checkpoint cannot fit the active model, including overflow recovery', async () => {
    const fetcher = scoringFetch(() => 0.1);
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-preserve-recent': '0' });
    harness.ctx.model = { contextWindow: 100 };
    await register(harness);
    await start(harness);
    appendTranscript(harness.session);

    await expect(beforeCompact(harness, { reason: 'overflow', willRetry: true })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(harness.appended).toHaveLength(0);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('retained context still exceeds the model budget'),
      'warning',
    );
  });

  it('triggers automatic compaction once at 60 percent and resets the guard when Pi completes it', async () => {
    const harness = makeHarness();
    await register(harness);
    await start(harness);
    harness.ctx.getContextUsage.mockReturnValue({ tokens: 60_000, contextWindow: 100_000, percent: 60 });

    await fire(harness, 'agent_settled', { type: 'agent_settled' });
    await fire(harness, 'agent_settled', { type: 'agent_settled' });
    expect(harness.ctx.compact).toHaveBeenCalledTimes(1);
    const firstOptions = harness.ctx.compact.mock.calls[0]?.[0] as AnyRecord;
    expect(firstOptions).toEqual(expect.objectContaining({ onComplete: expect.any(Function), onError: expect.any(Function) }));

    firstOptions.onComplete();
    await fire(harness, 'agent_settled', { type: 'agent_settled' });
    expect(harness.ctx.compact).toHaveBeenCalledTimes(2);
  });

  it('uses /jev compact and the prune alias to call Pi compaction directly without a background score', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness();
    await register(harness);
    await start(harness);

    await command(harness, 'compact');
    expect(harness.ctx.waitForIdle).toHaveBeenCalledTimes(1);
    expect(harness.ctx.compact).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    const firstOptions = harness.ctx.compact.mock.calls[0]?.[0] as AnyRecord;
    firstOptions.onError();

    await command(harness, 'prune');
    expect(harness.ctx.waitForIdle).toHaveBeenCalledTimes(2);
    expect(harness.ctx.compact).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('excludes a trailing overflow error before Jev sees or checkpoints it', async () => {
    const bodies: AnyRecord[] = [];
    const fetcher = scoringFetch(() => 0.1, bodies);
    vi.stubGlobal('fetch', fetcher);
    const harness = makeHarness({ 'jev-preserve-recent': '0' });
    await register(harness);
    await start(harness);
    appendTranscript(harness.session, true);

    const result = await beforeCompact(harness, { reason: 'overflow', willRetry: true }) as AnyRecord;

    expect(result?.compaction).toBeDefined();
    expect(JSON.stringify(bodies[0]?.state)).not.toContain('OVERFLOW-ERROR-TRAILING-PAYLOAD');
    expect(JSON.stringify(result.compaction.details.messages)).not.toContain('OVERFLOW-ERROR-TRAILING-PAYLOAD');
  });
});
