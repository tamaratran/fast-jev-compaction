import type { LayaAnswer, LayaQuestions, LayaResponse, LayaState } from './types.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1/systemone';
export const DEFAULT_MODEL = 'laya';

export interface LayaRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one `laya-serve` call, for any fetch-like transport. */
export function buildLayaRequest(
  params: {
    model?: string;
    baseUrl?: string;
  },
  state: LayaState,
  questions: LayaQuestions,
): LayaRequest {
  return {
    url: params.baseUrl || DEFAULT_BASE_URL,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: params.model || DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** Validates a response body; throws on anything but an `answers` object. */
export function parseLayaResponse(
  status: number,
  ok: boolean,
  text: string,
): LayaResponse {
  if (!ok) {
    throw new Error(`Laya request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Laya returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Laya response is missing answers');
  }
  return parsed as LayaResponse;
}

/**
 * The probability of each of `options` in one `choice` answer; throws when the
 * answer is missing or any option has no finite probability.
 */
export function choiceProbabilities<K extends string>(
  answers: Record<string, LayaAnswer>,
  name: string,
  options: readonly K[],
): Record<K, number> {
  const answer = answers[name];
  const probabilities = answer && 'probabilities' in answer ? answer.probabilities : undefined;
  const picked = {} as Record<K, number>;
  for (const option of options) {
    const value = probabilities?.[option];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Invalid Laya answer for ${name}`);
    }
    picked[option] = value;
  }
  return picked;
}

/** Whether `laya-serve` reported cutting the state to fit the checkpoint window. */
export function wasTruncated(response: LayaResponse): boolean {
  const flag = response.usage?.truncated;
  return flag === true || (typeof flag === 'number' && flag > 0);
}
