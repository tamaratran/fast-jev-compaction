# Jev compaction fork: preserving exact detail

Date: 2026-09-25
Status: design approved, pending spec review
Upstream: https://github.com/tamaratran/fast-jev-compaction (MIT)
Branch: `verbatim-fidelity`

## Problem

Claude Code's built-in compaction replaces conversation history with a prose
summary. Summaries paraphrase, and paraphrase destroys the things that must
survive intact: file paths, identifiers, exact commands, config values, error
strings. After a compaction the session is fluent about what happened and
wrong about the specifics.

`fast-jev-compaction` already fixes the core of this. It replaces the summary
step with per-tool-call decisions from Jev, and whatever it keeps stays
**verbatim**. Nothing is ever reworded.

This fork addresses two defects in *which* content survives, and moves the
transport to OpenRouter.

## Goals

1. Run against OpenRouter, since direct TypeSafe console signup is paused.
2. When a tool result is dropped, its identifiers survive rather than its
   first three lines.
3. Let Jev see the content it is judging, so "keep this verbatim" is a
   grounded decision rather than an inference from a byte count.

## Non-goals

- Pruning assistant/user prose. Deferred; see "Deferred work".
- Replacing the built-in compaction as a fallback. It stays as the safety net.
- Beating the built-in summariser on raw token reduction. Fidelity is the
  objective; reduction is a constraint, not the target.

## How upstream works today

At a compaction boundary Claude Code invokes the `session.compact` function
hook (requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, Claude Code >= 2.1.274).
Verified signature against the 2.1.282 binary:

- Receives `{ trigger, agentId, instructions?, messages }`, where `trigger`
  includes `"precompute"` (compaction is precomputed in the background).
- Returns `{ skip?, messages?, tokensBefore?, tokensAfter?, usage? }`.
  `messages` replaces the transcript wholesale. `skip` is a non-empty reason
  string that falls back to built-in compaction. Returning both is rejected.
  Hooks compose via `next()`.

The pipeline:

1. `collectToolCalls` pairs each `tool_use` with its `tool_result`. Calls in
   message 0 or the last `preserveRecentMessages` (default 6) are `pinned` and
   never dropped.
2. `fitState` builds the Jev state: a `goal` (defaulting to the last three
   user prompts), plus the whole history oldest-first with every tool result
   replaced by `resultNote()`, i.e. `"ok, 4213 chars (omitted)"`. It then
   shrinks through six escalating stages until it fits `maxStateTokens`
   (25_000): truncate tool inputs, abridge long texts, collapse old messages,
   compact old calls to one line, drop call-less old messages, fold runs of
   call-only messages. Throws if it still does not fit.
3. `questionsFor` asks two `noul` questions per call: should the *call* stay,
   and should its *result* stay verbatim.
4. `batchCalls` splits questions into requests that fit `maxRequestTokens`
   (30_000) alongside the full state. Batches are issued in parallel; each
   batch re-sends the entire state.
5. `decideCall` applies `keepThreshold` (0.5): `keepResult` over threshold
   keeps both; else `keepCall` over threshold drops the result only; else the
   call is dropped.
6. `applyDecisions` rebuilds the transcript. Dropped results keep a blind
   `truncateHeadChars` (300) prefix plus a note. A dropped call removes the
   call and its result together. Messages emptied of all content are removed.

## Findings that motivate this fork

**F1 - Jev judges output it cannot see.** `resultNote()` reduces every result
to `"ok, 4213 chars (omitted)"`. The question "should the full output stay
verbatim" is therefore answered from the tool name, its input, a character
count and an ok/error flag. This is the largest accuracy defect and it is not
mentioned in any public critique.

**F2 - dropped results lose exactly what we care about.** `truncateHeadChars`
keeps the first 300 characters. For a directory listing, a test run or a build
log, the first 300 characters are preamble; the paths, failures and
identifiers live further down. This is the defect that most directly causes
the symptom in "Problem".

**F3 - errors keep their flag but lose their text.** `isError` is in the
state, so Jev knows a call failed, but the error content is omitted. The
reason a thing failed is the part that prevents a retry.

