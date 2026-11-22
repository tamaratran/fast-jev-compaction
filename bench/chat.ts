/**
 * A small OpenAI-compatible chat client for the bench's summary baseline and
 * for the "can the model still answer" check. It talks to OpenCode Go, whose
 * route needs the session header, and falls back to any base/model pair.
 */
import { opencodeAuthKey } from '../src/opencode/auth.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  session?: string;
  maxTokens?: number;
  temperature?: number;
}

export const DEFAULT_CHAT_BASE = 'https://opencode.ai/inference/go/openai/v1';
export const DEFAULT_CHAT_MODEL = 'deepseek-v4.1-flash';

export async function chat(
  messages: readonly ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const baseUrl = options.baseUrl ?? process.env.FAST_JEV_CHAT_BASE ?? DEFAULT_CHAT_BASE;
  const model = options.model ?? process.env.FAST_JEV_CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
  const key =
    options.apiKey ??
    process.env.OPENCODE_API_KEY ??
    process.env.FAST_JEV_CHAT_KEY ??
    (await opencodeAuthKey());
  if (!key) throw new Error('no chat key: connect a provider or set OPENCODE_API_KEY');
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  if (/\/inference\/go\//u.test(baseUrl)) {
    headers['x-opencode-session'] = options.session ?? `ses_bench_${Date.now().toString(36)}`;
  }
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens ?? 1500,
      temperature: options.temperature ?? 0,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`chat failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text) as {
    choices?: { message?: { content?: string } }[];
  };
  return parsed.choices?.[0]?.message?.content ?? '';
}
