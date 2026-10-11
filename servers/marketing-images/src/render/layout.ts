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
}

export interface PlacedLine {
  field: TextField;
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
}

export interface Layout {
  lines: PlacedLine[];
  button?: PlacedButton;
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
  field: TextField;
  spec: SlotSpec;
  face: FontFace;
  meter: TextMeter;
  text: string;
  gap: number;
  fit: FitResult;
}

const ORDER: readonly TextField[] = TEXT_FIELDS;

function sizes(spec: SlotSpec, scale: number): { min: number; max: number } {
  return { min: Math.round(FLOORS[spec.role] * scale), max: Math.round(spec.maxSize * scale) };
}

export function layoutText(args: LayoutArgs): Layout {
  const { template, format, brand, fonts, region, warnings } = args;
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

  const faceFor = (spec: SlotSpec): FontFace =>
    fonts.resolve(spec.font === 'heading' ? brand.fonts.heading : brand.fonts.body, spec.font === 'heading' ? DEFAULT_HEADING_FAMILY : DEFAULT_BODY_FAMILY, spec.weight, spec.italic ?? false).face;

  const prepare = (field: TextField, spec: SlotSpec): { text: string; meter: TextMeter; face: FontFace } | undefined => {
    const raw = present(field);
    if (raw === undefined) return undefined;
    const face = faceFor(spec);
    const meter = new TextMeter(face);
    const prepared = prepareText(spec.uppercase ? raw.toUpperCase() : raw, meter);
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

  // ---- fixed-height slots: eyebrow, footer, button ---------------------------------
  const blocks: Partial<Record<TextField, Block>> = {};
  const gapOf = (spec: SlotSpec): number => Math.round(spec.gapBefore * scale);

  for (const field of ['eyebrow', 'footer'] as const) {
    const spec = template.slots[field];
    if (!spec) continue;
    const p = prepare(field, spec);
    if (!p) continue;
    const fit = fitSlot(spec, p, blockW, Math.ceil(sizes(spec, scale).max * spec.lineHeight * spec.maxLines), true);
    if (fit.truncated) warn(warnings, `${field}_shortened`, `The ${field} was shortened with "..." to fit.`, 'Use a shorter text if it matters.');
    blocks[field] = { field, spec, ...p, gap: gapOf(spec), fit };
  }

  let button: { block: Block; padX: number; padY: number; w: number; h: number; gap: number } | undefined;
  const ctaSpec = template.slots.cta;
  if (ctaSpec && template.button) {
    const p = prepare('cta', ctaSpec);
    if (p) {
      const { min, max } = sizes(ctaSpec, scale);
      let size = max;
      let fit = fitSlot(ctaSpec, p, blockW, Math.ceil(max * ctaSpec.lineHeight), true, 1);
      const pillWidth = (s: number): number => p.meter.emWidth(fit.lines[0] ?? '') * s + 2 * template.button!.paddingX * s;
      size = fit.size;
      // Pill must fit the block width: shrink the text until it does (never below the label floor).
      while (pillWidth(size) > blockW && size > min) size -= 1;
      if (pillWidth(size) > blockW) {
        fit = fitText({
          text: p.text,
          meter: p.meter,
          maxWidth: blockW - 2 * template.button.paddingX * min,
          maxHeight: Math.ceil(min * ctaSpec.lineHeight),
          maxLines: 1,
          minSize: min,
          maxSize: min,
          lineHeight: ctaSpec.lineHeight,
          allowEllipsis: true,
        });
        size = min;
        warn(warnings, 'cta_shortened', 'The call-to-action text was shortened with "..." to fit the button.', 'Use a shorter CTA (2-4 words).');
      }
      const line = fit.lines[0] ?? '';
      const padX = Math.round(template.button.paddingX * size);
      const padY = Math.round(template.button.paddingY * size);
      const textW = Math.ceil(p.meter.emWidth(line) * size);
      const lineH = Math.round(size * ctaSpec.lineHeight);
      const block: Block = { field: 'cta', spec: ctaSpec, ...p, gap: 0, fit: { ...fit, size, lines: [line], lineHeightPx: lineH, height: lineH } };
      button = {
        block,
        padX,
        padY,
        w: Math.min(blockW, textW + 2 * padX),
        h: lineH + 2 * padY,
        gap: Math.round(template.button.gapBefore * scale),
      };
    }
  }

  // ---- flexible slots: headline and body share what is left ---------------------------
  // The headline has priority. When it cannot stay at or above its floor, optional parts are given up in
  // this order, each reported as a warning: shorter body, no body, no footer, no eyebrow.
  const headlineSpec = template.slots.headline;
  const bodySpec = template.slots.body;
  if (!headlineSpec) throw new Error(`template ${template.id} has no headline slot`);
  const headlineP = prepare('headline', headlineSpec);
  if (!headlineP) throw new Error('headline is empty');
  const bodyP = bodySpec ? prepare('body', bodySpec) : undefined;
  const bodyGap = bodySpec && bodyP ? gapOf(bodySpec) : 0;

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
  const plans: Plan[] = bodyP
    ? [
        { body: 0.38, footer: true, eyebrow: true },
        { body: 0.2, footer: true, eyebrow: true },
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
    const fixedHeight = (eyebrow?.fit.height ?? 0) + (footer?.fit.height ?? 0) + (button?.h ?? 0);
    const fixedGaps = (eyebrow ? gapOf(headlineSpec) : 0) + (button ? button.gap : 0) + (footer ? footer.gap : 0);
    const room = Math.max(0, blockH - fixedHeight - fixedGaps);
    let bodyFit: FitResult | undefined;
    let bodyUsed = 0;
    if (bodyP && bodySpec && plan.body > 0) {
      bodyFit = fitSlot(bodySpec, bodyP, blockW, Math.max(0, (room - bodyGap) * plan.body), true);
      bodyUsed = bodyFit.height + bodyGap;
    }
    const headlineFit = fitSlot(headlineSpec, headlineP, blockW, Math.max(0, room - bodyUsed), false);
    return { plan, headlineFit, bodyFit };
  };

  let solved: Solved | undefined;
  for (const plan of plans) {
    const attempt = solve(plan);
    solved = attempt;
    if (attempt.headlineFit.fits) break;
  }
  if (!solved) throw new Error('unreachable: no layout plan');
  const { plan, headlineFit, bodyFit } = solved;

  if (headlineFit.fits) {
    if (bodyP && plan.body === 0) warn(warnings, 'body_dropped', 'The body text was left out to keep the headline large enough to read.', 'Use a shorter headline or shorter body text.');
    else if (bodyP && (plan.body < 0.38 || bodyFit?.truncated)) warn(warnings, 'body_shortened', 'The body text was shortened to keep the headline readable.', 'Use a shorter body text.');
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
  blocks.headline = { field: 'headline', spec: headlineSpec, ...headlineP, gap: gapOf(headlineSpec), fit: headlineFit };
  if (bodyP && bodySpec && bodyFit) blocks.body = { field: 'body', spec: bodySpec, ...bodyP, gap: bodyGap, fit: bodyFit };

  // ---- vertical stack -----------------------------------------------------------------
  type Item = { kind: 'text'; block: Block } | { kind: 'button'; gap: number; h: number };
  const items: Item[] = [];
  for (const field of ORDER) {
    if (field === 'cta') {
      if (button) items.push({ kind: 'button', gap: button.gap, h: button.h });
      continue;
    }
    const block = blocks[field];
    if (block) items.push({ kind: 'text', block });
  }
  const itemHeight = (item: Item): number => (item.kind === 'text' ? item.block.fit.height : item.h);
  const itemGap = (item: Item): number => (item.kind === 'text' ? item.block.gap : item.gap);
  const totalHeight = items.reduce((sum, item, i) => sum + itemHeight(item) + (i === 0 ? 0 : itemGap(item)), 0);

  const limitTop = Math.round(format.height * 0.02);
  let top: number;
  if (args.position === 'top') top = region.y;
  else if (args.position === 'bottom') top = region.y + region.h - totalHeight;
  else top = region.y + Math.round((region.h - totalHeight) / 2);
  top = Math.max(limitTop, top);

  // ---- place --------------------------------------------------------------------------
  const lines: PlacedLine[] = [];
  let buttonPlacement: PlacedButton | undefined;
  let cursor = top;
  let minX = Infinity;
  let maxX = -Infinity;
  const extend = (x: number, w: number): void => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + w);
  };

  items.forEach((item, i) => {
    if (i > 0) cursor += itemGap(item);
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
    } else if (button) {
      const bx = args.align === 'left' ? blockX : args.align === 'center' ? blockX + Math.round((blockW - button.w) / 2) : blockX + blockW - button.w;
      const lineH = Math.round(button.block.fit.lineHeightPx);
      buttonPlacement = {
        x: bx,
        y: cursor,
        w: button.w,
        h: button.h,
        line: {
          field: 'cta',
          text: button.block.fit.lines[0] ?? '',
          x: bx + button.padX,
          y: cursor + button.padY,
          w: button.w - 2 * button.padX,
          h: lineH,
          size: button.block.fit.size,
          face: button.block.face,
          letterSpacingEm: 0,
          align: 'center',
          tone: 'ink',
        },
      };
      extend(bx, button.w);
      cursor += button.h;
    }
  });

  const rect: Rect = {
    x: Number.isFinite(minX) ? minX : blockX,
    y: top,
    w: Number.isFinite(minX) ? maxX - minX : blockW,
    h: Math.max(1, cursor - top),
  };
  return { lines, ...(buttonPlacement ? { button: buttonPlacement } : {}), rect, anchor: args.position, align: args.align };
}
