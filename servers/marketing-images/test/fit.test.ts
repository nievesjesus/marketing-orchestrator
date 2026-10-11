import { describe, expect, it } from 'vitest';
import { estimateCapacityChars, fitText, prepareText, TextMeter } from '../src/render/fit.js';
import { DEFAULT_BODY_FAMILY, DEFAULT_HEADING_FAMILY } from '../src/render/fonts.js';
import { FLOORS, layoutText } from '../src/render/layout.js';
import { FORMATS, FORMAT_NAMES, scaleOf, textSafeRect } from '../src/render/formats.js';
import { resolveBrand } from '../src/render/brand.js';
import { getTemplate } from '../src/render/templates/index.js';
import type { RenderWarning } from '../src/render/warnings.js';
import { fonts } from './helpers.js';

const heading = new TextMeter(fonts().resolve(DEFAULT_HEADING_FAMILY, DEFAULT_HEADING_FAMILY, 700, false).face);
const body = new TextMeter(fonts().resolve(DEFAULT_BODY_FAMILY, DEFAULT_BODY_FAMILY, 400, false).face);

const base = { meter: heading, maxWidth: 864, maxHeight: 520, maxLines: 4, minSize: 90, maxSize: 135, lineHeight: 1.05 };
const lineWidth = (meter: TextMeter, line: string, size: number): number => meter.emWidth(line) * size;

describe('fitText', () => {
  it('uses the biggest size for a short headline', () => {
    const r = fitText({ ...base, text: 'Abierto hoy' });
    expect(r.fits).toBe(true);
    expect(r.size).toBe(135);
    expect(r.lines.join(' ')).toBe('Abierto hoy');
  });

  it('shrinks to fit the box and never goes below the floor', () => {
    const r = fitText({ ...base, text: 'Nuevo menu de temporada con ingredientes locales' });
    expect(r.fits).toBe(true);
    expect(r.size).toBeGreaterThanOrEqual(90);
    expect(r.size).toBeLessThan(135);
    expect(r.lines.length).toBeLessThanOrEqual(4);
    for (const line of r.lines) expect(lineWidth(heading, line, r.size)).toBeLessThanOrEqual(864);
    expect(r.height).toBeLessThanOrEqual(520);
  });

  it('picks the LARGEST fitting size (one more pixel would not fit)', () => {
    const text = 'Cafe de especialidad tostado cada manana';
    const r = fitText({ ...base, text });
    const bigger = fitText({ ...base, text, minSize: r.size + 1, maxSize: r.size + 1 });
    expect(r.fits).toBe(true);
    expect(bigger.fits).toBe(false);
  });

  it('respects maxLines', () => {
    const text = 'uno dos tres cuatro cinco seis siete ocho nueve diez';
    const r = fitText({ ...base, text, maxLines: 2, maxHeight: 10_000, minSize: 20, maxSize: 135 });
    expect(r.fits).toBe(true);
    expect(r.lines.length).toBeLessThanOrEqual(2);
  });

  it('reports failure (and does NOT truncate) when a headline cannot fit at the floor', () => {
    const text = 'Este titular es demasiado largo para caber en cuatro lineas al tamano minimo legible de noventa pixeles';
    const r = fitText({ ...base, text, allowEllipsis: false });
    expect(r.fits).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.size).toBe(90);
    expect(r.reason).toBe('too_many_lines');
    expect(r.lines.join(' ')).toBe(text); // every word is still there
  });

  it('truncates with an ellipsis only when allowed (body text)', () => {
    const text = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua';
    const r = fitText({ meter: body, text, maxWidth: 800, maxHeight: 200, maxLines: 2, minSize: 32, maxSize: 44, lineHeight: 1.35, allowEllipsis: true });
    expect(r.truncated).toBe(true);
    expect(r.fits).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]?.endsWith('…')).toBe(true);
    for (const line of r.lines) expect(lineWidth(body, line, r.size)).toBeLessThanOrEqual(800);
  });

  it('handles Spanish accents, ñ, ¿¡ and capitals', () => {
    const text = '¿Qué tal una mañana de café con niños? ¡Sí!';
    const prepared = prepareText(text, heading);
    expect(prepared.removed).toEqual([]);
    expect(prepared.text).toBe(text);
    const r = fitText({ ...base, text: prepared.text });
    expect(r.fits).toBe(true);
    expect(r.lines.join(' ')).toBe(text);
    // Accented glyphs have real widths (not .notdef)
    expect(heading.hasGlyph('ñ')).toBe(true);
    expect(heading.hasGlyph('Á')).toBe(true);
    expect(heading.hasGlyph('¿')).toBe(true);
    expect(heading.emWidth('ñ')).toBeCloseTo(heading.emWidth('n'), 1);
  });

  it('normalizes decomposed accents (n + combining tilde) to the precomposed form', () => {
    const decomposed = 'baño';
    const prepared = prepareText(decomposed, heading);
    expect(prepared.text).toBe('baño');
    expect(prepared.removed).toEqual([]);
  });

  it('long words: shrinks until the word fits, fails at the floor when it never will', () => {
    const word = 'Electroencefalografista';
    const fits = fitText({ ...base, text: word, maxWidth: 864, minSize: 40, maxSize: 135, maxLines: 1 });
    expect(fits.fits).toBe(true);
    expect(lineWidth(heading, word, fits.size)).toBeLessThanOrEqual(864);

    const never = fitText({ ...base, text: 'Pneumonoultramicroscopicsilicovolcanoconiosis', maxLines: 4 });
    expect(never.fits).toBe(false);
    expect(never.reason).toBe('word_too_long');
    expect(never.size).toBe(90);
  });

  it('long words in body text are cut with an ellipsis when allowed', () => {
    const r = fitText({ meter: body, text: 'Supercalifragilisticoespialidosoextraordinariamentelargoyancho', maxWidth: 300, maxHeight: 200, maxLines: 2, minSize: 32, maxSize: 44, lineHeight: 1.3, allowEllipsis: true });
    expect(r.fits).toBe(true);
    expect(r.truncated).toBe(true);
    for (const line of r.lines) expect(lineWidth(body, line, r.size)).toBeLessThanOrEqual(300);
  });

  it('balances headline lines (last line is not a lonely word)', () => {
    const text = 'Descubre el sabor de nuestro nuevo menu';
    const plain = fitText({ ...base, text, maxLines: 4 });
    const balanced = fitText({ ...base, text, maxLines: 4, balance: true });
    expect(balanced.size).toBe(plain.size);
    expect(balanced.lines.length).toBe(plain.lines.length);
    const spread = (lines: string[]): number => Math.max(...lines.map((l) => l.length)) - Math.min(...lines.map((l) => l.length));
    expect(spread(balanced.lines)).toBeLessThanOrEqual(spread(plain.lines));
    expect(balanced.lines.join(' ')).toBe(text);
  });

  it('honours explicit line breaks', () => {
    const r = fitText({ ...base, text: 'Primera\nSegunda', maxLines: 4 });
    expect(r.lines).toEqual(['Primera', 'Segunda']);
  });

  it('letter spacing is part of the measurement', () => {
    const text = 'NUEVA TEMPORADA';
    const tight = fitText({ meter: heading, text, maxWidth: 400, maxHeight: 200, maxLines: 1, minSize: 10, maxSize: 60, lineHeight: 1.2, letterSpacingEm: 0 });
    const spaced = fitText({ meter: heading, text, maxWidth: 400, maxHeight: 200, maxLines: 1, minSize: 10, maxSize: 60, lineHeight: 1.2, letterSpacingEm: 0.14 });
    expect(spaced.size).toBeLessThan(tight.size);
  });

  it('estimates a sensible character capacity', () => {
    const n = estimateCapacityChars(heading, 90, 864, 4);
    expect(n).toBeGreaterThan(30);
    expect(n).toBeLessThan(90);
  });
});

