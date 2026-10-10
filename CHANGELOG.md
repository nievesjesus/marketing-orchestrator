# Changelog

## 0.2.0 — 2026-10-10
- Portable Agent Skills layout (`skills/marketing-orchestrator/`), agent-neutral instructions.
- Unified stdlib CLI `scripts/mkt.py` (doctor, brand, image, time, package, postiz).
- Brand kits (`assets/brands/<slug>/` or `~/.config/marketing-orchestrator/brands/`): voice, audiences, palette, fonts, logos, style refs, learned lessons.
- Gemini image generation/editing with brand style injection and reference images.
- Local image tools: logo overlay (auto light/dark), crop/pad to ratio, platform fit check.
- Heuristic publish-time suggestions in the audience timezone.
- Post package schema + validator; package → Postiz payload builder; approval guard on create.
- Bundled stdio MCP server for Claude Desktop, Claude Code, Codex, Cursor.
- `install.sh` for Claude Code, Codex, Desktop zip, MCP snippets. Codex `agents/openai.yaml`.

## 0.1.0 — 2026-10-09
- First version: Postiz-only skill for Claude.
