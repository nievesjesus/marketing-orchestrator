import { estimateImageUsd, type ModelEntry } from '../models.js';

/** The size token a model will really use for a requested size (models with a single size ignore the request). */
export function effectiveSize(model: ModelEntry, size?: string): string {
  return size && model.sizes.includes(size) ? size : (model.sizes[0] as string);
}

/** Catalog price of one image, in USD. */
export function perImageUsd(model: ModelEntry, size?: string): number {
  return estimateImageUsd(model, effectiveSize(model, size));
}

/** Catalog price of `n` images, rounded to a tenth of a cent of a cent (micro-dollars) to avoid float noise. */
export function estimateUsd(model: ModelEntry, size: string | undefined, n: number): number {
  return Math.round(perImageUsd(model, size) * n * 1_000_000) / 1_000_000;
}
