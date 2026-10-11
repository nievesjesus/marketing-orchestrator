import type { Glyph } from 'opentype.js';
import type { FontFace } from './fonts.js';

/**
 * Text fitting (DESIGN section 5.1): measure with real glyph advances and kerning from the font file,
 * wrap greedily, and binary-search the largest size whose lines fit the box and the line limit.
 *
 * opentype.js `Font.getAdvanceWidth()` runs the GSUB shaping engine, which throws on some lookups used
 * by the bundled fonts (e.g. Outfit: "lookupType 6 ... not yet supported"), so advances and kerning are
 * summed per glyph instead. Docs: https://opentype.js.org/
 */

/** Measures text in em units (width / font size) with a per-string cache. */
export class TextMeter {
  private readonly cache = new Map<string, number>();

  constructor(readonly face: FontFace) {}

  private glyph(ch: string): Glyph {
    const font = this.face.font;
    return font.glyphs.get(font.charToGlyphIndex(ch));
  }

  hasGlyph(ch: string): boolean {
    return this.face.font.charToGlyphIndex(ch) !== 0;
  }

  /** Width of `text` in em, including pair kerning. */
  emWidth(text: string): number {
    const cached = this.cache.get(text);
    if (cached !== undefined) return cached;
    const font = this.face.font;
    let units = 0;
    let prev: Glyph | null = null;
    for (const ch of text) {
      const g = this.glyph(ch);
      units += g.advanceWidth ?? 0;
      if (prev) units += font.getKerningValue(prev, g);
      prev = g;
    }
    const em = units / font.unitsPerEm;
    this.cache.set(text, em);
    return em;
  }
}

export interface PreparedText {
  text: string;
  /** Characters the font cannot draw (removed from the text). */
  removed: string[];
}

/** NFC-normalize, flatten whitespace (keeping explicit newlines) and drop characters the font lacks. */
export function prepareText(raw: string, meter: TextMeter): PreparedText {
  const normalized = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t   ]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
  const removed: string[] = [];
  let out = '';
  for (const ch of normalized) {
    if (ch === '\n' || ch === ' ' || meter.hasGlyph(ch)) out += ch;
    else if (!removed.includes(ch)) removed.push(ch);
  }
  const text = out
    .split('\n')
    .map((l) => l.replace(/ +/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, removed };
}

export interface FitInput {
  text: string;
  meter: TextMeter;
  maxWidth: number;
  maxHeight: number;
  maxLines: number;
  minSize: number;
  maxSize: number;
  /** Line height multiplier. */
  lineHeight: number;
  /** Letter spacing in em. */
  letterSpacingEm?: number;
  /** Even out line lengths (headlines). */
  balance?: boolean;
  /** Cut with an ellipsis when it cannot fit at `minSize`. Never for headlines. */
  allowEllipsis?: boolean;
}

export interface FitResult {
  size: number;
  lines: string[];
  lineHeightPx: number;
  height: number;
  /** True when the text (possibly truncated, if allowed) fits the box at a size >= minSize. */
  fits: boolean;
  truncated: boolean;
  reason?: 'word_too_long' | 'too_many_lines' | 'too_tall';
}

/** Share of the box width kept free: other renderers' kerning/ligatures differ by a hair from ours. */
const WIDTH_SAFETY = 0.985;
const ELLIPSIS = '…';

interface Wrapped {
  lines: string[];
  overflow: boolean;
}

function wrap(paragraphs: string[][], meter: TextMeter, size: number, maxWidth: number, lsEm: number): Wrapped {
  const spaceEm = meter.emWidth(' ');
  const lines: string[] = [];
  let overflow = false;
  const widthOf = (em: number, chars: number): number => (em + lsEm * chars) * size;

  for (const words of paragraphs) {
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line: string[] = [];
    let lineEm = 0;
    let lineChars = 0;
    const flush = (): void => {
      lines.push(line.join(' '));
      line = [];
      lineEm = 0;
      lineChars = 0;
    };
    for (const word of words) {
      const wEm = meter.emWidth(word);
      const wChars = [...word].length;
      if (line.length === 0) {
        line = [word];
        lineEm = wEm;
        lineChars = wChars;
        if (widthOf(lineEm, lineChars) > maxWidth) overflow = true;
        continue;
      }
      const tryEm = lineEm + spaceEm + wEm;
      const tryChars = lineChars + 1 + wChars;
      if (widthOf(tryEm, tryChars) <= maxWidth) {
        line.push(word);
        lineEm = tryEm;
        lineChars = tryChars;
      } else {
        flush();
        line = [word];
        lineEm = wEm;
        lineChars = wChars;
        if (widthOf(lineEm, lineChars) > maxWidth) overflow = true;
      }
    }
    if (line.length > 0) flush();
  }
  return { lines, overflow };
}

