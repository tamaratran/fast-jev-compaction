/**
 * Plugin option parsing. OpenCode passes the `options` object from
 * `opencode.json(c)` verbatim, so every value is validated here and anything
 * unrecognised falls back to a default rather than failing a session.
 */
import { join } from 'node:path';
import {
  type JevTransport,
  type TransportEnv,
  resolveTransport,
  transportLabel,
  withTransportLimits,
} from '../transports.js';
import type { CompactOptions } from '../types.js';
import { opencodeDataDir } from './auth.js';

export interface PluginConfig extends CompactOptions {
  enabled: boolean;
  transport: JevTransport;
  /** Minimum share of characters that must go away to replace the summary. */
  minReductionRatio: number;
  /** JSONL trial log. */
  logPath: string;
  /** Key resolved from the environment or OpenCode's auth store. */
  apiKey?: string;
}

export type PluginOptions = Readonly<Record<string, unknown>>;

function stringOption(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOption(options: PluginOptions, key: string): number | undefined {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOption(options: PluginOptions, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === 'boolean' ? value : undefined;
}

function headerOption(options: PluginOptions): Record<string, string> | undefined {
  const value = options.headers;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') headers[key] = entry;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function enabledFromEnv(env: TransportEnv): boolean {
  const value = env.FAST_JEV_ENABLED ?? env.JEV_ENABLED;
  return value !== '0' && value !== 'false';
}

/**
 * Resolves the transport from options first, then the environment preset, then
 * `opencode-free`. `baseUrl` alone is enough to select the HTTP transport, which
 * is how a local model is configured without knowing preset names.
 */
export function resolveTransportOption(
  options: PluginOptions,
  env: TransportEnv,
): JevTransport {
  const baseUrl = stringOption(options, 'baseUrl') ?? env.FAST_JEV_BASE_URL ?? env.JEV_BASE_URL;
  if (baseUrl) {
    const preset = stringOption(options, 'transport') ?? stringOption(options, 'preset');
    const base = preset ? resolveTransport(preset, env) : undefined;
    const model =
      stringOption(options, 'model') ??
      env.FAST_JEV_MODEL ??
      env.JEV_MODEL ??
      (base?.kind === 'http' ? base.model : 'jev-latest');
    const transport: JevTransport = { kind: 'http', baseUrl, model };
    const apiKey = stringOption(options, 'apiKey');
    if (apiKey) transport.apiKey = apiKey;
    const headers = headerOption(options);
    if (headers) transport.headers = headers;
    const contextWindow = numberOption(options, 'contextWindow');
    if (contextWindow !== undefined) transport.contextWindow = contextWindow;
    const maxCallsPerBatch = numberOption(options, 'maxCallsPerBatch');
    if (maxCallsPerBatch !== undefined) transport.maxCallsPerBatch = maxCallsPerBatch;
    const maxConcurrentRequests = numberOption(options, 'maxConcurrentRequests');
    if (maxConcurrentRequests !== undefined) {
      transport.maxConcurrentRequests = maxConcurrentRequests;
    }
    return transport;
  }

  const providerID = stringOption(options, 'providerID') ?? env.FAST_JEV_PROVIDER ?? env.JEV_PROVIDER;
  const modelID = stringOption(options, 'modelID') ?? env.FAST_JEV_MODEL_ID ?? env.JEV_MODEL_ID;
  if (providerID || modelID) {
    return {
      kind: 'provider',
      providerID: providerID ?? 'opencode',
      modelID: modelID ?? 'jev-1.13-free',
    };
  }

  return resolveTransport(
    stringOption(options, 'transport') ?? stringOption(options, 'preset'),
    env,
  );
}

/** Reads plugin options and environment into one validated configuration. */
export function resolvePluginConfig(
  options: PluginOptions = {},
  env: TransportEnv = process.env,
): PluginConfig {
  const transport = resolveTransportOption(options, env);
  const limits = withTransportLimits({}, transport);
  const logPath =
    stringOption(options, 'logPath') ??
    env.FAST_JEV_LOG ??
    env.JEV_LOG ??
    join(opencodeDataDir(env), 'fast-jev-compaction', 'trial.jsonl');

  const config: PluginConfig = {
    enabled: booleanOption(options, 'enabled') ?? enabledFromEnv(env),
    transport,
    minReductionRatio: Math.min(
      1,
      Math.max(0, numberOption(options, 'minReductionRatio') ?? 0.25),
    ),
    logPath,
    keepThreshold: numberOption(options, 'keepThreshold'),
    preserveRecentMessages: numberOption(options, 'preserveRecentMessages'),
    truncateHeadChars: numberOption(options, 'truncateHeadChars'),
    maxStateTokens: numberOption(options, 'maxStateTokens') ?? limits.maxStateTokens,
    maxRequestTokens: numberOption(options, 'maxRequestTokens') ?? limits.maxRequestTokens,
    maxCallsPerBatch:
      numberOption(options, 'maxCallsPerBatch') ?? limits.maxCallsPerBatch ?? 0,
    maxConcurrentRequests:
      numberOption(options, 'maxConcurrentRequests') ?? limits.maxConcurrentRequests ?? 0,
  };
  const apiKey = stringOption(options, 'apiKey') ?? env.FAST_JEV_API_KEY ?? env.JEV_API_KEY;
  if (apiKey) config.apiKey = apiKey;
  const goal = stringOption(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** One line describing where decisions come from, for logs and the README. */
export function describeConfig(config: PluginConfig): string {
  return `${transportLabel(config.transport)} (state ≤${config.maxStateTokens}, request ≤${config.maxRequestTokens})`;
}
