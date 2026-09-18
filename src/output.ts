import { estimateTokens } from './state.js';
import { noulAnswer } from './request.js';
import type { JevAsker, JevQuestions } from './types.js';

const DEFAULT_MIN_CHARS = 4_000;
const DEFAULT_CHUNK_LINES = 20;
const DEFAULT_KEEP_THRESHOLD = 0.5;
const DEFAULT_MAX_STATE_TOKENS = 25_000;
const MAX_REQUEST_TOKENS = 30_000;

const MAX_CHUNKS = 200;
const MAX_LINE_CHARS = 2_000;
const ERROR_PATTERN =
  /\b(error|errors|failed|failure|fatal|exception|traceback|panic|assert|denied|refused|timeout|cannot|unable|warning)\b/i;
const estimateOutputTokens = (text: string): number =>
  estimateTokens(text) + (text.match(/\d/g)?.length ?? 0) / 2;

const OUTPUT_CONTEXT =
  'A coding agent ran a shell command. Its output is split into numbered chunks. The agent will only see the chunks that are kept; the full output is saved to a file it can read later. Decide which chunks the agent needs to understand the outcome of the command and continue its task: errors, failures, warnings, summaries, final results, and lines the task depends on are needed; repetitive progress output, verbose listings, download/install noise and boilerplate are not.';

export interface TrimOutputOptions {
  minChars?: number;
  chunkLines?: number;
  keepThreshold?: number;
  maxStateTokens?: number;
}

export interface TrimOutputInput {
  command: string;
  goal: string;
  output: string;
  fullOutputPath?: string;
}

export interface TrimOutputResult {
  output: string;
  trimmed: boolean;
  chunks: number;
  kept: number;
  dropped: number;
  charsBefore: number;
  charsAfter: number;
  scores: number[];
}

type OutputChunk = {
  id: string;
  text: string;
  lines: number;
  chars: number;
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Output with NULs or a lot of control bytes is not text worth chunking. */
export function looksBinary(output: string): boolean {
  const sample = output.slice(0, 4_000);
  if (sample.includes('\u0000')) return true;
  let control = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32) || code === 127) control += 1;
  }
  return control > sample.length * 0.05;
}

/**
 * Output the agent is likely to parse as one document (a file dump, a diff, a
 * JSON blob). Cutting a hole in it leaves something that still looks complete
 * but is not, so it is left alone.
 */
export function looksStructured(command: string, output: string): boolean {
  const head = output.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(output);
      return true;
    } catch {
      /* not JSON after all */
    }
  }
  if (head.startsWith('<?xml') || head.startsWith('<!DOCTYPE') || head.startsWith('---\n')) return true;
  if (/^diff --git |^--- |^@@ /m.test(output)) return true;
  return /(^|[|;&]\s*)(cat|bat|jq|yq|git\s+(diff|show)|base64|openssl)\b/.test(command);
}

/** Splits over-long lines so one line cannot become an untrimmable chunk. */
function splitLongLines(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length <= MAX_LINE_CHARS) {
      out.push(line);
      continue;
    }
    for (let at = 0; at < line.length; at += MAX_LINE_CHARS) {
      out.push(line.slice(at, at + MAX_LINE_CHARS));
    }
  }
  return out;
}

function chunkOutput(output: string, chunkLines: number): OutputChunk[] {
  const lines = splitLongLines(output);
  const chunks: OutputChunk[] = [];
  for (let start = 0; start < lines.length; start += chunkLines) {
    const text = lines.slice(start, start + chunkLines).join('\n');
    chunks.push({
      id: `c${chunks.length + 1}`,
      text,
      lines: Math.min(chunkLines, lines.length - start),
      chars: text.length,
    });
  }
  return chunks;
}

function stateFor(
  input: TrimOutputInput,
  chunks: readonly OutputChunk[],
): { context: string; task: string; command: string; chunks: { id: string; text: string }[] } {
  return {
    context: OUTPUT_CONTEXT,
    task: input.goal,
    command: input.command,
    chunks: chunks.map(({ id, text }) => ({ id, text })),
  };
}

