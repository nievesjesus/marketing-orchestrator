# AGENTS.md — marketing-orchestrator

Instructions for any coding agent (Codex, Claude Code, Cursor, Gemini CLI…) working **on** this repo, and a fallback for tools that don't load Agent Skills.

## Using the assistant without skills support

Read `skills/marketing-orchestrator/SKILL.md` and follow it. (Developers can also drive the optional Python toolkit: `python3 tools/scripts/mkt.py`.)

## Layout

```
.claude-plugin/plugin.json          ← Claude plugin manifest (name, displayName, version, description, author, license)
.mcp.json                           ← connector entries bundled in the plugin (marketing-images). NEVER put secrets here;
                                      Postiz is not listed because its URL carries the user's key
skills/marketing-orchestrator/      ← the skill: INSTRUCTIONS ONLY (portable Agent Skills folder; this is what ships)
  SKILL.md                          ← workflow; agent-neutral, < 500 lines
  agents/openai.yaml                ← Codex-only UI/policy metadata (others ignore it)
  references/*.md                   ← loaded on demand; keep details here, not in SKILL.md
servers/marketing-images/           ← portable MCP server (Node 22/TypeScript, Docker): image generation + post composer; not part of the plugin zip
tools/                              ← optional Python dev toolkit; never shipped in the skill or plugin
  scripts/mkt.py                    ← CLI entry point (stdlib only)
  scripts/mcp_server.py             ← local stdio MCP server over the same library
  scripts/mktlib/                   ← all logic: config, brand, gemini, imaging, timeslots, package, postiz
  brands/<slug>/                    ← example brand kits (brand.json, voice.md, logos, style/); `_template` is the base for `brand init`
  docs/*.md                         ← toolkit docs: setup, advanced, branding, package-schema, postiz-api
  tests/                            ← unittest suite, no network
  install.sh                        ← dev helper: link/copy the skill into Claude Code / Codex, print local MCP config; `zip` runs build.sh
build.sh                            ← validates the skill, builds dist/marketing-orchestrator.zip (skill only)
                                      and dist/marketing-orchestrator-plugin.zip (plugin bundle)
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
- Never commit `.env`, generated images, private brand kits, or secrets in `.mcp.json`.

## Adding a capability (checklist)

**Skill behavior (what users get):**

1. Short step in `skills/marketing-orchestrator/SKILL.md`, details in `skills/marketing-orchestrator/references/<topic>.md`; add the file to the table at the end of `SKILL.md`. Reference files must exist in `references/` (a test checks it).
2. A new connector for the plugin goes in `.mcp.json` (URL only, no secrets) and is mentioned in `getting-started.md`.
3. `CHANGELOG.md`; bump `metadata.version` in `SKILL.md` and `version` in `.claude-plugin/plugin.json` together.

**Python toolkit action (developers only):**

1. Logic in `tools/scripts/mktlib/<module>.py`.
2. CLI subcommand in `tools/scripts/mkt.py`; MCP tool in `tools/scripts/mcp_server.py` (`TOOLS` dict).
3. Docs in `tools/docs/` (not in the skill).
4. Tests in `tools/tests/` (mock HTTP; no network).
5. `CHANGELOG.md`; bump `__version__` in `tools/scripts/mktlib/__init__.py`.

**Image server:** work in `servers/marketing-images/` (planning and design notes are kept locally, not in the repo); it has its own checks (`server` job in `.github/workflows/ci.yml`): from that folder run `npm run typecheck && npm test` (Node 22, see `.nvmrc`; no network or keys needed).

## Checks before committing

```
python3 -m unittest discover -s tools/tests -v
python3 tools/scripts/mkt.py doctor
npx -y skills-ref validate skills/marketing-orchestrator
bash build.sh   # validates again and prints both zip listings
```
