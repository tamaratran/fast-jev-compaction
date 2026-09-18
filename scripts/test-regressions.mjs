// Offline contract tests. Transpilation here is not a substitute for typecheck.
import ts from 'typescript';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sourceAt = args.indexOf('--source');
const source = sourceAt < 0 ? root : resolve(args[sourceAt + 1]);
const caseAt = args.indexOf('--case');
const prefix = caseAt < 0 ? '' : args[caseAt + 1];
const build = mkdtempSync(join(tmpdir(), 'fast-jev-regressions-'));
try {
  writeFileSync(join(build, 'package.json'), '{"type":"module"}');
  for (const folder of ['src', 'hooks']) {
    mkdirSync(join(build, folder));
    for (const name of readdirSync(join(source, folder))) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const file = join(source, folder, name);
      const result = ts.transpileModule(readFileSync(file, 'utf8'), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      });
      const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
      if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: x => x, getCurrentDirectory: () => source, getNewLine: () => '\n',
      }));
      writeFileSync(join(build, folder, name.replace(/\.ts$/, '.js')), result.outputText);
    }
  }
  const cases = readdirSync(join(root, 'regressions')).filter(n => n.endsWith('.case.mjs') && n.startsWith(prefix)).sort();
  if (!cases.length) throw new Error('No regression cases selected');
  const result = spawnSync(process.execPath, ['--test', ...cases.map(n => join(root, 'regressions', n))], {
    stdio: 'inherit',
    env: { ...process.env, FJC_TEST_BUILD: pathToFileURL(build + '/').href, FJC_TEST_SOURCE: source },
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(build, { recursive: true, force: true });
}
