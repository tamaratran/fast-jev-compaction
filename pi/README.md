# fast-jev-compaction for Pi

This extension participates in Pi's native compaction lifecycle. It does not
score context before ordinary model requests. Instead, it supplies a Jev-backed
compaction only at `session_before_compact`, which covers `/compact`, `/jev
compact` (and its `/jev prune` alias), Pi's automatic threshold compaction,
and overflow recovery.

At the default 60% context level, it queues a compaction after the agent has
settled. Native Pi threshold and overflow triggers use the same hook. Jev
replaces the native summary only if it succeeds and removes at least 25% of the
core projection. A missing TypeSafe key, malformed answer, request failure,
host capacity gate, or smaller reduction falls back to Pi's normal summary.
An abort remains a normal cancelled compaction.

An explicit `/compact <focus>` passes that focus through the core's `goal`
option when Jev scores the calls. If Pi summarizes instead, Pi receives the
same custom instructions through its normal path.

## Checkpoints and fidelity

The successful compaction stores exact typed retained messages in the
compaction entry's `details`, plus a full deterministic retained-text rendering
in Pi's required summary field. The `context` hook restores only committed
checkpoints and never contacts Jev. Original session messages remain in prior
JSONL entries, so `/tree` can return to before the checkpoint. `/jev off`
stops future Jev scoring but does not stop an existing checkpoint from being
restored.

The readable checkpoint also carries Pi's read/modified file lists so a later
native summary can see file operations from the complete compacted context.

Version 2 checkpoints also retain a bounded, addressable source window for
Pi's compaction preparation, which runs before the extension hook. This keeps
a second compact available after a short new turn. The context hook replaces
the covered window with the typed snapshot; it does not send both copies to
the model. Raw Pi entry-size estimates may include the source window, whereas
`/jev status` uses the effective projection. Actual provider usage comes from
the following model response.

On native fallback, the adapter replaces the preparation's covered source
with the retained transcript and the new prefix. The previous checkpoint is
included even when Pi splits the first new turn, including fallback with
`/jev off`, missing credentials, or insufficient reduction. Version 1
checkpoints remain readable and receive the same fallback protection.

The adapter runs the same core paired-call decisions for every unique,
ordered tool-call/result pair, including errors, images, and tool discovery.
It preserves visible text and message metadata. When a dropped tool call would
leave an assistant row with neither visible text nor a remaining call, it
removes that row and its orphaned reasoning/signature blocks, matching Pi's
empty-row semantics and avoiding a Responses reasoning-only item.

## Install

Pi 0.85.1 needs Node 22.19 or newer. The standalone library in this repository
continues to support Node 18 and newer.

After the upstream merge:

```sh
pi install git:github.com/tamaratran/fast-jev-compaction
```

For a checkout during development:

```sh
pi -e ./pi/extension.ts
```

To install the fork branch as a package:

```sh
pi install git:github.com/MiguelMachado-dev/fast-jev-compaction@feat/pi-extension
```

## Data handling

Jev receives the projected visible transcript, Pi compaction/branch summaries,
non-excluded `!` bash commands and output, and tool names plus arguments. The
Jev state represents tool-result bodies with status/length notes. Image payload
bytes are never sent; they become count placeholders. `!!` bash executions
marked `excludeFromContext` are omitted. Enable this only if the remaining
text, summary content, commands, and arguments may be sent to TypeSafe.

The reduction reported in status comes from the core text projection. It is a
compaction estimate, not a tokenizer or response-time measurement.

## Flags

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--jev-compact-at-percent` | `60` | Context percentage that queues compaction after a settled turn. |
| `--jev-min-reduction-ratio` | `0.25` | Minimum projected reduction required to replace Pi's summary. |
| `--jev-keep-threshold` | `0.5` | Probability needed to retain a call or full result. |
| `--jev-preserve-recent` | `6` | Recent message rows pinned by the core compactor. |
| `--jev-max-state-tokens` | `25000` | Estimated Jev state budget. |
| `--jev-max-request-tokens` | `30000` | Estimated Jev request budget. |
| `--jev-truncate-head-chars` | `300` | Characters retained before a result marker. |
| `--jev-timeout-ms` | `0` | Extra scoring deadline in milliseconds; `0` disables it. |
| `--jev-model` | `jev-latest` | TypeSafe scoring model. |
| `--jev-disabled` | `false` | Starts with native Pi summarization only. |

## Commands

| Command | Effect |
| --- | --- |
| `/jev status` | Shows current mode, key state, auto-compaction threshold, and minimum reduction. |
| `/jev decisions` | Shows the latest core decisions and probabilities. |
| `/jev compact` / `/jev prune` | Requests the same compaction path as `/compact`. |
| `/jev on` / `/jev off` | Enables or disables future Jev scoring. Existing checkpoints remain available. |

## Interactive Astra check on Windows

`scripts/test-pi.ps1` launches the installed Pi from this repository with the
explicit local extension, `openai-codex`, `gpt-6-astra`, `xhigh`, and
`--no-extensions` so global extension discovery cannot affect the result. It
does not write Pi configuration. If `TYPESAFE_API_KEY` is not already in the
environment, it prompts securely and exposes the key only to that child Pi
process.

```powershell
.\scripts\test-pi.ps1
```

It starts without a user prompt. To print the reproducible read-only prompt
without starting a model request, run:

```powershell
.\scripts\test-pi.ps1 -ShowCompactionPrompt
```

Paste the output into Pi, wait for the response, and then enter `/compact`.
The result should be a Jev checkpoint with at least 25% projected reduction or
Pi's native summary fallback.
