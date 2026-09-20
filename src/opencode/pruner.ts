import { JevClient } from '../client.js';
import { applyActions, compact, resolveOptions } from '../compact.js';
import { DEFAULT_MODEL, OPENCODE_ZEN_FREE_MODEL, OPENCODE_ZEN_URL } from '../request.js';
import { collectToolCalls, estimateTokens } from '../state.js';
import type {
  CallAction,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ResolvedCompactOptions,
} from '../types.js';

/**
 * Options of the continuous pruner used by the OpenCode adapters. Every
 * `CompactOptions` key is passed to the library; the rest decides when a pass
 * runs and how Jev is reached.
 */
export interface PrunerOptions extends CompactOptions {
  /**
   * Where Jev is reached. `typesafe` is TypeSafe's own endpoint (needs
   * `TYPESAFE_API_KEY`); `opencode` is OpenCode Zen, whose free Jev needs no
   * key (`OPENCODE_API_KEY` is sent when set). Default: `typesafe` when a
   * TypeSafe key is available, `opencode` otherwise.
   */
  provider?: 'typesafe' | 'opencode';
  /** API key for the provider; defaults to `TYPESAFE_API_KEY` or `OPENCODE_API_KEY`. */
  apiKey?: string;
  /** Jev model name. Default `jev-latest` (TypeSafe) or `jev-1.13-free` (OpenCode Zen). */
  model?: string;
  /** System One endpoint override. */
  baseUrl?: string;
  /** Milliseconds without Jev requests after one fails. Default 60000. */
  cooldownMs?: number;
  /** Percentage of the context window at which a pass runs. Default 60. */
  compactAtPercent?: number;
  /** Context window assumed when the host does not report one. Default 200000. */
  contextTokens?: number;
  /**
   * Largest verbatim checkpoint (estimated tokens) an OpenCode 2 compaction
   * hook will supply instead of the built-in summary. Default 40000.
   */
  checkpointTokens?: number;
}

export interface ResolvedPrunerOptions extends ResolvedCompactOptions {
  provider: 'typesafe' | 'opencode';
  apiKey?: string;
  model: string;
  baseUrl?: string;
  compactAtPercent: number;
  contextTokens: number;
  checkpointTokens: number;
  cooldownMs: number;
}

export const PRUNER_DEFAULTS = {
  model: DEFAULT_MODEL,
  compactAtPercent: 60,
  contextTokens: 200_000,
  checkpointTokens: 40_000,
  cooldownMs: 60_000,
} as const;

const NUMBER_KEYS = [
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
  'compactAtPercent',
  'contextTokens',
  'checkpointTokens',
  'cooldownMs',
] as const;

type NumberKey = (typeof NUMBER_KEYS)[number];

/**
 * Reads an untyped options bag (an OpenCode plugin's `options`) into resolved
 * pruner options. Anything missing or malformed takes the default. With a
 * TypeSafe key (option or `TYPESAFE_API_KEY`) Jev is reached at TypeSafe;
 * without one, at OpenCode Zen's free Jev, with `OPENCODE_API_KEY` when set.
 * `FAST_JEV_PROVIDER` and `FAST_JEV_MODEL` in `env` stand in for the
 * `provider` and `model` options (options win), so a plugin-directory install
 * that takes no options can still choose; a model written the OpenCode way,
 * `opencode/jev-1.13-free`, selects the `opencode` provider by itself.
 */
