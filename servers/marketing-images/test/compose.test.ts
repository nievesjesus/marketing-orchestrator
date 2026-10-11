import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { composePost, type ComposeInput } from '../src/render/compose.js';
import { FORMATS, FORMAT_NAMES } from '../src/render/formats.js';
import { TEMPLATES } from '../src/render/templates/index.js';
import { checkerboard, diffBox, fonts, makeLogo, makePhoto, meanLuma, pixelAt, pixels, solidImage, splitImage } from './helpers.js';

const SAMPLES_DIR = new URL('../.samples/', import.meta.url);
mkdirSync(SAMPLES_DIR, { recursive: true });

const LOGO_URL = 'https://assets.example.test/logo.png';
const LOGO_LIGHT = 'https://assets.example.test/logo-light.png';
const LOGO_DARK = 'https://assets.example.test/logo-dark.png';
const PHOTO_URL = 'https://assets.example.test/photo.jpg';

/** Serves generated images instead of the network. */
async function makeDeps(extra: Record<string, Buffer> = {}) {
  const store: Record<string, Buffer> = {
    [PHOTO_URL]: await makePhoto(),
    [LOGO_URL]: await makeLogo(),
    [LOGO_LIGHT]: await makeLogo('#f5f5f5', '#222222'),
    [LOGO_DARK]: await makeLogo('#101820', '#ffd23f'),
    ...extra,
  };
  const calls: string[] = [];
  return {
    calls,
    deps: {
      fonts: fonts(),
      fetchImage: async (url: string): Promise<Buffer> => {
        calls.push(url);
        const hit = store[url];
        if (!hit) throw new UserFacingError('fetch_failed', 'Could not download the file.');
        return hit;
      },
    },
  };
}

const TEXTS = {
  eyebrow: 'Nueva temporada',
  headline: 'Café de especialidad',
  body: 'Ven a probar el menú de otoño con ingredientes locales.',
  cta: 'Reservar ahora',
  footer: 'cafeejemplo.com',
};

const BRAND = { colors: { primary: '#14213d', accent: '#fca311' }, logo_url: LOGO_URL };

describe('compose_post: both templates in every format', () => {
  for (const template of TEMPLATES) {
    for (const name of FORMAT_NAMES) {
      it(`${template.id} / ${name}: valid image with exact dimensions`, async () => {
        const { deps } = await makeDeps();
        const input: ComposeInput = {
          template: template.id,
          format: name,
          texts: template.supports.includes('cta') ? TEXTS : { eyebrow: TEXTS.eyebrow, headline: TEXTS.headline, body: TEXTS.body, footer: TEXTS.footer },
          ...(template.id === 'photo-headline' ? { background: { image_url: PHOTO_URL } } : {}),
          brand: BRAND,
        };
        const out = await composePost(input, deps);
        const format = FORMATS[name];

        const meta = await sharp(out.data).metadata();
        expect(meta.width).toBe(format.width);
        expect(meta.height).toBe(format.height);
        expect(meta.format).toBe(out.ext === 'png' ? 'png' : 'jpeg');
        expect(out.width).toBe(format.width);
        expect(out.height).toBe(format.height);
        expect(out.warnings.filter((w) => w.code === 'headline_too_long')).toEqual([]);

        // Something was actually drawn: the picture is not a flat field.
        const stats = await sharp(out.data).stats();
        expect(stats.channels[0]?.stdev ?? 0).toBeGreaterThan(5);

        // Write a sample so the result can be inspected by eye.
        writeFileSync(new URL(`${template.id}-${name}.${out.ext}`, SAMPLES_DIR), out.data);
      });
    }
  }

  it('is deterministic: same input, same bytes', async () => {
    const { deps } = await makeDeps();
    const input: ComposeInput = { template: 'photo-headline', format: 'portrait', texts: TEXTS, background: { image_url: PHOTO_URL }, brand: BRAND };
    const a = await composePost(input, deps);
    const b = await composePost(input, deps);
    expect(a.data.equals(b.data)).toBe(true);
  });
});

