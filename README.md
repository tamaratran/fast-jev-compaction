# fast-jev-compaction

Claude Code and OpenCode plugin that replaces the compaction summary with Jev
decisions: every tool call and result is scored in one fast request, stale
ones are dropped or truncated, everything kept stays verbatim. Also usable as
an npm library.

No API key is needed: without a TypeSafe key the plugin reaches Jev at
[OpenCode Zen](https://opencode.ai/docs/zen), whose `jev-1.13-free` model is
free and unauthenticated. Set `TYPESAFE_API_KEY` to use TypeSafe's own
endpoint instead.

## Quick install

OpenCode 2 installs plugins straight from GitHub (the entry it loads,
`opencode/server.js`, is committed, so no build is needed):

```sh
opencode plugin add github:tamaratran/fast-jev-compaction
```

Everything else goes through the install script, which needs only `git`:

```sh
curl -fsSL https://raw.githubusercontent.com/tamaratran/fast-jev-compaction/main/install.sh | sh              # OpenCode
curl -fsSL https://raw.githubusercontent.com/tamaratran/fast-jev-compaction/main/install.sh | sh -s -- claude  # Claude Code
curl -fsSL https://raw.githubusercontent.com/tamaratran/fast-jev-compaction/main/install.sh | sh -s -- all     # both
```

On OpenCode 2 the script runs `opencode plugin add` for you; on OpenCode 1
(or with `--file`) it clones into `~/.local/share/fast-jev-compaction` and
writes `~/.config/opencode/plugins/fast-jev-compaction.ts`, which either
version loads on the next start (`opencode service restart` for OpenCode 2's
background server). For Claude Code it adds the repository as a marketplace
and installs the plugin; function hooks must be enabled (see below). Run
`./install.sh --help` for `--dir`, `--ref` and `--file`. To remove: `opencode
plugin remove github:tamaratran/fast-jev-compaction`, or delete the plugin
file and the checkout.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is an npm package (`src/`), a Claude Code plugin (`hooks/`,
`.claude-plugin/`) that uses the package to replace Claude Code's built-in
compaction summary with the original messages, and an OpenCode plugin
(`src/opencode/`, loaded from `fast-jev-compaction/server`) for OpenCode 1 and
OpenCode 2.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...   # optional: without it, pass baseUrl/model for OpenCode Zen (below)
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file. To use OpenCode Zen's free Jev from the library, pass
`{ apiKey: '', baseUrl: OPENCODE_ZEN_URL, model: OPENCODE_ZEN_FREE_MODEL }`
(both constants are exported); a key is only required for TypeSafe's own
endpoint, and an empty key sends no `authorization` header.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | API key (`compactMessages`/`JevClient`); may be empty for endpoints that need none |
| `model` | `jev-latest` | Jev model name (`jev-1.13-free` or `jev-1.13` at OpenCode Zen) |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint (`https://opencode.ai/zen/v1/systemone` for OpenCode Zen) |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Add `"TYPESAFE_API_KEY": "<your key>"` to that `env` to use TypeSafe's own
endpoint; without a key the hook uses OpenCode Zen's free Jev and logs which
one it reached.

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment
or, without one, OpenCode Zen.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## OpenCode plugin

The same package is an OpenCode plugin for both plugin APIs: OpenCode 1
(`@opencode-ai/plugin` hooks) and OpenCode 2 (`@opencode/plugin`
`setup(ctx)`). One entry, `fast-jev-compaction/server`, default-exports an
object carrying both a `server` function and a `setup` function; each host
reads the one it knows and ignores the other. The adapters live in
`src/opencode/`: `pruner.ts` is host-agnostic, `v1.ts` and `v2.ts` map each
host's messages onto the library and back.

Neither OpenCode line has a hook that lets a plugin hand back the messages a
compaction should produce, so the plugin works differently from the Claude
Code hook:

- **Continuous pruning (OpenCode 1 and 2).** Before every model request
  (`experimental.chat.messages.transform` in OpenCode 1, the `context` session
  hook in OpenCode 2) the plugin estimates the transcript size. Above
  `compactAtPercent` of the context window it asks Jev about every tool call
  outside the pinned first and newest messages, remembers the decisions per
  session, and applies them to that request and every later one: a
  `drop_call` removes the tool call and its result, a `drop_result` keeps the
  call and the first `truncateHeadChars` characters of its output. Jev is
  asked again only when the transcript is still above the threshold and holds
  a call it has not been asked about; a kept call can be dropped by a later
  pass, a dropped one never comes back. Because the model then sees the
  pruned history, its reported usage stays low and OpenCode's own
  auto-compaction rarely triggers. Nothing is rewritten in the session store;
  decisions are held in memory and recomputed after a restart.
- **Verbatim checkpoint (OpenCode 2 only).** When OpenCode 2 does compact, its
  `compaction` session hook lets a plugin supply the summary and skip the
  summarising model call. The plugin runs a forced Jev pass over the history
  being summarised and, if the pruned history fits `checkpointTokens`
  (estimated), supplies it rendered verbatim (`[User]: …`, `[Assistant tool
  call]: …`, `[Tool result]: …`) instead of a summary. Above that budget the
  built-in summary runs, so a checkpoint can never be too large to fit.
  OpenCode 1 has no such hook; its built-in summary runs unchanged, over the
  pruned history.

**Where Jev is reached.** With `TYPESAFE_API_KEY` (or the `apiKey` option)
the plugin uses TypeSafe's endpoint and `jev-latest`. Without one it uses
OpenCode Zen's System One endpoint and `jev-1.13-free`, which needs no key;
`OPENCODE_API_KEY` is sent when set, which also unlocks Zen's paid `jev-1.13`
(`"model": "jev-1.13"`). `provider` forces one or the other. The plugin logs
which it picked at startup. If a Jev request fails, that request goes out
unpruned and nothing is asked again for `cooldownMs`, so an unreachable
endpoint costs one failure per minute, not one per request. OpenCode 1 also
shows each pass as a toast.

### Install in OpenCode

**As a git package.** Both OpenCode versions install packages with npm's
machinery, which accepts git specifiers and resolves the package's `./server`
export to the committed `opencode/server.js`. OpenCode 2, from the shell or in
`opencode.json` (the object form takes options):

```sh
opencode plugin add github:tamaratran/fast-jev-compaction
```

```json
{ "plugins": [{ "package": "github:tamaratran/fast-jev-compaction", "options": { "keepThreshold": 0.4 } }] }
```

OpenCode 1, in `opencode.json`:

```json
{ "plugin": ["github:tamaratran/fast-jev-compaction"] }
```

or with options `{ "plugin": [["github:tamaratran/fast-jev-compaction", { "keepThreshold": 0.4 }]] }`.
A fork or branch works the same way: `github:you/fast-jev-compaction#branch`.
`opencode plugin update` (OpenCode 2) fetches the latest commit. Installing
runs no scripts, which is why the bundle is committed; after changing anything
under `src/`, run `npm run bundle` and commit `opencode/server.js`
(a test fails when it is stale).

**From a checkout.** Clone the repository and drop a one-line file into a
plugins directory (`~/.config/opencode/plugins/` globally or
`.opencode/plugins/` in a project); nothing needs building:

```ts
// ~/.config/opencode/plugins/fast-jev-compaction.ts
export { default } from "/home/you/src/fast-jev-compaction/opencode/server.js"
```

OpenCode 2 also loads the TypeScript source directly (`src/opencode/server.ts`)
and reloads it when a file changes. Plugin-directory files take no options:
use the `FAST_JEV_*` environment variables below, or wrap the export:

```ts
import p from "/home/you/src/fast-jev-compaction/opencode/server.js"
// OpenCode 2
export default { id: p.id, setup: (ctx) => p.setup({ ...ctx, options: { keepThreshold: 0.4 } }) }
```

### Choosing where Jev runs

The default is TypeSafe when `TYPESAFE_API_KEY` is set and OpenCode Zen's free
Jev otherwise. To use OpenCode's Jev regardless, any of these works:

- the `provider` option: `"options": { "provider": "opencode" }`;
- the model written the OpenCode way: `"options": { "model": "opencode/jev-1.13-free" }`
  (or `opencode/jev-1.13`, Zen's paid one, billed to `OPENCODE_API_KEY`);
- the environment, for installs that take no options:
  `FAST_JEV_PROVIDER=opencode` and optionally `FAST_JEV_MODEL=jev-1.13`
  wherever OpenCode runs (for the background server, its service environment).

Options win over the environment. The Claude Code plugin has the same
`provider` option.

### OpenCode options

Every library option (`keepThreshold`, `preserveRecentMessages`, `goal`,
`maxStateTokens`, `maxRequestTokens`, `truncateHeadChars`) plus:

| Option | Default | Description |
| --- | --- | --- |
| `provider` | `typesafe` with a TypeSafe key, else `opencode` | Where Jev is reached (`FAST_JEV_PROVIDER` in the environment) |
| `apiKey` | `TYPESAFE_API_KEY` / `OPENCODE_API_KEY` | API key for the provider; none needed for Zen's free Jev |
| `model` | `jev-latest` / `jev-1.13-free` | Jev model name (`FAST_JEV_MODEL`); an `opencode/` prefix selects that provider |
| `baseUrl` | the provider's endpoint | Endpoint override |
| `cooldownMs` | `60000` | Pause after a failed Jev request |
| `compactAtPercent` | `60` | Context percentage above which a pass runs |
| `contextTokens` | `200000` | Context window assumed when the host does not report one (OpenCode 1 reports the model's from `chat.params`; OpenCode 2 does not) |
| `checkpointTokens` | `40000` | OpenCode 2: largest verbatim checkpoint supplied instead of the built-in summary |

`preserveRecentMessages` counts the host's own messages. Sizes are estimates
from character counts, not tokenizer counts, and cover the transcript only,
not the system prompt or tool definitions.

The pruner is exported from the library too: `SessionPruner`,
`readPrunerOptions`, `transcriptTokens`, `renderTranscript` and
`applyActions` are enough to wire the same behaviour into another host.

## Development

```sh
npm install
npm run typecheck        # library + OpenCode adapters + Claude Code hook
npm test                 # includes a check that opencode/server.js is current
npm run compile          # dist/ (library, tsc) and opencode/server.js (committed esbuild bundle)
npm run bundle           # only the bundle
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

The scripts are deliberately not named `build`, `prepare` or `prepack`: npm's
git fetcher treats any of those as a sign that a git dependency must be
prepared and runs a full `npm install` in a fresh clone, which OpenCode's
script-less installer cannot do. With the bundle committed and no such script,
`opencode plugin add github:…` installs the package as it is.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
