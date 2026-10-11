// sharp compositing and raw output: https://sharp.pixelplumbing.com/api-composite · https://sharp.pixelplumbing.com/api-output
import sharp from 'sharp';
import { UserFacingError } from '../errors.js';
import { isResolvedBrand, resolveBrand, type BrandInput, type ResolvedBrand } from './brand.js';
import { buildBackground, type BackgroundInput, type BackgroundKind } from './background.js';
import { hexToRgb, type RGB } from './color.js';
import { resolveAppearance, sampleRegion, type ScrimMode } from './contrast.js';
import { applyCounter, type CounterSpec } from './counter.js';
import type { FontRegistry } from './fonts.js';
import { FORMATS, textSafeRect, type FormatName, type FormatSpec, type Rect } from './formats.js';
import { layoutText, type Layout, type TextsInput } from './layout.js';
import { logoRect, maxLogoHeight, placeLogo, prepareLogos, type LogoVariant } from './logo.js';
import { renderOverlay } from './overlay.js';
import { getTemplate, type Align, type TemplateSpec, type TextPosition } from './templates/index.js';
import { warn, type RenderWarning } from './warnings.js';

/**
 * compose_post pipeline (DESIGN section 5.1):
 * background (sharp cover-crop) -> sample luminance under the text -> fit text -> contrast/scrim decision
 * -> Satori overlay -> resvg -> composite -> logo (variant by luminance) -> optional counter chip -> encode.
 * Same input, same pixels.
 */

export type OutputChoice = 'auto' | 'png' | 'jpg';

export interface ComposeOptions {
  scrim?: ScrimMode | undefined;
  align?: Align | undefined;
  text_position?: TextPosition | undefined;
  output?: OutputChoice | undefined;
}

export interface ComposeInput {
  template: string;
  format: FormatName;
  background?: BackgroundInput | undefined;
  texts: TextsInput;
  /** An inline brand, or one already resolved (a saved brand). */
  brand?: BrandInput | ResolvedBrand | undefined;
  options?: ComposeOptions | undefined;
  /** Draw a "2/5" slide counter chip (carousels). */
  counter?: CounterSpec | undefined;
}

export interface ComposeDeps {
  fonts: FontRegistry;
  /** Download an image through fetchsafe. */
  fetchImage(url: string): Promise<Buffer>;
}

export interface ComposeOutput {
  data: Buffer;
  ext: 'png' | 'jpg';
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  warnings: RenderWarning[];
  /** The positioned text and shapes (not part of the tool output; used by tests and callers that need geometry). */
  layout: Layout;
  applied: {
    template: string;
    format: FormatName;
    background: BackgroundKind;
    scrim: 'none' | 'auto' | 'soft' | 'strong';
    logo: { variant: LogoVariant; plate: boolean } | null;
    /** The brand style fields that shaped this render. */
    style: { radius: string; button: string; eyebrow_case: string; logo_size: string; logo_corner: string };
    counter?: { corner: string };
  };
}

function expand(rect: Rect, px: number, width: number, height: number): Rect {
  const x = Math.max(0, rect.x - px);
  const y = Math.max(0, rect.y - px);
  return { x, y, w: Math.min(width, rect.x + rect.w + px) - x, h: Math.min(height, rect.y + rect.h + px) - y };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(1, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(1, Math.min(a.y + a.h, b.y + b.h) - y) };
}

function shrink(rect: Rect, px: number): Rect {
  return { x: rect.x + px, y: rect.y + px, w: Math.max(1, rect.w - 2 * px), h: Math.max(1, rect.h - 2 * px) };
}

