/**
 * OpenCode 2 adapter (`@opencode/plugin` promise API). Two session hooks:
 * `context` prunes the messages of every model request continuously, and
 * `compaction` replaces the built-in summary with the pruned history rendered
 * verbatim whenever that history fits `checkpointTokens`.
 */
import type { Plugin } from '@opencode/plugin';
import type { SessionHooks } from '@opencode/plugin/promise/session';

import { applyActions, truncatedResultText } from '../compact.js';
import type { CallAction, Message, ToolResult, ToolUse } from '../types.js';
import {
  describeOutcome,
  describeProvider,
  jevClient,
  missingKey,
  readPrunerOptions,
  renderTranscript,
  SessionPruner,
  transcriptTokens,
} from './pruner.js';

export type ContextEvent = SessionHooks['context'];
export type CompactionEvent = SessionHooks['compaction'];
/** One model-level message as the session hooks see it. */
export type LLMMessage = ContextEvent['messages'][number];
export type LLMContentPart = LLMMessage['content'][number];
type ToolResultPart = Extract<LLMContentPart, { type: 'tool-result' }>;

export const CHECKPOINT_HEADER =
  'The earlier conversation, verbatim. Tool outputs that were no longer needed were truncated or removed; re-run a tool if its output is needed again.';

export interface Transcript {
  messages: Message[];
  /** Index of the model message each transcript message came from. */
  origins: number[];
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The text a tool result carries, whatever its shape. */
export function resultText(result: ToolResultPart['result']): string {
  if (result.type === 'content') {
    return result.value
      .map((item) =>
        item.type === 'text'
          ? item.text
          : `[Attached ${item.mime}${item.name === undefined ? '' : `: ${item.name}`}]`,
      )
      .join('\n');
  }
  return typeof result.value === 'string' ? result.value : stringify(result.value);
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { input };
}

function textOf(content: readonly LLMContentPart[]): string {
  const lines: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) lines.push(part.text);
    } else if (part.type === 'media') {
      lines.push(`[Attached ${part.mediaType}${part.filename ? `: ${part.filename}` : ''}]`);
    } else if (part.type === 'compaction') {
      lines.push(
        part.text === undefined
          ? '[Conversation checkpoint (encrypted)]'
          : `[Conversation checkpoint]\n${part.text ?? ''}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Model messages as library messages: assistant `tool-call` parts become
 * tool_uses (their `text` filled from the matching `tool-result`), a `tool`
 * message becomes a user message holding the results, and a system message
 * becomes a user message marked as such.
 */
export function toTranscript(messages: readonly LLMMessage[]): Transcript {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      results.set(part.id, { text: resultText(part.result), isError: part.result.type === 'error' });
    }
  }
  const out: Message[] = [];
  const origins: number[] = [];
  messages.forEach((message, index) => {
    const push = (entry: Message) => {
      out.push(entry);
      origins.push(index);
    };
    if (message.role === 'tool') {
      const toolResults: ToolResult[] = [];
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        const found = results.get(part.id);
        if (found) toolResults.push({ tool_use_id: part.id, ...found });
      }
      push({ role: 'user', text: '', toolUses: [], toolResults });
      return;
    }
    if (message.role === 'assistant') {
      const toolUses: ToolUse[] = [];
      for (const part of message.content) {
        if (part.type !== 'tool-call') continue;
        const use: ToolUse = { tool_use_id: part.id, tool: part.name, input: inputRecord(part.input) };
        const found = results.get(part.id);
        if (found) {
          use.text = found.text;
          if (found.isError) use.isError = true;
        }
        toolUses.push(use);
      }
      push({ role: 'assistant', text: textOf(message.content), toolUses });
      return;
    }
    const text = textOf(message.content);
    push({ role: 'user', text: message.role === 'system' && text ? `[System] ${text}` : text, toolUses: [] });
  });
  return { messages: out, origins };
}

/** How many transcript messages the newest `count` model messages span. */
export function preserveFor(transcript: Transcript, modelMessages: number, count: number): number {
  const first = modelMessages - count;
  return transcript.origins.filter((origin) => origin >= first).length;
}

function truncateResult(part: ToolResultPart, headChars: number): ToolResultPart {
  const isError = part.result.type === 'error';
  const text = resultText(part.result);
  const next = truncatedResultText(text, isError, headChars);
  if (next === text) return part;
  // An error stays an error; only its text shrinks.
  return { ...part, result: { type: isError ? 'error' : 'text', value: next } };
}

/**
 * A copy of a message with other content. The host's messages are class
 * instances that its request builder validates, so the copy keeps the
 * prototype: through the constructor when it accepts the fields, otherwise by
 * copying the fields onto the same prototype.
 */
export function withContent(message: LLMMessage, content: readonly LLMContentPart[]): LLMMessage {
  const proto = Object.getPrototypeOf(message) as object | null;
  const ctor = (proto as { constructor?: unknown } | null)?.constructor;
  if (proto && proto !== Object.prototype && typeof ctor === 'function') {
    try {
      return new (ctor as new (input: object) => LLMMessage)({ ...message, content });
    } catch {
      // fall through to the prototype copy
    }
  }
  return Object.assign(Object.create(proto), message, { content }) as LLMMessage;
}

/**
 * Applies actions to model messages: `drop_call` removes the `tool-call` and
 * its `tool-result`, `drop_result` turns the result into truncated text. A
 * message that loses all its content is left out; untouched messages are the
 * same objects.
 */
export function applyToMessages(
  messages: readonly LLMMessage[],
  actions: ReadonlyMap<string, CallAction>,
  headChars: number,
): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' && message.role !== 'tool') {
      out.push(message);
      continue;
    }
    let changed = false;
    const content: LLMContentPart[] = [];
    for (const part of message.content) {
      if (part.type === 'tool-call' || part.type === 'tool-result') {
        const action = actions.get(part.id);
        if (action === 'drop_call') {
          changed = true;
          continue;
        }
        if (action === 'drop_result' && part.type === 'tool-result') {
          const next = truncateResult(part, headChars);
          if (next !== part) changed = true;
          content.push(next);
          continue;
        }
      }
      content.push(part);
    }
    if (!changed) {
      out.push(message);
      continue;
    }
    if (content.length === 0) continue;
    out.push(withContent(message, content));
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  console.log(`[fast-jev-compaction] ${message}`);
}

/** The OpenCode 2 plugin setup, registered on the session domain. */
export const setup: Plugin.Plugin['setup'] = async (ctx) => {
  const config = readPrunerOptions(ctx.options);
  if (missingKey(config)) {
    log('TYPESAFE_API_KEY is not configured; Jev compaction is disabled');
    return;
  }
  log(`Jev compaction enabled: ${describeProvider(config)}`);
  const fetchFn = ctx.options['fetch'];
  const pruner = new SessionPruner(
    jevClient(config, typeof fetchFn === 'function' ? (fetchFn as typeof fetch) : undefined),
    config,
  );

  await ctx.session.hook('context', async (event) => {
    try {
      const transcript = toTranscript(event.messages);
      const outcome = await pruner.prune(event.sessionID, transcript.messages, {
        preserveRecentMessages: preserveFor(
          transcript,
          event.messages.length,
          config.preserveRecentMessages,
        ),
      });
      if (outcome.actions.size > 0) {
        event.messages = applyToMessages(event.messages, outcome.actions, config.truncateHeadChars);
      }
      if (outcome.reason === 'pruned') log(`${event.sessionID}: ${describeOutcome(outcome)}`);
    } catch (error) {
      log(`${event.sessionID}: left the history alone (${errorMessage(error)})`);
    }
  });

  await ctx.session.hook('compaction', async (event) => {
    try {
      const transcript = toTranscript(event.messages);
      // The head being summarised; its newest messages stay pinned like in
      // any other pass, so a call made just before compaction is never lost.
      const outcome = await pruner.prune(event.sessionID, transcript.messages, {
        force: true,
        preserveRecentMessages: preserveFor(
          transcript,
          event.messages.length,
          config.preserveRecentMessages,
        ),
      });
      const pruned = applyActions(transcript.messages, outcome.actions, config.truncateHeadChars);
      const tokens = transcriptTokens(pruned);
      if (tokens > config.checkpointTokens) {
        log(
          `${event.sessionID}: built-in summary (verbatim history ~${tokens} tokens is above checkpointTokens ${config.checkpointTokens})`,
        );
        return;
      }
      event.result = {
        summary: `${CHECKPOINT_HEADER}\n\n${renderTranscript(pruned)}`,
        metadata: {
          'fast-jev-compaction': {
            tokens,
            messages: pruned.length,
            ...(outcome.result ? outcome.result.stats : {}),
          },
        },
      };
      log(
        `${event.sessionID}: verbatim checkpoint, no summary (~${tokens} tokens; ${describeOutcome(outcome)})`,
      );
    } catch (error) {
      log(`${event.sessionID}: built-in summary (${errorMessage(error)})`);
    }
  });
};
