# Visuals: every option, in plain terms

Pick the first option that fits. Explain choices in one line, in the user's language ("I'll make the background with the image service and add your headline myself, so the spelling is exact").

## Options at a glance

| # | Option | Setup for the user | Cost | Good at | Limits |
|---|---|---|---|---|---|
| 1 | **Their own photos** (Postiz upload widget) | Postiz connected | Free | Real, authentic posts (usually perform best) | They need photos |
| 2 | **Marketing Images** (`generate_image`, `edit_image`, then `compose_post` / `compose_custom` / `compose_carousel`) | Personal link added as a connector, or a local server in a coding agent (`setup-local.md`) | AI images cost money (roughly US$0.003–0.13 each, `estimate_cost` gives the exact quote); composed graphics are free; daily limits | New images, restyling their photo, finished graphics with exact text, brand colors and logo, carousels | Remote: public links kept about 30 days. Local: files on the user's computer. No real people, brands or characters |
| 3 | **Canva** (`generate-image`, `generate-design`) | Connect Canva (1 click + sign in) | Free plan: about 20 AI uses a month; more on paid plans | Illustrations, designs built in Canva, editing there | Brand Kit needs Canva Pro/Teams |
| 4 | **Adobe for Creativity** | Connect Adobe; works as guest, more with a free account | Free to start | Editing photos, removing backgrounds, quick layouts | Making new images from text may not be available |
| 5 | **Postiz** `generateImageTool` | Already there if Postiz is connected | Postiz plan credits | A quick image straight into the Postiz library | Little control over style, no exact text |
| 6 | **Figma** `generate_image` | Only if they already use Figma | Figma AI credits | Strong image models | Needs their plan; download links expire |
| 7 | **Gemini or ChatGPT apps** | None | Their app plan | Strong image models | They make it there and upload it here; you write the prompt |

Default recommendation for a non-technical user: **their own photos** whenever possible, **Marketing Images** for anything made from scratch and for every graphic with words on it.

## Their own photos (Postiz upload widget)

