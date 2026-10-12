# Connecting Marketing Images: remote or local

Marketing Images (the graphics connector, see `marketing-images.md`) can reach you in two ways. This page is for **you, the assistant**, when you run inside a coding agent and the Marketing Images tools are missing. In the Claude web, Desktop, mobile and Cowork apps only the remote way exists: use `getting-started.md` step C instead.

Verified against each tool's docs on 2026-10-11. Config formats change: if a file or command no longer works, say so plainly and fall back to the app's own MCP settings screen.

## Remote or local?

| | **Remote** (personal link) | **Local** (runs on the user's computer) |
|---|---|---|
| Works in | Claude web, Desktop, mobile, Cowork, and any coding agent | Coding agents on the user's own computer (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, VS Code Copilot…) |
| The user needs | A personal link from the owner (it works like a password) | Node.js 22 or newer and their own image-service keys (at least one of Gemini, fal, Leonardo) |
| Who pays and who sets limits | The owner's keys and daily limits | The user's own keys, billed by each provider; `DAILY_*` limits in their settings file |
| Images | Public HTTPS links kept about 30 days | Files on the user's disk (`~/.marketing-images/`); results include `file_path` |
| Getting them into Postiz | `uploadFromUrlTool` with the link | Automatic for the final graphics if `POSTIZ_URL` and `POSTIZ_API_KEY` are set (results include `postiz: {id, path}`), otherwise by hand |
| Offline | Needs the owner's server | Graphics are drawn on the computer; AI images still need the internet |
| Secret to protect | The link | The provider keys, in `~/.config/marketing-images/.env` |

Recommend **remote** if the user already has a link, **local** if they have no link and can get an image-service key. Either can be changed later.

## Ground rules (both ways)

- Keys and links are passwords. **Never ask the user to paste one in the chat**, never print or read back the settings file, and never put a key in an agent's config file (no `env` block with keys): the local server reads its own file.
- **Show the exact change and wait for a yes** before you write any config, install anything or create any file. Back the config file up first (copy it next to itself with a `.bak` ending) and **merge** the new entry into what is there. Never overwrite other servers. If the file has comments, edit it in place instead of re-saving it from parsed JSON.
- Prefer **user scope** (the global config) for anything that holds a link, so it never lands in a repository. If a project file is used, make sure it is ignored by git.
- Speak plainly, one step at a time, in the user's language. They do the one thing only they can do (fill in their keys, or add their link); you do the rest.

## Local setup: step by step

1. **Detect the agent you are running in** (from your own tool names and environment). If unsure, ask: "Which tool are you using me in?" and list the options in the sections below. If it is bb or Orca, see "bb and Orca" at the end.
2. **Ask once: "Remote or local?"** with a one-line explanation of each and your recommendation. If they pick remote, go to "Remote setup".
3. **Check Node.js:** run `node -v`. It must print v22 or higher. If it is missing or older, tell them to install Node 22 or newer (nodejs.org or their version manager) and offer to continue afterwards. Do not install software without a yes.
4. **Create the settings file** (if it doesn't exist) from the template in "The settings file" below, with placeholder lines only, then lock it down with `chmod 600`. If the file already exists, do not overwrite it. On Windows `~` is the user folder and `chmod` doesn't apply.
5. **The user fills in the keys.** Open the file in their editor for them (for example `open -t <file>` on macOS, `xdg-open <file>` on Linux, `notepad <file>` on Windows, or `code <file>`) and say which line is for what: "Paste your Gemini key after `GEMINI_API_KEY=`, save and tell me when it's done." Any one key is enough to start; Gemini is the default image service. Do not read the file afterwards.
6. **Add the MCP server** for the agent you detected, using its snippet below. Show the exact command or the exact lines and where they go, wait for a yes, back up, merge.
7. **Restart or reload the agent** (a new session at least): MCP servers are read at start. Tell the user to do it now and to come back and say "continue"; this conversation may end.
8. **Verify:** call `list_providers`. Say what you see: "Ready: Gemini, and N images left today". If a service you expected is missing, check the settings file path and that the key line is filled (without reading it back), then restart again.
9. **Postiz (optional):** if they use Postiz, offer to add `POSTIZ_URL` and `POSTIZ_API_KEY` to the same file (the user fills them in; see "Images and Postiz in local mode"). The Postiz connector (scheduling) is a separate setup: `postiz-mcp.md`.
10. **Their own photos (optional):** if they want to use their own pictures as backgrounds, logos or edit sources, ask which folder they keep them in and have them add it to `LOCAL_IMAGE_DIRS` in the settings file (restart afterwards). Local photos must live in one of those folders and are passed to the tools as `file://` links (for example `file:///Users/ana/Pictures/marketing/shop.jpg`); a photo outside them is refused. Images the server made itself are always allowed.

The MCP entry is always the same command, `npx -y @codeame/marketing-images`: it speaks stdio by default, needs no token and saves images under `~/.marketing-images/`. To keep the settings file somewhere else, add `"--env", "<path>"` to the arguments (the flag is `--env`, not `--env-file`); without it the default path above is used.

## The settings file (local only)

`~/.config/marketing-images/.env`, created with placeholder lines and mode 600. The user fills in the values; you never read them back.

```bash
mkdir -p ~/.config/marketing-images
cat > ~/.config/marketing-images/.env <<'EOF'
# Marketing Images settings. Keep this file private; never commit it.
# Fill in at least one image service. A service without a key is simply off.
GEMINI_API_KEY=
FAL_KEY=
LEONARDO_API_KEY=
# Optional: upload the final graphics (compose_post, compose_custom, compose_carousel) to Postiz automatically.
# POSTIZ_URL=
# POSTIZ_API_KEY=
# Optional: comma-separated folders the server may read your own photos from, e.g. ~/Pictures/marketing
# LOCAL_IMAGE_DIRS=
# Optional daily limits (images, US dollars, composed graphics).
# DAILY_IMAGE_LIMIT=
# DAILY_USD_LIMIT=
# DAILY_RENDER_LIMIT=
EOF
chmod 600 ~/.config/marketing-images/.env
```

Real environment variables win over this file, and an empty value counts as not set.

## Remote setup

1. The user gets the personal link from the owner, privately.
2. They add it **themselves**, because it is a secret: either they run the add command (below, with the link in place of the placeholder) in their own terminal window, or you open the agent's config file for them with the snippet and a placeholder, and they replace the placeholder in their editor. You never see the link. Same rules as above: show the change, wait for a yes, back up, merge.
3. Restart or reload the agent, then call `list_providers`.

## The MCP entry for each agent

Replace `<personal-link>` only in the remote snippets. Local snippets have no secret.

### Claude Code

```bash
# local
claude mcp add --transport stdio --scope user marketing-images -- npx -y @codeame/marketing-images
# remote (the user runs this in their own terminal)
claude mcp add --transport http --scope user marketing-images <personal-link>
```
Skill: user folder `~/.claude/skills/marketing-orchestrator/`, or project folder `.claude/skills/`. Plugin: `/plugin marketplace add nievesjesus/marketing-orchestrator`, then `/plugin install marketing-orchestrator@codeame`.

### Codex CLI

File `~/.codex/config.toml` (docs: https://learn.chatgpt.com/docs/extend/mcp):
```toml
# local
[mcp_servers.marketing-images]
command = "npx"
args = ["-y", "@codeame/marketing-images"]
```
```toml
# remote
[mcp_servers.marketing-images]
url = "<personal-link>"
```
Or for local: `codex mcp add marketing-images -- npx -y @codeame/marketing-images`. Skill: `~/.agents/skills/` (user) or `.agents/skills/` (repo).

### OpenCode

File `~/.config/opencode/opencode.json` (global) or `opencode.json` (project), under the key `"mcp"`:
```json
{ "mcp": { "marketing-images": { "type": "local", "command": ["npx", "-y", "@codeame/marketing-images"], "enabled": true } } }
```
Remote entry: `{ "type": "remote", "url": "<personal-link>", "oauth": false, "enabled": true }`.
Skill: `~/.config/opencode/skills/` (it also reads `~/.claude/skills/` and `~/.agents/skills/`).

### Cursor

File `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), key `mcpServers`:
```json
{ "mcpServers": { "marketing-images": { "command": "npx", "args": ["-y", "@codeame/marketing-images"] } } }
```
Remote entry: `{ "url": "<personal-link>" }`. Skill: `~/.cursor/skills/` or `.agents/skills/`.

### Gemini CLI

File `~/.gemini/settings.json`, key `mcpServers`:
```json
{ "mcpServers": { "marketing-images": { "command": "npx", "args": ["-y", "@codeame/marketing-images"] } } }
```
Remote entry: `{ "httpUrl": "<personal-link>" }` (the key is `httpUrl`, not `url`). Gemini CLI hides environment variables whose names look like a key or token from local servers; that is no problem here because the server reads its own settings file.
Skill: `gemini skills install https://github.com/nievesjesus/marketing-orchestrator --path skills/marketing-orchestrator --scope user`, or the folder `~/.gemini/skills/`.

**Antigravity CLI (`agy`)**, the consumer Gemini command line: MCP file `~/.gemini/config/mcp_config.json` (the remote key is `serverUrl`; copy the shape of any entry already in the file for the local one); skills folder `~/.gemini/antigravity-cli/skills/`.

### VS Code with GitHub Copilot

File `.vscode/mcp.json`, key `servers` (for a remote link, keep that file out of git):
```json
{ "servers": { "marketing-images": { "type": "stdio", "command": "npx", "args": ["-y", "@codeame/marketing-images"] } } }
```
Remote entry: `{ "type": "http", "url": "<personal-link>" }`. Skill: `~/.copilot/skills/` or `.github/skills/`.

### Windsurf (Devin Desktop), Cline, Goose

- **Windsurf:** the MCP file is usually `~/.codeium/windsurf/mcp_config.json` but the path varies by version: check the app's MCP settings. Local entry like Cursor's; the remote key is `serverUrl`.
- **Cline:** open the MCP settings file from its MCP Servers panel. Local entry like Cursor's; a remote entry needs `"type": "streamableHttp"` with the `url`.
- **Goose:** `~/.config/goose/config.yaml`, under `extensions:` add an entry with `type: stdio`, `cmd: npx` and `args: ["-y", "@codeame/marketing-images"]` (plus `name` and `enabled: true`, as in its other entries).

### bb and Orca

bb (`get-bb/bb`) and Orca (`stablyai/orca`, onorca.dev) have **no MCP config of their own**: they run Claude Code, Codex, Cursor or OpenCode underneath and inherit that agent's MCP servers and skills. Ask which agent runs inside, and set it up there, preferring user scope. bb also reads `~/.bb/skills/`.

## Installing the skill in another agent

Once, for any of them (agent ids: `claude-code`, `codex`, `opencode`, `cursor`, `gemini-cli`, `github-copilot`, `cline`, `goose`, `windsurf`):

```bash
npx skills add nievesjesus/marketing-orchestrator --skill marketing-orchestrator -g -a <agent>
```
Or copy the folder `skills/marketing-orchestrator/` into the agent's skills folder listed above.

## Images and Postiz in local mode

**What a local result contains**

- `file_path`: the absolute path of the image on the user's disk (local mode only; the `url` is a `file://` link to the same file, which you can pass back to the tools as a background, an asset or the image to edit).
- `postiz: {id, path}`: the image is already in Postiz. Single graphics (`compose_post`, `compose_custom`) have it at the top level; `generate_image`, `edit_image` and `get_job` have it per picture in `images[].postiz`; `compose_carousel` has it per slide in `slides[].postiz` plus `postiz_paths`, the same paths **in slide order**.
- `postiz_error`: a warning (the upload failed, or Postiz is not set up). The image itself is fine and `file_path` still works. Call `upload_to_postiz` once with that `file_path` or `url`; if it fails again, save the post as a draft and tell the user in one line, or ask them to add the file in Postiz → Media by hand.

**When something is uploaded** (needs `POSTIZ_URL` and `POSTIZ_API_KEY` in the settings file; Postiz → Settings → Developers → Public API for the key)

- `compose_post`, `compose_custom` and `compose_carousel` (the final graphics) upload **automatically**. Use each `postiz.path` directly as the attachment and **skip `uploadFromUrlTool`**; for a carousel, use `postiz_paths` in order.
- `generate_image`, `edit_image` and `get_job` do **not** upload by default: their pictures are usually backgrounds that get a headline later. Pass `upload_to_postiz: true` only when the picture itself is the finished image.
- `POSTIZ_AUTO_UPLOAD=false` in the settings file turns every automatic upload off. A call can always override the default with `upload_to_postiz: true` or `false`.
- The tool `upload_to_postiz` (`url` or `file_path` of an image the server made) uploads any earlier image; an image that was already uploaded returns the same Postiz copy without a new request. Postiz allows about 30 uploads per hour, so don't upload alternatives you won't use. The Postiz connector is still what schedules (`postiz-mcp.md`).

**Without the Postiz settings:** images stay on disk. `uploadFromUrlTool` needs a public link, so it can't take a local file. Tell the user where the file is (`file_path`) and ask them to drag it into Postiz → Media and attach it to the draft there; or give the post ready to copy.

**Own photos:** put them in a folder listed in `LOCAL_IMAGE_DIRS` and pass them as `file://` links. Images stay on the user's own disk: nobody else can open them unless the user shares them. To reuse one as an input (a background, an edit, a carousel slide), pass back the link the tool gave you exactly as returned; the tool descriptions say what else is accepted.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `npx: command not found`, or the agent says it can't start the server | Node.js isn't installed or isn't on the agent's PATH (apps launched from the Dock or Start menu don't always see the shell's PATH, nor nvm). Install Node 22+, start the agent from a terminal where `node -v` works, or put the full path of `npx` in `command`. On Windows, if `npx` still can't start, use `cmd` with `args` `["/c", "npx", "-y", "@codeame/marketing-images"]` |
| Node too old (`node -v` below v22), or the server exits at start | Install or switch to Node 22+, restart the agent |
| The server isn't listed, no tools appear | Restart or reload the agent (new session). Check the file path, the key name for that agent and that the JSON/TOML/YAML is valid. Ask the user to run `npx -y @codeame/marketing-images` in a terminal: it should sit waiting (stop with Ctrl+C); an error message there is the cause |
| `list_providers` shows no available service | The key line is empty, misspelled, or the file isn't at `~/.config/marketing-images/.env`. Fix, then restart the agent: the file is read at start |
| Gemini CLI: keys don't seem to arrive | It hides env vars named like keys from local servers. Don't use an `env` block: keep the keys in the settings file |
| Windsurf: file not found | The path varies: open the MCP settings from inside the app, or check `~/.codeium/windsurf/mcp_config.json` |
| Remote: "not found" or invalid link | The link was mistyped, still has the `<personal-link>` placeholder, or was cancelled: ask the owner for a new one |
| Daily limit reached | Local: change `DAILY_*` in the settings file and restart, or use free composed graphics and own photos. Remote: resets at 00:00 UTC |
| Permission warning about the settings file | `chmod 600 ~/.config/marketing-images/.env` |
| A result has `postiz_error` | Only a warning: the image is fine. Call `upload_to_postiz` once; if it fails again save the post as a draft and tell the user. Check `POSTIZ_URL` and `POSTIZ_API_KEY` if it says Postiz is not configured |
| "The env file was not found" at start | The path after `--env` is wrong (the flag is `--env`, not `--env-file`). Fix it or remove the flag to use `~/.config/marketing-images/.env` |
| A photo of the user is refused | It is not inside a folder listed in `LOCAL_IMAGE_DIRS`: add the folder, restart the agent |

If nothing works, don't leave the user stuck: write the posts and the image briefs anyway, and use their own photos or Canva (`visuals.md`).
