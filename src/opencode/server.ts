/**
 * The plugin entry both OpenCode lines load from `fast-jev-compaction/server`:
 * OpenCode 1 reads `server` from the default export, OpenCode 2 reads `setup`
 * and ignores the rest.
 */
import type { PluginModule } from '@opencode-ai/plugin';
import type { Plugin } from '@opencode/plugin';

import { server } from './v1.js';
import { setup } from './v2.js';

function dual<T extends PluginModule & Plugin.Plugin>(plugin: T): T {
  return plugin;
}

export default dual({ id: 'fast-jev-compaction', server, setup });
