# Installing the Postiz MCP

Postiz runs a hosted MCP server. Once it's connected, the agent can list channels, read the calendar, schedule posts and use the media library without the CLI or a local API key. Docs: https://docs.postiz.com/mcp/setup

## 1. Get your API key

Postiz → **Settings → Developers → Public API** → copy the key.

The connection URL below contains the key. **Treat that URL like a password**: don't paste it into posts, screenshots or shared files. If it leaks, regenerate the key in Postiz; the old URL then stops working.

## 2. Pick the URL

| Postiz | URL |
|---|---|
| Cloud (key in path) | `https://mcp.postiz.com/mcp/<API_KEY>` |
| Cloud (key in header) | `https://mcp.postiz.com/mcp` + header `Authorization: Bearer <API_KEY>` |
| Self-hosted | `https://<your-postiz-domain>/mcp/<API_KEY>` |

Use the key-in-header form wherever the client supports headers, so the key isn't part of a URL.

## 3. Add it to your client

**Claude (web, Desktop, mobile — synced to your account)**
Settings → Connectors → *Add custom connector* → name `Postiz`, URL `https://mcp.postiz.com/mcp/<API_KEY>`. Custom connectors don't take headers, so use the key-in-path URL. After you add it, turn it on in each chat from the connectors menu.
Note: the Postiz connector in Claude's directory, if listed, leaves out the media-generation and clipping tools. The custom URL includes them.

**Claude Code**
```bash
claude mcp add postiz --transport http --url https://mcp.postiz.com/mcp \
  --header "Authorization: Bearer $POSTIZ_API_KEY"
```

**Codex** — `~/.codex/config.toml` (the key comes from the environment and never sits in the file):
```toml
[mcp_servers.postiz]
url = "https://mcp.postiz.com/mcp"
bearer_token_env_var = "POSTIZ_API_KEY"
```
Or from the terminal: `codex mcp add postiz --url https://mcp.postiz.com/mcp`, then add the `bearer_token_env_var` line.

**Cursor** — Settings → MCP → Add server: name `Postiz`, type `HTTP`, URL `https://mcp.postiz.com/mcp/<API_KEY>`.

**Claude Desktop (local config file, as an alternative to the account connector)** — `claude_desktop_config.json`:
```json
{ "mcpServers": { "postiz": { "url": "https://mcp.postiz.com/mcp/<API_KEY>" } } }
```

## 4. Verify

Ask: *"List my connected social media accounts."* The agent should call `integrationList` and return your channels. If it doesn't:

| Symptom | Fix |
|---|---|
| Tools don't appear | Enable the connector in this chat / restart the client |
| 401 / unauthorized | Key wrong or regenerated; update the URL or env var |
| Empty list | No channels connected in Postiz yet. Connect them in the Postiz app first |
| Rate-limit errors | Postiz Cloud allows ~30 requests/hour; wait, don't retry in a loop |

## 5. How the skill uses it

| Step | Postiz MCP tool |
|---|---|
| Channels | `integrationList` (+ `groupList` for client groups) |
| Platform rules / required settings | `integrationSchema` (`platform`, `isPremium`) |
| Lookups (Discord channels, LinkedIn pages, subreddits…) | `triggerTool` |
| Calendar / collisions | `postsListTool` (`startDate`, `endDate`) |
| Reuse uploaded media | `mediaListTool` → use `path` in `attachments` |
| Create draft / schedule / publish | `schedulePostTool` (content as HTML, `type` draft/schedule/now) |
| Change settings of a scheduled post | `postSettingsTool` |
| AI image from Postiz | `generateImageTool` (see `image-generation.md` → Providers) |

The Postiz MCP can't upload a file from your computer. For local images, use our MCP's `postiz_upload` or the CLI (`mkt.py postiz upload`), or drag the file into the Postiz media library and pick it with `mediaListTool`.
