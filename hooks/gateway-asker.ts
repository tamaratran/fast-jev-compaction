import type { HookFetch } from './fast-jev.js';
import type {
  JevAnswer,
  JevAsker,
  JevQuestion,
  JevQuestions,
  JevResponse,
  JevState,
} from '../src/types.js';

export const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
export const GATEWAY_MODEL = 'typesafe-ai/jev';
/**
 * The Gateway rejects a request without this header with a 400
 * "Unsupported gateway protocol version" before it reads the body. The `ai`
 * package sends it from the provider layer rather than the model layer, so it
 * is easy to miss when reading only the evaluation-model source.
 */
export const GATEWAY_PROTOCOL_VERSION = '0.0.1';

/** One answer of a Gateway evaluation response. */
export type GatewayAnswer =
  | { type: 'choice'; choice: string; probabilities?: Record<string, number> }
  | { type: 'score'; score: number; probabilities?: Record<string, number> }
  | { type: 'boolean'; probability: number };

/**
 * Jev over the Vercel AI Gateway instead of TypeSafe's System One endpoint.
 * The hook speaks both; `jevAsker` in `fast-jev.ts` is the System One side.
 *
 * The two speak the same primitive under different names: a System One `noul`
 * question is a Gateway `boolean` question, and the probability comes back as
 * `noul` from TypeSafe and as `probability` from the Gateway. The `choice` and
 * `score` shapes are already identical, so this renames the boolean case in
 * each direction and leaves everything else untouched.
 *
 * This speaks the Gateway's HTTP surface directly rather than through the `ai`
 * package: a hooks module may only import its own files and `claude-code`, and
 * going over `$.http.fetch` keeps the request inside the engine's transport.
 */
export function gatewayAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string = GATEWAY_MODEL,
  url: string = GATEWAY_URL,
): JevAsker {
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY is not configured');

  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'ai-gateway-protocol-version': GATEWAY_PROTOCOL_VERSION,
          'ai-gateway-auth-method': 'api-key',
          'ai-evaluation-model-specification-version': '4',
          'ai-model-id': model,
        },
        body: JSON.stringify({ state, questions: toGatewayQuestions(questions) }),
      });
      return parseGatewayResponse(model, response.status, response.ok, response.text);
    },
  };
}

/** Validates a Gateway evaluation body and restores the `noul` naming. */
export function parseGatewayResponse(
  model: string,
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
  const answers = parsed.answers as Record<string, GatewayAnswer>;
  return { model, answers: toNoulAnswers(answers) };
}

/** `noul` is the System One name for what the Gateway spells `boolean`. */
function toGatewayQuestions(questions: JevQuestions): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => [name, toGatewayQuestion(question)]),
  );
}

export function toGatewayQuestion(question: JevQuestion): unknown {
  if (question.type !== 'noul') return question;
  const { type: _noul, ...rest } = question;
  return { ...rest, type: 'boolean' };
}

function toNoulAnswers(answers: Record<string, GatewayAnswer>): Record<string, JevAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => [name, toNoulAnswer(answer)]),
  );
}

/** Turns `{ type: 'boolean', probability }` back into the `{ noul }` the library reads. */
export function toNoulAnswer(answer: GatewayAnswer): JevAnswer {
  if (answer && answer.type === 'boolean' && Number.isFinite(answer.probability)) {
    return { type: 'noul', noul: answer.probability };
  }
  return answer as JevAnswer;
}
