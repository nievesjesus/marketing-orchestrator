#!/usr/bin/env bash
# Install the marketing-orchestrator skill into one or more agent clients.
#   ./install.sh claude-code | codex | zip [--with-brands] | mcp-config | all
#   ./install.sh --dest <skills-dir>      any other Agent Skills client
#   --copy                                copy instead of symlink
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="marketing-orchestrator"
SKILL="$ROOT/skills/$NAME"
MODE="link"
WITH_BRANDS=0
TARGETS=()
DEST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy) MODE="copy" ;;
    --with-brands) WITH_BRANDS=1 ;;
    --dest) DEST="$2"; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) TARGETS+=("$1") ;;
  esac
  shift
done
[[ -n "$DEST" ]] && TARGETS+=("dest")
[[ ${#TARGETS[@]} -eq 0 ]] && { sed -n '2,6p' "$0"; exit 1; }

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
  mkdir -p "$ROOT/dist"
  local out="$ROOT/dist/$NAME.zip"
  python3 - "$SKILL" "$out" "$WITH_BRANDS" <<'PY'
import os, sys, zipfile
from pathlib import Path
skill, out, with_brands = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == "1"
skip_dirs = {"__pycache__", ".pytest_cache", "output"}
user = Path(os.environ.get("MKT_HOME", Path.home() / ".config" / "marketing-orchestrator")) / "brands"
user_slugs = {d.name for d in user.iterdir() if d.is_dir()} if with_brands and user.is_dir() else set()
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(skill.rglob("*")):
        rel = p.relative_to(skill)
        if any(part in skip_dirs for part in rel.parts) or p.name in (".env", ".DS_Store") or p.is_dir():
            continue
        if rel.parts[:2] == ("assets", "brands") and len(rel.parts) > 2 and rel.parts[2] in user_slugs:
            continue  # the private kit replaces the bundled one
        z.write(p, Path(skill.name) / rel)
    if user_slugs:
            for p in sorted(user.rglob("*")):
                if p.is_file() and p.name != ".DS_Store":
                    z.write(p, Path(skill.name) / "assets" / "brands" / p.relative_to(user))
print(f"✓ zip → {out}")
PY
  echo "  Upload it in the Skills section of Claude Desktop / claude.ai settings. Secrets (.env) are never included."
}

mcp_config() {
  local server="$SKILL/scripts/mcp_server.py"
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
