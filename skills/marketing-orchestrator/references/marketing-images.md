# The Marketing Images connector

**Marketing Images** is a portable connector (an MCP server) that makes finished social-media graphics: AI backgrounds, edits of the user's photos, and posts with exact text, brand colors and logo, plus carousels. It never publishes or schedules anything; Postiz does that. Tool details and what to tell the user are in `visuals.md`; custom layouts are in `design-guide.md`.

## Two ways to connect it

| | Remote | Local |
|---|---|---|
| What it is | A server run by someone else (the owner); the user adds their **personal link** | The same server, started on the user's own computer by their coding agent: `npx -y @codeame/marketing-images` |
| Works in | Claude web, Desktop, mobile, Cowork, and any coding agent | Coding agents on the user's computer |
| Keys and limits | The owner's | The user's own image-service keys, in `~/.config/marketing-images/.env` |
| Images | Public HTTPS links kept about 30 days | Files under `~/.marketing-images/` (`file_path` in the results) |

The full decision table, the step-by-step setup for coding agents and the per-agent configuration (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, VS Code Copilot, Windsurf, Cline, Goose, and bb or Orca on top of them) are in **`setup-local.md`**. If you are running in a coding agent and the tools are missing, follow it.

## For users of the Claude apps: add it with your personal link

Whoever runs the connector (the owner) hands each person a **personal link** privately. It looks like `https://<host>/mcp/<token>` and **works like a password**: the token is the key. Don't paste it in a chat, a document or a screenshot. If it leaks, ask the owner for a new one (the old one is then cancelled).

1. Open claude.ai in the browser (or the Desktop app) → **Customize → Connectors → Add custom connector**.
2. Name: `Marketing Images`. URL: the personal link. Leave any sign-in options empty: the link is the key. Click **Add**.
3. In the chat, turn **Marketing Images** on from the connectors menu (the **+** or tools button near the message box).
4. It is added once on web or Desktop and then also works in the mobile app.

Requirements: a plan that allows custom connectors (the Free plan allows only one, and the full setup uses two: Postiz and Marketing Images, so Pro or higher), and "Code execution and file creation" ON for skills.

Only users who run you inside a coding agent need the command-line or config-file routes: see `setup-local.md`. Remote links added there go into the agent's own config on the user's computer: user scope, private, never in a repository.

## Check it works

Call `list_providers`. It should list the image services that are set up (`available: true`) and what is left of today's allowance. Then say it in plain words: "Marketing Images is ready: N images and N graphics left today."

| Symptom | What to do |
|---|---|
| Tools don't appear | Turn the connector on in this chat, or start a new chat. In a coding agent: restart or reload it |
| "Not found" or invalid link | The link was mistyped or cancelled: ask the owner for a new one |
| `list_providers` shows no available service | Remote: the owner hasn't added an image service key yet. Local: no key filled in the settings file (`setup-local.md`). Meanwhile use the user's own photos |
| Daily limit reached | Limits reset at 00:00 UTC (local: the user can change `DAILY_*` in the settings file); use their own photos or try tomorrow |

## What it keeps

- **Images, remote:** public links (anyone with the link can see them) kept for about 30 days; Postiz keeps its own copy once you upload from the link (`uploadFromUrlTool`).
- **Images, local:** files in `~/.marketing-images/` on the user's computer. With `POSTIZ_URL` and `POSTIZ_API_KEY` set, the final graphics (`compose_post`, `compose_custom`, `compose_carousel`) are also uploaded to Postiz automatically and the result carries `postiz: {id, path}` (carousel: `slides[].postiz` and `postiz_paths` in order): attach that `path` directly (no `uploadFromUrlTool`). `generate_image`, `edit_image` and `get_job` do not upload unless called with `upload_to_postiz: true`. A `postiz_error` is only a warning: call `upload_to_postiz` once, else save a draft. The tool `upload_to_postiz` also uploads older images. Without them the user adds the file in Postiz → Media by hand.
- **Saved brands and templates** (colors, fonts, logos, layouts) are stored with the person's link name (remote) or on the user's computer (local); private unless saved with `shared: true`.
- **Limits** are per person per UTC day: AI images, US dollars of image cost, and composed graphics. `list_providers` shows what's left.

## For owners: running the server

The server lives in this repository: `servers/marketing-images/` (Node 22 and TypeScript). It ships three ways:

- **npm package** `@codeame/marketing-images`: `npx -y @codeame/marketing-images` runs it for one person on their computer (stdio, no token). Add `--http` to run it as a server for several people.
- **Docker image** `ghcr.io/nievesjesus/marketing-images` (HTTP mode), for a Coolify or any container deployment.

Its README, `servers/marketing-images/README.md`, covers everything: the environment variables (access tokens, the image-service keys, `PUBLIC_BASE_URL`, daily limits, retention), the Docker image and a Coolify deployment, and how to revoke a person (remove their entry and restart). It is not repeated here so there is one source of truth.

In short for the people you invite: create one token per person, build their link as `https://<your-host>/mcp/<token>`, and hand it over privately (not by email to a shared inbox, not in a group chat).
