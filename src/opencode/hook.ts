/**
 * The compaction hook itself, separated from `Plugin.define` so it can be
 * driven with a fake event and a fake asker.
 *
 * OpenCode's own summary is replaced only when Jev removes enough to be worth
 * it. On any failure the hook leaves `event.result` unset and OpenCode writes
 * its built-in summary, which is the safe fallback.
 */
import type { Message as AiMessage } from '@opencode/ai/effect';
import { compact, reductionRatio } from '../compact.js';
import { collectToolCalls } from '../state.js';
import { transportLabel } from '../transports.js';
import type { CallAction, JevAsker } from '../types.js';
import type { PluginConfig } from './config.js';
import { applyDecisionsToMessages, toJevMessages } from './messages.js';
import type { TrialRecord } from './trial.js';

export interface CompactionResultLike {
  summary: string;
  native?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CompactionEvent {
  readonly sessionID: string;
  messages: AiMessage[];
  result?: CompactionResultLike;
}

export interface CompactionHookDeps {
  config: PluginConfig;
  /** Built per event, so the Go route can carry the session header. */
  asker: (sessionID: string) => JevAsker;
  record?: TrialRecord;
  now?: () => number;
}

function summaryLine(stats: {
  messagesBefore: number;
  messagesAfter: number;
  resultsDropped: number;
  callsDropped: number;
  charsBefore: number;
  charsAfter: number;
}): string {
  const saved =
    stats.charsBefore === 0
      ? 0
      : Math.round(((stats.charsBefore - stats.charsAfter) / stats.charsBefore) * 100);
  return `fast-jev-compaction: ${stats.messagesAfter}/${stats.messagesBefore} messages kept, ${stats.resultsDropped} results and ${stats.callsDropped} calls dropped, ${saved}% of characters gone (no summary)`;
}

export function createCompactionHook(
  deps: CompactionHookDeps,
): (event: CompactionEvent) => Promise<void> {
  const now = deps.now ?? Date.now;
  const record = deps.record;
  return async (event) => {
    if (event.result) {
      await record?.({
        at: new Date(now()).toISOString(),
        session: event.sessionID,
        backend: transportLabel(deps.config.transport),
        transport: deps.config.transport.kind,
        ok: false,
        reason: 'already_compacted',
        ms: 0,
      });
      return;
    }

    const started = now();
    const view = toJevMessages(event.messages);
    const calls = collectToolCalls(view, deps.config.preserveRecentMessages ?? 6);
    const candidates = calls.filter((call) => !call.pinned);

    const base = {
      at: new Date(started).toISOString(),
      session: event.sessionID,
      backend: transportLabel(deps.config.transport),
      transport: deps.config.transport.kind,
    };

    if (candidates.length === 0) {
      await record?.({
        ...base,
        ok: false,
        reason: 'nothing_to_drop',
        ms: now() - started,
        stats: undefined,
      });
      return;
    }

    try {
      const result = await compact(view, deps.asker(event.sessionID), deps.config);
      const reduction = reductionRatio(result);
      if (reduction < deps.config.minReductionRatio) {
        await record?.({
          ...base,
          ok: false,
          reason: 'low_reduction',
          ms: now() - started,
          stats: result.stats,
          reduction,
          decisions: result.decisions,
        });
        return;
      }

      const toolUseID = new Map(calls.map((call) => [call.id, call.tool_use_id]));
      const actions = new Map<string, CallAction>();
      for (const decision of result.decisions) {
        if (decision.action === 'keep') continue;
        const id = toolUseID.get(decision.id);
        if (id) actions.set(id, decision.action);
      }

      const messages = applyDecisionsToMessages(
        event.messages,
        actions,
        deps.config.truncateHeadChars ?? 300,
      );
      event.result = {
        summary: summaryLine(result.stats),
        native: { messages },
        metadata: {
          'fast-jev-compaction': {
            backend: transportLabel(deps.config.transport),
            stats: result.stats,
            reduction,
          },
        },
      };
      await record?.({
        ...base,
        ok: true,
        ms: now() - started,
        stats: result.stats,
        reduction,
        decisions: result.decisions,
      });
    } catch (error) {
      await record?.({
        ...base,
        ok: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
        ms: now() - started,
      });
    }
  };
}
