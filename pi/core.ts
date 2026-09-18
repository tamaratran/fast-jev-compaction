/**
 * core.ts — pure logic for the fast-jev-compaction pi extension.
 *
 * Only type-only imports from the pi package (erased at runtime; pi itself
 * provides the module when it loads the extension), so this module can be
 * unit-tested outside pi with plain vitest.
 *
 * Mapping onto pi's compaction model:
 *   pi replaces the context with  summary + real messages from firstKeptEntryId.
 *   We keep pi's kept window untouched and write the OLD region into the
 *   summary as a verbatim serialized transcript, minus the tool calls/results
 *   Jev drops or truncates. Nothing is ever rewritten by an LLM.
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectToolCalls, compact, messageChars } from '../src/index.js';
import type {
  CallDecision,
  CompactResult,
  JevAsker,
  Message as JevMessage,
  ToolCall,
  ToolResult,
  ToolUse,
} from '../src/index.js';

export const EXTENSION_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FastJevUserConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /**
   * Estimated token ceiling for the Jev state. UNSET = unlimited (the
   * whole conversation goes to Jev). Set a finite number only to force
   * a hard ceiling.
   */
  maxStateTokens?: number;
  /**
   * Estimated ceiling for state plus one batch of questions. UNSET =
   * unlimited. Set a finite number only to force batching.
   */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result retained before its note. Default 300. */
  truncateHeadChars?: number;
  /**
   * Minimum char reduction required within the old region for the Jev result
   * to be used; below this we fall back to pi's built-in summary. Default 0.25.
   */
  minOldReduction?: number;
  /** Drop assistant thinking blocks from the compacted transcript. Default false. */
  dropThinking?: boolean;
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Show toast notifications. Default true. */
  notify?: boolean;
  /** Kill switch: disable the extension entirely. Default false. */
  disabled?: boolean;
}

export interface ResolvedFastJevConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  keepThreshold: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  minOldReduction: number;
  dropThinking: boolean;
  goal?: string;
  notify: boolean;
  disabled: boolean;
}

// State/request ceilings default to UNLIMITED (Infinity): a hardcoded 25k
// cap turned every long session into a built-in-summary fallback — exactly
// the sessions where Jev compaction matters most. Explicit finite values
// (config file, env) still honored. Mirrors src/compact.ts DEFAULT_OPTIONS.
export const FAST_JEV_DEFAULTS: ResolvedFastJevConfig = {
  keepThreshold: 0.5,
  maxStateTokens: Number.POSITIVE_INFINITY,
  maxRequestTokens: Number.POSITIVE_INFINITY,
  truncateHeadChars: 300,
  minOldReduction: 0.25,
  dropThinking: false,
  notify: true,
  disabled: false,
};

const CONFIG_FILENAME = 'fast-jev-compaction.json';

/**
 * pi's standard credential store (~/.pi/agent/auth.json, 0600 — the same
 * file /login writes). Read synchronously: loadConfig is sync and this
 * runs once per compaction. Returns the `typesafe` entry's key or undefined.
 * Survives GUI/IDE launches that never source ~/.zshrc (empty env).
 */
