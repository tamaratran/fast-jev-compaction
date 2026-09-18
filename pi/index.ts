/**
 * fast-jev-compaction — pi extension
 *
 * Takes over pi's compaction. Instead of asking the conversation model to
 * summarize old turns (lossy), it asks TypeSafe's Jev model whether each tool
 * call and each tool result still needs to stay. Stale calls/results are
 * dropped or truncated; everything else is written into the compaction
 * summary as a verbatim transcript. pi's kept window (recent messages) is
 * left untouched as real messages. Falls back to pi's built-in LLM summary
 * when Jev fails, when the API key is missing, or when Jev cannot reduce
 * the old region enough.
 *
 * Configuration: ~/.pi/agent/fast-jev-compaction.json,
 * <project>/.pi/fast-jev-compaction.json, and environment variables —
 * see pi/README.md.
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { jevCompactionForPi, loadConfig } from './core.js';
import { JevClient } from '../src/index.js';
import type { JevAsker } from '../src/index.js';

export default function (pi: ExtensionAPI) {
  pi.on('session_before_compact', async (event, ctx) => {
    const config = loadConfig({
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      configDirName: CONFIG_DIR_NAME,
      env: process.env,
    });

    const notify = (message: string, level: 'info' | 'warning' | 'error'): void => {
      if (!config.notify) return;
      try {
        ctx.ui.notify(message, level);
      } catch {
        // UI may be unavailable in some modes; never fail compaction for it.
      }
    };

    if (config.disabled) return; // silently use pi's built-in compaction
    if (event.signal.aborted) return { cancel: true };
    if (!config.apiKey) {
      notify('fast-jev: no TYPESAFE_API_KEY, using built-in summary', 'warning');
      return;
    }

    const asker: JevAsker = new JevClient({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      fetch: (url, init) => fetch(url, { ...init, signal: event.signal }),
    });

    const outcome = await jevCompactionForPi({
      branchEntries: event.branchEntries,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      asker,
      config,
    });

    if (!outcome.ok) {
      if (event.signal.aborted) return { cancel: true };
      notify(`fast-jev: using built-in summary (${outcome.fallback})`, 'warning');
      return;
    }

    notify(outcome.report, 'info');
    return {
      compaction: {
        summary: outcome.summary,
        firstKeptEntryId: outcome.firstKeptEntryId,
        tokensBefore: outcome.tokensBefore,
        usage: outcome.usage,
        details: outcome.details,
      },
    };
  });
}
