import { ChatJevAsker } from './chat-asker.js';
import { compact } from './compact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & {
  baseUrl?: string;
  model?: string;
};

/** `compact` with a `ChatJevAsker` that talks to a local Ollama instance. */
export async function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  const asker = new ChatJevAsker({
    baseUrl: options.baseUrl ?? 'http://localhost:11434',
    model: options.model ?? 'kaineone/metzger:0.8b',
    fetch: async (url, init) => {
      const resp = await globalThis.fetch(url, init);
      return { status: resp.status, ok: resp.ok, text: await resp.text() };
    },
  });
  return compact(messages, asker, options);
}