function readPiAuthKey(): string | undefined {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return undefined;
    const raw = readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8');
    const key = (JSON.parse(raw) as Record<string, { key?: unknown }>)[
      'typesafe'
    ]?.key;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function envBool(env: Record<string, string | undefined>, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  return /^(1|true|yes|on)$/i.test(value);
}

function envNumber(env: Record<string, string | undefined>, name: string): number | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pickNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickBool(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Config precedence (later wins): defaults → global config file → project
 * config file → environment variables.
 */
export function loadConfig(sources: {
  agentDir: string;
  cwd: string;
  configDirName: string;
  env: Record<string, string | undefined>;
}): ResolvedFastJevConfig {
  const fileConfig: Record<string, unknown> = {
    ...readJsonFile(join(sources.agentDir, CONFIG_FILENAME)),
    ...readJsonFile(join(sources.cwd, sources.configDirName, CONFIG_FILENAME)),
  };
  const env = sources.env;

  const config: ResolvedFastJevConfig = {
    apiKey:
      pickString(fileConfig, 'apiKey') ??
      env.FAST_JEV_API_KEY ??
      env.TYPESAFE_API_KEY ??
      readPiAuthKey(),
    model: pickString(fileConfig, 'model') ?? env.FAST_JEV_MODEL,
    baseUrl: pickString(fileConfig, 'baseUrl') ?? env.FAST_JEV_BASE_URL,
    keepThreshold: pickNumber(fileConfig, 'keepThreshold') ?? FAST_JEV_DEFAULTS.keepThreshold,
    maxStateTokens: pickNumber(fileConfig, 'maxStateTokens') ?? FAST_JEV_DEFAULTS.maxStateTokens,
    maxRequestTokens:
      pickNumber(fileConfig, 'maxRequestTokens') ?? FAST_JEV_DEFAULTS.maxRequestTokens,
    truncateHeadChars:
      pickNumber(fileConfig, 'truncateHeadChars') ?? FAST_JEV_DEFAULTS.truncateHeadChars,
    minOldReduction:
      pickNumber(fileConfig, 'minOldReduction') ?? FAST_JEV_DEFAULTS.minOldReduction,
    dropThinking: pickBool(fileConfig, 'dropThinking') ?? FAST_JEV_DEFAULTS.dropThinking,
    goal: pickString(fileConfig, 'goal') ?? env.FAST_JEV_GOAL,
    notify: pickBool(fileConfig, 'notify') ?? FAST_JEV_DEFAULTS.notify,
    disabled: pickBool(fileConfig, 'disabled') ?? FAST_JEV_DEFAULTS.disabled,
  };

  const envKeep = envNumber(env, 'FAST_JEV_KEEP_THRESHOLD');
  if (envKeep !== undefined) config.keepThreshold = envKeep;
  const envState = envNumber(env, 'FAST_JEV_MAX_STATE_TOKENS');
  if (envState !== undefined) config.maxStateTokens = envState;
  const envRequest = envNumber(env, 'FAST_JEV_MAX_REQUEST_TOKENS');
  if (envRequest !== undefined) config.maxRequestTokens = envRequest;
  const envTruncate = envNumber(env, 'FAST_JEV_TRUNCATE_HEAD_CHARS');
  if (envTruncate !== undefined) config.truncateHeadChars = envTruncate;
  const envMinReduction = envNumber(env, 'FAST_JEV_MIN_OLD_REDUCTION');
  if (envMinReduction !== undefined) config.minOldReduction = envMinReduction;
  const envDropThinking = envBool(env, 'FAST_JEV_DROP_THINKING');
  if (envDropThinking !== undefined) config.dropThinking = envDropThinking;
  const envNotify = envBool(env, 'FAST_JEV_NOTIFY');
  if (envNotify !== undefined) config.notify = envNotify;
  const envDisabled = envBool(env, 'FAST_JEV_DISABLE');
  if (envDisabled !== undefined) config.disabled = envDisabled;

  return config;
}

// ---------------------------------------------------------------------------
// Branch conversion (pi session entries → fast-jev messages)
// ---------------------------------------------------------------------------

/** Extra per-message info that does not fit the fast-jev Message shape. */
export interface MsgMeta {
  /** Assistant thinking blocks, concatenated. */
  thinking?: string;
  /** Tool names parallel to toolResults. */
  toolNames: string[];
}

export interface BranchTranscript {
  /** Whole branch as fast-jev messages, oldest first. */
  messages: JevMessage[];
  /** Metas parallel to `messages`. */
  metas: MsgMeta[];
  /** Messages derived from entries older than firstKeptEntryId. */
  oldCount: number;
}

/** Mirrors pi's BRANCH_SUMMARY_PREFIX/SUFFIX so branch context reads the same. */
const BRANCH_SUMMARY_PREFIX =
  'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n';
const BRANCH_SUMMARY_SUFFIX = '\n</summary>';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  let images = 0;
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      parts.push((part as { text: string }).text);
    } else {
      images++;
    }
  }
  if (images > 0) parts.push(`[${images} image${images === 1 ? '' : 's'} omitted]`);
  return parts.join('\n');
}

