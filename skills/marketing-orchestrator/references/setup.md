# Setup per client

The skill is a plain Agent Skills folder (`SKILL.md` + `references/` + `scripts/` + `assets/`). Instructions work everywhere; **actions** need one of: a shell with network (CLI), the bundled MCP server, or the official Postiz MCP.

## 1. Keys (once)

Create `~/.config/marketing-orchestrator/.env` (permissions 600):

```
POSTIZ_API_KEY=...            # Postiz > Settings > Developers > Public API
# POSTIZ_API_URL=https://postiz.example.com/api/public/v1   # self-hosted only
GEMINI_API_KEY=...            # https://aistudio.google.com/apikey
# GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1
# MKT_OUTPUT_DIR=~/Pictures/marketing   # where the MCP server writes images
```

Check: `python3 scripts/mkt.py doctor`. Optional deps: `pip install pillow` (logo overlay, crop/pad), `pip install tzdata` on Windows.

## 2. Install the skill

From the repo root: `./install.sh <target>` — symlinks by default so edits in the repo apply immediately (`--copy` to copy instead).

| Client | Target | Where it goes |
|---|---|---|
| Claude Code | `claude-code` | `~/.claude/skills/marketing-orchestrator` |
| Codex (CLI/app/IDE) | `codex` | `~/.agents/skills/marketing-orchestrator` |
| Claude Desktop / claude.ai | `zip` | `dist/marketing-orchestrator.zip` → upload it in the Skills section of Settings |
| Any other Agent Skills client | `--dest <dir>` | the client's skills folder |
| Tools without skills support | — | point them at `AGENTS.md` in the repo root |

Claude Desktop/claude.ai run skill scripts in a sandbox whose network may block Postiz or Gemini, and only bundled brands travel in the zip. Use `./install.sh zip --with-brands` to include your private kits, and add the MCP server below for actions.

## 3. Add the MCP server (actions from any MCP client)

Command: `python3 <abs-path>/skills/marketing-orchestrator/scripts/mcp_server.py` (reads the same `.env`). `./install.sh mcp-config` prints these snippets with your real paths.

**Claude Desktop** — `claude_desktop_config.json`:
```json
{ "mcpServers": { "marketing-orchestrator": {
  "command": "python3",
  "args": ["/ABS/PATH/skills/marketing-orchestrator/scripts/mcp_server.py"] } } }
```

**Claude Code**:
```
claude mcp add marketing-orchestrator -- python3 /ABS/PATH/skills/marketing-orchestrator/scripts/mcp_server.py
```

**Codex** — `~/.codex/config.toml`:
```toml
[mcp_servers.marketing-orchestrator]
command = "python3"
args = ["/ABS/PATH/skills/marketing-orchestrator/scripts/mcp_server.py"]
```

**Cursor** — `~/.cursor/mcp.json`: same shape as Claude Desktop.

## 4. Recommended: official Postiz MCP

Step-by-step for Claude, Claude Code, Codex and Cursor: `references/postiz-mcp.md`. It covers channels, schedule, calendar and media library with no local key; our MCP adds brand kits, Gemini, local-file upload and approval-guarded creation. Both can be active.

## 5. Optional: other image MCPs

Figma (`generate_image`, Nano Banana 2 / GPT image) and Canva (full branded designs) can stand in for or complement Gemini. See the Providers table in `references/image-generation.md`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach Postiz/Gemini … allowlist` | You're in a sandbox. Use the MCP server (runs on your machine) or run the CLI locally. |
| `HTTP 401` | Wrong/missing key in `.env`; run `doctor`. |
| `HTTP 404` on Gemini | Model id retired — set `GEMINI_IMAGE_MODEL`. |
| `HTTP 404` on a Postiz endpoint | Path changed — check https://docs.postiz.com/public-api/openapi.json and update `scripts/mktlib/postiz.py`. |
| `HTTP 429` | Postiz rate limit (~30/h). Wait; don't retry in a loop. |
| Skill not showing in Codex | Restart Codex; check `~/.agents/skills/marketing-orchestrator/SKILL.md` exists. |
