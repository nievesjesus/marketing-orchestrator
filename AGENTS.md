# AGENTS.md — marketing-orchestrator

Instructions for any coding agent (Codex, Claude Code, Cursor, Gemini CLI…) working **on** this repo, and a fallback for tools that don't load Agent Skills.

## Using the assistant without skills support

Read `skills/marketing-orchestrator/SKILL.md` and follow it. (Developers can also drive the optional Python toolkit: `python3 tools/scripts/mkt.py`.)

## Layout

```
.claude-plugin/plugin.json          ← Claude plugin manifest (name, displayName, version, description, author, license)
                                      The plugin is the skill only: there is NO .mcp.json, because both connectors (Postiz,
                                      Marketing Images) need a personal link or key, which is a secret. Users add them themselves.
.claude-plugin/marketplace.json     ← Claude Code marketplace "codeame" (`/plugin marketplace add nievesjesus/marketing-orchestrator`);
                                      its plugin entry name must equal plugin.json `name` (build.sh checks it); not shipped in the zips
skills/marketing-orchestrator/      ← the skill: INSTRUCTIONS ONLY (portable Agent Skills folder; this is what ships)
  SKILL.md                          ← workflow; agent-neutral, English, < 500 lines (aim ≤ 330)
  agents/openai.yaml                ← Codex-only UI/policy metadata (others ignore it)
  references/*.md                   ← loaded on demand; keep details here, not in SKILL.md
                                      (setup-local.md: remote vs local Marketing Images, per-agent MCP snippets and skill folders)
THIRD_PARTY_NOTICES.md, LICENSES/   ← attribution + Apache-2.0 text for the portions adapted from Anthropic's Marketing plugin;
                                      single copy at the repo root, build.sh copies them into both zips
servers/marketing-images/           ← portable MCP server (Node 22/TypeScript): image generation + post composer; not part of the plugin zip.
                                      Published as npm `@codeame/marketing-images` (stdio by default, `--http` for server mode) and as the
                                      Docker image `ghcr.io/nievesjesus/marketing-images` (HTTP mode)
tools/                              ← optional Python dev toolkit; never shipped in the skill or plugin
  scripts/mkt.py                    ← CLI entry point (stdlib only)
  scripts/mcp_server.py             ← local stdio MCP server over the same library
  scripts/mktlib/                   ← all logic: config, brand, gemini, imaging, timeslots, package, postiz
  brands/<slug>/                    ← example brand kits (brand.json, voice.md, logos, style/); `_template` is the base for `brand init`
  docs/*.md                         ← toolkit docs: setup, advanced, branding, package-schema, postiz-api
  tests/                            ← unittest suite, no network
  install.sh                        ← dev helper: link/copy the skill into Claude Code / Codex, print local MCP config; `zip` runs build.sh
build.sh                            ← validates the skill and both manifests, checks skill/plugin versions match, builds
                                      dist/marketing-orchestrator.zip (skill only + notices) and dist/marketing-orchestrator-plugin.zip
                                      (skill + plugin.json + notices); the zips are attached to GitHub Releases
.github/workflows/ci.yml            ← python tests · skill validation + build · server (typecheck, tests, docker build)
```

## Rules

