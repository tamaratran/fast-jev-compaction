import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Deadline for each request, including its response body. Default 15000 ms. */
  timeoutMs?: number;
  /** Optional caller cancellation, shared by this client's requests. */
  signal?: AbortSignal;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new RangeError('timeoutMs must be an integer between 1 and 2147483647');
    }
    this.signal = options.signal;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    if (this.signal?.aborted) throw this.signal.reason ?? new Error('Jev request aborted');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const reason = this.signal?.reason ?? new Error('Jev request aborted');
        controller.abort(reason);
        reject(reason);
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new Error(`Jev request timed out after ${this.timeoutMs} ms`);
        error.name = 'TimeoutError';
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
      if (this.signal?.aborted) onAbort();
    });
    try {
      if (controller.signal.aborted) return await cancelled;
      const response = await Promise.race([this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      }), cancelled]);
      const text = await Promise.race([response.text(), cancelled]);
      return parseJevResponse(response.status, response.ok, text);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort!);
    }
  }
}
