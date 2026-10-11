# Design guide: custom layouts with `compose_custom`

Use `compose_custom` when no template in `visuals.md` can do what the user wants: a magazine cover, a price list, a before/after, a menu, a badge, a collage. You write the layout as HTML with **inline styles**; the server draws it with the brand fonts and colors, so text is sharp and spelled exactly. It is free (no AI cost), counts as one composed graphic, and the same input gives the same picture.

The loop: write the HTML → `compose_custom` → **look at the preview** and read `warnings` and `needs_attention` → fix → render again (at most twice) → show the user. Don't use an image whose `needs_attention` is true.

## 1. The frame

- The **outer element is exactly the canvas**:
  `<div style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;background:...">`
- **Inline styles only** (`style="..."`). No `<style>` blocks, classes, scripts or external links (all are ignored with a warning).
- **Images** must be declared in `assets` as `{"name": "https://..."}` (public JPEG, PNG, WebP or AVIF links, at most 8) and used as `<img src="{{asset.name}}">`. The logo is `{{brand.logo}}`.
- Widths and heights **don't include padding** unless you add `box-sizing:border-box`; otherwise the warning `root_larger_than_canvas` appears.
- Text typed straight into the HTML is read as HTML: write `&amp;` for &, and avoid `<`. Text passed through `variables` is always shown as plain text.
- Limits: HTML up to 50 KB, 200 elements, 8 images, 10 seconds per render.
- Formats (`format`): `square` 1080×1080, `portrait` 1080×1350, `story` 1080×1920, `landscape` 1920×1080, `link` 1200×627.

## 2. What you can use

**Elements:** `div`, `span`, `p`, `h1`–`h6`, `img`, `br`, `b`/`strong`, `i`/`em`, `u`, and inline `<svg>` (`path`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `rect`, `g`, `defs`, `linearGradient`, `radialGradient`, `stop`, `clipPath`). Other block tags (`section`, `header`, `ul`…) are drawn like `div`; tables are drawn as plain blocks (use flex rows instead); `script`, `style`, `iframe`, `video` and form elements are removed.

**CSS that works** (anything else is ignored with a `css_unsupported` warning):

