import { estimateCapacityChars, fitText, prepareText, TextMeter, type FitResult } from './fit.js';
import { DEFAULT_BODY_FAMILY, DEFAULT_HEADING_FAMILY, type FontFace, type FontRegistry } from './fonts.js';
import { scaleOf, type FormatSpec, type Rect } from './formats.js';
import type { ResolvedBrand } from './brand.js';
import type { Align, SlotSpec, TemplateSpec, TextField, TextPosition, TextRole, TextTone } from './templates/index.js';
import { TEXT_FIELDS } from './templates/index.js';
import { warn, type RenderWarning } from './warnings.js';

/**
 * Template layout engine: turns template data + texts + format into positioned lines.
 * Minimum sizes at the 1080-px reference (DESIGN section 5.1, from HyperFrames typography guidance); other formats
 * scale by their SHORT side / 1080 (see `scaleOf`).
 */

export const FLOORS: Record<TextRole, number> = { headline: 90, body: 32, label: 24 };

export interface TextsInput {
  eyebrow?: string | undefined;
  headline: string;
  body?: string | undefined;
  cta?: string | undefined;
  footer?: string | undefined;
  /** Point number shown in a small tag (carousel-point). */
  number?: string | undefined;
}

export interface PlacedLine {
  /** `mark` is the decorative glyph of a quote card. */
  field: TextField | 'mark';
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  face: FontFace;
  letterSpacingEm: number;
  align: Align;
  tone: TextTone;
}

export interface PlacedButton {
  x: number;
  y: number;
  w: number;
  h: number;
  line: PlacedLine;
  /** Which element this is: the CTA button, the number tag of a carousel point, or the headline badge. */
  kind?: 'button' | 'chip' | 'badge';
  /** `underline` button style: no box is drawn, only a bar at `y` (absolute) of height `h` under the text. */
  underline?: { y: number; h: number };
}

export interface Layout {
  lines: PlacedLine[];
  button?: PlacedButton;
  chip?: PlacedButton;
  badge?: PlacedButton;
  /** Bounding box of everything drawn by the layout. */
  rect: Rect;
  anchor: TextPosition;
  align: Align;
}

export interface LayoutArgs {
  template: TemplateSpec;
  format: FormatSpec;
  texts: TextsInput;
  brand: ResolvedBrand;
  fonts: FontRegistry;
  /** Where text may go (title-safe, minus any logo band). */
  region: Rect;
  align: Align;
  position: TextPosition;
  warnings: RenderWarning[];
}

interface Block {
  field: TextField | 'mark';
  spec: SlotSpec;
  face: FontFace;
  meter: TextMeter;
  text: string;
  gap: number;
  fit: FitResult;
}

interface PillBlock {
  block: Block;
  padX: number;
  padY: number;
  w: number;
  h: number;
  textW: number;
  underline?: { gap: number; thick: number };
}

/** Stacking order of the free-text slots. `number` is drawn by the template's `lead` chip, not here. */
const ORDER: readonly TextField[] = ['eyebrow', 'headline', 'body', 'cta', 'footer'];

function sizes(spec: SlotSpec, scale: number): { min: number; max: number } {
  return { min: Math.round(FLOORS[spec.role] * scale), max: Math.round(spec.maxSize * scale) };
}

/** Capitalize the first letter of every word, leaving the rest as written ("iPhone" stays "iPhone"). */
export function titleCase(text: string): string {
  return text.replace(/(^|[\s\-–—/])(\p{L})/gu, (_m, lead: string, letter: string) => lead + letter.toLocaleUpperCase());
}

