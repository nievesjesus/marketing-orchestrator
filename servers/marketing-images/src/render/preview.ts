import sharp from 'sharp';

/**
 * Small JPEG previews for MCP image content. claude.ai moves tool results above ~150k characters to its
 * sandbox and Claude Code caps results at 25k tokens, so previews are <= 768 px and share a byte budget
 * per call (DESIGN section 5). Docs: https://sharp.pixelplumbing.com/api-output#jpeg
 */

export const PREVIEW_MAX_SIDE = 768;
export const PREVIEW_BUDGET_BYTES = 90 * 1024;

export class PreviewBudget {
  private left: number;

  constructor(total = PREVIEW_BUDGET_BYTES) {
    this.left = total;
  }

  get remaining(): number {
    return this.left;
  }

  consume(bytes: number): void {
    this.left = Math.max(0, this.left - bytes);
  }
}

export interface Preview {
  data: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}

/** Returns a preview within `budgetBytes` (shrinking quality, then size), or null if even the smallest is too big. */
export async function makePreview(image: Buffer, budgetBytes: number): Promise<Preview | null> {
  const attempts: { side: number; quality: number }[] = [
    { side: PREVIEW_MAX_SIDE, quality: 72 },
    { side: PREVIEW_MAX_SIDE, quality: 58 },
    { side: 640, quality: 55 },
    { side: 512, quality: 50 },
    { side: 384, quality: 45 },
    { side: 256, quality: 40 },
  ];
  for (const { side, quality } of attempts) {
    const { data, info } = await sharp(image)
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.length <= budgetBytes) return { data, mimeType: 'image/jpeg', width: info.width, height: info.height };
  }
  return null;
}
