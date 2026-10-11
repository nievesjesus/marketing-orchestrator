// sharp docs: https://sharp.pixelplumbing.com/api-resize (cover crop) · https://sharp.pixelplumbing.com/api-output#raw · https://sharp.pixelplumbing.com/api-operation#flatten
import sharp from 'sharp';
import { UserFacingError } from '../errors.js';
import { hexToRgb, isValidHex, type RGB } from './color.js';
import type { FormatSpec } from './formats.js';
import { warn, type RenderWarning } from './warnings.js';

export interface BackgroundInput {
  image_url?: string | undefined;
  color?: string | undefined;
  gradient?: { from: string; to: string; angle?: number | undefined } | undefined;
}

export type BackgroundKind = 'photo' | 'color' | 'gradient';

export interface BuiltBackground {
  kind: BackgroundKind;
  /** Raw RGB, width x height x 3. */
  raw: Buffer;
}

/** Decompression-bomb guard for user-supplied photos. */
const MAX_INPUT_PIXELS = 80_000_000;

function solid(width: number, height: number, c: RGB): Buffer {
  const raw = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = c.r;
    raw[i + 1] = c.g;
    raw[i + 2] = c.b;
  }
  return raw;
}

/**
 * CSS-style linear gradient (0deg = to top, 90deg = to right, 180deg = to bottom), computed per pixel
 * so the result is exactly reproducible. https://developer.mozilla.org/en-US/docs/Web/CSS/gradient/linear-gradient
 */
function gradient(width: number, height: number, from: RGB, to: RGB, angleDeg: number): Buffer {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const length = Math.abs(width * dx) + Math.abs(height * dy);
  const raw = Buffer.allocUnsafe(width * height * 3);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = Math.min(1, Math.max(0, ((x + 0.5 - width / 2) * dx + (y + 0.5 - height / 2) * dy) / length + 0.5));
      raw[o++] = Math.round(from.r + (to.r - from.r) * t);
      raw[o++] = Math.round(from.g + (to.g - from.g) * t);
      raw[o++] = Math.round(from.b + (to.b - from.b) * t);
    }
  }
  return raw;
}

export async function buildBackground(
  input: BackgroundInput,
  format: FormatSpec,
  fetchImage: (url: string) => Promise<Buffer>,
  warnings: RenderWarning[],
): Promise<BuiltBackground> {
  const { width, height } = format;

  if (input.image_url) {
    const data = await fetchImage(input.image_url);
    try {
      const pipeline = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
      const meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      const swapped = (meta.orientation ?? 1) >= 5;
      const srcW = (swapped ? meta.height : meta.width) ?? width;
      const srcH = (swapped ? meta.width : meta.height) ?? height;
      if (Math.max(width / srcW, height / srcH) > 1.5) {
        warn(
          warnings,
          'low_resolution_photo',
          `The photo is small (${srcW}x${srcH}) for a ${width}x${height} image, so it may look soft.`,
          'Ask for a larger photo if the result looks blurry.',
        );
      }
      const raw = await pipeline
        .resize(width, height, { fit: 'cover', position: 'centre' })
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer();
      return { kind: 'photo', raw };
    } catch (err) {
      if (err instanceof UserFacingError) throw err;
      throw new UserFacingError(
        'image_decode_failed',
        'The background photo could not be read (it may be damaged).',
        'Ask for another photo, or use a color background.',
      );
    }
  }

  if (input.gradient) {
    const from = isValidHex(input.gradient.from) ? hexToRgb(input.gradient.from) : null;
    const to = isValidHex(input.gradient.to) ? hexToRgb(input.gradient.to) : null;
    if (!from || !to) throw new UserFacingError('invalid_color', 'The gradient colors must be hex colors such as #1F3A5F.');
    return { kind: 'gradient', raw: gradient(width, height, from, to, input.gradient.angle ?? 160) };
  }

  if (input.color !== undefined) {
    const rgb = isValidHex(input.color) ? hexToRgb(input.color) : null;
    if (!rgb) throw new UserFacingError('invalid_color', 'The background color must be a hex color such as #1F3A5F.');
    return { kind: 'color', raw: solid(width, height, rgb) };
  }

  throw new UserFacingError('missing_background', 'A background (image_url, color or gradient) is required.');
}
