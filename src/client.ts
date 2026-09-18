import {
  buildJevRequest,
  looksLikeGatewayKey,
  missingJevKeyError,
  parseJevProvider,
  parseJevResponse,
} from './request.js';
import type { JevAsker, JevProvider, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /**
   * Defaults to `TYPESAFE_API_KEY`, or `AI_GATEWAY_API_KEY` when the provider
   * is `vercel-ai-gateway`.
   */
  apiKey?: string;
  /** Defaults to `jev-latest` (TypeSafe) or `typesafe-ai/jev` (Gateway). */
  model?: string;
  /** Defaults to the System One or AI Gateway evaluation endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * `typesafe` (default) or `vercel-ai-gateway`. When omitted, TypeSafe is
   * used if `apiKey` or `TYPESAFE_API_KEY` is set; otherwise a present
   * `AI_GATEWAY_API_KEY` selects the Gateway.
   */
  provider?: JevProvider | 'gateway' | 'ai-gateway';
}

export interface JevTransport {
  provider: JevProvider;
  apiKey: string;
}

/** Resolves provider and key without contacting the network. */
export function resolveJevTransport(options: JevClientOptions = {}): JevTransport {
  const explicit = parseJevProvider(options.provider);
  if (explicit) {
    const envKey =
      explicit === 'vercel-ai-gateway'
        ? process.env.AI_GATEWAY_API_KEY
        : process.env.TYPESAFE_API_KEY;
    return { provider: explicit, apiKey: options.apiKey ?? envKey ?? '' };
  }
  if (options.apiKey !== undefined) {
    return {
      provider: looksLikeGatewayKey(options.apiKey) ? 'vercel-ai-gateway' : 'typesafe',
      apiKey: options.apiKey,
    };
  }
  if (process.env.TYPESAFE_API_KEY) {
    return { provider: 'typesafe', apiKey: process.env.TYPESAFE_API_KEY };
  }
  if (process.env.AI_GATEWAY_API_KEY) {
    return { provider: 'vercel-ai-gateway', apiKey: process.env.AI_GATEWAY_API_KEY };
  }
  return { provider: 'typesafe', apiKey: '' };
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly provider: JevProvider;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    const transport = resolveJevTransport(options);
    this.provider = transport.provider;
    this.apiKey = transport.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(missingJevKeyError(this.provider));
    const request = buildJevRequest(
      {
        apiKey: this.apiKey,
        model: this.model,
        baseUrl: this.baseUrl,
        provider: this.provider,
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