/** Local reimplementation of pi's bashExecutionToText. */
export function bashExecutionToText(msg: {
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}): string {
  let text = `Ran \`${msg.command}\`\n`;
  text += msg.output ? '```\n' + msg.output + '\n```' : '(no output)';
  if (msg.cancelled) {
    text += '\n\n(command cancelled)';
  } else if (msg.exitCode !== undefined && msg.exitCode !== null && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

/**
 * Converts the whole session branch (all entries; entries are append-only
 * history) into fast-jev messages. Compaction entries are skipped: their
 * content is a view of branch messages we already include verbatim. Branch
 * summaries are kept (their source branches are not on this path).
 *
 * Returns undefined when firstKeptEntryId is not on the branch.
 */
export function convertBranch(
  branchEntries: readonly SessionEntry[],
  firstKeptEntryId: string,
): BranchTranscript | undefined {
  const keptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (keptIndex < 0) return undefined;

  const messages: JevMessage[] = [];
  const metas: MsgMeta[] = [];
  let oldCount = 0;

  const push = (message: JevMessage, meta: MsgMeta = { toolNames: [] }): void => {
    messages.push(message);
    metas.push(meta);
  };

  for (let i = 0; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (!entry) continue;
    const before = messages.length;

    if (entry.type === 'message') {
      const m = entry.message;
      switch (m.role) {
        case 'user': {
          const text = contentText(m.content);
          if (text.length > 0) push({ role: 'user', text, toolUses: [] });
          break;
        }
        case 'assistant': {
          let text = '';
          let thinking = '';
          const toolUses: ToolUse[] = [];
          for (const block of m.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              text = text ? `${text}\n${block.text}` : block.text;
            } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
              thinking = thinking ? `${thinking}\n${block.thinking}` : block.thinking;
            } else if (block.type === 'toolCall') {
              toolUses.push({
                tool_use_id: block.id,
                tool: block.name,
                input: block.arguments,
              });
            }
          }
          if (text.length > 0 || toolUses.length > 0) {
            push(
              { role: 'assistant', text, toolUses },
              { toolNames: [], thinking: thinking.length > 0 ? thinking : undefined },
            );
          }
          break;
        }
        case 'toolResult': {
          const text = contentText(m.content);
          const toolResults: ToolResult[] = [
            { tool_use_id: m.toolCallId, text, isError: m.isError },
          ];
          push({ role: 'user', text: '', toolUses: [], toolResults }, { toolNames: [m.toolName] });
          break;
        }
        case 'bashExecution': {
          if (m.excludeFromContext) break;
          push({ role: 'user', text: bashExecutionToText(m), toolUses: [] });
          break;
        }
        case 'custom': {
          const text = contentText(m.content);
          if (text.length > 0) push({ role: 'user', text, toolUses: [] });
          break;
        }
        case 'branchSummary': {
          push({
            role: 'user',
            text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX,
            toolUses: [],
          });
          break;
        }
        case 'compactionSummary': {
          // Derived view of branch messages we already include verbatim; skip.
          break;
        }
        default:
          break;
      }
    } else if (entry.type === 'branch_summary') {
      push({
        role: 'user',
        text: BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX,
        toolUses: [],
      });
    }
    // compaction / model-change / other entry types: skip.

    if (i < keptIndex) oldCount += messages.length - before;
  }

  return { messages, metas, oldCount };
}

// ---------------------------------------------------------------------------
// Serialization of the old region with Jev decisions applied
// ---------------------------------------------------------------------------

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable input]';
  }
}

/** Same truncation format as the library's truncatedResultText. */
function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

export interface SerializedOld {
  text: string;
  charsBefore: number;
  charsAfter: number;
  /** Messages that survived with any content. */
  messagesKept: number;
}

/**
 * Serializes the old region verbatim, applying Jev's decisions: dropped calls
 * and their results disappear; dropped results keep a bounded head plus note;
 * everything else is reproduced word-for-word.
 */
