# fast-laya-plugin

Claude Code plugin that replaces the compaction summary with decisions from a
**local** [Laya](https://huggingface.co/convaiinnovations/laya) model: every
tool call is scored, stale calls and results are dropped or truncated, and
everything kept stays verbatim. No API key and no network beyond `localhost`.
It also works as an npm library.

Fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT), which does the same with TypeSafe's hosted Jev model. The compaction
idea, the decision rule, the message rebuilding and the hook adapter come from
that project. This fork swaps the backend for `laya-serve` and redesigns the
state so it fits Laya's small context window.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, an exact error, a constraint or a command can disappear
even when it matters later. This plugin never rewrites anything. It only
deletes tool calls and tool results that Laya says are no longer needed. User
and assistant text stays verbatim and in order.

## Install

You need [Claude Code](https://claude.com/claude-code) 2.1.274 or newer and
[uv](https://docs.astral.sh/uv/) (for `laya-serve`, Python 3.10 or newer).
From a checkout of this repository, run the script for your shell:

```sh
./scripts/install          # bash, zsh, sh (macOS, Linux, Git Bash)
```

```powershell
./scripts/install          # PowerShell
```

```bat
scripts\install           :: cmd
```

The script:

1. Installs `laya-serve` with `uv tool install "laya[serve]"` if it is not
   on the `PATH` yet.
2. Adds this repository as a plugin marketplace
   (`claude plugin marketplace add Chamoouske/fast-laya-plugin`), or refreshes
   it if it is already there (`claude plugin marketplace update`).
3. Installs the plugin in user scope
   (`claude plugin install fast-laya-plugin@fast-laya-plugin`).
4. Warns if `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not set to `1`, and prints
   the command that sets it.

It is safe to run again. Pass another marketplace source as the first argument
to install from somewhere else, for example the checkout itself:
`./scripts/install "$PWD"`. In PowerShell, use `./scripts/install $PWD`. A
local source loads in place, so edits take effect at the next session start
or `/reload-plugins`.

Then turn on function hooks (see [Manual install](#manual-install)) and
restart Claude Code or run `/reload-plugins`. `laya-serve` starts by itself
with each session (see [Automatic start](#automatic-start)). The first start
downloads the English checkpoint (about 850 MB).

`scripts/install` and `scripts/install.bat` are thin wrappers around
`scripts/install.sh` and `scripts/install.ps1`. The `.bat` wrapper runs the
`.ps1` script with `-ExecutionPolicy Bypass`, so it works under any execution
policy.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. Each non-pinned call gets its **own small state**, built in this order:
   the goal (by default the last three user prompts), the nearest messages
   before the call, the call itself (tool, input, `ok`/`error` with the output
   size, and a short preview of the output), the nearest messages after the
   result, and one line per later tool call. The order matters. When a state
   is too long, `laya-serve` cuts its tail, so the most important parts come
   first.
3. The state is fitted into `maxStateTokens` (400 by default). It tries five
   size levels in turn, each with smaller caps for the goal, the texts, the
   input, the preview and the number of later calls, and uses the first level
   that fits. Tokens are estimated with a formula fitted to Laya's ModernBERT
   tokenizer (see `estimateTokens`).
4. Each call gets one `choice` question, `fate`, with three options: `keep`
   (the full output is still needed), `truncate` (knowing the call ran
   matters, its contents no longer do) and `drop` (obsolete, superseded or
   unrelated). One request is sent per call, `concurrency` at a time.
5. The probabilities become two numbers: `keepResult = p(keep)` and
   `keepCall = p(keep) + p(truncate)`. They are compared with `keepThreshold`:
   - `keepResult ≥ threshold`: keep the call and its result.
   - Otherwise, `keepCall ≥ threshold`: keep the call and truncate the result
     to its first `truncateHeadChars` characters plus a one-line note.
   - Otherwise: remove the call together with its result.
6. The message list is rebuilt. A message that loses all its content is
   removed. Untouched messages are returned as the same objects. A result is
   never left without its call.

If `laya-serve` is unreachable, returns an error or returns a malformed
answer, compaction throws. The caller (or the Claude Code hook) decides what
to fall back to.

### Why one state per call

Jev received the whole history as one state of up to 25k tokens. Laya reads
512 tokens on the English checkpoint and 1024 on `laya-multilingual`. When the
state is longer, `laya-serve` still answers `200` with a normal-looking answer
but drops every token past the window. The only sign is `usage.truncated` and
`usage.state_tokens_dropped` in the response. With states of 400, 2000 and
6000 words the answer was identical, because only the first 512 tokens were
read. Squeezing a whole session into 8192 tokens means asking the checkpoint
to read 16× more than it was trained on, and on a GTX 1650 that takes about
9 s per question. A small state per call fits the trained window, and the
plugin counts how many requests Laya reported as cut (`stats.truncatedRequests`).

## Run laya-serve

Laya needs Python 3.10 or newer. Install it with [uv](https://docs.astral.sh/uv/),
including the `serve` extra:

```sh
uv tool install "laya[serve]"
```

The Claude Code plugin starts the server by itself (see
[Automatic start](#automatic-start)), so this is all the setup it needs. To
run it by hand, or for the library, start it yourself. The first start
downloads the English checkpoint (about 850 MB) from Hugging Face.

PowerShell:

```powershell
$env:LAYA_HOST = "127.0.0.1"; $env:LAYA_PORT = "8000"; $env:LAYA_MODELS = "english"
laya-serve
```

bash:

```sh
LAYA_HOST=127.0.0.1 LAYA_PORT=8000 LAYA_MODELS=english laya-serve
```

Check it with `curl http://127.0.0.1:8000/health`. Useful variables:
`LAYA_DEVICE` (`cpu` or `cuda`), `LAYA_MAX_CONCURRENT` (16 by default; above
it the server answers 503) and `LAYA_MAX_LOADED`. Set `LAYA_MODELS` to
`english,multilingual` if you want the 1024-token checkpoint, then set the
plugin's `model` to `laya-multilingual` and `maxStateTokens` to about 900.

### Automatic start

When an agent session starts, the plugin checks `GET /health` on the
`baseUrl` origin. If nothing answers and `baseUrl` points at this machine
(`127.0.0.1`, `localhost` or `::1`), it starts `laya-serve` in the
background, detached from Claude Code, with `LAYA_HOST` and `LAYA_PORT` taken
from `baseUrl` and `LAYA_MODELS` taken from `model` (`english` for `laya`,
`english,multilingual` for `laya-multilingual`). On Windows it uses
`Start-Process -WindowStyle Hidden`, elsewhere `nohup … &`. A server that is
already running, started by hand or by another session, is reused.

The session does not wait for the model to load (about 60 s cold on a GTX
1650). Compaction does: before it asks Laya, it starts the server again if it
has died and waits up to `startupTimeoutSeconds` for `/health`, then falls
back to the built-in summary. The server keeps running after Claude Code
exits, so later sessions start warm.

Set `autoStart` to `false` to manage the server yourself, and
`layaServeCommand` to an absolute path when `laya-serve` is not on the `PATH`
Claude Code sees. A remote `baseUrl` is never started.

## Manual install

Function hooks are an early-access Claude Code feature (2.1.274 or newer).
Set the opt-in flag wherever Claude Code runs.

PowerShell (current session, then persistent):

```powershell
$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1"
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS", "1", "User")
```

bash:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1   # add to ~/.bashrc to keep it
```

Or in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then add this repository as a plugin marketplace and install the plugin,
inside a Claude Code session:

```
/plugin marketplace add Chamoouske/fast-laya-plugin
/plugin install fast-laya-plugin@fast-laya-plugin
```

The same works from the shell with `claude plugin marketplace add …` and
`claude plugin install …`. The install prompts for the plugin options; the
defaults point at `http://127.0.0.1:8000/v1/systemone`. Restart Claude Code or
run `/reload-plugins`. From then on `/compact` and auto-compaction go through
Laya. The toast reads `kept N/M messages, no summary (…)` when the pruned
history replaced the built-in summary, or `fallback to built-in summary (…)`
when Laya is down, fails, or could not remove enough.

To run from a checkout without installing, start Claude Code from the
repository root with `claude --plugin-dir .` and the flag set.

## Library usage

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-laya-plugin';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session
transcript can be passed in as is. To bring your own transport, implement
`LayaAsker` (one `ask(state, questions)` method) and call
`compact(messages, asker, options)`. `buildLayaRequest` and
`parseLayaResponse` build the HTTP request and validate the response. The
building blocks (`collectToolCalls`, `fitCallState`, `decideCall`,
`applyDecisions`) are exported too.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8000/v1/systemone` | `laya-serve` endpoint |
| `model` | `laya` | Checkpoint (`laya`, `laya-multilingual`, …); unknown names auto-route |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in every state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `400` | Estimated token ceiling for one call's state |
| `truncateHeadChars` | `300` | Characters of a dropped tool result kept before its note |
| `concurrency` | `4` | Requests in flight at once |

`maxStateTokens` must leave room for the question: `laya-serve` puts the
question first (86 tokens for `fate`), then the state, inside `max_len` (512
for `laya`), which leaves 425 tokens for the state. 400 covers the usual
error of the estimate (90% of samples within -7%/+14%). A state that still
ends up too long is cut by the server and counted in `stats.truncatedRequests`.

`result.stats` reports message and character counts before and after, the
counts per decision reason, the largest state sent, the number of requests,
and how many of them Laya reported as cut.

## Limitations

- Laya is a small, general decision model, not trained for this task. On the
  demo transcript its `fate` probabilities follow the tool type more than the
  content (Bash and Edit lean `keep`, Read and Glob lean `drop`). A
  probability is not proof that a result is safe to delete, but the assistant
  can always re-run the tool.
- `noul` questions (the Jev design) gave Laya almost no spread: every answer
  was between 0.5 and 0.75, even for "this call is obsolete". That is why the
  plugin asks one `choice` question.
- Each call only sees its neighbourhood and a list of later calls, not the
  whole session.
- Latency depends on the hardware. On a GTX 1650 one request takes about
  1.2 s and `laya-serve` runs them one at a time, so 50 candidate calls take
  about a minute.
- Only tool calls and results are candidates. Text messages are never
  removed or shortened.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test                 # unit tests; the laya-serve tests run only if the server answers
npm run build
npm run validate:plugin  # claude plugin validate
npm run demo             # compacts examples/transcript.ts against laya-serve
```

`LAYA_URL` points the integration tests and the demo at another endpoint.
`tests/laya-serve.integration.test.ts` is skipped when `/health` does not
answer.

## License

MIT. See [LICENSE](LICENSE). Laya itself is Apache 2.0.