export function readPrunerOptions(
  options: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedPrunerOptions {
  const numbers: Partial<Record<NumberKey, number>> = {};
  for (const key of NUMBER_KEYS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const string = (key: string): string | undefined => {
    const value = options[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  let model = string('model') ?? (env['FAST_JEV_MODEL'] || undefined);
  let explicitProvider: unknown = options['provider'] ?? (env['FAST_JEV_PROVIDER'] || undefined);
  if (model?.startsWith('opencode/')) {
    model = model.slice('opencode/'.length);
    explicitProvider ??= 'opencode';
  }
  const typesafeKey = string('apiKey') ?? (env['TYPESAFE_API_KEY'] || undefined);
  const provider: ResolvedPrunerOptions['provider'] =
    explicitProvider === 'opencode' || explicitProvider === 'typesafe'
      ? explicitProvider
      : typesafeKey
        ? 'typesafe'
        : 'opencode';
  const resolved: ResolvedPrunerOptions = {
    ...resolveOptions({
      goal: string('goal'),
      keepThreshold: numbers.keepThreshold,
      preserveRecentMessages: numbers.preserveRecentMessages,
      maxStateTokens: numbers.maxStateTokens,
      maxRequestTokens: numbers.maxRequestTokens,
      truncateHeadChars: numbers.truncateHeadChars,
    }),
    provider,
    model: model ?? (provider === 'opencode' ? OPENCODE_ZEN_FREE_MODEL : PRUNER_DEFAULTS.model),
    compactAtPercent: numbers.compactAtPercent ?? PRUNER_DEFAULTS.compactAtPercent,
    contextTokens: numbers.contextTokens ?? PRUNER_DEFAULTS.contextTokens,
    checkpointTokens: numbers.checkpointTokens ?? PRUNER_DEFAULTS.checkpointTokens,
    cooldownMs: Math.max(0, numbers.cooldownMs ?? PRUNER_DEFAULTS.cooldownMs),
  };
  const apiKey =
    string('apiKey') ??
    (provider === 'opencode' ? env['OPENCODE_API_KEY'] || undefined : typesafeKey);
  if (apiKey) resolved.apiKey = apiKey;
  const baseUrl = string('baseUrl') ?? (provider === 'opencode' ? OPENCODE_ZEN_URL : undefined);
  if (baseUrl) resolved.baseUrl = baseUrl;
  return resolved;
}

/** True when the options cannot reach Jev at all: TypeSafe without a key. */
export function missingKey(options: ResolvedPrunerOptions): boolean {
  return options.provider === 'typesafe' && !options.apiKey && !options.baseUrl;
}

/** One line naming where Jev is reached, for startup logs. */
export function describeProvider(options: ResolvedPrunerOptions): string {
  const where = options.baseUrl ?? 'TypeSafe';
  const auth = options.apiKey ? 'with key' : 'no key';
  return `${options.model} at ${where} (${auth})`;
}

/** A `JevClient` for the resolved options; `fetchFn` is for tests. */
export function jevClient(options: ResolvedPrunerOptions, fetchFn?: typeof fetch): JevClient {
  return new JevClient({
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    fetch: fetchFn,
  });
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Estimated tokens of a transcript's text, tool inputs and tool results. */
export function transcriptTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.text);
    for (const tool of message.toolUses) total += estimateTokens(stringify(tool.input));
    for (const result of message.toolResults ?? []) total += estimateTokens(result.text);
  }
  return total;
}

/**
 * A transcript as plain text, one line per utterance, tool calls followed by
 * their outcome. Results are read from the `text` of each tool_use, so a
 * message holding only tool_results contributes nothing.
 */
export function renderTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.text.trim()) lines.push(`[User]: ${message.text}`);
      continue;
    }
    if (message.text.trim()) lines.push(`[Assistant]: ${message.text}`);
    for (const tool of message.toolUses) {
      lines.push(`[Assistant tool call]: ${tool.tool}(${stringify(tool.input)})`);
      if (tool.text !== undefined) {
        lines.push(`[Tool ${tool.isError ? 'error' : 'result'}]: ${tool.text}`);
      }
    }
  }
  return lines.join('\n\n');
}

export type PruneReason = 'under_threshold' | 'no_candidates' | 'no_new_calls' | 'cooldown' | 'pruned';

export interface PruneOutcome {
  reason: PruneReason;
  /** Every action decided so far for the session, keyed by `tool_use_id`. */
  actions: ReadonlyMap<string, CallAction>;
  /** Estimated tokens at which a pass runs. */
  threshold: number;
  /** Estimated tokens of the transcript with the previous actions applied. */
  tokensBefore: number;
  /** Estimated tokens with every action applied. */
  tokensAfter: number;
  /** The library result of the pass, when one ran. */
  result?: CompactResult;
}

export interface PruneInput {
  /** The session's context window, when the host reports it. */
  contextTokens?: number;
  /** Overrides the option, so a host can count in its own message units. */
  preserveRecentMessages?: number;
  /** Runs a pass regardless of the threshold and of new calls. */
  force?: boolean;
}

