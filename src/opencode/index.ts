/**
 * OpenCode plugin entry: `hooks.compaction` decides over the transcript with
 * Jev and returns the surviving messages as the provider replacement window,
 * so no summary is written.
 */
import { Plugin } from '@opencode/plugin';
import { authProviders, opencodeAuthKey } from './auth.js';
import { createAsker, type DecisionsCall } from './asker.js';
import { resolvePluginConfig } from './config.js';
import { createCompactionHook } from './hook.js';
import { trialRecorder } from './trial.js';

export * from './asker.js';
export * from './auth.js';
export * from './config.js';
export * from './hook.js';
export * from './messages.js';
export * from './trial.js';
export { PRESETS, PRESET_NOTES, transportLabel } from '../transports.js';

export const PLUGIN_ID = 'fast-jev-compaction';

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = resolvePluginConfig(ctx.options);
    if (!config.enabled) return;

    const authKey =
      config.transport.kind === 'http'
        ? (config.apiKey ??
          (await opencodeAuthKey(process.env, authProviders(config.transport.baseUrl))))
        : undefined;
    const decisions: DecisionsCall = async (input) =>
      ctx.experimental.generate.decisions(input as never);
    const hook = createCompactionHook({
      config,
      asker: (sessionID) =>
        createAsker(config.transport, { decisions, sessionID, authKey }),
      record: trialRecorder(config.logPath),
    });
    await ctx.session.hook('compaction', hook);
  },
});
