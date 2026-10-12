# @codeame/marketing-images

An [MCP](https://modelcontextprotocol.io) server (Node 22 + TypeScript) for the marketing-orchestrator plugin that creates **finished
social-media graphics**: your photo, color or gradient plus a headline, short paragraph, button, brand colors and logo, in every common post
size. The text is drawn by the server (Satori + resvg + sharp), so it is always sharp and spelled exactly as written.

It runs two ways from the same code:

- **Locally over stdio** (`npx -y @codeame/marketing-images`): one MCP client, no access token, images saved on your computer. Works with any
  coding agent or MCP client that can launch a command.
- **As an HTTP server** (Docker image, or `marketing-images --http`): several people, a secret link per person, public image links.

AI image generation and editing use Gemini, fal.ai and Leonardo through the model catalog in `src/models.ts`. If you have a Postiz account the
server can also upload the finished graphics straight to it ([Postiz direct upload](#postiz-direct-upload)).

Typical flow: save the company brand once (`save_brand`), make a text-free background with `generate_image` (or take a photo the user gives you),
put the exact text on it with `compose_post` / `compose_custom` / `compose_carousel`, and hand the result to the scheduling tool (Postiz).
Use `estimate_cost` before spending on image generation.

## Tools

| Tool | What it does |
|---|---|
| `list_providers` | Image models, prices, today's allowance. |
| `estimate_cost` | Quote the price of a `generate_image` / `edit_image` request before spending; nothing is charged. |
| `generate_image` | Creates an image from a prompt (Gemini, fal.ai or Leonardo; `provider=auto` routes and falls back). Accepts `brand` (slug or inline object) to apply the brand's photo style and palette to the prompt. `leave_space` keeps room for text; `text_on_image` asks the model to draw words itself. |
| `edit_image` | Edits or restyles a reference image URL; also accepts `brand`. |
| `get_job` | Finishes an image that took longer than the synchronous wait (`SYNC_WAIT_MS`). |
| `list_templates` | Built-in, own and shared layouts (filters `format`, `tag`): variables, formats, preview links. Built-in previews use sample content and are rendered on first request, then cached. |
| `get_template` | HTML of a saved template, or a hand-written starter HTML equivalent of a built-in (`src/render/templates/starters/*.html`). |
| `save_template` | Saves a reusable layout (HTML + variables schema) after drawing it with the examples; same name = new version. `shared` makes it visible to every user. |
| `delete_template` | Deletes one of your own templates (soft delete; the tool description tells the agent to confirm with the user first). |
| `compose_post` | One finished graphic from a built-in or saved template (`photo-headline`, `cta-card`, `quote-card`, `split`, `minimal-badge`, `carousel-cover`, `carousel-point`, `carousel-end`). |
| `compose_carousel` | 2 to 10 slides, shared brand, optional "2/5" counter chip; links in order, previews of the first 3. |
| `compose_custom` | Draws a layout the agent designs as HTML with inline styles (see below). |
| `save_brand`, `list_brands`, `get_brand`, `delete_brand` | Saved brands (see below). |
| `upload_to_postiz` | Uploads an image this server made (its `url` or `file_path`) to Postiz and returns `postiz.path` ([details](#postiz-direct-upload)). Needs `POSTIZ_URL` and `POSTIZ_API_KEY`. |

Every compose tool takes `brand` as the **slug of a saved brand** (own first, then shared) or an inline object. Each slide of a carousel and each
composed graphic counts as one render against `DAILY_RENDER_LIMIT`.

Every tool that makes an image returns its `url`. In **local (stdio) mode** the result also has `file_path`, the absolute path of the file on your
computer, and `url` is a `file://` link (unless you set `PUBLIC_BASE_URL`). Those local links work as input for this server's own tools (a generated
picture as the `background.image_url` of `compose_post`, as the `image_url` of `edit_image`), but remote services such as Postiz's `uploadFromUrlTool`
cannot reach them: use [`upload_to_postiz`](#postiz-direct-upload) or attach the file from `file_path`. `edit_image` and reference images can use local
files only with Gemini (fal.ai and Leonardo download reference links themselves).

### Custom layouts (`compose_custom`) and saved templates

HTML with **inline styles** is converted to Satori nodes by our own converter on top of `parse5` (the `satori-html` package was evaluated and
rejected: it trims text nodes, ignores limits and keys, and turns `class` into Tailwind props; reasons are in `src/render/custom/html.ts`).
Pipeline: tokens, declared assets (downloaded through `fetchsafe` and embedded; Satori never fetches anything), CSS whitelist (unsupported
properties come back as warnings), fonts only from the registry (unknown family = fallback + warning), `data-fit` auto-size, Satori, resvg, sharp.
After drawing, Satori's `onNodeDetected` layout callback feeds the checks that return warnings for text outside the safe area, text overflow or cut off
by the edge, and low contrast against the background sampled from a text-less render. Limits: HTML 50 KB, 8 assets, 200 elements, 10 s.

Tokens: `{{brand.color.<name>}}` (aliases `{{brand.primary}}`...), `{{brand.font.heading|body|accent}}`, `{{brand.logo|logo_light|logo_dark}}`, `{{brand.radius}}`,
`{{brand.style.*}}`, `{{asset.<name>}}` (+ `.width` / `.height`), `{{var.<name>}}` (HTML-escaped), `{{format.width|height|scale}}`, `{{px.<n>}}` (n px at the 1080-px
reference, scaled to the format), `{{safe.top|bottom|left|right|width|height}}`. Add `data-fit` (+ `data-fit-min`, `data-fit-max`, `data-fit-lines`) to a text element
to get the largest size that fits its box, and `data-decor` to skip the checks for an intentional bleed.

### Saved brands

`save_brand` stores colors, fonts (bundled families or uploaded TTF/OTF files), logos (PNG/JPEG/WebP, or SVG rasterized with sharp at density 300), a style
(radius, button shape, eyebrow case, logo position and size, scrim, default templates, photo style) and voice notes. Assets are downloaded once through `fetchsafe`
and kept on the volume, never hot-linked: fonts in `DATA_DIR/fonts/<owner>/<slug>/` and logos in `DATA_DIR/brands/<owner>/<slug>/` (file names are content hashes; only the
host of the source link is remembered). It returns a brand sheet picture (palette, font specimens, logos). Uploaded fonts are registered per render, scoped to that brand.
`generate_image` and `edit_image` accept the same `brand` (slug or inline object): the brand's `style.photo_style` and a short palette phrase (primary, accent and secondary
as color names plus hex, for example `Brand palette: dark blue (#1F3A5F), amber (#F2A541)`) are appended to the prompt. An explicit `style` stays and wins where it differs, and `text_on_image` behaves as before.
Templates and brands are stored in the same `app.db` (tables `templates`, `brands`, `preview_cache`); the owner is the access-token name and other owners' private ones are never visible.

## Run locally (stdio) with any coding agent

Requires Node 22.13 or newer. Nothing to install: the MCP client launches the package with `npx`.

1. Create a settings file that only you can read (every variable is listed in [`.env.example`](https://github.com/nievesjesus/marketing-orchestrator/blob/main/servers/marketing-images/.env.example)):

   ```bash
   mkdir -p ~/.config/marketing-images
   cat > ~/.config/marketing-images/.env <<'EOF'
   GEMINI_API_KEY=your-gemini-key
   # FAL_KEY=
   # LEONARDO_API_KEY=
   # POSTIZ_URL=https://api.postiz.com
   # POSTIZ_API_KEY=
   EOF
   chmod 600 ~/.config/marketing-images/.env
   ```

   The server also looks in `$XDG_CONFIG_HOME/marketing-images/.env`; `--env PATH` picks any other file. Real environment variables win over the file
   (so an MCP client's `env` block can override one value), an empty variable counts as unset, and a file readable by other users only produces a warning on
   stderr ("run chmod 600"). Values are never logged. (The flag is `--env`, not `--env-file`: Node 22 intercepts `--env-file` itself before this program sees it.)

2. Register the command with your MCP client. Most clients accept this generic stdio entry:

   ```json
   {
     "mcpServers": {
       "marketing-images": {
         "command": "npx",
         "args": ["-y", "@codeame/marketing-images", "--env", "/Users/you/.config/marketing-images/.env"]
       }
     }
   }
   ```

   Without `--env` the default location above is used, so `"args": ["-y", "@codeame/marketing-images"]` is enough. Check it from a terminal with
   `npx -y @codeame/marketing-images --help`.

What is different in this mode:

- **One local user** (the owner name is `local`): no access tokens, and `ACCESS_TOKENS` is ignored if it is in a shared env file.
- **stdout carries only MCP messages.** Logs are JSON lines on stderr. Closing stdin (the client exiting) stops the server.
- **Data** lives in `~/.marketing-images/` (`--data-dir PATH`, `DATA_DIR` or `MARKETING_IMAGES_HOME` change it): `app.db` (brands, templates, quota), `images/{yyyy}/{mm}/`,
  `fonts/` and `brands/`. Images older than `RETENTION_DAYS` (30) are deleted. The daily limits (`DAILY_IMAGE_LIMIT`, `DAILY_USD_LIMIT`, `DAILY_RENDER_LIMIT`) still apply.
- **Local photos:** by default only images this server made can be read back by `file://` URL. To use your own photos as backgrounds, logos or edit sources,
  list their folders in `LOCAL_IMAGE_DIRS` (absolute paths or `~/...`, separated by commas; `:` also works on macOS/Linux and `;` on Windows). Files are checked by their real path (symlinks out of the folders are refused) and by their first bytes.

Command line:

```text
marketing-images [--stdio | --http] [--port N] [--env PATH] [--data-dir PATH] [--help] [--version]
```

## Run as a server (HTTP)

For several people, or when the image links must be public (Postiz copies them). Tokens are required: `ACCESS_TOKENS=name:token,name:token`
(`openssl rand -hex 24` for each token; the name keys quota and logs).

```bash
ACCESS_TOKENS=me:$(openssl rand -hex 24) PUBLIC_BASE_URL=http://localhost:8080 npx -y @codeame/marketing-images --http --port 8080
curl localhost:8080/healthz
```

`--http` from the command line keeps its data in `~/.marketing-images` (unless `DATA_DIR`/`--data-dir` says otherwise) and listens on `127.0.0.1` unless `HOST` is set.
Behind a reverse proxy set `PUBLIC_BASE_URL` to the public address and `HOST=0.0.0.0`.

Add it to Claude Code (the token is part of the URL, so treat the URL like a password):

```bash
claude mcp add --transport http marketing-images http://localhost:8080/mcp/<token>
```

### Development

```bash
source ~/.nvm/nvm.sh && nvm use      # Node 22 (see .nvmrc)
npm ci
ACCESS_TOKENS=dev:devtoken123 PUBLIC_BASE_URL=http://localhost:8080 DATA_DIR=./.data npm run dev
```

Other scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm start`, and `npm run readme:assets`, which redraws the pictures of the repository README into `.github/readme/` (calls the render functions directly with fictional brands and synthetic backgrounds: no server, network or API keys; see the header of `scripts/readme-assets.ts`). The CLI from source: `npx tsx src/cli.ts --help`.

## Docker (ghcr.io/nievesjesus/marketing-images)

The image runs the HTTP server (tokens required) on port 8080 with its data in the `/data` volume:

```bash
docker run -d --name marketing-images -p 8080:8080 -v marketing-images-data:/data \
  -e ACCESS_TOKENS=me:<token> -e PUBLIC_BASE_URL=https://image-mcp.example.com \
  -e GEMINI_API_KEY=<key> \
  ghcr.io/nievesjesus/marketing-images:latest
```

Tags: `vX.Y.Z` (exact), `X.Y` (latest patch of a minor) and `latest`; platforms `linux/amd64` and `linux/arm64`. Or use Compose: copy
`docker-compose.example.yml` to `docker-compose.yml`, copy `.env.example` to `.env`, fill it in and `docker compose up -d --build`. The same image can also
serve one local client over stdio: `docker run -i --rm -v mi:/data ghcr.io/nievesjesus/marketing-images node dist/cli.js --stdio` (links are `file://` paths inside the container).

## Postiz direct upload

If `POSTIZ_URL` and `POSTIZ_API_KEY` are set, the **final graphics** (`compose_post`, `compose_custom`, `compose_carousel`) are **also uploaded to Postiz** automatically, and the result includes
`postiz: { id, path }` (for `compose_carousel` it is `slides[].postiz` plus an ordered `postiz_paths`; for `generate_image`/`edit_image` it is `images[].postiz`, only when you ask for it). The
agent then uses `postiz.path` directly as the Postiz attachment and skips `uploadFromUrlTool`: this is what makes local (stdio) mode useful, because a local file
is not reachable by Postiz.

- **Endpoint:** `POST {base}/upload`, `multipart/form-data` with one field named `file`; the answer is Postiz's `MediaFile` (`id`, `name`, `path`...). Header
  `Authorization: <api key>` (the raw key, no `Bearer`). Spec: <https://docs.postiz.com/public-api/openapi.json> (operation `uploadFile`).
- **`POSTIZ_URL`** may be the app URL or the API base; it is normalized:

  | You set | Uploads go to |
  |---|---|
  | `https://api.postiz.com` (or `https://platform.postiz.com`, or `.../public/v1`) | `https://api.postiz.com/public/v1/upload` (Postiz Cloud) |
  | `https://postiz.example.com` (or `.../api`, or `.../api/public/v1`) | `https://postiz.example.com/api/public/v1/upload` (self-hosted) |

  Use `https://` (plain `http://` only for a Postiz on the same machine; a warning is logged otherwise).
- **Control:** by default `compose_post`, `compose_custom` and `compose_carousel` upload the final graphic, while `generate_image`, `edit_image` and `get_job` (and so their
  results) do **not**: those pictures are usually backgrounds that get a headline later. `POSTIZ_AUTO_UPLOAD=false` turns every automatic upload off. Per call,
  `upload_to_postiz: true | false` on any of those six tools overrides the default (`true` also forces an upload when `POSTIZ_AUTO_UPLOAD=false`). A draft with blocking warnings
  (`needs_attention`) is not uploaded automatically.
- **Failures never fail the tool:** the image comes back as usual with a `postiz_error` message (no key, URL or response body in it) and the agent can fall back to
  `uploadFromUrlTool` (public links) or call `upload_to_postiz` later. One retry with a short backoff happens on HTTP 429.
- **Rate limit:** Postiz's Public API allows 30 requests per hour, and every upload is one request. That is why `generate_image` and `edit_image` do not upload unless
  the call passes `upload_to_postiz=true` (use it only when the picture itself is the finished image); the tool descriptions say so.
- **`upload_to_postiz`** takes the `url` or `file_path` of an image this server made **for you** (ownership is recorded per user; other users' images, arbitrary links and files
  answer the same "not found"). An image that was already uploaded returns the same Postiz copy without using another request.
- **HTTP mode:** the Postiz key belongs to one account, not to each user of a multi-user server, so the credentials are ignored (with a startup warning) unless you set
  `POSTIZ_ALLOW_IN_HTTP=true` for a **single-tenant** deployment.

## Configuration

Copy `.env.example`; every name is listed there.

| Variable | Secret | Default | Meaning |
|---|---|---|---|
| `ACCESS_TOKENS` | yes | (required in HTTP mode, ignored in stdio) | `name:token,name:token`. Tokens are URL-safe (`openssl rand -hex 24`). The name keys quota and logs. Remove an entry and restart to revoke it. |
| `GEMINI_API_KEY`, `FAL_KEY`, `LEONARDO_API_KEY` | yes | none | Missing key = provider `available: false`. |
| `POSTIZ_URL`, `POSTIZ_API_KEY` | key: yes | none | Both enable the [direct Postiz upload](#postiz-direct-upload). |
| `POSTIZ_AUTO_UPLOAD`, `POSTIZ_ALLOW_IN_HTTP` | no | `true`, `false` | Upload the final graphics (`compose_*`) automatically (`generate_image` and `edit_image` only with `upload_to_postiz=true`); allow the upload in HTTP mode (single-tenant only). |
| `PUBLIC_BASE_URL` | no | `http://localhost:8080` (HTTP); none = `file://` links (stdio) | Base of the image links, e.g. `https://image-mcp.codeame.dev`. |
| `DATA_DIR` | no | `/data` (HTTP), `$MARKETING_IMAGES_HOME` or `~/.marketing-images` (stdio and the `--http` CLI) | SQLite database (`app.db`: ledger, saved templates, saved brands, image owners), `images/{yyyy}/{mm}/{uuid}.{png\|jpg}`, `fonts/` and `brands/` (saved brand assets). Mount a volume. |
| `LOCAL_IMAGE_DIRS` | no | none | Stdio only: extra folders (absolute or `~/...`, comma-separated) from which your own local `file://` photos may be read. |
| `RETENTION_DAYS` | no | `30` | An hourly sweep deletes older images (Postiz keeps its own copy). |
| `DAILY_IMAGE_LIMIT`, `DAILY_USD_LIMIT`, `DAILY_RENDER_LIMIT` | no | `30`, `3.00`, `200` | Per-user caps, UTC day. Renders are the free `compose_*` calls. |
| `SYNC_WAIT_MS` | no | `60000` | Longest a `generate_image`/`edit_image` call waits for a queued provider (fal, Leonardo) before saving a job and returning a `job_id`. Gemini answers in one request and is awaited up to 120 s. |
| `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` | no | `8080`, `0.0.0.0`, `info`, `production` | `NODE_ENV=development` binds loopback and allows `http://localhost` image links. Logs: stdout in HTTP mode, stderr in stdio mode. |

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

## Releasing

A tag `vX.Y.Z` publishes the npm package, the Docker image and the plugin zips (`.github/workflows/release.yml`). One-time setup:

1. **npm:** create the organization `codeame` on npmjs.com (the scope of `@codeame/marketing-images`; public packages are free), then create an access token
   that can publish to it (a granular token with read and write on the `@codeame` scope, or an automation token).
2. **GitHub:** repository Settings, Secrets and variables, Actions: add the secret `NPM_TOKEN` with that token. The Docker push uses the built-in `GITHUB_TOKEN`
   (after the first push, set the `marketing-images` package visibility to public in GitHub Packages).

To release:

```bash
# 1. set the same version in package.json and src/version.ts (test/config.test.ts checks they match), then
npm run typecheck && npm test && npm run build && npm pack --dry-run
# 2. commit, then tag and push the tag
git tag v0.1.0 && git push origin v0.1.0
```

The workflow stops if the tag differs from `package.json`'s version. It then (a) builds and tests, (b) runs `npm publish --provenance --access public`,
(c) pushes `ghcr.io/nievesjesus/marketing-images` as `vX.Y.Z`, `X.Y` and `latest` for `linux/amd64` and `linux/arm64`, and (d) runs `bash build.sh` at the repository
root and attaches `marketing-orchestrator.zip` and `marketing-orchestrator-plugin.zip` to the GitHub Release. The skill version (`SKILL.md` metadata) is independent of
the server version; `build.sh` only checks that the skill and the plugin manifest agree.

## Design notes

- **MCP SDK**: the v2 line, `@modelcontextprotocol/server` (`createMcpHandler`, stateless by default) with
  `@modelcontextprotocol/node` to mount it on `node:http`. Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md
  Stdio uses `serveStdio` from `@modelcontextprotocol/server/stdio` (same package, no extra dependency). Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.md
- **SQLite**: built-in `node:sqlite` (no native module to build, works on Node 22.13+ without flags; the
  ExperimentalWarning is silenced with `--disable-warning` in the scripts and the Dockerfile). Money is stored as integer micro-dollars.
- **HTML parsing** (`compose_custom`): `parse5` 8.0.1 (MIT; it depends on `entities`, BSD-2-Clause). Docs: https://parse5.js.org/
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
- **Image ownership**: every stored image is recorded with the user that made it (`image_owners` table), so `upload_to_postiz` only accepts your own images.
- Tests (`npm test`) need no network and write sample renders to `.samples/` (git-ignored).
