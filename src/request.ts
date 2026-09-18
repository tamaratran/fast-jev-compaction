import type {
  JevAnswer,
  JevProvider,
  JevQuestion,
  JevQuestions,
  JevResponse,
  JevState,
} from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/** Gateway evaluation route (`/v4/ai/evaluation-model`), not chat completions. */
export const AI_GATEWAY_EVALUATION_URL =
  'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
export const DEFAULT_GATEWAY_MODEL = 'typesafe-ai/jev';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface JevRequestParams {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  provider?: JevProvider;
}

/** Parses a provider option; aliases `gateway` and `ai-gateway`. */
export function parseJevProvider(value: unknown): JevProvider | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error('Unknown Jev provider (use typesafe or vercel-ai-gateway)');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'typesafe') return 'typesafe';
  if (
    normalized === 'vercel-ai-gateway' ||
    normalized === 'gateway' ||
    normalized === 'ai-gateway'
  ) {
    return 'vercel-ai-gateway';
  }
  throw new Error(`Unknown Jev provider '${value}' (use typesafe or vercel-ai-gateway)`);
}

export function missingJevKeyError(provider: JevProvider): string {
  return provider === 'vercel-ai-gateway'
    ? 'AI_GATEWAY_API_KEY is not configured'
    : 'TYPESAFE_API_KEY is not configured';
}

/**
 * Gateway model ids are `creator/model`. TypeSafe's `jev-latest` alias is
 * `typesafe-ai/jev` on AI Gateway; other unprefixed names get `typesafe-ai/`.
 */
export function resolveGatewayModel(model?: string): string {
  if (
    !model ||
    model === 'jev' ||
    model === 'jev-latest' ||
    model === 'typesafe-ai/jev-latest'
  ) {
    return DEFAULT_GATEWAY_MODEL;
  }
  return model.includes('/') ? model : `typesafe-ai/${model}`;
}

/** Vercel AI Gateway keys are issued with a `vck_` prefix. */
export function looksLikeGatewayKey(apiKey: string): boolean {
  return apiKey.startsWith('vck_');
}

/**
 * AI Gateway evaluation accepts `choice` | `score` | `boolean` only. TypeSafe
 * `noul` is the same primitive as `boolean` (P(true) in `[0, 1]`).
 */
export function toGatewayQuestions(questions: JevQuestions): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, toGatewayQuestion(question)]),
  );
}

function toGatewayQuestion(question: JevQuestion): unknown {
  if (question.type !== 'noul') return question;
  const mapped: Record<string, unknown> = {
    type: 'boolean',
    instructions: question.instructions,
  };
  if (question.criteria) mapped.criteria = question.criteria;
  return mapped;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: JevRequestParams,
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  if (params.provider === 'vercel-ai-gateway') {
    const model = resolveGatewayModel(params.model);
    return {
      url: params.baseUrl ?? AI_GATEWAY_EVALUATION_URL,
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        'content-type': 'application/json',
        'ai-evaluation-model-specification-version': '4',
        'ai-model-id': model,
        'ai-gateway-protocol-version': '0.0.1',
        'ai-gateway-auth-method': 'api-key',
      },
      body: JSON.stringify({
        state,
        questions: toGatewayQuestions(questions),
      }),
    };
  }
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

/** The keep-probability of one answer (`noul` or Gateway `boolean`). */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const value = noulProbability(answers[name]);
  if (value === undefined) throw new Error(`Invalid Jev answer for ${name}`);
  return value;
}

function noulProbability(answer: JevAnswer | undefined): number | undefined {
  if (!answer) return undefined;
  if ('noul' in answer && typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    return answer.noul;
  }
  if (
    'probability' in answer &&
    typeof answer.probability === 'number' &&
    Number.isFinite(answer.probability) &&
    !('choice' in answer) &&
    !('score' in answer)
  ) {
    return answer.probability;
  }
  return undefined;
}