function toParagraphs(text: string): string[][] {
  return text.split('\n').map((p) => p.split(' ').filter(Boolean));
}

function lineWidthPx(line: string, meter: TextMeter, size: number, lsEm: number): number {
  return (meter.emWidth(line) + lsEm * [...line].length) * size;
}

/** Shrink `line` (by words, then characters) until `line + ellipsis` fits. */
function ellipsize(line: string, meter: TextMeter, size: number, maxWidth: number, lsEm: number): string {
  const words = line.split(' ').filter(Boolean);
  while (words.length > 1 && lineWidthPx(`${words.join(' ')}${ELLIPSIS}`, meter, size, lsEm) > maxWidth) words.pop();
  let text = words.join(' ');
  const chars = [...text];
  while (chars.length > 1 && lineWidthPx(`${chars.join('')}${ELLIPSIS}`, meter, size, lsEm) > maxWidth) chars.pop();
  text = chars.join('').trimEnd();
  return `${text}${ELLIPSIS}`;
}

export function fitText(input: FitInput): FitResult {
  const { meter, maxHeight, maxLines, lineHeight } = input;
  const lsEm = input.letterSpacingEm ?? 0;
  const maxWidth = input.maxWidth * WIDTH_SAFETY;
  const minSize = Math.max(1, Math.floor(input.minSize));
  const maxSize = Math.max(minSize, Math.floor(input.maxSize));
  const paragraphs = toParagraphs(input.text);

  const attempt = (size: number): Wrapped & { ok: boolean; reason?: FitResult['reason'] } => {
    const w = wrap(paragraphs, meter, size, maxWidth, lsEm);
    if (w.overflow) return { ...w, ok: false, reason: 'word_too_long' };
    if (w.lines.length > maxLines) return { ...w, ok: false, reason: 'too_many_lines' };
    if (w.lines.length * Math.round(size * lineHeight) > maxHeight) return { ...w, ok: false, reason: 'too_tall' };
    return { ...w, ok: true };
  };

  // Whole-pixel line boxes: stacking N lines is then exactly N * lineHeightPx.
  const linePx = (size: number): number => Math.round(size * lineHeight);
  const result = (size: number, lines: string[], fits: boolean, truncated: boolean, reason?: FitResult['reason']): FitResult => ({
    size,
    lines,
    lineHeightPx: linePx(size),
    height: lines.length * linePx(size),
    fits,
    truncated,
    ...(reason ? { reason } : {}),
  });

  const atMin = attempt(minSize);
  if (!atMin.ok) {
    // Cannot fit at the floor.
    if (!input.allowEllipsis) return result(minSize, atMin.lines, false, false, atMin.reason);
    const rows = Math.max(1, Math.min(maxLines, Math.floor(maxHeight / linePx(minSize)) || 1));
    const kept = atMin.lines.slice(0, rows);
    const cut = atMin.lines.length > rows;
    const out = kept.map((l, i) => {
      const isLast = i === kept.length - 1;
      const tooWide = lineWidthPx(l, meter, minSize, lsEm) > maxWidth;
      return (isLast && cut) || tooWide ? ellipsize(l, meter, minSize, maxWidth, lsEm) : l;
    });
    return result(minSize, out, true, true);
  }

  let lo = minSize;
  let hi = maxSize;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (attempt(mid).ok) lo = mid;
    else hi = mid - 1;
  }
  let best = attempt(lo);

  if (input.balance && best.lines.length > 1 && paragraphs.length === 1) {
    // Narrowest width that still wraps into the same number of lines = evenly filled lines.
    const target = best.lines.length;
    let wLo = 0;
    let wHi = maxWidth;
    for (let i = 0; i < 14; i += 1) {
      const mid = (wLo + wHi) / 2;
      const w = wrap(paragraphs, meter, lo, mid, lsEm);
      if (!w.overflow && w.lines.length <= target) wHi = mid;
      else wLo = mid;
    }
    const balanced = wrap(paragraphs, meter, lo, wHi, lsEm);
    if (!balanced.overflow && balanced.lines.length === target) best = { ...balanced, ok: true };
  }
  return result(lo, best.lines, true, false);
}

const CAPACITY_SAMPLE = 'Nuevo menú de temporada para compartir con quienes más quieres';

/** Rough number of characters that fit at `size` in a box (for "use at most N characters" hints). */
export function estimateCapacityChars(meter: TextMeter, size: number, maxWidth: number, maxLines: number): number {
  const avgEm = meter.emWidth(CAPACITY_SAMPLE) / [...CAPACITY_SAMPLE].length;
  const perLine = (maxWidth * WIDTH_SAFETY) / (avgEm * size);
  return Math.max(1, Math.floor(perLine * maxLines * 0.9));
}
