/**
 * readme-assets.ts: renders the showcase images used by the repository README into `<repo>/.github/readme/`.
 *
 * What it does
 *   Draws every picture with the server's OWN render functions (`composePost`, `renderCustom`, `renderBrandSheet`),
 *   called directly: no HTTP server, no MCP client, no network and no API keys. Backgrounds are synthetic photo-like
 *   pictures and logos are drawn from the bundled fonts (see `readme-assets/fixtures.ts`). The three brands are
 *   fictional (Café Lumbre, Studio Norte, Verde Market); never use a real company here.
 *
 * Output (JPEG q82, mozjpeg; each file <= 250 KB and the set <= 2 MB, checked at the end)
 *   hero.jpg            1280x640   project banner, a compose_custom layout with three mock post cards
 *   templates-grid.jpg  the 8 built-in templates, square, 4x2 grid with labels
 *   formats.jpg         one design in square, portrait, story, landscape and link
 *   carousel.jpg        a 4-slide carousel strip (compose_carousel look: cover, 2 points, closing slide, counter chip)
 *   custom-layouts.jpg  two compose_custom designs: magazine cover and 3-column price list
 *   brand-sheet.jpg     the brand sheet that save_brand returns
 *
 * How to run (from servers/marketing-images; Node 22, see .nvmrc)
 *   source ~/.nvm/nvm.sh && nvm use 22
 *   npm run readme:assets
 *
 * The output is deterministic: the same code and dependency versions give the same bytes. `.github/readme/` is the
 * place on purpose (`docs/` is git-ignored in this repository). Commit the regenerated images with the README.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { renderBrandSheet } from '../src/brand-sheet.js';
import { defaultFontsDir } from '../src/config.js';
import type { ResolvedBrand } from '../src/render/brand.js';
import { composePost, type ComposeDeps } from '../src/render/compose.js';
import { renderCustom } from '../src/render/custom/render.js';
import { FontRegistry } from '../src/render/fonts.js';
import { FORMATS, type FormatName, type FormatSpec } from '../src/render/formats.js';
import type { TextsInput } from '../src/render/layout.js';
import type { RenderWarning } from '../src/render/warnings.js';
import { LUMBRE, NORTE, VERDE, buildBrand, scene, type SceneKind } from './readme-assets/fixtures.js';
import { MAGAZINE_COVER, TILE_RADIUS, chevron, hero, priceList, shell, type Slot } from './readme-assets/layouts.js';

const OUT_DIR = fileURLToPath(new URL('../../../.github/readme/', import.meta.url));
const MAX_FILE_BYTES = 250 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------------------------------

const fonts = new FontRegistry(defaultFontsDir());
/** In-memory "web": the render functions ask `fetchImage` for background links; we answer from here. */
const store = new Map<string, Buffer>();
const deps: ComposeDeps = {
  fonts,
  fetchImage: async (url) => {
    const hit = store.get(url);
    if (!hit) throw new Error(`readme-assets: no synthetic image registered for ${url}`);
    return hit;
  },
};

/** Registers a synthetic photo under a fake https link and returns the link. */
async function photo(kind: SceneKind, variant: number, width = 2000, height = 2000): Promise<string> {
  const url = `https://readme-assets.invalid/${kind}-${variant}-${width}x${height}.jpg`;
  if (!store.has(url)) store.set(url, await scene(kind, variant, width, height));
  return url;
}

const problems: string[] = [];
function check(label: string, warnings: RenderWarning[]): void {
  for (const w of warnings) problems.push(`${label}: ${w.code}: ${w.message}`);
}

async function post(label: string, brand: ResolvedBrand, template: string, format: FormatName, texts: TextsInput, background?: string, counter?: { index: number; total: number }): Promise<Buffer> {
  const out = await composePost(
    {
      template,
      format,
      texts,
      brand,
      options: { output: 'png' },
      ...(background ? { background: { image_url: background } } : {}),
      ...(counter ? { counter } : {}),
    },
    deps,
  );
  check(label, out.warnings);
  return out.data;
}

/** A custom canvas: the engine only needs the size (the name matters for story safe zones only). */
function canvas(width: number, height: number): FormatSpec {
  return { name: 'landscape', width, height, orientation: width >= height ? 'landscape' : 'portrait', description: 'README figure' };
}

