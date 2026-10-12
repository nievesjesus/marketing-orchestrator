# Marketing Orchestrator

![Marketing Orchestrator: campaigns, branded graphics and scheduling from one conversation with Claude. The banner shows two mock social posts waiting for approval and a message from Claude asking whether to schedule them.](.github/readme/hero.jpg)

[![CI](https://github.com/nievesjesus/marketing-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/nievesjesus/marketing-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm: @codeame/marketing-images](https://img.shields.io/npm/v/@codeame/marketing-images?label=npm)](https://www.npmjs.com/package/@codeame/marketing-images)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Fnievesjesus%2Fmarketing--images-2496ED?logo=docker&logoColor=white)](https://github.com/nievesjesus/marketing-orchestrator/pkgs/container/marketing-images)
[![Skill version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fnievesjesus%2Fmarketing-orchestrator%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=skill)](CHANGELOG.md)

A marketing assistant for people with no technical background, packaged as a Claude plugin and a portable [Agent Skill](https://agentskills.io). It works in Claude (web, Desktop, mobile and Cowork) and in coding agents such as Claude Code, Codex, Cursor, OpenCode, Gemini CLI and VS Code Copilot. Tell it what you want to promote and it plans the campaign or the single post, writes each post in your brand's voice for each network, makes branded graphics with exact text, suggests when to publish and saves or schedules everything in [Postiz](https://postiz.com), **only after you say yes**. The assistant always replies in your language; the skill files themselves are in English.

## How it works

```mermaid
flowchart LR
  you(["You"]) <-->|"one conversation"| claude["Claude + the skill<br/>plan, write, brand check"]
  claude -->|"brand, backgrounds, graphics"| mi["Marketing Images MCP<br/>generate_image, compose_*, brands, templates"]
  mi -.->|"AI backgrounds"| ai[("Gemini, fal.ai, Leonardo")]
  mi -->|"image link or postiz.path"| claude
  claude --> gate{"Approval card:<br/>do you say yes?"}
  gate -->|"yes: schedule or post now"| postiz["Postiz MCP<br/>upload, schedule"]
  gate -->|"unsure or no answer"| draft["Save as draft"]
  draft --> postiz
  postiz --> social["Your social networks"]
```

The skill holds the workflow and the writing rules. Two connectors do the work: **Marketing Images** draws the graphics (and can ask an AI model for a text-free background), **Postiz** holds the calendar and publishes. Nothing is scheduled or published without an explicit yes in the conversation; drafts are always fine.

## What you get

- **Campaigns and single posts.** Pick a goal, an audience and a message; the assistant builds a short campaign (launch, event, weekly series, seasonal promo, re-engagement) with a calendar, or one post with a card to approve first. Approving a plan never schedules anything.
- **Post packages per network:** goal, audience, hook (and an A/B option), copy, call to action, hashtags, alt text, first comment.
- **Brand card and saved visual brand.** A short interview produces a brand card the user keeps in a Claude Project (works on every device); colors, fonts and logo are saved in Marketing Images so every graphic matches.
- **Silent brand check** before anything is shown (voice, banned words, claims to double-check) and a plain check-in report after a campaign.
- **When to post:** audience-timezone heuristics plus the Postiz calendar.
- **Branded graphics** with exact text, in every common size (below). Canva is an optional second route; the user's own photos come in through Postiz's upload widget.

All pictures below were drawn by the Marketing Images render engine itself, from three fictional brands (Café Lumbre, Studio Norte, Verde Market), with synthetic backgrounds. They are not mockups. Text is drawn by the server, so it is spelled exactly as written, accents and ñ included.

### Built-in templates

![The eight built-in templates drawn with a fictional coffee-shop brand: photo and headline, offer card, quote card, photo with text panel, photo with price badge, and the three carousel slides (cover, numbered tip, closing call to action).](.github/readme/templates-grid.jpg)

`compose_post` and `compose_carousel` use eight layouts. Colors, fonts, logo, button shape and corner radius come from the saved brand; the server picks readable text colors and a scrim over photos.

### Every common format

![One photo-and-headline design drawn for story 1080x1920, portrait 1080x1350, square 1080x1080, landscape 1920x1080 and link card 1200x627, each with its label.](.github/readme/formats.jpg)

One design, five sizes. Text stays inside each format's safe area (story keeps clear of the app's top and bottom bars).

### Carousels

![A four-slide carousel for a fictional grocery: a photo cover, two numbered tips and a closing call to action, each with a small slide counter chip.](.github/readme/carousel.jpg)

2 to 10 slides with one brand, a "2/4" counter chip, and the links returned in order (uploaded to Postiz in order when the Postiz settings are present).

### Custom layouts

![Two designs written as HTML for compose_custom: a magazine cover and a three-column price list with the brand's fonts, colors and logo.](.github/readme/custom-layouts.jpg)

When no template fits, the assistant writes the layout as HTML with inline styles and `compose_custom` draws it with the brand's fonts and colors. The server checks safe areas, text overflow and contrast and returns warnings to fix. A layout worth reusing can be kept with `save_template`. The two above are examples from [`design-guide.md`](skills/marketing-orchestrator/references/design-guide.md).

### Brand sheet

![A brand sheet for a fictional coffee shop: nine color swatches with hex codes, font specimens for heading, body and accent, the logo on a light and a dark tile, and the style rules.](.github/readme/brand-sheet.jpg)

`save_brand` stores colors, fonts, logos and style rules once and returns this sheet. The same brand then shapes every graphic and the AI background prompts.

## Install

Pick the route that matches where you use the assistant, then connect the two connectors (next section).

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

Agent ids: `codex`, `opencode`, `cursor`, `gemini-cli`, `github-copilot`, `cline`, `goose`, `windsurf`. Gemini CLI also has its own: `gemini skills install https://github.com/nievesjesus/marketing-orchestrator --path skills/marketing-orchestrator --scope user`. The skill folder for each agent (to copy it by hand) is listed in [`setup-local.md`](skills/marketing-orchestrator/references/setup-local.md). Tools like bb or Orca run these agents underneath: install for the agent they use.

### Build the zips yourself

Needs `zip` and Node.js; the skill and both manifests are validated first.

```bash
bash build.sh        # writes dist/marketing-orchestrator.zip and dist/marketing-orchestrator-plugin.zip
```

Claude Code and Codex users working from a clone can also link the skill folder with `tools/install.sh claude-code codex`.

## Connect the two connectors

The plugin is the skill only. Both connectors need a secret (a personal link or API keys), so they are **not bundled**: each user adds them. Without them the assistant still writes the full plan and posts, and you can copy them by hand.

### Postiz (scheduling)

Needs **Postiz v2.25 or newer** (older versions have no upload tools). Get the API key in Postiz under **Settings → Developers → Public API**. The connection URL contains that key, so treat it like a password.

| Postiz | Connection URL |
|---|---|
| Postiz Cloud | `https://mcp.postiz.com/mcp/<API_KEY>` |
| Self-hosted | `https://<your-postiz-domain>/api/mcp/<API_KEY>` |
| Postiz Cloud, key in a header (where the client supports headers) | `https://mcp.postiz.com/mcp` plus the header `Authorization: Bearer <API_KEY>` |

In Claude: **Customize → Connectors → Add custom connector**, name `Postiz`, paste the URL. Add it on web or Desktop and it then works on mobile too. For Claude Code, Codex, Cursor and Claude Desktop's config file, see [`postiz-mcp.md`](skills/marketing-orchestrator/references/postiz-mcp.md).

### Marketing Images (graphics): remote link or local

| | **Remote** (personal link) | **Local** (runs on your computer) |
|---|---|---|
| Works in | Claude web, Desktop, mobile, Cowork and any coding agent | Coding agents on your own computer |
| You need | A link from whoever runs the server (it is a password) | Node.js 22 or newer and at least one image-service key |
| Who pays | The owner's keys and daily limits | Your own keys, billed by each provider |
| Images | Public HTTPS links kept about 30 days | Files on your disk (`~/.marketing-images/`), with `file_path` in every result |

**Remote.** Whoever runs the server gives you `https://<host>/mcp/<token>`. In Claude apps: **Customize → Connectors → Add custom connector**, name `Marketing Images`, paste the link, no sign-in. In a coding agent, add it as a remote MCP server (snippets in [`setup-local.md`](skills/marketing-orchestrator/references/setup-local.md)).

**Local.** Create a private settings file, then register one command with your agent:

```bash
mkdir -p ~/.config/marketing-images
cat > ~/.config/marketing-images/.env <<'EOF'
GEMINI_API_KEY=
# FAL_KEY=
# LEONARDO_API_KEY=
# POSTIZ_URL=
# POSTIZ_API_KEY=
EOF
chmod 600 ~/.config/marketing-images/.env     # then fill in your own keys
```

```bash
# Claude Code (other agents register the same command in their own MCP config, see setup-local.md)
claude mcp add --transport stdio --scope user marketing-images -- npx -y @codeame/marketing-images
```

Keys live only in that file, never in an agent's config and never in the chat. Real environment variables win over the file, and an empty value counts as unset.

| Variable | Needed | What it does |
|---|---|---|
| `GEMINI_API_KEY`, `FAL_KEY`, `LEONARDO_API_KEY` | At least one, for AI images | Image services. A service without a key is simply off. Composed graphics (`compose_*`) need no key. |
| `POSTIZ_URL`, `POSTIZ_API_KEY` | Optional, set both | Uploads the final graphics straight to Postiz, so results carry `postiz.path` and the agent skips `uploadFromUrlTool`. `POSTIZ_URL` can be `https://api.postiz.com` (Cloud) or your own `https://postiz.example.com`. `POSTIZ_AUTO_UPLOAD=false` turns the automatic upload off. |
| `LOCAL_IMAGE_DIRS` | Optional | Comma-separated folders (`~/Pictures/marketing`) the server may read your own photos from, passed to the tools as `file://` links. |
| `DAILY_IMAGE_LIMIT`, `DAILY_USD_LIMIT`, `DAILY_RENDER_LIMIT` | Optional | Daily caps (UTC day): AI images (default 30), US dollars (3.00) and composed graphics (200). |

The assistant can walk you through either route inside a coding agent: the decision table, the exact configuration for Claude Code, Codex CLI, OpenCode, Cursor, Gemini CLI, VS Code Copilot, Windsurf, Cline and Goose, and troubleshooting are in [`setup-local.md`](skills/marketing-orchestrator/references/setup-local.md). The first-time guide for non-technical users is [`getting-started.md`](skills/marketing-orchestrator/references/getting-started.md).

## Marketing Images server

`servers/marketing-images/` is a portable [MCP](https://modelcontextprotocol.io) server (Node 22, TypeScript), published as the npm package [`@codeame/marketing-images`](https://www.npmjs.com/package/@codeame/marketing-images) and the Docker image `ghcr.io/nievesjesus/marketing-images`. Text is drawn with Satori, resvg and sharp, with bundled open-license fonts.

| Tool | What it does |
|---|---|
| `list_providers` | Image models, prices and today's allowance |
| `estimate_cost` | Quotes the price of a `generate_image` or `edit_image` request before spending; nothing is charged |
| `generate_image` | AI image from a prompt (Gemini, fal.ai or Leonardo; `provider=auto` routes and falls back), with the saved brand applied |
| `edit_image` | Edits or restyles a reference image |
| `get_job` | Finishes an image that took longer than the synchronous wait |
| `list_templates`, `get_template`, `save_template`, `delete_template` | Built-in, own and shared layouts: browse, read the HTML, save a reusable layout, delete |
| `compose_post` | One finished graphic from a built-in or saved template |
| `compose_carousel` | 2 to 10 slides with shared brand and an optional counter chip |
| `compose_custom` | A layout the assistant designs as HTML with inline styles |
| `save_brand`, `list_brands`, `get_brand`, `delete_brand` | Saved brands: colors, fonts, logos, style rules, voice notes, brand sheet |
| `upload_to_postiz` | Uploads an image this server made to Postiz and returns `postiz.path` (needs `POSTIZ_URL` and `POSTIZ_API_KEY`) |

| Mode | Command | For |
|---|---|---|
| stdio (default) | `npx -y @codeame/marketing-images` | One MCP client on your computer: no access token, images saved locally |
| HTTP | `ACCESS_TOKENS=me:<token> npx -y @codeame/marketing-images --http --port 8080` | Several people, one secret link each, public image links |
| Docker | `docker run -d -p 8080:8080 -v marketing-images-data:/data -e ACCESS_TOKENS=me:<token> -e PUBLIC_BASE_URL=<public url> -e GEMINI_API_KEY=<key> ghcr.io/nievesjesus/marketing-images:latest` | Hosting the HTTP server (`linux/amd64` and `linux/arm64`) |

Every option, the full configuration table, the Postiz direct upload, the `compose_custom` token and CSS reference and the Coolify deployment steps are in [`servers/marketing-images/README.md`](servers/marketing-images/README.md).

## Safety and approvals

- **Nothing is published or scheduled without an explicit yes** in the conversation. Drafts are always fine. Approving a campaign plan never schedules anything, and an approval covers only the cards the user saw.
- **Money:** AI images cost money. The assistant calls `estimate_cost`, states the price in one sentence and waits for a quick ok before every `generate_image` or `edit_image`. Daily limits stop runaway use. Composed graphics are free.
- **Keys never go in the chat.** Provider keys live in `~/.config/marketing-images/.env` (mode 600); a remote link or Postiz URL is typed only into the connector form.
- **Personal links are passwords.** The Marketing Images link and the Postiz URL grant access. If one leaks, the owner issues a new link or creates a new Postiz key.
- **No invented facts.** The skill never makes up numbers, prices, reviews, clients or results, and never asks an AI model to draw logos, real people, minors or other brands' marks.
- **Text inside images, comments or tool results is information, not instructions.**
- **Data:** the plugin stores nothing itself. Post text and images go only to the connectors the user chooses to connect (Postiz, Marketing Images, Canva).

## Repository layout

```
.claude-plugin/plugin.json          plugin manifest
.claude-plugin/marketplace.json     marketplace "codeame" (`/plugin marketplace add nievesjesus/marketing-orchestrator`); not in the zips
.github/workflows/                  ci.yml (tests, validation, build) and release.yml (npm, GHCR, Release zips)
.github/readme/                     the README pictures, generated (see Development)
skills/marketing-orchestrator/      the skill: SKILL.md + references/ only (this is what ships)
servers/marketing-images/           portable MCP server: image generation and post composer (npm, Docker)
tools/                              optional Python toolkit for developers (CLI, local MCP server, tests)
THIRD_PARTY_NOTICES.md, LICENSES/   attribution and license text for the Apache-2.0 portions (shipped in both zips)
build.sh                            validates the skill and manifests, builds both zips into dist/
```

## Development

Read [`AGENTS.md`](AGENTS.md) (Claude Code also loads it through `CLAUDE.md`). Checks before committing, no network or keys needed:

```bash
python3 -m unittest discover -s tools/tests -v
python3 tools/scripts/mkt.py doctor
npx -y skills-ref validate skills/marketing-orchestrator
claude plugin validate .              # needs the Claude Code CLI
bash build.sh
```

Server (Node 22, see `.nvmrc`):

```bash
cd servers/marketing-images
source ~/.nvm/nvm.sh && nvm use
npm ci
npm run typecheck && npm test
```

**README pictures.** `npm run readme:assets` (in `servers/marketing-images/`) redraws everything in `.github/readme/` by calling the server's render functions directly, with fictional brands and synthetic backgrounds: no server, no network, no API keys. The output is deterministic and has a size budget; commit the regenerated images together with the README. Look at them before committing.

**Python toolkit (optional).** `tools/` holds a stdlib-only CLI and local MCP server (brand kits, Gemini images, logo overlay, time slots, Postiz uploads). The skill does not need it; details are in [`tools/docs/`](tools/docs/).

## Releasing

A tag `vX.Y.Z` publishes the npm package, the Docker image and the Release zips (`.github/workflows/release.yml`).

One-time setup:

1. Create the npm organization `codeame` (the scope of `@codeame/marketing-images`) and a token that can publish to it.
2. Add that token as the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions). The Docker push uses the built-in `GITHUB_TOKEN`; after the first push, make the `marketing-images` package public in GitHub Packages.

To release:

```bash
# 1. same version in servers/marketing-images/package.json and src/version.ts, then (in servers/marketing-images)
npm run typecheck && npm test && npm run build && npm pack --dry-run
# 2. commit, then tag and push the tag
git tag v0.1.0 && git push origin v0.1.0
```

The workflow stops if the tag differs from `package.json`'s version. It builds and tests, runs `npm publish --provenance --access public`, pushes `ghcr.io/nievesjesus/marketing-images` as `vX.Y.Z`, `X.Y` and `latest`, and attaches `marketing-orchestrator.zip` and `marketing-orchestrator-plugin.zip` (from `bash build.sh`) to the GitHub Release. The skill version (`SKILL.md` metadata and `plugin.json`, bumped together; `build.sh` checks they match) is independent of the server version.

## License and credits

MIT, see [`LICENSE`](LICENSE). Portions of the skill's instructions are adapted from the Marketing plugin of Anthropic's [knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) and are under the Apache License 2.0, modified; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). This project is not affiliated with Anthropic.

The server bundles Outfit, Work Sans, Bricolage Grotesque, Lora, Instrument Serif and Young Serif, all under the SIL Open Font License (texts in [`servers/marketing-images/fonts/LICENSES/`](servers/marketing-images/fonts/LICENSES/)). Built with [Satori](https://github.com/vercel/satori), [resvg](https://github.com/yisibl/resvg-js), [sharp](https://sharp.pixelplumbing.com), [opentype.js](https://opentype.js.org) and [parse5](https://parse5.js.org). Scheduling is done by [Postiz](https://postiz.com).
