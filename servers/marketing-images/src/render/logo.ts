// resvg-js (SVG plate -> PNG): https://github.com/yisibl/resvg-js · sharp resize/composite: https://sharp.pixelplumbing.com/api-resize
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { UserFacingError } from '../errors.js';
import { luma, rgba, type RGB } from './color.js';
import { LOGO_WIDTH_BY_SIZE, type LogoSize, type ResolvedBrand } from './brand.js';
import { graphicSafeY, LOGO_MARGIN, type FormatSpec, type Rect } from './formats.js';
import type { LogoCorner } from './templates/index.js';
import { warn, type RenderWarning } from './warnings.js';

/**
 * Logo overlay. Variant choice and sizing are ported from
 *   tools/scripts/mktlib/imaging.py  overlay_logo(): look at the corner where the logo goes;
 *   light background -> dark logo, dark background -> light logo, otherwise the primary logo.
 * Differences: the corner is sampled on the already-composited image (after scrim and text), and when
 * only one logo is available a subtle contrast plate is added instead of failing.
 */

export type LogoVariant = 'primary' | 'light' | 'dark';

export interface PreparedLogoVariant {
  png: Buffer;
  width: number;
  height: number;
  /** Alpha-weighted mean luma of the visible pixels, 0..1. */
  luma: number;
}

export type PreparedLogos = Partial<Record<LogoVariant, PreparedLogoVariant>>;

const VARIANT_ORDER: readonly LogoVariant[] = ['primary', 'light', 'dark'];
/** Wide logos use 16 % of the width; tall ones are capped so they never dominate (share of the short side). */
const MAX_HEIGHT_SHARE = 0.14;

export function logoTargetWidth(format: FormatSpec, size: LogoSize = 'medium'): number {
  return Math.round(format.width * LOGO_WIDTH_BY_SIZE[size]);
}

async function prepareOne(data: Buffer, format: FormatSpec, size: LogoSize): Promise<PreparedLogoVariant> {
  const targetW = logoTargetWidth(format, size);
  const maxH = Math.round(Math.min(format.width, format.height) * MAX_HEIGHT_SHARE * (LOGO_WIDTH_BY_SIZE[size] / LOGO_WIDTH_BY_SIZE.medium));
  const { data: png, info } = await sharp(data, { limitInputPixels: 40_000_000 })
    .rotate()
    .ensureAlpha()
    .resize({ width: targetW, height: maxH, fit: 'inside' })
    .png()
    .toBuffer({ resolveWithObject: true });

  const small = await sharp(png).resize({ width: 48, height: 48, fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  let weight = 0;
  let sum = 0;
  for (let i = 0; i < small.data.length; i += 4) {
    const a = (small.data[i + 3] as number) / 255;
    if (a < 0.1) continue;
    weight += a;
    sum += a * luma({ r: small.data[i] as number, g: small.data[i + 1] as number, b: small.data[i + 2] as number });
  }
  return { png, width: info.width, height: info.height, luma: weight > 0 ? sum / weight : 0.5 };
}

/** Downloads (links) or reads (stored files of a saved brand) and sizes every provided logo variant. A broken logo is reported, not fatal. */
export async function prepareLogos(
  logos: ResolvedBrand['logos'],
  format: FormatSpec,
  fetchImage: (url: string) => Promise<Buffer>,
  warnings: RenderWarning[],
  size: LogoSize = 'medium',
): Promise<PreparedLogos | null> {
  const out: PreparedLogos = {};
  for (const variant of VARIANT_ORDER) {
    const source = logos[variant === 'primary' ? 'primary' : variant];
    if (!source) continue;
    try {
      out[variant] = await prepareOne(typeof source === 'string' ? await fetchImage(source) : source, format, size);
    } catch (err) {
      const reason = err instanceof UserFacingError ? err.message : 'the file could not be read.';
      warn(warnings, 'logo_failed', `The ${variant} logo could not be used: ${reason}`, 'Check the logo link (PNG, JPEG, WebP or AVIF), or continue without a logo.');
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Largest height among the variants, used to reserve space before the variant is known. */
export function maxLogoHeight(logos: PreparedLogos): number {
  return Math.max(...Object.values(logos).map((l) => l.height));
}

export function logoRect(corner: LogoCorner, format: FormatSpec, width: number, height: number): Rect {
  const m = Math.round(Math.min(format.width, format.height) * LOGO_MARGIN);
  const safe = graphicSafeY(format);
  const x = corner.endsWith('left') ? m : format.width - width - m;
  const y = corner.startsWith('top') ? safe.top : safe.bottom - height;
  return { x, y, w: width, h: height };
}

/** Port of the `variant="auto"` branch of overlay_logo(). */
export function chooseVariant(cornerLuma: number, available: readonly LogoVariant[]): LogoVariant {
  const prefer: LogoVariant[] = cornerLuma > 0.6 ? ['dark', 'primary'] : cornerLuma < 0.4 ? ['light', 'primary'] : ['primary'];
  const picked = prefer.find((v) => available.includes(v));
  return picked ?? (VARIANT_ORDER.find((v) => available.includes(v)) as LogoVariant);
}

export interface LogoPlacement {
  layer: Buffer;
  left: number;
  top: number;
  variant: LogoVariant;
  plate: boolean;
}

export interface PlacementArgs {
  logos: PreparedLogos;
  corner: LogoCorner;
  format: FormatSpec;
  /** Mean RGB of the composited image under the logo corner. */
  cornerMean: RGB;
  inkHex: string;
  paperHex: string;
}

/** Decide variant and plate, then build the layer to composite. */
export async function placeLogo(args: PlacementArgs): Promise<LogoPlacement> {
  const { logos, corner, format } = args;
  const available = VARIANT_ORDER.filter((v) => logos[v]);
  const cornerLuma = luma(args.cornerMean);
  const variant = chooseVariant(cornerLuma, available);
  const logo = logos[variant] as PreparedLogoVariant;

  // A light/dark variant picked for the right background needs no help; a single logo might.
  const matched = (variant === 'dark' && cornerLuma > 0.6) || (variant === 'light' && cornerLuma < 0.4);
  const needsPlate = !matched && Math.abs(logo.luma - cornerLuma) < 0.3;

  if (!needsPlate) {
    const rect = logoRect(corner, format, logo.width, logo.height);
    return { layer: logo.png, left: rect.x, top: rect.y, variant, plate: false };
  }

  // Subtle rounded plate: light plate behind a dark logo, dark plate behind a light one.
  const pad = Math.round(Math.min(logo.width, logo.height) * 0.22);
  const plateW = logo.width + 2 * pad;
  const plateH = logo.height + 2 * pad;
  const fill = logo.luma > 0.5 ? rgba(args.inkHex, 0.7) : rgba(args.paperHex, 0.86);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${plateW}" height="${plateH}"><rect width="${plateW}" height="${plateH}" rx="${pad}" fill="${fill}"/></svg>`;
  const plate = new Resvg(svg).render().asPng();
  const layer = await sharp(plate)
    .composite([{ input: logo.png, left: pad, top: pad }])
    .png()
    .toBuffer();
  const rect = logoRect(corner, format, plateW, plateH);
  return { layer, left: rect.x, top: rect.y, variant, plate: true };
}
