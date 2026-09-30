import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, fullOutputNote, RAIL_FLOOR, reductionRatio, resolveOptions } from '../src/compact.js';
import { redactSecrets } from '../src/secrets.js';
import { estimateTokens } from '../src/state.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CallAnswer,
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
  model: DEFAULT_MODEL,
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
  model: string;
  /** Save the full output of every reduced result under `<cwd>/.claude/fast-jev/<session>/`. Default true. */
  saveFullOutputs: boolean;
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
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    saveFullOutputs: options.saveFullOutputs !== false,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
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

// Jev's answers by tool_use_id (globally unique), kept for the life of the hook module: a re-compaction of the same
// session does not ask about calls it already decided. ponytail: in-memory, capped; lost on restart, which only
// costs the requests it would have saved.
const knownAnswers = new Map<string, CallAnswer>();
const KNOWN_CAP = 20_000;

/** Clears the remembered answers (tests; a fresh session never needs it: tool_use_ids do not repeat). */
export function forgetAnswers(): void {
  knownAnswers.clear();
}

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
/** The context window's fill, as `$.session.usage().context` has it. */
export type WindowUsage = { tokens?: number; window?: number };

export type Pressure = {
  /** The char reduction the rails must reach. */
  minReduction: number;
  /** The reduction below which the hook falls back to the built-in summary. */
  gate: number;
};

/**
 * How much a compaction must free: enough to bring the context back to `compactAtPercent − 10` of the window, and
 * accepted when it lands at or below `compactAtPercent − 5`. A fixed minimum (the old 30% rails floor, 25% gate) made
 * repeated compactions of one session cut more than the window needed and fall back to the summary once kept facts
 * filled it; in a simulated session one window long this keeps 97.0% of 336 preregistered facts against 92.6%. The
 * part of the context outside the transcript (system prompt, tools) does not shrink: it is the window's token count
 * minus the transcript's own estimate. Without usage figures the fixed defaults apply.
 */
export function pressure(usage: WindowUsage | undefined, transcriptTokens: number, config: HookConfig): Pressure {
  if (!usage?.tokens || !usage.window || transcriptTokens <= 0) {
    return { minReduction: RAIL_FLOOR, gate: config.minReductionRatio };
  }
  const overhead = Math.max(0, usage.tokens - transcriptTokens);
  const need = (percent: number) => 1 - ((percent / 100) * usage.window! - overhead) / transcriptTokens;
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  return {
    minReduction: clamp(need(config.compactAtPercent - 10), 0.05, 0.9),
    gate: clamp(need(config.compactAtPercent - 5), 0, 0.9),
  };
}

/** Estimated tokens of a transcript's texts, tool inputs and tool results. */
export function transcriptTokens(messages: readonly SessionMessage[]): number {
  let total = 0;
  for (const message of messages as readonly Message[]) {
    total += estimateTokens(message.text ?? '');
    for (const use of message.toolUses ?? []) total += estimateTokens(JSON.stringify(use.input ?? {}));
    for (const result of message.toolResults ?? []) total += estimateTokens(result.text ?? '');
  }
  return total;
}

export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  minReduction?: number,
  offload?: { dir: string; fs: OffloadFs },
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), {
    ...config,
    knownAnswers,
    ...(minReduction === undefined ? {} : { minReduction }),
  });
  for (const id of knownAnswers.keys()) {
    if (knownAnswers.size <= KNOWN_CAP) break;
    knownAnswers.delete(id);
  }
  const kept = offload ? await offloadOutputs(messages, result.messages, offload.dir, offload.fs) : result.messages;
  return { result: { ...result, messages: kept }, messages: toSessionMessages(messages, kept) };
}

/**
 * Before a fallback to the built-in summary: every tool output longer than 200 chars goes to `<dir>/<tool_use_id>.txt`,
 * with an index (id, tool, brief input, size); returns the line the summarizer is given, or undefined when a write
 * fails (the summary then goes ahead without it).
 */
export async function saveForSummary(messages: readonly SessionMessage[], dir: string, fs: OffloadFs): Promise<string | undefined> {
  const uses = new Map<string, ToolUse>();
  for (const message of messages as readonly Message[]) for (const use of message.toolUses ?? []) uses.set(use.tool_use_id, use);
  const index: string[] = [];
  try {
    await fs.write(`${dir.replace(/[\\/][^\\/]+[\\/]?$/, '')}/.gitignore`, '*\n');
    for (const message of messages as readonly Message[]) {
      for (const result of message.toolResults ?? []) {
        if (result.text.length < 200) continue;
        await fs.write(`${dir}/${result.tool_use_id.replace(/[^\w.-]/g, '_')}.txt`, redactSecrets(result.text).slice(0, OFFLOAD_MAX_CHARS));
        const use = uses.get(result.tool_use_id);
        index.push(`${result.tool_use_id}\t${use?.tool ?? '?'}\t${JSON.stringify(use?.input ?? {}).slice(0, 160)}\t${result.text.length} chars`);
      }
    }
    if (index.length === 0) return undefined;
    const name = `${dir}/index-${Date.now()}.txt`;
    await fs.write(name, `${index.join('\n')}\n`);
    return `The full outputs of this session's tool calls are saved as files under ${dir}, one per tool_use_id (index: ${name}). Keep this path in the summary so exact outputs can be read back.`;
  } catch {
    return undefined;
  }
}

/** The file writes the offload needs: `$.fs` in the hook, a fake in tests. */
export type OffloadFs = {
  write: (path: string, text: string) => Promise<void>;
  list?: (path: string) => Promise<ReadonlyArray<{ name: string; kind: string; size: number }>>;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
};

