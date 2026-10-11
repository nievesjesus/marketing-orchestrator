import type { TemplateSpec } from './types.js';

/**
 * Brand-primary field, headline in paper (or whatever reads best), an accent pill button with the CTA, logo.
 * Rule from the ugc-ads-generator end card: bg = primary, headline = paper, button = accent.
 */
export const ctaCard: TemplateSpec = {
  id: 'cta-card',
  title: 'Call-to-action card',
  description:
    'Solid brand-color card with a large centered headline, optional short paragraph and a pill-shaped button with the call to action; logo in a corner.',
  best_for: 'Offers, sign-ups, events, "book now" / "write to us" posts, the last slide of a series.',
  supports: ['eyebrow', 'headline', 'body', 'cta', 'footer'],
  background: 'brand-primary',
  defaults: { align: 'center', textPosition: 'center' },
  logo: { corner: 'top-left' },
  block: {
    maxHeight: { square: 0.8, portrait: 0.75, landscape: 0.85 },
    maxWidth: { square: 1, portrait: 1, landscape: 0.75 },
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
      maxLines: 5,
      maxSize: 140,
      lineHeight: 1.05,
      balance: true,
      tone: 'ink',
      gapBefore: 24,
    },
    body: {
      role: 'body',
      font: 'body',
      weight: 400,
      maxLines: 4,
      maxSize: 46,
      lineHeight: 1.35,
      tone: 'ink',
      gapBefore: 30,
    },
    cta: {
      role: 'label',
      font: 'heading',
      weight: 700,
      maxLines: 1,
      maxSize: 44,
      lineHeight: 1.1,
      tone: 'ink',
      gapBefore: 0,
    },
    footer: {
      role: 'label',
      font: 'body',
      weight: 400,
      maxLines: 1,
      maxSize: 28,
      lineHeight: 1.25,
      tone: 'muted',
      gapBefore: 40,
    },
  },
  button: { paddingX: 1.5, paddingY: 0.55, gapBefore: 52 },
};