**F4 - state is re-sent per batch.** Long sessions issue several batches, each
paying the full state cost. Tolerable at $0.042/MTok, but it caps how much can
be added to the state.

Two widely-repeated criticisms of this approach do **not** apply here, and the
design deliberately does not defend against them:

- *"Breaks prompt caching."* That applies to continuous mid-session pruning.
  `session.compact` fires only at the compaction boundary, where the prefix is
  discarded regardless. The filtered result becomes the new stable prefix and
  caches normally.
- *"Strips encrypted reasoning traces."* The `Message` type the hook receives
  exposes only `text`, `toolUses` and `toolResults`. Thinking blocks are not
  surfaced, and compaction drops them either way.

## Design

Three changes. `state.ts` is not modified; its shrink ladder is tuned and
works.

### 1. OpenRouter transport - `src/openrouter.ts` (new)

`JevClient` in `src/client.ts` implements a `JevAsker` interface with a single
`ask(state, questions)` method, and the HTTP concern is already isolated in
`buildJevRequest` / `parseJevResponse` as pure functions. Add a sibling
`OpenRouterClient` implementing the same interface against
`POST https://openrouter.ai/api/alpha/decisions` with model
`typesafe/jev-1.13` (or `~typesafe/jev-latest`).

This is a distinct endpoint from OpenAI-compatible chat completions; chat SDKs
do not work with it. Selection is by config, defaulting to OpenRouter when
`OPENROUTER_API_KEY` is set and TypeSafe otherwise, so upstream behaviour is
preserved for anyone with a TypeSafe key. When both keys are present, OpenRouter wins unless `transport` says otherwise.

Budget change: OpenRouter advertises a 32k context for Jev against TypeSafe's
64k. `maxRequestTokens` must drop to leave headroom. Proposed:
`maxStateTokens` 20_000 and `maxRequestTokens` 28_000 when the OpenRouter
transport is active, retaining the current values otherwise.

### 2. Salvage on drop - `src/salvage.ts` (new)

Replace `truncatedResultText`'s blind head with a smaller head sample plus a
deterministic extraction that scans the **whole** result for high-value
tokens:

- absolute and relative file paths
- URLs
- git SHAs and long hex/UUID identifiers
- `KEY=value` style config and env var names (names only, never values - see
  "Security")
- exit codes and non-zero status lines
- lines matching error/failure/exception patterns

Results are deduplicated, ordered by first appearance, and capped by a
`salvageMaxChars` budget. The output is a compact block appended to the head
sample, clearly marked as salvaged rather than verbatim, so the model is not
misled into thinking it has the full result.

This is a pure function of `(text, isError, budget)`. No Jev call, no added
state cost, no network. It is the highest-certainty win in the fork and is
independently testable.

### 3. Peek in the question - `src/compact.ts` (modified)

> **Withdrawn 2026-09-28, kept here for the record.** B1aZer ran this change
> over 60 OpenHands sessions and could not measure a benefit at any budget
> (0.19 vs 0.20 at 10% kept, 0.46 vs 0.46 at 25%, 0.67 vs 0.66 at 50%, every
> confidence interval spanning zero), with ranking AUC falling from 0.68 to
> 0.63. Their reading is that Jev's scores track the kind of call rather than
> its content, which matches what we measured independently. One difference
> worth noting: they placed the sample in the state, where it competes for
> the state budget, while the design below places it in the question. That
> changes the cost, not the mechanism they measured, so we are not pursuing
> it. Section 2 (salvage) is a different mechanism and is unaffected.

Give `questionsFor` access to a bounded head+tail sample of the real result
text and embed it in the `result_*` question instructions.

The sample goes in the **question**, not the state. Jev evaluates every
question in parallel and in isolation against the same shared state, so a
sample placed in the state would be re-sent with every batch (F4) and would
consume the budget `fitState` needs, regressing history fidelity in order to
fix F1. Placed in the question it is paid once per call, and `batchCalls`
already budgets questions separately from state, so this uses the existing
structure rather than fighting it.

`peekHeadChars` / `peekTailChars` are config, and the sample shrinks
automatically when `batchCalls` finds itself short of budget rather than
throwing.

