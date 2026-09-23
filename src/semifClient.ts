import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAnswer, JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export const DEFAULT_SEMIF_URL = 'http://127.0.0.1:8765/v1/systemone';

export interface SemIfClientOptions {
  /** Defaults to `process.env.SEMIF_BASE_URL` or `http://127.0.0.1:8765/v1/systemone`. */
  baseUrl?: string;
  /** Model override (defaults to server's loaded model, e.g. `Qwen/Qwen3.5-4B`). */
  model?: string;
  /** Optional auth token if server is behind reverse proxy. Defaults to `semif-local`. */
  apiKey?: string;
  /** Injected fetch function; defaults to global `fetch`. */
  fetch?: typeof fetch;
}

interface SemIfDecideResponse {
  id: string;
  decision: string;
  confidence: number;
  probabilities: Record<string, number>;
  [key: string]: unknown;
}

/**
 * Asks a local or remote SemIf semantic decision server implementing
 * either the native `/v1/systemone` contract or the standard `/v1/decide` endpoint.
 */
export class SemIfClient implements JevAsker {
  private readonly baseUrl: string;
  private readonly model?: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(options: SemIfClientOptions = {}) {
    const rawUrl = options.baseUrl ?? process.env.SEMIF_BASE_URL ?? DEFAULT_SEMIF_URL;
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey ?? process.env.SEMIF_API_KEY ?? 'semif-local';
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const targetUrl = this.baseUrl.endsWith('/v1/systemone')
      ? this.baseUrl
      : `${this.baseUrl}/v1/systemone`;

    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: targetUrl },
      state,
      questions,
    );

    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    if (response.status === 404) {
      // Fallback for servers only exposing /v1/decide
      return this.fallbackToDecide(state, questions);
    }

    return parseJevResponse(response.status, response.ok, await response.text());
  }

  /**
   * Fallback for earlier SemIf servers that only implement `POST /v1/decide`.
   */
  private async fallbackToDecide(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const rootUrl = this.baseUrl.replace(/\/v1\/systemone$/, '').replace(/\/v1\/decide$/, '');
    const decideUrl = `${rootUrl}/v1/decide`;
    const answers: Record<string, JevAnswer> = {};

    for (const [key, q] of Object.entries(questions)) {
      if (q.type === 'noul') {
        const payload = {
          state,
          question: q.instructions,
          options: [
            { id: 'yes', description: 'Yes, true' },
            { id: 'no', description: 'No, false' },
          ],
        };
        const res = await this.postJson<SemIfDecideResponse>(decideUrl, payload);
        answers[key] = {
          type: 'noul',
          noul: res.probabilities['yes'] ?? 0.5,
        };
      } else if (q.type === 'choice') {
        const criteria = q.criteria ?? {};
        const options = Object.entries(criteria).map(([id, desc]) => ({
          id,
          description: desc ?? id,
        }));
        const payload = {
          state,
          question: q.instructions,
          options,
        };
        const res = await this.postJson<SemIfDecideResponse>(decideUrl, payload);
        answers[key] = {
          type: 'choice',
          choice: res.decision,
          confidence: res.confidence,
          probabilities: res.probabilities,
        };
      } else if (q.type === 'score') {
        const criteria = q.criteria ?? [];
        const options = criteria.map((desc, i) => ({
          id: String(i),
          description: desc,
        }));
        const payload = {
          state,
          question: q.instructions,
          options,
        };
        const res = await this.postJson<SemIfDecideResponse>(decideUrl, payload);
        const score = Object.entries(res.probabilities).reduce(
          (acc, [idx, prob]) => acc + Number(idx) * prob,
          0,
        );
        answers[key] = {
          type: 'score',
          score,
          confidence: res.confidence,
          probabilities: res.probabilities,
        };
      }
    }

    return {
      model: this.model ?? 'semif-qwen3.5',
      answers,
    };
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const res = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`SemIf decide request failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}
