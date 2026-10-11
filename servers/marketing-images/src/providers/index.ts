import sharp from 'sharp';
import type { AppContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import { sniffFormat } from '../fetchsafe.js';
import type { ProviderId } from '../models.js';
import { FalAdapter } from './fal.js';
import { GeminiAdapter, MAX_INLINE_REFERENCE_BYTES } from './gemini.js';
import { LeonardoAdapter } from './leonardo.js';
import type { AdapterDeps, LoadedImage, ProviderAdapter } from './types.js';

export type Adapters = Partial<Record<ProviderId, ProviderAdapter>>;

/**
 * Download a user-supplied reference through the SSRF guard and prepare it for an inline request.
 * Gemini accepts PNG, JPEG and WebP; AVIF is converted to PNG.
 */
export async function loadReference(ctx: Pick<AppContext, 'fetchImage'>, url: string): Promise<LoadedImage> {
  let data = await ctx.fetchImage(url);
  const sniffed = sniffFormat(data, 'image');
  let mime = sniffed?.mime ?? 'image/png';
  if (sniffed?.format === 'avif' || !sniffed) {
    data = await sharp(data).png().toBuffer();
    mime = 'image/png';
  }
  if (data.length > MAX_INLINE_REFERENCE_BYTES) {
    throw new UserFacingError('reference_too_large', 'One of the reference images is too large to send to the model.', 'Use a smaller version of the photo (a normal social-media size is plenty).');
  }
  return { mime, base64: data.toString('base64'), bytes: data.length };
}

/** One adapter per provider whose key is configured. Providers without a key are simply absent. */
export function createAdapters(ctx: AppContext): Adapters {
  const deps = (apiKey: string): AdapterDeps => ({
    apiKey,
    fetch: (input, init) => ctx.providerFetch(input, init), // looked up per call, so a replaced fetch is honoured
    loadImage: (url) => loadReference(ctx, url),
    now: () => Date.now(),
  });
  const adapters: Adapters = {};
  if (ctx.config.keys.gemini) adapters.gemini = new GeminiAdapter(deps(ctx.config.keys.gemini));
  if (ctx.config.keys.fal) adapters.fal = new FalAdapter(deps(ctx.config.keys.fal));
  if (ctx.config.keys.leonardo) adapters.leonardo = new LeonardoAdapter(deps(ctx.config.keys.leonardo));
  return adapters;
}

const cache = new WeakMap<AppContext, Adapters>();

/** Adapters for a context, built once (the keys never change while the process runs). */
export function adaptersFor(ctx: AppContext): Adapters {
  let adapters = cache.get(ctx);
  if (!adapters) {
    adapters = createAdapters(ctx);
    cache.set(ctx, adapters);
  }
  return adapters;
}
