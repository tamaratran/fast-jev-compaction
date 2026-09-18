import { buildJevRequest, KEY_ENV_VARS, MISSING_KEY_MESSAGE, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

/** The first non-empty key among `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY`. */
export function apiKeyFromEnv(env: Record<string, string | undefined> = process.env): string {
  for (const name of KEY_ENV_VARS) {
    const value = env[name];
    if (value) return value;
  }
  return '';
}

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`, then `process.env.OPENROUTER_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest` (`~typesafe/jev-latest` on OpenRouter). */
  model?: string;
  /** Full endpoint URL. Defaults to System One, or OpenRouter's Decisions endpoint for an OpenRouter key. */
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
    this.apiKey = options.apiKey ?? apiKeyFromEnv();
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(MISSING_KEY_MESSAGE);
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