describe('backgrounds', () => {
  it('cover-crops a photo to the format without stretching', async () => {
    const { deps } = await makeDeps({ 'https://assets.example.test/split.png': await splitImage(2000, 1000) });
    const out = await composePost(
      { template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: 'https://assets.example.test/split.png' }, options: { output: 'png' } },
      deps,
    );
    const p = await pixels(out.data);
    // Center square of a 2000x1000 image = x 500..1500: red then blue, split in the middle.
    const [r1, , b1] = pixelAt(p, 200, 150);
    const [r2, , b2] = pixelAt(p, 880, 150);
    expect(r1).toBeGreaterThan(200);
    expect(b1).toBeLessThan(60);
    expect(b2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(60);
  });

  it('supports a flat color and a CSS-style gradient', async () => {
    const { deps } = await makeDeps();
    const flat = await composePost({ template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { color: '#336699' }, options: { output: 'png' } }, deps);
    expect(flat.applied.background).toBe('color');
    expect(pixelAt(await pixels(flat.data), 20, 20)).toEqual([0x33, 0x66, 0x99]);

    const grad = await composePost(
      { template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { gradient: { from: '#ff0000', to: '#0000ff', angle: 90 } }, options: { output: 'png', text_position: 'bottom' } },
      deps,
    );
    const p = await pixels(grad.data);
    const [rl, , bl] = pixelAt(p, 2, 40);
    const [rr, , br] = pixelAt(p, 1077, 40);
    expect(rl).toBeGreaterThan(240);
    expect(bl).toBeLessThan(15);
    expect(br).toBeGreaterThan(240);
    expect(rr).toBeLessThan(15);
    expect(grad.applied.background).toBe('gradient');
  });

  it('cta-card defaults to the brand primary color; photo-headline falls back to a brand gradient with a warning', async () => {
    const { deps } = await makeDeps();
    const cta = await composePost({ template: 'cta-card', format: 'square', texts: { headline: 'Hola' }, brand: { colors: { primary: '#aa3300' } }, options: { output: 'png' } }, deps);
    expect(pixelAt(await pixels(cta.data), 10, 10)).toEqual([0xaa, 0x33, 0x00]);

    const photo = await composePost({ template: 'photo-headline', format: 'square', texts: { headline: 'Hola' } }, deps);
    expect(photo.applied.background).toBe('gradient');
    expect(photo.warnings.map((w) => w.code)).toContain('default_background');
  });

  it('rejects invalid colors with a plain message', async () => {
    const { deps } = await makeDeps();
    await expect(composePost({ template: 'cta-card', format: 'square', texts: { headline: 'Hola' }, background: { color: 'blue-ish' } }, deps)).rejects.toMatchObject({ code: 'invalid_color' });
    await expect(composePost({ template: 'cta-card', format: 'square', texts: { headline: 'Hola' }, background: { gradient: { from: '#fff', to: 'nope' } } }, deps)).rejects.toMatchObject({ code: 'invalid_color' });
  });

  it('warns about low-resolution photos and rejects damaged ones', async () => {
    const { deps } = await makeDeps({ 'https://assets.example.test/small.jpg': await makePhoto(300, 300), 'https://assets.example.test/bad.jpg': Buffer.from('not an image at all') });
    const small = await composePost({ template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: 'https://assets.example.test/small.jpg' } }, deps);
    expect(small.warnings.map((w) => w.code)).toContain('low_resolution_photo');
    await expect(composePost({ template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: 'https://assets.example.test/bad.jpg' } }, deps)).rejects.toMatchObject({ code: 'image_decode_failed' });
  });
});

