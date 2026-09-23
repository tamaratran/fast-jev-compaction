import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export const DEFAULT_LAYA_URL = 'http://localhost:8000/v1/systemone';

export interface LayaClientOptions {
  /** Defaults to `process.env.LAYA_BASE_URL`, `process.env.TYPESAFE_BASE_URL`, or `http://localhost:8000/v1/systemone`. */
  baseUrl?: string;
  /** Model override name (e.g. `english`, `multilingual`, `typed-decisions`). */
  model?: string;
  /** Optional API key for auth if Laya server is behind a proxy. Defaults to 'laya-local'. */
  apiKey?: string;
  /** Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Asks a local or remote Laya decision server implementing the Jev API endpoint contract.
 */
export class LayaClient implements JevAsker {
  private readonly baseUrl: string;
  private readonly model?: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(options: LayaClientOptions = {}) {
    this.baseUrl =
      options.baseUrl ??
      process.env.LAYA_BASE_URL ??
      process.env.TYPESAFE_BASE_URL ??
      DEFAULT_LAYA_URL;
    this.model = options.model;
    this.apiKey = options.apiKey ?? process.env.LAYA_API_KEY ?? 'laya-local';
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
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
