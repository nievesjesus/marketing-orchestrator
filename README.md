# Marketing Orchestrator

A marketing assistant for people with no technical background, packaged as a Claude plugin and a portable [Agent Skill](https://agentskills.io). Tell Claude what you want to promote and it plans the posts, writes them in your brand's voice for each social network, helps you get the images, suggests when to publish and, only after you say yes, schedules everything in [Postiz](https://postiz.com).

Works in **Claude (web, Desktop, mobile, Cowork)** and in coding agents such as **Claude Code, Codex, Cursor, OpenCode, Gemini CLI and VS Code Copilot**, and in any client that reads `SKILL.md`. The assistant always replies in the user's language; the skill files themselves are in English.

## What it does

- **Campaigns and single posts:** pick a goal, an audience and a message, and the assistant builds a short campaign (launch, event, weekly series, seasonal promo, re-engagement) with a calendar, or one post, with a short card to approve first. Approving a plan never schedules anything.
- **Post packages** per network: goal, audience, hook (+ A/B), copy, call to action, hashtags, alt text, first comment.
- **Brand card** and **saved visual brand**: a short interview produces a brand card the user keeps in a Claude Project (works on every device); the colors, fonts and logo are saved in the Marketing Images connector so every graphic matches.
- **Branded graphics** with the [Marketing Images connector](servers/marketing-images/README.md): AI backgrounds, finished posts with exact text, brand colors and logo, carousels and custom layouts, in every common size. Canva is an optional second route, and the user's own photos come in through Postiz's upload widget.
- **Silent brand check** before anything is shown (voice, banned words, claims to double-check) and a plain check-in report after a campaign.
- **When to post**: audience-timezone heuristics plus the Postiz calendar.
- **Scheduling in Postiz** (v2.25 or newer): images are copied into Postiz, drafts are always fine, and publishing or scheduling needs an explicit yes.

## Install

Pick the route that matches where you use the assistant, then connect the image server (last part).

### Claude apps (web, Desktop, Cowork)

1. Download `marketing-orchestrator-plugin.zip` from the [Releases](https://github.com/nievesjesus/marketing-orchestrator/releases) page.
2. In Claude: **Customize → Plugins → Add → Upload plugin**, pick the zip.

| File | Contains | Upload in Claude |
|---|---|---|
| `marketing-orchestrator-plugin.zip` (recommended) | The skill, with `THIRD_PARTY_NOTICES.md` and `LICENSES/` | Customize → Plugins → Add → Upload plugin |
| `marketing-orchestrator.zip` | The skill only, with its notices inside the folder | Customize → Skills → Upload |

Or, if your app offers it, add the marketplace `nievesjesus/marketing-orchestrator` from the Plugins screen. Claude Pro or higher is needed (the Free plan allows only one custom connector) and "Code execution and file creation" must be on.

### Claude Code

```
/plugin marketplace add nievesjesus/marketing-orchestrator
/plugin install marketing-orchestrator@codeame
```

On Claude Code 2.1.275 or later, one step also works: `/plugin install marketing-orchestrator --marketplace nievesjesus/marketing-orchestrator`.

Or install the skill alone with the universal command below (`-a claude-code`), or copy `skills/marketing-orchestrator/` to `~/.claude/skills/` (all projects) or `.claude/skills/` (one project).

### Other agents (Codex, OpenCode, Cursor, Gemini CLI, VS Code Copilot, Cline, Goose, Windsurf)

```bash
npx skills add nievesjesus/marketing-orchestrator --skill marketing-orchestrator -g -a <agent>
```

Agent ids: `codex`, `opencode`, `cursor`, `gemini-cli`, `github-copilot`, `cline`, `goose`, `windsurf`. Gemini CLI also has its own: `gemini skills install https://github.com/nievesjesus/marketing-orchestrator --path skills/marketing-orchestrator --scope user`. The skill folder for each agent (so you can copy it by hand) is listed in [`setup-local.md`](skills/marketing-orchestrator/references/setup-local.md). Tools like bb or Orca run these agents underneath: install for the agent they use.

### Connect the image server: remote link or local

The plugin is the skill only. The connectors need a secret (a personal link or keys), so they are **not** bundled: each user adds them. There are two ways to get the Marketing Images tools:

- **Remote:** whoever runs the server hands you a personal link; add it as a connector (Claude apps: Customize → Connectors → Add custom connector) or in your agent's MCP settings. Works everywhere, including Claude on the web, Desktop and mobile.
- **Local** (coding agents on your computer): run the server yourself with your own image-service keys. Needs Node.js 22 or newer:

  ```bash
  npx -y @codeame/marketing-images
  ```

  The agent starts it for you once it is registered as an MCP server. Keys live in `~/.config/marketing-images/.env` (mode 600), images are saved under `~/.marketing-images/`, and with `POSTIZ_URL` plus `POSTIZ_API_KEY` set, the final graphics (`compose_*`) are also uploaded to Postiz.

The assistant itself walks you through either route, step by step: the decision table, the exact configuration for each agent and troubleshooting are in [`setup-local.md`](skills/marketing-orchestrator/references/setup-local.md); the first-time guide for non-technical users is [`getting-started.md`](skills/marketing-orchestrator/references/getting-started.md). Postiz (scheduling) is added the same way, see [`postiz-mcp.md`](skills/marketing-orchestrator/references/postiz-mcp.md). To host the server for other people, see [`servers/marketing-images/README.md`](servers/marketing-images/README.md) (npm package `@codeame/marketing-images` with `--http`, or the Docker image `ghcr.io/nievesjesus/marketing-images`).

### Build the zips yourself

Needs `zip` and Node.js; the skill and both manifests are validated first:

```bash
bash build.sh
```

The zips land in `dist/`; maintainers attach them to each GitHub Release. Claude Code and Codex users working from a clone can also link the skill folder: `tools/install.sh claude-code codex`.

Data: the plugin stores nothing itself. Post text and images go only to the connectors the user chooses to connect (Postiz, Marketing Images, Canva). No keys or links are bundled.

## Repository layout

```
.claude-plugin/plugin.json          plugin manifest
.claude-plugin/marketplace.json     marketplace listing (`/plugin marketplace add nievesjesus/marketing-orchestrator`); not in the zips
skills/marketing-orchestrator/      the skill: SKILL.md + references/ only (this is what ships)
servers/marketing-images/           portable MCP server (Node/TS; npm `@codeame/marketing-images`, Docker): image generation + post composer
tools/                              optional Python toolkit for developers (CLI, local MCP server, tests)
THIRD_PARTY_NOTICES.md, LICENSES/   attribution and license text for the Apache-2.0 portions (shipped in both zips)
build.sh                            validates the skill and the manifests, builds both zips into dist/
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
