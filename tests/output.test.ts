import { describe, expect, it } from 'vitest';
import { trimOutput } from '../src/output.js';
import { estimateTokens } from '../src/state.js';
import type { JevAsker } from '../src/types.js';
import { resolveHookConfig } from '../hooks/fast-jev.ts';

function askerFor(score: (id: string) => number, calls: { count: number }): JevAsker {
  return {
    async ask(_state, questions) {
      calls.count += 1;
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: 'noul' as const, noul: score(id) },
          ]),
        ),
      };
    },
  };
}

function outputLines(): string[] {
  return Array.from({ length: 200 }, (_, index) => `line-${index + 1}`);
}

function estimateOutputTokens(text: string): number {
  return estimateTokens(text) + (text.match(/\d/g)?.length ?? 0) / 2;
}

describe('trimOutput', () => {
  it('passes short output through without asking Jev', async () => {
    const calls = { count: 0 };
    const output = 'short output';
    const result = await trimOutput(
      { command: 'printf short', goal: 'test', output },
      askerFor(() => 0, calls),
    );
    expect(calls.count).toBe(0);
    expect(result).toEqual({
      output,
      trimmed: false,
      chunks: 0,
      kept: 0,
      dropped: 0,
      charsBefore: output.length,
      charsAfter: output.length,
      scores: [],
    });
  });

  it('keeps selected chunks and collapses dropped runs with markers', async () => {
    const calls = { count: 0 };
    const lines = outputLines();
    const output = lines.join('\n');
    const result = await trimOutput(
      {
        command: 'run command',
        goal: 'fix the test',
        output,
        fullOutputPath: '.claude/full.txt',
      },
      askerFor((id) => (id === 'c1' || id === 'c3' ? 0.9 : 0.1), calls),
      { minChars: 1, chunkLines: 20, keepThreshold: 0.5 },
    );

    const chunk = (number: number): string =>
      lines.slice((number - 1) * 20, number * 20).join('\n');
    expect(calls.count).toBe(1);
    expect(result.trimmed).toBe(true);
    expect(result.chunks).toBe(10);
    expect(result.kept).toBe(3);
    expect(result.dropped).toBe(7);
    expect(result.scores).toHaveLength(10);
    expect(result.scores[9]).toBe(0.1);
    expect(result.output).toContain(chunk(1));
    expect(result.output).toContain(chunk(3));
    expect(result.output).toContain(chunk(10));
    expect(result.output).toContain(
      `[fast-jev-compaction trimmed 20 lines (${chunk(2).length} chars); full output: .claude/full.txt (Read or grep it if needed)]`,
    );
    expect(result.output).toContain(
      `[fast-jev-compaction trimmed 120 lines (${[4, 5, 6, 7, 8, 9]
        .map((number) => chunk(number).length)
        .reduce((sum, chars) => sum + chars, 0) + 5} chars); full output: .claude/full.txt (Read or grep it if needed)]`,
    );
    expect(result.output.indexOf(chunk(1))).toBeLessThan(result.output.indexOf(chunk(3)));
    expect(result.output.indexOf(chunk(3))).toBeLessThan(result.output.indexOf(chunk(10)));
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it('returns the original output when every chunk is kept', async () => {
    const output = outputLines().join('\n');
    const result = await trimOutput(
      { command: 'run command', goal: 'test', output },
      askerFor(() => 0.9, { count: 0 }),
      { minChars: 1, chunkLines: 20 },
    );
    expect(result.trimmed).toBe(false);
    expect(result.output).toBe(output);
    expect(result.dropped).toBe(0);
    expect(result.charsAfter).toBe(result.charsBefore);
  });

  it('rejects when Jev fails', async () => {
    const asker: JevAsker = {
      async ask() {
        throw new Error('network unavailable');
      },
    };
    await expect(
      trimOutput(
        { command: 'run command', goal: 'test', output: outputLines().join('\n') },
        asker,
        { minChars: 1, chunkLines: 20 },
      ),
    ).rejects.toThrow('network unavailable');
  });

  it('retries with a smaller state after max_tokens_exceeded', async () => {
    let calls = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            'Jev request failed (400): {"detail":{"error_type":"max_tokens_exceeded"}}',
          );
        }
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'noul' as const, noul: id === 'c1' || id === 'c10' ? 0.9 : 0.1 },
            ]),
          ),
        };
      },
    };
    const result = await trimOutput(
      { command: 'run command', goal: 'test', output: outputLines().join('\n') },
      asker,
      { minChars: 1, chunkLines: 20 },
    );
    expect(result.trimmed).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('bounds retries when max_tokens_exceeded persists', async () => {
    let calls = 0;
    const asker: JevAsker = {
      async ask() {
        calls += 1;
        throw new Error(
          'Jev request failed (400): {"detail":{"error_type":"max_tokens_exceeded"}}',
        );
      },
    };
    await expect(
      trimOutput(
        { command: 'run command', goal: 'test', output: outputLines().join('\n') },
        asker,
        { minChars: 1, chunkLines: 20 },
      ),
    ).rejects.toThrow('max_tokens_exceeded');
    expect(calls).toBe(3);
  });

  it('fits digit-heavy output to the state budget', async () => {
    const output = Array.from({ length: 20_000 }, (_, index) => String(index + 1)).join('\n');
    const defaultStates: number[] = [];
    const asker = (states: number[]): JevAsker => ({
      async ask(state, questions) {
        states.push(estimateOutputTokens(JSON.stringify(state)));
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'noul' as const, noul: 0.1 },
            ]),
          ),
        };
      },
    });

    const result = await trimOutput(
      { command: 'seq 1 20000', goal: '', output },
      asker(defaultStates),
      {},
    );
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain('1\n2');
    expect(result.output).toContain('19999\n20000');
    expect(defaultStates.length).toBeGreaterThan(0);
    expect(defaultStates.every((tokens) => tokens <= 25_000)).toBe(true);

    const smallStates: number[] = [];
    await trimOutput(
      { command: 'seq 1 20000', goal: '', output },
      asker(smallStates),
      { maxStateTokens: 5_000 },
    );
    expect(smallStates.length).toBeGreaterThan(0);
    expect(Math.max(...smallStates)).toBeLessThan(Math.max(...defaultStates));
  });
});

