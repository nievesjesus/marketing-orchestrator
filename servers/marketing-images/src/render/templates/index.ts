import { carouselCover } from './carouselCover.js';
import { carouselEnd } from './carouselEnd.js';
import { carouselPoint } from './carouselPoint.js';
import { ctaCard } from './ctaCard.js';
import { minimalBadge } from './minimalBadge.js';
import { photoHeadline } from './photoHeadline.js';
import { quoteCard } from './quoteCard.js';
import { split } from './split.js';
import type { TemplateSpec } from './types.js';

export type { TemplateSpec, TextField, Align, TextPosition, LogoCorner, SlotSpec, TextRole, TextTone } from './types.js';
export { TEXT_FIELDS } from './types.js';

export const TEMPLATES: readonly TemplateSpec[] = [photoHeadline, ctaCard, quoteCard, split, minimalBadge, carouselCover, carouselPoint, carouselEnd];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id) as [string, ...string[]];

export function getTemplate(id: string): TemplateSpec | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
