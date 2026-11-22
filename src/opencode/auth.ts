/**
 * OpenCode's own credential store, for the HTTP transports that call the
 * Console route directly (the plugin's provider transport never reads it: the
 * host signs those requests itself).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AuthEnv = Record<string, string | undefined>;

/** OpenCode's data directory, honouring `XDG_DATA_HOME`. */
export function opencodeDataDir(env: AuthEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  return xdg && xdg.length > 0
    ? join(xdg, 'opencode')
    : join(homedir(), '.local', 'share', 'opencode');
}

/**
 * The key OpenCode stored for the Console connection, falling back to the Go
 * subscription. `opencode` comes first because it is the provider that serves
 * `jev-1.13-free` and `jev-1.13` without a plan check.
 */
export async function opencodeAuthKey(
  env: AuthEnv = process.env,
  providers: readonly string[] = ['opencode', 'opencode-go', 'typesafe-ai'],
): Promise<string | undefined> {  const path = env.FAST_JEV_AUTH_FILE ?? join(opencodeDataDir(env), 'auth.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const store = parsed as Record<string, { key?: unknown } | undefined>;
  for (const provider of providers) {
    const key = store[provider]?.key;
    if (typeof key === 'string' && key.length > 0) return key;
  }
  return undefined;
}

/**
 * Which stored key to try first for an HTTP route. The Go route needs the Go
 * credential; the Console route needs the `opencode` one.
 */
export function authProviders(baseUrl?: string): readonly string[] {
  return baseUrl && /\/inference\/go\//u.test(baseUrl)
    ? ['opencode-go', 'opencode', 'typesafe-ai']
    : ['opencode', 'opencode-go', 'typesafe-ai'];
}
