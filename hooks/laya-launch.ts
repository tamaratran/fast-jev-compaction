/**
 * The engine calls the launcher needs. The hook builds it from `$` with
 * closures, because a hooks module may not pass `$` itself around.
 */
export type LaunchOps = {
  fetch: (url: string) => Promise<{ ok: boolean }>;
  run: (
    argv: readonly string[],
    init: { env: Record<string, string>; timeoutMs: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  isWindows: () => Promise<boolean>;
  now: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  log: (text: string) => void;
  /** The plugin's directory, where `scripts/service.*` live. */
  pluginRoot: string;
};

export type LaunchConfig = {
  baseUrl: string;
  model: string;
  autoStart: boolean;
  layaServeCommand: string;
  startupTimeoutSeconds: number;
  installService: boolean;
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const POLL_MS = 1000;

/** Only a `laya-serve` on this machine can be started by the plugin. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** The `LAYA_*` variables that make `laya-serve` listen where `baseUrl` points. */
export function layaServeEnv(baseUrl: string, model: string): Record<string, string> {
  const url = new URL(baseUrl);
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  const env: Record<string, string> = {
    LAYA_HOST: url.hostname.replace(/^\[|\]$/g, ''),
    LAYA_PORT: url.port || defaultPort,
  };
  if (model === 'laya') env.LAYA_MODELS = 'english';
  if (model === 'laya-multilingual') env.LAYA_MODELS = 'english,multilingual';
  return env;
}

/**
 * A command that starts `laya-serve` detached and exits at once, so
 * `$.process.run` does not wait for the server.
 */
export function detachedLaunchArgv(command: string, windows: boolean): string[] {
  if (windows) {
    const quoted = `'${command.replace(/'/g, "''")}'`;
    return [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -WindowStyle Hidden -FilePath ${quoted}`,
    ];
  }
  return ['sh', '-c', 'nohup "$0" >/dev/null 2>&1 </dev/null &', command];
}

export type ServiceAction = 'install' | 'start';

/**
 * The command that runs `scripts/service.sh` (or `service.ps1` on Windows),
 * which keeps `laya-serve` running across logins: a systemd user service, a
 * LaunchAgent, or a supervisor started from the Windows Run key.
 */
export function serviceArgv(pluginRoot: string, action: ServiceAction, windows: boolean): string[] {
  const root = pluginRoot.replace(/[\\/]+$/, '');
  if (windows) {
    return [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${root}\\scripts\\service.ps1`,
      action,
    ];
  }
  return ['sh', `${root}/scripts/service.sh`, action];
}

/** Exit code of the service script when this machine has no service manager it supports. */
export const SERVICE_UNSUPPORTED = 3;

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1) ?? '';
}

export function healthUrl(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/health`;
}

export async function isLayaHealthy(ops: LaunchOps, baseUrl: string): Promise<boolean> {
  try {
    const response = await ops.fetch(healthUrl(baseUrl));
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts `laya-serve` when it is not answering, at most once per startup
 * window, and waits for it when asked. With `installService`, it first
 * installs the login service once per process and from then on starts the
 * server through it. Remote endpoints and `autoStart: false` are left alone.
 */
export function layaLauncher(config: LaunchConfig) {
  const enabled = config.autoStart && isLocalBaseUrl(config.baseUrl);
  const startupMs = config.startupTimeoutSeconds * 1000;
  let spawnedAt = Number.NEGATIVE_INFINITY;
  let serviceTried = false;
  let managed = false;

  function serviceEnv(): Record<string, string> {
    return { ...layaServeEnv(config.baseUrl, config.model), LAYA_SERVE: config.layaServeCommand };
  }

  /**
   * Installs (or confirms) the login service, once per process. Never throws:
   * without a service the launcher starts `laya-serve` itself, as before.
   */
  async function installService(ops: LaunchOps): Promise<void> {
    if (!enabled || !config.installService || serviceTried) return;
    serviceTried = true;
    const windows = await ops.isWindows();
    try {
      const argv = serviceArgv(ops.pluginRoot, 'install', windows);
      const { exitCode, stdout, stderr } = await ops.run(argv, { env: serviceEnv(), timeoutMs: 30_000 });
      if (exitCode === 0) {
        managed = true;
        ops.log(`laya-serve service ${lastLine(stdout)}`);
      } else if (exitCode === SERVICE_UNSUPPORTED) {
        ops.log(`laya-serve service not available (${lastLine(stderr)}); starting laya-serve per session`);
      } else {
        ops.log(`laya-serve service install failed (${lastLine(stderr) || `exit ${exitCode}`}); starting laya-serve per session`);
      }
    } catch (error) {
      ops.log(`laya-serve service install failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  async function spawn(ops: LaunchOps): Promise<void> {
    const windows = await ops.isWindows();
    const env = managed ? serviceEnv() : layaServeEnv(config.baseUrl, config.model);
    const argv = managed
      ? serviceArgv(ops.pluginRoot, 'start', windows)
      : detachedLaunchArgv(config.layaServeCommand, windows);
    const { exitCode, stderr } = await ops.run(argv, { env, timeoutMs: 15_000 });
    if (exitCode !== 0) throw new Error(`could not start ${config.layaServeCommand}: ${stderr.trim()}`);
    ops.log(
      `started ${config.layaServeCommand} on ${env.LAYA_HOST}:${env.LAYA_PORT}${managed ? ' (service)' : ''}`,
    );
  }

  async function ensure(ops: LaunchOps): Promise<void> {
    if (!enabled) return;
    if (await isLayaHealthy(ops, config.baseUrl)) return;
    const now = await ops.now();
    const launchPending = now - spawnedAt < startupMs;
    if (launchPending) return;
    spawnedAt = now;
    await spawn(ops);
  }

  async function ready(ops: LaunchOps): Promise<void> {
    await ensure(ops);
    if (!enabled) return;
    const deadline = (await ops.now()) + startupMs;
    while (!(await isLayaHealthy(ops, config.baseUrl))) {
      if ((await ops.now()) > deadline) {
        throw new Error(`laya-serve did not answer within ${config.startupTimeoutSeconds} s`);
      }
      await ops.sleep(POLL_MS);
    }
  }

  return { installService, ensure, ready };
}
