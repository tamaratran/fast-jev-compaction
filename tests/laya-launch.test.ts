import { describe, expect, it } from 'vitest';
import {
  detachedLaunchArgv,
  healthUrl,
  isLocalBaseUrl,
  layaLauncher,
  layaServeEnv,
  type LaunchConfig,
  type LaunchOps,
} from '../hooks/laya-launch.ts';

const config: LaunchConfig = {
  baseUrl: 'http://127.0.0.1:8000/v1/systemone',
  model: 'laya',
  autoStart: true,
  layaServeCommand: 'laya-serve',
  startupTimeoutSeconds: 5,
};

function fakeEngine(options: { upAfterSpawn: number; os?: string; exitCode?: number }) {
  let now = 0;
  let spawned = false;
  let healthChecksAfterSpawn = 0;
  const runs: { argv: readonly string[]; env?: Record<string, string> }[] = [];
  const logs: string[] = [];
  const $: LaunchOps = {
    fetch: async () => {
      if (!spawned) throw new Error('ECONNREFUSED');
      healthChecksAfterSpawn += 1;
      return { ok: healthChecksAfterSpawn > options.upAfterSpawn };
    },
    run: async (argv, init) => {
      runs.push({ argv, env: init.env });
      spawned = true;
      return { exitCode: options.exitCode ?? 0, stderr: 'not found' };
    },
    isWindows: async () => options.os === 'Windows_NT',
    now: async () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: (text) => logs.push(text),
  };
  return { $, runs, logs };
}

describe('laya-serve launch helpers', () => {
  it('starts only local endpoints', () => {
    expect(isLocalBaseUrl('http://127.0.0.1:8000/v1/systemone')).toBe(true);
    expect(isLocalBaseUrl('http://localhost:9000/x')).toBe(true);
    expect(isLocalBaseUrl('http://gpu-box:8000/v1/systemone')).toBe(false);
    expect(isLocalBaseUrl('not a url')).toBe(false);
  });

  it('derives host, port, models and the health URL from the config', () => {
    expect(layaServeEnv('http://127.0.0.1:8123/v1/systemone', 'laya')).toEqual({
      LAYA_HOST: '127.0.0.1',
      LAYA_PORT: '8123',
      LAYA_MODELS: 'english',
    });
    expect(layaServeEnv('http://[::1]/v1/systemone', 'laya-multilingual')).toEqual({
      LAYA_HOST: '::1',
      LAYA_PORT: '80',
      LAYA_MODELS: 'english,multilingual',
    });
    expect(layaServeEnv('http://localhost:8000/v1', 'custom')).toEqual({
      LAYA_HOST: 'localhost',
      LAYA_PORT: '8000',
    });
    expect(healthUrl('http://127.0.0.1:8000/v1/systemone')).toBe('http://127.0.0.1:8000/health');
  });

  it('builds a detached command per platform', () => {
    expect(detachedLaunchArgv("C:/it's/laya-serve.exe", true)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Start-Process -WindowStyle Hidden -FilePath 'C:/it''s/laya-serve.exe'",
    ]);
    expect(detachedLaunchArgv('laya-serve', false)).toEqual([
      'sh',
      '-c',
      'nohup "$0" >/dev/null 2>&1 </dev/null &',
      'laya-serve',
    ]);
  });
});

describe('layaLauncher', () => {
  it('spawns laya-serve once and waits until it answers', async () => {
    const { $, runs, logs } = fakeEngine({ upAfterSpawn: 3, os: 'Windows_NT' });
    const laya = layaLauncher(config);
    await laya.ensure($);
    await laya.ready($);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv[0]).toBe('powershell.exe');
    expect(runs[0]!.env).toEqual({ LAYA_HOST: '127.0.0.1', LAYA_PORT: '8000', LAYA_MODELS: 'english' });
    expect(logs).toEqual(['started laya-serve on 127.0.0.1:8000']);
  });

  it('does nothing when laya-serve already answers', async () => {
    const { $, runs } = fakeEngine({ upAfterSpawn: 0 });
    $.fetch = async () => ({ ok: true });
    await layaLauncher(config).ready($);
    expect(runs).toHaveLength(0);
  });

  it('leaves remote endpoints and autoStart false alone', async () => {
    for (const changed of [{ autoStart: false }, { baseUrl: 'http://gpu-box:8000/v1/systemone' }]) {
      const { $, runs } = fakeEngine({ upAfterSpawn: 0 });
      await layaLauncher({ ...config, ...changed }).ready($);
      expect(runs).toHaveLength(0);
    }
  });

  it('gives up after startupTimeoutSeconds', async () => {
    const { $ } = fakeEngine({ upAfterSpawn: 1_000 });
    await expect(layaLauncher(config).ready($)).rejects.toThrow(/did not answer within 5 s/);
  });

  it('reports a launch command that fails', async () => {
    const { $ } = fakeEngine({ upAfterSpawn: 0, exitCode: 1 });
    await expect(layaLauncher(config).ensure($)).rejects.toThrow(/could not start laya-serve: not found/);
  });
});