describe('Bash output hook options', () => {
  it('uses the Bash trimming defaults and accepts overrides', () => {
    expect(resolveHookConfig({})).toMatchObject({
      bashOutput: false,
      bashOutputMinChars: 4_000,
      bashOutputChunkLines: 20,
    });
    expect(
      resolveHookConfig({
        bashOutput: true,
        bashOutputMinChars: 100,
        bashOutputChunkLines: 5,
      }),
    ).toMatchObject({
      bashOutput: true,
      bashOutputMinChars: 100,
      bashOutputChunkLines: 5,
    });
  });
});

describe('trimOutput safety', () => {
  const asker = (score: number) => ({
    ask: async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: score }]),
      ),
    }),
  });
  const lines = (n: number, make: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => make(i)).join('\n');

  it('leaves a JSON document alone', async () => {
    const json = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ i })) }, null, 2);
    const r = await trimOutput({ command: 'cat items.json', goal: 'g', output: json }, asker(0));
    expect(r.trimmed).toBe(false);
    expect(r.output).toBe(json);
  });

  it('leaves binary output alone', async () => {
    const bin = Array.from({ length: 9000 }, (_, i) => String.fromCharCode(i % 256)).join('');
    const r = await trimOutput({ command: 'run', goal: 'g', output: bin }, asker(0));
    expect(r.trimmed).toBe(false);
  });

  it('keeps a chunk that looks like an error even when Jev says drop', async () => {
    const out = lines(400, (i) => (i === 200 ? 'ERROR: boom' : `[${i}] compiled module ${i} fine`));
    const r = await trimOutput({ command: 'npm run build', goal: 'g', output: out }, asker(0));
    expect(r.trimmed).toBe(true);
    expect(r.output).toContain('ERROR: boom');
  });

  it('keeps chunks that were never scored instead of dropping them', async () => {
    const out = lines(6000, (i) => `[${i}] ${'detail '.repeat(20)}`);
    const r = await trimOutput(
      { command: 'npm run build', goal: 'g', output: out },
      asker(0),
      { maxStateTokens: 1_000 },
    );
    expect(r.output).toContain('[3000]');
  });

  it('splits one enormous line so it can still be trimmed', async () => {
    const r = await trimOutput(
      { command: 'run', goal: 'g', output: 'x'.repeat(60_000) },
      asker(0),
      { chunkLines: 5 },
    );
    expect(r.chunks).toBeGreaterThan(2);
  });
});
