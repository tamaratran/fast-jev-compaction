/**
 * Bench: run the compaction decisions on hand-labelled cases and on real
 * OpenCode sessions, and report the numbers that say whether a backend is
 * better or worse.
 *
 *   tsx bench/run.ts --transport stub
 *   tsx bench/run.ts --transport opencode-http-free
 *   tsx bench/run.ts --transport laya --limit 5
 *   tsx bench/run.ts --transport typesafe --save bench/results/typesafe.json
 *
 * Three numbers matter, in this order:
 *   dangerous  a result the next turn needed was dropped or truncated
 *   lost       a probe the next turn used is no longer in the window at all
 *   reduction  share of characters removed; without it there is no point
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  compact,
  collectToolCalls,
  reductionRatio,
  resolveOptions,
} from '../src/index.js';
import { transportLabel, withTransportLimits } from '../src/transports.js';
import { createAsker } from '../src/opencode/asker.js';
import { authProviders, opencodeAuthKey } from '../src/opencode/auth.js';
import {
  arg,
  benchTransport,
  flag,
  normalize,
  percent,
  readCases,
  windowText,
} from './lib.js';
import type { BenchReport, CaseOutcome } from './types.js';

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function main(): Promise<void> {
  if (flag('presets')) {
    const { PRESET_NOTES } = await import('../src/transports.js');
    for (const [name, note] of Object.entries(PRESET_NOTES)) console.log(`${name.padEnd(20)} ${note}`);
    return;
  }

  const { http, useStub } = benchTransport();
  const key = arg('key', '') || (await opencodeAuthKey(process.env, authProviders(http.baseUrl)));
  const { stubAsker } = await import('./stub.js');
  const asker = useStub
    ? stubAsker()
    : createAsker(http, {
        sessionID: `ses_bench_${Date.now().toString(36)}`,
        authKey: key,
      });

  const limit = Number(arg('limit', '0'));
  const cases = [arg('cases', 'bench/cases'), arg('fixtures', 'bench/fixtures')]
    .flatMap((dir) => readCases(dir))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit > 0 ? limit : undefined);

  if (cases.length === 0) {
    console.error('no cases: run `tsx bin/extract-sessions.ts` and check bench/cases');
    process.exit(1);
  }

  const options = withTransportLimits(
    {
      ...(arg('keep-threshold', '') ? { keepThreshold: Number(arg('keep-threshold', '0')) } : {}),
      ...(arg('preserve', '') ? { preserveRecentMessages: Number(arg('preserve', '0')) } : {}),
    },
    http,
  );
  const resolved = resolveOptions(options);

  console.log(`transport   ${useStub ? 'stub (offline)' : transportLabel(http)}`);
  console.log(`cases       ${cases.length} (${cases.filter((item) => item.source === 'hand').length} hand, ${cases.filter((item) => item.source === 'session').length} session)`);
  console.log(`limits      state ≤${resolved.maxStateTokens}, request ≤${resolved.maxRequestTokens}, threshold ${resolved.keepThreshold}, preserve ${resolved.preserveRecentMessages}`);
  console.log('');
  console.log('case                          calls  kept  drop  danger  probes  lost  saved   ms');

  const outcomes: CaseOutcome[] = [];
  for (const item of cases) {
    const started = Date.now();
    try {
      const result = await compact(item.messages, asker, options);
      const calls = collectToolCalls(item.messages, resolved.preserveRecentMessages);
      const action = new Map(
        calls.map((call) => [
          call.tool_use_id,
          result.decisions.find((decision) => decision.id === call.id)?.action ?? 'keep',
        ]),
      );
      let dangerousResults = 0;
      let dangerousCalls = 0;
      let wastedResults = 0;
      for (const [toolUseID, expectation] of Object.entries(item.expect)) {
        const decided = action.get(toolUseID) ?? 'keep';
        if (expectation.keepResult && decided !== 'keep') dangerousResults += 1;
        if (expectation.keepCall && decided === 'drop_call') dangerousCalls += 1;
        if (expectation.keepResult === false && decided === 'keep') wastedResults += 1;
      }
      const kept = windowText(result.messages);
      const lost = (item.probes ?? []).filter((probe) => !kept.includes(normalize(probe.text)));
      const outcome: CaseOutcome = {
        id: item.id,
        source: item.source,
        calls: result.stats.calls,
        kept: result.stats.kept,
        resultsDropped: result.stats.resultsDropped,
        callsDropped: result.stats.callsDropped,
        dangerousResults,
        dangerousCalls,
        wastedResults,
        probes: item.probes?.length ?? 0,
        probesLost: lost.length,
        lostProbeTexts: lost.map((probe) => probe.text),
        reduction: round(reductionRatio(result)),
        stateTokens: result.stats.stateTokens,
        stateStage: result.stats.stateStage,
        requests: result.stats.requests,
        ms: Date.now() - started,
      };
      outcomes.push(outcome);
      const danger = outcome.dangerousResults + outcome.dangerousCalls;
      console.log(
        `${item.id.slice(0, 29).padEnd(29)} ${String(outcome.calls).padStart(5)} ${String(outcome.kept).padStart(5)} ${String(outcome.resultsDropped + outcome.callsDropped).padStart(5)} ${String(danger).padStart(7)} ${String(outcome.probes).padStart(7)} ${String(outcome.probesLost).padStart(5)} ${percent(outcome.reduction).padStart(6)} ${String(outcome.ms).padStart(5)}`,
      );
      if (flag('verbose') && danger + outcome.probesLost > 0) {
        for (const text of outcome.lostProbeTexts.slice(0, 4)) {
          console.log(`    lost: ${text.slice(0, 120).replace(/\s+/gu, ' ')}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        id: item.id,
        source: item.source,
        calls: 0,
        kept: 0,
        resultsDropped: 0,
        callsDropped: 0,
        dangerousResults: 0,
        dangerousCalls: 0,
        wastedResults: 0,
        probes: item.probes?.length ?? 0,
        probesLost: item.probes?.length ?? 0,
        lostProbeTexts: [],
        reduction: 0,
        stateTokens: 0,
        stateStage: '',
        requests: 0,
        ms: Date.now() - started,
        error: message,
      });
      console.log(`${item.id.slice(0, 29).padEnd(29)} error: ${message.slice(0, 80)}`);
    }
  }

  const times = outcomes.map((outcome) => outcome.ms).sort((a, b) => a - b);
  const totals = {
    cases: outcomes.length,
    calls: outcomes.reduce((sum, item) => sum + item.calls, 0),
    kept: outcomes.reduce((sum, item) => sum + item.kept, 0),
    resultsDropped: outcomes.reduce((sum, item) => sum + item.resultsDropped, 0),
    callsDropped: outcomes.reduce((sum, item) => sum + item.callsDropped, 0),
    dangerousResults: outcomes.reduce((sum, item) => sum + item.dangerousResults, 0),
    dangerousCalls: outcomes.reduce((sum, item) => sum + item.dangerousCalls, 0),
    wastedResults: outcomes.reduce((sum, item) => sum + item.wastedResults, 0),
    probes: outcomes.reduce((sum, item) => sum + item.probes, 0),
    probesLost: outcomes.reduce((sum, item) => sum + item.probesLost, 0),
    reduction: round(
      outcomes.reduce((sum, item) => sum + item.reduction, 0) / Math.max(1, outcomes.length),
    ),
    msMean: round(times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length)),
    msP95: round(times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0),
    errors: outcomes.filter((item) => item.error).length,
  };

  console.log('');
  console.log(`dangerous   ${totals.dangerousResults} results, ${totals.dangerousCalls} calls`);
  console.log(`lost probes ${totals.probesLost}/${totals.probes}`);
  console.log(`reduction   ${percent(totals.reduction)} mean`);
  console.log(`latency     mean ${totals.msMean} ms, p95 ${totals.msP95} ms`);
  console.log(`errors      ${totals.errors}/${totals.cases}`);

  const report: BenchReport = {
    transport: useStub ? 'stub' : transportLabel(http),
    model: http.model,
    at: new Date().toISOString(),
    cases: outcomes,
    totals,
  };
  const save = arg('save', '');
  const path =
    save.length > 0
      ? save
      : join('bench', 'results', `${http.model}-${report.at.replace(/[:.]/gu, '-')}.json`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`saved       ${basename(path)}`);
}

await main();
