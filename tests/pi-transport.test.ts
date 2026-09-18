import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevTransport } from '../pi/transport.js';

const questions = {
  old_call: { type: 'noul' as const, instructions: 'Does this old tool call still matter?' },
  old_result: { type: 'noul' as const, instructions: 'Does this old tool output still matter?' },
};

function answerResponse(init: RequestInit | undefined, answer = 0.4): Response {
  const body = JSON.parse(String(init?.body ?? '{}')) as { questions: Record<string, unknown> };
  return new Response(JSON.stringify({
    answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: answer }])),
  }), { status: 200 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Pi Jev transport', () => {
  it('sends all supplied questions through the System One request and shares its signal', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => answerResponse(init));
    const transport = createJevTransport('test-key', 1_000, undefined, fetcher as typeof fetch);

    const result = await transport.asker.ask({ history: ['one'] }, questions);

    expect(result.answers).toEqual({
      old_call: { type: 'noul', noul: 0.4 },
      old_result: { type: 'noul', noul: 0.4 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer test-key', 'content-type': 'application/json' }),
      signal: transport.signal,
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      model: 'jev-latest',
      state: { history: ['one'] },
      questions,
    });
    transport.dispose();
  });

  it('rejects failed, malformed, incomplete, and out-of-range responses without exposing HTTP bodies', async () => {
    const failures: Array<{ response: Response; pattern: RegExp }> = [
      { response: new Response('server only: supplied transcript', { status: 500 }), pattern: /Jev request failed \(500\)$/ },
      { response: new Response('not json', { status: 200 }), pattern: /malformed JSON/ },
      { response: new Response(JSON.stringify({ answers: { old_call: { noul: 0.4 } } }), { status: 200 }), pattern: /old_result/ },
      { response: new Response(JSON.stringify({ answers: {
        old_call: { type: 'noul', noul: -0.01 },
        old_result: { type: 'noul', noul: 1.01 },
      } }), { status: 200 }), pattern: /old_call/ },
    ];

    for (const { response, pattern } of failures) {
      const fetcher = vi.fn(async () => response);
      const transport = createJevTransport('test-key', 1_000, undefined, fetcher as typeof fetch);
      await expect(transport.asker.ask('state', questions)).rejects.toThrow(pattern);
      transport.dispose();
    }

    const httpFetcher = vi.fn(async () => new Response('server only: supplied transcript', { status: 500 }));
    const transport = createJevTransport('test-key', 1_000, undefined, httpFetcher as typeof fetch);
    await expect(transport.asker.ask('state', questions)).rejects.not.toThrow('server only');
    transport.dispose();
  });

  it('uses one deadline for a response body, even when fetch itself resolves first', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>(() => undefined),
    }) as Response);
    const transport = createJevTransport('test-key', 25, undefined, fetcher as typeof fetch);
    const pending = transport.asker.ask('state', questions);
    const assertion = expect(pending).rejects.toThrow(/Jev deadline exceeded/);

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(transport.signal.aborted).toBe(true);
    transport.dispose();
  });

  it('allows the native no-deadline default and a configured Jev model', async () => {
    vi.useFakeTimers();
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveResponse = resolve; }));
    const transport = createJevTransport('test-key', 0, undefined, fetcher as typeof fetch, 'jev-custom');
    const pending = transport.asker.ask('state', questions);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.signal.aborted).toBe(false);
    const init = fetcher.mock.calls[0]![1];
    expect(JSON.parse(String(init?.body)).model).toBe('jev-custom');
    resolveResponse(answerResponse(init));
    await expect(pending).resolves.toHaveProperty('answers.old_call.noul', 0.4);
    transport.dispose();
  });

  it('propagates parent and explicit cancellation to in-flight requests', async () => {
    const parent = new AbortController();
    const fetcher = vi.fn((_url: string | URL | Request, _init?: RequestInit) => new Promise<Response>(() => undefined));
    const parentTransport = createJevTransport('test-key', 1_000, parent.signal, fetcher as typeof fetch);
    const parentPending = parentTransport.asker.ask('state', questions);
    parent.abort(new Error('caller stopped'));
    await expect(parentPending).rejects.toThrow(/Jev request cancelled/);
    expect(parentTransport.signal.aborted).toBe(true);
    parentTransport.dispose();

    const explicitTransport = createJevTransport('test-key', 1_000, undefined, fetcher as typeof fetch);
    const explicitPending = explicitTransport.asker.ask('state', questions);
    explicitTransport.abort();
    await expect(explicitPending).rejects.toThrow(/Jev request cancelled/);
    explicitTransport.dispose();
  });
});
