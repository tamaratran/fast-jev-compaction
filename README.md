# fast-jev-compaction (OpenCode fork)

Fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction):
the same verbatim compaction engine, wired into OpenCode's `compaction` hook
instead of Claude Code's, and able to ask Jev through OpenCode itself, through
TypeSafe, or through a local Jev-compatible model.

[Русская версия](README.ru.md)

## What it does

OpenCode compacts a long session by replacing older turns with a model-written
summary. A summary is lossy: a file path, an exact error, a constraint can
disappear even when the next turn needs it.

This plugin never rewrites anything. Every tool call and every tool result is
scored in one Jev request; stale ones are deleted or truncated, and everything
kept stays verbatim, in order. The hook returns the surviving messages as the
provider replacement window (`result.native.messages`), so OpenCode replays them
instead of a summary.

If Jev fails, answers badly, or removes too little, the hook leaves `result`
unset and OpenCode writes its own summary. A failed compaction never makes a
session worse than the built-in behaviour.

## Install in OpenCode

```sh
git clone https://github.com/Zakhvatov/fast-jev-compaction.git \
  ~/.config/opencode/plugins/fast-jev-compaction
cd ~/.config/opencode/plugins/fast-jev-compaction
npm install --omit=dev
```

The repository root is the plugin directory. Without a `package.json` name and
`exports`, OpenCode would look for `server.ts`/`index.ts` at the root; with them
it loads `exports["."]`, which is [`src/opencode/index.ts`](src/opencode/index.ts).

