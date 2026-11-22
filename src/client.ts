import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. Point it at a local server or OpenCode's route. */
  baseUrl?: string;
  /** Extra request headers, such as OpenCode's `x-opencode-session`. */
  headers?: Record<string, string>;
  /** Refuse a call without a key. Local systemone servers need none; defaults to true. */
  requireKey?: boolean;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly headers: Record<string, string> | undefined;
  private readonly requireKey: boolean;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
    this.requireKey = options.requireKey ?? true;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (this.requireKey && !this.apiKey) {
      throw new Error(
        'no Jev API key is configured (TYPESAFE_API_KEY, JEV_API_KEY or the transport key)',
      );
    }
    const request = buildJevRequest(
      {
        apiKey: this.apiKey,
        model: this.model,
        baseUrl: this.baseUrl,
        headers: this.headers,
      },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
