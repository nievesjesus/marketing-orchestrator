import { blend, contrastRatio, type RGB } from '../color.js';
import { sampleRegion } from '../contrast.js';
import { textSafeRect, type FormatSpec } from '../formats.js';
import type { ResolvedBrand } from '../brand.js';
import { warn, type RenderWarning } from '../warnings.js';
import { parseColor, pxValue } from './css.js';
import type { Box } from './datafit.js';
import { hasDirectText, labelOf, walk, type HChild, type HElement } from './html.js';

/**
 * Post-render checks for compose_custom (DESIGN section 5.2), based on Satori's `onNodeDetected` callback.
 *
 * What the callback gives (verified against satori 0.47.1: `dist/*.d.ts` `SatoriOptions.onNodeDetected`, and by experiment):
 * called once per element AFTER layout with `{left, top, width, height, type, key, props, textContent}` in absolute canvas pixels
 * (before CSS transforms). For a BLOCK element the box is the element's own box (text that overflows it is NOT included), for an INLINE
 * element (`span`, `b`, ...) it is the union of its text fragments. So the analysis pass wraps every text run in a keyed `<span>`: that span's
 * box is the real extent of the text, and the parent's box is the container it should stay inside.
 *
 * Checks: text outside the title-safe area, text overflowing its box or the canvas, low contrast against the background
 * sampled from a second render in which all text is transparent.
 */

const TOLERANCE = 3;
const MIN_CONTRAST = 3;
/** One warning per element and kind, at most this many per kind (then a summary). */
const MAX_PER_KIND = 5;

export interface TextlessRaster {
  raw: Buffer;
  width: number;
  height: number;
  /** raster pixels per canvas pixel (0.5 = half resolution). */
  scale: number;
}

export interface CheckArgs {
  roots: readonly HChild[];
  format: FormatSpec;
  brand: ResolvedBrand;
  /** Boxes by element key (blocks) and `<key>#t<n>` (text runs). */
  nodes: ReadonlyMap<string, Box>;
  textless: TextlessRaster | undefined;
  /** Elements whose text already got a `text_does_not_fit` warning from data-fit. */
  fitFailed: ReadonlySet<string>;
}

