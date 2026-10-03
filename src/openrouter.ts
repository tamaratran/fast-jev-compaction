/**
 * OpenRouter exposes real Jev as an unlisted "decisions" model, on a dedicated
 * endpoint that speaks the same `{model, state, questions}` → `{answers}`
 * protocol as TypeSafe's System One API. So the native `JevClient` reaches it
 * with only a base URL and model change — no separate transport is needed.
 *
 * This module stays free of `fetch`/`process`/`JevClient` so it can be imported
 * by the Claude Code hook build (which has no Node or DOM types). The
 * `JevClient` convenience lives in `messages.ts`.
 */
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';

/** True for an OpenRouter API key (`sk-or-...`), used to pick the endpoint. */
export function isOpenRouterKey(apiKey: string | undefined): boolean {
  return typeof apiKey === 'string' && apiKey.startsWith('sk-or-');
}
