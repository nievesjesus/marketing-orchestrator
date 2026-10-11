import type { TemplateSpec } from './types.js';

/** Brand-color field, a large accent quotation mark, the quote, and the author line. */
export const quoteCard: TemplateSpec = {
  id: 'quote-card',
  title: 'Quote card',
  description:
    'Brand-color card (or gradient/photo) with a large accent quotation mark, the quote in big type and the author or source below; logo in a corner.',
  best_for: 'Customer testimonials, reviews, tips, sayings, short statements. The quote is `headline`, the author is `footer`.',
  supports: ['eyebrow', 'headline', 'footer'],
  background: 'brand-primary',
  defaults: { align: 'left', textPosition: 'center' },
  logo: { corner: 'bottom-right' },
  block: {
    maxHeight: { square: 0.74, portrait: 0.7, landscape: 0.8 },
    maxWidth: { square: 1, portrait: 1, landscape: 0.82 },
  },
  lead: {
    kind: 'mark',
    text: '“',
    gapAfter: 6,
    slot: { role: 'label', font: 'heading', weight: 700, maxLines: 1, maxSize: 240, lineHeight: 0.62, tone: 'accent', gapBefore: 0 },
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
    // The quote is running text, so it uses the body floor (32 px) instead of the headline floor (90 px).
    headline: {
      role: 'body',
      font: 'heading',
      weight: 400,
      maxLines: 8,
      maxSize: 100,
      lineHeight: 1.18,
      balance: true,
      tone: 'ink',
      gapBefore: 20,
    },
    footer: {
      role: 'label',
      font: 'accent',
      weight: 700,
      maxLines: 2,
      maxSize: 36,
      lineHeight: 1.25,
      tone: 'accent',
      gapBefore: 44,
    },
  },
};
