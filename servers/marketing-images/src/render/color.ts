/**
 * Color helpers.
 *
 * `normalizeHex`, `hexToRgb` and `readableOn` are ported from
 *   ~/Proyectos/React-Next/logo-showcase/packages/ui/src/lib/color.ts  (shared color utilities)
 * keeping the same behaviour: 3/6-digit hex, and a luminance cut-off of 150 on
 * 0.299 R + 0.587 G + 0.114 B to choose dark or light text. The WCAG helpers below are additions.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Normalizes a 3 or 6 digit hex to 6-digit uppercase (no '#'), or null if invalid. */
export function normalizeHex(hex: string): string | null {
  let h = (hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : null;
}

export function isValidHex(hex: string): boolean {
  return normalizeHex(hex) !== null;
}

export function hexToRgb(hex: string): RGB | null {
  const h = normalizeHex(hex);
  if (!h) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Readable text color (dark/light) on a hex background, by luminance. */
export function readableOn(hex: string, dark = '#0b1020', light = '#ffffff'): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return dark;
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b > 150 ? dark : light;
}

// ---- additions (not in the source file) -----------------------------------------------

export function rgbToHex({ r, g, b }: RGB): string {
  const to = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Hex (any form) to `#rrggbb` lowercase; falls back when invalid. */
export function toHex(hex: string, fallback: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : fallback;
}

/** 0..1 perceptual-ish luminance used by the logo variant logic (same weights as readableOn, /255). */
export function luma(rgb: RGB): number {
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

/** WCAG 2.x relative luminance. https://www.w3.org/TR/WCAG21/#dfn-relative-luminance */
export function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1..21. https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite `top` (opacity 0..1) over `bottom` in sRGB space, like an image compositor does. */
export function blend(bottom: RGB, top: RGB, alpha: number): RGB {
  return {
    r: bottom.r * (1 - alpha) + top.r * alpha,
    g: bottom.g * (1 - alpha) + top.g * alpha,
    b: bottom.b * (1 - alpha) + top.b * alpha,
  };
}

export function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}
