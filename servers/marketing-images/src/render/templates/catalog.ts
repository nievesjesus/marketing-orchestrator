import { readFileSync } from 'node:fs';
import type { VariableSpec } from '../../templates-store.js';
import type { TextsInput } from '../layout.js';
import type { TemplateSpec } from './types.js';

/**
 * Catalog data for the built-in templates: tags, sample content for the preview pictures, the variables schema of the starter HTML,
 * and the starter HTML itself (hand-written equivalents in `starters/*.html`, loaded from disk; the build copies the folder to dist/).
 * The starters are NOT pixel-identical to the built-ins: they are a starting point an agent can remix with compose_custom.
 */

export interface BuiltinInfo {
  tags: string[];
  /** Sample content used for the catalog previews. */
  sample: TextsInput;
  /** Whether the template shows a photo (preview gets a sample photo; starter has an optional `background` image variable). */
  photo: boolean;
}

export const BUILTIN_INFO: Record<string, BuiltinInfo> = {
  'photo-headline': {
    tags: ['photo', 'headline', 'announcement'],
    sample: { eyebrow: 'New season', headline: 'Fresh flavors, made today', body: 'Seasonal ingredients from nearby farms, on the menu now.', footer: 'example.com' },
    photo: true,
  },
  'cta-card': {
    tags: ['cta', 'offer', 'color'],
    sample: { eyebrow: 'Limited offer', headline: 'Book your table this week', body: 'Reserve now and get a free dessert.', cta: 'Book now', footer: 'example.com' },
    photo: false,
  },
  'quote-card': {
    tags: ['quote', 'testimonial', 'color'],
    sample: { eyebrow: 'Reviews', headline: 'The best coffee I have had in the city, and the people are even better.', footer: 'Ana M., customer' },
    photo: false,
  },
  split: {
    tags: ['photo', 'panel', 'explainer'],
    sample: { eyebrow: 'New menu', headline: 'Autumn on a plate', body: 'Pumpkin, chestnuts and slow-roasted roots.', cta: 'See the menu', footer: 'example.com' },
    photo: true,
  },
  'minimal-badge': {
    tags: ['photo', 'badge', 'price', 'minimal'],
    sample: { eyebrow: 'New', headline: 'From $12', body: 'Single-origin coffee, roasted weekly.', footer: 'example.com' },
    photo: true,
  },
  'carousel-cover': {
    tags: ['carousel', 'cover', 'photo'],
    sample: { eyebrow: '5 tips', headline: 'Make better coffee at home', body: 'Simple habits that change the cup.', cta: 'Swipe', footer: 'example.com' },
    photo: true,
  },
  'carousel-point': {
    tags: ['carousel', 'tips', 'list', 'color'],
    sample: { number: '1', eyebrow: 'Tip', headline: 'Grind just before brewing', body: 'Ground coffee loses aroma within minutes. Grind only what you will use and the difference shows in the first sip.', footer: '@example' },
    photo: false,
  },
  'carousel-end': {
    tags: ['carousel', 'cta', 'closing', 'color'],
    sample: { eyebrow: 'That is all', headline: 'Save this post', body: 'And share it with someone who loves coffee.', cta: 'Follow us', footer: '@example' },
    photo: false,
  },
};

const TEXT_LABELS: Record<string, { description: string; max_chars?: number }> = {
  headline: { description: 'Main message (short).', max_chars: 45 },
  eyebrow: { description: 'Small label above the headline.', max_chars: 30 },
  body: { description: 'Short paragraph.', max_chars: 160 },
  cta: { description: 'Button text, 2-4 words.', max_chars: 24 },
  footer: { description: 'Small line at the bottom (website, @handle, author).', max_chars: 40 },
  number: { description: 'Point number shown in a tag.', max_chars: 3 },
};

/** The variables of a built-in's starter HTML (the same names compose_post uses for `texts`, plus the optional `background` photo). */
export function builtinVariables(spec: TemplateSpec): VariableSpec[] {
  const info = BUILTIN_INFO[spec.id];
  const out: VariableSpec[] = [];
  for (const field of ['number', 'eyebrow', 'headline', 'body', 'cta', 'footer'] as const) {
    if (!spec.supports.includes(field)) continue;
    const label = TEXT_LABELS[field];
    // A quote (headline slot with the body role) is running text, not a short headline.
    const maxChars = field === 'headline' && spec.slots.headline?.role === 'body' ? 160 : label?.max_chars;
    out.push({
      name: field,
      kind: 'text',
      required: field === 'headline',
      ...(maxChars !== undefined ? { max_chars: maxChars } : {}),
      ...(info?.sample[field] !== undefined ? { example: info.sample[field] as string } : {}),
      ...(label ? { description: label.description } : {}),
    });
  }
  if (info?.photo) out.push({ name: 'background', kind: 'image', required: false, description: 'Photo behind the text (public https link). Without it the brand primary color shows.' });
  return out;
}

const STARTERS = new Map<string, string>();

export function starterHtml(id: string): string {
  const cached = STARTERS.get(id);
  if (cached !== undefined) return cached;
  const html = readFileSync(new URL(`./starters/${id}.html`, import.meta.url), 'utf8').trim();
  STARTERS.set(id, html);
  return html;
}
