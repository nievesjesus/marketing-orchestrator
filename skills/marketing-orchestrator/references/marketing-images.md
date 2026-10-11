# The Marketing Images connector

**Marketing Images** is a portable connector (an MCP server) that makes finished social-media graphics: AI backgrounds, edits of the user's photos, and posts with exact text, brand colors and logo, plus carousels. It never publishes or schedules anything; Postiz does that. Tool details and what to tell the user are in `visuals.md`; custom layouts are in `design-guide.md`.

## For users: add it with your personal link

Whoever runs the connector (the owner) hands each person a **personal link** privately. It looks like `https://<host>/mcp/<token>` and **works like a password**: the token is the key. Don't paste it in a chat, a document or a screenshot. If it leaks, ask the owner for a new one (the old one is then cancelled).

### Claude (web, Desktop, then mobile)

1. Open claude.ai in the browser (or the Desktop app) → **Customize → Connectors → Add custom connector**.
2. Name: `Marketing Images`. URL: the personal link. Leave any sign-in options empty: the link is the key. Click **Add**.
3. In the chat, turn **Marketing Images** on from the connectors menu (the **+** or tools button near the message box).
4. It is added once on web or Desktop and then also works in the mobile app.

Requirements: a plan that allows custom connectors (the Free plan allows only one, and the full setup uses two: Postiz and Marketing Images, so Pro or higher), and "Code execution and file creation" ON for skills.

### Developer tools (only for users who say they use them)

| Tool | How |
|---|---|
| **Claude Code** | `claude mcp add --transport http marketing-images <your-personal-link>` |
| **Codex** | `codex mcp add marketing-images --url <your-personal-link>`, or in `~/.codex/config.toml`: `[mcp_servers.marketing-images]` with `url = "<your-personal-link>"` |
| **Cursor** | Settings → MCP → Add server: name `Marketing Images`, type HTTP, URL = the link (or `{ "mcpServers": { "marketing-images": { "url": "<your-personal-link>" } } }` in `~/.cursor/mcp.json`) |

These put the link in a local settings file: keep that file private and out of any repository.

### Check it works

Call `list_providers`. It should list the image services that are set up (`available: true`) and what is left of today's allowance. Then say it in plain words: "Marketing Images is ready: N images and N graphics left today."

| Symptom | What to do |
|---|---|
| Tools don't appear | Turn the connector on in this chat, or start a new chat |
| "Not found" or invalid link | The link was mistyped or cancelled: ask the owner for a new one |
| `list_providers` shows no available service | The owner hasn't added an image service key yet: use their own photos meanwhile |
| Daily limit reached | Limits reset at 00:00 UTC; use their own photos or try tomorrow |

## What it keeps

- **Images** it makes are public links (anyone with the link can see them) kept for about 30 days; Postiz keeps its own copy once you upload from the link (`uploadFromUrlTool`).
- **Saved brands and templates** (colors, fonts, logos, layouts) are stored under the person's link name; private unless saved with `shared: true`.
- **Limits** are per person per UTC day: AI images, US dollars of image cost, and composed graphics. `list_providers` shows what's left.

## For owners: deploying the server

The server lives in this repository: `servers/marketing-images/` (Node 22 and TypeScript, one Docker image). Its README, `servers/marketing-images/README.md`, covers everything: running locally, the environment variables (access tokens, the image-service keys, `PUBLIC_BASE_URL`, daily limits, retention), the Docker image and a Coolify deployment, and how to revoke a person (remove their entry and restart). It is not repeated here so there is one source of truth.

In short for the people you invite: create one token per person, build their link as `https://<your-host>/mcp/<token>`, and hand it over privately (not by email to a shared inbox, not in a group chat).
