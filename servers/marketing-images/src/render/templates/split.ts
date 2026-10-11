import type { TemplateSpec } from './types.js';

/** Photo on one side, flat brand-primary panel with the text on the other. */
export const split: TemplateSpec = {
  id: 'split',
  title: 'Photo and text panel',
  description:
    'The image is split: a photo fills one part and a brand-color panel holds an eyebrow, headline, short paragraph and optional button; logo in a corner. Photo above the panel on feed formats, left of it on landscape.',
  best_for: 'Product or place photo with a clear explanation, announcements that need more words than a full-bleed photo allows, events with details.',
  supports: ['eyebrow', 'headline', 'body', 'cta', 'footer'],
  background: 'photo',
  defaults: { align: 'left', textPosition: 'center' },
  logo: { corner: 'top-left' },
  // Shares of the canvas are applied to the panel region, not the full canvas.
  block: {
    maxHeight: { square: 1, portrait: 1, landscape: 1 },
    maxWidth: { square: 1, portrait: 1, landscape: 1 },
  },
  split: {
    square: { side: 'top', share: 0.42 },
    portrait: { side: 'top', share: 0.42 },
    // Story: the platform UI covers the top and bottom bands, so the photo goes at the bottom (the UI may cover it) and the text panel sits above.
    story: { side: 'bottom', share: 0.42 },
    landscape: { side: 'left', share: 0.5 },
    link: { side: 'left', share: 0.46 },
  },
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
    headline: {
      role: 'headline',
      font: 'heading',
      weight: 700,
      maxLines: 5,
      maxSize: 110,
      lineHeight: 1.05,
      balance: true,
      tone: 'ink',
      gapBefore: 20,
    },
    body: {
      role: 'body',
      font: 'body',
      weight: 400,
      maxLines: 5,
      maxSize: 40,
      lineHeight: 1.35,
      tone: 'ink',
      gapBefore: 24,
    },
    cta: {
      role: 'label',
      font: 'accent',
      weight: 700,
      maxLines: 1,
      maxSize: 38,
      lineHeight: 1.1,
      tone: 'ink',
      gapBefore: 0,
    },
    footer: {
      role: 'label',
      font: 'body',
      weight: 400,
      maxLines: 1,
      maxSize: 26,
      lineHeight: 1.25,
      tone: 'muted',
      gapBefore: 32,
    },
  },
  button: { paddingX: 1.4, paddingY: 0.5, gapBefore: 40 },
};
