import { buildLocalRequest, parseLocalResponse } from './local.js';
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
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
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

export interface LocalClientOptions {
  /** Defaults to `http://localhost:11434`. */
  baseUrl?: string;
  /** Defaults to `qwen2.5:3b`. */
  model?: string;
  /** Context window for the model; Ollama's default is too small for most states. */
  numCtx?: number;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Answers Jev questions with a local Ollama model: free and offline, but slower and rougher. */
export class LocalClient implements JevAsker {
  constructor(private readonly options: LocalClientOptions = {}) {}

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const request = buildLocalRequest(this.options, state, questions);
    const response = await (this.options.fetch ?? fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseLocalResponse(response.status, response.ok, await response.text(), questions);
  }
}
