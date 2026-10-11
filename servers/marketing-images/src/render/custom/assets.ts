// sharp resize/format: https://sharp.pixelplumbing.com/api-resize · https://sharp.pixelplumbing.com/api-output
import sharp from 'sharp';
import { UserFacingError, isUserFacingError } from '../../errors.js';
import type { LogoSource } from '../brand.js';
import { warn, type RenderWarning } from '../warnings.js';
import type { AssetData } from './tokens.js';

/**
 * Assets for compose_custom: every image the layout uses is DECLARED (`assets: {name: https-url}`, at most 8), downloaded through
 * `fetchImage` (= fetchsafe: https only, no private addresses, size/type checks) and EMBEDDED as a data URI. Satori never fetches anything itself.
 */

export const MAX_ASSETS = 8;
export const ASSET_NAME_RE = /^[a-z][a-z0-9_-]{0,29}$/;
/** Longest side kept for embedded images: 2x the largest canvas side is plenty and keeps the SVG small. */
const MAX_SIDE = 2000;
const MAX_INPUT_PIXELS = 80_000_000;

export type DeclaredAssets = Record<string, string | Buffer>;

export function validateAssetNames(declared: DeclaredAssets): void {
  const names = Object.keys(declared);
  if (names.length > MAX_ASSETS) {
    throw new UserFacingError('too_many_assets', `At most ${MAX_ASSETS} assets can be used in one layout (got ${names.length}).`, 'Combine images or drop the ones that are not essential.');
  }
  for (const name of names) {
    if (!ASSET_NAME_RE.test(name)) {
      throw new UserFacingError('asset_name_invalid', `The asset name "${name}" is not valid.`, 'Use lower-case letters, digits, "-" and "_" (start with a letter, max 30), e.g. "hero" or "photo-2".');
    }
  }
}

/** Decode, bake in the EXIF rotation, shrink to MAX_SIDE, and re-encode (PNG when it has transparency, JPEG otherwise). */
export async function embedImage(data: Buffer, maxSide = MAX_SIDE): Promise<AssetData> {
  const base = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
  const meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const pipeline = base.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
  const { data: out, info } = meta.hasAlpha
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
    : await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const mime = meta.hasAlpha ? 'image/png' : 'image/jpeg';
  const small = sharp(out).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true });
  const thumb = meta.hasAlpha ? await small.png().toBuffer() : await small.jpeg({ quality: 60 }).toBuffer();
  return { uri: `data:${mime};base64,${out.toString('base64')}`, width: info.width, height: info.height, thumb: `data:${mime};base64,${thumb.toString('base64')}` };
}

export async function loadAssets(
  declared: DeclaredAssets,
  referenced: ReadonlySet<string>,
  fetchImage: (url: string) => Promise<Buffer>,
  warnings: RenderWarning[],
): Promise<Map<string, AssetData>> {
  validateAssetNames(declared);
  const used = Object.keys(declared).filter((name) => referenced.has(`asset.${name}`) || [...referenced].some((t) => t.startsWith(`asset.${name}.`)));
  for (const name of Object.keys(declared)) {
    if (!used.includes(name)) warn(warnings, 'asset_unused', `The asset "${name}" was declared but the HTML never uses {{asset.${name}}}.`, 'Use it in an <img src> or background-image, or remove it.');
  }
  const loaded = await Promise.all(
    used.map(async (name) => {
      const source = declared[name] as string | Buffer;
      try {
        const bytes = typeof source === 'string' ? await fetchImage(source) : source;
        return [name, await embedImage(bytes)] as const;
      } catch (err) {
        const reason = isUserFacingError(err) ? err.message : 'the file could not be read as an image.';
        throw new UserFacingError('asset_failed', `The image for asset "${name}" could not be used: ${reason}`, 'Check that the link is a public https link to a JPEG, PNG, WebP or AVIF file, or use another image.');
      }
    }),
  );
  return new Map(loaded);
}

/** Logo as an embedded PNG/JPEG data URI for {{brand.logo}} tokens (links are downloaded, stored files are read). */
export async function embedLogo(source: LogoSource, fetchImage: (url: string) => Promise<Buffer>): Promise<AssetData> {
  const bytes = typeof source === 'string' ? await fetchImage(source) : source;
  return embedImage(bytes, 1200);
}
