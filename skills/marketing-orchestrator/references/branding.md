# Branding

A brand kit is a folder: `brand.json` (structured), `voice.md` (prose), logos, and `style/` reference images.

## Where kits live (first match wins)

1. `$MKT_BRANDS_DIR/<slug>/`
2. `~/.config/marketing-orchestrator/brands/<slug>/` — your private kits; skill updates never overwrite them
3. `<skill>/assets/brands/<slug>/` — bundled kits (the only place that travels inside a zip uploaded to Claude Desktop / claude.ai)

Commands: `mkt.py brand list | show <slug> | validate <slug> | init <slug> [--here] | learn <slug> "<lesson>"`.

## brand.json fields

| Field | Used for |
|---|---|
| `name`, `goal` | Objective defaults, tone of CTAs |
| `languages` | Post language; if several, pick by audience and say which |
| `timezone`, `audience_timezone` | Time suggestions (audience) and how times are shown (user) |
| `default_channels`, `cadence_per_week`, `min_spacing_hours` | Channel choice and calendar spacing |
| `audiences[]` | `name`, `pain`, `stage` → the "Target audience" field |
| `pillars[]` | Every post maps to one pillar; say which |
| `offer.cta_url`, `offer.primary_cta` | CTA and first-comment link |
| `hashtags.branded / always / never` | Always include branded+always; never use the never-list (validated) |
| `emoji`, `links_in_first_comment` | Copy formatting |
| `visual.style / imagery / avoid` | Injected into image prompts verbatim |
| `visual.colors` | Hex palette injected into prompts; also padding color for `image fit --mode pad` |
| `visual.fonts` | Typography *feel* for rendered text (models don't load real fonts) |
| `visual.logo.{primary,light,dark}` | Files for `image overlay-logo`; `light` = for dark backgrounds |
| `visual.logo_position` | Default corner; also passed as `--logo-space` so the model leaves room |
| `visual.style_refs[]` + `style/*` | Sent to Gemini as style reference images (max 14 refs total) |
| `visual.default_aspect.<platform>` | Aspect used when generating for that platform |
| `learned[]` | Dated lessons from the user's edits. Read them; they override generic playbook advice |

## Applying a brand to copy

1. Read `voice.md` fully, then the `learned` list. Learned lessons win over the playbook.
2. Pick one audience and one pillar for the post and state them in the package.
3. Respect `emoji`, `links_in_first_comment` and the hashtag lists.
4. If the brand has no example lines yet, write plainly and ask the user to paste 2–3 posts they like — then offer to add them to `voice.md`.

## Applying a brand to visuals

- **Generated images**: pass `--brand`; the CLI appends style, palette, fonts and avoid-list, attaches style references, and (with `--logo-space`) asks for a calm corner.
- **Logos**: never ask the model to draw the logo. Generate without it, then `image overlay-logo --brand <slug>`. The variant is chosen by the background brightness of that corner.
- **User photos**: don't recolor them. Use `image fit --mode pad --color <brand color>` when the ratio is wrong and cropping would cut the subject, and add the logo only if the brand does that on photos.
- **Consistency check** before proposing: palette dominant? avoid-list respected? text legible and spelled right? logo crisp and not covering the subject?

## Adding a new brand

`mkt.py brand init acme` → fill `brand.json` and `voice.md` (ask the user; don't invent values) → drop transparent PNG logos and 1–6 style images → `mkt.py brand validate acme`.