| Group | Properties |
|---|---|
| Layout | `display` (`flex`, `grid`, `none`), `position` (`relative`, `absolute`) with `top` `right` `bottom` `left` `inset`, `width` `height` `min-*` `max-*` `aspect-ratio`, `margin`, `padding`, `box-sizing`, `overflow`, `z-index`, `gap` `row-gap` `column-gap`, `flex` `flex-direction` `flex-wrap` `flex-grow` `flex-shrink` `flex-basis`, `align-items` `align-self` `align-content` `justify-content` `order`, grid templates |
| Look | `color`, `background` / `background-color` / `background-image` (`linear-gradient`, `radial-gradient`) with `background-size` `background-position` `background-repeat` `background-clip`, `border` (and each side) `border-radius`, `outline`, `box-shadow`, `text-shadow`, `opacity`, `transform` (`rotate`, `scale`, `translate`) `transform-origin`, `object-fit` and `object-position` on images, `filter` (such as `blur()`), `mix-blend-mode`, `clip-path`, `mask-image`, `-webkit-text-stroke`, `-webkit-background-clip:text` |
| Text | `font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `word-spacing`, `text-transform`, `text-align`, `text-decoration`, `text-indent`, `text-wrap:balance`, `white-space`, `word-break`, `overflow-wrap`, `text-overflow`, `line-clamp` |

**Not supported:** classes and stylesheets, transitions and animations, `columns`, `writing-mode`, `direction`, pseudo-elements (`::before`), the `font` shorthand (write each part), `zoom`, `hyphens`, the `mask` shorthand (use `mask-image`), emoji, and values above 12,000 px (blur above 400 px). Images in `url()` must be embedded data, so use `<img>` with `assets` for photos.

**Fonts:** only the bundled families (Outfit, Work Sans, Bricolage Grotesque, Lora, Instrument Serif, Young Serif) and the brand's fonts. Prefer `font-family:{{brand.font.heading}}`, `{{brand.font.body}}`, `{{brand.font.accent}}`; an unknown family falls back to the brand font with a `font_unavailable` warning.

## 3. Tokens (replaced before drawing)

| Token | What it gives |
|---|---|
| `{{brand.color.primary}}`, `secondary`, `accent`, `ink`, `paper`, or an extra color name | Brand colors (aliases: `{{brand.primary}}`, `{{brand.accent}}`…) |
| `{{brand.font.heading}}`, `body`, `accent` | Font family names, for `font-family` |
| `{{brand.logo}}`, `{{brand.logo_light}}`, `{{brand.logo_dark}}` | Logo images, for `<img src>` (`logo_light` is for dark backgrounds) |
| `{{brand.radius}}` | Corner radius in px for this format |
| `{{brand.style.radius}}`, `button`, `eyebrow_case`, `eyebrow_transform`, `logo_position`, `logo_size`, `scrim`, `photo_style`; `{{brand.name}}` | The saved brand's style rules and name |
| `{{asset.<name>}}`, `{{asset.<name>.width}}`, `.height` | A declared image and its size |
| `{{var.<name>}}` | A text from `variables` (plain text, HTML-safe) |
| `{{format.width}}`, `height`, `name`, `scale` | The canvas (`scale` = short side ÷ 1080) |
| `{{px.<n>}}` | `n` pixels at the 1080 reference, scaled to the format: `font-size:{{px.40}}px` keeps proportions on every format |
| `{{safe.top}}`, `bottom`, `left`, `right`, `width`, `height` | The text-safe area (distance from each edge in px, and its size) |

**Auto-fit text:** add `data-fit` to a text element (optionally `data-fit-min`, `data-fit-max` in px and `data-fit-lines`) and the server picks the biggest font size that fits its box. The element must contain only text and have a width (`width:100%` or a fixed width). Add `data-decor` to an element to skip the safe-zone, overflow and contrast checks when an overlap or bleed is intentional.

## 4. Safe zones, sizes, contrast

- **Text stays inside the title-safe area** (10% margins); use `{{safe.*}}` instead of fixed numbers:

| Format | Text area (x from left, y from top) |
|---|---|
| square | 108–972, 108–972 |
| portrait | 108–972, 135–1215 |
| story | 108–972, 250–1520 (the top 250 px and bottom 400 px are covered by the app) |
| landscape | 192–1728, 108–972 |
| link | 120–1080, 63–564 |

- **Type minimums** (at the 1080 reference, so write them as `{{px.N}}`): main message at least 90 px, body at least 32 px, small labels at least 24 px. Nothing smaller: people read on phones.
- **Contrast:** aim for 4.5:1 (3:1 at least for very large text). The server measures the background behind each text and warns below about 3:1.
  - Text on a dark area: `{{brand.color.paper}}`. Text on a light area: `{{brand.color.ink}}`. A dark panel is `{{brand.color.ink}}`, a light one `{{brand.color.paper}}`; they stay right whatever the brand.
  - `primary` and `accent` can be mid-tones: use them for shapes and big accents, and check small text in them against the warnings (if a price in the accent color warns, make it `paper`).
  - Text over a photo needs a gradient overlay or a solid or semi-transparent panel behind it.

## 5. Warnings and what to do

`needs_attention: true` appears for the first five. Read the others too.

| Code | Meaning | Fix |
|---|---|---|
| `text_outside_safe_zone` | Text goes outside the safe area | Move it inside with `{{safe.*}}`, or `data-decor` if intended |
| `text_outside_canvas` | Text is cut off by the edge | Move it in, make its box narrower so it wraps, reduce the size, or use `data-fit` |
| `text_overflow` | Text is bigger than its box | Shorten it, enlarge the box, drop a fixed height, or use `data-fit` |
| `text_does_not_fit` | `data-fit` couldn't fit it even at the minimum size | Shorten the text, lower `data-fit-min`, allow more lines |
| `low_contrast` | Text is hard to read on its background | Change the text color, or put a panel or gradient behind it |
| `root_larger_than_canvas` | The outer element is bigger than the image | `box-sizing:border-box`, or reduce width and height |
| `css_unsupported`, `css_invalid_value`, `css_value_too_large` | A style was ignored | Use the hint in the warning (flex instead of columns, and so on) |
| `unsupported_characters` | Emoji or rare characters were removed | Remove them |
| `font_unavailable` | The font isn't available | Use `{{brand.font.*}}` or a bundled family |
| `asset_missing`, `variable_missing`, `unknown_token`, `asset_unused` | A token or name doesn't match | Fix the names in the HTML and in `assets` / `variables` |
| `external_url_blocked` | A web link was used for an image | Declare it in `assets` |
| `class_ignored`, `style_block_ignored`, `script_removed`, `html_tag_unsupported` | Not inline HTML | Inline styles and the elements in section 2 |
| `brand_logo_missing` | The brand has no logo | Save one in the brand, or drop the logo |

## 6. Three layouts that render cleanly

Written with the guide's own rules and checked with the renderer: they render without text warnings on the usual palettes. If a warning shows up with a particular brand, fix it as in section 5 (for example, a mid-tone accent color on small text). Replace the texts, keep the structure.

**A. Magazine cover** (`portrait`; asset `cover`; variables `issue`, `season`, `title`, `deck`, `byline`)

```html
<div style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.primary}}">
  <img src="{{asset.cover}}" style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;object-fit:cover" />
  <div style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;background-image:linear-gradient(to bottom, rgba(11,16,32,0.9) 0%, rgba(11,16,32,0.86) 46%, rgba(11,16,32,0.25) 64%, rgba(11,16,32,0.4) 74%, rgba(11,16,32,0.93) 100%)"></div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:{{safe.top}}px;display:flex;justify-content:space-between;color:{{brand.color.paper}};font-family:{{brand.font.accent}};font-size:{{px.26}}px;letter-spacing:{{px.6}}px;text-transform:uppercase">
    <span>{{var.issue}}</span><span>{{var.season}}</span>
  </div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:{{px.260}}px;display:flex;flex-direction:column;color:{{brand.color.paper}}">
    <div style="display:flex;width:{{px.90}}px;height:{{px.8}}px;background:{{brand.color.accent}};margin-bottom:{{px.34}}px"></div>
    <div data-fit data-fit-max="{{px.210}}" data-fit-min="{{px.90}}" data-fit-lines="3" style="display:flex;width:100%;font-family:{{brand.font.heading}};line-height:0.98">{{var.title}}</div>
  </div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;bottom:{{safe.bottom}}px;display:flex;flex-direction:column;color:{{brand.color.paper}}">
    <div data-fit data-fit-max="{{px.42}}" data-fit-min="{{px.28}}" data-fit-lines="3" style="display:flex;width:100%;font-family:{{brand.font.body}};line-height:1.3">{{var.deck}}</div>
    <div style="display:flex;margin-top:{{px.30}}px;font-family:{{brand.font.accent}};font-weight:700;font-size:{{px.28}}px;letter-spacing:{{px.4}}px;text-transform:uppercase;color:{{brand.color.accent}}">{{var.byline}}</div>
  </div>
