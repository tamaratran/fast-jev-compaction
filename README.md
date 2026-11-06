# Metzger

Context compaction for Claude Code that doesn't lose anything important.

When Claude Code runs out of context, it normally summarizes old messages, and
summaries are lossy. A file path, an exact error, a constraint you mentioned
three turns ago: gone. Metzger takes a different approach. It runs a small, fast
model locally on your machine that reads the whole conversation and scores every
tool call for relevance. Stale ones get cut. Everything else stays word for word.

The name comes from the German word for butcher: someone who knows exactly
where to cut and what to keep.

## How it works

1. Your conversation fills up (or you run `/compact`).
2. Metzger sends the full conversation to a tiny local model (under 1 GB) that
   scores each tool call and result: is this still relevant to what we're doing?
3. Calls that score above the threshold stay untouched. Calls below it get
   trimmed or removed entirely.
4. User and assistant text is **never** changed. Only tool calls and their
   outputs are candidates for removal.

The result: you keep your messages, code, and errors intact, without the tool
output you'll never look at again.

## Quick start

### 1. Install Ollama

Metzger needs [Ollama](https://ollama.com) to serve the scoring model locally.

```sh
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS
brew install ollama

# Windows: download from https://ollama.com/download
```

Verify it's running: `ollama --version` (requires 0.35+).

### 2. Pull the model

```sh
ollama pull kaineone/metzger:0.8b
```

That's an 833 MB download. It runs on CPU, no GPU required. Takes
about a second to load and scores a full conversation in a few seconds.

### 3. Install the plugin

```sh
claude plugin marketplace add FlintWave/metzger
claude plugin install metzger@metzger
```

That's it. From now on, compaction (automatic or `/compact`) goes through
Metzger. You'll see a toast like:

```
kept 42/67 messages, no summary (35% reduction; 18 kept, 7 results truncated…)
```

If Metzger can't cut enough (short sessions, or if Ollama is down), it falls
back to Claude Code's built-in summary automatically.

### First-run check

When you start a session, Metzger pings Ollama to make sure it's running and
the model is pulled. If something's missing, you'll see a toast with the exact
command to fix it.

## Models

All Metzger models are fine-tuned from Qwen 3.5 for relevance scoring of
conversation messages. They speak the Jev decision protocol.

| Model | Params | Size | Quant | Notes |
| --- | --- | --- | --- | --- |
| `kaineone/metzger:0.8b` | 773M | 833 MB | Q8_0 | **Default.** Fast on CPU or GPU. Good accuracy for most sessions. |
| `kaineone/metzger` | 4.3B | 4.6 GB | Q8_0 | Higher accuracy. Needs a GPU with 6+ GB VRAM; slow on CPU-only machines. |
| `kaineone/metzger:distill-0.8b` | 752M | 1.5 GB | F16 | Distilled variant for the chat-API backend. Full precision. |

The 0.8b default is intentional. It loads in under a second and barely touches
your VRAM. The 4.3B model is
there if you want to trade speed for accuracy. To switch:

```json
{
  "pluginConfigs": {
    "metzger": {
      "model": "kaineone/metzger"
    }
  }
}
```

## What it actually does to your messages

Here's a concrete example. Say you have a 67-message conversation where Claude
read a bunch of files, ran some tests, hit errors, fixed them, and moved on.
Metzger looks at the whole thing and might decide:

- The `Read` of `src/auth.ts` from 40 messages ago? You moved on to a
  completely different file. **Cut.**
- The failed `npm test` output from before the fix? You already fixed it.
  **Cut.**
- The `Read` of `src/config.ts` that you're still referencing? **Keep.**
- The user's instruction "never edit anything under src/generated"? That's text,
  not a tool call. **Always kept.**

After Metzger runs, the conversation is shorter but nothing important is gone.
Claude still has your instructions and the code it's actively working with. It just doesn't have the `cat` output of a file you
looked at once and never touched again.

## Under the hood

The scoring model gets the full conversation as context (with tool outputs
replaced by short summaries to fit the token budget). For each tool call outside
the pinned messages (first message + most recent N), it asks two questions:

- **Should this call stay?** (knowing it was made, with its input, still matters)
- **Should the result stay verbatim?** (the actual output is still needed and
  re-running the tool wouldn't work)

The answers are probabilities. Above `keepThreshold` (default 0.5), the item
stays. Below it for the result but above for the call: the result is truncated
to its first 300 characters plus a note. Below it for both: the whole thing is
removed.

If the conversation is long, the scoring is split across multiple requests
(same full context, different batches of questions) that run concurrently.

## Options

Set these in `~/.claude/settings.json` under `pluginConfigs.metzger`:

| Option | Default | What it does |
| --- | --- | --- |
| `model` | `metzger:0.8b` | Which scoring model to use |
| `keepThreshold` | `0.5` | Probability cutoff. Lower keeps more, higher cuts more aggressively |
| `preserveRecentMessages` | `6` | Most recent messages that are never touched |
| `compactAtPercent` | `60` | Context fill % that triggers automatic compaction |
| `minReductionRatio` | `0.25` | Minimum reduction needed to use Metzger's output (otherwise falls back to built-in summary) |
| `maxStateTokens` | `25000` | Token budget for the conversation context sent to the scorer |
| `maxRequestTokens` | `30000` | Token budget per scoring request (context + questions) |
| `truncateHeadChars` | `300` | Characters kept from a truncated tool result |
| `baseUrl` | `http://localhost:11434/v1/systemone` | Scoring endpoint (change for TypeSafe cloud) |
| `backend` | `auto` | `systemone` for Jev API, `chat` for Ollama chat API (distilled models), `auto` to detect |

## TypeSafe cloud API (alternative)

If you don't want to run a local model, you can use TypeSafe's hosted Jev API:

```json
{
  "pluginConfigs": {
    "metzger": {
      "model": "jev-latest",
      "baseUrl": "https://api.typesafe.ai/v1/systemone"
    }
  }
}
```

Set your API key as `TYPESAFE_API_KEY` in your environment or as the `apiKey`
plugin option.

## npm library

Metzger is also an npm package if you want to use the compaction logic in your
own tools:

```sh
npm install metzger
```

```ts
import { compactMessages, reductionRatio, type Message } from 'metzger';

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in directly.

## Limitations

- Only tool calls and results are candidates for removal. Text messages are
  never changed.
- Token counts are estimated from character counts, not a tokenizer.
- A probability score is not proof that something is safe to delete, but
  Claude can always re-run the tool if it needs the output again.
- The full conversation context is sent with every scoring request, so very long
  sessions near the state ceiling cost more requests.

## Development

```sh
npm install
npm run typecheck
npm test                  # 34 tests, all offline, no model needed
npm run build
npm run validate:plugin
npm run demo              # live test against local Ollama
```

## Companion plugins

If you use [MemoryGraph](https://github.com/modelcontextprotocol/servers), the [memorygraph-bridge](https://github.com/FlintWave/memorygraph-bridge) plugin saves key context to MemoryGraph before compaction so agents can recall it afterward.

## Origin

This started as a fork of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
by [Tamara Tran](https://github.com/tamaratran), who built the original plugin
using Jev decisions for verbatim compaction. Our
fork switched the default from the TypeSafe cloud API to locally-served models,
trained purpose-built scoring models (the Metzger family), added a chat-API
backend for distilled models, added automatic Ollama health checks, and
optimized for low-resource machines. It's now maintained by
[FlintWave](https://github.com/FlintWave).

## License

MIT