describe('contrast and scrim', () => {
  const bright = 'https://assets.example.test/bright.png';

  it('darkens a bright photo under the text (auto) and not when scrim is none', async () => {
    const { deps } = await makeDeps({ [bright]: await solidImage(1600, 1600, '#f2f2f2') });
    const base = { template: 'photo-headline', format: 'square', texts: { headline: 'Titular' }, background: { image_url: bright } } as const;
    const auto = await composePost({ ...base, options: { output: 'png' } }, deps);
    const none = await composePost({ ...base, options: { output: 'png', scrim: 'none' } }, deps);
    const strong = await composePost({ ...base, options: { output: 'png', scrim: 'strong' } }, deps);
    expect(auto.applied.scrim).toBe('auto');
    expect(none.applied.scrim).toBe('none');
    expect(strong.applied.scrim).toBe('strong');

    const lumaAt = async (o: typeof auto): Promise<number> => meanLuma(await pixels(o.data), 0, 980, 80, 90); // bottom-left corner, text-free
    const [a, n, s] = [await lumaAt(auto), await lumaAt(none), await lumaAt(strong)];
    expect(n).toBeGreaterThan(230);
    expect(a).toBeLessThan(n - 80);
    expect(s).toBeLessThanOrEqual(a);

    // Without a scrim the text turns dark on the bright photo (readableOn); with it, the text is light.
    const lightPixelsInText = async (o: typeof auto): Promise<number> => {
      const p = await pixels(o.data);
      let n2 = 0;
      for (let y = 600; y < 1000; y += 2) for (let x = 108; x < 600; x += 2) if (pixelAt(p, x, y)[0] > 240) n2 += 1;
      return n2;
    };
    expect(await lightPixelsInText(auto)).toBeGreaterThan(300); // white glyphs on the darkened photo
  });

  it('a busy black/white photo gets a low-contrast warning without a scrim and none with one', async () => {
    const { deps } = await makeDeps({ 'https://assets.example.test/busy.png': await checkerboard(1200, 1200) });
    const base = { template: 'photo-headline', format: 'square', texts: { headline: 'Titular' }, background: { image_url: 'https://assets.example.test/busy.png' } } as const;
    const none = await composePost({ ...base, options: { scrim: 'none' } }, deps);
    expect(none.warnings.map((w) => w.code)).toContain('low_contrast');
    expect(none.warnings.find((w) => w.code === 'low_contrast')?.suggestion).toMatch(/strong/);
    const auto = await composePost(base, deps);
    expect(auto.warnings.map((w) => w.code)).not.toContain('low_contrast');
    expect(auto.applied.scrim).toBe('auto');
  });

  it('scrim policy: never on flat colors, only when needed on gradients, baseline on photos', async () => {
    const { deps } = await makeDeps();
    const base = { template: 'photo-headline', format: 'square', texts: { headline: 'Titular' }, options: { output: 'png' } } as const;
    const flat = await composePost({ ...base, background: { color: '#f2f2f2' } }, deps);
    expect(flat.applied.scrim).toBe('none');
    const flatStrong = await composePost({ ...base, background: { color: '#f2f2f2' }, options: { output: 'png', scrim: 'strong' } }, deps);
    expect(flatStrong.applied.scrim).toBe('none'); // nothing to protect on a flat color
    const calm = await composePost({ ...base, background: { gradient: { from: '#1f3a5f', to: '#14213d' } } }, deps);
    expect(calm.applied.scrim).toBe('none');
    expect(calm.warnings).toEqual([]);
    // white-to-black gradient: neither text color reads everywhere, so a scrim is added automatically
    const harsh = await composePost({ ...base, background: { gradient: { from: '#ffffff', to: '#000000', angle: 90 } }, options: { output: 'png', text_position: 'center', align: 'center' } }, deps);
    expect(harsh.applied.scrim).toBe('auto');
    expect(harsh.warnings.map((w) => w.code)).not.toContain('low_contrast');
    const harshNone = await composePost({ ...base, background: { gradient: { from: '#ffffff', to: '#000000', angle: 90 } }, options: { output: 'png', scrim: 'none', text_position: 'center', align: 'center' } }, deps);
    expect(harshNone.warnings.map((w) => w.code)).toContain('low_contrast');
  });

  it('cta-card text follows the template rule (paper on a dark primary, dark ink on a light primary)', async () => {
    const { deps } = await makeDeps();
    const dark = await composePost({ template: 'cta-card', format: 'square', texts: { headline: 'Hola' }, brand: { colors: { primary: '#14213d' } }, options: { output: 'png' } }, deps);
    const light = await composePost({ template: 'cta-card', format: 'square', texts: { headline: 'Hola' }, brand: { colors: { primary: '#f4efe6' } }, options: { output: 'png' } }, deps);
    const brightest = async (o: typeof dark): Promise<number> => {
      const p = await pixels(o.data);
      let max = 0;
      let min = 255;
      for (let y = 300; y < 800; y += 3) for (let x = 100; x < 980; x += 3) {
        const v = pixelAt(p, x, y)[0];
        max = Math.max(max, v);
        min = Math.min(min, v);
      }
      return max - min > 0 ? (pixelAt(p, 5, 5)[0] < 128 ? max : min) : 128;
    };
    expect(await brightest(dark)).toBeGreaterThan(240); // light glyphs on navy
    expect(await brightest(light)).toBeLessThan(40); // dark glyphs on cream
  });

  it('uses a paper button when the accent is too close to the primary color', async () => {
    const { deps } = await makeDeps();
    const out = await composePost({ template: 'cta-card', format: 'square', texts: { headline: 'Hola', cta: 'Reservar' }, brand: { colors: { primary: '#fca311', accent: '#fca412' } } }, deps);
    expect(out.warnings.map((w) => w.code)).toContain('accent_low_contrast');
  });
});

