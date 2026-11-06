# Metzger — Claude Code plugin

This is the Claude Code plugin side of Metzger. It hooks into `session.compact`
and replaces the default summarization with verbatim message retention, minus
the tool calls and results that Metzger's scoring model says are no longer
relevant.

`hooks/fast-jev.ts` is the adapter: it reads plugin options, checks that Ollama
and the model are available on session start, hands compaction transcripts to
the library in `src/`, and maps the results back onto session messages.

On `turn.complete`, it checks context usage against `compactAtPercent` and
triggers compaction proactively when the threshold is reached.

## Install

```sh
claude plugin marketplace add FlintWave/metzger
claude plugin install metzger@metzger
```

For local development:

```sh
claude --plugin-dir .
```

## Configuration

All options are set in `~/.claude/settings.json` under `pluginConfigs.metzger`.
See the root README for the full list.

| Option | Default |
| --- | ---: |
| `model` | `metzger:0.8b` |
| `keepThreshold` | `0.5` |
| `preserveRecentMessages` | `6` |
| `compactAtPercent` | `60` |
| `minReductionRatio` | `0.25` |
| `maxStateTokens` | `25000` |
| `maxRequestTokens` | `30000` |
| `truncateHeadChars` | `300` |
| `baseUrl` | `http://localhost:11434/v1/systemone` |
| `backend` | `auto` |

When `baseUrl` points to localhost, no API key is needed.

## Fallback

If the scoring model fails, the response is malformed, the key is unavailable,
or the estimated reduction is below `minReductionRatio`, the plugin logs a
message and falls back to Claude Code's built-in compaction. You'll see a toast
explaining why.
