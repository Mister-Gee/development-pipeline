#!/usr/bin/env sh
# Installs the development-pipeline skills and agents into Codex.
# Usage: sh install.sh            (uses $CODEX_HOME, default ~/.codex)
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
AGENTS_DIR="$CODEX_DIR/agents"
mkdir -p "$AGENTS_DIR" "$CODEX_DIR/skills"
cp "$SRC"/agents/*.toml "$AGENTS_DIR/"
for s in build-project review-fix review-implement; do
  rm -rf "$CODEX_DIR/skills/$s"
  cp -R "$SRC/skills/$s" "$CODEX_DIR/skills/$s"
  sed "s#{{CODEX_AGENTS_DIR}}#$AGENTS_DIR#g" "$SRC/skills/$s/SKILL.md" > "$CODEX_DIR/skills/$s/SKILL.md"
done
echo "Installed to $CODEX_DIR (skills: build-project, review-fix, review-implement). Restart Codex."
