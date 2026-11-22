/**
 * Shared bench shapes.
 *
 * A case is a transcript in the engine's own message format, so hand-written
 * cases and real OpenCode sessions run through the same code path. `expect`
 * is keyed by `tool_use_id`, which is what the decisions carry once mapped
 * back.
 */
import type { Message } from '../src/index.js';

export interface CallExpectation {
  /** The call itself still matters downstream (it was referenced later). */
  keepCall?: boolean;
  /** The result must survive verbatim (its contents were used later). */
  keepResult?: boolean;
  /** How the label was obtained. */
  source?: 'hand' | 'next-turn' | 'result-quote';
}

export interface Probe {
  /** Literal fact the next turn used, matched with normalized whitespace. */
  text: string;
  /** Where the fact lived in the compacted region. */
  origin: 'result' | 'call' | 'text';
  /** The call whose result or input holds the fact. */
  call?: string;
  /** `tool_use_id`, when the origin is a call or result. */
  toolUseID?: string;
}

export interface BenchCase {
  id: string;
  note?: string;
  /** Where the case came from: hand-written or a recorded session. */
  source: 'hand' | 'session';
  session?: string;
  title?: string;
  messages: Message[];
  expect: Record<string, CallExpectation>;
  probes?: Probe[];
  /** The user prompt that followed the recorded history, when held out. */
  nextTurn?: string;
}

export interface CaseOutcome {
  id: string;
  source: BenchCase['source'];
  calls: number;
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  /** A result labelled as needed later was dropped or truncated. */
  dangerousResults: number;
  /** A call labelled as needed later was removed. */
  dangerousCalls: number;
  /** A result labelled as not needed was kept anyway (wasted context). */
  wastedResults: number;
  probes: number;
  probesLost: number;
  lostProbeTexts: string[];
  reduction: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
  ms: number;
  error?: string;
}

export interface BenchReport {
  transport: string;
  model: string;
  at: string;
  cases: CaseOutcome[];
  totals: {
    cases: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    dangerousResults: number;
    dangerousCalls: number;
    wastedResults: number;
    probes: number;
    probesLost: number;
    reduction: number;
    msMean: number;
    msP95: number;
    errors: number;
  };
}
