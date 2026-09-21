# Contributing

## Before opening a pull request

Run the same checks used by CI:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

The package is deliberately dependency-light. Keep changes focused, preserve
the verbatim-message contract, and add a regression test for behavior changes.
Do not send real API keys or live transcripts in tests or pull requests; use a
fake `JevAsker` or injected fetch instead.

## Commits and pull requests

Use a short imperative commit subject, for example `Validate Jev probabilities`.
Describe the user-visible behavior, the failure mode being fixed, and the
commands used to verify it. If the change affects the Claude Code hook, include
the Claude Code version or type reference used for validation.
