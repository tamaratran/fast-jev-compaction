import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { estimateTokens, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import { DEFAULT_OPTIONS, reductionRatio } from '../src/compact.js';
import { DEFAULT_MODEL } from '../src/request.js';
import type { CompactOptions, CompactResult } from '../src/types.js';
import { compactPiMessages } from './adapter.js';
import { createCheckpoint, isJevCheckpoint, renderCheckpoint, restoreCheckpoints } from './checkpoint.js';
import { createJevTransport } from './transport.js';
import { prepareCheckpointFallback } from './fallback.js';

const SETTINGS_ENTRY = 'fast-jev-pi-settings';
const BOUNDARY_ENTRY = 'fast-jev-pi-boundary';

export interface PiConfig extends CompactOptions {
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  timeoutMs: number;
}

function describe(stats: CompactResult['stats']): string {
  return `${Math.round(reductionRatio({ stats }) * 100)}% reduction; ` +
    `${stats.callsDropped} calls dropped, ${stats.resultsDropped} results truncated, ` +
    `${stats.pinned} pinned; ${stats.requests} Jev request(s)`;
}

export default function registerPiExtension(pi: ExtensionAPI): void {
  const flags: Array<[string, string, number]> = [
    ['jev-compact-at-percent', 'Context percentage that triggers compaction after a completed turn', 60],
    ['jev-min-reduction-ratio', 'Minimum character reduction before replacing native summarization', 0.25],
    ['jev-keep-threshold', 'Minimum probability for keeping a call or full result', DEFAULT_OPTIONS.keepThreshold],
    ['jev-preserve-recent', 'Newest message rows preserved by the native compactor', DEFAULT_OPTIONS.preserveRecentMessages],
    ['jev-max-state-tokens', 'Estimated Jev state token budget', DEFAULT_OPTIONS.maxStateTokens],
    ['jev-max-request-tokens', 'Estimated Jev request token budget', DEFAULT_OPTIONS.maxRequestTokens],
    ['jev-truncate-head-chars', 'Characters retained when a result is truncated', DEFAULT_OPTIONS.truncateHeadChars],
    ['jev-timeout-ms', 'Optional deadline for a scoring pass; 0 disables the deadline', 0],
  ];
  for (const [name, description, value] of flags) {
    pi.registerFlag(name, { description, type: 'string', default: String(value) });
  }
  pi.registerFlag('jev-model', { description: 'TypeSafe compaction model', type: 'string', default: DEFAULT_MODEL });
  pi.registerFlag('jev-disabled', { description: 'Start with native Pi summarization only', type: 'boolean', default: false });

  let config: PiConfig | undefined;
  let initialized = false;
  let enabled = true;
  let generation = 0;
  let requested = false;
  let active: ReturnType<typeof createJevTransport> | undefined;
  let status = 'ready';
  let lastStats: CompactResult['stats'] | undefined;
  let lastDecisions: CompactResult['decisions'] = [];

  function notify(ctx: ExtensionContext, text: string, warning = false): void {
    if (ctx.hasUI) ctx.ui.notify(`Jev: ${text}`, warning ? 'warning' : 'info');
  }

  function showStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus('fast-jev-pi', `Jev: ${enabled ? status : 'off'}`);
  }

  function invalidate(): void {
    generation++;
    active?.abort();
    active = undefined;
    requested = false;
  }

  function readConfig(): PiConfig {
    function number(name: string, fallback: number, min: number, max: number, integer = true): number {
      const raw = pi.getFlag(name) ?? String(fallback);
      const value = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
        throw new Error(`Invalid --${name}`);
      }
      return value;
    }
    const model = pi.getFlag('jev-model') ?? DEFAULT_MODEL;
    if (typeof model !== 'string' || !model.trim()) throw new Error('Invalid --jev-model');
    return {
      compactAtPercent: number('jev-compact-at-percent', 60, 0, 100, false),
      minReductionRatio: number('jev-min-reduction-ratio', 0.25, 0, 1, false),
      keepThreshold: number('jev-keep-threshold', DEFAULT_OPTIONS.keepThreshold, 0, 1, false),
      preserveRecentMessages: number('jev-preserve-recent', DEFAULT_OPTIONS.preserveRecentMessages, 0, Number.MAX_SAFE_INTEGER),
      maxStateTokens: number('jev-max-state-tokens', DEFAULT_OPTIONS.maxStateTokens, 1, Number.MAX_SAFE_INTEGER),
      maxRequestTokens: number('jev-max-request-tokens', DEFAULT_OPTIONS.maxRequestTokens, 1, Number.MAX_SAFE_INTEGER),
      truncateHeadChars: number('jev-truncate-head-chars', DEFAULT_OPTIONS.truncateHeadChars, 0, Number.MAX_SAFE_INTEGER),
      timeoutMs: number('jev-timeout-ms', 0, 0, 2_147_483_647),
      model: model.trim(),
    };
  }

  function hydrate(ctx: ExtensionContext): void {
    invalidate();
    initialized = true;
    lastStats = undefined;
    lastDecisions = [];
    try {
      config = readConfig();
      const branch = ctx.sessionManager.getBranch();
      const saved = [...branch].reverse().find(entry => entry.type === 'custom' && entry.customType === SETTINGS_ENTRY);
      enabled = pi.getFlag('jev-disabled') !== true &&
        !(saved?.type === 'custom' && saved.data && typeof saved.data === 'object' &&
          'enabled' in saved.data && saved.data.enabled === false);
      const lastCompaction = [...branch].reverse().find(entry => entry.type === 'compaction');
      if (lastCompaction?.type === 'compaction' && isJevCheckpoint(lastCompaction.details)) {
        lastStats = lastCompaction.details.stats;
        lastDecisions = lastCompaction.details.decisions ?? [];
      }
      status = lastStats ? describe(lastStats) : 'ready';
    } catch (error) {
      config = undefined;
      enabled = false;
      status = 'invalid configuration';
      notify(ctx, error instanceof Error ? error.message : status, true);
    }
    showStatus(ctx);
  }

  pi.on('session_start', (_event, ctx) => hydrate(ctx));
  pi.on('session_tree', (_event, ctx) => hydrate(ctx));
  pi.on('session_shutdown', () => invalidate());

  // Decode already-committed compactions even while future Jev compaction is off.
  // This hook never scores or revisits prior keep/drop decisions.
  pi.on('context', (event, ctx) => ({
    messages: restoreCheckpoints(event.messages, ctx.sessionManager.getBranch()),
  }));

  pi.on('session_before_compact', async (event, ctx) => {
    if (!initialized) hydrate(ctx);
    const prepareFallback = () => prepareCheckpointFallback(event, () => {
      pi.appendEntry('fast-jev-pi-native-cutoff', {});
      const id = ctx.sessionManager.getLeafId();
      if (!id) throw new Error('Missing native compaction cutoff');
      return id;
    });
    // Previously committed checkpoints must also survive /jev off and bad flags.
    if (!enabled || !config) { prepareFallback(); return; }
    const fallback = (reason: string) => {
      prepareFallback();
      status = `fallback to Pi summary (${reason})`;
      notify(ctx, status, true);
      showStatus(ctx);
    };
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) { fallback('TYPESAFE_API_KEY missing'); return; }
    const epoch = generation;
    const settings = config;
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const transport = createJevTransport(apiKey, settings.timeoutMs, event.signal, fetch, settings.model);
    active = transport;
    try {
      status = 'compacting';
      showStatus(ctx);
      const branch = ctx.sessionManager.getBranch();
      let messages = restoreCheckpoints(
        ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages), branch,
      );
      // Pi removes this failed response from live state before overflow recovery.
      // Do not bury it inside a checkpoint where Pi's retry cleanup cannot see it.
      const last = messages[messages.length - 1];
      if (event.willRetry && last?.role === 'assistant' &&
          (last.stopReason === 'error' || last.stopReason === 'length')) messages = messages.slice(0, -1);
      const result = await compactPiMessages(messages, transport.asker, {
        ...settings,
        goal: event.customInstructions?.trim() || settings.goal,
      });
      if (event.signal.aborted) return { cancel: true };
      if (epoch !== generation || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) {
        fallback('session context changed during scoring');
        return;
      }
      if (reductionRatio(result) < settings.minReductionRatio) {
        fallback(`below ${Math.round(settings.minReductionRatio * 100)}% minimum: ${describe(result.stats)}`);
        return;
      }
      const previousCompaction = [...branch].reverse().find(entry => entry.type === 'compaction');
      const previousFiles = previousCompaction?.type === 'compaction' && isJevCheckpoint(previousCompaction.details)
        ? previousCompaction.details : undefined;
      // Keep source entries selectable: Pi can otherwise reject a second compact
      // before it ever emits session_before_compact. The context hook replaces
      // this complete source interval with the snapshot, without duplicating it.
      // Retain the host's cut window plus one preceding message, not the entire
      // original session. That preceding row keeps a future preparation nonempty
      // even when all new messages fit inside keepRecentTokens. Back up over tool
      // results to include their assistant call rather than exposing an orphan.
      let sourceStart = branch.findIndex(entry => entry.id === event.preparation.firstKeptEntryId) - 1;
      while (sourceStart >= 0) {
        const entry = branch[sourceStart]!;
        const message = entry.type === 'compaction' ? undefined : sessionEntryToContextMessages(entry)[0];
        if (message && message.role !== 'toolResult') break;
        sourceStart--;
      }
      const sourceStartId = sourceStart >= 0 ? branch[sourceStart]!.id :
        branch.find(entry => sessionEntryToContextMessages(entry).length > 0)?.id;
      if (!sourceStartId) throw new Error('Missing checkpoint source');
      const details = createCheckpoint(result.messages, result.stats, event.preparation.fileOps, messages, previousFiles, sourceStartId);
      if (event.willRetry && last?.role === 'assistant' &&
          (last.stopReason === 'error' || last.stopReason === 'length')) details.omittedRetryResponse = true;
      details.decisions = result.decisions;
      const summary = renderCheckpoint(details);
      const safeBudget = ctx.model ? ctx.model.contextWindow - event.preparation.settings.reserveTokens : undefined;
      const retainedTokens = result.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      const checkpointTokens = estimateTokens({ role: 'compactionSummary', summary, tokensBefore: event.preparation.tokensBefore, timestamp: Date.now() });
      if (safeBudget !== undefined && Math.max(retainedTokens, checkpointTokens) >= safeBudget) {
        // A smaller checkpoint can still exceed a model's limit. Let Pi recover
        // normally rather than committing a checkpoint it cannot compact again.
        fallback('retained context still exceeds the model budget');
        return;
      }
      // This non-message boundary binds the snapshot to the covered source span.
      pi.appendEntry(BOUNDARY_ENTRY, { checkpointId: details.id });
      return {
        compaction: { summary, firstKeptEntryId: sourceStartId, tokensBefore: event.preparation.tokensBefore, details },
      };
    } catch {
      if (event.signal.aborted) return { cancel: true };
      fallback('Jev request or transcript validation failed');
      return;
    } finally {
      transport.dispose();
      if (active === transport) active = undefined;
    }
  });

  pi.on('session_compact', (event, ctx) => {
    if (isJevCheckpoint(event.compactionEntry.details)) {
      lastStats = event.compactionEntry.details.stats;
      lastDecisions = event.compactionEntry.details.decisions ?? [];
      status = `kept original messages, no summary; ${describe(lastStats)}`;
      notify(ctx, status);
    } else {
      lastStats = undefined;
      lastDecisions = [];
      status = 'Pi summary applied';
    }
    showStatus(ctx);
  });
  pi.on('session_compact_failed', (_event, ctx) => {
    lastStats = undefined;
    lastDecisions = [];
    status = 'compaction failed or cancelled; previous context retained';
    showStatus(ctx);
  });

  function requestCompaction(ctx: ExtensionContext): void {
    if (requested || active) return;
    requested = true;
    const epoch = generation;
    ctx.compact({
      onComplete: () => { if (epoch === generation) requested = false; },
      onError: () => { if (epoch === generation) requested = false; },
    });
  }

  // ctx.compact() aborts active Pi runs, so trigger only after the complete turn
  // has settled. Pi's own threshold/overflow compaction uses the same hook above.
  pi.on('agent_settled', (_event, ctx) => {
    if (!initialized) hydrate(ctx);
    if (!enabled || !config || !ctx.isIdle()) return;
    if ((ctx.getContextUsage()?.percent ?? 0) >= config.compactAtPercent) requestCompaction(ctx);
  });

  pi.registerCommand('jev', {
    description: 'Jev compaction: status, decisions, compact, on, off',
    handler: async (args, ctx) => {
      if (!initialized) hydrate(ctx);
      const command = args.trim() || 'status';
      if (command === 'status') {
        notify(ctx, `${enabled ? status : 'off'}; API key ${process.env.TYPESAFE_API_KEY?.trim() ? 'configured' : 'missing'}; ` +
          `auto at ${config?.compactAtPercent ?? 60}%; minimum reduction ${Math.round((config?.minReductionRatio ?? 0.25) * 100)}%`);
      } else if (command === 'decisions') {
        notify(ctx, lastDecisions.map(decision => `${decision.id}:${decision.tool}:${decision.action} ` +
          `call=${decision.keepCall.toFixed(2)} result=${decision.keepResult.toFixed(2)}`).join('\n') || 'no decisions yet');
      } else if (command === 'compact' || command === 'prune') {
        await ctx.waitForIdle();
        requestCompaction(ctx);
      } else if (command === 'on' || command === 'off') {
        invalidate();
        enabled = command === 'on';
        pi.appendEntry(SETTINGS_ENTRY, { enabled });
        showStatus(ctx);
        notify(ctx, enabled ? 'on' : 'off; existing compacted context remains available');
      } else {
        notify(ctx, 'usage: /jev status|decisions|compact|on|off; /compact also uses Jev');
      }
    },
  });
}
