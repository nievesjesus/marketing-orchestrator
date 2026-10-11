import sharp from 'sharp';
import type { ProviderId } from '../models.js';
import { RATIOS, type Ratio } from '../models.js';
import type { Storage } from '../storage.js';
import { providerError } from './errors.js';

/**
 * Provider outputs are copied into OUR storage and handed out as our own URLs, never hot-linked: the providers'
 * file URLs expire or are tied to their account (DESIGN section 6).
 */

export interface StoredOutput {
  key: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
  /** The stored bytes (kept in memory only to build the preview; never persisted in a job). */
  data: Buffer;
}

/** PNG and JPEG are stored as they are; anything else (WebP, AVIF) is converted to PNG. Garbage is a provider error. */
export async function ingestOutput(storage: Storage, data: Buffer, provider: ProviderId): Promise<StoredOutput> {
  let width: number;
  let height: number;
  let bytes = data;
  let ext: 'png' | 'jpg';
  try {
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    const rotated = (meta.orientation ?? 1) >= 5;
    width = rotated ? meta.height : meta.width;
    height = rotated ? meta.width : meta.height;
    if (meta.format === 'jpeg') {
      ext = 'jpg';
    } else if (meta.format === 'png') {
      ext = 'png';
    } else {
      ext = 'png';
      bytes = await sharp(data).png().toBuffer();
    }
  } catch {
    throw providerError('server', provider);
  }
  const stored = await storage.put(bytes, ext);
  return { key: stored.key, url: stored.url, width, height, bytes: stored.bytes, contentType: stored.contentType, data: bytes };
}

/** The public ratio closest to an image's shape (used when an edit does not say which ratio it wants). */
export function nearestRatio(width: number, height: number): Ratio {
  const actual = Math.log(width / height);
  let best: Ratio = '1:1';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of RATIOS) {
    const [w, h] = ratio.split(':').map(Number) as [number, number];
    const distance = Math.abs(Math.log(w / h) - actual);
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}
