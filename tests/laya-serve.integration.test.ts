import { describe, expect, it } from 'vitest';
import {
  CALL_QUESTIONS,
  collectToolCalls,
  compactMessages,
  DEFAULT_BASE_URL,
  estimateTokens,
  fitCallState,
  LayaClient,
  resolveOptions,
  wasTruncated,
  type Message,
} from '../src/index.js';
import { demoTranscript } from '../examples/transcript.js';

const baseUrl = process.env.LAYA_URL || DEFAULT_BASE_URL;

async function serverUp(): Promise<boolean> {
  try {
    const response = await fetch(baseUrl.replace(/\/v1\/systemone$/, '/health'), {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const up = await serverUp();

describe.skipIf(!up)(`real laya-serve at ${baseUrl}`, () => {
  const client = new LayaClient({ baseUrl });

  it('cuts an oversized state silently but flags it in usage', async () => {
    const response = await client.ask({ text: 'lorem ipsum '.repeat(1000) }, CALL_QUESTIONS);
    expect(wasTruncated(response)).toBe(true);
    expect(response.usage?.state_tokens_dropped).toBeGreaterThan(0);
    expect(response.answers.fate).toMatchObject({ type: 'choice' });
  });

  it('fits every per-call state of a real transcript in the default window', async () => {
    const messages: Message[] = demoTranscript();
    const options = resolveOptions({ preserveRecentMessages: 2 });
    const calls = collectToolCalls(messages, options.preserveRecentMessages);
    for (const call of calls.filter((c) => !c.pinned)) {
      const { state, tokens } = fitCallState(messages, calls, call, options);
      const response = await client.ask(state, CALL_QUESTIONS);
      const real = response.usage?.state_tokens ?? 0;
      expect(wasTruncated(response)).toBe(false);
      expect(tokens).toBeGreaterThanOrEqual(Math.floor(real * 0.8));
      expect(tokens).toBeLessThanOrEqual(Math.ceil(real * 1.3));
      expect(estimateTokens(JSON.stringify(state))).toBe(tokens);
    }
  }, 60_000);

  it('compacts the demo transcript end to end', async () => {
    const result = await compactMessages(demoTranscript(), { baseUrl, preserveRecentMessages: 2 });
    const candidates = result.decisions.filter((d) => d.reason !== 'pinned');
    expect(result.stats.requests).toBe(candidates.length);
    expect(result.stats.truncatedRequests).toBe(0);
    for (const d of candidates) {
      expect(d.keepCall).toBeGreaterThanOrEqual(0);
      expect(d.keepCall).toBeLessThanOrEqual(1);
      expect(d.keepResult).toBeGreaterThanOrEqual(0);
      expect(d.keepResult).toBeLessThanOrEqual(1);
    }
    console.log(
      'laya-serve decisions:',
      candidates.map((d) => `${d.id}:${d.tool}:${d.action}/${d.keepCall.toFixed(2)}/${d.keepResult.toFixed(2)}`).join(' '),
      JSON.stringify(result.stats),
    );
  }, 60_000);
});
