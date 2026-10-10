# Image generation with Gemini

Uses Google's Gemini image models ("Nano Banana"). Needs `GEMINI_API_KEY` (https://aistudio.google.com/apikey). Every output carries Google's invisible SynthID watermark.

## Models (set `GEMINI_IMAGE_MODEL` or pass `--model`)

| Model id | When | Sizes |
|---|---|---|
| `gemini-nano-banana-2.1` (default) | General use, best balance | 1K, 2K, 4K |
| `gemini-3-pro-image` | Hardest jobs: lots of rendered text, infographics, up to 3 style refs | 1K, 2K, 4K |
| `gemini-3.1-flash-lite-image` | Cheap drafts / many variations | 1K only |
| `gemini-3.1-flash-image`, `gemini-2.5-flash-image` | Legacy, being retired | — |

Model ids change; if you get a 404, check https://ai.google.dev/gemini-api/docs/image-generation and update the default in `scripts/mktlib/gemini.py` and this table.

Aspect ratios: `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`. Sizes: `1K 2K 4K` (uppercase K).

## Workflow

1. **Brief** (show the user, 3–5 lines): concept · platform + aspect · exact text to render (or none) · brand · what to avoid.
2. **Dry run** to check the final prompt without spending: `mkt.py image generate --brand <slug> --platform linkedin --prompt "…" --out out/p.png --dry-run`.
3. **Generate** (drop `--dry-run`). Output: the image plus a `.json` sidecar with model, prompt and settings, so you can reproduce or tweak it.
4. **Look at it.** Check subject, palette, legibility and spelling of any text, artifacts (hands, faces, warped edges), and space for the logo.
5. **Logo**: `mkt.py image overlay-logo out/p.png --brand <slug>`.
6. **Iterate** with an edit instead of starting over: `--ref out/p.png --prompt "Same image, but make the background warmer and remove the cup on the left"`.

## Prompt recipe

Write the scene as a short paragraph, not a tag list:

> **Subject + action**, **setting**, **composition/camera** (close-up, flat lay, wide, top-down; where the subject sits in the frame), **lighting/mood**, **medium** (photo, 3D render, flat illustration, editorial collage), **purpose** ("LinkedIn carousel cover about …").

- Text in the image: pass it with `--text "…"` (exact spelling enforced in the prompt). Keep it ≤ 8 words. For longer text, generate the image without text and let the platform copy carry it.
- Variations: change one thing at a time (composition, or lighting, or palette weight).
- Edits: refer to the attached image explicitly ("the attached image"), say what to keep and what to change.
- Style consistency across a campaign: keep the same brand `style/` refs and reuse the previous best image as a `--ref`.

## Reference images

`--ref` files (png/jpeg/webp) go first, then the brand's style refs, max 14 total. Per-model limits on characters/objects/styles apply (e.g. Pro: up to 3 style refs).

## Don'ts

- Don't generate real, identifiable people (including the user) unless the user supplies the photo and asks for an edit of themselves.
- No third-party logos, trademarks, characters, or imitation of another brand's look.
- No photorealistic "news" or event images that could pass as real; no fake screenshots, receipts or testimonials.
- Don't loop on regeneration — after 2 misses, show the best one and ask what to change.

## API notes

The CLI calls `POST /v1beta/models/{model}:generateContent` with `generationConfig.responseModalities = ["TEXT","IMAGE"]` and `imageConfig {aspectRatio, imageSize}`, and falls back to `POST /v1beta/interactions` (`response_format {type: image, aspect_ratio, image_size}`, `store: false`) on 400/404. Force one with `--api`. Interim "thought" images are ignored.
