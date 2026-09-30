import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/index.js';

// Sample values are built at run time: no key-shaped literal sits in the repository (push protection, sweeps).
const body = (n: number) => 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0'.repeat(4).slice(0, n);
const samples: Array<[string, string]> = [
  ['sk-proj', `sk-${'proj'}-${body(40)}`],
  ['sk-ant', `sk-${'ant'}-api03-${body(40)}`],
  ['sk', `sk-${body(32)}`],
  ['github-pat', `github${'_pat_'}${body(40)}`],
  ['gh-token', `gh${'p_'}${body(36)}`],
  ['hf', `hf${'_'}${body(34)}`],
  ['google-api', `AI${'za'}${body(35)}`],
  ['aws-akia', `AK${'IA'}${'ABCDEFGHIJKLMNOP'}`],
  ['jwt', `ey${'J'}${body(20)}.${body(24)}.${body(30)}`],
  ['sakana', `fish${'_'}${body(30)}`],
  ['bearer', `Authorization: Bearer ${body(40)}`],
];

describe('redactSecrets', () => {
  for (const [family, value] of samples) {
    it(`masks a ${family} value and keeps the text around it`, () => {
      const out = redactSecrets(`before ${value} after`);
      expect(out).not.toContain(value.slice(-12));
      expect(out).toContain('[REDACTED:');
      expect(out.startsWith('before ')).toBe(true);
      expect(out.endsWith(' after')).toBe(true);
    });
  }

  it('masks a private key block', () => {
    const pem = `-----BEGIN ${'RSA PRIVATE'} KEY-----\n${body(64)}\n-----END ${'RSA PRIVATE'} KEY-----`;
    expect(redactSecrets(pem)).toBe('[REDACTED:private-key]');
  });

  it('leaves placeholders, field names and ordinary facts alone', () => {
    const text = [
      `api_key: sk-${'x'.repeat(24)}`,
      'TYPESAFE_API_KEY is read from the environment',
      'HTTP 404 from /oauth, pid 40211, commit 9f3c2a1b',
      'task-0035042d842444bd',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });
});
