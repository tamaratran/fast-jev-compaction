import {
  findTurnStartIndex,
  sessionEntryToContextMessages,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { checkpointAt } from './checkpoint.js';

/** Give Pi only the committed retained transcript and the new prefix to summarize. */
export function prepareCheckpointFallback(event: SessionBeforeCompactEvent, appendCutoff: () => string): void {
  const branch = event.branchEntries;
  let previousIndex = branch.length - 1;
  while (previousIndex >= 0 && branch[previousIndex]?.type !== 'compaction') previousIndex--;
  const previous = branch[previousIndex];
  if (previous?.type !== 'compaction' || !checkpointAt(branch, previousIndex)) return;

  const preparation = event.preparation;
  let cut = branch.findIndex(entry => entry.id === preparation.firstKeptEntryId);
  if (cut < 0) return;
  // Pi's initial cut can lie inside the source interval which the checkpoint
  // replaced. Summarize the checkpoint instead and keep the new tail intact.
  if (cut <= previousIndex) {
    cut = branch.findIndex((entry, index) => index > previousIndex &&
      sessionEntryToContextMessages(entry).length > 0);
    preparation.firstKeptEntryId = cut < 0 ? appendCutoff() : branch[cut]!.id;
    if (cut < 0) cut = branch.length;
    preparation.isSplitTurn = false;
  }
  const turnStart = preparation.isSplitTurn
    ? findTurnStartIndex(branch, cut, previousIndex + 1) : -1;
  preparation.isSplitTurn = turnStart >= previousIndex + 1;
  preparation.turnPrefixMessages = preparation.isSplitTurn
    ? branch.slice(turnStart, cut).flatMap(sessionEntryToContextMessages) : [];
  preparation.messagesToSummarize = branch
    .slice(previousIndex + 1, preparation.isSplitTurn ? turnStart : cut)
    .flatMap(sessionEntryToContextMessages);
  preparation.previousSummary = previous.summary;

  // Pi 0.85.1 omits previousSummary when only a turn prefix is summarized.
  // An explicit history row ensures it is consumed even on that path.
  if (preparation.messagesToSummarize.length === 0) {
    preparation.messagesToSummarize = [{
      role: 'user', content: previous.summary, timestamp: new Date(previous.timestamp).getTime(),
    }];
    preparation.previousSummary = undefined;
  }
}
