/**
 * One JSON line per compaction attempt, so a trial can answer whether the
 * plugin is worth keeping. No transcript content is written: only counts,
 * decisions, the backend and the error text if one happened.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CallDecision, CompactResult } from '../types.js';

export interface TrialEntry {
  at: string;
  session: string;
  backend: string;
  transport: string;
  ok: boolean;
  /** Why an attempt did not replace the summary. */
  reason?: 'error' | 'low_reduction' | 'nothing_to_drop' | 'already_compacted';
  error?: string;
  ms: number;
  stats?: CompactResult['stats'];
  reduction?: number;
  decisions?: Pick<CallDecision, 'id' | 'tool' | 'action' | 'reason' | 'keepCall' | 'keepResult'>[];
  /** Estimated tokens the compaction saved. */
  tokensSaved?: number;
}

export type TrialRecord = (entry: TrialEntry) => Promise<void>;

/** Appends to a JSONL file; a failure to log never fails the compaction. */
export function trialRecorder(path: string): TrialRecord {
  return async (entry) => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // The compaction already answered; a lost log line is not worth a retry.
    }
  };
}

export function noTrial(): TrialRecord {
  return async () => {};
}
