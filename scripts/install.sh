#!/usr/bin/env sh
set -eu

PLUGIN="fast-laya-plugin"
SOURCE="${1:-Chamoouske/fast-laya-plugin}"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

command -v claude >/dev/null 2>&1 || fail "claude not found on PATH. Install Claude Code first: https://claude.com/claude-code"

step "laya-serve"
if command -v laya-serve >/dev/null 2>&1; then
  echo "already installed: $(command -v laya-serve)"
elif command -v uv >/dev/null 2>&1; then
  uv tool install "laya[serve]"
else
  fail "laya-serve and uv not found. Install uv (https://docs.astral.sh/uv/), then run this script again."
fi

step "laya-serve service (start at login, restart if it dies)"
if [ "${FAST_LAYA_NO_SERVICE:-}" = "1" ]; then
  echo "skipped (FAST_LAYA_NO_SERVICE=1)"
else
  code=0
  sh "$(dirname "$0")/service.sh" install || code=$?
  if [ "$code" -eq 3 ]; then
    echo "warning: no supported service manager here; the plugin will start laya-serve with each session instead."
  elif [ "$code" -ne 0 ]; then
    fail "could not install the laya-serve service (exit $code)"
  fi
fi

step "marketplace $PLUGIN ($SOURCE)"
if claude plugin marketplace list | grep -q "$PLUGIN"; then
  claude plugin marketplace update "$PLUGIN"
else
  claude plugin marketplace add "$SOURCE"
fi

step "plugin $PLUGIN@$PLUGIN"
claude plugin install "$PLUGIN@$PLUGIN"

if [ "${CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:-}" != "1" ]; then
  printf '\nwarning: function hooks are off. Add this to your shell profile (~/.bashrc, ~/.zshrc):\n'
  printf '  export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1\n'
fi

printf '\nDone. Restart Claude Code or run /reload-plugins. laya-serve now starts at every login and restarts if it dies.\n'
