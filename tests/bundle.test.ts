import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * `opencode/server.js` is committed so OpenCode can install the plugin
 * straight from git (its installer runs no build scripts). It must match the
 * sources: run `npm run bundle` after changing anything it bundles.
 */
describe('committed OpenCode bundle', () => {
  it('matches a fresh build of src/opencode/server.ts', () => {
    const fresh = execFileSync(
      'npx',
      ['esbuild', 'src/opencode/server.ts', '--bundle', '--format=esm', '--platform=node', '--target=node18', '--log-level=warning'],
      { encoding: 'utf8' },
    );
    expect(readFileSync('opencode/server.js', 'utf8')).toBe(fresh);
  });
});
