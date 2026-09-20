#!/bin/sh
# Installs fast-jev-compaction into OpenCode (1 or 2) and/or Claude Code.
# Nothing is built: the OpenCode entry is committed as opencode/server.js and
# the Claude Code hook runs from source. No API key is needed; without
# TYPESAFE_API_KEY the plugin uses OpenCode Zen's free Jev.
#
#   curl -fsSL https://raw.githubusercontent.com/tamaratran/fast-jev-compaction/main/install.sh | sh
#   curl -fsSL ... | sh -s -- claude       # Claude Code instead of OpenCode
#   curl -fsSL ... | sh -s -- all          # both
#   ./install.sh opencode --dir ~/src/fast-jev-compaction   # use this checkout
#
# OpenCode 2 with `opencode` on PATH: `opencode plugin add` installs the git
# package (FAST_JEV_PACKAGE, default github:tamaratran/fast-jev-compaction).
# Otherwise (OpenCode 1, or --file): a git checkout in FAST_JEV_DIR (default
# ~/.local/share/fast-jev-compaction, ref FAST_JEV_REF, default main) and one
# file in ~/.config/opencode/plugins/ that loads it.
set -eu

REPO="https://github.com/tamaratran/fast-jev-compaction.git"
PACKAGE="${FAST_JEV_PACKAGE:-github:tamaratran/fast-jev-compaction}"
TARGET="opencode"
MODE="auto"
DIR="${FAST_JEV_DIR:-$HOME/.local/share/fast-jev-compaction}"
REF="${FAST_JEV_REF:-main}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

while [ $# -gt 0 ]; do
  case "$1" in
    opencode|claude|all) TARGET="$1" ;;
    --file) MODE="file" ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a directory"; DIR="$2"; MODE="file"; shift ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a git ref"; REF="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# A checkout of the repository. Only a checkout this script created is ever
# updated; any other directory is used as it is.
checkout() {
  need git
  marker="$DIR/.fast-jev-installer"
  if [ -f "$marker" ] && [ -d "$DIR/.git" ]; then
    say "updating $DIR"
    git -C "$DIR" fetch --quiet origin "$REF"
    git -C "$DIR" checkout --quiet --detach FETCH_HEAD
  elif [ -e "$DIR/package.json" ]; then
    say "using existing checkout at $DIR"
  else
    say "cloning into $DIR"
    git clone --quiet --branch "$REF" "$REPO" "$DIR"
    : > "$marker"
  fi
  [ -f "$DIR/opencode/server.js" ] || die "$DIR has no opencode/server.js (run: npm install && npm run bundle)"
}

opencode_major() {
  opencode --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\..*/\1/p' | head -n 1
}

# OpenCode 2: the package manager installs the git package and records it in
# the global config; `opencode plugin update` keeps it current.
install_opencode_package() {
  say "installing $PACKAGE with opencode plugin add"
  opencode plugin add "$PACKAGE"
}

# Either version: one file in the global plugins directory loads the checkout.
install_opencode_file() {
  checkout
  plugins="$CONFIG_HOME/opencode/plugins"
  mkdir -p "$plugins"
  file="$plugins/fast-jev-compaction.ts"
  printf 'export { default } from "%s/opencode/server.js"\n' "$DIR" > "$file"
  say "installed OpenCode plugin: $file"
}

install_opencode() {
  major="$(opencode_major || true)"
  if [ "$MODE" = "auto" ] && [ "${major:-0}" -ge 2 ] 2>/dev/null; then
    install_opencode_package
  else
    install_opencode_file
  fi
  say "restart OpenCode (or its background server: opencode service restart) to load it"
}

# Claude Code: the repository is its own plugin marketplace.
install_claude() {
  need claude
  claude plugin marketplace add tamaratran/fast-jev-compaction >/dev/null 2>&1 || true
  claude plugin install fast-jev-compaction@fast-jev-compaction
  say "installed Claude Code plugin; function hooks must be enabled:"
  say '  { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }   # in ~/.claude/settings.json'
  say "then restart Claude Code or run /reload-plugins"
}

case "$TARGET" in
  opencode) install_opencode ;;
  claude) install_claude ;;
  all) install_opencode; install_claude ;;
esac

say ""
say "Jev is reached at OpenCode Zen (free, no key) unless TYPESAFE_API_KEY is set;"
say "FAST_JEV_PROVIDER=opencode forces Zen even with a key."
