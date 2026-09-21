import { describe, expect, it } from 'vitest';

import { jevAsker, resolveHookConfig } from '../hooks/fast-jev.js';
import { SYSTEM_ONE_URL } from '../src/request.js';

function recordingFetch(seen: { url?: string }) {
  return async (url: string) => {
    seen.url = url;
    return { status: 200, ok: true, text: JSON.stringify({ answers: { q: { noul: 0.5 } } }) };
  };
}

const QUESTIONS = { q: { type: 'noul', instructions: 'i' } } as const;

describe('baseUrl', () => {
  it('is read from the plugin options', () => {
    expect(resolveHookConfig({ baseUrl: 'https://jev.internal/v1/systemone' }).baseUrl).toBe(
      'https://jev.internal/v1/systemone',
    );
  });

  it('is left unset when the option is absent or empty', () => {
    expect(resolveHookConfig({}).baseUrl).toBeUndefined();
    expect(resolveHookConfig({ baseUrl: '' }).baseUrl).toBeUndefined();
  });

  it('is where the asker sends the request', async () => {
    const seen: { url?: string } = {};
    await jevAsker(recordingFetch(seen), 'k', 'jev-latest', 'https://jev.internal/v1/systemone').ask(
      's',
      QUESTIONS,
    );
    expect(seen.url).toBe('https://jev.internal/v1/systemone');
  });

  it('falls back to the System One endpoint when unset', async () => {
    const seen: { url?: string } = {};
    await jevAsker(recordingFetch(seen), 'k', 'jev-latest').ask('s', QUESTIONS);
    expect(seen.url).toBe(SYSTEM_ONE_URL);
  });
});
