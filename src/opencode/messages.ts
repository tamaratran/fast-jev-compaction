/**
 * Adapter between OpenCode's message shapes and the plain transcript the
 * compaction engine reads.
 *
 * The engine only needs roles, text, tool calls and tool results; everything
 * else (reasoning, media, provider metadata, compaction checkpoints) stays on
 * the original message objects and is copied back untouched. Decisions are
 * therefore applied to the native messages, never to a rewritten copy.
 */
import type { Message as AiMessage, ToolResultPart } from '@opencode/ai/effect';
import { truncatedResultText } from '../compact.js';
import type { CallAction, Message, ToolResult, ToolUse } from '../types.js';

type Part = AiMessage['content'][number];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function contentText(parts: readonly Part[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.length > 0) texts.push(part.text);
    else if (part.type === 'compaction' && typeof part.text === 'string' && part.text.length > 0) {
      texts.push(part.text);
    }
  }
  return texts.join('\n');
}

/** The text of one tool result, as the engine sees and truncates it. */
export function toolResultText(part: ToolResultPart): string {
  const result = part.result;
  switch (result.type) {
    case 'text':
    case 'error':
      return typeof result.value === 'string' ? result.value : String(result.value);
    case 'json':
      try {
        return JSON.stringify(result.value);
      } catch {
        return String(result.value);
      }
    case 'content':
      return result.value
        .map((entry) =>
          entry.type === 'text' ? entry.text : `[file ${entry.name ?? entry.uri} (${entry.mime})]`,
        )
        .join('\n');
    default:
      return '';
  }
}

export function toolResultFailed(part: ToolResultPart): boolean {
  return part.result.type === 'error';
}

function toolCalls(message: AiMessage): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const part of message.content) {
    if (part.type !== 'tool-call') continue;
    uses.push({
      tool_use_id: part.id,
      tool: part.name,
      input: asRecord(part.input),
    });
  }
  return uses;
}

function toolResults(message: AiMessage): ToolResult[] {
  const results: ToolResult[] = [];
  for (const part of message.content) {
    if (part.type !== 'tool-result') continue;
    const entry: ToolResult = {
      tool_use_id: part.id,
      text: toolResultText(part),
    };
    if (toolResultFailed(part)) entry.isError = true;
    results.push(entry);
  }
  return results;
}

/** One engine message per native message, at the same index, so pinning works. */
export function toJevMessages(messages: readonly AiMessage[]): Message[] {
  return messages.map((message) => {
    const view: Message = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: contentText(message.content),
      toolUses: message.role === 'assistant' ? toolCalls(message) : [],
    };
    const results = toolResults(message);
    if (results.length > 0) view.toolResults = results;
    return view;
  });
}

function truncatedPart(part: ToolResultPart, text: string): ToolResultPart {
  return {
    type: 'tool-result',
    id: part.id,
    name: part.name,
    result: { type: 'text', value: text },
    ...(part.namespace !== undefined ? { namespace: part.namespace } : {}),
    ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
  };
}

/**
 * Rebuilds the native window: a dropped call loses its tool-call part and its
 * tool-result part, a dropped result keeps a bounded head as plain text.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects.
 */
export function applyDecisionsToMessages(
  messages: readonly AiMessage[],
  actions: ReadonlyMap<string, CallAction>,
  headChars: number,
): AiMessage[] {
  const kept: AiMessage[] = [];
  for (const message of messages) {
    let touched = false;
    const content: Part[] = [];
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        if (actions.get(part.id) === 'drop_call') {
          touched = true;
          continue;
        }
        content.push(part);
        continue;
      }
      if (part.type === 'tool-result') {
        const action = actions.get(part.id);
        if (action === 'drop_call') {
          touched = true;
          continue;
        }
        if (action === 'drop_result') {
          const text = toolResultText(part);
          const truncated = truncatedResultText(text, toolResultFailed(part), headChars);
          if (truncated !== text) {
            touched = true;
            content.push(truncatedPart(part, truncated));
            continue;
          }
        }
        content.push(part);
        continue;
      }
      content.push(part);
    }
    if (!touched) {
      kept.push(message);
      continue;
    }
    if (content.length === 0) continue;
    kept.push({ ...message, content } as AiMessage);
  }
  return kept;
}
