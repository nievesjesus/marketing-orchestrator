#!/usr/bin/env bash
# Build the distributable zips into dist/ (bash 3.2+, macOS and Linux).
#
#   bash build.sh
#
# Outputs
#   dist/marketing-orchestrator.zip          the skill only (zip root = marketing-orchestrator/)
#   dist/marketing-orchestrator-plugin.zip   Claude plugin bundle: .claude-plugin/plugin.json,
#                                            .mcp.json, skills/marketing-orchestrator/**, README.md, LICENSE
#
# The skill is validated first (npx -y skills-ref validate); an invalid skill fails the build.
# Needs: bash, zip, unzip, npx (Node.js).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="marketing-orchestrator"
SKILL_REL="skills/$NAME"
DIST="$ROOT/dist"
SKILL_ZIP="$DIST/$NAME.zip"
PLUGIN_ZIP="$DIST/$NAME-plugin.zip"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but was not found in PATH"; }

need zip
need unzip
need npx

cd "$ROOT"

# --- 1. Validate -------------------------------------------------------------------------------

echo "==> Validating $SKILL_REL"
npx -y skills-ref validate "$SKILL_REL" || die "skill validation failed"

[[ -f "$SKILL_REL/SKILL.md" ]] || die "$SKILL_REL/SKILL.md not found"
fm_name="$(sed -n 's/^name:[[:space:]]*//p' "$SKILL_REL/SKILL.md" | head -n 1 | tr -d '\r"'"'"' ')"
[[ "$fm_name" == "$NAME" ]] || die "frontmatter name '$fm_name' must equal the folder name '$NAME'"

for f in .claude-plugin/plugin.json .mcp.json README.md LICENSE; do
  [[ -f "$f" ]] || die "$f not found"
done
# A top-level bin/ makes claude.ai and Cowork refuse to install the plugin.
[[ ! -e bin ]] || die "a top-level bin/ directory stops claude.ai and Cowork from installing the plugin; remove it"

# --- 2. Build ----------------------------------------------------------------------------------

mkdir -p "$DIST"
rm -f "$SKILL_ZIP" "$PLUGIN_ZIP"

# Never ship OS noise, Python caches or secrets.
EXCLUDES=(-x '*.DS_Store' -x '*__pycache__*' -x '*.pyc' -x '*.env')

echo "==> Building $SKILL_ZIP"
( cd "$ROOT/skills" && zip -r -X -q "$SKILL_ZIP" "$NAME" "${EXCLUDES[@]}" )

echo "==> Building $PLUGIN_ZIP"
zip -r -X -q "$PLUGIN_ZIP" .claude-plugin .mcp.json "$SKILL_REL" README.md LICENSE "${EXCLUDES[@]}"

# --- 3. Verify the layouts ---------------------------------------------------------------------

echo "==> Checking zip layouts"

# Here-strings instead of pipes: `grep -q` closing a pipe early would trip pipefail via SIGPIPE.
skill_entries="$(unzip -Z1 "$SKILL_ZIP")"
plugin_entries="$(unzip -Z1 "$PLUGIN_ZIP")"

# Skill zip: every entry lives under marketing-orchestrator/, and SKILL.md is directly inside it.
outside="$(grep -v "^$NAME/" <<<"$skill_entries" || true)"
[[ -z "$outside" ]] || die "$SKILL_ZIP has entries outside $NAME/: $outside"
grep -qxF "$NAME/SKILL.md" <<<"$skill_entries" || die "$SKILL_ZIP is missing $NAME/SKILL.md"

# Plugin zip: manifest and .mcp.json at the zip root, nothing that belongs to the dev toolkit.
for required in .claude-plugin/plugin.json .mcp.json "$SKILL_REL/SKILL.md" README.md LICENSE; do
  grep -qxF "$required" <<<"$plugin_entries" || die "$PLUGIN_ZIP is missing $required"
done
forbidden="$(grep -E '^(bin|tools|servers|docs|dist|\.github)/' <<<"$plugin_entries" || true)"
[[ -z "$forbidden" ]] || die "$PLUGIN_ZIP contains paths that must not ship: $forbidden"

# --- 4. Report ---------------------------------------------------------------------------------

echo
echo "==> $SKILL_ZIP"
unzip -l "$SKILL_ZIP"
echo
echo "==> $PLUGIN_ZIP"
unzip -l "$PLUGIN_ZIP"
echo
echo "Done."
echo "  Skill only:  $SKILL_ZIP    (Customize > Skills > Upload)"
echo "  Plugin:      $PLUGIN_ZIP   (Customize > Plugins > Add > Upload plugin)"
