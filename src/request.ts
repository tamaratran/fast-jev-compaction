import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

/** Environment variables holding a key, in the order they are tried. */
export const KEY_ENV_VARS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'] as const;
export const MISSING_KEY_MESSAGE = 'TYPESAFE_API_KEY or OPENROUTER_API_KEY is not configured';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/**
 * OpenRouter's Decisions endpoint. It takes the same body as System One and
 * returns the same answers, billed to the OpenRouter account. The path is
 * still on OpenRouter's alpha prefix and may move.
 */
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** The Jev alias on OpenRouter; always the newest Jev. */
export const OPENROUTER_MODEL = '~typesafe/jev-latest';

export type JevProvider = 'typesafe' | 'openrouter';

export interface JevEndpoint {
  provider: JevProvider;
  url: string;
  model: string;
}

/** OpenRouter keys start with `sk-or-`; TypeSafe keys do not. */
export function isOpenRouterKey(apiKey: string): boolean {
  return apiKey.startsWith('sk-or-');
}

function isOpenRouterUrl(url: string): boolean {
  return /^https?:\/\/([^/]*\.)?openrouter\.ai(\/|$)/i.test(url);
}

/**
 * Picks the endpoint and the model name to send. An explicit `baseUrl` wins;
 * without one an OpenRouter key goes to OpenRouter's Decisions endpoint and
 * anything else to System One. On OpenRouter a bare TypeSafe model name is
 * mapped to OpenRouter's naming: `jev-latest` becomes `~typesafe/jev-latest`
 * and `jev-1.13` becomes `typesafe/jev-1.13`; names with a slash pass through.
 */
export function resolveEndpoint(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): JevEndpoint {
  const url =
    params.baseUrl ?? (isOpenRouterKey(params.apiKey) ? OPENROUTER_DECISIONS_URL : SYSTEM_ONE_URL);
  const provider: JevProvider = isOpenRouterUrl(url) ? 'openrouter' : 'typesafe';
  let model = params.model ?? DEFAULT_MODEL;
  if (provider === 'openrouter' && !model.includes('/')) {
    model = model === DEFAULT_MODEL ? OPENROUTER_MODEL : `typesafe/${model}`;
  }
  return { provider, url, model };
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const endpoint = resolveEndpoint(params);
  return {
    url: endpoint.url,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: endpoint.model,
      state,
      questions,
    }),
  };
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
