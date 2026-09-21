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
  /** Maximum time for one request, including the response body. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Optional caller cancellation signal. */
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
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 15_000;
    this.signal = options.signal;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort(this.signal?.reason);
    if (this.signal?.aborted) controller.abort(this.signal.reason);
    this.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.signal?.aborted) throw new Error('Jev request was cancelled');
        throw new Error(`Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.signal?.removeEventListener('abort', abort);
    }
  }
}
