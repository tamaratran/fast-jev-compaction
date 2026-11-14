import { JevClient, type JevClientOptions } from './client.js';
import { compact, compactSafe } from './compact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

/** `compact` with a `JevClient` built from the options (key from `TYPESAFE_API_KEY` by default). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}

/** Like `compactMessages` but returns the original transcript on any failure. */
export function compactMessagesSafe(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compactSafe(messages, new JevClient(options), options);
}
