# Marketing Orchestrator

A marketing assistant for people with no technical background, packaged as a Claude plugin and a portable [Agent Skill](https://agentskills.io). Tell Claude what you want to promote and it plans the posts, writes them in your brand's voice for each social network, helps you get the images, suggests when to publish and, only after you say yes, schedules everything in [Postiz](https://postiz.com).

Works in **Claude (web, Desktop, mobile, Cowork), Claude Code, Codex, Cursor** and any client that reads `SKILL.md`. The assistant always replies in the user's language; the skill files themselves are in English.

## What it does

- **Campaigns and single posts:** pick a goal, an audience and a message, and the assistant builds a short campaign (launch, event, weekly series, seasonal promo, re-engagement) with a calendar, or one post, with a short card to approve first. Approving a plan never schedules anything.
- **Post packages** per network: goal, audience, hook (+ A/B), copy, call to action, hashtags, alt text, first comment.
- **Brand card** and **saved visual brand**: a short interview produces a brand card the user keeps in a Claude Project (works on every device); the colors, fonts and logo are saved in the Marketing Images connector so every graphic matches.
- **Branded graphics** with the [Marketing Images connector](servers/marketing-images/README.md): AI backgrounds, finished posts with exact text, brand colors and logo, carousels and custom layouts, in every common size. Canva is an optional second route, and the user's own photos come in through Postiz's upload widget.
- **Silent brand check** before anything is shown (voice, banned words, claims to double-check) and a plain check-in report after a campaign.
- **When to post**: audience-timezone heuristics plus the Postiz calendar.
- **Scheduling in Postiz** (v2.25 or newer): images are copied into Postiz, drafts are always fine, and publishing or scheduling needs an explicit yes.

## Install

Build the zips (needs `zip` and Node.js; the skill is validated first):

```bash
bash build.sh
```

| File | Contains | Upload in Claude |
|---|---|---|
| `dist/marketing-orchestrator-plugin.zip` (recommended) | The skill, with `THIRD_PARTY_NOTICES.md` and `LICENSES/` | Customize → Plugins → Add → Upload plugin |
| `dist/marketing-orchestrator.zip` | The skill only, with its notices inside the folder | Customize → Skills → Upload |

The plugin is the skill only. Both connectors need a personal link or key (a secret), so they are **not** bundled: each user adds **Postiz** and **Marketing Images** themselves in Customize → Connectors → Add custom connector. The guided steps are in `skills/marketing-orchestrator/references/getting-started.md`, and the assistant walks the user through them. Claude Pro or higher is needed (the Free plan allows only one custom connector) and "Code execution and file creation" must be on.

For Claude Code or Codex, link the skill folder instead: `tools/install.sh claude-code codex`.

Data: the plugin stores nothing itself. Post text and images go only to the connectors the user chooses to connect (Postiz, Marketing Images, Canva). No keys or links are bundled.

## Repository layout

```
.claude-plugin/plugin.json          plugin manifest
skills/marketing-orchestrator/      the skill: SKILL.md + references/ only (this is what ships)
servers/marketing-images/           portable MCP server (Node/TS, Docker): image generation + post composer
tools/                              optional Python toolkit for developers (CLI, local MCP server, tests)
THIRD_PARTY_NOTICES.md, LICENSES/   attribution and license text for the Apache-2.0 portions (shipped in both zips)
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
- Video: Postiz clipping / Veo short clips
- More image providers behind the same `image generate` interface
- Competitor/trend research step before drafting

## License

MIT (see `LICENSE`). Portions of the skill's instructions are adapted from Anthropic's knowledge-work-plugins Marketing plugin and are under the Apache License 2.0, modified: see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).
