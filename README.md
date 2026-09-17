# fast-jev-compaction

Continuous context compaction for LLM agents using TypeSafe's Jev model.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library asks Jev two narrow questions for each chunk:

1. Can this chunk be removed without losing information needed to continue?
2. What kind of information is it?

Your code then deletes only chunks Jev says are safe to drop. Kept chunks remain
verbatim and in their original order. The design is intended for continuous
compaction on every agent turn, with a target of roughly 150 ms for a small
request (actual latency depends on network and API load).

## How it works

- Messages are split into sentence chunks for user/assistant content and line
  chunks for tool output.
- System chunks are pinned.
- Chunks from the most recent two turns are kept by default.
- Older candidates are sent to Jev in batches. Each chunk gets one `noul`
  removal question and one `choice` kind question.
- The full transcript is included in every batch so each decision has global
  context.
- User instructions and pending tasks are protected when their kind confidence
  is at least `0.5`.
- A chunk is dropped only when its removal probability is at least `0.8`, its
  kind confidence is at least `0.5`, and its kind is not protected.
- Low-confidence classifications and probabilities below the threshold are
  kept.

The TypeSafe documentation says question count is limited by the request token
budget rather than a fixed count: about 32,000 tokens, or roughly 150,000
characters of English text, shared by state and questions. It does not document
an independent maximum state size or a numeric maximum question count. This
package therefore uses a conservative default of 64 questions per call
(32 chunks), marked **unverified** as a server-side numeric limit. Override
`maxQuestionsPerCall` if your state or account needs a smaller batch.

The HTTP response documented by TypeSafe is:

```json
{
  "model": "jev-latest",
  "answers": {
    "question_name": {
      "type": "noul",
      "noul": 0.92
    }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages } from 'fast-jev-compaction';

const { messages, result } = await compactMessages(messages, {
  goal: 'Fix the checkout parser while preserving the public API.',
  dropThreshold: 0.8,
  preserveRecentTurns: 2,
});

console.log(messages);
console.log(result.stats);
```

For a lower-level workflow:

```ts
import { chunkMessages, compact } from 'fast-jev-compaction';

const chunks = chunkMessages(transcript, { mode: 'sentence' });
const result = await compact(chunks, {
  protectedKinds: ['user_instruction', 'pending_task'],
});
```

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. The live demo uses the
same environment variable. Never commit the key or put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `goal` | `''` | Ongoing task description included in state |
| `dropThreshold` | `0.8` | Minimum removal probability to consider dropping |
| `minKindConfidence` | `0.5` | Minimum kind confidence for dropping/protection |
| `protectedKinds` | `user_instruction`, `pending_task` | Kinds that remain protected |
| `preserveRecentTurns` | `2` | Number of newest turns always kept |
| `maxQuestionsPerCall` | `64` | Conservative, unverified numeric batch cap |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |

## Limitations

- The library can delete chunks, but it cannot condense or rewrite them.
- Calibration is at the group/request level; confidence is not a proof that a
  chunk is safe to delete.
- The full transcript is repeated in each batch. Keep batches within the
  documented roughly 32,000-token request budget.
- Every chunk uses two questions, so a 64-question call handles 32 candidate
  chunks. The API's returned `usage` fields are the best basis for cost
  estimates; actual cost depends on state size, batch count, and account
  pricing.
- A failed or unexpected Jev response fails the compaction call rather than
  silently deleting content.

## Claude Code mod

The repository includes an early-access Claude Code function-hook plugin under
[`plugin/`](plugin/). It can return Jev-selected original messages from
`session.compact` and falls back to Claude Code's built-in summary on errors or
insufficient reduction. See [`plugin/README.md`](plugin/README.md) for
installation, configuration, and the Claude Code 2.1.274 type reference.

## Prior art

The protected and classified keep categories mirror the information that
compaction prompts from Claude Code (third-party extracted), Gemini CLI,
OpenAI Codex CLI, and Cline explicitly ask agents to preserve: user intent,
constraints, decisions, files and symbols, errors and fixes, completed work,
pending tasks, blockers, and next steps. This library uses those categories
only as typed decisions and deletes old chunks verbatim instead of asking a
generative model to rewrite them.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests mock `fetch` and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: transcript
chunks are scanned, marked green (keep) or red (drop), and the red ones
collapse away. It uses a canned transcript and never calls the API; it exists
to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start. The large token counter uses
illustrative values (156,000 → 62,000), not tokenizer measurements.
Each line reveals a scripted removal probability, `p(drop)`, beside its
KEEP/DROP verdict as the scan passes.
