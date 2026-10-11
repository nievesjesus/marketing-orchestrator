# Images: every option, in plain terms

Pick the first option the user has. Explain choices to them in one line, in their language ("I'll make it in Canva, it uses 1 of your 20 free AI uses this month").

## Options at a glance

| # | Option | Setup for the user | Cost | Good at | Limits |
|---|---|---|---|---|---|
| 1 | **Canva — generate image** | Connect Canva (1 click + sign in) | Free plan: ~20 AI uses/month shared; more on paid plans | Photos, illustrations, icons; editing/restyling their own photo | Result is an image, not a layout |
| 2 | **Canva — generate design** | Same | Same | Finished post: headline, layout, photo, brand colors/logo (with Brand Kit) | Brand Kit needs Canva Pro/Teams; you pick one of several candidates |
| 3 | **Adobe for Creativity** | Connect Adobe from the connector list; works as guest, more with a free Adobe account | Free to start | Editing photos, removing backgrounds, quick social layouts (Express) | Making new images from text may not be available; check its tools |
| 4 | **Postiz — generateImageTool** | Already there if Postiz is connected | Postiz plan credits | Quick image saved straight into the Postiz library | Little control over style |
| 5 | **Figma — generate_image** | Only if they already use Figma | Figma AI credits | Nano Banana 2 and GPT-image models | Needs their Figma plan; download link lasts 7 days |
| 6 | **Gemini / ChatGPT apps** | None (they use the app they already have) | Their app plan | Strong image models | They make it there and upload it here; you write the prompt |
| 7 | **Their own photos** | None | Free | Real, authentic posts (usually perform best) | — |

Default recommendation for a non-technical user: **Canva** for anything made from scratch, **their own photos** whenever possible.

## Before generating

Write a 2–3 line brief and get an "ok":
- **What**: subject and scene ("a latte on a wooden table by a sunny window").
- **Style**: photo / illustration / 3D / flat; mood; brand colors from the brand card.
- **Shape**: vertical 4:5 for Instagram/LinkedIn feed, 9:16 for Stories/TikTok, 16:9 for X/YouTube, square if unsure.
- **Text on the image**: only if needed, max ~6 words, exact spelling.

## Canva, step by step

**A picture** (`generate-image`)
1. Call `generate-image` with a clear prompt and `aspectRatio` (`PORTRAIT_4_5`, `PORTRAIT_9_16`, `SQUARE_1_1`, `LANDSCAPE_16_9`). Include the brand style in the prompt in plain words.
2. If a widget shows the image, don't poll; otherwise check with `get-generate-image-job` until done. Always share the "Open generated image" link it returns.
3. **Edit their photo**: upload it first (`create-upload-url`, then send the file), then pass its media id in `imageReferences` with a prompt like "same photo, warmer light, remove the cup on the left".
4. **Remove background**: `remove-background` on an uploaded image.

**A finished post** (`generate-design`)
1. Ask if they want it on-brand. If yes, `list-brand-kits` and let them choose.
2. `generate-design` with `design_type` (`instagram_post`, `your_story`, `facebook_post`, `twitter_post`, `pinterest_pin`…), a detailed `query` (headline, message, style, what photo to use) and `brand_kit_id` if chosen. Pass their uploaded photos in `asset_ids`.
3. Show the candidates; when they pick one, `create-design-from-candidate`.
4. Other sizes: `resize-design` (e.g. 1080×1920 for Stories).
5. For Postiz: `export-design` as PNG and use the download link.

## Prompt recipe (any tool)

One short paragraph, not a list of tags:

> **Subject + action**, **where**, **framing** (close-up, top view, wide), **light and mood**, **style** (photo, illustration…), **brand colors**, **purpose** ("Instagram post for a coffee shop").

- Change one thing at a time when iterating.
- For a series, reuse the same style words and, if possible, the previous best image as a reference.
- Leave a calm corner if a logo will be added.

## Always

- Look at the result before showing it: subject right, colors on-brand, text spelled correctly, no weird hands/faces, nothing cropped.
- Offer one improvement round; after two misses, show the best one and ask what to change.
- Use the brand's real logo (Brand Kit or uploaded file). Never ask a model to draw a logo.

## Never

- Real, identifiable people (unless it's the user's own photo of themselves and they ask for an edit).
- Other brands' logos, known characters, or imitating another brand's look.
- Realistic "news-like" scenes that could be mistaken for real events; fake screenshots, receipts or reviews.
