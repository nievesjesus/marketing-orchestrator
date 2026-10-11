# Connecting the Postiz MCP

For a non-technical user, use the guided walkthrough in `getting-started.md` (step B). This page has the details for every app, the tool map, and the differences between Postiz versions.

Postiz runs an MCP server (hosted on Postiz Cloud, built into self-hosted installs). Once connected, the assistant can list channels, read the calendar, upload images, and create drafts or scheduled posts. Docs: https://docs.postiz.com/mcp/setup

**Postiz version:** the tool set below needs **Postiz v2.25 or newer**. Older versions have no upload tools (`uploadFromUrlTool`, `uploadWidgetTool`, `uploadWidgetStatusTool`), so generated images can't be attached automatically.

## 1. Get the API key

Postiz → **Settings → Developers → Public API** → copy the key.

The connection URL contains the key. **Treat the URL like a password**: don't paste it into posts, chats, screenshots or shared files. If it leaks, create a new key in Postiz; the old URL stops working.

## 2. Pick the URL

| Postiz | URL |
|---|---|
| Postiz Cloud (key in the path) | `https://mcp.postiz.com/mcp/<API_KEY>` |
| Self-hosted (key in the path) | `https://<your-postiz-domain>/api/mcp/<API_KEY>` |
| Postiz Cloud (key in a header) | `https://mcp.postiz.com/mcp` plus the header `Authorization: Bearer <API_KEY>` |

Use the header form on Cloud wherever the client supports headers, so the key isn't part of a URL. Claude's custom connector form has no header field: use the key-in-path URL there.

## 3. Add it to your app

**Claude (web, Desktop, mobile: synced to your account)**
Customize → Connectors → *Add custom connector* → name `Postiz`, URL = the key-in-path URL for your Postiz (Cloud or self-hosted). Then turn it on in each chat from the connectors menu. Add it on web or Desktop; it then works on mobile too. If Postiz also appears in Claude's connector directory, note that the directory entry may leave out the media-generation and clipping tools: the custom URL has them all.

**Claude Code**
```bash
# Cloud, key in a header
claude mcp add --transport http postiz https://mcp.postiz.com/mcp --header "Authorization: Bearer $POSTIZ_API_KEY"
# Self-hosted, key in the path
claude mcp add --transport http postiz https://<your-postiz-domain>/api/mcp/<API_KEY>
```

**Codex**: `~/.codex/config.toml` (on Cloud the key comes from the environment and never sits in the file):
```toml
[mcp_servers.postiz]
url = "https://mcp.postiz.com/mcp"
bearer_token_env_var = "POSTIZ_API_KEY"
```
Self-hosted: `url = "https://<your-postiz-domain>/api/mcp/<API_KEY>"` (the key is then in the file: keep it private).

**Cursor**: Settings → MCP → Add server: name `Postiz`, type `HTTP`, URL = the key-in-path URL.

**Claude Desktop (local config file, as an alternative to the account connector)**: `claude_desktop_config.json`:
```json
{ "mcpServers": { "postiz": { "url": "https://mcp.postiz.com/mcp/<API_KEY>" } } }
```

## 4. Verify

Ask: *"List my connected social media accounts."* The assistant should call `integrationList` and return the channels. Then check that `uploadFromUrlTool` is among the tools.

| Symptom | Fix |
|---|---|
| Tools don't appear | Turn the connector on in this chat, or restart the app |
| 401 / unauthorized | The key is wrong or was replaced: update the URL or environment variable |
| Empty channel list | No channels connected in Postiz yet: add them in the Postiz app first |
| No upload tools | Postiz is older than v2.25: ask whoever runs it to update, or add images by hand in Postiz → Media |
| Rate-limit errors | Postiz limits requests per hour (its docs mention between 30 and 100): wait, don't retry in a loop, and work in batches |

## 5. How the skill uses it

| Step | Postiz MCP tool |
|---|---|
| Channels | `integrationList` (and `groupList` for client groups) |
| Platform rules and required settings | `integrationSchema` (`platform`, `isPremium`) |
| Lookups (LinkedIn pages, Discord channels, subreddits…) | `triggerTool` |
| Calendar and collisions | `postsListTool` (`startDate`, `endDate`) |
| The user's own photos | `uploadWidgetTool` (shows an upload widget in the chat) → `uploadWidgetStatusTool` (returns `{id, path}`; "processing" means wait about 10 seconds) |
| Images from a public link (Marketing Images, a Canva export) | `uploadFromUrlTool` → `{id, path}` |
| Create a draft, schedule, or publish | `integrationSchedulePostTool`: older versions and Postiz Cloud docs call it `schedulePostTool`; use whichever your tool list has. Fields: channel, date (UTC), `type` (`draft`, `schedule`, `now`), HTML content, attachments |
| Change the settings of a scheduled post | `postSettingsTool` |
| AI image made by Postiz (credits of their plan) | `generateImageTool`; Postiz also has video tools and `ask_postiz` for questions about Postiz itself |

**Images:** Postiz rejects attachments that aren't hosted in its own upload domain. Anything that comes from elsewhere (Marketing Images links, Canva exports) must go through `uploadFromUrlTool` first, and the returned `path` (with its `id`) is what you attach. Photos uploaded with `uploadWidgetTool` are already there. On an older Postiz without upload tools, if a media list tool such as `mediaListTool` exists use its `path`; otherwise save a draft and ask the user to attach the image inside Postiz.

**Content:** simple HTML, one `<p>` per line. Allowed tags: `h1`, `h2`, `h3`, `strong`, `u`, `ul`, `li`, `p`; never nest `u` and `strong` together. Extra items on LinkedIn and Facebook become comments (use that for the first comment).

**Not available through the tools:** deleting posts (tell the user to delete them in Postiz) and analytics (use the numbers the user reads in Postiz → Analytics; see `reports.md`).
