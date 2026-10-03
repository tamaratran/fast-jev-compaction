import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import { OPENROUTER_DECISIONS_URL, OPENROUTER_JEV_MODEL } from './openrouter.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

/** `compact` with a `JevClient` built from the options (key from `TYPESAFE_API_KEY` by default). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}

export interface JevViaOpenRouterOptions extends Omit<JevClientOptions, 'baseUrl'> {
  /** OpenRouter model slug. Defaults to `typesafe/jev-1.13`. */
  model?: string;
}

/**
 * A `JevClient` pointed at OpenRouter's decisions endpoint, reaching real Jev
 * with an OpenRouter key. `apiKey` defaults to `OPENROUTER_API_KEY`.
 */
export function jevViaOpenRouter(options: JevViaOpenRouterOptions = {}): JevClient {
  return new JevClient({
    apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY,
    model: options.model ?? OPENROUTER_JEV_MODEL,
    baseUrl: OPENROUTER_DECISIONS_URL,
    fetch: options.fetch,
  });
}

/** `compactMessages` against real Jev over OpenRouter (key from `OPENROUTER_API_KEY`). */
export function compactMessagesViaOpenRouter(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(
    messages,
    jevViaOpenRouter({ apiKey: options.apiKey, model: options.model, fetch: options.fetch }),
    options,
  );
}
