import { ctaCard } from './ctaCard.js';
import type { TemplateSpec } from './types.js';

/** Last slide of a carousel: the same card as cta-card (DESIGN section 5.1: carousel-end = cta-card). */
export const carouselEnd: TemplateSpec = {
  ...ctaCard,
  id: 'carousel-end',
  title: 'Carousel closing slide',
  description:
    'Last slide of a carousel: solid brand-color card with a large centered headline, an optional line of text, a pill button with the call to action and an optional footer such as a @handle; logo in a corner.',
  best_for: 'Final slide of a carousel: "save this post", "follow us", "book now". Same look as cta-card so the series closes like a campaign.',
};
