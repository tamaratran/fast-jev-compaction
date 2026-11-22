import { SYSTEM_ONE_URL } from './request.js';
import type { ResolvedCompactOptions } from './types.js';

/** OpenCode Console route: the free Jev tier and the paid `jev-1.13` live here. */
export const OPENCODE_CONSOLE_URL = 'https://opencode.ai/inference/systemone/v1/systemone';
/** OpenCode Go route, for a session-scoped subscription request. */
export const OPENCODE_GO_URL = 'https://opencode.ai/inference/go/systemone/v1/systemone';

/** The Jev model behind OpenCode's decision route, billed per call (paid tier). */
export const OPENCODE_PAID_MODEL = 'jev-1.13';
/** The free Jev model behind OpenCode's decision route. */
export const OPENCODE_FREE_MODEL = 'jev-1.13-free';

/** A model served by the host's provider runtime (OpenCode's decision route). */
export interface ProviderTransport {
  kind: 'provider';
  providerID: string;
  modelID: string;
  /** Total request budget the model can take, when it is smaller than Jev's ~32k. */
  contextWindow?: number;
}

/** Any server that speaks `POST /v1/systemone`: TypeSafe, OpenCode's route, a local model. */
export interface HttpTransport {
  kind: 'http';
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Extra headers, such as OpenCode's `x-opencode-session`. */
  headers?: Record<string, string>;
  /** Total request budget the model can take, when it is smaller than Jev's ~32k. */
  contextWindow?: number;
}

export type JevTransport = ProviderTransport | HttpTransport;

/**
 * Named transports. `opencode-free` is the default because that is the tier a
 * Console connection serves without billing; `opencode-paid` bills per call in
 * dollars. The local presets assume the port each server documents.
 */
export const PRESETS: Record<string, JevTransport> = {
  'opencode-free': {
    kind: 'provider',
    providerID: 'opencode',
    modelID: OPENCODE_FREE_MODEL,
  },
  'opencode-paid': {
    kind: 'provider',
    providerID: 'opencode',
    modelID: OPENCODE_PAID_MODEL,
  },
  'opencode-http-free': {
    kind: 'http',
    baseUrl: OPENCODE_CONSOLE_URL,
    model: OPENCODE_FREE_MODEL,
  },
  'opencode-go-free': {
    kind: 'http',
    baseUrl: OPENCODE_GO_URL,
    model: OPENCODE_FREE_MODEL,
  },
  typesafe: {
    kind: 'http',
    baseUrl: SYSTEM_ONE_URL,
    model: 'jev-latest',
  },
  /** `pip install "laya[serve]" && LAYA_PRELOAD=1 laya-serve`. */
  laya: {
    kind: 'http',
    baseUrl: 'http://127.0.0.1:8000/v1/systemone',
    model: 'laya-typed-decisions',
    contextWindow: 320,
  },
  /** OpenJev served by `wev serve` (or any OpenAI-compatible systemone shim). */
  openjev: {
    kind: 'http',
    baseUrl: 'http://127.0.0.1:8009/v1/systemone',
    model: 'openjev-1.7b',
    contextWindow: 32_000,
  },
  /** Vega through the `/v1/decide` shim in `bench/`; 73k context. */
  vega: {
    kind: 'http',
    baseUrl: 'http://127.0.0.1:8010/v1/systemone',
    model: 'vega-0.8b',
    contextWindow: 73_000,
  },
};

/** One line per preset, for `--help` output and the README. */
export const PRESET_NOTES: Record<string, string> = {
  'opencode-free': 'free Jev through OpenCode Console (needs a connected opencode provider)',
  'opencode-paid': 'Jev 1.13 through OpenCode Console, billed in dollars per call',
  'opencode-http-free': 'free Jev over HTTP; needs an OpenCode Console key',
  'opencode-go-free': 'Go route; needs x-opencode-session and the model on the plan',
  typesafe: 'TypeSafe System One; needs TYPESAFE_API_KEY',
  laya: 'Laya on 127.0.0.1:8000; ~320-token state, expect fallbacks',
  openjev: 'OpenJev on 127.0.0.1:8009',
  vega: 'Vega on 127.0.0.1:8010 through the systemone shim',
};

