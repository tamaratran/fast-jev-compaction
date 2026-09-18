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
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import { goalFromMessages } from '../src/state.js';
import { trimOutput } from '../src/output.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  archiveResults: true,
  bashOutput: false,
  bashOutputMinChars: 4_000,
  bashOutputChunkLines: 20,
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
  bashOutput: boolean;
  bashOutputMinChars: number;
  bashOutputChunkLines: number;
  archiveResults: boolean;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionBoolean(options: PluginOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
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
    bashOutput: optionBoolean(options, 'bashOutput', HOOK_DEFAULTS.bashOutput),
    bashOutputMinChars: optionNumber(
      options,
      'bashOutputMinChars',
      HOOK_DEFAULTS.bashOutputMinChars,
    ),
    bashOutputChunkLines: optionNumber(
      options,
      'bashOutputChunkLines',
      HOOK_DEFAULTS.bashOutputChunkLines,
    ),
    archiveResults:
      typeof options.archiveResults === 'boolean'
        ? options.archiveResults
        : HOOK_DEFAULTS.archiveResults,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
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

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  archive?: ArchiveWriter,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), {
    ...config,
    ...(archive ? { archive: archive.cite } : {}),
  });
  if (archive) await archive.flush();
  return { result, messages: toSessionMessages(messages, result.messages) };
}

export type ArchiveWriter = {
  /** Names the file a dropped result will be written to, for its marker. */
  cite: (toolUseId: string, text: string) => string | undefined;
  /** Writes the files named so far. */
  flush: () => Promise<void>;
};

/**
 * Saves the tool results compaction drops, so a detail buried in one can be
 * read back later instead of being lost. Credentials are never written.
 */
export function archiveWriter($: {
  fs: { exists: (path: string) => Promise<boolean>; write: (path: string, text: string) => Promise<void> };
}): ArchiveWriter {
  const pending = new Map<string, string>();
  return {
    cite(toolUseId, text) {
      if (!text || looksSecret('', text)) return undefined;
      const path = `${ARCHIVE_DIR}/result-${toolUseId}.txt`;
      pending.set(path, text);
      return path;
    },
    async flush() {
      if (pending.size === 0) return;
      const ignorePath = `${ARCHIVE_DIR}/.gitignore`;
      if (!(await $.fs.exists(ignorePath))) await $.fs.write(ignorePath, '*\n');
      for (const [path, text] of pending) await $.fs.write(path, text);
      pending.clear();
    },
  };
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
const ARCHIVE_DIR = '.claude/fast-jev-compaction';

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

const SECRET_COMMAND =
  /(^|[|;&]\s*)(printenv|env)\b|\.env\b|\b(secret|secrets|credential|credentials|password|token|keychain|netrc|id_rsa|private[_-]?key)\b/i;
const SECRET_OUTPUT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(aws_secret_access_key|api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*\S|:\/\/[^\s:@/]+:[^\s:@/]+@/i;

/** True when the command or its output looks like it carries credentials. */
export function looksSecret(command: string, output: string): boolean {
  return SECRET_COMMAND.test(command) || SECRET_OUTPUT.test(output.slice(0, 20_000));
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

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  if (configured.bashOutput) {
    on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
      const answer = await next(event);
      try {
        if (answer.deny !== undefined || answer.isError || !answer.result) return answer;
        const record = answer.result;
        if ('persistedOutputPath' in record && record.persistedOutputPath) return answer;
        const combined = record.stdout + (record.stderr ? `\n${record.stderr}` : '');
        if (combined.length <= configured.bashOutputMinChars) return answer;
        const apiKey = await getApiKey($, configured);
        if (!apiKey) return answer;
        const goal = goalFromMessages(await $.session.messages());
        // Secrets are never written to disk; such output is still trimmed, but
        // the marker tells the agent to re-run the command instead of pointing
        // at a file that would outlive the session.
        const secret = looksSecret(event.command, combined);
        const path = secret
          ? undefined
          : `${ARCHIVE_DIR}/bash-${event.tool_use_id ?? Date.now()}.txt`;
        const trimmed = await trimOutput(
          {
            command: event.command,
            goal,
            output: record.stdout,
            fullOutputPath: path,
          },
          jevAsker(
            async (url, init) => {
              const response = await $.http.fetch(url, init);
              return { status: response.status, ok: response.ok, text: response.text };
            },
            apiKey,
            configured.model,
          ),
          {
            minChars: configured.bashOutputMinChars,
            chunkLines: configured.bashOutputChunkLines,
            keepThreshold: configured.keepThreshold,
            maxStateTokens: configured.maxStateTokens,
          },
        );
        if (!trimmed.trimmed) return answer;
        // Written only now, so output that ends up untrimmed leaves nothing behind.
        if (path) {
          const ignorePath = `${ARCHIVE_DIR}/.gitignore`;
          if (!(await $.fs.exists(ignorePath))) await $.fs.write(ignorePath, '*\n');
          await $.fs.write(path, combined);
        }
        const scores = trimmed.scores.map((score) => score.toFixed(2)).join(',');
        $.ui.log(
          `bash output: kept ${trimmed.kept}/${trimmed.chunks} chunks (${trimmed.charsBefore}→${trimmed.charsAfter} chars) scores=${scores}`,
        );
        $.ui.toast(
          `trimmed Bash output ${trimmed.charsBefore}→${trimmed.charsAfter} chars`,
          { timeoutMs: 8_000 },
        );
        return { result: { ...record, stdout: trimmed.output } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        $.ui.log(`bash output trim skipped (${message})`);
        return answer;
      }
    });
  }

  on('session.compact', async ($, event, next) => {
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        config.archiveResults ? archiveWriter($) : undefined,
      );
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
