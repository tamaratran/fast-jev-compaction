// Minimal TypeScript surface for the pi coding agent extension API
// (@earendil-works/pi-coding-agent), mirroring how types/claude-code.d.ts
// types the Claude Code hook surface.
//
// At run time pi provides these exports itself: extensions load through
// pi's jiti with the package registered as a virtual module, so the npm
// package does not need to be installed. This file exists only for
// typechecking (`npm run typecheck:pi`).
//
// Written against the pi surface the fast-jev-compaction extension uses.
// When pi's extension API changes, extend the declarations here rather
// than adding the package as a dependency; the shapes are taken from the
// installed package's dist/*.d.ts.
//
// Typing an extension against it:
//   import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
//   export default function (pi: ExtensionAPI) { pi.on('session_before_compact', ...) }
//
// A tsconfig that fits a pi extension module (see tsconfig.pi.json):
//   {
//     "compilerOptions": {
//       "target": "es2023", "lib": ["es2023"], "types": ["node"],
//       "module": "esnext", "moduleResolution": "bundler",
//       "strict": true, "noUncheckedIndexedAccess": true,
//       "noEmit": true, "skipLibCheck": true,
//       "baseUrl": ".",
//       "paths": { "@earendil-works/pi-coding-agent": ["types/pi.d.ts"] }
//     },
//     "include": ["pi", "types"]
//   }

declare module '@earendil-works/pi-coding-agent' {
  /** Config directory name (".pi" for stock pi; rebrands differ). */
  export const CONFIG_DIR_NAME: string;
  /** The agent directory (e.g. ~/.pi/agent), honoring PI_CONFIG_DIR. */
  export function getAgentDir(): string;

  // --- session entries (the subset the extension reads) -------------------

  export interface PiTextContent {
    type: 'text';
    text: string;
  }
  export interface PiImageContent {
    type: 'image';
    data: string;
    mimeType: string;
  }
  export interface PiThinkingContent {
    type: 'thinking';
    thinking: string;
  }
  export interface PiToolCallContent {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }

  export interface PiUserMessage {
    role: 'user';
    content: string | (PiTextContent | PiImageContent)[];
    timestamp: number;
  }
  export interface PiAssistantMessage {
    role: 'assistant';
    content: (PiTextContent | PiThinkingContent | PiToolCallContent)[];
    api: string;
    provider: string;
    model: string;
    usage: unknown;
    stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
    errorMessage?: string;
    timestamp: number;
  }
  export interface PiToolResultMessage {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: (PiTextContent | PiImageContent)[];
    details?: unknown;
    usage?: unknown;
    isError: boolean;
    timestamp: number;
  }
  export interface PiBashExecutionMessage {
    role: 'bashExecution';
    command: string;
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
    excludeFromContext?: boolean;
    timestamp: number;
  }
  export interface PiCustomMessage {
    role: 'custom';
    customType: string;
    content: string | (PiTextContent | PiImageContent)[];
    display: boolean;
    details?: unknown;
    timestamp: number;
  }
  export interface PiBranchSummaryMessage {
    role: 'branchSummary';
    summary: string;
    fromId: string;
    timestamp: number;
  }
  export interface PiCompactionSummaryMessage {
    role: 'compactionSummary';
    summary: string;
    tokensBefore: number;
    timestamp: number;
  }

  export type PiAgentMessage =
    | PiUserMessage
    | PiAssistantMessage
    | PiToolResultMessage
    | PiBashExecutionMessage
    | PiCustomMessage
    | PiBranchSummaryMessage
    | PiCompactionSummaryMessage;

  export interface PiSessionEntryBase {
    id: string;
    parentId: string;
    timestamp: number | Date;
  }
  export interface PiSessionMessageEntry extends PiSessionEntryBase {
    type: 'message';
    message: PiAgentMessage;
  }
  export interface PiBranchSummaryEntry extends PiSessionEntryBase {
    type: 'branch_summary';
    summary: string;
    fromId: string;
  }
  export interface PiCompactionEntry extends PiSessionEntryBase {
    type: 'compaction';
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  }

  export type SessionEntry =
    | PiSessionMessageEntry
    | PiBranchSummaryEntry
    | PiCompactionEntry;

  // --- extension API (the subset the extension uses) -----------------------

  export interface ExtensionUIContext {
    notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  }
  export interface ExtensionContext {
    cwd: string;
    ui: ExtensionUIContext;
  }

  export interface CompactionPreparation {
    /** UUID of the first entry pi keeps as real messages. */
    firstKeptEntryId: string;
    tokensBefore: number;
  }

  export interface SessionBeforeCompactEvent {
    type: 'session_before_compact';
    preparation: CompactionPreparation;
    /** All entries on the current branch (append-only history). */
    branchEntries: SessionEntry[];
    reason: 'manual' | 'threshold' | 'overflow';
    willRetry: boolean;
    signal: AbortSignal;
  }

  /** Structural subset of pi-ai's Usage. */
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

  export interface ExtensionCompactionResult {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: PiUsage;
    details?: unknown;
  }

  export interface SessionBeforeCompactResult {
    cancel?: boolean;
    compaction?: ExtensionCompactionResult;
  }

  export interface ExtensionAPI {
    on(
      event: 'session_before_compact',
      handler: (
        event: SessionBeforeCompactEvent,
        ctx: ExtensionContext,
      ) =>
        | Promise<SessionBeforeCompactResult | undefined>
        | SessionBeforeCompactResult
        | undefined,
    ): void;
  }
}
