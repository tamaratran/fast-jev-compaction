import { LayaClient, type LayaClientOptions } from './client.js';
import { compact } from './compact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & LayaClientOptions;

/** `compact` with a `LayaClient` built from the options (local `laya-serve` by default). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new LayaClient(options), options);
}
