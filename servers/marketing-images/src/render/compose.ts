// sharp compositing and raw output: https://sharp.pixelplumbing.com/api-composite · https://sharp.pixelplumbing.com/api-output
import sharp from 'sharp';
import { UserFacingError } from '../errors.js';
import { resolveBrand, type BrandInput } from './brand.js';
import { buildBackground, type BackgroundInput, type BackgroundKind } from './background.js';
import type { RGB } from './color.js';
import { resolveAppearance, sampleRegion, type ScrimMode } from './contrast.js';
import type { FontRegistry } from './fonts.js';
import { FORMATS, textSafeRect, type FormatName, type Rect } from './formats.js';
import { layoutText, type TextsInput } from './layout.js';
import { logoRect, maxLogoHeight, placeLogo, prepareLogos, type LogoVariant } from './logo.js';
import { renderOverlay } from './overlay.js';
import { getTemplate, type Align, type TextPosition } from './templates/index.js';
import { warn, type RenderWarning } from './warnings.js';

/**
 * compose_post pipeline (DESIGN section 5.1):
 * background (sharp cover-crop) -> sample luminance under the text -> fit text -> contrast/scrim decision
 * -> Satori overlay -> resvg -> composite -> logo (variant by luminance) -> encode.
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
  brand?: BrandInput | undefined;
  options?: ComposeOptions | undefined;
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
  applied: {
    template: string;
    format: FormatName;
    background: BackgroundKind;
    scrim: 'none' | 'auto' | 'strong';
    logo: { variant: LogoVariant; plate: boolean } | null;
  };
}

function expand(rect: Rect, px: number, width: number, height: number): Rect {
  const x = Math.max(0, rect.x - px);
  const y = Math.max(0, rect.y - px);
  return { x, y, w: Math.min(width, rect.x + rect.w + px) - x, h: Math.min(height, rect.y + rect.h + px) - y };
}

export async function composePost(input: ComposeInput, deps: ComposeDeps): Promise<ComposeOutput> {
  const warnings: RenderWarning[] = [];
  const template = getTemplate(input.template);
  if (!template) throw new UserFacingError('unknown_template', `There is no template called "${input.template}".`, 'Call list_templates to see the available ones.');
  const format = FORMATS[input.format];
  if (!input.texts.headline || input.texts.headline.trim() === '') {
    throw new UserFacingError('missing_headline', 'A headline is required.', 'Provide texts.headline (short, ideally under 60 characters).');
  }

  const brand = resolveBrand(input.brand, deps.fonts, warnings);
  const options = input.options ?? {};
  const align = options.align ?? template.defaults.align;
  const position = options.text_position ?? template.defaults.textPosition;
  const scrimMode: ScrimMode = options.scrim ?? 'auto';

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
  const bg = await buildBackground(backgroundInput as BackgroundInput, format, deps.fetchImage, warnings);

  // 2. Logo (optional): sized now so the text region can avoid it.
  const corner = brand.logoCorner ?? template.logo.corner;
  const logos = Object.keys(brand.logos).length > 0 ? await prepareLogos(brand.logos, format, deps.fetchImage, warnings) : null;
  let region = textSafeRect(format);
  if (logos) {
    const reserved = logoRect(corner, format, Math.max(...Object.values(logos).map((l) => l.width)), maxLogoHeight(logos));
    const gap = Math.round(format.height * 0.02);
    if (corner.startsWith('top')) {
      const top = Math.max(region.y, reserved.y + reserved.h + gap);
      region = { ...region, y: top, h: region.y + region.h - top };
    } else {
      region = { ...region, h: Math.min(region.h, reserved.y - gap - region.y) };
    }
  }

  // 3. Fit text and place it.
  const layout = layoutText({ template, format, texts: input.texts, brand, fonts: deps.fonts, region, align, position, warnings });

  // 4. Contrast: sample what is under the text, choose colors and scrim.
  const pad = Math.round(format.height * 0.04);
  const stats = sampleRegion(bg.raw, format.width, format.height, expand(layout.rect, pad, format.width, format.height));
  const look = resolveAppearance({
    brand,
    stats,
    backgroundKind: bg.kind,
    mode: scrimMode,
    hasButton: layout.button !== undefined,
    warnings,
  });

  // 5. Overlay (scrim + text + button) and composite.
  const overlay = await renderOverlay({ format, layout, look });
  const rawOpts = { raw: { width: format.width, height: format.height, channels: 3 as const } };
  let composed = await sharp(bg.raw, rawOpts).composite([{ input: overlay, left: 0, top: 0 }]).removeAlpha().raw().toBuffer();

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

  // 7. Encode.
  const ext: 'png' | 'jpg' = options.output === 'png' ? 'png' : options.output === 'jpg' ? 'jpg' : bg.kind === 'photo' ? 'jpg' : 'png';
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
    applied: {
      template: template.id,
      format: format.name,
      background: bg.kind,
      scrim: look.scrim ? (look.scrim.strong ? 'strong' : 'auto') : 'none',
      logo: logoApplied,
    },
  };
}

