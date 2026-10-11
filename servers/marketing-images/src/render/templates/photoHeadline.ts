import type { TemplateSpec } from './types.js';

/** Full-bleed photo, gradient scrim, eyebrow + headline + optional body, logo in a corner. */
export const photoHeadline: TemplateSpec = {
  id: 'photo-headline',
  title: 'Photo with headline',
  description:
    'Full-bleed photo with a soft dark gradient at the text side, a small eyebrow label, a big headline and an optional short paragraph; logo in a corner.',
  best_for: 'Announcements, news, product or place photos, quotes over a photo.',
  supports: ['eyebrow', 'headline', 'body', 'footer'],
  background: 'photo',
  defaults: { align: 'left', textPosition: 'bottom' },
  logo: { corner: 'top-left' },
  block: {
    maxHeight: { square: 0.62, portrait: 0.55, landscape: 0.75 },
    maxWidth: { square: 1, portrait: 1, landscape: 0.7 },
  },
  slots: {
    eyebrow: {
      role: 'label',
      font: 'heading',
      weight: 700,
      maxLines: 1,
      maxSize: 30,
      lineHeight: 1.2,
      letterSpacing: 0.14,
      uppercase: true,
      tone: 'accent',
      gapBefore: 0,
    },
    headline: {
      role: 'headline',
      font: 'heading',
      weight: 700,
      maxLines: 4,
      maxSize: 135,
      lineHeight: 1.05,
      balance: true,
      tone: 'ink',
      gapBefore: 22,
    },
    body: {
      role: 'body',
      font: 'body',
      weight: 400,
      maxLines: 4,
      maxSize: 44,
      lineHeight: 1.35,
      tone: 'ink',
      gapBefore: 28,
    },
    footer: {
      role: 'label',
      font: 'body',
      weight: 400,
      maxLines: 1,
      maxSize: 28,
      lineHeight: 1.25,
      tone: 'muted',
      gapBefore: 36,
    },
  },
};
