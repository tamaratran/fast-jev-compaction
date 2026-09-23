import { describe, expect, it, vi } from 'vitest';
import { SemIfClient } from '../src/semifClient.js';
import { SemIfSubprocessAsker } from '../src/semifBridge.js';
import { compact } from '../src/compact.js';
import type { Message } from '../src/types.js';
import { resolveHookConfig, compactSession, type HookFetch } from '../hooks/fast-jev.js';

describe('SemIfClient', () => {
  it('sends correct request payload to native /v1/systemone endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          model: 'Qwen/Qwen3.5-4B',
          answers: {
            t1_call: { type: 'noul', noul: 0.95 },
            t1_result: { type: 'noul', noul: 0.15 },
          },
        }),
    });

    const client = new SemIfClient({
      baseUrl: 'http://127.0.0.1:8765/v1/systemone',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const response = await client.ask('state text', {
      t1_call: { type: 'noul', instructions: 'Keep tool call in history?' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8765/v1/systemone');
    expect(init.headers['authorization']).toBe('Bearer semif-local');
    expect(response.answers.t1_call.noul).toBe(0.95);
  });

  it('falls back to /v1/decide endpoint when /v1/systemone returns 404', async () => {
    const mockFetch = vi
      .fn()
      // First call to /v1/systemone -> 404
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        text: async () => 'Not Found',
      })
      // Subsequent call to /v1/decide -> 200
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          id: 'decide-1',
          decision: 'yes',
          confidence: 0.88,
          probabilities: { yes: 0.88, no: 0.12 },
        }),
      });

    const client = new SemIfClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const response = await client.ask('some state', {
      q1: { type: 'noul', instructions: 'Was the operation successful?' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url2, init2] = mockFetch.mock.calls[1];
    expect(url2).toBe('http://127.0.0.1:8765/v1/decide');
    const parsedBody = JSON.parse(init2.body);
    expect(parsedBody.question).toBe('Was the operation successful?');
    expect(response.answers.q1.noul).toBe(0.88);
  });
});

describe('SemIfSubprocessAsker', () => {
  it('executes python semif_bridge in mock mode and returns valid answers', async () => {
    const asker = new SemIfSubprocessAsker({ useMock: true });
    const response = await asker.ask(
      { context: 'test context', goal: 'test goal', history: [] },
      { t1_call: { type: 'noul', instructions: 'is relevant?' } },
    );

    expect(response).toBeDefined();
    expect(response.answers).toBeDefined();
    expect(response.answers.t1_call).toBeDefined();
    expect(response.answers.t1_call.noul).toBe(0.85);
  });
});

describe('compact with SemIfAsker', () => {
  it('compacts transcript messages using SemIf mock asker', async () => {
    const asker = new SemIfSubprocessAsker({ useMock: true });
    const messages: Message[] = [
      { role: 'user', text: 'Hello', toolUses: [] },
      {
        role: 'assistant',
        text: 'Executing task',
        toolUses: [
          {
            tool_use_id: 'call_1',
            tool: 'Bash',
            input: { command: 'git status' },
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
            text: 'On branch main\nnothing to commit, working tree clean',
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
    expect(result.stats.kept).toBe(1);
  });
});

describe('Claude Code Hook SemIf Provider', () => {
  it('resolves hook config for provider semif with default url', () => {
    const config = resolveHookConfig({ provider: 'semif' });
    expect(config.provider).toBe('semif');
    expect(config.baseUrl).toBe('http://127.0.0.1:8765/v1/systemone');
  });

  it('compactSession succeeds with provider semif without manual API key', async () => {
    const mockHookFetch: HookFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: JSON.stringify({
        model: 'Qwen/Qwen3.5-4B',
        answers: {
          call_t1: { type: 'noul', noul: 0.9 },
          result_t1: { type: 'noul', noul: 0.9 },
        },
      }),
    });

    const config = resolveHookConfig({ provider: 'semif' });
    const sessionMessages = [
      { role: 'user' as const, text: 'Hello', toolUses: [] },
      {
        role: 'assistant' as const,
        text: 'Running',
        toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: {} }],
      },
      {
        role: 'user' as const,
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 't1', text: 'Result content' }],
      },
    ];

    const { result, messages } = await compactSession(sessionMessages, config, mockHookFetch);
    expect(result).toBeDefined();
    expect(messages.length).toBe(3);
  });
});
