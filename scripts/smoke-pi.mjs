import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCli = process.env.npm_execpath ?? bundledNpmCli;

function formatDiagnostics(errors) {
  return errors.map(({ path, error }) => `${path}: ${error}`).join('\n');
}

function assertOwnedTempDir(path, prefix) {
  const resolved = resolve(path);
  assert.equal(dirname(resolved), resolve(tmpdir()), `refusing to remove non-temp path: ${resolved}`);
  assert.equal(basename(resolved).startsWith(prefix), true, `refusing to remove unexpected temp path: ${resolved}`);
}

async function removeOwnedTempDir(path, prefix) {
  assertOwnedTempDir(path, prefix);
  await rm(path, { recursive: true, force: true });
}

async function loadPackage(packageRoot, label) {
  const agentDir = await mkdtemp(join(tmpdir(), 'fast-jev-pi-agent-'));
  try {
    const settingsManager = SettingsManager.inMemory(
      { packages: [packageRoot] },
      { projectTrusted: true },
    );
    const loader = new DefaultResourceLoader({
      cwd: packageRoot,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    const result = loader.getExtensions();
    assert.equal(result.errors.length, 0, `${label} Pi loader errors:\n${formatDiagnostics(result.errors)}`);
    assert.equal(result.extensions.length, 1, `${label} should load exactly one Pi extension`);
    assert.match(
      result.extensions[0]?.resolvedPath ?? '',
      /(?:^|[\\/])pi[\\/]extension\.ts$/,
      `${label} should load the manifest's pi/extension.ts entry`,
    );
  } finally {
    await removeOwnedTempDir(agentDir, 'fast-jev-pi-agent-');
  }
}

async function main() {
  await loadPackage(root, 'checkout');

  const packDir = await mkdtemp(join(tmpdir(), 'fast-jev-pi-pack-'));
  try {
    execFileSync(
      process.execPath,
      [npmCli, 'pack', '--pack-destination', packDir, '--cache', join(packDir, 'cache')],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const archives = (await readdir(packDir)).filter((file) => file.endsWith('.tgz'));
    assert.equal(archives.length, 1, 'npm pack did not create exactly one archive');
    const filename = archives[0];

    execFileSync('tar', ['-xzf', join(packDir, filename), '-C', packDir], { stdio: 'inherit' });
    await loadPackage(join(packDir, 'package'), 'packed archive');
  } finally {
    await removeOwnedTempDir(packDir, 'fast-jev-pi-pack-');
  }
}

await main();
