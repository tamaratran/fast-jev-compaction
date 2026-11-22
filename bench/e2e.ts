/**
 * End-to-end check on recorded sessions: after compaction, is the evidence the
 * next turn used still there, and can a model still answer from it?
 *
 * The baseline is the thing this plugin replaces — a model-written summary. Both
 * get the same probes, so the report answers "better or worse" directly:
 *
 *   tsx bench/e2e.ts --transport stub              # deterministic, offline
 *   tsx bench/e2e.ts --transport opencode-http-free --baseline
 *   tsx bench/e2e.ts --transport opencode-http-free --ask --probes 2
 *
 * `--baseline` costs one chat call per session, `--ask` one per probe.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compact, type Message } from '../src/index.js';
import { transportLabel, withTransportLimits } from '../src/transports.js';
import { createAsker } from '../src/opencode/asker.js';
import { authProviders, opencodeAuthKey } from '../src/opencode/auth.js';
import { chat } from './chat.js';
import {
  arg,
  benchTransport,
  flag,
  normalize,
  percent,
  readCases,
  renderWindow,
} from './lib.js';

interface Row {
  id: string;
  probes: number;
  windowKept: number;
  summaryKept?: number;
  askHit?: number;
  askSummaryHit?: number;
  reduction: number;
  ms: number;
  error?: string;
}

const SUMMARY_PROMPT =
  'You compact a long coding session so the work can continue in a new context. ' +
  'Keep every exact file path, command, error message, constraint and decision. ' +
  'Be dense and factual; no preamble, no advice.';

function countKept(probes: readonly { text: string }[], haystack: string): number {
  return probes.filter((probe) => haystack.includes(normalize(probe.text))).length;
}

async function askProbe(
  transcript: string,
  probe: string,
  model: string | undefined,
): Promise<boolean> {
  const target = probe.length > 140 ? probe.slice(0, 140) : probe;
  const answer = await chat(
    [
      {
        role: 'system',
        content:
          'You answer only from the transcript you are given. Quote text exactly as it appears. ' +
          'If the requested text is not present, reply with the single word MISSING.',
      },
      {
        role: 'user',
        content: `Transcript:\n\n${transcript}\n\nQuote the exact fragment from the transcript that contains:\n${target}\n\nAnswer with the quoted text only.`,
      },
    ],
    { model, maxTokens: 300 },
  );
  if (/\bMISSING\b/u.test(answer)) return false;
  return normalize(answer).includes(normalize(target));
}

async function main(): Promise<void> {
  const { http, useStub } = benchTransport();
  const key = arg('key', '') || (await opencodeAuthKey(process.env, authProviders(http.baseUrl)));
  const { stubAsker } = await import('./stub.js');
  const asker = useStub
    ? stubAsker()
    : createAsker(http, { sessionID: `ses_e2e_${Date.now().toString(36)}`, authKey: key });

  const withSummary = flag('baseline') || flag('ask-baseline');
  const ask = flag('ask') || flag('ask-baseline');
  const probesPerCase = Number(arg('probes', '2'));
  const chatModel = arg('chat-model', '') || undefined;
  const limit = Number(arg('limit', '0'));

  const fixtures = readCases(arg('fixtures', 'bench/fixtures'))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit > 0 ? limit : undefined)
    .filter((item) => (item.probes?.length ?? 0) > 0);

  if (fixtures.length === 0) {
    console.error('no fixtures with probes: run `tsx bin/extract-sessions.ts`');
    process.exit(1);
  }

  const options = withTransportLimits({}, http);
  console.log(`transport   ${useStub ? 'stub (offline)' : transportLabel(http)}`);
  console.log(`fixtures    ${fixtures.length}`);
  console.log(`modes       probes${withSummary ? ' + summary baseline' : ''}${ask ? ' + ask' : ''}`);
  console.log('');
  console.log('fixture                       probes  kept  lost  summary  ask  ask-sum  saved   ms');

  const rows: Row[] = [];
  const summaries: { id: string; text: string }[] = [];
  for (const fixture of fixtures) {
    const probes = (fixture.probes ?? []).slice(0, Math.max(1, probesPerCase));
    const started = Date.now();
    try {
      const result = await compact(fixture.messages, asker, options);
      const windowText = renderWindow(result.messages);
      const windowKept = countKept(probes, windowText);
      let summaryKept: number | undefined;
      let summaryText = '';
      if (withSummary) {
        summaryText = await chat(
          [
            { role: 'system', content: SUMMARY_PROMPT },
            { role: 'user', content: `Conversation:\n\n${renderWindow(fixture.messages)}` },
          ],
          { model: chatModel, maxTokens: 2000 },
        );
        summaries.push({ id: fixture.id, text: summaryText });
        summaryKept = countKept(probes, summaryText);
      }
      let askHit: number | undefined;
      let askSummaryHit: number | undefined;
      if (ask) {
        askHit = 0;
        for (const probe of probes) {
          if (await askProbe(windowText, probe.text, chatModel)) askHit += 1;
        }
        if (withSummary) {
          askSummaryHit = 0;
          for (const probe of probes) {
            if (await askProbe(summaryText, probe.text, chatModel)) askSummaryHit += 1;
          }
        }
      }
      const row: Row = {
        id: fixture.id,
        probes: probes.length,
        windowKept,
        ...(summaryKept === undefined ? {} : { summaryKept }),
        ...(askHit === undefined ? {} : { askHit }),
        ...(askSummaryHit === undefined ? {} : { askSummaryHit }),
        reduction: Math.round((1 - result.stats.charsAfter / Math.max(1, result.stats.charsBefore)) * 1000) / 1000,
        ms: Date.now() - started,
      };
      rows.push(row);
      console.log(
        `${fixture.id.slice(0, 28).padEnd(28)} ${String(row.probes).padStart(6)} ${String(row.windowKept).padStart(5)} ${String(row.probes - row.windowKept).padStart(5)} ${summaryKept === undefined ? '      -' : String(summaryKept).padStart(8)} ${askHit === undefined ? '   -' : String(askHit).padStart(4)} ${askSummaryHit === undefined ? '       -' : String(askSummaryHit).padStart(8)} ${percent(row.reduction).padStart(6)} ${String(row.ms).padStart(5)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push({
        id: fixture.id,
        probes: probes.length,
        windowKept: 0,
        reduction: 0,
        ms: Date.now() - started,
        error: message,
      });
      console.log(`${fixture.id.slice(0, 28).padEnd(28)} error: ${message.slice(0, 70)}`);
    }
  }

  const sum = (pick: (row: Row) => number | undefined): number =>
    rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const probes = sum((row) => row.probes);
  const windowKept = sum((row) => row.windowKept);

  console.log('');
  console.log(`window kept ${windowKept}/${probes} (${percent(windowKept / Math.max(1, probes))})`);
  if (withSummary) {
    const kept = sum((row) => row.summaryKept);
    console.log(`summary kept ${kept}/${probes} (${percent(kept / Math.max(1, probes))})`);
  }
  if (ask) {
    const hit = sum((row) => row.askHit);
    console.log(`ask on window ${hit}/${probes} (${percent(hit / Math.max(1, probes))})`);
    if (withSummary) {
      const kept = sum((row) => row.askSummaryHit);
      console.log(`ask on summary ${kept}/${probes} (${percent(kept / Math.max(1, probes))})`);
    }
  }
  console.log(`errors ${rows.filter((row) => row.error).length}/${rows.length}`);

  const save = arg('save', '');
  if (save.length > 0) {
    mkdirSync(join(save, '..'), { recursive: true });
    writeFileSync(save, `${JSON.stringify({ at: new Date().toISOString(), rows, summaries }, null, 2)}\n`);
    console.log(`saved ${save}`);
  }
}

await main();
