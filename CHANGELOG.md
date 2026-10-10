# Changelog

## 0.4.0 — 2026-10-10
- Rewritten for non-technical users: connectors first (Canva, Postiz), plain-language guidance, one step at a time, no commands or keys asked of the user.
- Language rule: always reply in the user's language; skill files stay in English.
- New `references/getting-started.md` (connect Canva, connect Postiz, brand card in a Claude Project) and `references/brand-card.md` (template + example).
- `references/image-generation.md` rewritten: Canva generate-image/generate-design/Brand Kit, Adobe, Postiz, Figma, Gemini/ChatGPT apps, own photos.
- Developer material moved to `references/advanced.md` (CLI, local MCP server, Gemini API).

## 0.3.0 — 2026-10-10
- `references/postiz-mcp.md`: install guide for the Postiz MCP (Claude connector, Claude Code, Codex, Cursor, Desktop config) and tool mapping.
- Image providers table: Gemini direct, Figma MCP `generate_image`/Weave, Postiz `generateImageTool`, Canva designs.
- `--approved` flag documented for `postiz create`.

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