describe('logo', () => {
  async function render(background: string, brand: ComposeInput['brand'], extra: Partial<ComposeInput> = {}) {
    const { deps } = await makeDeps({ 'https://assets.example.test/bg.png': await solidImage(1200, 1200, background) });
    return composePost(
      { template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: 'https://assets.example.test/bg.png' }, brand, options: { output: 'png', scrim: 'none' }, ...extra },
      deps,
    );
  }

  it('chooses the dark variant on light backgrounds and the light variant on dark ones (port of overlay_logo)', async () => {
    const onLight = await render('#f0f0f0', { logo_url: LOGO_URL, logo_url_light: LOGO_LIGHT, logo_url_dark: LOGO_DARK });
    expect(onLight.applied.logo).toEqual({ variant: 'dark', plate: false });
    const onDark = await render('#101010', { logo_url: LOGO_URL, logo_url_light: LOGO_LIGHT, logo_url_dark: LOGO_DARK });
    expect(onDark.applied.logo).toEqual({ variant: 'light', plate: false });
    const onMid = await render('#808080', { logo_url: LOGO_URL, logo_url_light: LOGO_LIGHT, logo_url_dark: LOGO_DARK });
    expect(onMid.applied.logo?.variant).toBe('primary');
  });

  it('falls back to the primary logo when a variant is missing', async () => {
    const onDark = await render('#101010', { logo_url: LOGO_URL, logo_url_dark: LOGO_DARK });
    expect(onDark.applied.logo?.variant).toBe('primary');
  });

  it('adds a contrast plate when a single logo would disappear into the background, and not otherwise', async () => {
    // LOGO_URL is navy; navy background -> plate. Light background -> no plate.
    const hidden = await render('#14213d', { logo_url: LOGO_URL });
    expect(hidden.applied.logo).toEqual({ variant: 'primary', plate: true });
    const visible = await render('#f0f0f0', { logo_url: LOGO_URL });
    expect(visible.applied.logo).toEqual({ variant: 'primary', plate: false });
  });

  it.each(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)('places the logo in the %s corner (about 16 percent wide, 4 percent margin)', async (corner) => {
    // Anchor the text on the opposite side so only the logo differs between the two renders.
    const options = { output: 'png', scrim: 'none', text_position: corner.startsWith('top') ? 'bottom' : 'top' } as const;
    const withLogo = await render('#f0f0f0', { logo_url: LOGO_URL, logo_position: corner }, { options });
    const without = await render('#f0f0f0', {}, { options });
    const box = diffBox(await pixels(withLogo.data), await pixels(without.data), 4)!;
    expect(box).not.toBeNull();
    const margin = Math.round(1080 * 0.04);
    const width = box.x1 - box.x0 + 1;
    expect(width).toBeGreaterThanOrEqual(Math.round(1080 * 0.14));
    expect(width).toBeLessThanOrEqual(Math.round(1080 * 0.18) + 1);
    if (corner.endsWith('left')) expect(box.x0).toBeLessThanOrEqual(margin + 2);
    else expect(1080 - 1 - box.x1).toBeLessThanOrEqual(margin + 2);
    if (corner.startsWith('top')) expect(box.y0).toBeLessThanOrEqual(margin + 2);
    else expect(1080 - 1 - box.y1).toBeLessThanOrEqual(margin + 2);
  });

  it('keeps the story logo inside the safe zone (below 250 px / above 400 px from the bottom)', async () => {
    const { deps } = await makeDeps({ 'https://assets.example.test/bg.png': await solidImage(1200, 2000, '#f0f0f0') });
    const mk = (corner: 'top-left' | 'bottom-right', logo: boolean) =>
      composePost({ template: 'photo-headline', format: 'story', texts: { headline: 'Hola' }, background: { image_url: 'https://assets.example.test/bg.png' }, brand: logo ? { logo_url: LOGO_URL, logo_position: corner } : {}, options: { output: 'png', scrim: 'none' } }, deps);
    const base = await pixels((await mk('top-left', false)).data);
    const top = diffBox(await pixels((await mk('top-left', true)).data), base, 4)!;
    expect(top.y0).toBeGreaterThanOrEqual(250);
    const bottom = diffBox(await pixels((await mk('bottom-right', true)).data), base, 4)!;
    expect(bottom.y1).toBeLessThanOrEqual(1920 - 400);
  });

  it('a broken logo link is reported, not fatal', async () => {
    const { deps } = await makeDeps();
    const out = await composePost({ template: 'cta-card', format: 'square', texts: { headline: 'Hola' }, brand: { logo_url: 'https://assets.example.test/missing.png' } }, deps);
    expect(out.applied.logo).toBeNull();
    expect(out.warnings.map((w) => w.code)).toContain('logo_failed');
  });

  it('the text region avoids the logo band', async () => {
    const { deps } = await makeDeps({ 'https://assets.example.test/bg.png': await solidImage(1200, 1200, '#f0f0f0') });
    const base = { template: 'cta-card', format: 'square', texts: { headline: 'Hola' }, background: { image_url: 'https://assets.example.test/bg.png' }, options: { output: 'png', scrim: 'none', text_position: 'top' } } as const;
    const flat = await pixels(await solidImage(1080, 1080, '#f0f0f0'));
    const withLogo = await pixels((await composePost({ ...base, brand: { logo_url: LOGO_URL } }, deps)).data);
    // Rows that contain any non-background pixel.
    const rows: number[] = [];
    for (let y = 0; y < 1080; y += 1) {
      for (let x = 0; x < 1080; x += 2) {
        const [r] = pixelAt(withLogo, x, y);
        if (Math.abs(r - 0xf0) > 6) {
          rows.push(y);
          break;
        }
      }
    }
    // The logo block ends, then a clear gap, then the headline.
    const logoRows = rows.filter((y) => y < 200);
    const firstGap = logoRows.findIndex((y, i) => i > 0 && y - (logoRows[i - 1] as number) > 10);
    expect(firstGap).toBeGreaterThan(0);
    const logoEnd = logoRows[firstGap - 1] as number;
    const textStart = logoRows[firstGap] as number;
    expect(textStart - logoEnd).toBeGreaterThanOrEqual(15);
  });
});

