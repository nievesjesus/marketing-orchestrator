import { fitText, prepareText, TextMeter } from '../fit.js';
import { DEFAULT_BODY_FAMILY, type FontRegistry } from '../fonts.js';
import type { ResolvedBrand } from '../brand.js';
import { warn, type RenderWarning } from '../warnings.js';
import { paddingSides, pxValue } from './css.js';
import { directText, labelOf, walk, type HChild, type HElement } from './html.js';

/**
 * `data-fit` auto-size (DESIGN section 5.2): a text element with `data-fit` (and optionally `data-fit-min`, `data-fit-max` in px and
 * `data-fit-lines`) gets the LARGEST font size at which its text fits the element's box, computed with the same engine as the built-in
 * templates (`fit.ts`: real glyph advances, greedy wrap, binary search). The box comes from a measuring pass of the layout itself,
 * so percentages, flex-grow and absolute left/right all work.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FitReport {
  element: string;
  font_size: number;
  lines: number;
  fits: boolean;
}

export interface FitOutcome {
  /** Style changes per element key (font-size, line-height). */
  overrides: Map<string, Record<string, string>>;
  report: FitReport[];
  /** Keys whose text did not fit even at the minimum size (the overflow check skips them: already reported). */
  failed: Set<string>;
}

export const FIT_ATTRS = ['data-fit', 'data-fit-min', 'data-fit-max', 'data-fit-lines'] as const;

export function fitTargets(roots: readonly HChild[]): HElement[] {
  const out: HElement[] = [];
  walk(roots, (el) => {
    if (el.attrs['data-fit'] !== undefined && !el.svg) out.push(el);
  });
  return out;
}

const INHERITED = ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'letterSpacing', 'lineHeight', 'textTransform'] as const;
type Inherited = Partial<Record<(typeof INHERITED)[number], string>>;

function inherit(ancestors: readonly HElement[], el: HElement): Inherited {
  const out: Inherited = {};
  for (const a of [...ancestors, el]) for (const p of INHERITED) if (a.style[p] !== undefined) out[p] = a.style[p] as string;
  return out;
}

function weightOf(value: string | undefined): number {
  if (!value) return 400;
  if (value === 'bold' || value === 'bolder') return 700;
  const n = Number(value);
  return Number.isFinite(n) ? n : 400;
}

const num = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export function firstKnownFamily(value: string | undefined, registry: FontRegistry): string | undefined {
  if (!value) return undefined;
  for (const raw of value.split(',')) {
    const name = raw.trim().replace(/^['"]|['"]$/g, '');
    const display = registry.displayName(name);
    if (display) return display;
  }
  return undefined;
}

export function applyFits(args: {
  roots: readonly HChild[];
  measured: ReadonlyMap<string, Box>;
  parents: ReadonlyMap<string, string | undefined>;
  registry: FontRegistry;
  brand: ResolvedBrand;
  warnings: RenderWarning[];
}): FitOutcome {
  const { registry, brand, warnings } = args;
  const outcome: FitOutcome = { overrides: new Map(), report: [], failed: new Set() };

  walk(args.roots, (el, _parent, ancestors) => {
    if (el.attrs['data-fit'] === undefined || el.svg) return;
    const label = labelOf(el);
    if (el.children.some((c) => typeof c !== 'string' && c.tag !== 'br')) {
      warn(warnings, 'data_fit_ignored', `data-fit on ${label} was ignored: it only works on elements that contain nothing but text.`, 'Put data-fit on the innermost element that holds the text.');
      return;
    }
    const inherited = inherit(ancestors, el);
    const family = firstKnownFamily(inherited.fontFamily, registry) ?? brand.fonts.body;
    const italic = inherited.fontStyle === 'italic';
    const face = registry.resolve(family, DEFAULT_BODY_FAMILY, weightOf(inherited.fontWeight), italic).face;
    const meter = new TextMeter(face);

    let text = directText(el).trim();
    if (inherited.textTransform === 'uppercase') text = text.toUpperCase();
    text = prepareText(text, meter).text;
    if (text === '') return;

    // Box: measured with the text removed. Content-sized boxes measure 0 wide, then the parent's width is the limit.
    let box = args.measured.get(el.key);
    if (!box || box.width < 2) {
      const parentKey = args.parents.get(el.key);
      box = parentKey ? args.measured.get(parentKey) : undefined;
    }
    if (!box || box.width < 2) {
      warn(warnings, 'data_fit_ignored', `data-fit on ${label} was ignored: its width could not be determined.`, 'Give the element a width (px or %) or put it inside a container with a width.');
      return;
    }
    const pad = paddingSides(el.style);
    const declaredHeight = pxValue(el.style.height) ?? pxValue(el.style.maxHeight);
    const heightBox = box.height > 1 ? box.height : declaredHeight;
    const contentW = Math.max(1, box.width - pad.left - pad.right);
    const contentH = heightBox !== undefined ? Math.max(1, heightBox - pad.top - pad.bottom) : Number.POSITIVE_INFINITY;

    const declaredSize = pxValue(inherited.fontSize);
    const min = Math.max(6, Math.round(num(el.attrs['data-fit-min']) ?? 10));
    const max = Math.min(600, Math.max(min, Math.round(num(el.attrs['data-fit-max']) ?? declaredSize ?? 160)));
    const lines = Math.max(1, Math.round(num(el.attrs['data-fit-lines']) ?? 99));

    // Line height: unitless multiplier, or a px value converted at the largest size; default 1.2.
    let lineMult = 1.2;
    const lh = inherited.lineHeight;
    if (lh !== undefined && lh !== 'normal') {
      const unitless = num(lh);
      const px = pxValue(lh);
      if (unitless !== undefined) lineMult = unitless;
      else if (px !== undefined) lineMult = px / max;
    }
    let letterEm = 0;
    const ls = inherited.letterSpacing;
    if (ls !== undefined) {
      const px = pxValue(ls);
      if (px !== undefined) letterEm = px / max;
      else if (/^-?\d+(\.\d+)?em$/.test(ls)) letterEm = Number.parseFloat(ls);
    }

    const fit = fitText({
      text,
      meter,
      maxWidth: contentW,
      maxHeight: contentH,
      maxLines: lines,
      minSize: min,
      maxSize: max,
      lineHeight: lineMult,
      letterSpacingEm: letterEm,
      allowEllipsis: false,
    });
    outcome.overrides.set(el.key, { fontSize: `${fit.size}px`, lineHeight: String(Math.round(lineMult * 1000) / 1000) });
    outcome.report.push({ element: label, font_size: fit.size, lines: fit.lines.length, fits: fit.fits });
    if (!fit.fits) {
      outcome.failed.add(el.key);
      const why = fit.reason === 'word_too_long' ? 'a single word is wider than the box' : fit.reason === 'too_many_lines' ? `it needs more than ${lines} line(s)` : 'it is taller than the box';
      warn(
        warnings,
        'text_does_not_fit',
        `The text of ${label} does not fit its box even at the minimum size of ${min}px (${why}).`,
        'Shorten the text, enlarge the box, or lower data-fit-min / raise data-fit-lines.',
      );
    }
  });
  return outcome;
}