function union(boxes: Box[]): Box | undefined {
  const real = boxes.filter((b) => b.width > 0.5 && b.height > 0.5);
  if (real.length === 0) return undefined;
  const left = Math.min(...real.map((b) => b.left));
  const top = Math.min(...real.map((b) => b.top));
  const right = Math.max(...real.map((b) => b.left + b.width));
  const bottom = Math.max(...real.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

function skipped(el: HElement, ancestors: readonly HElement[]): boolean {
  for (const a of [...ancestors, el]) {
    if (a.attrs['data-nocheck'] !== undefined || a.attrs['data-decor'] !== undefined) return true;
    if (a.style.display === 'none' || a.style.visibility === 'hidden' || a.style.opacity === '0') return true;
    if (a.style.transform !== undefined && a.style.transform !== 'none') return true; // layout boxes are pre-transform
  }
  return false;
}

function inheritedColor(ancestors: readonly HElement[], el: HElement, fallback: string): { color: ReturnType<typeof parseColor>; clipped: boolean } {
  let color = fallback;
  let clipped = false;
  for (const a of [...ancestors, el]) {
    if (a.style.color !== undefined) color = a.style.color;
    if (a.style.backgroundClip === 'text' || a.style.WebkitBackgroundClip === 'text' || a.style.WebkitTextFillColor !== undefined) clipped = true;
  }
  return { color: parseColor(color), clipped };
}

const round = (n: number): number => Math.round(n);

/** Effective font size in px (nearest px declaration up the tree; the browser default is 16). */
function fontSizeOf(ancestors: readonly HElement[], el: HElement): number {
  let size = 16;
  for (const a of [...ancestors, el]) {
    const px = pxValue(a.style.fontSize);
    if (px !== undefined) size = px;
  }
  return size;
}

export function runChecks(args: CheckArgs, warnings: RenderWarning[]): void {
  const { format, brand } = args;
  const safe = textSafeRect(format);
  const counts: Record<string, number> = {};
  const extra: Record<string, number> = {};
  const emit = (code: string, message: string, suggestion: string): void => {
    counts[code] = (counts[code] ?? 0) + 1;
    if ((counts[code] as number) > MAX_PER_KIND) {
      extra[code] = (extra[code] ?? 0) + 1;
      return;
    }
    warn(warnings, code, message, suggestion);
  };

  walk(args.roots, (el, _parent, ancestors) => {
    if (el.svg || !hasDirectText(el) || skipped(el, ancestors)) return;
    const runs: Box[] = [];
    for (const [key, box] of args.nodes) if (key.startsWith(`${el.key}#t`)) runs.push(box);
    const text = union(runs);
    if (!text) return;
    const label = labelOf(el);
    const right = text.left + text.width;
    const bottom = text.top + text.height;

    // 1. Outside the canvas: cut off.
    const cut: string[] = [];
    if (text.left < -TOLERANCE) cut.push(`${round(-text.left)}px past the left edge`);
    if (text.top < -TOLERANCE) cut.push(`${round(-text.top)}px past the top edge`);
    if (right > format.width + TOLERANCE) cut.push(`${round(right - format.width)}px past the right edge`);
    if (bottom > format.height + TOLERANCE) cut.push(`${round(bottom - format.height)}px past the bottom edge`);
    if (cut.length > 0) {
      emit('text_outside_canvas', `The text of ${label} is cut off by the image edge (${cut.join(', ')}).`, 'Move it inside the canvas, make its box narrower so it wraps, or reduce the font size (data-fit does this automatically).');
    } else {
      // 2. Outside the title-safe area (the story bands included). Glyph boxes are taller than tight line boxes, so vertical edges get slack.
      const slackV = TOLERANCE + 0.15 * fontSizeOf(ancestors, el);
      const out: string[] = [];
      if (text.left < safe.x - TOLERANCE) out.push(`left by ${round(safe.x - text.left)}px`);
      if (right > safe.x + safe.w + TOLERANCE) out.push(`right by ${round(right - (safe.x + safe.w))}px`);
      if (text.top < safe.y - slackV) out.push(`top by ${round(safe.y - text.top)}px`);
      if (bottom > safe.y + safe.h + slackV) out.push(`bottom by ${round(bottom - (safe.y + safe.h))}px`);
      if (out.length > 0) {
        const band = format.name === 'story' ? ' (the story format keeps the top 250 px and bottom 400 px clear of the app interface)' : '';
        emit(
          'text_outside_safe_zone',
          `The text of ${label} goes outside the safe area${band}: ${out.join(', ')}.`,
          `Keep text inside x ${round(safe.x)}-${round(safe.x + safe.w)}, y ${round(safe.y)}-${round(safe.y + safe.h)} (use {{safe.left}}, {{safe.top}}, ... tokens), or add data-decor to the element if the overlap is intentional.`,
        );
      }
    }

    // 3. Overflowing its box. Width: the text is wider than its own element (a long word, or `nowrap`). Height: only when a box with a
    //    DEFINITE height (this element or an ancestor) is shorter than the text; auto-height boxes grow with their text.
    const box = args.nodes.get(el.key);
    const clips = el.style.textOverflow === 'ellipsis' || el.style.lineClamp !== undefined || el.style.WebkitLineClamp !== undefined;
    const inline = el.tag === 'span' || el.tag === 'b' || el.tag === 'strong' || el.tag === 'i' || el.tag === 'em' || el.tag === 'u' || el.tag === 'small' || el.tag === 'mark' || el.tag === 'code';
    if (box && !clips && !inline && !args.fitFailed.has(el.key)) {
      const overW = text.width - box.width;
      let overH = 0;
      const holder = [...ancestors, el].reverse().find((a) => pxValue(a.style.height) !== undefined || pxValue(a.style.maxHeight) !== undefined);
      const holderBox = holder ? args.nodes.get(holder.key) : undefined;
      if (holderBox) {
        const slack = TOLERANCE + 0.3 * fontSizeOf(ancestors, el); // glyph boxes are taller than tight line boxes
        overH = Math.max(text.top + text.height - (holderBox.top + holderBox.height) - slack, 0);
        if (overH > 0) overH += slack;
      }
      if (overW > TOLERANCE || overH > 0) {
        const dims = [overW > TOLERANCE ? `${round(overW)}px too wide` : '', overH > 0 ? `${round(overH)}px too tall` : ''].filter(Boolean).join(' and ');
        emit(
          'text_overflow',
          `The text of ${label} overflows its box (${dims}).`,
          'Shorten the text, enlarge the box (width/height), allow it to grow (remove the fixed height), or add data-fit so the font size adapts.',
        );
      }
    }

    // 4. Contrast against what is actually behind the text (text-less render).
    const tl = args.textless;
    if (tl) {
      const { color, clipped } = inheritedColor(ancestors, el, brand.colors.ink);
      if (color && color.a > 0.05 && !clipped) {
        const rect = {
          x: Math.max(0, text.left) * tl.scale,
          y: Math.max(0, text.top) * tl.scale,
          w: Math.min(format.width, right) * tl.scale - Math.max(0, text.left) * tl.scale,
          h: Math.min(format.height, bottom) * tl.scale - Math.max(0, text.top) * tl.scale,
        };
        if (rect.w >= 2 && rect.h >= 2) {
          const stats = sampleRegion(tl.raw, tl.width, tl.height, rect, 2);
          const clamp = (v: number): number => Math.max(0, Math.min(255, v));
          const lo: RGB = { r: clamp(stats.mean.r - stats.sd.r), g: clamp(stats.mean.g - stats.sd.g), b: clamp(stats.mean.b - stats.sd.b) };
          const hi: RGB = { r: clamp(stats.mean.r + stats.sd.r), g: clamp(stats.mean.g + stats.sd.g), b: clamp(stats.mean.b + stats.sd.b) };
          const fg: RGB = { r: color.r, g: color.g, b: color.b };
          const worst = Math.min(contrastRatio(blend(lo, fg, color.a), lo), contrastRatio(blend(hi, fg, color.a), hi));
          if (worst < MIN_CONTRAST) {
            emit(
              'low_contrast',
              `The text of ${label} has low contrast against its background (about ${worst.toFixed(1)}:1; aim for 4.5:1, at least 3:1 for very large text).`,
              'Use a lighter or darker text color, or add a solid / semi-transparent panel or a gradient overlay behind the text.',
            );
          }
        }
      }
    }
  });

  for (const [code, n] of Object.entries(extra)) {
    warn(warnings, `${code}_more`, `${n} more element(s) have the same problem (${code}).`, 'Fix the ones listed above first, then render again.');
  }
}
