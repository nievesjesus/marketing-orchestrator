# Marketing Orchestrator

A personal marketing assistant packaged as a portable [Agent Skill](https://agentskills.io): drop images (or ask for one), get on-brand, platform-tailored posts — copy, hashtags, target audience, alt text, best time to publish — and schedule them in [Postiz](https://postiz.com) after you approve.

Works in **Claude Code, Claude Desktop / claude.ai, Codex, Cursor** and any client that reads `SKILL.md` or speaks MCP.

## What it does

- **Post packages** per platform: objective, audience, hook (+ A/B), copy, CTA, hashtags, alt text, first comment.
- **Brand kits**: voice, audiences, pillars, palette, fonts, logos, style references, and lessons learned from your edits.
- **Image generation & editing** with Gemini (Nano Banana), brand style injected automatically.
- **Image tools**: stamp your real logo (auto light/dark), crop/pad to the right ratio, platform-fit check.
- **When to post**: audience-timezone heuristics + Postiz free slots + calendar collisions.
- **Postiz**: upload local media, build payloads, create drafts; publishing requires explicit approval.

## Quick start

```bash
git clone <this repo> && cd marketing-orchestrator
mkdir -p ~/.config/marketing-orchestrator && cp .env.example ~/.config/marketing-orchestrator/.env
chmod 600 ~/.config/marketing-orchestrator/.env   # then fill POSTIZ_API_KEY and GEMINI_API_KEY
pip install pillow                                # optional, for logo/crop tools

./install.sh claude-code codex zip mcp-config     # pick the clients you use
python3 skills/marketing-orchestrator/scripts/mkt.py doctor
```

Then, in any client: *"Here are 2 images for LinkedIn, brand example-coffee-shop. Build the post and tell me when to publish."*

Details per client (Claude Desktop zip upload, MCP config for Desktop/Codex/Cursor, official Postiz MCP): [`references/setup.md`](skills/marketing-orchestrator/references/setup.md).

## How it fits together

```
           ┌──────────── any agent client ─────────────┐
           │  SKILL.md (workflow, rules, approval card)│
           └───────┬───────────────────────┬───────────┘
        shell?     │                       │  MCP?
   scripts/mkt.py ─┤                       ├─ scripts/mcp_server.py
                   └────── scripts/mktlib ─┘
                 brand · gemini · imaging · timeslots · package · postiz
                         │                         │
                   Gemini API                 Postiz API
```

- **Instructions** (`SKILL.md` + `references/`) are plain Markdown and run anywhere.
- **Actions** run through the CLI (when the agent has a shell with network) or the local MCP server (when it doesn't — e.g. Claude Desktop chat), both on the same library.

## Brand kits

`python3 skills/marketing-orchestrator/scripts/mkt.py brand init acme` creates `~/.config/marketing-orchestrator/brands/acme/` from the template. Fill `brand.json`, `voice.md`, add `logo*.png` and `style/` images, then `brand validate acme`. See [`references/branding.md`](skills/marketing-orchestrator/references/branding.md).

Private kits stay outside the repo. For Claude Desktop/claude.ai, `./install.sh zip --with-brands` bundles them into the upload.

## Developing

Read [`AGENTS.md`](AGENTS.md) (also loaded by Claude Code via `CLAUDE.md`). Tests: `python3 -m unittest discover -s tests -v` — no network, no keys needed.

## Roadmap ideas

- Weekly content calendar from pillars + cadence, filled into Postiz as drafts
- Analytics loop: pull post stats, update `learned` and best-time windows per brand
- Carousel builder (multi-slide images with consistent style and text)
- Video: Postiz clipping / Veo short clips
- More image providers behind the same `image generate` interface
- Competitor/trend research step before drafting

## License

MIT
