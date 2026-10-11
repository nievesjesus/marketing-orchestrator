# Changelog

## 0.5.0 — 2026-10-11
- **Skill rewritten (SKILL.md 0.5.0, English, always replies in the user's language):** new flow with a connector check (Marketing Images, Postiz, optional Canva), brand card plus a saved visual brand (`list_brands` / `save_brand`), single-post and **campaign mode** (goal, audience, message, networks, arcs, calendar), visuals, post package with hook and call-to-action guidance, a silent brand check, when to post, a campaign summary card plus per-post cards, publishing, a check-in report, and safety rails (costs and daily limits, confirmations before deletes, personal links are passwords). Approving a campaign plan never schedules anything.
- **Marketing Images connector** (`servers/marketing-images/`, portable MCP server): the skill now drives `list_providers`, `estimate_cost`, `generate_image`, `edit_image`, `get_job`, `compose_post`, `compose_custom`, `compose_carousel`, the template tools and the brand tools. Users add it with a personal link (a secret) handed over by the owner.
- **Postiz MCP v2.25 flow:** user photos through `uploadWidgetTool` / `uploadWidgetStatusTool`, every image that Postiz doesn't host through `uploadFromUrlTool`, then `integrationSchema` → `integrationSchedulePostTool` (or `schedulePostTool` in older versions and Cloud docs) → `postsListTool` to confirm. Self-hosted URL format fixed to `https://<postiz-domain>/api/mcp/<API_KEY>`.
- References: new `campaigns.md`, `brand-check.md`, `visuals.md` (replaces `image-generation.md`: Marketing Images first, template catalog, Canva and other options), `design-guide.md` (how to write `compose_custom` HTML and save templates), `marketing-images.md` and `reports.md`; rewritten `getting-started.md` and `postiz-mcp.md`; extended `brand-card.md` (3 voice traits, tone per network, emoji and capitals policy, words to avoid, mapping to `save_brand`); `platform-playbook.md` aligned with the new flow.
- Licensing: `SKILL.md` license is now "MIT (portions Apache-2.0, see THIRD_PARTY_NOTICES.md)". New `THIRD_PARTY_NOTICES.md` and `LICENSES/Apache-2.0.txt` for the portions adapted from Anthropic's knowledge-work-plugins Marketing plugin v1.2.0 (Apache-2.0, modified); adapted files carry a first-line comment. `build.sh` ships both in the skill zip (inside `marketing-orchestrator/`) and in the plugin zip.
- **Plugin = skill only:** `.mcp.json` removed (the connectors need personal links, which are secrets: users add Postiz and Marketing Images themselves). `build.sh` no longer requires it, fails if it appears in the plugin zip, and checks that the skill and plugin versions match.
- `.claude-plugin/plugin.json` is `0.5.0`; `agents/openai.yaml` updated; README "What it does" updated.
- Structure: the skill (`skills/marketing-orchestrator/`) is now instructions-only (`SKILL.md`, `references/`, `agents/`). The Python toolkit moved to `tools/` (kept, dev-only, behavior unchanged): `scripts/` → `tools/scripts/`, `assets/brands/` → `tools/brands/`, `tests/` → `tools/tests/`, `install.sh` → `tools/install.sh`.
- Developer-only references moved to `tools/docs/`: `advanced.md`, `setup.md`, `branding.md`, `package-schema.md`, `postiz-api.md`.
- The personal example brand kit was replaced by the fictional `example-coffee-shop`; the toolkit's bundled brands directory is now `tools/brands` (the `~/.config/marketing-orchestrator/brands` and `MKT_BRANDS_DIR` lookups are unchanged).
- `SKILL.md`: dropped mentions of scripts, `assets/brands/` and the moved reference files; `agents/openai.yaml` no longer declares the local MCP server.
- New Claude plugin manifest `.claude-plugin/plugin.json`.
- New `build.sh`: validates the skill with `skills-ref`, then builds `dist/marketing-orchestrator.zip` (skill only) and `dist/marketing-orchestrator-plugin.zip` (plugin bundle). `tools/install.sh zip` delegates to it; `--with-brands` is no longer supported.
- New GitHub Actions workflow `.github/workflows/ci.yml` (Python tests on 3.9 and 3.13, skill validation and build, and the Marketing Images server checks: typecheck, tests, Docker build).
- Added `LICENSE` (MIT); author/copyright is now Codeame.

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