export function serializeOldRegion(
  transcript: BranchTranscript,
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  opts: { truncateHeadChars: number; dropThinking: boolean },
): SerializedOld {
  const callByDecisionId = new Map(calls.map((call) => [call.id, call]));
  const actionByToolUseId = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = callByDecisionId.get(decision.id);
    if (call) actionByToolUseId.set(call.tool_use_id, decision.action);
  }

  const chunks: string[] = [];
  let charsAfter = 0;
  let messagesKept = 0;

  for (let i = 0; i < transcript.oldCount; i++) {
    const message = transcript.messages[i];
    const meta = transcript.metas[i];
    if (!message || !meta) continue;
    const parts: string[] = [];

    if (message.role === 'assistant') {
      if (!opts.dropThinking && meta.thinking) {
        parts.push(`[Assistant thinking]\n${meta.thinking}`);
        charsAfter += meta.thinking.length;
      }
      if (message.text.length > 0) {
        parts.push(`[Assistant]\n${message.text}`);
        charsAfter += message.text.length;
      }
      for (const use of message.toolUses) {
        if (actionByToolUseId.get(use.tool_use_id) === 'drop_call') continue;
        const inputJson = safeJson(use.input);
        parts.push(`[Tool call ${use.tool}]\n${inputJson}`);
        charsAfter += inputJson.length;
      }
    } else {
      if (message.text.length > 0) {
        parts.push(`[User]\n${message.text}`);
        charsAfter += message.text.length;
      }
      const results = message.toolResults ?? [];
      for (let r = 0; r < results.length; r++) {
        const result = results[r];
        if (!result) continue;
        const action = actionByToolUseId.get(result.tool_use_id) ?? 'keep';
        if (action === 'drop_call') continue;
        const toolName = meta.toolNames[r] ?? 'tool';
        if (action === 'drop_result') {
          const truncated = truncatedResultText(
            result.text,
            result.isError ?? false,
            opts.truncateHeadChars,
          );
          parts.push(`[Tool result ${toolName} — truncated]\n${truncated}`);
          charsAfter += truncated.length;
        } else {
          parts.push(
            `[Tool result ${toolName} — verbatim, ${result.text.length} chars]\n${result.text}`,
          );
          charsAfter += result.text.length;
        }
      }
    }

    if (parts.length > 0) {
      chunks.push(parts.join('\n\n'));
      messagesKept++;
    }
  }

  const charsBefore = transcript.messages
    .slice(0, transcript.oldCount)
    .reduce((sum, message) => sum + messageChars(message), 0);

  return { text: chunks.join('\n\n'), charsBefore, charsAfter, messagesKept };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Structural subset of pi-ai's Usage (fields pi's CompactionResult.usage needs). */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface FastJevDetails {
  fastJev: {
    version: string;
    oldMessages: number;
    pinnedMessages: number;
    oldCharsBefore: number;
    oldCharsAfter: number;
    oldReduction: number;
    jev: {
      requests: number;
      stateTokens: number;
      stateStage: string;
      inputTokens: number;
      outputTokens: number;
      ms: number;
    };
    decisions: Array<{
      id: string;
      tool: string;
      action: string;
      keepCall: number;
      keepResult: number;
    }>;
  };
}

export interface FastJevSuccess {
  ok: true;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: PiUsage;
  details: FastJevDetails;
  oldReduction: number;
  report: string;
}

export interface FastJevFallback {
  ok: false;
  fallback: string;
}

const SUMMARY_HEADER = `<fast-jev-compaction>
Earlier history preserved as a verbatim transcript; no LLM summary was written.
Tool calls and tool results a Jev decision model judged no longer necessary were removed or truncated (each truncation is marked); all other content is reproduced word-for-word, oldest first, up to where the recent unmodified messages begin.
</fast-jev-compaction>`;

/**
 * Runs the full fast-jev compaction for one pi compaction event.
 *
 * - Reconstructs the whole branch, pinning everything from firstKeptEntryId
 *   onwards (pi's kept window stays as real messages).
 * - Asks Jev about every non-pinned tool call/result via `asker`.
 * - Serializes the old region verbatim with the decisions applied.
 *
 * Returns a fallback (with reason) instead of throwing when Jev cannot be
 * used or cannot reduce the old region enough; the caller falls back to pi's
 * built-in compaction. Aborts surface as { ok: false, fallback: "..." }.
 */
