#!/usr/bin/env bash
# Developer helper: install the (instructions-only) skill into agent clients, build the zips,
# or print the config for the local Python MCP server (tools/scripts/mcp_server.py).
#   tools/install.sh claude-code | codex | zip | mcp-config | all
#   tools/install.sh --dest <skills-dir>  any other Agent Skills client
#   --copy                                copy instead of symlink
# `zip` delegates to the repo's build.sh (dist/marketing-orchestrator.zip + the plugin zip).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="marketing-orchestrator"
SKILL="$ROOT/skills/$NAME"
MODE="link"
TARGETS=()
DEST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy) MODE="copy" ;;
    --with-brands) echo "note: --with-brands is no longer supported: the skill ships without brand kits (the brand card lives in a Claude Project)." >&2 ;;
    --dest) DEST="$2"; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) TARGETS+=("$1") ;;
  esac
  shift
done
[[ -n "$DEST" ]] && TARGETS+=("dest")
[[ ${#TARGETS[@]} -eq 0 ]] && { sed -n '2,7p' "$0"; exit 1; }

install_to() {
  local dir="$1"
  mkdir -p "$dir"
  local target="$dir/$NAME"
  if [[ -L "$target" || -e "$target" ]]; then
    if [[ -L "$target" ]]; then rm "$target"; else mv "$target" "$target.bak.$(date +%s)"; echo "  backed up existing $target"; fi
  fi
  if [[ "$MODE" == "link" ]]; then ln -s "$SKILL" "$target"; else cp -R "$SKILL" "$target"; fi
  echo "✓ $MODE → $target"
}

make_zip() {
  bash "$ROOT/build.sh"
}

mcp_config() {
  local server="$ROOT/tools/scripts/mcp_server.py"
  cat <<EOF

Claude Desktop (claude_desktop_config.json) / Cursor (~/.cursor/mcp.json):
{ "mcpServers": { "$NAME": { "command": "python3", "args": ["$server"] } } }

Claude Code:
  claude mcp add $NAME -- python3 "$server"

Codex (~/.codex/config.toml):
  [mcp_servers.$NAME]
  command = "python3"
  args = ["$server"]

Keys are read from ~/.config/marketing-orchestrator/.env (see .env.example).
EOF
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    claude-code) install_to "$HOME/.claude/skills" ;;
    codex) install_to "$HOME/.agents/skills" ;;
    zip|desktop) make_zip ;;
    mcp-config) mcp_config ;;
    dest) install_to "$DEST" ;;
    all) install_to "$HOME/.claude/skills"; install_to "$HOME/.agents/skills"; make_zip; mcp_config ;;
    *) echo "unknown target: $t"; exit 1 ;;
  esac
done

if [[ ! -f "$HOME/.config/marketing-orchestrator/.env" ]]; then
  echo
  echo "Next: mkdir -p ~/.config/marketing-orchestrator && cp \"$ROOT/.env.example\" ~/.config/marketing-orchestrator/.env && chmod 600 ~/.config/marketing-orchestrator/.env"
fi
