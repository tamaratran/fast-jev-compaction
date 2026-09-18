# Repository Guidelines

## Project Structure & Module Organization

Core TypeScript lives in `src/`; `src/index.ts` is the package export surface. Claude Code integration belongs in `hooks/`, while Codex packaging uses `plugin.json`, `.codex-plugin/`, and `codex/`. Host type shims are in `types/`, tests in `tests/`, and runnable examples in `examples/`. The standalone SwiftUI animation is under `demo/JevDemo/`. Generated JavaScript and declarations go to `dist/` and must not be edited directly.

## Build, Test, and Development Commands

- `npm install` installs the locked development dependencies (Node.js 18+).
- `npm run typecheck` checks both the library and Claude Code hook without emitting files.
- `npm test` runs the Vitest suite once.
- `npm run build` compiles `src/` into `dist/` with declarations and source maps.
- `npm run validate:plugin` validates `.claude-plugin/plugin.json` with the Claude CLI.
- `npm run demo` performs the live TypeSafe API example and requires `TYPESAFE_API_KEY`.

Run type checking and tests before opening a pull request. Use the live demo only when network/API behavior is relevant.

## Coding Style & Naming Conventions

Write strict ESM TypeScript targeting modern Node. Follow the existing two-space indentation, single quotes, semicolons, and trailing commas. Use `camelCase` for functions and variables, `PascalCase` for types, and descriptive lowercase filenames such as `request.ts`. Import local modules with `.js` extensions so emitted NodeNext modules resolve correctly. Keep the hook adapter thin; reusable logic belongs in `src/`.

## Testing Guidelines

Tests use Vitest and follow `*.test.ts`. Group behavior with `describe`, name cases with outcome-focused `it` statements, and prefer deterministic fakes such as the existing fake Jev transport. Add regression coverage for compaction decisions, token-budget boundaries, malformed responses, and hook fallbacks. Unit tests must not contact TypeSafe or depend on real API credentials.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, for example `Split the per-call decision log...` or a scoped form such as `README: update tagline...`. Keep each commit focused. Pull requests should explain the behavior change, note tests run, link relevant issues, and update `README.md` or `hooks/README.md` when configuration or user-visible behavior changes. Include screenshots only for changes to the SwiftUI demo or visible plugin output.

## Security & Configuration

Never commit API keys, session transcripts, or user configuration. Read `TYPESAFE_API_KEY` from the environment, use placeholders in documentation, and preserve fail-safe fallback behavior when Jev requests fail.