F3 follows from this at no extra cost: when `isError` is set, the peek is
biased toward the tail, where failure output normally lives.

## Data flow

```
session.compact hook
  -> messages[]
  -> collectToolCalls        (pin first + last N)
  -> fitState                (unchanged; results still stubbed)
  -> questionsFor + peek     (NEW: sample per result, in the question)
  -> batchCalls              (shrinks peek if short on budget)
  -> OpenRouter /decisions   (NEW transport) | TypeSafe /systemone
  -> decideCall              (unchanged thresholds)
  -> applyDecisions
       keep        -> verbatim, untouched
       drop_result -> head sample + salvaged identifiers   (NEW)
       drop_call   -> call and result removed together
  -> { messages, tokensBefore, tokensAfter, usage }
```

## Configuration

New keys, all optional, defaults chosen so an unconfigured install behaves
like upstream plus salvage:

| Key | Default | Purpose |
|---|---|---|
| `transport` | auto | `openrouter` or `typesafe`; auto-selects on which key is present |
| `salvageMaxChars` | 600 | cap on the salvaged identifier block |
| `truncateHeadChars` | 150 | reduced from 300; salvage covers the rest |
| `peekHeadChars` | 200 | head sample embedded in the result question |
| `peekTailChars` | 100 | tail sample; weighted higher on errors |
| `maxStateTokens` | 20_000 on OpenRouter | was 25_000 |
| `maxRequestTokens` | 28_000 on OpenRouter | was 30_000 |

## Error handling

Unchanged in shape, which matters: every failure path already returns `skip`
with a reason and Claude Code falls back to built-in compaction. The fork must
preserve this. Specifically:

- transport error, non-2xx, malformed JSON, missing `answers` -> `skip`
- `fitState` throwing (history too large) -> `skip`
- salvage throwing on pathological input -> must NOT skip; catch and fall back
  to the plain head truncation, since salvage is an enhancement to a path that
  already works

Worst case the fork is never worse than the current built-in behaviour.

## Testing

The existing suite injects a fake `JevAsker`, so it covers the new code paths
without network access.

- `salvage.ts`: table-driven over captured real tool output - `ls` listings,
  `npm test` failures, `git log`, stack traces, JSON blobs, binary-ish noise.
  Assert that known identifiers survive and that the budget cap holds.
- `questionsFor`: peek is present, bounded, and tail-weighted on errors.
- `batchCalls`: peek shrinks instead of throwing when budget is tight.
- `openrouter.ts`: request shape via injected `fetch`; response parsing
  including error bodies.
- End-to-end on a recorded transcript: assert reduction ratio and that a
  seeded set of identifiers survives compaction.

A regression guard worth having: a test asserting no code path can return both
`skip` and `messages`, since the hook contract rejects it.

## Security

The salvage extractor matches `KEY=value` patterns. It must capture the
**name only** and never the value, or compaction becomes a mechanism for
copying secrets from a tool result into the retained context. This is a hard
requirement with a dedicated test.

API keys are read from the environment and must never be written to the repo,
logs, decision records or the `stats` object. This fork is intended for
upstream contribution, so every commit is public.

## Open questions

1. **OpenRouter wire format is unverified.** The public docs reference
   `POST /api/alpha/decisions` but the linked schema page 404s, and the exact
   encodings for `Noul` / `Choice` / `Score` and the response field names are
   not published anywhere reachable. Whether OpenRouter mirrors TypeSafe's
   `{model, state, questions}` body is an assumption. This must be settled
   empirically against a real key as implementation step 1, before anything
   else is built on it.
2. Does OpenRouter's 32k apply to state and questions combined, or per field?
   Affects the budget numbers above.
3. Rate limits on the decisions endpoint are undocumented; parallel batches
   may need throttling.

## Deferred work

**Pruning narrative prose (approach C).** `collectToolCalls` only considers
tool_use/tool_result pairs, so a session dominated by long assistant prose
reduces almost not at all. Extending candidates to text messages, with Jev
separating narrative from decisions and constraints, would fund more verbatim
retention. Deferred because it is the change most likely to regress fidelity,
and it should be driven by measurements from real sessions rather than by
reasoning.