/** Saved outputs live as long as Claude Code keeps a transcript by default. */
export const OUTPUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Empties saved outputs older than `maxAgeMs` under `root` (`<cwd>/.claude/fast-jev/cache`). `$.fs` cannot delete, so
 * an expired file is overwritten with nothing; its name (a tool_use_id) stays. Returns how many were emptied.
 */
export async function expireOutputs(root: string, fs: OffloadFs, now: number, maxAgeMs = OUTPUT_MAX_AGE_MS): Promise<number> {
  if (!fs.list || !fs.stat) return 0;
  let emptied = 0;
  try {
    for (const session of await fs.list(root)) {
      if (session.kind !== 'dir') continue;
      for (const file of await fs.list(`${root}/${session.name}`)) {
        if (file.kind !== 'file' || file.size === 0 || !file.name.endsWith('.txt')) continue;
        const path = `${root}/${session.name}/${file.name}`;
        if (now - (await fs.stat(path)).mtimeMs > maxAgeMs) {
          await fs.write(path, '');
          emptied++;
        }
      }
    }
  } catch {
    // a missing root or a refused read: nothing to expire this time
  }
  return emptied;
}

const OFFLOAD_MAX_CHARS = 4_000_000; // $.fs.write rejects over 4 MiB

/**
 * Saves the full output of every result a compaction reduced to `<dir>/<tool_use_id>.txt` and points its note there,
 * so no fact is gone: what the stub does not keep is one Read away. A reproducible read is not saved (a re-run gives
 * it back). A write that fails leaves the note pointing to the transcript. `<dir>/../.gitignore` keeps the files out
 * of git.
 */
export async function offloadOutputs(
  original: readonly SessionMessage[],
  compacted: readonly Message[],
  dir: string,
  fs: OffloadFs,
): Promise<Message[]> {
  const full = new Map<string, string>();
  for (const message of original as readonly Message[]) {
    for (const result of message.toolResults ?? []) full.set(result.tool_use_id, result.text);
  }
  const root = dir.replace(/[\\/][^\\/]+[\\/]?$/, '');
  let ignored = false;
  const out: Message[] = [];
  for (const message of compacted) {
    if (!message.toolResults?.some((result) => result.text.includes(fullOutputNote(result.tool_use_id)))) {
      out.push(message);
      continue;
    }
    const results = [];
    for (const result of message.toolResults) {
      const note = fullOutputNote(result.tool_use_id);
      const text = full.get(result.tool_use_id);
      if (!result.text.includes(note) || text === undefined) {
        results.push(result);
        continue;
      }
      const path = `${dir}/${result.tool_use_id.replace(/[^\w.-]/g, '_')}.txt`;
      try {
        if (!ignored) {
          await fs.write(`${root}/.gitignore`, '*\n');
          ignored = true;
        }
        await fs.write(path, redactSecrets(text).slice(0, OFFLOAD_MAX_CHARS));
        results.push({ ...result, text: result.text.replace(note, `the full output is saved at ${path}; Read it for anything not kept here`) });
      } catch {
        results.push(result);
      }
    }
    out.push({ ...message, toolResults: results });
  }
  return out;
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

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

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

// ponytail: the hook context's type is not exported under a name here; only session.cwd/id and fs.write are used.
// Under `cache/`: backup and index configs commonly skip `**/cache`, and a backup of `~/.claude` that leaves session
// transcripts (`*.jsonl`) out on purpose should leave their saved outputs out too.
let lastExpiry = 0;

async function offloadTarget($: {
  session: { cwd: () => Promise<string>; id: () => Promise<string> };
  fs: {
    write: (path: string, text: string) => Promise<void>;
    list: (path?: string) => Promise<ReadonlyArray<{ name: string; kind: string; size: number }>>;
    stat: (path: string) => Promise<{ mtimeMs: number }>;
  };
}): Promise<{ dir: string; fs: OffloadFs } | undefined> {
  try {
    const [cwd, id] = await Promise.all([$.session.cwd(), $.session.id()]);
    const root = `${cwd.replace(/[\\/]+$/, '')}/.claude/fast-jev/cache`;
    const fs: OffloadFs = {
      write: (path: string, text: string) => $.fs.write(path, text),
      list: (path: string) => $.fs.list(path),
      stat: (path: string) => $.fs.stat(path),
    };
    if (Date.now() - lastExpiry > 24 * 60 * 60 * 1000) {
      lastExpiry = Date.now();
      await expireOutputs(root, fs, Date.now());
    }
    return { dir: `${root}/${id.replace(/[^\w.-]/g, '_')}`, fs };
  } catch {
    return undefined;
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    // A fallback still keeps every output: saved to files, and the summarizer is told where they are.
    const fallback = async (reason: string) => {
      notify($, `fallback to built-in summary (${reason})`);
      const target = configured.saveFullOutputs ? await offloadTarget($) : undefined;
      const note = target ? await saveForSummary(event.messages, target.dir, target.fs) : undefined;
      return next(note ? { ...event, instructions: [event.instructions, note].filter(Boolean).join('\n\n') } : event);
    };
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const usage = await $.session.usage().then(
        (u) => u.context,
        () => undefined,
      );
      const needed = pressure(usage, transcriptTokens(event.messages), config);
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        needed.minReduction,
        config.saveFullOutputs ? await offloadTarget($) : undefined,
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < needed.gate) {
        return fallback(`below the ${percent(needed.gate)} this window needs: ${summarize(result)}`);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      return fallback(error instanceof Error ? error.message : String(error));
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
