# Saved outputs: what is written, where, and what can leak

With `saveFullOutputs` (on by default) the Claude Code hook writes the full output of every tool result it reduces to a file, so a fact
the stub does not keep is one Read away. Tool outputs can carry secrets (an `env` dump, a config read, a token in an
error). This note is the threat model for those files and what the hook does about it.

## Before and after

| | before | after |
|---|---|---|
| Full outputs on disk | the session transcript (`~/.claude/projects/…/*.jsonl`), deleted after 30 days by default | the same, plus `<cwd>/.claude/fast-jev/cache/<session>/<tool_use_id>.txt` |
| In backups | transcripts are `*.jsonl`, which backup configs that skip session logs exclude | a `**/cache` exclusion (common) keeps the saved outputs out too |
| In git | — | `<cwd>/.claude/fast-jev/cache/.gitignore` with `*` |
| In search indexes | — | indexers that skip `.claude` and `cache` folders skip them |
| Lifetime | 30 days (transcript cleanup) | 30 days: older saved outputs are emptied |

## What the hook does

- **Masks secret values** before writing (`src/secrets.ts`): 22 value-based families — OpenAI/Anthropic/OpenRouter
  `sk-…`, GitHub and GitLab tokens, Hugging Face, Google API keys, Slack, AWS access keys and secret keys, JWTs,
  `Bearer …` tokens, private key blocks, Perplexity, xAI, Groq, Sakana, Keenable, SendGrid, Telegram bot tokens.
  A match that is one repeated character (`sk-xxxxxxxx…`) is a placeholder and stays. The transcript keeps the
  original; the saved copy does not become one more place a key lives.
- **Writes under `cache/`**, which backups and indexers skip, with a `.gitignore` that ignores everything.
- **Expires**: once a day, saved outputs older than 30 days are overwritten with nothing (`$.fs` cannot delete a
  file; the empty file keeps its name, a `tool_use_id`).
- **Sanitizes names**: session ids and `tool_use_id`s keep only `[A-Za-z0-9_.-]`, so no id can write outside the
  session folder.
- **Caps** every file at 4 MiB.
- **Opt-out**: `saveFullOutputs: false` writes nothing.

## Measured

- 5995 tool outputs from the evaluation transcripts (25 subagent transcripts and four 1500-message tails of real
  sessions): 0 values of a known family; 6 field-name hits (`api_key: …`), all code references (`env.X`,
  `process.env.X`), a placeholder or a test marker.
- Masking changed 0 of the 5995 outputs and removed none of the 392 preregistered facts.
- Tests: every family is masked with the text around it kept; placeholders, field names and ordinary facts are left
  alone; a hostile `tool_use_id` stays inside the session folder; expired files are emptied, fresh ones kept. The
  sample keys are built at run time, so no key-shaped literal sits in the repository.

## What is left

- A secret outside the families — a password in free text, an internal token with no fixed prefix — is written as
  is. The transcript already holds it; the saved copy is a second place.
- The project folder can travel where `~/.claude` does not: a Docker build context without a `.dockerignore` entry,
  a cloud-synced project folder, a zip sent to someone. `.claude/fast-jev/` is worth adding to those ignore lists.
- Other tools and agents that read hidden folders of the project can read the saved outputs.
- Expiry runs only when the hook runs: a project not opened for months keeps its files until the next compaction
  there. An expired file is empty but keeps its name.
