import type { TemplateSpec } from './types.js';

/** Photo with very little text: a small label or price badge, an optional caption, the logo. */
export const minimalBadge: TemplateSpec = {
  id: 'minimal-badge',
  title: 'Photo with a badge',
  description:
    'Full-bleed photo with a light gradient and almost no text: the headline sits in a small accent badge (a label such as "New" or a price), with an optional eyebrow above and a one- or two-line caption below; logo in a corner.',
  best_for: 'Product photos with a price or tag ("Desde $12", "Nuevo", "-20%"), lifestyle photos that should stay clean. `headline` is the badge text: keep it to 1-4 words.',
  supports: ['eyebrow', 'headline', 'body', 'footer'],
  background: 'photo',
  scrim: 'soft',
  defaults: { align: 'left', textPosition: 'bottom' },
  logo: { corner: 'top-left' },
  block: {
    maxHeight: { square: 0.42, portrait: 0.38, landscape: 0.55 },
    maxWidth: { square: 0.9, portrait: 0.9, landscape: 0.55 },
  },
  badge: { paddingX: 0.75, paddingY: 0.36, gapBefore: 22 },
  slots: {
    eyebrow: {
      role: 'label',
      font: 'accent',
      weight: 700,
      maxLines: 1,
      maxSize: 28,
      lineHeight: 1.2,
      letterSpacing: 0.14,
      uppercase: true,
      tone: 'accent',
      gapBefore: 0,
    },
    // The badge text: one line, label sizes (not the 90-px headline floor, which is for free-standing headlines).
    headline: {
      role: 'label',
      font: 'accent',
      weight: 700,
      maxLines: 1,
      maxSize: 78,
      lineHeight: 1.1,
      tone: 'ink',
      gapBefore: 20,
    },
    body: {
      role: 'body',
      font: 'body',
      weight: 400,
      maxLines: 2,
      maxSize: 40,
      lineHeight: 1.3,
      tone: 'ink',
      gapBefore: 22,
    },
    footer: {
      role: 'label',
      font: 'body',
      weight: 400,
      maxLines: 1,
      maxSize: 26,
      lineHeight: 1.25,
      tone: 'muted',
      gapBefore: 28,
    },
  },
};