/** Where the photo and the text panel of a `split` template go on this format. */
export function splitGeometry(spec: NonNullable<TemplateSpec['split']>, format: FormatSpec): { photo: Rect; panel: Rect } {
  const { side, share } = spec[format.name];
  const { width: W, height: H } = format;
  if (side === 'left' || side === 'right') {
    const w = Math.round(W * share);
    return side === 'left'
      ? { photo: { x: 0, y: 0, w, h: H }, panel: { x: w, y: 0, w: W - w, h: H } }
      : { photo: { x: W - w, y: 0, w, h: H }, panel: { x: 0, y: 0, w: W - w, h: H } };
  }
  const h = Math.round(H * share);
  return side === 'top'
    ? { photo: { x: 0, y: 0, w: W, h }, panel: { x: 0, y: h, w: W, h: H - h } }
    : { photo: { x: 0, y: H - h, w: W, h }, panel: { x: 0, y: 0, w: W, h: H - h } };
}

export async function composePost(input: ComposeInput, deps: ComposeDeps): Promise<ComposeOutput> {
  const warnings: RenderWarning[] = [];
  const template = getTemplate(input.template);
  if (!template) throw new UserFacingError('unknown_template', `There is no template called "${input.template}".`, 'Call list_templates to see the available ones.');
  const format = FORMATS[input.format];
  if (!input.texts.headline || input.texts.headline.trim() === '') {
    throw new UserFacingError('missing_headline', 'A headline is required.', 'Provide texts.headline (short, ideally under 60 characters).');
  }

  const brand = isResolvedBrand(input.brand) ? input.brand : resolveBrand(input.brand, deps.fonts, warnings);
  const fonts = brand.fontRegistry;
  const style = brand.style;
  const options = input.options ?? {};
  const align = options.align ?? template.defaults.align;
  const position = options.text_position ?? template.defaults.textPosition;
  // Priority: the call's option, then the brand's explicit preference, then the template's own default.
  const scrimMode: ScrimMode = options.scrim ?? (style.scrim !== 'auto' ? style.scrim : (template.scrim ?? 'auto'));

  // 1. Background.
  let backgroundInput = input.background;
  const hasBackground = backgroundInput && (backgroundInput.image_url || backgroundInput.color || backgroundInput.gradient);
  if (!hasBackground) {
    if (template.background === 'brand-primary') {
      backgroundInput = { color: brand.colors.primary };
    } else {
      backgroundInput = { gradient: { from: brand.colors.primary, to: brand.colors.ink, angle: 160 } };
      warn(warnings, 'default_background', 'No background was given, so a brand-color gradient was used.', 'Pass background.image_url with a photo for a photo post.');
    }
  }

  let region = textSafeRect(format);
  let bg: { kind: BackgroundKind; raw: Buffer };
  /** What the picture contains (for `applied`/output choice); `bg.kind` is what the TEXT sits on. */
  let pictureKind: BackgroundKind;
  const rawOpts = { raw: { width: format.width, height: format.height, channels: 3 as const } };
  if (template.split) {
    // Photo on one side, flat brand-primary panel with the text on the other.
    const { photo, panel } = splitGeometry(template.split, format);
    const pad = Math.round(Math.min(format.width, format.height) * 0.06);
    region = intersect(region, shrink(panel, pad));
    const photoBg = await buildBackground(backgroundInput as BackgroundInput, { ...format, width: photo.w, height: photo.h }, deps.fetchImage, warnings);
    const primary = hexToRgb(brand.colors.primary) as RGB;
    const base = Buffer.alloc(format.width * format.height * 3);
    for (let i = 0; i < base.length; i += 3) {
      base[i] = primary.r;
      base[i + 1] = primary.g;
      base[i + 2] = primary.b;
    }
    const raw = await sharp(base, rawOpts)
      .composite([{ input: photoBg.raw, raw: { width: photo.w, height: photo.h, channels: 3 }, left: photo.x, top: photo.y }])
      .removeAlpha()
      .raw()
      .toBuffer();
    bg = { kind: 'color', raw }; // the text sits on the flat panel
    pictureKind = photoBg.kind;
  } else {
    bg = await buildBackground(backgroundInput as BackgroundInput, format, deps.fetchImage, warnings);
    pictureKind = bg.kind;
  }

  // 2. Logo (optional): sized now so the text region can avoid it.
  const corner = brand.logoCorner ?? template.logo.corner;
  const logos = Object.keys(brand.logos).length > 0 ? await prepareLogos(brand.logos, format, deps.fetchImage, warnings, style.logo_size) : null;
  if (logos) {
    const reserved = logoRect(corner, format, Math.max(...Object.values(logos).map((l) => l.width)), maxLogoHeight(logos));
    const gap = Math.round(format.height * 0.02);
    if (corner.startsWith('top')) {
      const top = Math.max(region.y, reserved.y + reserved.h + gap);
      region = { ...region, y: top, h: Math.max(1, region.y + region.h - top) };
    } else {
      region = { ...region, h: Math.max(1, Math.min(region.h, reserved.y - gap - region.y)) };
    }
  }

  // 3. Fit text and place it.
  const layout = layoutText({ template, format, texts: input.texts, brand, fonts, region, align, position, warnings });

  // 4. Contrast: sample what is under the text, choose colors and scrim.
  const pad = Math.round(format.height * 0.04);
  const stats = sampleRegion(bg.raw, format.width, format.height, expand(layout.rect, pad, format.width, format.height));
  const look = resolveAppearance({
    brand,
    stats,
    backgroundKind: bg.kind,
    mode: scrimMode,
    hasButton: layout.button !== undefined || layout.badge !== undefined || layout.chip !== undefined,
    warnings,
  });

  // 5. Overlay (scrim + text + button) and composite.
  const overlay = await renderOverlay({ format, layout, look, style });
  let composed: Buffer = await sharp(bg.raw, rawOpts).composite([{ input: overlay, left: 0, top: 0 }]).removeAlpha().raw().toBuffer();

  // 6. Logo on top, variant chosen from what is now under the corner.
  let logoApplied: ComposeOutput['applied']['logo'] = null;
  if (logos) {
    const probe = logoRect(corner, format, Object.values(logos)[0]!.width, Object.values(logos)[0]!.height);
    const cornerMean: RGB = sampleRegion(composed, format.width, format.height, probe, 2).mean;
    const placement = await placeLogo({ logos, corner, format, cornerMean, inkHex: brand.colors.ink, paperHex: brand.colors.paper });
    composed = await sharp(composed, rawOpts)
      .composite([{ input: placement.layer, left: placement.left, top: placement.top }])
      .removeAlpha()
      .raw()
      .toBuffer();
    logoApplied = { variant: placement.variant, plate: placement.plate };
  }

  // 6b. Carousel counter chip (never in the logo's corner).
  let counterApplied: { corner: string } | undefined;
  if (input.counter) {
    const counted = await applyCounter(composed, format, brand, input.counter, logos ? corner : undefined);
    composed = counted.raw;
    counterApplied = { corner: counted.corner };
  }

  // 7. Encode.
  const ext: 'png' | 'jpg' = options.output === 'png' ? 'png' : options.output === 'jpg' ? 'jpg' : pictureKind === 'photo' ? 'jpg' : 'png';
  const encoder = sharp(composed, rawOpts);
  const data =
    ext === 'png'
      ? await encoder.png({ compressionLevel: 9 }).toBuffer()
      : await encoder.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();

  return {
    data,
    ext,
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    width: format.width,
    height: format.height,
    warnings,
    layout,
    applied: {
      template: template.id,
      format: format.name,
      background: pictureKind,
      scrim: look.scrim ? (look.scrim.strong ? 'strong' : look.scrim.soft ? 'soft' : 'auto') : 'none',
      logo: logoApplied,
      style: { radius: style.radius, button: style.button, eyebrow_case: style.eyebrow_case, logo_size: style.logo_size, logo_corner: corner },
      ...(counterApplied ? { counter: counterApplied } : {}),
    },
  };
}
