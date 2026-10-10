# Postiz API Reference (what this skill uses)

Docs index: https://docs.postiz.com/llms.txt — OpenAPI: https://docs.postiz.com/public-api/openapi.json
If an endpoint below returns 404, check the OpenAPI spec and call it with `mkt.py postiz` or add a function in `scripts/mktlib/postiz.py`.

- Base URL (cloud): `https://api.postiz.com/public/v1`
- Base URL (self-hosted): `https://<your-domain>/api/public/v1`
- Auth header: `Authorization: <api-key>` (no "Bearer")
- UI says "channel", API says "integration" — same thing.
- Rate limit: ~30 requests/hour on Postiz Cloud public endpoints; create-post has its own hourly cap. Plan calls accordingly.

## Endpoints

| Purpose | Method + path | Verified |
|---|---|---|
| Check key | `GET /is-connected` | docs |
| List channels | `GET /integrations` | docs |
| Channel rules/settings/tools | `GET /integration-settings/{id}` | path assumed — confirm in OpenAPI |
| Next free slot | `GET /find-slot/{id}` → `{ "date": "…Z" }` | docs |
| List posts | `GET /posts?startDate=…Z&endDate=…Z` | params assumed — confirm |
| Create post | `POST /posts` | docs |
| Delete post (whole group) | `DELETE /posts/{id}` | docs |
| Upload file | `POST /upload` multipart, field `file` → `{id, path}` | docs |
| Upload from URL | `POST /upload-from-url` `{ "url": "…" }` | docs |
| Media library | `GET /media?search=&page=` | docs |
| Post analytics | `GET /analytics/post/{id}?date=7` | path assumed — confirm |
| Channel analytics | `GET /analytics/{integrationId}?date=7` | path assumed — confirm |

Accepted media: jpeg, png, gif, webp, avif, bmp, tiff, mp4. No PDF.

## Create post payload

```json
{
  "type": "schedule",
  "date": "2026-10-14T12:30:00.000Z",
  "shortLink": false,
  "tags": [],
  "posts": [
    {
      "integration": { "id": "<integration-id>" },
      "value": [
        {
          "content": "Hook line\n\nBody…\n\n#AgenticAI #EngineeringLeadership",
          "image": [ { "id": "<media-id>", "path": "https://uploads.postiz.com/x.png" } ]
        },
        { "content": "First comment with the link: https://…", "image": [] }
      ],
      "settings": { "__type": "linkedin", "post_as_images_carousel": true, "carousel_name": "Title" }
    }
  ]
}
```

- `type`: `now` (date ignored) | `schedule` | `draft`
- `date`: UTC ISO 8601. Required even for `now`/`draft` — use current UTC time.
- Multiple `value` items: LinkedIn/Facebook → post + comments; X/Threads/Bluesky → thread.
- One `posts[]` item per channel. Same media `{id, path}` can be reused across channels.

## Per-platform `settings`

| Platform | `__type` | Required / useful |
|---|---|---|
| LinkedIn profile | `linkedin` | `post_as_images_carousel` (bool), `carousel_name` |
| LinkedIn page | `linkedin-page` | same as above |
| X | `x` | `who_can_reply_post`: everyone \| following \| mentionedUsers \| subscribers \| verified; optional `community`, `made_with_ai` |
| Instagram (FB-linked) | `instagram` | `post_type`: post \| story; `is_trial_reel`, `collaborators: [{label}]` |
| Instagram standalone | `instagram-standalone` | same as Instagram |
| Facebook | `facebook` | optional `url` |
| Threads / Bluesky / Mastodon / Telegram | `threads` / `bluesky` / `mastodon` / `telegram` | none |
| TikTok | `tiktok` | `privacy_level`, `duet`, `stitch`, `comment`, `autoAddMusic` ("yes"/"no"), `brand_content_toggle`, `brand_organic_toggle`, `content_posting_method` (DIRECT_POST publishes; UPLOAD only sends to the TikTok inbox) |
| YouTube | `youtube` | `title`, `type` (public/private/unlisted), `selfDeclaredMadeForKids` |
| Pinterest | `pinterest` | `board` (id), `title`, `link` |
| Reddit | `reddit` | `subreddit: [{ value: { subreddit, title, type, is_flair_required } }]` |
| Discord / Slack | `discord` / `slack` | `channel` (id) |

Always prefer the live schema from the channel settings endpoint (or MCP `integrationSchema`) over this table.

## MCP equivalents (Postiz connector)

| REST | MCP tool | Notes |
|---|---|---|
| `GET /integrations` | `integrationList` | |
| settings | `integrationSchema` (`platform`, `isPremium`) | returns rules, `maxLength`, settings schema, helper tools |
| helper lookups | `triggerTool` | e.g. list Discord channels, LinkedIn pages |
| `POST /posts` | `schedulePostTool` | `socialPost[]` with `integrationId`, `date`, `type`, `shortLink`, `isPremium`, `postsAndComments[{content, attachments[]}]`, `settings[{key, value}]` (keys from `integrationSchema`). Content must be HTML: `<p>` per line, `<strong>`, `<u>`, `<ul><li>`, `<h1-3>`. |
| `GET /posts` | `postsListTool` (`startDate`, `endDate`) | |
| `GET /media` | `mediaListTool` | reuse `path` as attachment |
| — | `postSettingsTool` | change settings of a scheduled/draft post |
| — | `generateImageTool` | only if the user asks for an AI image |

MCP setup: Postiz → Settings → Developers → copy the MCP URL, then in Claude add it as a custom connector. (The directory version of the connector omits media-generation tools.)