describe('text rules', () => {
  const base = { template: 'photo-headline', format: 'square', background: { color: '#14213d' }, options: { output: 'png', scrim: 'none' } } as const;

  it('flags a too-long headline instead of cutting it, and still returns an image', async () => {
    const { deps } = await makeDeps();
    const out = await composePost({ ...base, texts: { headline: 'Este titular es muchisimo mas largo de lo que cualquier imagen cuadrada podria mostrar de forma legible y clara' } }, deps);
    const w = out.warnings.find((x) => x.code === 'headline_too_long');
    expect(w?.suggestion).toMatch(/shorter headline/);
    expect((await sharp(out.data).metadata()).width).toBe(1080);
  });

  it('keeps text inside the story safe zones (top 250 px and bottom 400 px stay empty)', async () => {
    const { deps } = await makeDeps();
    for (const template of ['photo-headline', 'cta-card'] as const) {
      for (const position of ['top', 'center', 'bottom'] as const) {
        const withText = await composePost({ template, format: 'story', background: { color: '#14213d' }, texts: TEXTS, options: { output: 'png', scrim: 'none', text_position: position } }, deps);
        const flat = await pixels(await solidImage(1080, 1920, '#14213d'));
        const box = diffBox(await pixels(withText.data), flat, 4)!;
        expect(box.y0, `${template}/${position} top`).toBeGreaterThanOrEqual(250);
        expect(box.y1, `${template}/${position} bottom`).toBeLessThanOrEqual(1920 - 400);
      }
    }
  });

  it('requires a headline', async () => {
    const { deps } = await makeDeps();
    await expect(composePost({ ...base, texts: { headline: '   ' } }, deps)).rejects.toMatchObject({ code: 'missing_headline' });
  });

  it('rejects unknown templates', async () => {
    const { deps } = await makeDeps();
    await expect(composePost({ ...base, template: 'nope', texts: { headline: 'Hola' } }, deps)).rejects.toMatchObject({ code: 'unknown_template' });
  });

  it('removes unsupported characters (emoji) and says so', async () => {
    const { deps } = await makeDeps();
    const out = await composePost({ ...base, texts: { headline: 'Hola \u{1F600} mundo' } }, deps);
    expect(out.warnings.map((w) => w.code)).toContain('unsupported_characters');
  });

  it('draws Spanish accents and ñ (all glyphs exist in the bundled fonts)', async () => {
    const { deps } = await makeDeps();
    const out = await composePost({ ...base, texts: { headline: '¿Qué tal una mañana de café? ¡Sí!', eyebrow: 'Niños y niñas', body: 'ÁÉÍÓÚÜÑ áéíóúüñ' } }, deps);
    expect(out.warnings.map((w) => w.code)).not.toContain('unsupported_characters');
  });

  it('uses brand fonts when bundled and warns about unknown ones', async () => {
    const { deps } = await makeDeps();
    const lora = await composePost({ ...base, texts: { headline: 'Hola mundo' }, brand: { fonts: { heading: 'Lora', body: 'work-sans' } } }, deps);
    expect(lora.warnings).toEqual([]);
    const plain = await composePost({ ...base, texts: { headline: 'Hola mundo' } }, deps);
    expect(lora.data.equals(plain.data)).toBe(false);
    const unknown = await composePost({ ...base, texts: { headline: 'Hola mundo' }, brand: { fonts: { heading: 'Comic Sans' } } }, deps);
    expect(unknown.warnings.map((w) => w.code)).toContain('font_unavailable');
  });

  it('warns about invalid brand colors and falls back', async () => {
    const { deps } = await makeDeps();
    const out = await composePost({ ...base, texts: { headline: 'Hola' }, brand: { colors: { accent: 'zzz-not-a-color' } } }, deps);
    expect(out.warnings.map((w) => w.code)).toContain('invalid_color');
  });
});

describe('output', () => {
  it('png/jpg/auto', async () => {
    const { deps } = await makeDeps();
    const mk = (output: 'png' | 'jpg' | 'auto', background: ComposeInput['background']) =>
      composePost({ template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background, options: { output } }, deps);
    const png = await mk('png', { image_url: PHOTO_URL });
    expect(png.data.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(png.contentType).toBe('image/png');
    const jpg = await mk('jpg', { color: '#123456' });
    expect(jpg.data.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(jpg.contentType).toBe('image/jpeg');
    expect((await mk('auto', { image_url: PHOTO_URL })).ext).toBe('jpg');
    expect((await mk('auto', { color: '#123456' })).ext).toBe('png');
  });
});
