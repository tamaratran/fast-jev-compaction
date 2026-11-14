# Handoff: Jev to local Laya

Branch `Chamoouske/laya-backend`. Three commits on top of `e3f262a`, not
pushed:

- `09af4d0 feat!:` new backend, per-call state, tests. The removal of
  `demo/JevDemo` (a macOS Swift animation that only showed Jev) also landed
  in this commit.
- `95f75ad chore:` rename to `fast-laya-plugin` in `plugin.json`,
  `marketplace.json`, `package.json` and the lock file.
- `b6546f1 docs:` `README.md` and `hooks/README.md`.

## What changed

- `src/request.ts` and `src/client.ts`: keyless POST to
  `http://127.0.0.1:8000/v1/systemone` (the `laya-serve` default port), with
  default model `laya` (the English checkpoint, pinned so language detection
  cannot route code text to another window). `baseUrl` is a `userConfig`
  option and reaches `buildLayaRequest` through `layaAsker()`.
  `apiKey` and `TYPESAFE_API_KEY` are gone.
- Renamed `Jev*` identifiers to `Laya*` (`LayaClient`, `LayaAsker`,
  `buildLayaRequest`, `parseLayaResponse`, wire types). The hook is now
  `hooks/fast-laya.ts`.
- `src/state.ts`: `fitCallState` builds one state per call and replaces
  `fitState` and `batchCalls`. `src/apply.ts` holds `applyDecisions` and
  `messageChars`, moved out of `compact.ts`. `src/limit.ts` holds
  `mapLimit`, which runs the requests with bounded concurrency.
- The fallback is unchanged: on any error, or a reduction below
  `minReductionRatio`, the hook calls `next(event)`. This is now covered by
  tests that drive `register` with a fake `$`.

## Context window: how laya-serve behaves past max_len

Measured against `laya-serve` 0.3.22 (English checkpoint, `max_len` 512, CUDA):

| State | Result |
| --- | --- |
| 106 tokens | 200, `truncated: false` |
| 806 / 4006 / 12006 tokens | 200, **same answer (0.7938) for all three**, `truncated: true`, `state_tokens_dropped` 328 / 3528 / 11528 |
| more than 50,000 characters | 413 `state too large` |
| `max_len` 9000 in the body | 422 (server cap 8192) |
| `max_len` 8192 on the English checkpoint, 3k tokens | 200, 8.9 s for one question |

So the server **truncates silently**: it keeps the head of the serialized
JSON and drops the tail. The only signal is in `usage`, and only when
`LAYA_JEV_STRICT` is off, which is the default.

## Strategy chosen: (B), one state per call

Each candidate call gets its own state: goal, the two nearest prose messages
before and after, its input, `ok`/`error` with the output size, a preview of
the output, and up to 8 later calls on one line each. It is fitted into
`maxStateTokens` (400) by trying 5 size levels, and the keys are ordered so
that the tail, which is cut first, is the least important part. Why (B):

- (A) means a whole session in 8192 tokens on a checkpoint trained at
  512 or 1024. That is 9 s per question on this GPU, and quality is unknown
  that far past the trained length.
- (B) stays inside the trained window. The question head for `fate` is 86
  tokens (measured), so the state has 425 tokens of room. The plugin counts
  the requests the server reports as cut (`stats.truncatedRequests`, shown
  in the toast).

### Change to the question design (deviation, please review)

With the Jev design (two `noul` questions per call), Laya gave almost no
spread: every answer was between 0.51 and 0.74, and "this call is obsolete"
scored 0.43–0.59 on every call. Everything was kept, so the
reduction was 0%. I tested five phrasings and none was better. I switched to
**one `choice` question**, `fate` (`keep`/`truncate`/`drop`), mapped to
`keepResult = p(keep)` and `keepCall = p(keep) + p(truncate)`, so the
decision rule and `keepThreshold` keep their meaning. On the demo transcript:
53% reduction, Edit and the final test kept, Read and Glob truncated. It also
needs half the forward passes. Reversing the option order moved the
probabilities only a little (one marginal flip, on t2). Even so, the signal
mostly follows the tool type, not the content.

### Token estimator

The estimator was refit on 1,434 samples (code, JSON and prose from this
repo, `package-lock.json` and `types/`) counted with the real tokenizer
(`tokenizer.json` of the checkpoint, ModernBERT BPE). Ratio estimate/real:
median 1.04, p5 0.93, p95 1.14, min 0.83 (base64 hashes), max 1.22. The old
Jev estimator on the same samples: 0.66–1.26. The calibration scripts lived
in the session scratchpad and were not committed.

## Test results

- `npm test`: **34/34 passed** with `laya-serve` running. 31 pass and 3 are
  skipped when it is not running (`tests/laya-serve.integration.test.ts`
  uses `describe.skipIf`; `LAYA_URL` overrides the endpoint).
- `npm run typecheck` (library and hooks): clean.
- `npm run build`: clean.
- `claude plugin validate` on both manifests: passed. One warning remains:
  `plugin.json` has no `author`.

## What was validated against the real Laya

On a local `laya-serve` (`uv tool install "laya[serve]"`, laya 0.3.22,
English checkpoint revision `85cc74dd`, GTX 1650):

- The truncation behaviour in the table above.
- Every per-call state of the demo transcript fits without truncation, and
  the estimate is within 0.8–1.3× of the server's `state_tokens`.
- `compactMessages` end to end: 7 requests, 0 cut, 4475 to 2088 characters.
- Latency: about 1.2 s per request on the GTX 1650 and 3.6 s on CPU (8 logical
  cores). `laya-serve` serializes requests, so concurrency 4 does not speed
  things up. This is far from the 33–40 ms per question quoted for a T4;
  this GPU has no bf16 support, which is a likely cause, but I did not
  confirm it.
- GPU and CPU gave the same decisions.

## Not validated / pending

- **The hook was not run inside a real Claude Code session.** It was only
  tested with a fake `$`. Next step: start Claude Code with the function-hooks
  flag and `claude --plugin-dir .`, then run `/compact` on a real session.
- `laya-multilingual` was not tested: its download stalled at about 400 MB
  and I started the server with `LAYA_MODELS=english`. The docs say to use
  `maxStateTokens` of about 900 with it, but that number is not measured.
- Decision quality is the main risk. Laya is not trained for this task. A
  real evaluation on real sessions, with tuning of the `fate` wording and
  `keepThreshold`, is still to do. The `/v1/systemone/batch` endpoint (one
  question set for up to 64 states) could cut the HTTP overhead, but it is
  not part of the Jev protocol, so I did not use it.
- On a 50-call session the hook takes about a minute on this GPU. Consider a
  cap on candidates, or asking only about the oldest calls.
- The `LICENSE` file is untouched (MIT, "Copyright (c) 2025" with no name).
  Credit to tamaratran/fast-jev-compaction is in the README.
- The SQLite cache and MCP server in `fast-laya-compaction` are out of scope
  and were not touched.
