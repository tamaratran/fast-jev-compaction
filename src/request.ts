import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

const ENDPOINT_PATHS = ['/v1/systemone', '/alpha/decisions'];

/**
 * Picks the System One endpoint from optional overrides; `undefined` means
 * the default TypeSafe endpoint.
 *
 * - `jevBaseUrl` (`JEV_BASE_URL`) is a full endpoint URL and is used as is.
 * - `typesafeBaseUrl` (`TYPESAFE_BASE_URL`) is an API base, as the TypeSafe
 *   SDKs take it; `/v1/systemone` is appended unless the URL already ends in
 *   an endpoint path.
 * - Otherwise an OpenRouter key (`sk-or-`) selects the OpenRouter endpoint.
 */
export function resolveSystemOneUrl(params: {
  jevBaseUrl?: string;
  typesafeBaseUrl?: string;
  apiKey?: string;
}): string | undefined {
  const jev = params.jevBaseUrl?.trim();
  if (jev) return jev;
  const base = params.typesafeBaseUrl?.trim().replace(/\/+$/, '');
  if (base) {
    return ENDPOINT_PATHS.some((path) => base.endsWith(path)) ? base : `${base}/v1/systemone`;
  }
  if (params.apiKey?.startsWith('sk-or-')) return OPENROUTER_SYSTEM_ONE_URL;
  return undefined;
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
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
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
