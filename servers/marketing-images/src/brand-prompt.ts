import { findBrand, type StoredBrandData } from './brands.js';
import type { AppContext } from './context.js';
import { hexToRgb, normalizeHex } from './render/color.js';
import type { BrandInput } from './render/brand.js';

/**
 * What a brand adds to an AI image prompt (DESIGN section 5.3): its `style.photo_style` text and a short palette phrase.
 * Only the colors that describe the look go in (primary, accent, secondary); ink and paper are text colors, and the
 * fonts, logos and voice are irrelevant to a picture. Nothing here touches the disk: a saved brand is read from the store only.
 */

export interface BrandImageHints {
  /** The brand's photo style, cleaned up (no trailing period). */
  photoStyle?: string;
  /** "dark blue (#1F3A5F), amber (#F2A541)": color names a model understands, plus the exact hex. */
  palette?: string;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl(hex: string): Hsl | undefined {
  const rgb = hexToRgb(hex);
  if (!rgb) return undefined;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** A plain color name for a hex ("dark blue", "amber", "cream"). Coarse on purpose: it only has to steer an image model. */
export function describeColor(hex: string): string {
  const hsl = toHsl(hex);
  if (!hsl) return 'neutral';
  const { h, s, l } = hsl;
  if (l <= 0.1) return 'black';
  if (l >= 0.985) return 'white';
  if (l >= 0.94) return 'off-white';
  if (s < 0.1) {
    if (l < 0.3) return 'charcoal';
    if (l < 0.62) return 'gray';
    return l < 0.9 ? 'light gray' : 'off-white';
  }

  const shade = l < 0.3 ? 'dark ' : l > 0.78 ? 'light ' : '';
  if (h < 15 || h >= 345) return l > 0.75 ? 'pink' : `${shade}red`;
  if (h < 45) {
    if (l > 0.86) return 'cream';
    if (l < 0.36) return 'brown';
    return h >= 30 && l >= 0.45 ? 'amber' : `${shade}orange`;
  }
  if (h < 70) {
    if (l > 0.86) return 'cream';
    return l < 0.4 ? 'olive' : `${shade}yellow`;
  }
  if (h < 165) return `${shade}green`;
  if (h < 195) return `${shade}teal`;
  if (h < 255) return `${shade}blue`;
  if (h < 290) return `${shade}purple`;
  return l > 0.7 ? 'pink' : `${shade}magenta`;
}

interface PaletteColors {
  primary?: string | undefined;
  accent?: string | undefined;
  secondary?: string | undefined;
}

/** "dark blue (#1F3A5F), amber (#F2A541)" or undefined when no valid color was given. Each color once. */
export function paletteList(colors: PaletteColors | undefined): string | undefined {
  if (!colors) return undefined;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of [colors.primary, colors.accent, colors.secondary]) {
    const hex = value ? normalizeHex(value) : null;
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    items.push(`${describeColor(hex)} (#${hex})`);
  }
  return items.length > 0 ? items.join(', ') : undefined;
}

function cleanPhotoStyle(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim().replace(/[.;,\s]+$/, '');
  return text ? text : undefined;
}

function hintsOf(colors: PaletteColors | undefined, photoStyle: string | undefined): BrandImageHints | undefined {
  const style = cleanPhotoStyle(photoStyle);
  const palette = paletteList(colors);
  if (!style && !palette) return undefined;
  return { ...(style ? { photoStyle: style } : {}), ...(palette ? { palette } : {}) };
}

/**
 * `brand` as generate_image / edit_image accept it: the slug of a saved brand (own first, then shared; another owner's private
 * brand is not found) or an inline object. Returns undefined when the brand has nothing to say about pictures.
 * Throws the usual "no saved brand called ..." message for an unknown slug, before anything is reserved or spent.
 */
export function resolveBrandImageHints(ctx: AppContext, user: string, arg: string | BrandInput | undefined): BrandImageHints | undefined {
  if (arg === undefined) return undefined;
  if (typeof arg === 'string') {
    const data = findBrand(ctx, user, arg).data as StoredBrandData;
    return hintsOf(data.colors, data.style.photo_style);
  }
  return hintsOf(arg.colors, arg.style?.photo_style);
}
