<!-- Portions adapted from Anthropic's knowledge-work-plugins Marketing plugin v1.2.0 (Apache-2.0); modified. -->
# Brand card

A short, plain-text profile of the brand. You fill it from the interview (SKILL.md section 2), show it to the user, and they keep it in a Claude Project's instructions so every chat starts on-brand. The **visual** part (colors, fonts, logo, style) is also saved in Marketing Images with `save_brand`; the card keeps the **voice and rules** (the image server doesn't write copy).

Rules:
- Write the card in the user's language (it's their document). Keep the section titles below.
- Only write what the user said. Leave a field as "—" rather than inventing it.
- Keep it under about 300 words. Short bullets.
- When they correct a post, offer to add the lesson under **Learned**.

## Voice: 3 attributes, "we are / we are not"

Pick 3 traits (warm, direct, expert, playful, premium, calm, bold…). For each one, write what it means in practice and what it must not turn into, plus a sentence that sounds like it. Help the user choose with a few opposites: formal ↔ casual, expert ↔ friendly peer, warm ↔ straight to the point, calm ↔ energetic, playful ↔ serious.

```
1. Warm: we are friendly and personal; we are not cheesy or overly familiar.
   Sounds like: "Pasá, el café ya está listo."
2. Simple: we are plain and clear; we are not simplistic or vague.
   Sounds like: "Granos tostados esta semana, molidos como quieras."
3. A bit funny: we are light and observant; we are not sarcastic or making fun of customers.
   Sounds like: "Hoy el medialunas-meter está alto."
```

The voice stays the same everywhere; the **tone** adjusts by network and situation (LinkedIn a bit more formal, Instagram more relaxed, bad news more honest and direct).

## Template

```
BRAND CARD — <name>

What we are: <one sentence: who/what and what you offer>
Goal of our posts: <follow / comment / visit / buy / book / trust>
Who we talk to:
- <audience 1: who, where, what they care about>
- <audience 2>
Networks & frequency: <e.g. Instagram 3/week, LinkedIn 1/week>
Language(s): <e.g. Spanish (Argentina); English for international clients>
Time zone of our audience: <e.g. Buenos Aires>
Voice (3 traits):
1. <trait>: we are <…>; we are not <…>. Sounds like: "<example>"
2. …
3. …
Tone by network:
- <network>: <how the tone shifts, e.g. relaxed, short, 1–2 emojis>
Emojis: <none / a few (which) / lots>
Capitals and punctuation: <e.g. no ALL CAPS, max one exclamation mark>
Words to avoid: <list>
We never: <topics, claims, promises to avoid>
Hashtags we always use: <#…>
Link for calls to action: <url or —>
Visual style: <colors (names), photo vs illustration, mood>
Saved visual brand (Marketing Images): <slug, or —>
Logo: <saved in the visual brand / uploaded file / none>
Learned:
- <dated lessons from their edits>
```

## How the card maps to `save_brand`

Call `save_brand` once the user has seen and liked the look. Show the brand sheet picture it returns and ask "Does this look like you?" Saving the same `slug` again creates a new version.

| Card says | `save_brand` field | Notes |
|---|---|---|
| Brand name | `display_name` (≤ 80 chars) and `slug` | `slug`: lower-case letters, digits and hyphens, for example `cafe-lumbre` |
| Main color, highlight color | `colors.primary`, `colors.accent` | Hex like `#1F3A5F`. Pick them yourself from "warm browns and cream"; show the brand sheet and adjust. Never ask the user for hex codes |
| Text on light / on dark | `colors.ink` (dark), `colors.paper` (light) | Ink must be dark and paper light, so text stays readable |
| Second color, extra colors | `colors.secondary`, `colors.extra` | Optional; `extra` is a list of `{name, hex}` with lower-case names |
| Font feel | `fonts.heading`, `fonts.body`, `fonts.accent` | Use the bundled families: **Outfit** (modern geometric), **Work Sans** (neutral, easy to read), **Bricolage Grotesque** (modern with character), **Lora** (classic serif), **Instrument Serif** (elegant display), **Young Serif** (warm, bold display). Pick the closest to what they described; say which you chose |
| Logo file | `logos.primary` (+ `light` for dark backgrounds, `dark` for light ones) | Needs a public https link: have the user upload the file with Postiz `uploadWidgetTool` and use the returned link, or use the logo link from their website. PNG with transparency is best |
| Roundness, buttons | `style.radius` (none, small, medium, large, pill), `style.button` (pill, rounded, square, underline) | Friendly brands: large or pill; serious ones: small |
| Label letter case | `style.eyebrow_case` (upper, title, none) | |
| Logo place and size | `style.logo_position` (top-left, top-right, bottom-left, bottom-right), `style.logo_size` (small, medium, large) | |
| Text over photos | `style.scrim` (auto, soft, strong, none) | Darkening behind text on photos; `auto` is a good default |
| Favorite layouts | `style.default_templates` | For example `{"story": "photo-headline", "square": "quote-card"}` |
| Photo look | `style.photo_style` | Plain text, for example "warm natural light, minimal, beige tones"; it is added to every AI image prompt |
| Voice traits, words to avoid, hashtags, language | `voice.tone_words`, `voice.avoid_words`, `voice.hashtags`, `voice.language` | Stored for reference (for example `es`); you still read the card to write copy |

If the user already has a Canva Brand Kit, mention it as another source of colors and fonts, but the saved brand in Marketing Images is what the graphics tools use.

## Example (fictional brand)

```
BRAND CARD — Café Lumbre

What we are: Specialty coffee shop in Palermo, Buenos Aires; coffee, pastries and beans to take home.
Goal of our posts: Visit the shop and order beans online.
Who we talk to:
- Neighbors 25–45 who work from cafés, care about quality and a calm place
- Tourists looking for good coffee in Palermo
Networks & frequency: Instagram 4/week, Facebook 1/week
Language(s): Spanish (Argentina); short English line for tourist posts
Time zone of our audience: Buenos Aires
Voice (3 traits):
1. Warm: we are friendly and personal; we are not cheesy. Sounds like: "Pasá, el café ya está listo."
2. Simple: we are plain and clear; we are not vague. Sounds like: "Granos tostados esta semana."
3. A bit funny: we are light; we never joke about customers. Sounds like: "Hoy el medialunas-meter está alto."
Tone by network:
- Instagram: relaxed, short, a few emojis
- Facebook: a bit more informative, one question to invite comments
Emojis: a few (☕️🥐)
Capitals and punctuation: no ALL CAPS, one exclamation mark at most
Words to avoid: "barato", "el mejor de Buenos Aires"
We never: talk about prices in posts, mention competitors, promise health benefits
Hashtags we always use: #CafeLumbre #PalermoCafe
Link for calls to action: https://cafelumbre.example/beans
Visual style: warm browns and cream, natural light photos, no filters, lots of space
Saved visual brand (Marketing Images): cafe-lumbre
Logo: saved in the visual brand
Learned:
- 2026-10-12: shorter captions work better; max 3 lines
```
