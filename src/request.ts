import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Answers come in two shapes: the native map (`{name: {type:'noul', noul}}`)
 * that System One and local servers speak, and the array of named answers
 * (`[{type:'predicate', name, probability}]`) that OpenCode's decision route
 * returns. Both become the map shape the rest of the library reads.
 */
export function normalizeAnswers(raw: unknown): Record<string, JevAnswer> {
  if (!Array.isArray(raw)) {
    const map = asRecord(raw);
    if (!map) throw new Error('Jev response is missing answers');
    return map as Record<string, JevAnswer>;
  }
  const answers: Record<string, JevAnswer> = {};
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) throw new Error('Jev returned a malformed answer');
    const name = record.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('Jev returned an answer without a name');
    }
    const type = record.type;
    if (type === 'error') {
      const reason =
        typeof record.reason === 'string'
          ? record.reason
          : typeof record.message === 'string'
            ? record.message
            : 'unspecified';
      throw new Error(`Jev could not answer ${name}: ${reason}`);
    }
    if (type === 'predicate') {
      answers[name] = { type: 'noul', noul: record.probability as number };
      continue;
    }
    answers[name] = record as unknown as JevAnswer;
  }
  return answers;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    /** Extra headers, such as OpenCode's `x-opencode-session`. */
    headers?: Record<string, string>;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...params.headers,
  };
  if (params.apiKey) headers.authorization = `Bearer ${params.apiKey}`;
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers,
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
  const body = asRecord(parsed);
  if (!body) throw new Error('Jev response is missing answers');
  if (body.answers === undefined) {
    const inner = asRecord(body.data);
    if (!inner || inner.answers === undefined) {
      throw new Error('Jev response is missing answers');
    }
    return { ...(inner as object), answers: normalizeAnswers(inner.answers) } as JevResponse;
  }
  return { ...(body as object), answers: normalizeAnswers(body.answers) } as JevResponse;
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
