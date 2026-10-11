import { isValidHex, toHex } from './color.js';
import { DEFAULT_BODY_FAMILY, DEFAULT_HEADING_FAMILY, type FontRegistry } from './fonts.js';
import type { FormatName } from './formats.js';
import type { LogoCorner } from './templates/index.js';
import { warn, type RenderWarning } from './warnings.js';

/**
 * A brand as the renderers see it. It comes from two places:
 *  - an inline object given to a compose tool (`BrandInput`, the original shape plus optional `style`), or
 *  - a saved brand (`src/brands.ts`), already resolved to files on disk and a font registry scoped to that brand.
 * Both end up as `ResolvedBrand`.
 */

export const RADIUS_NAMES = ['none', 'small', 'medium', 'large', 'pill'] as const;
export type RadiusName = (typeof RADIUS_NAMES)[number];
export const BUTTON_STYLES = ['pill', 'rounded', 'square', 'underline'] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];
export const EYEBROW_CASES = ['upper', 'title', 'none'] as const;
export type EyebrowCase = (typeof EYEBROW_CASES)[number];
export const LOGO_SIZES = ['small', 'medium', 'large'] as const;
export type LogoSize = (typeof LOGO_SIZES)[number];
export const BRAND_SCRIMS = ['auto', 'soft', 'strong', 'none'] as const;
export type BrandScrim = (typeof BRAND_SCRIMS)[number];
export const LOGO_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

export interface BrandStyleInput {
  radius?: RadiusName | undefined;
  button?: ButtonStyle | undefined;
  eyebrow_case?: EyebrowCase | undefined;
  /** Letter spacing of the eyebrow label, in em (0 to 0.4). */
  letter_spacing_eyebrow?: number | undefined;
  logo_position?: LogoCorner | undefined;
  logo_size?: LogoSize | undefined;
  scrim?: BrandScrim | undefined;
  /** Template to use per format when a compose tool gets no `template`. */
  default_templates?: Partial<Record<FormatName, string>> | undefined;
  /** Plain text for image prompts, e.g. "warm natural light, minimal, beige tones". Not used by the renderer. */
  photo_style?: string | undefined;
}

export interface BrandStyle {
  radius: RadiusName;
  button: ButtonStyle;
  eyebrow_case: EyebrowCase;
  letter_spacing_eyebrow?: number;
  logo_position?: LogoCorner;
  logo_size: LogoSize;
  scrim: BrandScrim;
  default_templates?: Partial<Record<FormatName, string>>;
  photo_style?: string;
}

export const DEFAULT_STYLE: BrandStyle = { radius: 'medium', button: 'pill', eyebrow_case: 'upper', logo_size: 'medium', scrim: 'auto' };

export function resolveStyle(input: BrandStyleInput | undefined): BrandStyle {
  const style: BrandStyle = { ...DEFAULT_STYLE };
  if (!input) return style;
  if (input.radius) style.radius = input.radius;
  if (input.button) style.button = input.button;
  if (input.eyebrow_case) style.eyebrow_case = input.eyebrow_case;
  if (input.letter_spacing_eyebrow !== undefined) style.letter_spacing_eyebrow = input.letter_spacing_eyebrow;
  if (input.logo_position) style.logo_position = input.logo_position;
  if (input.logo_size) style.logo_size = input.logo_size;
  if (input.scrim) style.scrim = input.scrim;
  if (input.default_templates) style.default_templates = input.default_templates;
  if (input.photo_style) style.photo_style = input.photo_style;
  return style;
}

/** Corner radius in pixels at the 1080-px reference (multiply by the format scale). `pill` is handled by the caller (h / 2). */
export const RADIUS_PX: Record<Exclude<RadiusName, 'pill'>, number> = { none: 0, small: 12, medium: 28, large: 48 };

/** Share of the canvas width the logo takes. The documented range is 14-18 %, small/large sit just outside on purpose. */
export const LOGO_WIDTH_BY_SIZE: Record<LogoSize, number> = { small: 0.12, medium: 0.16, large: 0.2 };

