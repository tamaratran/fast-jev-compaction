import type { JevQuestions, JevResponse, JevState } from './types.js';

export const OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_LOCAL_MODEL = 'qwen2.5:3b';

const SYSTEM_PROMPT =
  'You judge which parts of a coding assistant conversation still matter. You get the conversation as `state` and a set of named statements as `questions`. For every statement, answer with the probability (0 to 1) that it is true. Answer with a JSON object mapping each question name to its probability, nothing else.';

export interface LocalRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/**
 * The HTTP request asking a local Ollama model the Jev questions. A JSON
 * schema forces one probability per question name.
 */
export function buildLocalRequest(
  params: { baseUrl?: string; model?: string; numCtx?: number },
  state: JevState,
  questions: JevQuestions,
): LocalRequest {
  const names = Object.keys(questions);
  const options: Record<string, number> = { temperature: 0 };
  if (params.numCtx) options['num_ctx'] = params.numCtx;
  return {
    url: `${params.baseUrl ?? OLLAMA_URL}/api/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_LOCAL_MODEL,
      stream: false,
      format: {
        type: 'object',
        properties: Object.fromEntries(names.map((name) => [name, { type: 'number' }])),
        required: names,
      },
      options,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            state,
            questions: Object.fromEntries(
              Object.entries(questions).map(([name, question]) => [name, question.instructions]),
            ),
          }),
        },
      ],
    }),
  };
}

/** Turns an Ollama chat response into Jev `noul` answers; throws on anything unusable. */
export function parseLocalResponse(
  status: number,
  ok: boolean,
  text: string,
  questions: JevQuestions,
): JevResponse {
  if (!ok) throw new Error(`local model request failed (${status}): ${text.slice(0, 200)}`);
  let probabilities: Record<string, unknown>;
  let usage: JevResponse['usage'];
  try {
    const body = JSON.parse(text) as {
      model?: string;
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    probabilities = JSON.parse(body.message?.content ?? '') as Record<string, unknown>;
    usage = { input_tokens: body.prompt_eval_count, output_tokens: body.eval_count };
  } catch {
    throw new Error('local model returned malformed JSON');
  }
  const answers: JevResponse['answers'] = {};
  for (const name of Object.keys(questions)) {
    const value = probabilities?.[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`local model gave no probability for ${name}`);
    }
    answers[name] = { type: 'noul', noul: Math.min(1, Math.max(0, value)) };
  }
  return { answers, usage };
}
