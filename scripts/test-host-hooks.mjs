import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// The native runner discovers *.test.ts recursively. Give it an isolated
// copy so it never attempts to load the Vitest tests.
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'fast-jev-host-tests-'));
try {
  for (const name of ['.claude-plugin', 'hooks', 'src']) {
    await cp(join(root, name), join(fixture, name), { recursive: true });
  }
  for (const name of await readdir(join(root, 'tests/host'))) {
    if (name.endsWith('.ts')) {
      await cp(join(root, 'tests/host', name), join(fixture, name.replace(/\.ts$/, '.test.ts')));
    }
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn('claude', ['plugin', 'test', fixture], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
