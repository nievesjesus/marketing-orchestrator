import type { FormatName, Orientation } from '../formats.js';
import type { ScrimMode } from '../contrast.js';

/**
 * Templates are DATA (DESIGN section 5.1): the layout engine in `layout.ts` interprets them, so a new
 * template is a new object, not new code. All sizes are in pixels at the 1080-px reference and are
 * multiplied by `min(width, height) / 1080` (the typography floors scale the same way).
 */

export const TEXT_FIELDS = ['eyebrow', 'headline', 'body', 'cta', 'footer', 'number'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export type Align = 'left' | 'center' | 'right';
export type TextPosition = 'top' | 'center' | 'bottom';
export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** `label` and `body` map to the minimum-size floors; `headline` to the headline floor. */
export type TextRole = 'headline' | 'body' | 'label';

/** How the text color is derived. `ink` = readable color on the background, `accent` = brand accent (if readable). */
export type TextTone = 'ink' | 'accent' | 'muted';

export interface SlotSpec {
  role: TextRole;
  /** `accent` = the brand's accent font (falls back to the heading font). */
  font: 'heading' | 'body' | 'accent';
  weight: 400 | 700;
  italic?: boolean;
  maxLines: number;
  /** Largest font size, px at the 1080-px reference. */
  maxSize: number;
  /** Line-height multiplier. */
  lineHeight: number;
  /** Letter spacing in em. */
  letterSpacing?: number;
  uppercase?: boolean;
  /** Even out line lengths. */
  balance?: boolean;
  tone: TextTone;
  /** Space above this slot, px at the 1080-px reference. */
  gapBefore: number;
}

export interface TemplateSpec {
  id: string;
  title: string;
  description: string;
  best_for: string;
  /** Text fields the template draws. Others are ignored with a warning. */
  supports: readonly TextField[];
  /** `photo`: expects an image/color/gradient and darkens it for legibility. `brand-primary`: solid brand color by default. */
  background: 'photo' | 'brand-primary';
  defaults: { align: Align; textPosition: TextPosition };
  logo: { corner: LogoCorner };
  /** Share of the canvas the text block may use. */
  block: {
    maxHeight: Record<Orientation, number>;
    maxWidth: Record<Orientation, number>;
  };
  slots: Partial<Record<TextField, SlotSpec>>;
  /** The CTA is drawn as an accent pill button instead of plain text. Sizes are in em of the button text. */
  button?: { paddingX: number; paddingY: number; gapBefore: number };
  /**
   * Something drawn ABOVE the text stack:
   *  - `mark`: a fixed decorative glyph (the opening quotation mark of a quote card);
   *  - `chip`: the `number` text inside a small accent tag (the point number of a carousel slide). Only drawn when `texts.number` is given.
   * `gapAfter` is the space between it and the next item, px at the 1080-px reference.
   */
  lead?:
    | { kind: 'mark'; text: string; slot: SlotSpec; gapAfter: number }
    | { kind: 'chip'; slot: SlotSpec; paddingX: number; paddingY: number; gapAfter: number };
  /**
   * The HEADLINE is drawn as one line inside an accent badge (minimal-badge) instead of as big free text.
   * Sizes are in em of the badge text. The headline slot then uses the `label` role.
   */
  badge?: { paddingX: number; paddingY: number; gapBefore: number };
  /**
   * The photo fills only one part of the canvas; the rest is a flat brand-primary panel that holds the text.
   * `share` is the photo's share of the canvas along the split axis.
   */
  split?: Record<FormatName, { side: 'left' | 'right' | 'top' | 'bottom'; share: number }>;
  /** Scrim used when neither the options nor the brand ask for one explicitly. */
  scrim?: ScrimMode;
  /** Share of the free height first offered to the body text (default 0.38). */
  bodyShare?: number;
}