</div>
```

**B. Price list** (`landscape` or `square`; no assets; the rows are typed in the HTML, so for real prices use the user's exact words and numbers, never invent them)

```html
<div style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.ink}};color:{{brand.color.paper}};font-family:{{brand.font.body}}">
  <div style="position:absolute;left:{{safe.left}}px;top:{{safe.top}}px;display:flex;flex-direction:column">
    <div style="display:flex;font-family:{{brand.font.accent}};font-size:{{px.26}}px;letter-spacing:{{px.6}}px;text-transform:uppercase;color:{{brand.color.accent}}">Autumn menu</div>
    <div style="display:flex;margin-top:{{px.12}}px;font-family:{{brand.font.heading}};font-size:{{px.84}}px;line-height:1.05">Prices at a glance</div>
  </div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:{{px.340}}px;display:flex;flex-direction:column;padding:{{px.10}}px {{px.40}}px;border-radius:{{brand.radius}}px;background:rgba(255,255,255,0.08)">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:{{px.20}}px 0;border-bottom:2px solid rgba(255,255,255,0.2)">
      <div style="display:flex;flex-direction:column"><div style="display:flex;font-family:{{brand.font.heading}};font-size:{{px.40}}px;font-weight:700">Espresso</div><div style="display:flex;font-size:{{px.26}}px;opacity:0.8">Single origin</div></div>
      <div style="display:flex;font-family:{{brand.font.heading}};font-size:{{px.44}}px;font-weight:700;color:{{brand.color.accent}}">$3</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;padding:{{px.20}}px 0">
      <div style="display:flex;flex-direction:column"><div style="display:flex;font-family:{{brand.font.heading}};font-size:{{px.40}}px;font-weight:700">Croissant</div><div style="display:flex;font-size:{{px.26}}px;opacity:0.8">Butter, baked daily</div></div>
      <div style="display:flex;font-family:{{brand.font.heading}};font-size:{{px.44}}px;font-weight:700;color:{{brand.color.accent}}">$3</div>
    </div>
  </div>
  <div style="position:absolute;left:{{safe.left}}px;bottom:{{safe.bottom}}px;display:flex;font-size:{{px.28}}px;opacity:0.85">Open daily 8:00 to 18:00 - example.com</div>