describe('prepareText', () => {
  it('removes characters the font cannot draw and reports them', () => {
    const r = prepareText('Hola \u{1F600} mundo', heading);
    expect(r.text).toBe('Hola mundo');
    expect(r.removed).toEqual(['\u{1F600}']);
  });

  it('collapses whitespace and strips control characters', () => {
    expect(prepareText('  a\t\tb \u0000 c  ', heading).text).toBe('a b c');
  });
});

describe('layout: floors, safe zones and templates in every format', () => {
  const warnings = (): RenderWarning[] => [];

  for (const templateId of ['photo-headline', 'cta-card']) {
    for (const name of FORMAT_NAMES) {
      it(`${templateId} / ${name}: text stays inside the title-safe area at or above the floors`, () => {
        const template = getTemplate(templateId)!;
        const format = FORMATS[name];
        const w = warnings();
        const brand = resolveBrand(undefined, fonts(), w);
        const layout = layoutText({
          template,
          format,
          texts: { eyebrow: 'Nueva temporada', headline: 'Café de especialidad cada mañana', body: 'Ven a probar el menú de otoño.', cta: 'Reservar ahora', footer: 'cafeejemplo.com' },
          brand,
          fonts: fonts(),
          region: textSafeRect(format),
          align: template.defaults.align,
          position: template.defaults.textPosition,
          warnings: w,
        });
        const safe = textSafeRect(format);
        const scale = scaleOf(format);
        expect(w.filter((x) => x.code === 'headline_too_long')).toEqual([]);
        for (const line of layout.lines) {
          expect(line.x).toBeGreaterThanOrEqual(safe.x);
          expect(line.x + line.w).toBeLessThanOrEqual(safe.x + safe.w + 1);
          expect(line.y).toBeGreaterThanOrEqual(safe.y - 1);
          expect(line.y + line.h).toBeLessThanOrEqual(safe.y + safe.h + 1);
          const floor = line.field === 'headline' ? FLOORS.headline : line.field === 'body' ? FLOORS.body : FLOORS.label;
          expect(line.size).toBeGreaterThanOrEqual(Math.round(floor * scale));
        }
        if (layout.button) {
          expect(layout.button.y + layout.button.h).toBeLessThanOrEqual(safe.y + safe.h + 1);
          expect(layout.button.line.size).toBeGreaterThanOrEqual(Math.round(FLOORS.label * scale));
        }
        if (name === 'story') {
          expect(layout.rect.y).toBeGreaterThanOrEqual(250);
          expect(layout.rect.y + layout.rect.h).toBeLessThanOrEqual(1920 - 400);
        }
      });
    }
  }

  it('scales by the SHORT side: landscape has the same floors and sizes as square', () => {
    expect(scaleOf(FORMATS.square)).toBe(1);
    expect(scaleOf(FORMATS.portrait)).toBe(1);
    expect(scaleOf(FORMATS.story)).toBe(1);
    expect(scaleOf(FORMATS.landscape)).toBe(1);
    expect(scaleOf(FORMATS.link)).toBeCloseTo(627 / 1080, 5);

    const template = getTemplate('photo-headline')!;
    const texts = { eyebrow: 'Nueva temporada', headline: 'Caf\u00e9 de especialidad', body: 'Ven a probar el men\u00fa de oto\u00f1o con ingredientes locales.', footer: 'cafeejemplo.com' };
    const place = (name: 'square' | 'landscape') => {
      const w = warnings();
      const layout = layoutText({ template, format: FORMATS[name], texts, brand: resolveBrand(undefined, fonts(), w), fonts: fonts(), region: textSafeRect(FORMATS[name]), align: 'left', position: 'bottom', warnings: w });
      return { layout, w };
    };
    const landscape = place('landscape');
    const sizeOf = (l: ReturnType<typeof place>, field: string): number => l.layout.lines.find((x) => x.field === field)!.size;
    // the same typography as square: headline never below 90, body below 44, label 24..30
    expect(sizeOf(landscape, 'headline')).toBeGreaterThanOrEqual(90);
    expect(sizeOf(landscape, 'headline')).toBeLessThanOrEqual(135);
    expect(sizeOf(landscape, 'body')).toBeGreaterThanOrEqual(32);
    expect(sizeOf(landscape, 'body')).toBeLessThanOrEqual(44);
    expect(sizeOf(landscape, 'eyebrow')).toBeGreaterThanOrEqual(24);
    expect(sizeOf(landscape, 'eyebrow')).toBeLessThanOrEqual(30);
    // and nothing is cut for the sample text
    expect(landscape.w).toEqual([]);
    expect(landscape.layout.lines.filter((l) => l.field === 'body').every((l) => !l.text.endsWith('\u2026'))).toBe(true);
    expect(landscape.layout.lines.filter((l) => l.field === 'body').map((l) => l.text).join(' ')).toBe(texts.body);
    expect(landscape.layout.lines.some((l) => l.field === 'footer')).toBe(true);
  });

  it('flags a too-long headline instead of truncating it, with a character hint', () => {
    const template = getTemplate('photo-headline')!;
    const format = FORMATS.square;
    const w = warnings();
    const headline = 'Este es un titular excesivamente largo que nunca podra caber en cuatro lineas legibles dentro de la imagen cuadrada';
    const layout = layoutText({
      template,
      format,
      texts: { headline },
      brand: resolveBrand(undefined, fonts(), w),
      fonts: fonts(),
      region: textSafeRect(format),
      align: 'left',
      position: 'bottom',
      warnings: w,
    });
    const warning = w.find((x) => x.code === 'headline_too_long');
    expect(warning).toBeDefined();
    expect(warning?.suggestion).toMatch(/shorter headline \(about \d+ characters/);
    expect(layout.lines.map((l) => l.text).join(' ')).toBe(headline); // nothing was cut
    expect(Math.min(...layout.lines.map((l) => l.size))).toBe(90);
  });

  it('drops or shortens the body to keep the headline large', () => {
    const template = getTemplate('photo-headline')!;
    const format = FORMATS.link;
    const w = warnings();
    layoutText({
      template,
      format,
      texts: { headline: 'Café de especialidad', body: 'Un párrafo largo '.repeat(60) },
      brand: resolveBrand(undefined, fonts(), w),
      fonts: fonts(),
      region: textSafeRect(format),
      align: 'left',
      position: 'bottom',
      warnings: w,
    });
    expect(w.some((x) => x.code === 'body_shortened' || x.code === 'body_dropped')).toBe(true);
    expect(w.some((x) => x.code === 'headline_too_long')).toBe(false);
  });

  it('ignores text fields the template does not draw, with a warning', () => {
    const template = getTemplate('photo-headline')!;
    const w = warnings();
    const layout = layoutText({
      template,
      format: FORMATS.square,
      texts: { headline: 'Hola', cta: 'Click aqui' },
      brand: resolveBrand(undefined, fonts(), w),
      fonts: fonts(),
      region: textSafeRect(FORMATS.square),
      align: 'left',
      position: 'bottom',
      warnings: w,
    });
    expect(layout.button).toBeUndefined();
    expect(w.some((x) => x.code === 'cta_ignored')).toBe(true);
  });
});
