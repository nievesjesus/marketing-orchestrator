import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PREVIEW_BUDGET_BYTES, PREVIEW_MAX_SIDE, PreviewBudget, makePreview } from '../src/render/preview.js';

/** Incompressible noise: the worst case for JPEG size. */
function noise(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 12345;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[i] = seed >>> 24;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('previews', () => {
  it('are JPEGs of at most 768 px that fit the shared 90 KB budget', async () => {
    const budget = new PreviewBudget();
    expect(budget.remaining).toBe(PREVIEW_BUDGET_BYTES);
    const preview = await makePreview(await noise(1080, 1920), budget.remaining);
    expect(preview).not.toBeNull();
    expect(preview!.data.length).toBeLessThanOrEqual(90 * 1024);
    expect(Math.max(preview!.width, preview!.height)).toBeLessThanOrEqual(PREVIEW_MAX_SIDE);
    expect(preview!.mimeType).toBe('image/jpeg');
    expect((await sharp(preview!.data).metadata()).format).toBe('jpeg');
  });

  it('keep the aspect ratio and never upscale', async () => {
    const small = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#336699' } }).png().toBuffer();
    const p = await makePreview(small, 90 * 1024);
    expect(p).toMatchObject({ width: 200, height: 100 });
    const wide = await makePreview(await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#336699' } }).png().toBuffer(), 90 * 1024);
    expect(wide).toMatchObject({ width: 768, height: 432 });
  });

  it('share one budget across several images and give up when it is exhausted', async () => {
    const budget = new PreviewBudget(40 * 1024);
    const img = await noise(600, 600);
    const first = await makePreview(img, budget.remaining);
    expect(first).not.toBeNull();
    budget.consume(first!.data.length);
    const second = await makePreview(img, budget.remaining);
    if (second) budget.consume(second.data.length);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
    expect(await makePreview(img, 100)).toBeNull(); // 100 bytes is never enough
  });
});