</div>
```

Add one row `div` per item (copy the row block). Two or three columns: put several column panels with `flex:1` inside one `display:flex` row.

**C. Before / after split** (`square` or `portrait`; assets `before`, `after`; variables `label_before`, `label_after`, `caption`)

```html
<div style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.primary}}">
  <img src="{{asset.before}}" style="position:absolute;left:0;top:0;width:50%;height:100%;object-fit:cover" />
  <img src="{{asset.after}}" style="position:absolute;left:50%;top:0;width:50%;height:100%;object-fit:cover" />
  <div style="position:absolute;left:50%;top:0;width:{{px.8}}px;height:100%;margin-left:-{{px.4}}px;background:{{brand.color.paper}}"></div>
  <div style="position:absolute;left:{{safe.left}}px;top:{{safe.top}}px;display:flex;padding:{{px.12}}px {{px.28}}px;border-radius:9999px;background:{{brand.color.ink}};color:{{brand.color.paper}};font-family:{{brand.font.accent}};font-weight:700;font-size:{{px.28}}px;letter-spacing:{{px.4}}px;text-transform:uppercase">{{var.label_before}}</div>
  <div style="position:absolute;right:{{safe.right}}px;top:{{safe.top}}px;display:flex;padding:{{px.12}}px {{px.28}}px;border-radius:9999px;background:{{brand.color.accent}};color:{{brand.color.ink}};font-family:{{brand.font.accent}};font-weight:700;font-size:{{px.28}}px;letter-spacing:{{px.4}}px;text-transform:uppercase">{{var.label_after}}</div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;bottom:{{safe.bottom}}px;display:flex;justify-content:center;padding:{{px.26}}px {{px.36}}px;border-radius:{{brand.radius}}px;background:{{brand.color.ink}};color:{{brand.color.paper}}">
    <div data-fit data-fit-max="{{px.54}}" data-fit-min="{{px.30}}" data-fit-lines="2" style="display:flex;justify-content:center;width:100%;text-align:center;font-family:{{brand.font.heading}};font-weight:700;line-height:1.15">{{var.caption}}</div>
  </div>
</div>
```

Use it only with photos the user really has (the real before and after); never generate fake results.

## 7. Turn a design into a reusable template

When the user loves a layout and will want it again (a weekly "before / after", a menu, a promo card), offer to keep it. Ask for a short name first.

1. Make sure every text that changes is a `{{var.<name>}}` and every photo a `{{asset.<name>}}` (layouts A and C above already are).
2. Call `save_template` with:
   - `name`: lower-case letters, digits and hyphens, 2–40 characters (for example `before-after`); it can't be a built-in name.
   - `description`: 5–300 characters on what it is for, so it can be found later.
   - `html`: the layout.
   - `variables`: one entry per placeholder: `name`, `kind` (`text` or `image`), `required` (default true), `max_chars` (texts: the longest it was designed for), `example` (**required** for required variables: a sample text, or a public https image link), `description` (a line for the next user).
   - `formats` (the formats it was designed for), `tags` (lower-case words), `brand` (the saved slug, used to draw the preview). Leave `shared` off unless the owner asks: shared templates are visible to everyone using that server.
3. The server first draws it with your examples; if that fails nothing is saved and you get the preview and warnings to fix. Saving the same name again creates a new version.
4. Use it later with `compose_post` (`template: "<name>"`, texts in `variables` or `texts`, images in `assets`; `background.image_url` fills an image variable called `background`) or as a `compose_carousel` slide. `list_templates` and `get_template` show what you saved.

```json
{
  "name": "before-after",
  "description": "Two photos side by side with Before and After tags and a caption bar. For makeovers, renovations and results.",
  "formats": ["square", "portrait"],
  "tags": ["before-after", "photo"],
  "variables": [
    {"name": "before", "kind": "image", "example": "<public link of a real before photo>", "description": "Left photo"},
    {"name": "after", "kind": "image", "example": "<public link of a real after photo>", "description": "Right photo"},
    {"name": "label_before", "kind": "text", "example": "Before", "max_chars": 12},
    {"name": "label_after", "kind": "text", "example": "After", "max_chars": 12},
    {"name": "caption", "kind": "text", "example": "One afternoon, new look", "max_chars": 40, "description": "Short line under the photos"}
  ],
  "html": "<layout C from above>"
}
```

Starting points: `get_template` returns a hand-written HTML equivalent of every built-in template (similar, not pixel-identical) that you can remix with `compose_custom`.
