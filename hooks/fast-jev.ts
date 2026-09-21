import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import {
  buildJevRequest,
  DEFAULT_MODEL,
  parseJevResponse,
  SYSTEM_ONE_URL,
} from '../src/request.js';
import { GATEWAY_MODEL, GATEWAY_URL, gatewayAsker } from './gateway-asker.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  provider: 'auto' as ProviderSetting,
};

/**
 * Which Jev API the hook talks to. `systemone` is TypeSafe's own endpoint (what
 * the library in `src/` speaks); `gateway` is the Vercel AI Gateway's
 * evaluation-model endpoint. `auto` picks one from the key and the model.
 */
export type JevProvider = 'gateway' | 'systemone';
export type ProviderSetting = JevProvider | 'auto';

/** Where the key came from; `auto` reads it as which API the install is set up for. */
export type KeySource = 'gateway-env' | 'typesafe-env' | 'option' | 'none';

export const PROVIDER_DEFAULTS: Record<JevProvider, { model: string; url: string }> = {
  gateway: { model: GATEWAY_MODEL, url: GATEWAY_URL },
  systemone: { model: DEFAULT_MODEL, url: SYSTEM_ONE_URL },
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  /** Which API to talk to; `auto` decides from the key and the model. */
  provider: ProviderSetting;
  /** Unset takes the chosen provider's default model. */
  model?: string;
  /** Unset takes the chosen provider's default endpoint. */
  baseUrl?: string;
};

/** The API, model and endpoint one compaction actually uses. */
export type JevTarget = {
  provider: JevProvider;
  model: string;
  url: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    provider: optionProvider(options),
  };
  const model = optionString(options, 'model');
  if (model) config.model = model;
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** An unknown `provider` value is treated as `auto` rather than failing the install. */
function optionProvider(options: PluginOptions): ProviderSetting {
  const value = optionString(options, 'provider')?.toLowerCase();
  if (value === 'gateway' || value === 'vercel') return 'gateway';
  if (value === 'systemone' || value === 'system-one' || value === 'typesafe') return 'systemone';
  return HOOK_DEFAULTS.provider;
}

/**
 * Which API a compaction goes to, plus the model and endpoint for it.
 *
 * A configured `provider` always wins. Otherwise the key decides: a key read
 * from `AI_GATEWAY_API_KEY` is a Gateway key and one read from
 * `TYPESAFE_API_KEY` is a System One key. Only when the key carries no such
 * hint — it came from the `apiKey` plugin option, or there is none — does the
 * model id break the tie: Gateway ids are namespaced (`typesafe-ai/jev`) where
 * System One names are bare (`jev-latest`). With nothing to go on the Gateway
 * is the default, which is what a fresh install of this plugin is set up for.
 */
export function resolveTarget(config: HookConfig, keySource: KeySource = 'none'): JevTarget {
  const provider =
    config.provider !== 'auto'
      ? config.provider
      : keySource === 'gateway-env'
        ? 'gateway'
        : keySource === 'typesafe-env'
          ? 'systemone'
          : config.model
            ? config.model.includes('/')
              ? 'gateway'
              : 'systemone'
            : 'gateway';
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    model: config.model ?? defaults.model,
    url: config.baseUrl ?? defaults.url,
  };
}

/** The asker for a resolved target: the Gateway adapter, or System One directly. */
export function createAsker(fetchFn: HookFetch, apiKey: string, target: JevTarget): JevAsker {
  return target.provider === 'gateway'
    ? gatewayAsker(fetchFn, apiKey, target.model, target.url)
    : jevAsker(fetchFn, apiKey, target.model, target.url);
}

/** A `JevAsker` over the engine's `$.http.fetch`, speaking TypeSafe's System One. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string = DEFAULT_MODEL,
  baseUrl: string = SYSTEM_ONE_URL,
): JevAsker {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');

  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the Jev request fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  asker: JevAsker,
): Promise<SessionCompaction> {
  const result = await compact(messages, asker, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

export type ResolvedKey = { apiKey?: string; source: KeySource };

/**
 * The key, and which name it came from. The name is what `auto` reads as the
 * API the install is set up for, so the two travel together.
 *
 * `AI_GATEWAY_API_KEY` is looked at first and `TYPESAFE_API_KEY` second, which
 * is also the order a machine set up for both resolves in; a `provider` option
 * overrides that. Each name is spelled out because `$.env.get` takes a literal,
 * so the host can list which variables this module reads.
 */
async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<ResolvedKey> {
  if (config.apiKey) return { apiKey: config.apiKey, source: 'option' };
  // A configured provider decides which name to try first, so an install
  // pointed at System One on a machine that also has a Gateway key still
  // picks up its own credential.
  const names: readonly KeyName[] =
    config.provider === 'systemone'
      ? [TYPESAFE_KEY, GATEWAY_KEY]
      : [GATEWAY_KEY, TYPESAFE_KEY];
  for (const name of names) {
    const value =
      name === GATEWAY_KEY
        ? await $.env.get('AI_GATEWAY_API_KEY')
        : await $.env.get('TYPESAFE_API_KEY');
    if (value) return { apiKey: value, source: KEY_SOURCES[name] };
  }
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    for (const name of names) {
      const value = (env as Record<string, unknown>)[name];
      if (typeof value === 'string' && value) return { apiKey: value, source: KEY_SOURCES[name] };
    }
  }
  return { source: 'none' };
}

const GATEWAY_KEY = 'AI_GATEWAY_API_KEY';
const TYPESAFE_KEY = 'TYPESAFE_API_KEY';
type KeyName = typeof GATEWAY_KEY | typeof TYPESAFE_KEY;
const KEY_SOURCES: Record<KeyName, KeySource> = {
  [GATEWAY_KEY]: 'gateway-env',
  [TYPESAFE_KEY]: 'typesafe-env',
};

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const { apiKey, source } = await getApiKey($, configured);
      const config = { ...configured, apiKey };
      const target = resolveTarget(config, source);
      const asker = createAsker(
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        apiKey ?? '',
        target,
      );
      // Logged before the request, so a failure below says which API it went to.
      $.ui.log(`jev via ${target.provider} (${target.model})`);
      const { result, messages } = await compactSession(event.messages, config, asker);
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