interface SessionState {
  actions: Map<string, CallAction>;
  asked: Set<string>;
}

/**
 * Continuous compaction for hosts that expose the messages of every model
 * request but no hook that replaces a compaction: decisions are remembered
 * per session and re-applied to each request, and Jev is asked again only
 * when the transcript is above the threshold and holds a call it has not
 * been asked about. A result Jev drops stays dropped; a call it kept can be
 * dropped by a later pass. After a failed request nothing is asked for
 * `cooldownMs`, so an unreachable Jev costs one failure per cooldown, not one
 * per request.
 */
export class SessionPruner {
  private readonly sessions = new Map<string, SessionState>();
  /** When the last Jev failure happened; requests pause for `cooldownMs` after it. */
  private failedAt: number | undefined;

  constructor(
    private readonly asker: JevAsker,
    readonly options: ResolvedPrunerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while a recent Jev failure keeps requests paused. */
  coolingDown(): boolean {
    return this.failedAt !== undefined && this.now() - this.failedAt < this.options.cooldownMs;
  }

  /** The actions decided so far for a session. */
  actions(session: string): ReadonlyMap<string, CallAction> {
    return this.sessions.get(session)?.actions ?? new Map();
  }

  forget(session: string): void {
    this.sessions.delete(session);
  }

  private state(session: string): SessionState {
    let state = this.sessions.get(session);
    if (!state) {
      state = { actions: new Map(), asked: new Set() };
      this.sessions.set(session, state);
    }
    return state;
  }

  async prune(
    session: string,
    messages: readonly Message[],
    input: PruneInput = {},
  ): Promise<PruneOutcome> {
    const state = this.state(session);
    const headChars = this.options.truncateHeadChars;
    const applied = applyActions(messages, state.actions, headChars);
    const tokensBefore = transcriptTokens(applied);
    const contextTokens = input.contextTokens ?? this.options.contextTokens;
    const threshold = Math.floor((contextTokens * this.options.compactAtPercent) / 100);
    const base = { actions: state.actions, threshold, tokensBefore, tokensAfter: tokensBefore };
    if (!input.force && tokensBefore < threshold) return { ...base, reason: 'under_threshold' };

    const preserveRecentMessages = input.preserveRecentMessages ?? this.options.preserveRecentMessages;
    const candidates = collectToolCalls(applied, preserveRecentMessages).filter((call) => !call.pinned);
    if (candidates.length === 0) return { ...base, reason: 'no_candidates' };
    if (!input.force && candidates.every((call) => state.asked.has(call.tool_use_id))) {
      return { ...base, reason: 'no_new_calls' };
    }
    if (!input.force && this.coolingDown()) return { ...base, reason: 'cooldown' };

    let result: CompactResult;
    try {
      result = await compact(applied, this.asker, { ...this.options, preserveRecentMessages });
    } catch (error) {
      this.failedAt = this.now();
      throw error;
    }
    this.failedAt = undefined;
    for (const call of candidates) state.asked.add(call.tool_use_id);
    for (const decision of result.decisions) {
      if (decision.action === 'keep') continue;
      const current = state.actions.get(decision.tool_use_id);
      if (decision.action === 'drop_call' || current === undefined) {
        state.actions.set(decision.tool_use_id, decision.action);
      }
    }
    const tokensAfter = transcriptTokens(applyActions(messages, state.actions, headChars));
    return { ...base, reason: 'pruned', result, tokensAfter };
  }
}

/** One line describing a pass, for logs and toasts. */
export function describeOutcome(outcome: PruneOutcome): string {
  const stats = outcome.result?.stats;
  const decisions = stats
    ? [
        stats.kept > 0 ? `${stats.kept} kept` : '',
        stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
        stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
        stats.pinned > 0 ? `${stats.pinned} pinned` : '',
      ]
        .filter(Boolean)
        .join(', ') || 'no tool calls'
    : outcome.reason;
  const requests = stats ? ` in ${stats.requests} request(s)` : '';
  return `${decisions}; ~${outcome.tokensBefore} → ~${outcome.tokensAfter} tokens (threshold ${outcome.threshold})${requests}`;
}
