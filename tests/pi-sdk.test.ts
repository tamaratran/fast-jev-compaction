import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import registerPiExtension from '../pi/extension.js';
import { restoreCheckpoints } from '../pi/checkpoint.js';
import { sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';

type AnyRecord = Record<string, any>;

const usage = {
  input: 2,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 4,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp: number): AgentMessage {
  return { role: 'user', content: text, timestamp } as AgentMessage;
}

function assistant(content: AnyRecord[], extras: AnyRecord = {}): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-6-astra',
    responseId: 'sdk-fixture-response',
    usage,
    stopReason: 'stop',
    timestamp: 2,
    ...extras,
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    details: { source: 'sdk-fixture' },
    timestamp: 3,
  } as AgentMessage;
}

function doneStream(model: AnyRecord, text: string) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
  });
  return stream;
}

function jevFetch(bodies: AnyRecord[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as AnyRecord;
    bodies.push(body);
    return new Response(JSON.stringify({
      answers: Object.fromEntries(Object.keys(body.questions ?? {}).map(question => [
        question,
        { type: 'noul', noul: 0.1 },
      ])),
    }), { status: 200 });
  });
}

describe('Pi SDK native compaction integration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function repeatedCompactionFixture() {
    vi.stubEnv('TYPESAFE_API_KEY', 'offline-jev-test-key');
    let keepAll = false;
    let firstPass = true;
    const jevBodies: AnyRecord[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      jevBodies.push(body);
      return new Response(JSON.stringify({ answers: Object.fromEntries(
        Object.keys(body.questions).map(id => [id, {
          type: 'noul', noul: keepAll || firstPass && id.endsWith('t2') ? 0.9 : 0.1,
        }]),
      ) }), { status: 200 });
    }));
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey('openai', 'offline-provider-test-key');
    // Exercise Pi's actual defaults: 20k recent tokens and 16,384 reserved tokens.
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
      extensionFactories: [registerPiExtension], noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(process.cwd());
    const { session } = await createAgentSession({
      cwd: process.cwd(), agentDir: process.cwd(), model: getModel('openai', 'gpt-6-astra'),
      modelRuntime, resourceLoader, sessionManager, settingsManager, noTools: 'all',
    });
    const marker = 'CRITICAL-RETAINED-CONSTRAINT';
    const dropped = 'OBSOLETE-FIRST-READ:'.repeat(16_000);
    const retained = 'SECOND-READ-STILL-NEEDED:'.repeat(4_500);
    const providerContexts: AnyRecord[] = [];
    (session.agent as any).streamFunction = (model: AnyRecord, context: AnyRecord) => {
      providerContexts.push(context);
      return doneStream(model, JSON.stringify(context).includes(marker) ? marker : 'MISSING PRIOR CONTEXT');
    };
    await session.bindExtensions({});
    const call = (id: string) => assistant([
      { type: 'toolCall', id, name: 'read', arguments: { path: `${id}.txt` } },
    ]);
    for (const message of [
      user(marker, 1), call('drop-now'), toolResult('drop-now', dropped),
      call('retain-first'), toolResult('retain-first', retained),
      assistant([{ type: 'text', text: 'Read completed.' }]), user('Continue.', 4),
      assistant([{ type: 'text', text: 'Working.' }]), user('Next.', 5),
      assistant([{ type: 'text', text: 'Ready.' }]), user('Finish.', 6),
    ]) sessionManager.appendMessage(message as any);
    await session.compact();
    firstPass = false;
    const effective = () => restoreCheckpoints(
      sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages), sessionManager.getBranch(),
    );
    return { session, sessionManager, marker, dropped, retained, providerContexts, jevBodies, call, effective,
      keepEverything: () => { keepAll = true; } };
  }

  it('compacts retained checkpoint content again with a short new tail at the default 20k keep budget', async () => {
    const f = await repeatedCompactionFixture();
    try {
      f.sessionManager.appendMessage(user('The old read is no longer needed.', 7) as any);
      f.sessionManager.appendMessage(assistant([{ type: 'text', text: 'Discard that read.' }]) as any);
      const second = await f.session.compact();
      expect(f.jevBodies).toHaveLength(2);
      expect(second.details).toMatchObject({ stats: { callsDropped: 1 } });
      expect(JSON.stringify(f.effective())).toContain(f.marker);
      expect(JSON.stringify(f.effective())).not.toContain(f.dropped);
      expect(JSON.stringify(f.effective())).not.toContain(f.retained);
      await f.session.prompt('Reply with the constraint.', { expandPromptTemplates: false });
      const context = JSON.stringify(f.providerContexts.at(-1));
      expect(context.split(f.marker)).toHaveLength(2);
      expect(context).not.toContain('OBSOLETE-FIRST-READ:');
      expect(context).not.toContain(f.retained);
    } finally { f.session.dispose(); }
  });

  it.each(['missing-key', 'low-reduction', 'disabled', 'request-error'])(
    'preserves the checkpoint during native split-turn fallback: %s', async reason => {
      const f = await repeatedCompactionFixture();
      try {
        if (reason === 'missing-key') vi.stubEnv('TYPESAFE_API_KEY', '');
        else if (reason === 'disabled') await f.session.prompt('/jev off');
        else if (reason === 'request-error') vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
        else f.keepEverything();
        f.sessionManager.appendMessage(user('Inspect the next large file.', 7) as any);
        f.sessionManager.appendMessage(f.call('new-read') as any);
        f.sessionManager.appendMessage(toolResult('new-read', 'NEW-READ-OUTPUT '.repeat(7_000)) as any);
        f.sessionManager.appendMessage(assistant([{ type: 'text', text: 'New read completed.' }]) as any);
        await f.session.compact();
        const context = JSON.stringify(f.providerContexts);
        expect(context).toContain(f.marker);
        expect(context).toContain(f.retained);
        expect(context).not.toContain('OBSOLETE-FIRST-READ:');
        expect(context).toContain('retain-first.txt');
        expect(JSON.stringify(f.effective())).toContain(f.marker);
        expect(JSON.stringify(f.effective())).not.toContain(f.dropped);
      } finally { f.session.dispose(); }
    },
  );

  it('restores only retained messages on the real overflow retry path', async () => {
    const f = await repeatedCompactionFixture();
    try {
      const contexts: AnyRecord[] = [];
      (f.session.agent as any).streamFunction = (model: AnyRecord, context: AnyRecord) => {
        contexts.push(context);
        if (contexts.length > 1) return doneStream(model, 'Recovered.');
        const stream = createAssistantMessageEventStream();
        const error = {
          ...assistant([], { timestamp: Date.now() + 1 }),
          api: model.api, provider: model.provider, model: model.id,
          stopReason: 'error', errorMessage: 'Your input exceeds the context window of this model',
        } as any;
        queueMicrotask(() => { stream.push({ type: 'error', reason: 'error', error }); stream.end(); });
        return stream;
      };
      await f.session.prompt('Continue after removing obsolete reads.', { expandPromptTemplates: false });
      expect(contexts).toHaveLength(2);
      expect(f.jevBodies).toHaveLength(2);
      const retry = JSON.stringify(contexts[1]);
      expect(retry.split(f.marker)).toHaveLength(2);
      expect(retry).not.toContain('OBSOLETE-FIRST-READ:');
      expect(retry).not.toContain('SECOND-READ-STILL-NEEDED:');
      expect(retry).not.toContain('exceeds the context window');
    } finally { f.session.dispose(); }
  });

  it('preserves the checkpoint when Pi declines compaction without any new context', async () => {
    const f = await repeatedCompactionFixture();
    try {
      await f.session.prompt('/jev off');
      await expect(f.session.compact()).rejects.toThrow('Nothing to compact');
      expect(f.providerContexts).toHaveLength(0);
      expect(JSON.stringify(f.effective())).toContain(f.marker);
      expect(JSON.stringify(f.effective())).toContain(f.retained);
      expect(JSON.stringify(f.effective())).not.toContain('OBSOLETE-FIRST-READ:');
    } finally { f.session.dispose(); }
  });

  it('commits a Jev checkpoint through AgentSession.compact, restores typed context for the next request, and gives native fallback the full retained checkpoint', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'offline-jev-test-key');
    const jevBodies: AnyRecord[] = [];
    vi.stubGlobal('fetch', jevFetch(jevBodies));

    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey('openai', 'offline-provider-test-key');
    const model = getModel('openai', 'gpt-6-astra');
    if (!model) throw new Error('The bundled OpenAI Astra model is unavailable');

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager,
      extensionFactories: [registerPiExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(process.cwd());
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      model,
      thinkingLevel: 'xhigh',
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: 'all',
    });

    const providerContexts: AnyRecord[] = [];
    const providerOptions: AnyRecord[] = [];
    const streamFn = vi.fn((requestModel: AnyRecord, context: AnyRecord, options?: AnyRecord) => {
      providerContexts.push(context);
      providerOptions.push(options ?? {});
      return doneStream(requestModel, 'OFFLINE PROVIDER RESPONSE');
    });
    (session.agent as any).streamFunction = streamFn;
    await session.bindExtensions({});
    expect(session.thinkingLevel).toBe('xhigh');

    const fullRetainedText = `SDK-RETAINED:${'complete retained checkpoint text '.repeat(90)}`;
    const droppedOutput = `SDK-DROPPED:${'recomputable output '.repeat(700)}`;
    const transcript = [
      user('Keep the generated directory unchanged.', 1),
      assistant([
        { type: 'thinking', thinking: 'Astra typed reasoning must remain intact.', thinkingSignature: 'astra-thinking-signature' },
        { type: 'text', text: 'I will inspect an old result.' },
      ], { responseId: 'astra-sdk-response' }),
      user(fullRetainedText, 3),
      assistant([
        { type: 'text', text: 'Reading a stale report.' },
        { type: 'toolCall', id: 'sdk-old-read', name: 'read', arguments: { path: 'reports/sdk-old.txt' } },
      ], { stopReason: 'toolUse', timestamp: 4 }),
      toolResult('sdk-old-read', droppedOutput),
      assistant([{ type: 'text', text: 'Old report understood.' }], { timestamp: 5 }),
      user('Continue.', 6),
      assistant([{ type: 'text', text: 'Working.' }], { timestamp: 7 }),
      user('Use the smallest safe change.', 8),
      assistant([{ type: 'text', text: 'Ready.' }], { timestamp: 9 }),
      user('Finish the task.', 10),
    ];
    for (const message of transcript) sessionManager.appendMessage(message as any);

    const checkpointResult = await session.compact();
    const savedCheckpoint = sessionManager.getLeafEntry() as AnyRecord;
    expect(jevBodies).toHaveLength(1);
    expect(streamFn).not.toHaveBeenCalled();
    expect(checkpointResult.details).toMatchObject({ format: 'fast-jev-pi-context-v2' });
    expect(savedCheckpoint).toMatchObject({ type: 'compaction', fromHook: true });
    expect(savedCheckpoint.details.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-6-astra',
      responseId: 'astra-sdk-response',
      content: expect.arrayContaining([expect.objectContaining({ type: 'thinking', thinkingSignature: 'astra-thinking-signature' })]),
    }));
    expect(JSON.stringify(savedCheckpoint.details.messages)).not.toContain(droppedOutput);

    await session.prompt('Make a short status reply.', { expandPromptTemplates: false });
    const followingProviderContext = providerContexts.at(-1);
    expect(JSON.stringify(followingProviderContext)).toContain('Astra typed reasoning must remain intact.');
    expect(JSON.stringify(followingProviderContext)).toContain('Make a short status reply.');
    expect(JSON.stringify(followingProviderContext)).not.toContain(droppedOutput);
    expect(providerOptions.at(-1)).toMatchObject({ reasoning: 'xhigh' });

    vi.stubEnv('TYPESAFE_API_KEY', '');
    sessionManager.appendMessage(user('Native fallback has another update to summarize.', 20) as any);
    sessionManager.appendMessage(user('This creates a later native compaction boundary.', 21) as any);
    const fallbackResult = await session.compact();
    const summaryContext = providerContexts.find(context => JSON.stringify(context).includes('<previous-summary>'));

    expect(jevBodies).toHaveLength(1);
    expect(fallbackResult.summary).toMatch(/^OFFLINE PROVIDER RESPONSE/);
    expect(summaryContext).toBeDefined();
    expect(JSON.stringify(summaryContext)).toContain(fullRetainedText);
    expect(JSON.stringify(summaryContext)).toContain('<read-files>');
    expect(JSON.stringify(summaryContext)).toContain('reports/sdk-old.txt');

    session.dispose();
  });
});
