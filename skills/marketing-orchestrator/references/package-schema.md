# Post package schema

The package is the draft for one post idea across one or more channels. Validate with `mkt.py package validate pkg.json`; turn into a Postiz payload with `mkt.py postiz build --package pkg.json`.

```json
{
  "brand": "example-coffee-shop",
  "idea": "Why we stopped deploying on Fridays",
  "posts": [
    {
      "platform": "linkedin",
      "integration_id": "clx123…",
      "objective": "authority",
      "audience": "Engineering leaders in LATAM fintechs",
      "pillar": "leading engineering teams",
      "language": "es",
      "hook": "Dejamos de deployar los viernes. No por miedo.",
      "hook_alt": "Optional second hook for A/B",
      "body": "Short paragraphs…",
      "cta": "¿Cómo lo manejan en tu equipo?",
      "hashtags": ["#EngineeringLeadership", "#DevOps", "#Fintech"],
      "media": ["out/cover.png", {"id": "media-id", "path": "https://uploads.postiz.com/x.png"}],
      "alt_text": ["Whiteboard with a deploy calendar crossed out on Fridays"],
      "first_comment": "Write-up: https://…",
      "carousel_name": "Friday deploys",
      "settings": {}
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `platform` | yes | Postiz identifier: `linkedin`, `linkedin-page`, `x`, `instagram`, `instagram-standalone`, `facebook`, `threads`, `bluesky`, `tiktok`, `pinterest`, … |
| `objective` | yes | awareness · engagement · traffic · leads · authority |
| `audience`, `hook`, `body` | yes | `body` may start with the hook; it won't be repeated |
| `integration_id` | for build | From `postiz integrations` |
| `cta`, `hashtags`, `first_comment` | no | Composed as hook → body → cta → hashtags, blank lines between |
| `media` | IG/TikTok/YouTube/Pinterest | Local paths, https URLs, or uploaded `{id, path}` |
| `alt_text` | recommended | One per image, same order as `media` |
| `settings` | no | Merged over defaults; use the live schema from `postiz settings <id>` |

Checks: required fields, length per platform (X 280, Bluesky 300, Threads 500, LinkedIn 3000, Instagram 2200…), hashtag count vs. playbook, brand never-list, media present where required, local files exist.
