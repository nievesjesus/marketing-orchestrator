import { Resvg } from '@resvg/resvg-js';
// Satori renders a plain { type, props } element tree: https://github.com/vercel/satori#documentation
import satori from 'satori';
import sharp from 'sharp';
import type { ResolvedBrand } from './brand.js';
import { luma, rgba } from './color.js';
import { sampleRegion } from './contrast.js';
import { DEFAULT_HEADING_FAMILY } from './fonts.js';
import { scaleOf, type FormatSpec } from './formats.js';
import { logoRect } from './logo.js';
import type { LogoCorner } from './templates/index.js';
import { TextMeter } from './fit.js';

/**
 * Slide counter chip for carousels ("2/5"): a small pill in a corner, drawn on the finished raw image.
 * The text is 30 px at the 1080-px reference (above the 24-px label floor), the pill sits in the same
 * margins and safe bands as the logo, and its colors follow what is under it (dark pill on light areas, light pill on dark ones).
 */

export interface CounterSpec {
  /** 1-based position of this slide. */
  index: number;
  total: number;
  position?: LogoCorner | undefined;
}

const MIRROR: Record<LogoCorner, LogoCorner> = {
  'bottom-right': 'bottom-left',
  'bottom-left': 'bottom-right',
  'top-right': 'top-left',
  'top-left': 'top-right',
};

export interface CounterResult {
  raw: Buffer;
  corner: LogoCorner;
}

/** Draws the chip on `raw` (RGB, format.width x format.height) and returns the new raw image. `avoid` is the corner the logo uses. */
export async function applyCounter(raw: Buffer, format: FormatSpec, brand: ResolvedBrand, counter: CounterSpec, avoid?: LogoCorner): Promise<CounterResult> {
  const text = `${counter.index}/${counter.total}`;
  const scale = scaleOf(format);
  const size = Math.round(30 * scale);
  const face = brand.fontRegistry.resolve(brand.fonts.accent, DEFAULT_HEADING_FAMILY, 700, false).face;
  const meter = new TextMeter(face);
  const padX = Math.round(size * 0.75);
  const padY = Math.round(size * 0.38);
  const textW = Math.ceil(meter.emWidth(text) * size);
  const w = textW + 2 * padX;
  const h = size + 2 * padY;

  let corner = counter.position ?? 'bottom-right';
  if (avoid && avoid === corner) corner = MIRROR[corner];
  const rect = logoRect(corner, format, w, h);

  const stats = sampleRegion(raw, format.width, format.height, rect, 2);
  const onLight = luma(stats.mean) > 0.55;
  const background = onLight ? rgba(brand.colors.ink, 0.8) : rgba(brand.colors.paper, 0.88);
  const color = onLight ? brand.colors.paper : brand.colors.ink;

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: w,
          height: h,
          borderRadius: Math.round(h / 2),
          backgroundColor: background,
          color,
          fontFamily: face.family,
          fontWeight: face.weight,
          fontSize: size,
          lineHeight: 1,
          whiteSpace: 'nowrap',
        },
        children: text,
      },
    } as never,
    { width: w, height: h, fonts: [{ name: face.family, data: face.data, weight: face.weight as 400 | 700, style: 'normal' as const }] },
  );
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: w }, font: { loadSystemFonts: false } }).render().asPng();
  const rawOpts = { raw: { width: format.width, height: format.height, channels: 3 as const } };
  const out = await sharp(raw, rawOpts).composite([{ input: png, left: rect.x, top: rect.y }]).removeAlpha().raw().toBuffer();
  return { raw: out, corner };
}
