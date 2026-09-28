import { describe, expect, test } from 'vitest';
import {
  salvageErrorLines,
  salvageIdentifiers,
  salvagedResultText,
} from '../src/salvage.js';

describe('salvageIdentifiers', () => {
  test('finds a unix file path that appears past the head of the text', () => {
    const text = `${'preamble line\n'.repeat(40)}src/components/Button.tsx\n`;

    expect(salvageIdentifiers(text)).toContain('src/components/Button.tsx');
  });

  test('finds an absolute windows path', () => {
    expect(salvageIdentifiers('opened C:\\repos\\app\\main.ts ok')).toContain(
      'C:\\repos\\app\\main.ts',
    );
  });

  test('finds a url', () => {
    expect(salvageIdentifiers('see https://example.com/a/b?c=1 for details')).toContain(
      'https://example.com/a/b?c=1',
    );
  });

  test('finds a git sha', () => {
    expect(salvageIdentifiers('commit e3f262a9c1b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8')).toContain(
      'e3f262a9c1b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8',
    );
  });

  test('does not repeat an identifier that occurs many times', () => {
    const text = 'src/a.ts\n'.repeat(10);

    expect(salvageIdentifiers(text).filter((s) => s === 'src/a.ts')).toHaveLength(1);
  });

  test('returns nothing for prose that carries no identifiers', () => {
    expect(salvageIdentifiers('the operation completed and everything looks fine')).toEqual(
      [],
    );
  });
});

describe('salvageIdentifiers and secrets', () => {
  test('keeps an env var name', () => {
    expect(salvageIdentifiers('DATABASE_URL=postgres://user:pw@host/db')).toContain(
      'DATABASE_URL',
    );
  });

  test('never keeps the value assigned to an env var', () => {
    const out = salvageIdentifiers('DATABASE_URL=postgres://user:hunter2@host/db').join(' ');

    expect(out).not.toContain('hunter2');
  });

  test('never keeps a secret value that is shaped like a path', () => {
    const out = salvageIdentifiers('API_KEY=sk-or-v1/abcdef/ghijkl').join(' ');

    expect(out).not.toContain('abcdef');
  });

  test('never keeps a secret value that is shaped like a url', () => {
    const out = salvageIdentifiers(
      'WEBHOOK=https://hooks.example.com/tok-9f8e7d6c5b4a',
    ).join(' ');

    expect(out).not.toContain('9f8e7d6c5b4a');
  });
});

describe('salvageErrorLines', () => {
  test('keeps a line reporting an error', () => {
    const text = `${'compiling\n'.repeat(30)}Error: cannot find module 'left-pad'\ndone\n`;

    expect(salvageErrorLines(text)).toContain("Error: cannot find module 'left-pad'");
  });

  test('keeps a non-zero exit code line', () => {
    expect(salvageErrorLines('npm run build\nexit code 127\n')).toContain('exit code 127');
  });

  test('ignores an exit code of zero', () => {
    expect(salvageErrorLines('all good\nexit code 0\n')).toEqual([]);
  });

  test('returns nothing when nothing failed', () => {
    expect(salvageErrorLines('built 12 files in 3s\nall tests passed\n')).toEqual([]);
  });

  test('keeps a bare FAIL line, as test runners emit', () => {
    const line = 'FAIL tests/hook.test.ts > session message mapping';

    expect(salvageErrorLines(`compiling\n${line}\n`)).toContain(line);
  });

  test('does not treat a passing summary as a failure', () => {
    expect(salvageErrorLines('Tests  53 passed (53)\n')).toEqual([]);
  });

  test('redacts a secret assigned inside a failing line', () => {
    const out = salvageErrorLines('Error: auth failed for TOKEN=abc123secretvalue').join(' ');

    expect(out).toContain('TOKEN');
    expect(out).not.toContain('abc123secretvalue');
  });
});

const OPTIONS = { headChars: 150, maxChars: 600 };

describe('salvagedResultText', () => {
  test('leaves a short result exactly as it was', () => {
    const text = 'ok: 3 files changed';

    expect(salvagedResultText(text, false, OPTIONS)).toBe(text);
  });

  test('keeps the head of a long result', () => {
    const text = `START-OF-OUTPUT\n${'filler line\n'.repeat(200)}`;

    expect(salvagedResultText(text, false, OPTIONS)).toContain('START-OF-OUTPUT');
  });

  test('keeps a path that upstream head truncation would have lost', () => {
    const text = `${'filler line\n'.repeat(200)}src/deeply/buried/Thing.tsx\n`;

    expect(salvagedResultText(text, false, OPTIONS)).toContain(
      'src/deeply/buried/Thing.tsx',
    );
  });

  test('keeps an error line from the tail of a failed result', () => {
    const text = `${'filler line\n'.repeat(200)}Error: build failed at step 4\n`;

    expect(salvagedResultText(text, true, OPTIONS)).toContain(
      'Error: build failed at step 4',
    );
  });

  test('marks salvaged content so it is not mistaken for the full result', () => {
    const text = `${'filler line\n'.repeat(200)}src/a.ts\n`;

    expect(salvagedResultText(text, false, OPTIONS)).toMatch(/salvaged/i);
  });

  test('stays within the head and salvage budget', () => {
    const text = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`).join('\n');

    expect(salvagedResultText(text, false, OPTIONS).length).toBeLessThan(1200);
  });

  test('never leaks an assigned secret into the salvaged block', () => {
    const text = `${'filler line\n'.repeat(200)}AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG\n`;

    const out = salvagedResultText(text, false, OPTIONS);

    expect(out).toContain('AWS_SECRET_ACCESS_KEY');
    expect(out).not.toContain('wJalrXUtnFEMIK7MDENG');
  });

  test('does not throw on pathological input', () => {
    const text = '\u0000￿'.repeat(5000);

    expect(() => salvagedResultText(text, false, OPTIONS)).not.toThrow();
  });
});