export async function jevCompactionForPi(params: {
  branchEntries: readonly SessionEntry[];
  firstKeptEntryId: string;
  tokensBefore: number;
  asker: JevAsker;
  config: ResolvedFastJevConfig;
}): Promise<FastJevSuccess | FastJevFallback> {
  const { branchEntries, firstKeptEntryId, tokensBefore, asker, config } = params;

  const transcript = convertBranch(branchEntries, firstKeptEntryId);
  if (!transcript) {
    return { ok: false, fallback: 'firstKeptEntryId not found on branch' };
  }
  if (transcript.oldCount === 0) {
    return { ok: false, fallback: 'nothing to compact before the kept window' };
  }

  const pinnedCount = Math.max(0, transcript.messages.length - transcript.oldCount);
  let inputTokens = 0;
  let outputTokens = 0;
  const countingAsker: JevAsker = {
    ask: async (state, questions) => {
      const response = await asker.ask(state, questions);
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      return response;
    },
  };

  let result: CompactResult;
  try {
    result = await compact(transcript.messages, countingAsker, {
      goal: config.goal,
      keepThreshold: config.keepThreshold,
      preserveRecentMessages: pinnedCount,
      maxStateTokens: config.maxStateTokens,
      maxRequestTokens: config.maxRequestTokens,
      truncateHeadChars: config.truncateHeadChars,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, fallback: `Jev failed: ${message}` };
  }

  const candidates = result.decisions.filter((d) => d.reason !== 'pinned');
  if (candidates.length === 0) {
    return { ok: false, fallback: 'no tool calls to evaluate' };
  }

  // Same calls list compact() built internally (same messages, same pinning),
  // to map decision ids (t1, t2, …) back onto tool_use_ids.
  const calls = collectToolCalls(transcript.messages, pinnedCount);
  const serialized = serializeOldRegion(transcript, result.decisions, calls, {
    truncateHeadChars: config.truncateHeadChars,
    dropThinking: config.dropThinking,
  });

  const oldReduction =
    serialized.charsBefore === 0
      ? 0
      : (serialized.charsBefore - serialized.charsAfter) / serialized.charsBefore;

  if (oldReduction < config.minOldReduction) {
    return {
      ok: false,
      fallback: `insufficient reduction (${Math.round(oldReduction * 100)}% < ${Math.round(
        config.minOldReduction * 100,
      )}%)`,
    };
  }

  const stats = result.stats;
  const details: FastJevDetails = {
    fastJev: {
      version: EXTENSION_VERSION,
      oldMessages: transcript.oldCount,
      pinnedMessages: pinnedCount,
      oldCharsBefore: serialized.charsBefore,
      oldCharsAfter: serialized.charsAfter,
      oldReduction,
      jev: {
        requests: stats.requests,
        stateTokens: stats.stateTokens,
        stateStage: stats.stateStage,
        inputTokens,
        outputTokens,
        ms: stats.ms,
      },
      decisions: candidates.map((d) => ({
        id: d.id,
        tool: d.tool,
        action: d.action,
        keepCall: Math.round(d.keepCall * 100) / 100,
        keepResult: Math.round(d.keepResult * 100) / 100,
      })),
    },
  };

  const usage: PiUsage | undefined =
    inputTokens + outputTokens > 0
      ? {
          input: inputTokens,
          output: outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: inputTokens + outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }
      : undefined;

  const report =
    `fast-jev: ${Math.round(oldReduction * 100)}% of old region pruned, ` +
    `${serialized.messagesKept}/${transcript.oldCount} old messages kept, ` +
    `${stats.kept + stats.pinned}/${stats.calls} tool calls kept, ` +
    `${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped ` +
    `(${stats.requests} Jev request${stats.requests === 1 ? '' : 's'}, no LLM summary)`;

  return {
    ok: true,
    summary: `${SUMMARY_HEADER}\n\n${serialized.text}`,
    firstKeptEntryId,
    tokensBefore,
    usage,
    details,
    oldReduction,
    report,
  };
}
