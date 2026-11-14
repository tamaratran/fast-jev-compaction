import { buildLayaRequest, parseLayaResponse } from './request.js';
import type { LayaAsker, LayaQuestions, LayaResponse, LayaState } from './types.js';

export interface LayaClientOptions {
  /** Defaults to `laya`, the English checkpoint. */
  model?: string;
  /** Defaults to the local `laya-serve` endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks a `laya-serve` instance over HTTP with the global `fetch` (or an injected one). */
export class LayaClient implements LayaAsker {
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: LayaClientOptions = {}) {
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: LayaState, questions: LayaQuestions): Promise<LayaResponse> {
    const request = buildLayaRequest(
      { model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseLayaResponse(response.status, response.ok, await response.text());
  }
}