export function layoutText(args: LayoutArgs): Layout {
  const { template, format, brand, fonts, region, warnings } = args;
  const style = brand.style;
  const scale = scaleOf(format);
  const orientation = format.orientation;

  // Text block box inside the safe region.
  const blockW = Math.min(region.w, Math.round(template.block.maxWidth[orientation] * format.width));
  const blockH = Math.min(region.h, Math.round(template.block.maxHeight[orientation] * format.height));
  const blockX =
    args.align === 'left' ? region.x : args.align === 'center' ? region.x + Math.round((region.w - blockW) / 2) : region.x + region.w - blockW;

  for (const field of TEXT_FIELDS) {
    const raw = args.texts[field];
    if (raw !== undefined && raw.trim() !== '' && !template.supports.includes(field)) {
      warn(warnings, `${field}_ignored`, `The "${field}" text is not used by the ${template.id} template and was left out.`, 'Pick a template that supports it (see list_templates).');
    }
  }

  const present = (field: TextField): string | undefined => {
    const raw = args.texts[field];
    return raw === undefined || raw.trim() === '' || !template.supports.includes(field) ? undefined : raw;
  };

  // The brand style decides the eyebrow's letter case (and, optionally, its letter spacing).
  const slotOf = (field: TextField): SlotSpec | undefined => {
    const spec = template.slots[field];
    if (!spec || field !== 'eyebrow') return spec;
    const spacing = style.letter_spacing_eyebrow ?? (style.eyebrow_case === 'upper' ? spec.letterSpacing : Math.min(spec.letterSpacing ?? 0, 0.04));
    return { ...spec, uppercase: style.eyebrow_case === 'upper', ...(spacing !== undefined ? { letterSpacing: spacing } : {}) };
  };

  const faceFor = (spec: SlotSpec): FontFace => {
    const family = spec.font === 'heading' ? brand.fonts.heading : spec.font === 'body' ? brand.fonts.body : brand.fonts.accent;
    return fonts.resolve(family, spec.font === 'body' ? DEFAULT_BODY_FAMILY : DEFAULT_HEADING_FAMILY, spec.weight, spec.italic ?? false).face;
  };

  const caseText = (field: TextField | 'mark', spec: SlotSpec, raw: string): string => {
    if (field === 'eyebrow' && style.eyebrow_case === 'title') return titleCase(raw);
    return spec.uppercase ? raw.toUpperCase() : raw;
  };

  const prepare = (field: TextField, spec: SlotSpec, rawText?: string): { text: string; meter: TextMeter; face: FontFace } | undefined => {
    const raw = rawText ?? present(field);
    if (raw === undefined) return undefined;
    const face = faceFor(spec);
    const meter = new TextMeter(face);
    const prepared = prepareText(caseText(field, spec, raw), meter);
    if (prepared.removed.length > 0) {
      warn(
        warnings,
        'unsupported_characters',
        `Some characters in the ${field} cannot be drawn by the font and were removed: ${prepared.removed.join(' ')}`,
        'Emoji and symbols are not supported in composed graphics; put them in the post caption instead.',
      );
    }
    return prepared.text === '' ? undefined : { text: prepared.text, meter, face };
  };

  const fitSlot = (
    spec: SlotSpec,
    p: { text: string; meter: TextMeter },
    width: number,
    height: number,
    allowEllipsis: boolean,
    maxLines = spec.maxLines,
  ): FitResult => {
    const { min, max } = sizes(spec, scale);
    return fitText({
      text: p.text,
      meter: p.meter,
      maxWidth: width,
      maxHeight: height,
      maxLines,
      minSize: min,
      maxSize: max,
      lineHeight: spec.lineHeight,
      letterSpacingEm: spec.letterSpacing ?? 0,
      balance: spec.balance ?? false,
      allowEllipsis,
    });
  };

  const gapOf = (spec: SlotSpec): number => Math.round(spec.gapBefore * scale);

  /**
   * One line of text inside a filled shape: the CTA button, the number tag, or the headline badge.
   * Em-based padding follows the text size; the text shrinks (never below the label floor) until the shape fits.
   */
  const buildPill = (
    spec: SlotSpec,
    p: { text: string; meter: TextMeter; face: FontFace },
    cfg: { paddingX: number; paddingY: number },
    kind: 'button' | 'chip' | 'badge',
    shortenCode: string,
    shortenMessage: string,
  ): PillBlock => {
    const underline = kind === 'button' && style.button === 'underline';
    const padXEm = underline ? 0 : cfg.paddingX;
    const padYEm = underline ? 0 : cfg.paddingY;
    const { min, max } = sizes(spec, scale);
    let fit = fitSlot(spec, p, blockW, Math.ceil(max * spec.lineHeight), true, 1);
    const pillWidth = (s: number): number => p.meter.emWidth(fit.lines[0] ?? '') * s + 2 * padXEm * s;
    let size = fit.size;
    // The shape must fit the block width: shrink the text until it does (never below the label floor).
    while (pillWidth(size) > blockW && size > min) size -= 1;
    if (pillWidth(size) > blockW) {
      fit = fitText({
        text: p.text,
        meter: p.meter,
        maxWidth: blockW - 2 * padXEm * min,
        maxHeight: Math.ceil(min * spec.lineHeight),
        maxLines: 1,
        minSize: min,
        maxSize: min,
        lineHeight: spec.lineHeight,
        allowEllipsis: true,
      });
      size = min;
      warn(warnings, shortenCode, shortenMessage, 'Use a shorter text (2-4 words).');
    }
    const line = fit.lines[0] ?? '';
    const padX = Math.round(padXEm * size);
    const padY = Math.round(padYEm * size);
    const textW = Math.ceil(p.meter.emWidth(line) * size);
    const lineH = Math.round(size * spec.lineHeight);
    const block: Block = { field: kind === 'chip' ? 'number' : kind === 'badge' ? 'headline' : 'cta', spec, ...p, gap: 0, fit: { ...fit, size, lines: [line], lineHeightPx: lineH, height: lineH } };
    if (underline) {
      const gap = Math.round(size * 0.22);
      const thick = Math.max(3, Math.round(size * 0.1));
      return { block, padX, padY, w: Math.min(blockW, textW), h: lineH + gap + thick, textW, underline: { gap, thick } };
    }
    return { block, padX, padY, w: Math.min(blockW, textW + 2 * padX), h: lineH + 2 * padY, textW };
  };

  // ---- fixed-height slots: eyebrow, footer ---------------------------------------
  const blocks: Partial<Record<TextField, Block>> = {};

  for (const field of ['eyebrow', 'footer'] as const) {
    const spec = slotOf(field);
    if (!spec) continue;
    const p = prepare(field, spec);
    if (!p) continue;
    const fit = fitSlot(spec, p, blockW, Math.ceil(sizes(spec, scale).max * spec.lineHeight * spec.maxLines), true);
    if (fit.truncated) warn(warnings, `${field}_shortened`, `The ${field} was shortened with "..." to fit.`, 'Use a shorter text if it matters.');
    blocks[field] = { field, spec, ...p, gap: gapOf(spec), fit };
  }

  // ---- lead item above the stack: quote mark or number tag ---------------------------
  const lead = template.lead;
  let leadMark: Block | undefined;
  let leadChip: PillBlock | undefined;
  if (lead?.kind === 'mark') {
    const face = faceFor(lead.slot);
    const meter = new TextMeter(face);
    if (meter.hasGlyph(lead.text)) {
      const fit = fitSlot(lead.slot, { text: lead.text, meter }, blockW, Math.ceil(sizes(lead.slot, scale).max * lead.slot.lineHeight), false, 1);
      leadMark = { field: 'mark', spec: lead.slot, text: lead.text, meter, face, gap: 0, fit };
    }
  } else if (lead?.kind === 'chip') {
    const p = prepare('number', lead.slot);
    if (p) leadChip = buildPill(lead.slot, p, lead, 'chip', 'number_shortened', 'The number tag was shortened with "..." to fit.');
  }
  const leadHeight = leadMark?.fit.height ?? leadChip?.h ?? 0;
  const leadGap = lead && (leadMark || leadChip) ? Math.round(lead.gapAfter * scale) : 0;

  // ---- CTA button (own shape, own gap) ------------------------------------------------
  let button: (PillBlock & { gap: number }) | undefined;
  const ctaSpec = slotOf('cta');
  if (ctaSpec && template.button) {
    const p = prepare('cta', ctaSpec);
    if (p) button = { ...buildPill(ctaSpec, p, template.button, 'button', 'cta_shortened', 'The call-to-action text was shortened with "..." to fit the button.'), gap: Math.round(template.button.gapBefore * scale) };
  }

  // ---- flexible slots: headline and body share what is left ---------------------------
  // The headline has priority. When it cannot stay at or above its floor, optional parts are given up in
  // this order, each reported as a warning: shorter body, no body, no footer, no eyebrow.
  const headlineSpec = slotOf('headline');
  const bodySpec = slotOf('body');
  if (!headlineSpec) throw new Error(`template ${template.id} has no headline slot`);
  const headlineP = prepare('headline', headlineSpec);
  if (!headlineP) throw new Error('headline is empty');
  const bodyP = bodySpec ? prepare('body', bodySpec) : undefined;
  const bodyGap = bodySpec && bodyP ? gapOf(bodySpec) : 0;

  let badge: (PillBlock & { gap: number }) | undefined;
  let headlineFit: FitResult;
  let bodyFit: FitResult | undefined;

  if (template.badge) {
    // The headline IS the badge: one line, fixed height. Body gets what is left, then goes.
    badge = { ...buildPill(headlineSpec, headlineP, template.badge, 'badge', 'headline_shortened', 'The badge text was shortened with "..." to fit.'), gap: Math.round(template.badge.gapBefore * scale) };
    headlineFit = badge.block.fit;
    const eyebrow = blocks.eyebrow;
    const footer = blocks.footer;
    const used = (): number =>
      leadHeight + (leadGap ? leadGap : 0) + (eyebrow?.fit.height ?? 0) + badge!.h + (eyebrow ? badge!.gap : 0) + (footer ? footer.fit.height + footer.gap : 0);
    if (bodyP && bodySpec) {
      const room = blockH - used() - bodyGap;
      const candidate = room > 0 ? fitSlot(bodySpec, bodyP, blockW, room, true) : undefined;
      if (candidate && candidate.fits) {
        bodyFit = candidate;
        if (candidate.truncated) warn(warnings, 'body_shortened', 'The body text was shortened to fit.', 'Use a shorter body text.');
      } else {
        warn(warnings, 'body_dropped', 'The body text was left out because there was no room for it.', 'Use a shorter body text.');
      }
    }
  } else {
    interface Plan {
      body: number; // share of the free height offered to the body (0 = no body)
      footer: boolean;
      eyebrow: boolean;
    }
    interface Solved {
      plan: Plan;
      headlineFit: FitResult;
      bodyFit: FitResult | undefined;
    }
    const firstShare = template.bodyShare ?? 0.38;
    const plans: Plan[] = bodyP
      ? [
          { body: firstShare, footer: true, eyebrow: true },
          { body: template.bodyShare === undefined ? 0.2 : firstShare / 2, footer: true, eyebrow: true },
          { body: 0, footer: true, eyebrow: true },
          { body: 0, footer: false, eyebrow: true },
          { body: 0, footer: false, eyebrow: false },
        ]
      : [
          { body: 0, footer: true, eyebrow: true },
          { body: 0, footer: false, eyebrow: true },
          { body: 0, footer: false, eyebrow: false },
        ];

    const solve = (plan: Plan): Solved => {
      const eyebrow = plan.eyebrow ? blocks.eyebrow : undefined;
      const footer = plan.footer ? blocks.footer : undefined;
      const fixedHeight = leadHeight + (eyebrow?.fit.height ?? 0) + (footer?.fit.height ?? 0) + (button?.h ?? 0);
      const fixedGaps = leadGap + (eyebrow ? gapOf(headlineSpec) : 0) + (button ? button.gap : 0) + (footer ? footer.gap : 0);
      const room = Math.max(0, blockH - fixedHeight - fixedGaps);
      let fitBody: FitResult | undefined;
      let bodyUsed = 0;
      if (bodyP && bodySpec && plan.body > 0) {
        fitBody = fitSlot(bodySpec, bodyP, blockW, Math.max(0, (room - bodyGap) * plan.body), true);
        bodyUsed = fitBody.height + bodyGap;
      }
      const fitHeadline = fitSlot(headlineSpec, headlineP, blockW, Math.max(0, room - bodyUsed), false);
      return { plan, headlineFit: fitHeadline, bodyFit: fitBody };
    };

    let solved: Solved | undefined;
    for (const plan of plans) {
      const attempt = solve(plan);
      solved = attempt;
      if (attempt.headlineFit.fits) break;
    }
    if (!solved) throw new Error('unreachable: no layout plan');
    const { plan } = solved;
    headlineFit = solved.headlineFit;
    bodyFit = solved.bodyFit;

    if (headlineFit.fits) {
      if (bodyP && plan.body === 0) warn(warnings, 'body_dropped', 'The body text was left out to keep the headline large enough to read.', 'Use a shorter headline or shorter body text.');
      else if (bodyP && (plan.body < firstShare || bodyFit?.truncated)) warn(warnings, 'body_shortened', 'The body text was shortened to keep the headline readable.', 'Use a shorter body text.');
      if (blocks.footer && !plan.footer) warn(warnings, 'footer_dropped', 'The footer line was left out to keep the headline large enough to read.', 'Use a shorter headline.');
      if (blocks.eyebrow && !plan.eyebrow) warn(warnings, 'eyebrow_dropped', 'The small label above the headline was left out to keep the headline large enough to read.', 'Use a shorter headline.');
    } else {
      const { min } = sizes(headlineSpec, scale);
      const chars = estimateCapacityChars(headlineP.meter, min, blockW, headlineSpec.maxLines);
      const reasonText = headlineFit.reason === 'word_too_long' ? 'one word is wider than the image' : 'it needs more lines than fit';
      warn(
        warnings,
        'headline_too_long',
        `The headline is too long to stay readable in this layout (${reasonText}). It was drawn at the smallest allowed size and may run past the safe area.`,
        `Ask for a shorter headline (about ${chars} characters or fewer for ${format.name}) and call compose_post again.`,
      );
    }
    if (!plan.eyebrow) delete blocks.eyebrow;
    if (!plan.footer) delete blocks.footer;
  }

  if (!template.badge) blocks.headline = { field: 'headline', spec: headlineSpec, ...headlineP, gap: gapOf(headlineSpec), fit: headlineFit };
  if (bodyP && bodySpec && bodyFit) blocks.body = { field: 'body', spec: bodySpec, ...bodyP, gap: bodyGap, fit: bodyFit };

  // ---- vertical stack -----------------------------------------------------------------
  type Item =
    | { kind: 'text'; block: Block; gap: number; h: number }
    | { kind: 'pill'; pill: PillBlock; role: 'button' | 'chip' | 'badge'; gap: number; h: number };
  const items: Item[] = [];
  const afterLead = (natural: number): number => (items.length === 1 && (leadMark || leadChip) ? leadGap : natural);
  if (leadMark) items.push({ kind: 'text', block: leadMark, gap: 0, h: leadMark.fit.height });
  else if (leadChip) items.push({ kind: 'pill', pill: leadChip, role: 'chip', gap: 0, h: leadChip.h });
  for (const field of ORDER) {
    if (field === 'cta') {
      if (button) items.push({ kind: 'pill', pill: button, role: 'button', gap: items.length === 0 ? 0 : afterLead(button.gap), h: button.h });
      continue;
    }
    if (field === 'headline' && badge) {
      items.push({ kind: 'pill', pill: badge, role: 'badge', gap: items.length === 0 ? 0 : afterLead(badge.gap), h: badge.h });
      continue;
    }
    const block = blocks[field];
    if (block) items.push({ kind: 'text', block, gap: items.length === 0 ? 0 : afterLead(block.gap), h: block.fit.height });
  }
  const totalHeight = items.reduce((sum, item) => sum + item.h + item.gap, 0);

  const limitTop = Math.round(format.height * 0.02);
  let top: number;
  if (args.position === 'top') top = region.y;
  else if (args.position === 'bottom') top = region.y + region.h - totalHeight;
  else top = region.y + Math.round((region.h - totalHeight) / 2);
  top = Math.max(limitTop, top);

  // ---- place --------------------------------------------------------------------------
  const lines: PlacedLine[] = [];
  const placedPills: Partial<Record<'button' | 'chip' | 'badge', PlacedButton>> = {};
  let cursor = top;
  let minX = Infinity;
  let maxX = -Infinity;
  const extend = (x: number, w: number): void => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + w);
  };

  for (const item of items) {
    cursor += item.gap;
    if (item.kind === 'text') {
      const { block } = item;
      for (const text of block.fit.lines) {
        const lineH = Math.round(block.fit.lineHeightPx);
        lines.push({
          field: block.field,
          text,
          x: blockX,
          y: cursor,
          w: blockW,
          h: lineH,
          size: block.fit.size,
          face: block.face,
          letterSpacingEm: block.spec.letterSpacing ?? 0,
          align: args.align,
          tone: block.spec.tone,
        });
        extend(blockX, blockW);
        cursor += lineH;
      }
    } else {
      const { pill } = item;
      const bx = args.align === 'left' ? blockX : args.align === 'center' ? blockX + Math.round((blockW - pill.w) / 2) : blockX + blockW - pill.w;
      const lineH = Math.round(pill.block.fit.lineHeightPx);
      const underline = pill.underline;
      placedPills[item.role] = {
        kind: item.role,
        x: bx,
        y: cursor,
        w: pill.w,
        h: pill.h,
        ...(underline ? { underline: { y: cursor + lineH + underline.gap, h: underline.thick } } : {}),
        line: {
          field: pill.block.field,
          text: pill.block.fit.lines[0] ?? '',
          x: bx + pill.padX,
          y: cursor + pill.padY,
          w: Math.max(1, pill.w - 2 * pill.padX),
          h: lineH,
          size: pill.block.fit.size,
          face: pill.block.face,
          letterSpacingEm: 0,
          align: 'center',
          tone: 'ink',
        },
      };
      extend(bx, pill.w);
      cursor += pill.h;
    }
  }

  const rect: Rect = {
    x: Number.isFinite(minX) ? minX : blockX,
    y: top,
    w: Number.isFinite(minX) ? maxX - minX : blockW,
    h: Math.max(1, cursor - top),
  };
  return {
    lines,
    ...(placedPills.button ? { button: placedPills.button } : {}),
    ...(placedPills.chip ? { chip: placedPills.chip } : {}),
    ...(placedPills.badge ? { badge: placedPills.badge } : {}),
    rect,
    anchor: args.position,
    align: args.align,
  };
}