export type TransportEnv = Record<string, string | undefined>;

function envFirst(env: TransportEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function presetNamed(name: string): JevTransport {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(
      `unknown Jev transport '${name}'; known: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  return { ...preset };
}

function httpTransport(baseUrl: string, env: TransportEnv): HttpTransport {
  return {
    kind: 'http',
    baseUrl,
    model: envFirst(env, ['FAST_JEV_MODEL', 'JEV_MODEL']) ?? 'jev-latest',
  };
}

/**
 * Turns a preset name, a URL or an explicit transport into one transport, with
 * environment overrides applied last:
 *
 * - `FAST_JEV_TRANSPORT` (or `JEV_TRANSPORT`): default preset name
 * - `FAST_JEV_PROVIDER`, `FAST_JEV_MODEL_ID`: provider transport
 * - `FAST_JEV_BASE_URL`, `FAST_JEV_MODEL`, `FAST_JEV_API_KEY`: HTTP transport
 */
export function resolveTransport(
  input?: string | JevTransport,
  env: TransportEnv = process.env,
): JevTransport {
  const requested =
    input ??
    envFirst(env, ['FAST_JEV_TRANSPORT', 'JEV_TRANSPORT']) ??
    'opencode-free';
  let transport: JevTransport;
  if (typeof requested !== 'string') {
    transport = { ...requested };
  } else if (/^https?:\/\//u.test(requested)) {
    transport = httpTransport(requested, env);
  } else {
    transport = presetNamed(requested);
  }

  const baseUrl = envFirst(env, ['FAST_JEV_BASE_URL', 'JEV_BASE_URL']);
  const apiKey = envFirst(env, ['FAST_JEV_API_KEY', 'JEV_API_KEY']);
  if (transport.kind === 'http') {
    if (baseUrl) transport.baseUrl = baseUrl;
    if (apiKey) transport.apiKey = apiKey;
    if (transport.model === 'jev-latest') {
      const model = envFirst(env, ['FAST_JEV_MODEL', 'JEV_MODEL']);
      if (model) transport.model = model;
    }
    return transport;
  }

  const providerID = envFirst(env, ['FAST_JEV_PROVIDER', 'JEV_PROVIDER']);
  const modelID = envFirst(env, ['FAST_JEV_MODEL_ID', 'JEV_MODEL_ID']);
  if (providerID) transport.providerID = providerID;
  if (modelID) transport.modelID = modelID;
  return transport;
}

/** A short `provider/model` or `model@host` label for logs and reports. */
export function transportLabel(transport: JevTransport): string {
  if (transport.kind === 'provider') {
    return `${transport.providerID}/${transport.modelID}`;
  }
  const host = transport.baseUrl.replace(/^https?:\/\//u, '');
  return `${transport.model}@${host}`;
}

const DEFAULT_REQUEST_TOKENS = 30_000;
const DEFAULT_STATE_TOKENS = 25_000;

/**
 * The request ceilings for a transport. A model with a small window (Laya is
 * ~320 tokens) needs the state fitted much harder; the engine's usual 25k/30k
 * would be silently truncated by the server.
 */
export function transportLimits(transport: JevTransport): {
  maxStateTokens: number;
  maxRequestTokens: number;
} {
  const window = transport.contextWindow;
  if (!window || window <= 0) {
    return {
      maxStateTokens: DEFAULT_STATE_TOKENS,
      maxRequestTokens: DEFAULT_REQUEST_TOKENS,
    };
  }
  const request = Math.max(96, Math.floor(window * 0.95));
  return {
    maxRequestTokens: request,
    maxStateTokens: Math.max(48, Math.floor(request * 0.6)),
  };
}

/** Applies the transport's ceilings to compaction options that did not set their own. */
export function withTransportLimits(
  options: Partial<ResolvedCompactOptions>,
  transport: JevTransport,
): Partial<ResolvedCompactOptions> {
  const limits = transportLimits(transport);
  return {
    ...options,
    maxStateTokens: options.maxStateTokens ?? limits.maxStateTokens,
    maxRequestTokens: options.maxRequestTokens ?? limits.maxRequestTokens,
  };
}
