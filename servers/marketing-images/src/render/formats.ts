/**
 * Post formats and safe zones (DESIGN section 5.1).
 *
 * Text lives inside the title-safe area (10 % insets); other graphics may use the action-safe
 * area (5 %). Story (9:16) keeps everything out of the top 250 px and bottom 400 px, where the
 * platform UI (profile header, reply bar) covers the image.
 */

export const FORMAT_NAMES = ['square', 'portrait', 'story', 'landscape', 'link'] as const;
export type FormatName = (typeof FORMAT_NAMES)[number];

export type Orientation = 'square' | 'portrait' | 'landscape';

export interface FormatSpec {
  name: FormatName;
  width: number;
  height: number;
  orientation: Orientation;
  description: string;
}

export const FORMATS: Record<FormatName, FormatSpec> = {
  square: { name: 'square', width: 1080, height: 1080, orientation: 'square', description: 'Square 1080x1080 (Instagram/Facebook/LinkedIn feed)' },
  portrait: { name: 'portrait', width: 1080, height: 1350, orientation: 'portrait', description: 'Portrait 4:5, 1080x1350 (Instagram/Facebook/LinkedIn feed, most screen space)' },
  story: { name: 'story', width: 1080, height: 1920, orientation: 'portrait', description: 'Story/Reel/TikTok cover 9:16, 1080x1920' },
  landscape: { name: 'landscape', width: 1920, height: 1080, orientation: 'landscape', description: 'Landscape 16:9, 1920x1080 (YouTube, X, Facebook link-less posts)' },
  link: { name: 'link', width: 1200, height: 627, orientation: 'landscape', description: 'Link preview 1200x627 (LinkedIn/Facebook/X link cards)' },
};

export const ACTION_SAFE = 0.05;
export const TITLE_SAFE = 0.1;
export const STORY_TOP_PX = 250;
export const STORY_BOTTOM_PX = 400;
/** Logo margin as a share of the short side. */
export const LOGO_MARGIN = 0.04;
/** Logo width as a share of the canvas width (allowed range 14-18 %). */
export const LOGO_WIDTH = 0.16;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Scale factor from the 1080-px reference used by the typography floors, sizes and gaps: the SHORT side / 1080.
 * Landscape 1920x1080 therefore has the same floors as square (headline 90 px, body 32 px, label 24 px), and
 * story 1080x1920 as well; the link card (1200x627) scales down with its 627-px short side.
 */
export function scaleOf(format: FormatSpec): number {
  return Math.min(format.width, format.height) / 1080;
}

/** The title-safe rectangle where text may be placed. */
export function textSafeRect(format: FormatSpec): Rect {
  const x = Math.round(format.width * TITLE_SAFE);
  const top = format.name === 'story' ? STORY_TOP_PX : Math.round(format.height * TITLE_SAFE);
  const bottom = format.name === 'story' ? STORY_BOTTOM_PX : Math.round(format.height * TITLE_SAFE);
  return { x, y: top, w: format.width - 2 * x, h: format.height - top - bottom };
}

/** Vertical limits for non-text graphics such as the logo (action-safe, and the story UI bands). */
export function graphicSafeY(format: FormatSpec): { top: number; bottom: number } {
  if (format.name === 'story') return { top: STORY_TOP_PX, bottom: format.height - STORY_BOTTOM_PX };
  const margin = Math.round(Math.min(format.width, format.height) * LOGO_MARGIN);
  return { top: margin, bottom: format.height - margin };
}
