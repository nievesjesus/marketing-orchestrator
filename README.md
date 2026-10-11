# Marketing Orchestrator

A marketing assistant for people with no technical background, packaged as a Claude plugin and a portable [Agent Skill](https://agentskills.io). Tell Claude what you want to promote and it plans the posts, writes them in your brand's voice for each social network, helps you get the images, suggests when to publish and, only after you say yes, schedules everything in [Postiz](https://postiz.com).

Works in **Claude (web, Desktop, mobile, Cowork), Claude Code, Codex, Cursor** and any client that reads `SKILL.md`. The assistant always replies in the user's language; the skill files themselves are in English.

## What it does

- **Post packages** per network: goal, audience, hook (+ A/B), copy, CTA, hashtags, alt text, first comment.
- **Brand card**: a short interview produces a brand card the user keeps in a Claude Project (works on every device).
- **Images**: briefs and routing to the connected image tools (Canva today; the hosted Marketing Images connector is in development).
- **When to post**: audience-timezone heuristics plus the Postiz calendar.
- **Scheduling in Postiz**: drafts are always fine; publishing or scheduling needs an explicit yes.

## Install

Build the zips (needs `zip` and Node.js; the skill is validated first):

```bash
bash build.sh
```

| File | Contains | Upload in Claude |
|---|---|---|
| `dist/marketing-orchestrator-plugin.zip` (recommended) | The skill plus the connector entry (`.mcp.json`) | Customize → Plugins → Add → Upload plugin |
| `dist/marketing-orchestrator.zip` | The skill only | Customize → Skills → Upload |

For Claude Code or Codex, link the skill folder instead: `tools/install.sh claude-code codex`.

Data: the plugin stores nothing itself. Post text and images go only to the connectors the user chooses to connect (Postiz, the Marketing Images connector, Canva). No API keys are bundled; Postiz is connected by the user inside Claude.

## Repository layout

```
.claude-plugin/plugin.json          plugin manifest
.mcp.json                           connector entries bundled in the plugin (no secrets)
skills/marketing-orchestrator/      the skill: SKILL.md + references/ only (this is what ships)
servers/marketing-images/           hosted image MCP server (design; Cloudflare Worker)
tools/                              optional Python toolkit for developers (CLI, local MCP server, tests)
build.sh                            validates the skill and builds both zips into dist/
```

## Developer toolkit (optional)

`tools/` holds a stdlib-only Python CLI and a local MCP server (brand kits, Gemini images, logo overlay, time slots, Postiz uploads). It is not shipped with the skill and the skill does not need it.

```bash
mkdir -p ~/.config/marketing-orchestrator && cp .env.example ~/.config/marketing-orchestrator/.env
chmod 600 ~/.config/marketing-orchestrator/.env   # then fill POSTIZ_API_KEY and GEMINI_API_KEY
pip install pillow                                # optional, for logo/crop tools
python3 tools/scripts/mkt.py doctor
```

Then, in any client with the toolkit connected: *"Here are 2 images for Instagram, brand example-coffee-shop. Build the post and tell me when to publish."*

Details (per-client setup, brand kits, package schema, Postiz API): [`tools/docs/`](tools/docs/). The example brand kit is `tools/brands/example-coffee-shop/`; private kits live in `~/.config/marketing-orchestrator/brands/`.

## Developing

Read [`AGENTS.md`](AGENTS.md) (also loaded by Claude Code via `CLAUDE.md`). Checks, no network or keys needed:

```bash
python3 -m unittest discover -s tools/tests -v
npx -y skills-ref validate skills/marketing-orchestrator
bash build.sh
```

## Roadmap ideas

- Weekly content calendar from pillars + cadence, filled into Postiz as drafts
- Analytics loop: pull post stats, update `learned` and best-time windows per brand
- Carousel builder (multi-slide images with consistent style and text)
- Video: Postiz clipping / Veo short clips
- More image providers behind the same `image generate` interface
- Competitor/trend research step before drafting

## License

MIT
