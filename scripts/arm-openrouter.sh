#!/usr/bin/env bash
# Arm fast-jev-compaction to route /compact through real Jev over OpenRouter.
# Run this yourself: the Claude Code harness blocks the assistant from doing it
# (arming it ships full transcripts to OpenRouter on every compaction).
#
#   bash scripts/arm-openrouter.sh
#
# Requires an OpenRouter key in the environment first:
#   OPENROUTER_API_KEY=sk-or-... bash scripts/arm-openrouter.sh
set -euo pipefail

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "ERROR: set OPENROUTER_API_KEY (an sk-or-... key) in the environment first." >&2
  exit 1
fi
KEY="$OPENROUTER_API_KEY"
PLUGIN_DIR="/mnt/nvme/PROMETHEUS/PROJECTS/fast-jev-compaction"

echo "==> 1/3  merging ~/.claude/settings.json (flag + OpenRouter key)"
OPENROUTER_API_KEY="$KEY" node <<'EOF'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
// $HOME can be empty in the Claude Code `!` shell; homedir() reads /etc/passwd.
const home = process.env.HOME && process.env.HOME.length ? process.env.HOME : homedir();
const p = home + '/.claude/settings.json';
if (!existsSync(p)) {
  console.error('    ERROR: ' + p + ' not found — refusing to create a stray file');
  process.exit(1);
}
const s = JSON.parse(readFileSync(p, 'utf8'));
s.env = Object.assign({}, s.env, {
  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
});
writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
console.log('    armed:', p);
EOF

echo "==> 2/3  registering marketplace + installing plugin (user scope)"
claude plugin marketplace add "$PLUGIN_DIR" --scope user
claude plugin install fast-jev-compaction@fast-jev-compaction -y --scope user

echo "==> 3/3  done"
echo
echo "Now run  /reload-plugins  (or restart Claude Code)."
echo "New sessions' /compact will route through real Jev on your OpenRouter key."
echo "Note: the key needs a positive OpenRouter balance or compaction falls back"
echo "to the built-in summary."
