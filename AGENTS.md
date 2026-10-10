# AGENTS.md — marketing-orchestrator

Instructions for any coding agent (Codex, Claude Code, Cursor, Gemini CLI…) working **on** this repo, and a fallback for tools that don't load Agent Skills.

## Using the assistant without skills support

Read `skills/marketing-orchestrator/SKILL.md` and follow it. Run actions with `python3 skills/marketing-orchestrator/scripts/mkt.py`.

## Layout

```
skills/marketing-orchestrator/      ← the skill (portable Agent Skills folder; this is what gets installed)
  SKILL.md                          ← workflow; agent-neutral, < 500 lines
  agents/openai.yaml                ← Codex-only UI/policy metadata (others ignore it)
  references/*.md                   ← loaded on demand; keep details here, not in SKILL.md
  assets/brands/<slug>/             ← brand kits (brand.json, voice.md, logos, style/)
  scripts/mkt.py                    ← CLI entry point (stdlib only)
  scripts/mcp_server.py             ← stdio MCP server over the same library
  scripts/mktlib/                   ← all logic: config, brand, gemini, imaging, timeslots, package, postiz
tests/                              ← unittest suite, no network
install.sh                          ← install into Claude Code / Codex / zip for Desktop / print MCP config
```

## Rules

- **Portability first.** `SKILL.md` must not name client-specific tools (no "ToolSearch", "Read tool", "SendUserFile"). Describe actions generically ("open the image", "if you have MCP tools named …").
- Frontmatter follows the Agent Skills spec: `name` = folder name (lowercase, hyphens, ≤ 64), `description` ≤ 1024 chars with *what* and *when*, optional `license`, `compatibility`, `metadata`.
- **Stdlib only** in `mktlib` (Pillow optional, imported lazily). Python ≥ 3.9.
- One function in `mktlib` per action; the CLI (`mkt.py`) and the MCP server (`mcp_server.py`) are thin wrappers. When you add an action, wire it in **both** and document it in `SKILL.md` or a reference.
- Errors: raise `MktError` with a user-facing message. Never include secrets in messages, files or output.
- Publishing guard: anything that makes content public must require explicit approval (`approved=True`). Keep that invariant.
- Never commit `.env`, generated images, or private brand kits.

## Adding a capability (checklist)

1. Logic in `scripts/mktlib/<module>.py`.
2. CLI subcommand in `scripts/mkt.py`; MCP tool in `scripts/mcp_server.py` (`TOOLS` dict).
3. Docs: short step in `SKILL.md`, details in `references/<topic>.md`, add the file to the table at the end of `SKILL.md`.
4. Tests in `tests/` (mock HTTP; no network).
5. `CHANGELOG.md` + bump `metadata.version` in `SKILL.md` and `mktlib/__init__.py`.

## Checks before committing

```
python3 -m unittest discover -s tests -v
python3 skills/marketing-orchestrator/scripts/mkt.py doctor
./install.sh zip && unzip -l dist/marketing-orchestrator.zip | head
```