async function custom(label: string, html: string, brand: ResolvedBrand, format: FormatSpec, extra: { assets?: Record<string, Buffer>; variables?: Record<string, string>; checks?: boolean } = {}): Promise<Buffer> {
  const out = await renderCustom({ html, format, brand, output: 'png', ...extra }, deps);
  check(label, out.warnings);
  return out.data;
}

async function rounded(data: Buffer, w: number, h: number): Promise<Buffer> {
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${TILE_RADIUS}" ry="${TILE_RADIUS}" fill="#fff"/></svg>`);
  return sharp(data).resize(w, h, { fit: 'fill' }).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/** Puts rendered posts (scaled and rounded) on a shell at their slots. */
async function assemble(base: Buffer, tiles: { slot: Slot; data: Buffer }[]): Promise<Buffer> {
  const layers = await Promise.all(tiles.map(async ({ slot, data }) => ({ input: await rounded(data, slot.w, slot.h), left: slot.x, top: slot.y })));
  return sharp(base).composite(layers).png().toBuffer();
}

const written: { name: string; bytes: number; width: number; height: number }[] = [];
async function save(name: string, image: Buffer, width?: number): Promise<void> {
  const pipeline = sharp(image).removeAlpha();
  const { data, info } = await (width ? pipeline.resize({ width }) : pipeline).jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  writeFileSync(path.join(OUT_DIR, name), data);
  written.push({ name, bytes: data.length, width: info.width, height: info.height });
}

// ---------------------------------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------------------------------

async function templatesGrid(brand: ResolvedBrand): Promise<void> {
  const items: { id: string; sub: string; texts: TextsInput; bg?: SceneKind }[] = [
    { id: 'photo-headline', sub: 'Photo and big headline', bg: 'lumbre', texts: { eyebrow: 'Nueva temporada', headline: 'Café de otoño, recién tostado', body: 'Granos de origen único, tostados cada semana.', footer: 'cafelumbre.example' } },
    { id: 'cta-card', sub: 'Offer and button', texts: { eyebrow: 'Oferta limitada', headline: 'Reserva tu mesa esta semana', body: 'Un postre de cortesía con cada reserva.', cta: 'Reservar ahora', footer: 'cafelumbre.example' } },
    { id: 'quote-card', sub: 'Quote on the brand color', texts: { eyebrow: 'Nuestra idea', headline: 'El mejor café es el que se comparte con alguien.', footer: 'Café Lumbre' } },
    { id: 'split', sub: 'Photo and text panel', bg: 'lumbre', texts: { eyebrow: 'Menú nuevo', headline: 'Otoño en tu taza', body: 'Calabaza, canela y castañas.', cta: 'Ver el menú', footer: 'cafelumbre.example' } },
    { id: 'minimal-badge', sub: 'Photo with a price badge', bg: 'lumbre', texts: { eyebrow: 'Nuevo', headline: 'Desde $4', body: 'Latte de calabaza y canela.', footer: 'cafelumbre.example' } },
    { id: 'carousel-cover', sub: 'Carousel: first slide', bg: 'lumbre', texts: { eyebrow: '5 consejos', headline: 'Mejor café en casa', body: 'Hábitos simples que cambian la taza.', cta: 'Desliza', footer: '@cafelumbre' } },
    { id: 'carousel-point', sub: 'Carousel: numbered tip', texts: { number: '1', eyebrow: 'Consejo', headline: 'Muele justo antes', body: 'El café molido pierde aroma en minutos. Muele solo lo que vas a usar.', footer: '@cafelumbre' } },
    { id: 'carousel-end', sub: 'Carousel: closing call to action', texts: { eyebrow: 'Eso es todo', headline: 'Guárdalo para después', body: 'Y compártelo con quien ama el café.', cta: 'Síguenos', footer: '@cafelumbre' } },
  ];
  const W = 1600;
  const M = 40;
  const GAP = 24;
  const T = Math.floor((W - 2 * M - 3 * GAP) / 4);
  const pitch = T + 94;
  const H = M + 2 * pitch - 14;
  const slots: Slot[] = items.map((it, i) => ({ x: M + (i % 4) * (T + GAP), y: M + Math.floor(i / 4) * pitch, w: T, h: T, title: it.id, sub: it.sub }));
  const tiles: { slot: Slot; data: Buffer }[] = [];
  let variant = 0;
  for (const [i, it] of items.entries()) {
    variant += 1;
    const bg = it.bg ? await photo(it.bg, variant) : undefined;
    tiles.push({ slot: slots[i] as Slot, data: await post(`grid/${it.id}`, brand, it.id, 'square', it.texts, bg) });
  }
  const base = await custom('grid/shell', shell(W, H, slots), brand, canvas(W, H), { checks: false });
  await save('templates-grid.jpg', await assemble(base, tiles));
}

async function formatsFigure(brand: ResolvedBrand): Promise<void> {
  const texts: TextsInput = { eyebrow: 'Open studio', headline: 'Come and see how we work', body: 'Saturday, coffee on us.', footer: 'studionorte.example' };
  const bg = await photo('norte', 5);
  const render = (format: FormatName): Promise<Buffer> => post(`formats/${format}`, brand, 'photo-headline', format, texts, bg);

  const M = 48;
  const GAP = 38;
  const TOP = 44;
  const ROW = 520;
  const fit = (f: FormatName, height: number): { w: number; h: number } => ({ w: Math.round((FORMATS[f].width * height) / FORMATS[f].height), h: height });
  const story = fit('story', ROW);
  const portrait = fit('portrait', ROW);
  const square = fit('square', ROW);
  const COL = 410;
  const landscape = { w: COL, h: Math.round((COL * FORMATS.landscape.height) / FORMATS.landscape.width) };
  const link = { w: COL, h: Math.round((COL * FORMATS.link.height) / FORMATS.link.width) };

  let x = M;
  const place = (f: FormatName, size: { w: number; h: number }, y: number, title: string): Slot => {
    const slot: Slot = { x, y, w: size.w, h: size.h, title, sub: `${FORMATS[f].width}x${FORMATS[f].height}` };
    return slot;
  };
  const sStory = place('story', story, TOP, 'story');
  x += story.w + GAP;
  const sPortrait = place('portrait', portrait, TOP, 'portrait');
  x += portrait.w + GAP;
  const sSquare = place('square', square, TOP, 'square');
  x += square.w + GAP;
  const sLandscape = place('landscape', landscape, TOP, 'landscape');
  const sLink = place('link', link, TOP + landscape.h + 80, 'link');
  const W = x + COL + M;
  const H = TOP + ROW + 94;
  const slots = [sStory, sPortrait, sSquare, sLandscape, sLink];
  const base = await custom('formats/shell', shell(W, H, slots), brand, canvas(W, H), { checks: false });
  const tiles = [
    { slot: sStory, data: await render('story') },
    { slot: sPortrait, data: await render('portrait') },
    { slot: sSquare, data: await render('square') },
    { slot: sLandscape, data: await render('landscape') },
    { slot: sLink, data: await render('link') },
  ];
  await save('formats.jpg', await assemble(base, tiles));
}

async function carouselStrip(brand: ResolvedBrand): Promise<void> {
  const total = 4;
  const slides: { id: string; sub: string; texts: TextsInput; bg?: SceneKind }[] = [
    { id: 'carousel-cover', sub: 'Slide 1: cover', bg: 'verde', texts: { eyebrow: 'Guía rápida', headline: 'Cómo elegir fruta de temporada', body: 'Tres gestos que evitan sorpresas en la caja.', cta: 'Desliza', footer: '@verdemarket' } },
    { id: 'carousel-point', sub: 'Slide 2: a numbered point', texts: { number: '1', eyebrow: 'Consejo', headline: 'Mira el color', body: 'Un tono parejo y brillante suele indicar que está en su punto.', footer: '@verdemarket' } },
    { id: 'carousel-point', sub: 'Slide 3: another point', texts: { number: '2', eyebrow: 'Consejo', headline: 'Huele cerca del tallo', body: 'El aroma dulce es la mejor señal de que madura bien.', footer: '@verdemarket' } },
    { id: 'carousel-end', sub: 'Slide 4: closing call to action', texts: { eyebrow: 'Eso es todo', headline: 'Guárdalo para tu próxima compra', body: 'Y cuéntanos cuál es tu fruta favorita del mes.', cta: 'Síguenos', footer: '@verdemarket' } },
  ];
  const tileW = 380;
  const tileH = Math.round((tileW * FORMATS.portrait.height) / FORMATS.portrait.width);
  const M = 48;
  const GAP = 46;
  const TOP = 44;
  const W = 2 * M + total * tileW + (total - 1) * GAP;
  const H = TOP + tileH + 92;
  const slots: Slot[] = slides.map((s, i) => ({ x: M + i * (tileW + GAP), y: TOP, w: tileW, h: tileH, title: s.sub.split(': ')[0] as string, sub: s.sub.split(': ')[1] as string }));
  const arrows = [0, 1, 2].map((i) => chevron(M + (i + 1) * tileW + i * GAP + GAP / 2, TOP + tileH / 2)).join('');
  const base = await custom('carousel/shell', shell(W, H, slots, arrows), brand, canvas(W, H), { checks: false });
  const tiles: { slot: Slot; data: Buffer }[] = [];
  for (const [i, s] of slides.entries()) {
    const bg = s.bg ? await photo(s.bg, 11 + i) : undefined;
    tiles.push({ slot: slots[i] as Slot, data: await post(`carousel/${i + 1}`, brand, s.id, 'portrait', s.texts, bg, { index: i + 1, total }) });
  }
  await save('carousel.jpg', await assemble(base, tiles));
}

async function customLayouts(magazineBrand: ResolvedBrand, menuBrand: ResolvedBrand): Promise<void> {
  const cover = await custom('custom/magazine', MAGAZINE_COVER, magazineBrand, FORMATS.portrait, {
    // Flipped so the light source sits in the clear band of the cover's gradient instead of under the dark top.
    assets: { cover: await sharp(await scene('norte', 8, 1600, 2000)).flip().jpeg({ quality: 92 }).toBuffer() },
    variables: { issue: 'Nº 14', season: 'Otoño 2026', title: 'La luz del norte', deck: 'Estudios, oficios y objetos que cambian con las estaciones.', byline: 'Studio Norte · Revista' },
  });
  const menu = await custom(
    'custom/prices',
    priceList([
      { title: 'Café', rows: [{ name: 'Espresso', note: 'Origen único', price: '$3' }, { name: 'Cortado', note: 'Con leche vaporizada', price: '$3.5' }, { name: 'Capuchino', note: 'Canela y cacao', price: '$4.5' }] },
      { title: 'Panadería', rows: [{ name: 'Croissant', note: 'Mantequilla, de hoy', price: '$3' }, { name: 'Pan de yuca', note: 'Recién horneado', price: '$2.5' }, { name: 'Torta de nuez', note: 'Porción', price: '$4' }] },
      { title: 'Bebidas frías', rows: [{ name: 'Cold brew', note: 'Infusión de 18 horas', price: '$4' }, { name: 'Limonada', note: 'Con hierbabuena', price: '$3.5' }, { name: 'Té helado', note: 'Hibisco y naranja', price: '$3' }] },
    ]),
    menuBrand,
    FORMATS.landscape,
    { variables: { eyebrow: 'Menú de otoño', title: 'Precios de un vistazo', footer: 'Abierto todos los días de 8:00 a 18:00 · cafelumbre.example' } },
  );
  const H = 640;
  const M = 48;
  const GAP = 48;
  const TOP = 44;
  const coverW = Math.round((FORMATS.portrait.width * H) / FORMATS.portrait.height);
  const menuW = Math.round((FORMATS.landscape.width * H) / FORMATS.landscape.height);
  const slots: Slot[] = [
    { x: M, y: TOP, w: coverW, h: H, title: 'Magazine cover', sub: 'compose_custom, portrait 1080x1350' },
    { x: M + coverW + GAP, y: TOP, w: menuW, h: H, title: 'Three-column price list', sub: 'compose_custom, landscape 1920x1080' },
  ];
  const W = 2 * M + coverW + GAP + menuW;
  const base = await custom('custom/shell', shell(W, TOP + H + 92, slots), menuBrand, canvas(W, TOP + H + 92), { checks: false });
  await save('custom-layouts.jpg', await assemble(base, [{ slot: slots[0] as Slot, data: cover }, { slot: slots[1] as Slot, data: menu }]));
}

async function brandSheet(brand: ResolvedBrand): Promise<void> {
  const sheet = await renderBrandSheet(brand, { name: brand.displayName ?? 'Brand', slug: brand.slug ?? 'brand', version: 1 }, deps);
  check('brand-sheet', sheet.warnings as RenderWarning[]);
  await save('brand-sheet.jpg', sheet.data, 1600);
}

async function heroBanner(lumbre: ResolvedBrand, norte: ResolvedBrand, verde: ResolvedBrand): Promise<void> {
  const cardW = 250;
  const px2 = cardW * 2;
  const small = async (data: Buffer): Promise<Buffer> => sharp(data).resize(px2, px2).png().toBuffer();
  const a = await small(
    await post('hero/lumbre', lumbre, 'photo-headline', 'square', { eyebrow: 'Nueva temporada', headline: 'Café de otoño, recién tostado', body: 'Granos de origen único, tostados cada semana.', footer: 'cafelumbre.example' }, await photo('lumbre', 21)),
  );
  const b = await small(
    await post('hero/norte', norte, 'cta-card', 'square', { eyebrow: 'Open studio', headline: 'Come and see how we work', body: 'Saturday, coffee on us.', cta: 'Reserve a spot', footer: 'studionorte.example' }),
  );
  const c = await small(
    await post('hero/verde', verde, 'minimal-badge', 'square', { eyebrow: 'Fresh', headline: 'From $2', body: 'Fruit from nearby farms.', footer: 'verdemarket.example' }, await photo('verde', 23)),
  );
  const waiting = { text: 'Waiting for your yes', bg: '#fff0cf', fg: '#7a4b00' };
  const html = hero([
    // Behind the other two and cropped by the canvas edge: its header hides behind Studio Norte, so only the picture peeks out.
    { asset: 'c', name: '', meta: '', initial: 'V', avatar: '#1f6b3a', chip: { text: 'Draft', bg: '#e6e9ef', fg: '#3d4658' }, x: 1134, y: 250, w: cardW, rot: 8 },
    { asset: 'a', name: 'Café Lumbre', meta: 'Instagram · Tue 9:30', initial: 'C', avatar: '#8a3a1c', chip: waiting, x: 652, y: 92, w: cardW, rot: -5 },
    { asset: 'b', name: 'Studio Norte', meta: 'LinkedIn · Thu 8:30', initial: 'S', avatar: '#12355b', chip: waiting, x: 924, y: 58, w: cardW, rot: 4 },
  ]);
  const format = canvas(1280, 640);
  const banner = await renderCustom({ html, format, brand: norte, output: 'png', assets: { a, b, c }, checks: false }, deps);
  check('hero', banner.warnings);
  await save('hero.jpg', banner.data);
}

// ---------------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const [lumbre, norte, verde] = await Promise.all([buildBrand(LUMBRE, fonts), buildBrand(NORTE, fonts), buildBrand(VERDE, fonts)]);

  await heroBanner(lumbre, norte, verde);
  await templatesGrid(lumbre);
  await formatsFigure(norte);
  await carouselStrip(verde);
  await customLayouts(norte, lumbre);
  await brandSheet(lumbre);

  let total = 0;
  for (const f of written) {
    total += f.bytes;
    const flag = f.bytes > MAX_FILE_BYTES ? '  <-- over 250 KB' : '';
    console.log(`${f.name.padEnd(20)} ${String(f.width).padStart(5)}x${String(f.height).padEnd(5)} ${(f.bytes / 1024).toFixed(0).padStart(5)} KB${flag}`);
  }
  console.log(`${'total'.padEnd(20)} ${' '.repeat(11)} ${(total / 1024).toFixed(0).padStart(5)} KB`);
  if (problems.length > 0) {
    console.log('\nRender warnings (look at them; some are expected for decorative layouts):');
    for (const p of problems) console.log(`  - ${p}`);
  }
  const over = written.filter((f) => f.bytes > MAX_FILE_BYTES);
  if (over.length > 0 || total > MAX_TOTAL_BYTES) {
    console.error(`\nSize budget exceeded (max ${MAX_FILE_BYTES / 1024} KB per file, ${MAX_TOTAL_BYTES / 1024 / 1024} MB in total). Simplify the picture or lower its width.`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