/** A logo is either a download link (inline brands) or the bytes of a file already stored by the server (saved brands). */
export type LogoSource = string | Buffer;

export interface BrandInput {
  colors?: { primary?: string; secondary?: string; accent?: string; ink?: string; paper?: string };
  fonts?: { heading?: string; body?: string; accent?: string };
  /** Main logo. */
  logo_url?: string;
  /** Logo variant meant for DARK backgrounds (light-colored logo). */
  logo_url_light?: string;
  /** Logo variant meant for LIGHT backgrounds (dark-colored logo). */
  logo_url_dark?: string;
  logo_position?: LogoCorner;
  style?: BrandStyleInput;
}

export interface ResolvedBrand {
  /** Marks an already-resolved brand so renderers can accept either form. */
  readonly resolved: true;
  colors: { primary: string; secondary: string; accent: string; ink: string; paper: string };
  /** Extra named colors of a saved brand (available as {{brand.color.<name>}}). */
  extraColors: { name: string; hex: string }[];
  fonts: { heading: string; body: string; accent: string };
  /** Registry to resolve this brand's fonts with: the bundled one, plus uploaded fonts for a saved brand. */
  fontRegistry: FontRegistry;
  logos: { primary?: LogoSource; light?: LogoSource; dark?: LogoSource };
  logoCorner?: LogoCorner;
  style: BrandStyle;
  slug?: string;
  displayName?: string;
}

/** Neutral palette used when the brand does not give one. */
export const DEFAULT_COLORS = {
  primary: '#1f3a5f',
  secondary: '#f4efe6',
  accent: '#f2a541',
  ink: '#0b1020',
  paper: '#ffffff',
} as const;

export function isResolvedBrand(value: unknown): value is ResolvedBrand {
  return typeof value === 'object' && value !== null && (value as { resolved?: unknown }).resolved === true;
}

export function resolveBrand(input: BrandInput | undefined, fonts: FontRegistry, warnings: RenderWarning[]): ResolvedBrand {
  const colors = { ...DEFAULT_COLORS } as Record<keyof typeof DEFAULT_COLORS, string>;
  for (const key of Object.keys(DEFAULT_COLORS) as (keyof typeof DEFAULT_COLORS)[]) {
    const given = input?.colors?.[key];
    if (given === undefined) continue;
    if (isValidHex(given)) colors[key] = toHex(given, DEFAULT_COLORS[key]);
    else warn(warnings, 'invalid_color', `Brand color "${key}" is not a valid hex color; the default was used.`, 'Use hex colors such as #1F3A5F.');
  }

  const pick = (role: 'heading' | 'body' | 'accent', requested: string | undefined, fallback: string): string => {
    if (requested === undefined) return fallback;
    const display = fonts.displayName(requested);
    if (display !== undefined) return display;
    warn(
      warnings,
      'font_unavailable',
      `The ${role} font "${requested}" is not available; ${fallback} was used instead.`,
      `Available fonts: ${fonts.listFamilies().join(', ')}.`,
    );
    return fallback;
  };

  const logos: ResolvedBrand['logos'] = {};
  if (input?.logo_url) logos.primary = input.logo_url;
  if (input?.logo_url_light) logos.light = input.logo_url_light;
  if (input?.logo_url_dark) logos.dark = input.logo_url_dark;

  const heading = pick('heading', input?.fonts?.heading, DEFAULT_HEADING_FAMILY);
  const body = pick('body', input?.fonts?.body, DEFAULT_BODY_FAMILY);
  const style = resolveStyle(input?.style);
  const corner = input?.logo_position ?? style.logo_position;

  return {
    resolved: true,
    colors: colors as ResolvedBrand['colors'],
    extraColors: [],
    fonts: { heading, body, accent: pick('accent', input?.fonts?.accent, heading) },
    fontRegistry: fonts,
    logos,
    style,
    ...(corner ? { logoCorner: corner } : {}),
  };
}
