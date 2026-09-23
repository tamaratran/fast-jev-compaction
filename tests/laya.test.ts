import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LayaClient } from '../src/layaClient.js';
import { JevClient } from '../src/client.js';
import { LayaSubprocessAsker } from '../src/layaBridge.js';
import { compact } from '../src/compact.js';
import type { Message } from '../src/types.js';

describe('LayaClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LAYA_BASE_URL;
    delete process.env.TYPESAFE_BASE_URL;
    delete process.env.TYPESAFE_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('sends correct request payload to local Laya server', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          answers: {
            t1_call: { type: 'noul', noul: 0.9 },
            t1_result: { type: 'noul', noul: 0.1 },
          },
        }),
    });

    const client = new LayaClient({
      baseUrl: 'http://localhost:8000/v1/systemone',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const response = await client.ask('state text', {
      t1_call: { type: 'noul', instructions: 'keep call?' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/v1/systemone');
    expect(init.headers['authorization']).toBe('Bearer laya-local');
    expect(response.answers.t1_call.noul).toBe(0.9);
  });

  it('honours TYPESAFE_BASE_URL when LAYA_BASE_URL is not set', async () => {
    process.env.TYPESAFE_BASE_URL = 'http://127.0.0.1:8787/v1/systemone';

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          answers: {
            t1_call: { type: 'noul', noul: 0.8 },
          },
        }),
    });

    const client = new LayaClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await client.ask('state text', {
      t1_call: { type: 'noul', instructions: 'keep call?' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8787/v1/systemone');
  });

  it('prefers LAYA_BASE_URL over TYPESAFE_BASE_URL', async () => {
    process.env.LAYA_BASE_URL = 'http://127.0.0.1:9000/v1/systemone';
    process.env.TYPESAFE_BASE_URL = 'http://127.0.0.1:8787/v1/systemone';

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          answers: {
            t1_call: { type: 'noul', noul: 0.8 },
          },
        }),
    });

    const client = new LayaClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await client.ask('state text', {
      t1_call: { type: 'noul', instructions: 'keep call?' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9000/v1/systemone');
  });
});

describe('JevClient with TYPESAFE_BASE_URL', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TYPESAFE_BASE_URL;
    delete process.env.TYPESAFE_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('honours TYPESAFE_BASE_URL without requiring TYPESAFE_API_KEY', async () => {
    process.env.TYPESAFE_BASE_URL = 'http://127.0.0.1:8787/v1/systemone';

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          answers: {
            t1_call: { type: 'noul', noul: 0.95 },
          },
        }),
    });

    const client = new JevClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    const response = await client.ask('state text', {
      t1_call: { type: 'noul', instructions: 'keep call?' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8787/v1/systemone');
    expect(response.answers.t1_call.noul).toBe(0.95);
  });
});

describe('LayaSubprocessAsker', () => {
  it('executes python laya_bridge in mock mode and returns valid answers', async () => {
    const asker = new LayaSubprocessAsker({ useMock: true });
    const response = await asker.ask(
      { context: 'test context', goal: 'test goal', history: [] },
      { t1_call: { type: 'noul', instructions: 'is relevant?' } },
    );

    expect(response).toBeDefined();
    expect(response.answers).toBeDefined();
    expect(response.answers.t1_call).toBeDefined();
    expect(response.answers.t1_call.noul).toBe(0.75);
  });
});

describe('compact with LayaAsker', () => {
  it('compacts transcript messages using Laya mock asker', async () => {
    const asker = new LayaSubprocessAsker({ useMock: true });
    const messages: Message[] = [
      { role: 'user', text: 'Hello', toolUses: [] },
      {
        role: 'assistant',
        text: 'Let me run a command',
        toolUses: [
          {
            tool_use_id: 'call_1',
            tool: 'Bash',
            input: { command: 'ls -l' },
          },
        ],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [
          {
            tool_use_id: 'call_1',
            text: 'file1.txt file2.txt file3.txt long content...',
          },
        ],
      },
      { role: 'assistant', text: 'Done', toolUses: [] },
    ];

    const result = await compact(messages, asker, {
      preserveRecentMessages: 0,
    });

    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.stats.calls).toBe(1);
  });
});