1. Call `uploadWidgetTool`: an upload widget appears in the chat and the user picks their photos.
2. When they say they're done, call `uploadWidgetStatusTool`: it returns each media `{id, path}`. "Processing" means wait about 10 seconds and ask again.
3. Look at every photo (what's in it, mood, text, people, shape). Flag problems kindly: blurry, text cut off, wrong shape for the network, a screenshot with private information, someone who may not have agreed to appear.
4. Use the `{id, path}` as the attachment when scheduling: it is already hosted by Postiz. The `path` is also a public link you can give to Marketing Images as `image_url` (`edit_image`) or `background.image_url` (`compose_post`).
5. Apps that can't show widgets show nothing: then ask for a public link to the photo (give it to `uploadFromUrlTool`), or ask them to drag the photo into Postiz → Media. A photo that only sits in Media can't be picked by the assistant unless the tool list has a media-list tool (such as `mediaListTool`, whose `path` you then use): otherwise save the post as a draft and tell them to attach the photo from Media inside Postiz.

## Marketing Images

It makes **finished social graphics**: your photo, a color or an AI background plus a headline, short text, button, brand colors and logo, in every common size. The text is drawn by the server, so it is sharp and spelled exactly as written. It never publishes anything.

| Tool | Use it for |
|---|---|
| `list_providers` | Which image services and models exist, what each is good at, and what is left of today's allowance |
| `estimate_cost` | The price of a `generate_image` / `edit_image` request before spending anything (free) |
| `generate_image` | A new picture from a description (1–4 alternatives, each billed) |
| `edit_image` | Change or restyle a photo that has a public link (new background, light, remove an object) |
| `get_job` | Finish an image that took longer than the wait (`pending`) |
| `compose_post` | One finished graphic from a template |
| `compose_carousel` | 2–10 slides that share one look |
| `compose_custom` | A layout you design in HTML (`design-guide.md`) |
| `list_templates`, `get_template`, `save_template`, `delete_template` | Browse, read, save and delete layouts |
| `save_brand`, `list_brands`, `get_brand`, `delete_brand` | The saved visual brand (colors, fonts, logo, style) |

### Image services in plain words (verified 2026-10-10; `list_providers` has the current list)

| Service | Good at |
|---|---|
| **Google Gemini** ("Nano Banana") | Following detailed descriptions, words inside the picture, editing photos, using reference images. The default. Every picture carries an invisible watermark |
| **fal.ai** | Very cheap, fast drafts, plus a second route to Nano Banana and to photo edits |
| **Leonardo** | A distinct "Leonardo look" and style presets; its prices are estimates until the image comes back |

Leave `provider` on `auto`. In plain words, the server routes like this: if the picture needs words in it or reference images, Gemini first; plain photo edits, Gemini, then fal, then Leonardo; "quick draft" requests with several images, fal's cheapest; anything else, Gemini, then fal, then Leonardo. If one service is down or out of credits it tries the next on its own (the answer says `fallback_from`), but it never retries after a safety refusal. If you name a provider or a `model`, there is no fallback: do that only if the user asks.

### What to tell the user (in their language, short)

| Situation | Say |
|---|---|
| Before spending (`estimate_cost`) | "I'll make N image(s): about US$<total>. OK?" |
| `fits_allowance` is false | "That's more than what's left for today (<images> images, US$<budget>); it resets at midnight UTC. I can make fewer, use your photos, or do it tomorrow." |
| Daily limit error | "Today's limit of images / dollars / graphics is used up. It resets at 00:00 UTC. Meanwhile I can use your photos or save the posts as drafts." |
| `fallback_from` is set | Nothing, or "the first service was busy, another one made it" |
| A service is out of credits or not set up | "That image service isn't available right now; I used another one" (or, if none works, "none is available; the owner needs to check it", and offer own photos) |
| Safety refusal | "The service won't make that picture (it avoids real people, brands and some themes). I can describe it differently." |
| `pending` | "It needs a little longer, I'll check again in a few seconds." Then `get_job` after about 15 seconds; it is only billed when it finishes, and the job is kept 24 hours |
| Real person, brand or character in the request | Explain you can't make those; offer a generic scene or their own photo |

### Prompt recipe for text-free backgrounds

Write one short paragraph, not a list of tags:

> **Subject + action**, **where**, **framing** (close-up, top view, wide), **light and mood**, **style** (photo, illustration…), **brand colors** (added automatically with `brand`), **purpose** ("Instagram post for a coffee shop").

- Leave `text_on_image` empty: headlines are added afterwards with the compose tools. Use it only when the user explicitly wants the AI to draw words (a sign, a label).
- Set `leave_space` to the side where the headline will sit (`top`, `bottom`, `left`, `right`): that area stays calm and empty.
- Pass `brand` (the saved slug): the brand's photo style and palette are added to the prompt. `style` overrides it for one picture.
- `aspect_ratio`: `1:1` square, `4:5` portrait (best for feed posts), `9:16` story/reel, `16:9` landscape and link cards.
- `reference_image_urls` (up to 14 public links) when the picture must follow a product photo or a mood image.
- `negative_prompt` and `seed` exist; use them only to fix a specific problem. `size` stays at the default (1K): plenty for social posts.
- Change one thing at a time when iterating. For a series, reuse the same style words and the same brand.

Example: "A latte with leaf art on a light wooden table by a sunny window, top view, soft morning light, warm natural tones, calm and minimal, Instagram post for a coffee shop" with `leave_space: "top"`, `aspect_ratio: "4:5"`.

### Templates for `compose_post`

Formats: `square` 1080×1080, `portrait` 1080×1350, `story` 1080×1920, `landscape` 1920×1080, `link` 1200×627. Match the format to the network (portrait or square for Instagram, Facebook and LinkedIn feeds; story for Stories, Reels and TikTok covers; landscape or square for X; link for link cards). Stories keep text out of the top 250 px and bottom 400 px.

| Template | Looks like | Best for | Texts |
|---|---|---|---|
| `photo-headline` | Photo with a big headline at the bottom | Announcements, news, product or place photos | eyebrow, **headline**, body, footer |
| `cta-card` | Brand-color card with a button | Offers, booking, last call, reminders | eyebrow, **headline**, body, cta, footer |
| `quote-card` | Big quote on a brand-color card | Real customer quotes (with permission), tips, a motto | eyebrow, **headline** (the quote), footer (the author) |
| `split` | Photo on one side, text panel on the other | Explaining a product, a menu item, event details | eyebrow, **headline**, body, cta, footer |
| `minimal-badge` | Clean photo with a small label or price badge | A price, "New", a tag | eyebrow, **headline** (1–4 words), body, footer |
| `carousel-cover` | Photo with a hook and a "swipe" cue | Slide 1 of a carousel | eyebrow, **headline**, body, cta, footer |
| `carousel-point` | Numbered tip on a brand-color card | The middle slides, one idea each | number, eyebrow, **headline**, body, footer |
| `carousel-end` | Closing card with a button | Last slide: "save this", "follow us", "book now" | eyebrow, **headline**, body, cta, footer |

- Texts are drawn exactly as written (accents and ñ are fine; **emoji are not supported** in graphic text). Keep them short: headline about 25–45 characters (quotes up to about 160), eyebrow 30, body 160, button 2–4 words (24), footer 40.
- Photo templates take a photo in `background.image_url` (a color or gradient also works); without one they use a brand gradient. Card templates use the brand color unless you pass a background.
- `options`: `scrim` (`auto`, `soft`, `strong`, `none`: darkening behind text on photos), `align`, `text_position`, `output`. A saved brand can set `style.default_templates`, so `template` may be left out.
- Read `warnings`: a too-long headline sets `needs_attention` (write a shorter one); low contrast on a photo means retry with `options.scrim: "strong"`.
- Saved templates (`list_templates` shows them) are used by name: `compose_post` with `template`, `variables`, `assets`.
- **Carousels:** `compose_carousel` with 2–10 slides (first slide cover, last slide end, the rest points, numbered automatically; a "2/5" counter is drawn). It returns the links **in order** (`urls`) and previews of the first 3; every slide counts as one composed graphic against the daily limit.
- Need something no template does? `compose_custom` (`design-guide.md`); keep the design with `save_template` when the user loves it.

## Canva (when connected and the user prefers it)

**A picture** (`generate-image`): call it with a clear prompt and `aspectRatio` (`PORTRAIT_4_5`, `PORTRAIT_9_16`, `SQUARE_1_1`, `LANDSCAPE_16_9`). If a widget shows the image don't poll; otherwise check with `get-generate-image-job`. To edit their photo, upload it first (`create-upload-url`), then pass its id in `imageReferences`. `remove-background` works on uploaded images.

**A finished post** (`generate-design`): if they want it on-brand, `list-brand-kits` and let them choose; then `generate-design` with `design_type` (`instagram_post`, `your_story`, `facebook_post`, `twitter_post`…), a detailed `query` and `brand_kit_id`. Show the candidates, `create-design-from-candidate` for the one they pick, `resize-design` for other sizes, and `export-design` as PNG. Give the export link to Postiz `uploadFromUrlTool`.

## Always

- Get the quote and a quick ok before every AI image (`estimate_cost`); composed graphics are free.
- Look at every result before showing it: subject right, colors on-brand, text spelled correctly, no strange hands or faces, nothing cropped. Read the `warnings`.
- Fix and render again at most twice; then show the best one and ask what to change.
- Use the brand's real logo (saved brand or a file the user gave). Logos are never drawn by AI.
- Give the final image links to Postiz `uploadFromUrlTool` only after the user approves the post. (A local server with Postiz settings has already uploaded the final graphics from `compose_*`: use `postiz.path`, or `postiz_paths` in order for a carousel, as the attachment.)

## Never

- Real, identifiable people (unless it's the user's own photo of themselves and they ask for an edit).
- Other brands' logos, known characters, or imitating another brand's look.
- Realistic "news-like" scenes that could pass for real events; fake screenshots, receipts or reviews.
- Words drawn by an AI model when a compose tool can draw them.
