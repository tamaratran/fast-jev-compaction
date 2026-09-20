/**
 * OpenCode 1.x adapter (`@opencode-ai/plugin` hooks API). OpenCode 1 has no
 * hook that replaces a compaction, so this adapter prunes continuously: before
 * every model request `experimental.chat.messages.transform` hands it the
 * session's messages, it drops or truncates the tool parts Jev judged stale,
 * and the host converts the rest. Kept context stays verbatim; the built-in
 * summary only runs if the pruned history still overflows.
 */
import type { Hooks, Plugin } from '@opencode-ai/plugin';

import { truncatedResultText } from '../compact.js';
import type { CallAction, Message, ToolResult, ToolUse } from '../types.js';
import {
  describeOutcome,
  describeProvider,
  jevClient,
  missingKey,
  readPrunerOptions,
  SessionPruner,
} from './pruner.js';

type Transform = NonNullable<Hooks['experimental.chat.messages.transform']>;
/** One session message as the transform hook sees it: `info` plus its parts. */
export type SessionMessage = Parameters<Transform>[1]['messages'][number];
export type SessionPart = SessionMessage['parts'][number];
type ToolPart = Extract<SessionPart, { type: 'tool' }>;

export const CLEARED_OUTPUT = '[Old tool result content cleared]';

export interface Transcript {
  messages: Message[];
  /** Index of the session message each transcript message came from. */
  origins: number[];
}

function toolOutcome(part: ToolPart): { text: string; isError: boolean } | undefined {
  if (part.state.status === 'completed') {
    return { text: part.state.time.compacted ? CLEARED_OUTPUT : part.state.output, isError: false };
  }
  if (part.state.status === 'error') return { text: part.state.error, isError: true };
  return undefined;
}

function userText(parts: readonly SessionPart[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && !part.ignored && part.text) lines.push(part.text);
    else if (part.type === 'file') lines.push(`[Attached ${part.mime}: ${part.filename ?? 'file'}]`);
    else if (part.type === 'compaction') lines.push('[Conversation compacted]');
  }
  return lines.join('\n');
}

function assistantText(parts: readonly SessionPart[]): string {
  return parts
    .filter((part): part is Extract<SessionPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n');
}

/**
 * Session messages as library messages. A tool part carries both the call
 * and its outcome, so every assistant message with tool parts is followed by
 * a synthetic user message holding the results, the shape the library pairs.
 */
export function toTranscript(messages: readonly SessionMessage[]): Transcript {
  const out: Message[] = [];
  const origins: number[] = [];
  messages.forEach((message, index) => {
    const push = (entry: Message) => {
      out.push(entry);
      origins.push(index);
    };
    if (message.info.role === 'user') {
      push({ role: 'user', text: userText(message.parts), toolUses: [] });
      return;
    }
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    for (const part of message.parts) {
      if (part.type !== 'tool') continue;
      const outcome = toolOutcome(part);
      if (!outcome) continue;
      toolUses.push({
        tool_use_id: part.callID,
        tool: part.tool,
        input: part.state.input,
        text: outcome.text,
        isError: outcome.isError,
      });
      toolResults.push({ tool_use_id: part.callID, text: outcome.text, isError: outcome.isError });
    }
    push({ role: 'assistant', text: assistantText(message.parts), toolUses });
    if (toolResults.length > 0) push({ role: 'user', text: '', toolUses: [], toolResults });
  });
  return { messages: out, origins };
}

/** How many transcript messages the newest `count` session messages span. */
export function preserveFor(transcript: Transcript, sessionMessages: number, count: number): number {
  const first = sessionMessages - count;
  return transcript.origins.filter((origin) => origin >= first).length;
}

function truncatePart(part: ToolPart, headChars: number): ToolPart {
  if (part.state.status === 'completed') {
    if (part.state.time.compacted) return part;
    const output = truncatedResultText(part.state.output, false, headChars);
    return output === part.state.output ? part : { ...part, state: { ...part.state, output } };
  }
  if (part.state.status === 'error') {
    const error = truncatedResultText(part.state.error, true, headChars);
    return error === part.state.error ? part : { ...part, state: { ...part.state, error } };
  }
  return part;
}

/**
 * Applies actions to session messages: `drop_call` removes the tool part,
 * `drop_result` truncates its output. Untouched messages are returned as the
 * same objects; a message left with only step parts is dropped by the host.
 */
export function applyToSession(
  messages: readonly SessionMessage[],
  actions: ReadonlyMap<string, CallAction>,
  headChars: number,
): SessionMessage[] {
  return messages.map((message) => {
    if (message.info.role !== 'assistant') return message;
    let changed = false;
    const parts: SessionPart[] = [];
    for (const part of message.parts) {
      if (part.type !== 'tool') {
        parts.push(part);
        continue;
      }
      const action = actions.get(part.callID);
      if (action === 'drop_call') {
        changed = true;
        continue;
      }
      if (action === 'drop_result') {
        const next = truncatePart(part, headChars);
        if (next !== part) changed = true;
        parts.push(next);
        continue;
      }
      parts.push(part);
    }
    return changed ? { ...message, parts } : message;
  });
}

function replace<T>(target: T[], next: readonly T[]): void {
  target.length = 0;
  for (const item of next) target.push(item);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The OpenCode 1.x plugin: `(input, options) => hooks`. */
export const server: Plugin = async (input, options) => {
  const config = readPrunerOptions(options ?? {});
  const log = (level: 'info' | 'warn', message: string) =>
    Promise.resolve(
      input.client.app.log({ body: { service: 'fast-jev-compaction', level, message } }),
    ).catch(() => undefined);
  const toast = (message: string) =>
    Promise.resolve(
      input.client.tui.showToast({
        body: { title: 'fast-jev-compaction', message, variant: 'info', duration: 10_000 },
      }),
    ).catch(() => undefined);
  if (missingKey(config)) {
    await log('warn', 'TYPESAFE_API_KEY is not configured; Jev compaction is disabled');
    return {};
  }
  await log('info', `Jev compaction enabled: ${describeProvider(config)}`);
  const fetchFn = options?.['fetch'];
  const pruner = new SessionPruner(
    jevClient(config, typeof fetchFn === 'function' ? (fetchFn as typeof fetch) : undefined),
    config,
  );
  const limits = new Map<string, number>();

  return {
    'chat.params': async (params) => {
      limits.set(params.sessionID, params.model.limit.context);
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      const session = output.messages[0]?.info.sessionID;
      if (!session) return;
      try {
        const transcript = toTranscript(output.messages);
        const outcome = await pruner.prune(session, transcript.messages, {
          contextTokens: limits.get(session),
          preserveRecentMessages: preserveFor(
            transcript,
            output.messages.length,
            config.preserveRecentMessages,
          ),
        });
        if (outcome.actions.size > 0) {
          replace(
            output.messages,
            applyToSession(output.messages, outcome.actions, config.truncateHeadChars),
          );
        }
        if (outcome.reason === 'pruned') {
          const text = describeOutcome(outcome);
          await log('info', text);
          await toast(text);
        }
      } catch (error) {
        await log('warn', `left the history alone (${errorMessage(error)})`);
      }
    },
  };
};