Add it to `~/.config/opencode/opencode.json` (or a project's `opencode.json`):

```jsonc
{
  "plugins": [
    {
      "package": "/Users/you/.config/opencode/plugins/fast-jev-compaction",
      "options": { "transport": "opencode-free" }
    }
  ]
}
```

Restart OpenCode. A `.opencode/plugins/fast-jev-compaction/` directory next to a
project works too and needs no `plugins` entry.

## Which Jev

`jev-1.13-free` and `jev-1.13` are served by an OpenCode Console connection
(provider `opencode`), not by the Go plan. The free tier costs nothing; the paid
tier is billed in dollars per call.

| Preset | Transport | Needs |
| --- | --- | --- |
| `opencode-free` (default) | provider `opencode`, model `jev-1.13-free` | a connected `opencode` provider |
| `opencode-paid` | provider `opencode`, model `jev-1.13` | the same, billed per call |
| `typesafe` | HTTP, `api.typesafe.ai/v1/systemone`, `jev-latest` | `TYPESAFE_API_KEY` |
| `opencode-http-free` | HTTP, `opencode.ai/inference/systemone`, `jev-1.13-free` | an OpenCode Console key in `auth.json` |
| `opencode-go-free` | HTTP, `opencode.ai/inference/go/systemone` | key plus `x-opencode-session`, and the model on the Go plan |
| `laya` | `http://127.0.0.1:8000/v1/systemone`, `laya-typed-decisions` | `pip install "laya[serve]"`, `LAYA_PRELOAD=1 laya-serve` |
| `openjev` | `http://127.0.0.1:8009/v1/systemone`, `openjev-1.7b` | a running OpenJev server |
| `vega` | `http://127.0.0.1:8010/v1/systemone`, `vega-0.8b` | Vega behind the systemone shim |

Any other server is configured with `baseUrl` and `model`; a local address needs
no key. Local models are asked within their real window: `laya` gets a ~320-token
request budget, so the state is fitted much harder and compaction often falls
back rather than sending a truncated request.

Inside OpenCode the default goes through `ctx.experimental.generate.decisions`,
which signs the request with the provider the user connected. Outside OpenCode
(the bench) the same model is reached over HTTP with a key from
`~/.local/share/opencode/auth.json`.

### Region blocks

Observed on a Russian network, November 2026:

| Route | Answer |
| --- | --- |
| TypeSafe | `451 Typesafe is not available in your region` |
| Console Jev (`opencode`) | `403 RegionError: This model is not available in your country` |
| Go route | `400 Model jev-1.13-free isn't included in OpenCode Go` |

The plugin fails closed on all three: the trial log records the error and
OpenCode writes its summary. If Jev works for you through the `opencode`
provider, the default preset already uses that path; the HTTP presets are for
the bench and for other networks.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `transport` / `preset` | `opencode-free` | preset name, or a URL (`http://…/v1/systemone`) |
| `baseUrl` | — | select the HTTP transport explicitly |
| `model` | preset's | model name for the HTTP transport |
| `apiKey` | env or `auth.json` | key for the HTTP transport |
| `providerID`, `modelID` | `opencode`, `jev-1.13-free` | select the provider transport explicitly |
| `contextWindow` | — | total request budget of a local model |
| `maxStateTokens` | `25000` (transport limit) | estimated ceiling for the state Jev sees |
| `maxRequestTokens` | `30000` (transport limit) | estimated ceiling for state plus questions |
| `keepThreshold` | `0.5` | minimum keep probability for a call or result |
| `preserveRecentMessages` | `6` | newest messages never touched (the first is always kept) |
| `truncateHeadChars` | `300` | characters of a dropped result left before its note |
| `minReductionRatio` | `0.25` | below this share the built-in summary is kept |
| `logPath` | `~/.local/share/opencode/fast-jev-compaction/trial.jsonl` | trial log |
| `enabled` | `true` | turn the plugin off without removing it |

Environment overrides: `FAST_JEV_TRANSPORT`, `FAST_JEV_BASE_URL`,
`FAST_JEV_MODEL`, `FAST_JEV_API_KEY`, `FAST_JEV_PROVIDER`, `FAST_JEV_MODEL_ID`,
`FAST_JEV_LOG`, `FAST_JEV_ENABLED`, `FAST_JEV_CHAT_MODEL`.

### Local model example

```jsonc
{
  "plugins": [
    {
      "package": "/Users/you/.config/opencode/plugins/fast-jev-compaction",
      "options": {
        "baseUrl": "http://127.0.0.1:8000/v1/systemone",
        "model": "laya-typed-decisions",
        "contextWindow": 320
      }
    }
  ]
}
```

## Measuring "better or worse"

Three layers, because they answer different questions.

### 1. Hand-labelled cases

[`bench/cases/core.json`](bench/cases/core.json) holds transcripts where the
right decision is known: a stale read that should go, the failing test output
that must stay, a constraint in user text (never a candidate), a build log that
holds the compile error, a repeated read whose older copy is stale.

```sh
tsx bench/run.ts --transport stub        # offline plumbing check
tsx bench/run.ts --transport opencode-http-free --verbose
tsx bench/run.ts --transport laya --limit 5
```

Metrics, in order of importance:

- **dangerous** — a result the next turn needed was dropped or truncated;
- **lost probes** — a literal the next turn used is no longer in the window;
- **reduction** — share of characters removed; without it there is no point.

### 2. Real sessions

```sh
tsx bin/extract-sessions.ts --limit 10
```

Reads `~/.local/share/opencode/opencode.db`, finds the last assistant turn of a
session, and treats everything that turn referenced (a file it opened, a command
it ran, an error line it quoted) as a probe. If a probe lived in a tool result of
the history, that result was needed later — a drop is a dangerous decision. The
fixtures are ordinary `bench/run.ts` cases.

### 3. End to end

```sh
tsx bench/e2e.ts --transport opencode-http-free --baseline --ask
```

For every fixture it compacts the history, then checks:

- whether each probe is still in the window;
- whether a model-written summary of the same history keeps it (`--baseline`, one
  chat call per fixture);
- whether a chat model can still quote it from the window, and from the summary
  (`--ask`, one call per probe).

The chat model defaults to `deepseek-v4.1-flash` through the Go route; override
with `FAST_JEV_CHAT_MODEL` or `--chat-model`.

### 4. Trial log

Each compaction appends one JSON line to `logPath`: backend, counts, decisions,
reduction, fitting stage, latency, and the error text when one happened. No
transcript content is written.

```sh
tsx bin/trial.ts
tsx bin/trial.ts --since 2026-11-20
```

## How the decisions work

1. `tool_use` and `tool_result` are paired by id. Calls in the first message and
   in the newest `preserveRecentMessages` messages are pinned.
2. The state is the whole conversation, oldest first, with results replaced by a
   short note (`ok, 4213 chars (omitted)`), fitted into `maxStateTokens` in
   stages; if it still does not fit, compaction throws and the hook falls back.
3. Two `noul` questions per call: should the call stay, should the result stay
   verbatim. Requests are batched under `maxRequestTokens`, run concurrently.
4. `keepResult ≥ threshold` → keep; else `keepCall ≥ threshold` → keep the call
   and truncate the result; else drop both. Text messages are never removed.

The engine is still usable as a library: `import { compact } from
'fast-jev-compaction/lib'` after `npm run build`.

## Development

```sh
npm run typecheck     # library, plugin, bench, hooks
npm test              # unit tests, fake transport, no network
npm run build
npm run bench:stub    # offline bench, deterministic
npm run bench:stub-server   # 127.0.0.1:8787/v1/systemone for a manual plugin check
```

Two OpenCode-specific test files matter:

- `tests/opencode.test.ts` — message mapping, native window rebuilding, provider
  question translation, fail-closed answers, the hook's fallback paths;
- the same file drives the hook with a fake event, so the compaction contract is
  tested without OpenCode.

`npm install` uses `.npmrc` with `legacy-peer-deps` because `@opencode/plugin`
and the vitest toolchain disagree about a vite peer.

## Upstream

The engine, the Claude Code hook, the SwiftUI demo and the original README come
from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
This fork adds the OpenCode plugin, the transport registry, the local-model
profiles and the bench. MIT.
