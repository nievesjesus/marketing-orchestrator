# marketing-images

A portable [MCP](https://modelcontextprotocol.io) server (Node 22 + TypeScript, one Docker image) for the
marketing-orchestrator plugin. It creates **finished social-media graphics**: your photo, color or gradient plus a
headline, short paragraph, button, brand colors and logo, in every common post size. The text is drawn by the server
(Satori + resvg + sharp), so it is always sharp and spelled exactly as written. Every result is a public image link
that the scheduling tool (Postiz `uploadFromUrlTool`) can copy.

Tools in this version: `list_providers` (image models, prices, today's allowance), `list_templates`, `compose_post`,
and the AI image tools `generate_image`, `edit_image`, `estimate_cost` (quote before spending) and `get_job`
(finish an image that took longer than the synchronous wait). They use Gemini, fal.ai and Leonardo through the
model catalog in `src/models.ts`.

## Run locally

```bash
source ~/.nvm/nvm.sh && nvm use      # Node 22 (see .nvmrc)
npm ci
ACCESS_TOKENS=dev:devtoken123 PUBLIC_BASE_URL=http://localhost:8080 DATA_DIR=./.data npm run dev
```

Check it: `curl localhost:8080/healthz`. Other scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm start`.

Add it to Claude Code (the token is part of the URL, so treat the URL like a password):

```bash
claude mcp add --transport http marketing-images http://localhost:8080/mcp/<token>
```

Or run the container: copy `docker-compose.example.yml` to `docker-compose.yml`, copy `.env.example` to `.env`,
fill it in and `docker compose up -d --build`.

## Configuration

Copy `.env.example`; every name is listed there.

| Variable | Secret | Default | Meaning |
|---|---|---|---|
| `ACCESS_TOKENS` | yes | (required) | `name:token,name:token`. Tokens are URL-safe (`openssl rand -hex 24`). The name keys quota and logs. Remove an entry and restart to revoke it. |
| `GEMINI_API_KEY`, `FAL_KEY`, `LEONARDO_API_KEY` | yes | none | Missing key = provider `available: false`. |
| `PUBLIC_BASE_URL` | no | `http://localhost:8080` | Base of the image links, e.g. `https://image-mcp.codeame.dev`. |
| `DATA_DIR` | no | `/data` | SQLite ledger (`app.db`) and `images/{yyyy}/{mm}/{uuid}.{png\|jpg}`. Mount a volume. |
| `RETENTION_DAYS` | no | `30` | An hourly sweep deletes older images (Postiz keeps its own copy). |
| `DAILY_IMAGE_LIMIT`, `DAILY_USD_LIMIT`, `DAILY_RENDER_LIMIT` | no | `30`, `3.00`, `200` | Per-user caps, UTC day. Renders are the free `compose_post` calls. |
| `SYNC_WAIT_MS` | no | `60000` | Longest a `generate_image`/`edit_image` call waits for a queued provider (fal, Leonardo) before saving a job and returning a `job_id`. Gemini answers in one request and is awaited up to 120 s. |
| `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` | no | `8080`, `0.0.0.0`, `info`, `production` | `NODE_ENV=development` binds loopback and allows `http://localhost` image links. |

## HTTP surface

| Route | What |
|---|---|
| `POST/GET/DELETE /mcp/<token>` | MCP Streamable HTTP, **stateless** (no sessions). Unknown token = `404`. |
| `GET /i/<yyyy>/<mm>/<uuid>.<png\|jpg>` | Stored images, `Cache-Control: public, max-age=31536000, immutable`; no directory listing. |
| `GET /healthz` | Liveness. |

Logs are one JSON line per event on stdout. They carry the token **name**, never the token or the `/mcp/...` path.

## Deploy on Coolify

1. New resource, Git repository `nievesjesus/marketing-orchestrator`, build pack **Dockerfile**, base directory
   `servers/marketing-images`.
2. Domain `https://image-mcp.codeame.dev`, port `8080`; health check path `/healthz`.
3. Persistent volume mounted at `/data`.
4. Environment variables from the table above (set the secrets yourself; `PUBLIC_BASE_URL=https://image-mcp.codeame.dev`).
5. In Claude: Customize, Connectors, Add custom connector, paste `https://image-mcp.codeame.dev/mcp/<token>`, "No sign-in".

## Design notes

- **MCP SDK**: the v2 line, `@modelcontextprotocol/server` (`createMcpHandler`, stateless by default) with
  `@modelcontextprotocol/node` to mount it on `node:http`. Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md
- **SQLite**: built-in `node:sqlite` (no native module to build, works on Node 22.13+ without flags; the
  ExperimentalWarning is silenced with `--disable-warning` in the scripts and the Dockerfile). Money is stored as integer micro-dollars.
- **Rendering**: Satori (plain `{type, props}` objects, no React) -> `@resvg/resvg-js` -> `sharp`. Text is measured with
  `opentype.js` on the real font files so line breaks, sizes and minimum sizes (headline 90 px, body 32 px, label 24 px at
  the 1080-px reference, scaled by short side / 1080) are decided by our code. Fonts are bundled OFL TTFs in `fonts/` (licenses in `fonts/LICENSES/`).
- **Downloads** of user-supplied URLs go through `src/fetchsafe.ts` (https only, DNS and IP range checks pinned to the
  connection, redirects re-checked, 15 MB, 15 s, magic bytes).
- **Image providers** (`src/providers/`, `src/router.ts`): one adapter per provider (`generate`, `edit`, `poll`) with plain
  `fetch`; the documented endpoints are cited next to each integration. `provider=auto` routes by `DESIGN` section 7
  (text in the picture or reference images: Gemini first; plain edit: Gemini, fal, Leonardo; "fast/draft" with several
  images: fal's cheapest model; otherwise Gemini, fal, Leonardo) and falls back to the next provider on provider failures
  (5xx, timeout, 429, credits, auth) but never on safety refusals or validation errors; an explicit `provider` or `model`
  never falls back. Every output is copied into our own storage. Queued jobs are polled with a 1 s x1.5 backoff capped at 5 s;
  past `SYNC_WAIT_MS` the job is saved in SQLite with its reserved allowance (kept 24 h, then refunded) and `get_job`
  resumes it. Quota is reserve, call, settle (real cost when the provider reports one) or release.
- **Prompt guard** (`src/safety.ts`): keyword lists refuse real people, minors in sensitive contexts and third-party
  brands/characters before any provider is called; editing the user's own photo is allowed.
- Tests (`npm test`) need no network and write sample renders to `.samples/` (git-ignored).
