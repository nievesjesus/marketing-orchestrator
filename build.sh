#!/usr/bin/env bash
# Build the distributable zips into dist/ (bash 3.2+, macOS and Linux).
#
#   bash build.sh
#
# Outputs
#   dist/marketing-orchestrator.zip          the skill only (zip root = marketing-orchestrator/), plus
#                                            marketing-orchestrator/THIRD_PARTY_NOTICES.md and
#                                            marketing-orchestrator/LICENSES/Apache-2.0.txt (copied in at build time:
#                                            the repo keeps one copy of each, at the repo root)
#   dist/marketing-orchestrator-plugin.zip   Claude plugin bundle: .claude-plugin/plugin.json,
#                                            skills/marketing-orchestrator/**, README.md, LICENSE,
#                                            THIRD_PARTY_NOTICES.md, LICENSES/
#                                            (no .mcp.json: the connectors need personal links, which are secrets,
#                                            so users add Postiz and Marketing Images themselves)
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

for f in .claude-plugin/plugin.json README.md LICENSE THIRD_PARTY_NOTICES.md LICENSES/Apache-2.0.txt; do
  [[ -f "$f" ]] || die "$f not found"
done

# The skill version and the plugin version are bumped together.
skill_ver="$(sed -n 's/^[[:space:]]*version:[[:space:]]*//p' "$SKILL_REL/SKILL.md" | head -n 1 | tr -d '\r"'"'"' ')"
plugin_ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' .claude-plugin/plugin.json | head -n 1)"
[[ -n "$skill_ver" && "$skill_ver" == "$plugin_ver" ]] || die "SKILL.md metadata.version ('$skill_ver') must equal .claude-plugin/plugin.json version ('$plugin_ver')"

# A top-level bin/ makes claude.ai and Cowork refuse to install the plugin.
[[ ! -e bin ]] || die "a top-level bin/ directory stops claude.ai and Cowork from installing the plugin; remove it"

# --- 2. Build ----------------------------------------------------------------------------------

mkdir -p "$DIST"
rm -f "$SKILL_ZIP" "$PLUGIN_ZIP"

# Never ship OS noise, Python caches or secrets.
EXCLUDES=(-x '*.DS_Store' -x '*__pycache__*' -x '*.pyc' -x '*.env')

# The skill zip is built from a staging copy so the notices can sit inside the skill folder
# without adding files to the skill directory in git.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mkt-build.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Building $SKILL_ZIP"
mkdir -p "$STAGE/skill"
cp -R "$SKILL_REL" "$STAGE/skill/$NAME"
cp THIRD_PARTY_NOTICES.md "$STAGE/skill/$NAME/THIRD_PARTY_NOTICES.md"
mkdir -p "$STAGE/skill/$NAME/LICENSES"
cp LICENSES/* "$STAGE/skill/$NAME/LICENSES/"
( cd "$STAGE/skill" && zip -r -X -q "$SKILL_ZIP" "$NAME" "${EXCLUDES[@]}" )

echo "==> Building $PLUGIN_ZIP"
zip -r -X -q "$PLUGIN_ZIP" .claude-plugin "$SKILL_REL" README.md LICENSE THIRD_PARTY_NOTICES.md LICENSES "${EXCLUDES[@]}"

# --- 3. Verify the layouts ---------------------------------------------------------------------

echo "==> Checking zip layouts"

# Here-strings instead of pipes: `grep -q` closing a pipe early would trip pipefail via SIGPIPE.
skill_entries="$(unzip -Z1 "$SKILL_ZIP")"
plugin_entries="$(unzip -Z1 "$PLUGIN_ZIP")"

# Skill zip: every entry lives under marketing-orchestrator/, SKILL.md is directly inside it, and the notices ship with it.
outside="$(grep -v "^$NAME/" <<<"$skill_entries" || true)"
[[ -z "$outside" ]] || die "$SKILL_ZIP has entries outside $NAME/: $outside"
for required in "$NAME/SKILL.md" "$NAME/THIRD_PARTY_NOTICES.md" "$NAME/LICENSES/Apache-2.0.txt"; do
  grep -qxF "$required" <<<"$skill_entries" || die "$SKILL_ZIP is missing $required"
done

# Plugin zip: manifest at the zip root, the notices next to it, nothing that belongs to the dev toolkit,
# and no .mcp.json (the connectors need personal links, which are secrets).
for required in .claude-plugin/plugin.json "$SKILL_REL/SKILL.md" README.md LICENSE THIRD_PARTY_NOTICES.md LICENSES/Apache-2.0.txt; do
  grep -qxF "$required" <<<"$plugin_entries" || die "$PLUGIN_ZIP is missing $required"
done
forbidden="$(grep -E '^(bin|tools|servers|docs|dist|\.github)/|^\.mcp\.json$' <<<"$plugin_entries" || true)"
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
echo "  Then add the Postiz and Marketing Images connectors (Customize > Connectors); see references/getting-started.md."
