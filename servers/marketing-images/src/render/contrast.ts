import type { ResolvedBrand } from './brand.js';
import {
  blend,
  contrastRatio,
  hexToRgb,
  readableOn,
  rgbToHex,
  rgba,
  relativeLuminance,
  type RGB,
} from './color.js';
import type { BackgroundKind } from './background.js';
import type { Rect } from './formats.js';
import { warn, type RenderWarning } from './warnings.js';

/** Sampling and color decisions so text is always readable (DESIGN section 5.1, "contrast"). */

export type ScrimMode = 'auto' | 'soft' | 'none' | 'strong';

export interface RegionStats {
  mean: RGB;
  /** Per-channel standard deviation. */
  sd: RGB;
}

/** Mean and spread of the pixels under `rect` (every `stride`-th pixel; deterministic). */
export function sampleRegion(raw: Buffer, width: number, height: number, rect: Rect, stride = 3): RegionStats {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  let n = 0;
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const v = raw[i + c] as number;
        sum[c] = (sum[c] as number) + v;
        sumSq[c] = (sumSq[c] as number) + v * v;
      }
      n += 1;
    }
  }
  if (n === 0) return { mean: { r: 128, g: 128, b: 128 }, sd: { r: 0, g: 0, b: 0 } };
  const mean = (c: number): number => (sum[c] as number) / n;
  const sd = (c: number): number => Math.sqrt(Math.max(0, (sumSq[c] as number) / n - mean(c) ** 2));
  return {
    mean: { r: mean(0), g: mean(1), b: mean(2) },
    sd: { r: sd(0), g: sd(1), b: sd(2) },
  };
}

/** The darkest and brightest plausible colors under the text: mean -/+ one standard deviation per channel. */
function extremes(stats: RegionStats): { lo: RGB; hi: RGB } {
  const clamp = (v: number): number => Math.max(0, Math.min(255, v));
  return {
    lo: { r: clamp(stats.mean.r - stats.sd.r), g: clamp(stats.mean.g - stats.sd.g), b: clamp(stats.mean.b - stats.sd.b) },
    hi: { r: clamp(stats.mean.r + stats.sd.r), g: clamp(stats.mean.g + stats.sd.g), b: clamp(stats.mean.b + stats.sd.b) },
  };
}

export interface Appearance {
  ink: string;
  accent: string;
  muted: string;
  /** Pill button colors (cta-card). */
  buttonBg: string;
  buttonText: string;
  scrim?: { color: string; alpha: number; strong: boolean; soft?: boolean };
  /** Background under the text after the scrim, for logo/plate decisions. */
  effectiveBg: RGB;
}

const TARGET_CONTRAST = 4.5;
const MIN_CONTRAST = 3;
const ALPHAS = [0.5, 0.6, 0.7, 0.8, 0.85];
/** `soft` scrim: starts lighter, still climbs until the text reaches the target contrast. */
const SOFT_ALPHAS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85];

/** Worst contrast of `hex` against the darkest and brightest plausible background. */
function score(hex: string, lo: RGB, hi: RGB): number {
  const rgb = hexToRgb(hex);
  return rgb ? Math.min(contrastRatio(rgb, lo), contrastRatio(rgb, hi)) : 0;
}

/** First candidate that reaches the target contrast everywhere under the text, else the best one. */
function pickInk(candidates: string[], lo: RGB, hi: RGB): { hex: string; score: number } {
  let best = { hex: candidates[0] as string, score: 0 };
  for (const hex of candidates) {
    const s = score(hex, lo, hi);
    if (s >= TARGET_CONTRAST) return { hex, score: s };
    if (s > best.score) best = { hex, score: s };
  }
  return best;
}

export interface AppearanceArgs {
  brand: ResolvedBrand;
  stats: RegionStats;
  /** Photos and gradients change from place to place under the text; flat colors do not. */
  backgroundKind: BackgroundKind;
  mode: ScrimMode;
  hasButton: boolean;
  warnings: RenderWarning[];
}

export function resolveAppearance(args: AppearanceArgs): Appearance {
  const { brand, stats, warnings } = args;
  const paper = hexToRgb(brand.colors.paper) as RGB;
  const inkIsDark = relativeLuminance(hexToRgb(brand.colors.ink) as RGB) < 0.12;
  const scrimColor = inkIsDark ? brand.colors.ink : '#0b1020';
  const scrimRgb = hexToRgb(scrimColor) as RGB;
  const { lo, hi } = extremes(stats);

  // Candidate text colors without a scrim. Flat cards follow the template rule (text = paper) whenever paper
  // is readable; photos and gradients prefer the color `readableOn` picks for their average.
  const preferred = readableOn(rgbToHex(stats.mean), brand.colors.ink, brand.colors.paper);
  const order = args.backgroundKind === 'color' ? [brand.colors.paper, preferred] : [preferred, brand.colors.paper];
  const plain = pickInk([...order, brand.colors.ink, '#ffffff', '#0b1020'], lo, hi);

  // Scrim policy: never on flat colors; always (baseline) on photos; on gradients only when plain text would not be readable.
  let wantScrim = false;
  if (args.backgroundKind !== 'color' && args.mode !== 'none') {
    if (args.mode === 'strong') wantScrim = true;
    else wantScrim = args.backgroundKind === 'photo' || plain.score < TARGET_CONTRAST;
  }

  let scrim: Appearance['scrim'];
  let effective: RGB = stats.mean;
  let inkHex = plain.hex;
  if (wantScrim) {
    const steps = args.mode === 'soft' ? SOFT_ALPHAS : ALPHAS;
    const alpha = args.mode === 'strong' ? 0.85 : (steps.find((a) => contrastRatio(paper, blend(hi, scrimRgb, a)) >= TARGET_CONTRAST) ?? 0.85);
    scrim = { color: scrimColor, alpha, strong: args.mode === 'strong', ...(args.mode === 'soft' ? { soft: true } : {}) };
    effective = blend(stats.mean, scrimRgb, alpha);
    inkHex = pickInk([brand.colors.paper, '#ffffff'], blend(lo, scrimRgb, alpha), blend(hi, scrimRgb, alpha)).hex;
  } else if (plain.score < MIN_CONTRAST) {
    warn(
      warnings,
      'low_contrast',
      'The text may be hard to read on this background.',
      args.backgroundKind === 'color'
        ? 'Use a brand color with more contrast against the text color.'
        : 'Call compose_post again with options.scrim set to "strong".',
    );
  }

  // Accent (eyebrow) must be readable too.
  const accentRgb = hexToRgb(brand.colors.accent) as RGB;
  const accentHex = contrastRatio(accentRgb, effective) >= MIN_CONTRAST ? brand.colors.accent : inkHex;

  // Button: accent pill; fall back to the ink color when the accent is too close to the card color.
  let buttonBg = brand.colors.accent;
  if (args.hasButton && contrastRatio(accentRgb, effective) < 2) {
    buttonBg = inkHex;
    warn(
      warnings,
      'accent_low_contrast',
      'The accent color is too close to the background color, so the button uses the text color instead.',
      'Pick an accent color that contrasts with the primary color.',
    );
  }
  const buttonRgb = hexToRgb(buttonBg) as RGB;
  const buttonText = pickInk([brand.colors.ink, brand.colors.paper, '#0b1020', '#ffffff'], buttonRgb, buttonRgb).hex;

  return {
    ink: inkHex,
    accent: accentHex,
    muted: rgba(inkHex, 0.78),
    buttonBg,
    buttonText,
    ...(scrim ? { scrim } : {}),
    effectiveBg: effective,
  };
}
