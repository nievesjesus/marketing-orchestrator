import { describe, expect, it } from 'vitest';
import { composePost } from '../src/render/compose.js';
import { FORMATS, FORMAT_NAMES, type FormatName } from '../src/render/formats.js';
import type { Layout } from '../src/render/layout.js';
import { scrimGradient } from '../src/render/overlay.js';
import { fonts, makePhoto, pixelAt, pixels, solidImage, type Pixels } from './helpers.js';

const luma = (p: Pixels, x: number, y: number): number => {
  const [r, g, b] = pixelAt(p, x, y);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

/** Mean luma of a 50-px-wide strip in the right margin (outside the title-safe area: no text, no logo), per row. */
function marginColumn(p: Pixels): number[] {
  const rows: number[] = [];
  for (let y = 0; y < p.height; y += 1) {
    let sum = 0;
    let n = 0;
    for (let x = p.width - 60; x < p.width - 10; x += 1) {
      sum += luma(p, x, y);
      n += 1;
    }
    rows.push(sum / n);
  }
  return rows;
}

const maxStep = (rows: number[]): { step: number; at: number } => {
  let step = 0;
  let at = 0;
  for (let y = 1; y < rows.length; y += 1) {
    const d = Math.abs((rows[y] as number) - (rows[y - 1] as number));
    if (d > step) {
      step = d;
      at = y;
    }
  }
  return { step, at };
};

async function render(format: FormatName, image: Buffer, scrim: 'auto' | 'none' | 'strong' = 'auto'): Promise<Pixels> {
  const out = await composePost(
    {
      template: 'photo-headline',
      format,
      texts: { eyebrow: 'Nueva temporada', headline: 'Café de especialidad', body: 'Ven a probar el menú de otoño.', footer: 'cafeejemplo.com' },
      background: { image_url: 'https://assets.example.test/bg' },
      options: { output: 'png', scrim },
    },
    { fonts: fonts(), fetchImage: async () => image },
  );
  return pixels(out.data);
}

describe('photo-headline scrim is a smooth vertical gradient (no bands, no hard edges)', () => {
  it.each(FORMAT_NAMES)('%s: on a flat bright photo the scrim alone changes smoothly and only ever darkens downward', async (format) => {
    const p = await render(format, await solidImage(2000, 2000, '#f2f2f2'));
    const rows = marginColumn(p);
    const { step, at } = maxStep(rows);
    expect(step, `largest row-to-row jump ${step.toFixed(2)} at y=${at}`).toBeLessThanOrEqual(2.5); // 8-bit steps of 1-2 levels are invisible
    // clear at the top, dark at the bottom edge
    expect(rows[2] as number).toBeGreaterThan(236);
    expect(rows[rows.length - 1] as number).toBeLessThan(110);
    // monotone: luminance never rises going down (the picture is flat, so any rise would be a band)
    for (let y = 1; y < rows.length; y += 1) expect(rows[y] as number, `rise at y=${y}`).toBeLessThanOrEqual((rows[y - 1] as number) + 0.01);
    // the ramp is long: the fade spans at least 25 % of the canvas height (the picture is flat, so this is the scrim alone)
    const top = rows[2] as number;
    const bottom = rows[rows.length - 1] as number;
    const start = rows.findIndex((v) => v < top - 2);
    const end = rows.length - 1 - [...rows].reverse().findIndex((v) => v > bottom + 2);
    expect((end - start) / rows.length, `fade from y=${start} to y=${end}`).toBeGreaterThan(0.25);
  });

  it.each(FORMAT_NAMES)('%s: on a photo-like background (blurred shapes + grain) there is no jump between adjacent rows', async (format) => {
    const p = await render(format, await makePhoto(2000, 1500));
    const { step, at } = maxStep(marginColumn(p));
    expect(step, `largest row-to-row jump ${step.toFixed(2)} at y=${at}`).toBeLessThan(3);
  });

  it('strong scrim is also smooth', async () => {
    const rows = marginColumn(await render('portrait', await solidImage(2000, 2000, '#f2f2f2'), 'strong'));
    expect(maxStep(rows).step).toBeLessThanOrEqual(2.5);
    expect(rows[rows.length - 1] as number).toBeLessThan(60);
  });
});

describe('scrimGradient stops', () => {
  const format = FORMATS.portrait;
  const layout = (anchor: Layout['anchor'], y: number, h: number): Layout => ({ lines: [], rect: { x: 0, y, w: 800, h }, anchor, align: 'left' });
  const parse = (css: string): { alpha: number; pct: number }[] =>
    [...css.matchAll(/rgba\(\d+, \d+, \d+, ([\d.]+)\) ([\d.]+)%/g)].map((m) => ({ alpha: Number(m[1]), pct: Number(m[2]) }));
  const look = { color: '#0b1020', alpha: 0.6, strong: false };

  it('bottom anchor: eased ramp starting about 30 % of the height above the text, max alpha at the bottom edge', () => {
    const stops = parse(scrimGradient(look, layout('bottom', 800, 400), format));
    expect(stops.length).toBeGreaterThanOrEqual(8);
    expect(stops[0]).toEqual({ alpha: 0, pct: expect.any(Number) });
    const alphas = stops.map((s) => s.alpha);
    for (let i = 1; i < alphas.length; i += 1) expect(alphas[i] as number).toBeGreaterThanOrEqual(alphas[i - 1] as number);
    const pcts = stops.map((s) => s.pct);
    for (let i = 1; i < pcts.length; i += 1) expect(pcts[i] as number).toBeGreaterThanOrEqual(pcts[i - 1] as number);
    // text block top at y=800 (59.3 %): ramp starts ~30 % of the canvas earlier (pad 3 % + reach 30 %)
    expect(stops[0]!.pct).toBeCloseTo(((800 - 0.03 * 1350 - 0.3 * 1350) / 1350) * 100, 0);
    expect(stops.at(-1)).toEqual({ alpha: 0.68, pct: 100 });
    // eased: gentle start (first interior stop well below linear) and reaches full strength above the text
    const mid = stops.find((s) => s.alpha > 0 && s.alpha < 0.6)!;
    expect(mid.alpha).toBeLessThan(0.3);
    expect(stops.some((s) => s.alpha === 0.6 && s.pct < 59.3)).toBe(true);
  });

  it('top and center anchors mirror the same easing; strong reaches further', () => {
    const top = parse(scrimGradient(look, layout('top', 150, 300), format));
    expect(top[0]).toEqual({ alpha: 0.68, pct: 0 });
    expect(top.at(-1)!.alpha).toBe(0);
    const center = parse(scrimGradient(look, layout('center', 500, 300), format));
    expect(center[0]!.alpha).toBe(0);
    expect(center.at(-1)!.alpha).toBe(0);
    expect(Math.max(...center.map((s) => s.alpha))).toBe(0.6);
    const normal = parse(scrimGradient(look, layout('bottom', 900, 300), format));
    const strong = parse(scrimGradient({ ...look, alpha: 0.85, strong: true }, layout('bottom', 900, 300), format));
    expect(strong[0]!.pct).toBeLessThan(normal[0]!.pct);
    expect(strong.at(-1)!.alpha).toBe(0.93);
  });
});