function questionFor(chunk: OutputChunk): JevQuestions {
  const n = chunk.id.slice(1);
  return {
    [chunk.id]: {
      type: 'noul',
      instructions: `Chunk c${n} must stay visible to the agent for it to understand the result of the command and continue its task.`,
      criteria: {
        true: 'The chunk contains an error, failure, warning, summary, final result, or information the task depends on.',
        false: 'The chunk is repetitive, verbose, or boilerplate output the agent can act without.',
      },
    },
  };
}

function batches(
  chunks: readonly OutputChunk[],
  stateTokens: number,
): OutputChunk[][] {
  const budget = MAX_REQUEST_TOKENS - stateTokens;
  const result: OutputChunk[][] = [];
  let current: OutputChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    const tokens = estimateOutputTokens(JSON.stringify(questionFor(chunk)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      result.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for output questions (~${stateTokens} of ${MAX_REQUEST_TOKENS} tokens)`,
      );
    }
    current.push(chunk);
    currentTokens += tokens;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function outputMarker(
  chunks: readonly OutputChunk[],
  fullOutputPath: string | undefined,
): string {
  const lines = chunks.reduce((sum, chunk) => sum + chunk.lines, 0);
  const chars =
    chunks.reduce((sum, chunk) => sum + chunk.chars, 0) + Math.max(0, chunks.length - 1);
  return `[fast-jev-compaction trimmed ${lines} lines (${chars} chars)${
    fullOutputPath
      ? `; full output: ${fullOutputPath} (Read or grep it if needed)`
      : '; not saved to disk, re-run the command if you need these lines'
  }]`;
}

function untrimmed(output: string, chunks: number, scores: number[]): TrimOutputResult {
  return {
    output,
    trimmed: false,
    chunks,
    kept: chunks,
    dropped: 0,
    charsBefore: output.length,
    charsAfter: output.length,
    scores,
  };
}

function maxTokensExceeded(error: unknown): boolean {
  return error instanceof Error && error.message.includes('max_tokens_exceeded');
}

async function trimOutputAttempt(
  input: TrimOutputInput,
  asker: JevAsker,
  options: TrimOutputOptions = {},
  retriesRemaining = 2,
): Promise<TrimOutputResult> {
  const minChars = Math.max(0, finite(options.minChars, DEFAULT_MIN_CHARS));
  const chunkLines = Math.max(
    1,
    Math.floor(finite(options.chunkLines, DEFAULT_CHUNK_LINES)),
  );
  const keepThreshold = finite(options.keepThreshold, DEFAULT_KEEP_THRESHOLD);
  const maxStateTokens = Math.max(
    1,
    finite(options.maxStateTokens, DEFAULT_MAX_STATE_TOKENS),
  );

  if (input.output.length <= minChars) return untrimmed(input.output, 0, []);

  if (looksBinary(input.output) || looksStructured(input.command, input.output)) {
    return untrimmed(input.output, 0, []);
  }

  const lineCount = splitLongLines(input.output).length;
  const perChunk = Math.max(chunkLines, Math.ceil(lineCount / MAX_CHUNKS));
  const chunks = chunkOutput(input.output, perChunk);
  if (chunks.length <= 2) return untrimmed(input.output, chunks.length, []);

  let stateChunks = chunks.map((chunk) => ({ ...chunk }));
  let state = stateFor(input, stateChunks);
  let stateTokens = estimateOutputTokens(JSON.stringify(state));
  let omitted = new Set<number>();
  if (stateTokens > maxStateTokens) {
    stateChunks = chunks.map((chunk) => ({
      ...chunk,
      text: chunk.text
        .split('\n')
        .map((line) => line.slice(0, 200))
        .join('\n'),
    }));
    state = stateFor(input, stateChunks);
    stateTokens = estimateOutputTokens(JSON.stringify(state));
  }
  if (stateTokens > maxStateTokens) {
    // Chunks left out of the state are never scored, so they are KEPT, not
    // dropped: an error in the middle of a long output must not disappear
    // because the state did not fit.
    omitted = new Set(
      chunks
        .map((_, index) => index)
        .filter(
          (index) =>
            index >= 40 && index < chunks.length - 40 && !ERROR_PATTERN.test(chunks[index]!.text),
        ),
    );
    stateChunks = chunks.map((chunk, index) =>
      omitted.has(index)
        ? { ...chunk, text: '[… omitted from state …]' }
        : { ...chunk },
    );
    state = stateFor(input, stateChunks);
    stateTokens = estimateOutputTokens(JSON.stringify(state));
  }

  if (stateTokens > maxStateTokens) {
    let perChunkChars = 400;
    while (stateTokens > maxStateTokens) {
      stateChunks = chunks.map((chunk, index) =>
        omitted.has(index)
          ? { ...chunk, text: '[… omitted from state …]' }
          : { ...chunk, text: chunk.text.slice(0, perChunkChars) },
      );
      state = stateFor(input, stateChunks);
      stateTokens = estimateOutputTokens(JSON.stringify(state));
      if (stateTokens <= maxStateTokens || perChunkChars === 50) break;
      perChunkChars = Math.max(50, Math.floor(perChunkChars / 2));
    }

    if (stateTokens > maxStateTokens) {
      const middle = (chunks.length - 1) / 2;
      const candidates = chunks
        .map((_, index) => index)
        .filter(
          (index) =>
            index !== 0 &&
            index !== chunks.length - 1 &&
            !omitted.has(index) &&
            !ERROR_PATTERN.test(chunks[index]!.text),
        )
        .sort((left, right) => {
          const distance = Math.abs(left - middle) - Math.abs(right - middle);
          return distance || left - right;
        });
      for (let start = 0; stateTokens > maxStateTokens && start < candidates.length; start += 10) {
        for (const index of candidates.slice(start, start + 10)) omitted.add(index);
        stateChunks = chunks.map((chunk, index) =>
          omitted.has(index)
            ? { ...chunk, text: '[… omitted from state …]' }
            : { ...chunk, text: chunk.text.slice(0, 50) },
        );
        state = stateFor(input, stateChunks);
        stateTokens = estimateOutputTokens(JSON.stringify(state));
      }
    }
  }

  const asked = chunks.filter((_, index) => !omitted.has(index));
  const scores = Array<number>(chunks.length).fill(0);
  scores[0] = 1;
  scores[chunks.length - 1] = 1;
  try {
    const questionBatches = batches(asked, stateTokens);
    const answered = await Promise.all(
      questionBatches.map(async (batch) => {
        const questions = Object.assign({}, ...batch.map(questionFor));
        return asker.ask(state, questions);
      }),
    );
    let answerOffset = 0;
    for (const batch of questionBatches) {
      const response = answered[answerOffset++];
      if (!response) throw new Error('Missing Jev output answer batch');
      for (const chunk of batch) {
        scores[chunks.indexOf(chunk)] = noulAnswer(response.answers, chunk.id);
      }
    }
  } catch (error) {
    if (maxTokensExceeded(error) && retriesRemaining > 0 && maxStateTokens >= 2_000) {
      return trimOutputAttempt(
        input,
        asker,
        { ...options, maxStateTokens: Math.floor(maxStateTokens / 2) },
        retriesRemaining - 1,
      );
    }
    throw error;
  }

  const keptIndexes = new Set<number>();
  for (let index = 0; index < chunks.length; index += 1) {
    if (
      omitted.has(index) ||
      index === 0 ||
      index === chunks.length - 1 ||
      ERROR_PATTERN.test(chunks[index]!.text) ||
      scores[index]! >= keepThreshold
    ) {
      keptIndexes.add(index);
    }
  }
  const droppedIndexes = chunks
    .map((_, index) => index)
    .filter((index) => !keptIndexes.has(index));
  if (droppedIndexes.length === 0) return untrimmed(input.output, chunks.length, scores);

  const parts: string[] = [];
  for (let index = 0; index < chunks.length;) {
    if (keptIndexes.has(index)) {
      parts.push(chunks[index]!.text);
      index += 1;
      continue;
    }
    const run: OutputChunk[] = [];
    while (index < chunks.length && !keptIndexes.has(index)) run.push(chunks[index++]!);
    parts.push(outputMarker(run, input.fullOutputPath));
  }
  const output = parts.join('\n');
  return {
    output,
    trimmed: true,
    chunks: chunks.length,
    kept: keptIndexes.size,
    dropped: droppedIndexes.length,
    charsBefore: input.output.length,
    charsAfter: output.length,
    scores,
  };
}

export async function trimOutput(
  input: TrimOutputInput,
  asker: JevAsker,
  options?: TrimOutputOptions,
): Promise<TrimOutputResult> {
  return trimOutputAttempt(input, asker, options, 2);
}
