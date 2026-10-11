import { isValidHex, toHex } from './color.js';
import { DEFAULT_BODY_FAMILY, DEFAULT_HEADING_FAMILY, type FontRegistry } from './fonts.js';
import type { LogoCorner } from './templates/index.js';
import { warn, type RenderWarning } from './warnings.js';

export interface BrandInput {
  colors?: { primary?: string; secondary?: string; accent?: string; ink?: string; paper?: string };
  fonts?: { heading?: string; body?: string };
  /** Main logo. */
  logo_url?: string;
  /** Logo variant meant for DARK backgrounds (light-colored logo). */
  logo_url_light?: string;
  /** Logo variant meant for LIGHT backgrounds (dark-colored logo). */
  logo_url_dark?: string;
  logo_position?: LogoCorner;
}

export interface ResolvedBrand {
  colors: { primary: string; secondary: string; accent: string; ink: string; paper: string };
  fonts: { heading: string; body: string };
  logos: { primary?: string; light?: string; dark?: string };
  logoCorner?: LogoCorner;
}

/** Neutral palette used when the brand does not give one. */
export const DEFAULT_COLORS = {
  primary: '#1f3a5f',
  secondary: '#f4efe6',
  accent: '#f2a541',
  ink: '#0b1020',
  paper: '#ffffff',
} as const;

export function resolveBrand(input: BrandInput | undefined, fonts: FontRegistry, warnings: RenderWarning[]): ResolvedBrand {
  const colors = { ...DEFAULT_COLORS } as Record<keyof typeof DEFAULT_COLORS, string>;
  for (const key of Object.keys(DEFAULT_COLORS) as (keyof typeof DEFAULT_COLORS)[]) {
    const given = input?.colors?.[key];
    if (given === undefined) continue;
    if (isValidHex(given)) colors[key] = toHex(given, DEFAULT_COLORS[key]);
    else warn(warnings, 'invalid_color', `Brand color "${key}" is not a valid hex color; the default was used.`, 'Use hex colors such as #1F3A5F.');
  }

  const pick = (role: 'heading' | 'body', requested: string | undefined, fallback: string): string => {
    if (requested === undefined) return fallback;
    if (fonts.has(requested)) return requested;
    warn(
      warnings,
      'font_unavailable',
      `The ${role} font "${requested}" is not bundled; ${fallback} was used instead.`,
      `Available fonts: ${fonts.listFamilies().join(', ')}.`,
    );
    return fallback;
  };

  const logos: ResolvedBrand['logos'] = {};
  if (input?.logo_url) logos.primary = input.logo_url;
  if (input?.logo_url_light) logos.light = input.logo_url_light;
  if (input?.logo_url_dark) logos.dark = input.logo_url_dark;

  return {
    colors: colors as ResolvedBrand['colors'],
    fonts: {
      heading: pick('heading', input?.fonts?.heading, DEFAULT_HEADING_FAMILY),
      body: pick('body', input?.fonts?.body, DEFAULT_BODY_FAMILY),
    },
    logos,
    ...(input?.logo_position ? { logoCorner: input.logo_position } : {}),
  };
}