- **The skill ships instructions only.** No scripts, no `assets/`, no brand kits inside `skills/marketing-orchestrator/`. Anything executable or developer-facing lives in `tools/`.
- **Never create a top-level `bin/` directory**: it makes claude.ai and Cowork refuse to install the plugin. `build.sh` fails if one exists.
- **Portability first.** `SKILL.md` must not name client-specific tools (no "ToolSearch", "Read tool", "SendUserFile"). Describe actions generically ("open the image", "if you have MCP tools named …").
- Frontmatter follows the Agent Skills spec: `name` = folder name (lowercase, hyphens, ≤ 64), `description` ≤ 1024 chars with *what* and *when*, optional `license`, `compatibility`, `metadata`.
- **Stdlib only** in `tools/scripts/mktlib` (Pillow optional, imported lazily). Python ≥ 3.9.
- One function in `mktlib` per action; the CLI (`mkt.py`) and the local MCP server (`mcp_server.py`) are thin wrappers. When you add an action, wire it in **both** and document it in `tools/docs/`.
- Errors: raise `MktError` with a user-facing message. Never include secrets in messages, files or output.
- Publishing guard: anything that makes content public must require explicit approval (`approved=True`). Keep that invariant.
- Never commit `.env`, generated images, private brand kits, or secrets (personal connector links, API keys). There is no `.mcp.json` in the repo; don't add one with a link in it.
- **Language:** every skill file (and every doc in this repo) is in English, and `SKILL.md` tells the assistant to always reply in the user's language. The end user is non-technical: the skill never asks them to run commands, edit files or paste keys or links in the chat. The one exception is a user running the assistant inside a coding agent (`references/setup-local.md`): the assistant runs the setup commands itself, with a yes, and the user only fills in their own keys in `~/.config/marketing-images/.env`, never in the chat.
- **Local setup rules** (`references/setup-local.md`): provider keys live only in `~/.config/marketing-images/.env` (chmod 600), never in an agent's config file or in the repo; before changing an agent's config the assistant shows the exact change, gets a yes, backs the file up and merges (never overwrites other servers). Only document config formats verified against each tool's docs, and date the check.
- **Anthropic-derived content** (Apache-2.0): a file that adapts it gets the first-line comment `<!-- Portions adapted from Anthropic's knowledge-work-plugins Marketing plugin v1.2.0 (Apache-2.0); modified. -->` and a row in `THIRD_PARTY_NOTICES.md`. Never copy their example statistics.
- Never let the skill invent numbers, reviews, prices, clients or results, and never publish or schedule without an explicit yes (approving a campaign plan never schedules anything).

## Adding a capability (checklist)

**Skill behavior (what users get):**

1. Short step in `skills/marketing-orchestrator/SKILL.md`, details in `skills/marketing-orchestrator/references/<topic>.md`; add the file to the table at the end of `SKILL.md`. Reference files must exist in `references/` (a test checks it).
2. Connectors are not bundled in the plugin (they need personal links or keys): document a new one in `getting-started.md` and in its own reference (see `marketing-images.md`, `setup-local.md`, `postiz-mcp.md`), and add it to the connector table in `SKILL.md` section 1.
3. `CHANGELOG.md`; bump `metadata.version` in `SKILL.md` and `version` in `.claude-plugin/plugin.json` together (`build.sh` fails if they differ).

**Python toolkit action (developers only):**

1. Logic in `tools/scripts/mktlib/<module>.py`.
2. CLI subcommand in `tools/scripts/mkt.py`; MCP tool in `tools/scripts/mcp_server.py` (`TOOLS` dict).
3. Docs in `tools/docs/` (not in the skill).
4. Tests in `tools/tests/` (mock HTTP; no network).
5. `CHANGELOG.md`; bump `__version__` in `tools/scripts/mktlib/__init__.py`.

**Image server:** work in `servers/marketing-images/` (planning and design notes are kept locally, not in the repo). When its run modes, settings or result fields change (`file_path`, `postiz`, env variables, flags), update `references/setup-local.md` and `references/marketing-images.md` too. It has its own checks (`server` job in `.github/workflows/ci.yml`): from that folder run `npm run typecheck && npm test` (Node 22, see `.nvmrc`; no network or keys needed).

## Checks before committing

```
python3 -m unittest discover -s tools/tests -v
python3 tools/scripts/mkt.py doctor
npx -y skills-ref validate skills/marketing-orchestrator
claude plugin validate .   # plugin.json + .claude-plugin/marketplace.json (needs the Claude Code CLI)
bash build.sh   # validates again and prints both zip listings
```
