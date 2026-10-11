import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrandStore } from '../src/brands-store.js';
import { defaultFontsDir } from '../src/config.js';
import { fetchSafe, sniffFormat, type FetchSafeDeps } from '../src/fetchsafe.js';
import { UserFacingError } from '../src/errors.js';
import { composePost } from '../src/render/compose.js';
import { resolveBrand, type BrandInput } from '../src/render/brand.js';
import { FORMATS, textSafeRect } from '../src/render/formats.js';
import { layoutText } from '../src/render/layout.js';
import { renderCustom } from '../src/render/custom/render.js';
import { BUILTIN_INFO } from '../src/render/templates/catalog.js';
import { TEMPLATES, getTemplate } from '../src/render/templates/index.js';
import { callTool, diffBox, fonts, makeLogo, makePhoto, OTHER_TOKEN, pixelAt, pixels, rawRequest, startTestServer, TEST_TOKEN } from './helpers.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;
type ToolResult = Awaited<ReturnType<typeof callTool>>;

const textOf = (r: ToolResult): string => r.content.find((c) => c.type === 'text')?.text ?? '';
const jsonOf = (r: ToolResult): any => JSON.parse(textOf(r));
const imagesOf = (r: ToolResult): { data: string; mimeType: string }[] => r.content.filter((c) => c.type === 'image');

const SAMPLES_DIR = new URL('../.samples/', import.meta.url);
mkdirSync(SAMPLES_DIR, { recursive: true });

const A = TEST_TOKEN; // alice
const B = OTHER_TOKEN; // bob
const PHOTO = 'https://assets.example.test/photo.jpg';

const fontBytes = (file: string): Buffer => readFileSync(path.join(defaultFontsDir(), file));
const svgLogo = (fill = '#0f766e'): Buffer =>
  Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="70" viewBox="0 0 200 70"><rect width="200" height="70" rx="14" fill="${fill}"/><circle cx="35" cy="35" r="16" fill="#fff"/><rect x="62" y="26" width="110" height="18" rx="9" fill="#fff"/></svg>`);

describe('saved brands over MCP', () => {
  let server: Server;
  const files = new Map<string, Buffer>();
  let offline = false;
  const fetchedFonts: string[] = [];
  const fetchedImages: string[] = [];

  beforeAll(async () => {
    files.set('https://cdn.example.test/logo.png', await makeLogo('#0f766e', '#ffffff'));
    files.set('https://cdn.example.test/logo-light.png', await makeLogo('#f5f5f5', '#222222'));
    files.set('https://cdn.example.test/logo.svg', svgLogo());
    files.set('https://cdn.example.test/evil.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///etc/passwd" width="10" height="10"/></svg>'));
    files.set('https://cdn.example.test/script.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    files.set('https://cdn.example.test/serif-bold.ttf', fontBytes('Lora-Bold.ttf'));
    files.set('https://cdn.example.test/serif-regular.ttf', fontBytes('Lora-Regular.ttf'));
    files.set('https://cdn.example.test/sans.ttf', fontBytes('WorkSans-Regular.ttf'));
    files.set('https://cdn.example.test/font.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(200, 1)]));
    files.set('https://cdn.example.test/notafont.ttf', await makeLogo());
    server = await startTestServer({
      configExtra: { DAILY_RENDER_LIMIT: '400' },
      overrides: {
        fetchImage: async (url: string, opts?: { svg?: boolean }) => {
          fetchedImages.push(url);
          if (offline) throw new UserFacingError('fetch_failed', 'offline');
          if (url === PHOTO) return makePhoto(1600, 1400);
          const hit = files.get(url);
          if (!hit) throw new UserFacingError('fetch_failed', 'Could not download the file.');
          // like fetchsafe: SVG only when the caller opts in
          if (hit.subarray(0, 40).toString().includes('<') && !opts?.svg) throw new UserFacingError('not_an_image', 'That link does not point to a supported image.');
          return hit;
        },
        fetchFont: async (url: string) => {
          fetchedFonts.push(url);
          if (offline) throw new UserFacingError('fetch_failed', 'offline');
          const hit = files.get(url);
          if (!hit) throw new UserFacingError('fetch_failed', 'Could not download the file.');
          return hit;
        },
      },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  const novaClinic = (extra: Record<string, unknown> = {}) => ({
    slug: 'nova-clinic',
    display_name: 'Nova Clinic',
    colors: { primary: '#0f766e', secondary: '#ecfdf5', accent: '#f59e0b', ink: '#0b1020', paper: '#ffffff', extra: [{ name: 'sand', hex: '#e8dcc4' }] },
    fonts: { heading: 'Brand Serif', body: 'Work Sans', accent: 'Outfit' },
    font_files: [
      { family: 'Brand Serif', weight: 700, style: 'normal', url: 'https://cdn.example.test/serif-bold.ttf' },
      { family: 'Brand Serif', weight: 400, style: 'normal', url: 'https://cdn.example.test/serif-regular.ttf' },
    ],
    logos: { primary: 'https://cdn.example.test/logo.png', light: 'https://cdn.example.test/logo-light.png' },
    style: { radius: 'large', button: 'rounded', eyebrow_case: 'title', logo_position: 'top-right', logo_size: 'large', scrim: 'soft', default_templates: { story: 'photo-headline', square: 'quote-card' }, photo_style: 'warm natural light, minimal, beige tones' },
    voice: { tone_words: ['calm', 'caring'], avoid_words: ['cheap'], hashtags: ['#novaclinic'], language: 'es' },
    ...extra,
  });

  describe('schema and validation', () => {
    it('rejects bad hex colors, slugs, weights and extra color names as validation errors', async () => {
      for (const bad of [
        novaClinic({ colors: { primary: 'teal', accent: '#f59e0b', ink: '#000', paper: '#fff' } }),
        novaClinic({ slug: 'Bad Slug' }),
        novaClinic({ slug: 'x'.repeat(41) }),
        novaClinic({ font_files: [{ family: 'Brand Serif', weight: 1000, style: 'normal', url: 'https://cdn.example.test/serif-bold.ttf' }] }),
        novaClinic({ colors: { primary: '#0f766e', accent: '#f59e0b', ink: '#000', paper: '#fff', extra: [{ name: 'Not Valid', hex: '#fff' }] } }),
        novaClinic({ style: { radius: 'round' } }),
        novaClinic({ logos: { primary: 'not-a-url' } }),
        { slug: 'no-colors', display_name: 'X', fonts: { heading: 'Outfit', body: 'Outfit' } },
      ]) {
        const r = await callTool(server.url, A, 'save_brand', bad);
        expect(r.isError, JSON.stringify(bad).slice(0, 80)).toBe(true);
        expect(textOf(r)).toMatch(/validation/i);
      }
      expect(jsonOf(await callTool(server.url, A, 'list_brands', {})).brands).toEqual([]);
    });

    it('fonts must be bundled or uploaded in the same call; nothing is saved otherwise', async () => {
      const r = await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'bad-fonts', font_files: [] }));
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/"Brand Serif" is not a bundled font/);
      expect(textOf(r)).toMatch(/Outfit.*Work Sans/);
      expect(jsonOf(await callTool(server.url, A, 'list_brands', {})).brands).toEqual([]);
    });

    it('WOFF2 and non-font files are rejected with a clear message, and nothing is stored or versioned', async () => {
      const woff = await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'woff', font_files: [{ family: 'Brand Serif', weight: 400, style: 'normal', url: 'https://cdn.example.test/font.woff2' }] }));
      expect(woff.isError).toBe(true);
      expect(textOf(woff)).toMatch(/WOFF\/WOFF2.*not supported/);
      expect(textOf(woff)).toMatch(/\.ttf or \.otf/);
      const notFont = await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'notfont', font_files: [{ family: 'Brand Serif', weight: 400, style: 'normal', url: 'https://cdn.example.test/notafont.ttf' }] }));
      expect(textOf(notFont)).toMatch(/not a TTF or OTF/);
      expect(existsSync(path.join(server.dataDir, 'fonts', 'alice', 'woff'))).toBe(false);
      expect(jsonOf(await callTool(server.url, A, 'list_brands', {})).brands).toEqual([]);
    });

    it('fetchsafe itself rejects WOFF/WOFF2 with the same kind of message (real network layer, fake transport)', async () => {
      const deps: FetchSafeDeps = {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => ({ status: 200, headers: { 'content-type': 'font/woff2' }, body: (async function* () { yield Buffer.from('wOF2....'); })(), destroy() {} }),
      };
      await expect(fetchSafe('https://cdn.example.test/x.woff2', { kind: 'font' }, deps)).rejects.toMatchObject({ code: 'font_unsupported', message: expect.stringMatching(/WOFF/) });
      expect(sniffFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image')).toBeNull(); // SVG only when asked
      expect(sniffFormat(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'image', true)).toMatchObject({ format: 'svg' });
    });

    it('unsafe SVG logos (external images, scripts) are refused', async () => {
      for (const url of ['https://cdn.example.test/evil.svg', 'https://cdn.example.test/script.svg']) {
        const r = await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'svg-bad', font_files: undefined, fonts: { heading: 'Lora', body: 'Work Sans' }, logos: { primary: url } }));
        expect(r.isError, url).toBe(true);
        expect(textOf(r)).toMatch(/references outside files, scripts or entities/);
      }
    });
  });

  describe('saving, versions and stored assets', () => {
    it('save_brand stores assets once, returns the brand data without links, a sheet preview and a public preview URL', async () => {
      const r = await callTool(server.url, A, 'save_brand', novaClinic());
      expect(r.isError, textOf(r)).toBeUndefined();
      const d = jsonOf(r);
      expect(d).toMatchObject({ saved: true, slug: 'nova-clinic', version: 1, display_name: 'Nova Clinic', owner: 'alice', shared: false });
      expect(d.brand.colors).toMatchObject({ primary: '#0f766e', accent: '#f59e0b', extra: [{ name: 'sand', hex: '#e8dcc4' }] });
      expect(d.brand.style).toMatchObject({ radius: 'large', button: 'rounded', eyebrow_case: 'title', logo_position: 'top-right', logo_size: 'large', scrim: 'soft', photo_style: 'warm natural light, minimal, beige tones' });
      expect(d.brand.voice).toMatchObject({ language: 'es', hashtags: ['#novaclinic'] });
      expect(d.brand.font_files).toHaveLength(2);
      expect(d.brand.font_files[0]).toMatchObject({ family: 'Brand Serif', weight: 700, stored: true, source_host: 'cdn.example.test' });
      expect(d.brand.logos.primary).toMatchObject({ stored: true, source_host: 'cdn.example.test' });
      // no source URL (with a path or a query) is exposed or kept
      expect(JSON.stringify(d)).not.toMatch(/serif-bold\.ttf|logo\.png|https:\/\/cdn/);
      expect(d.warnings.filter((w: any) => !['font_file_unused'].includes(w.code))).toEqual([]);

      const images = imagesOf(r);
      expect(images).toHaveLength(1);
      const preview = Buffer.from(images[0]!.data, 'base64');
      expect(preview.length).toBeLessThanOrEqual(90 * 1024);
      expect(Math.max(...[(await sharp(preview).metadata()).width ?? 0, (await sharp(preview).metadata()).height ?? 0])).toBeLessThanOrEqual(768);
      expect(d.preview_url).toMatch(/^https:\/\/images\.example\.test\/i\/.*\.jpg$/);
      const served = await rawRequest(server.url, 'GET', new URL(d.preview_url).pathname);
      expect(served.status).toBe(200);
      expect(await sharp(served.body).metadata()).toMatchObject({ width: 1280, height: 720 });
      writeFileSync(new URL('brand-sheet-nova-clinic.jpg', SAMPLES_DIR), served.body);

      // assets are on the volume, under owner/slug, named by content hash
      const fontDir = path.join(server.dataDir, 'fonts', 'alice', 'nova-clinic');
      const logoDir = path.join(server.dataDir, 'brands', 'alice', 'nova-clinic');
      expect(readdirSync(fontDir).sort()).toHaveLength(2);
      expect(readdirSync(fontDir).every((f) => /^[0-9a-f]{16}\.(ttf|otf)$/.test(f))).toBe(true);
      expect(readdirSync(logoDir).every((f) => /^[0-9a-f]{16}\.png$/.test(f))).toBe(true);
      expect(readdirSync(logoDir)).toHaveLength(2);
    });

    it('re-saving creates version 2 (get_brand returns the latest, or an older version to its owner)', async () => {
      const r = await callTool(server.url, A, 'save_brand', novaClinic({ display_name: 'Nova Clinic Norte', colors: { primary: '#115e59', accent: '#f59e0b', ink: '#0b1020', paper: '#ffffff' } }));
      expect(jsonOf(r).version).toBe(2);
      const latest = jsonOf(await callTool(server.url, A, 'get_brand', { slug: 'nova-clinic' }));
      expect(latest).toMatchObject({ slug: 'nova-clinic', version: 2, display_name: 'Nova Clinic Norte', own: true });
      expect(latest.brand.colors.primary).toBe('#115e59');
      expect(latest.brand.style.photo_style).toMatch(/warm natural light/);
      const v1 = jsonOf(await callTool(server.url, A, 'get_brand', { slug: 'nova-clinic', version: 1 }));
      expect(v1).toMatchObject({ version: 1, display_name: 'Nova Clinic' });
      expect(v1.brand.colors.primary).toBe('#0f766e');
      // same bytes -> same file names: no duplicates on the volume
      expect(readdirSync(path.join(server.dataDir, 'fonts', 'alice', 'nova-clinic'))).toHaveLength(2);
      // restore v1-like data as the working version for the next tests
      expect(jsonOf(await callTool(server.url, A, 'save_brand', novaClinic())).version).toBe(3);
    });

    it('no hot-linking: with every download blocked, compose tools still use the stored logo and uploaded fonts', async () => {
      const args = { template: 'photo-headline', format: 'square', brand: 'nova-clinic', background: { color: '#336699' }, texts: { eyebrow: 'nueva temporada', headline: 'Café de especialidad' } };
      const online = jsonOf(await callTool(server.url, A, 'compose_post', args));
      expect(online.warnings.map((w: any) => w.code)).not.toContain('logo_failed');
      expect(online.applied.logo).not.toBeNull();
      const before = { fonts: fetchedFonts.length, images: fetchedImages.length };
      offline = true;
      try {
        const off = await callTool(server.url, A, 'compose_post', args);
        expect(off.isError).toBeUndefined();
        const offData = jsonOf(off);
        expect(offData.warnings.map((w: any) => w.code)).not.toContain('logo_failed');
        expect(offData.applied.logo).not.toBeNull();
        const a = (await rawRequest(server.url, 'GET', new URL(online.url).pathname)).body;
        const b = (await rawRequest(server.url, 'GET', new URL(offData.url).pathname)).body;
        expect(a.equals(b)).toBe(true);
      } finally {
        offline = false;
      }
      expect(fetchedFonts.length).toBe(before.fonts);
      expect(fetchedImages.length).toBe(before.images);
    });

    it('an SVG logo is rasterized to a PNG at save time', async () => {
      const r = await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'svg-brand', font_files: undefined, fonts: { heading: 'Lora', body: 'Work Sans' }, logos: { primary: 'https://cdn.example.test/logo.svg' } }));
      expect(r.isError, textOf(r)).toBeUndefined();
      const info = jsonOf(r).brand.logos.primary;
      expect(info.width).toBeGreaterThanOrEqual(500); // 200 px wide SVG at density 300
      const dir = path.join(server.dataDir, 'brands', 'alice', 'svg-brand');
      const [file] = readdirSync(dir);
      const bytes = readFileSync(path.join(dir, file!));
      expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47');
      expect((await sharp(bytes).metadata()).width).toBe(info.width);
      // used on a post (as plain text-free card)
      const post = await callTool(server.url, A, 'compose_post', { template: 'cta-card', format: 'square', brand: 'svg-brand', texts: { headline: 'Hola' } });
      expect(jsonOf(post).applied.logo).not.toBeNull();
    });

    it('an uploaded font that is not used by any role is reported', async () => {
      const r = await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'unused-font', fonts: { heading: 'Lora', body: 'Work Sans' } }));
      expect(jsonOf(r).warnings.map((w: any) => w.code)).toContain('font_file_unused');
    });
  });

  describe('owners, sharing and slug resolution', () => {
    it('private brands are invisible to other owners; shared ones are visible but not editable or deletable', async () => {
      const bobList = jsonOf(await callTool(server.url, B, 'list_brands', {}));
      expect(bobList.brands).toEqual([]);
      const get = await callTool(server.url, B, 'get_brand', { slug: 'nova-clinic' });
      expect(get.isError).toBe(true);
      expect(textOf(get)).toMatch(/no saved brand called "nova-clinic"/);
      expect((await callTool(server.url, B, 'get_brand', { slug: 'alice/nova-clinic' })).isError).toBe(true);
      const use = await callTool(server.url, B, 'compose_post', { template: 'cta-card', format: 'square', brand: 'nova-clinic', texts: { headline: 'Hola' } });
      expect(use.isError).toBe(true);
      expect(textOf(use)).toMatch(/no saved brand called/);
      const del = await callTool(server.url, B, 'delete_brand', { slug: 'nova-clinic' });
      expect(del.isError).toBe(true);

      await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'house', display_name: 'Alice House', shared: true, colors: { primary: '#aa2200', accent: '#ffcc00', ink: '#000000', paper: '#ffffff' }, font_files: undefined, fonts: { heading: 'Lora', body: 'Work Sans' }, logos: undefined }));
      const shared = jsonOf(await callTool(server.url, B, 'list_brands', {}));
      expect(shared.brands).toHaveLength(1);
      expect(shared.brands[0]).toMatchObject({ slug: 'house', use_as: 'alice/house', owner: 'alice', own: false, shared: true, display_name: 'Alice House', has_logo: false });
      expect(shared.brands[0].preview_url).toMatch(/^https:\/\//);
      expect(jsonOf(await callTool(server.url, B, 'get_brand', { slug: 'house' }))).toMatchObject({ owner: 'alice', own: false, shared: true });
      expect((await callTool(server.url, B, 'get_brand', { slug: 'alice/house', version: 1 })).isError).toBe(true); // old versions are the owner's
      const delShared = await callTool(server.url, B, 'delete_brand', { slug: 'house' });
      expect(delShared.isError).toBe(true);
      expect(textOf(delShared)).toMatch(/shared by alice and can only be deleted by them/);
      // alice still has everything
      const aliceList = jsonOf(await callTool(server.url, A, 'list_brands', {}));
      expect(aliceList.brands.map((b: any) => b.slug)).toEqual(expect.arrayContaining(['nova-clinic', 'house']));
      expect(aliceList.brands.find((b: any) => b.slug === 'house')).toMatchObject({ own: true, use_as: 'house' });
    });

    it('a slug resolves to the caller’s own brand first, then to a shared one; owner/slug picks a specific shared brand', async () => {
      const color = async (token: string, brand: string): Promise<number[]> => {
        const d = jsonOf(await callTool(server.url, token, 'compose_post', { template: 'cta-card', format: 'square', brand, texts: { headline: 'Hola' }, options: { output: 'png' } }));
        const img = (await rawRequest(server.url, 'GET', new URL(d.url).pathname)).body;
        return pixelAt(await pixels(img), 4, 4) as unknown as number[];
      };
      expect(await color(B, 'house')).toEqual([0xaa, 0x22, 0x00]); // bob has no own "house": alice's shared one
      const bobs = await callTool(server.url, B, 'save_brand', { slug: 'house', display_name: 'Bob House', colors: { primary: '#0022aa', accent: '#ffcc00', ink: '#000000', paper: '#ffffff' }, fonts: { heading: 'Lora', body: 'Work Sans' } });
      expect(bobs.isError, textOf(bobs)).toBeUndefined();
      expect(await color(B, 'house')).toEqual([0x00, 0x22, 0xaa]); // own first
      expect(await color(B, 'alice/house')).toEqual([0xaa, 0x22, 0x00]); // explicit owner
      expect(await color(A, 'house')).toEqual([0xaa, 0x22, 0x00]);
      // bob's private "house" is not visible to alice by owner/slug
      const nope = await callTool(server.url, A, 'compose_post', { template: 'cta-card', format: 'square', brand: 'bob/house', texts: { headline: 'Hola' } });
      expect(nope.isError).toBe(true);
    });

    it('unknown brands fail with the list of available ones', async () => {
      const r = await callTool(server.url, B, 'compose_post', { template: 'cta-card', format: 'square', brand: 'ghost', texts: { headline: 'Hola' } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/Available brands: .*alice\/house/);
      expect(textOf(r)).toMatch(/Available brands: .*\bhouse\b/);
    });

    it('delete_brand removes every version (own only); the brand then fails to resolve and versions keep counting', async () => {
      const del = jsonOf(await callTool(server.url, B, 'delete_brand', { slug: 'house' }));
      expect(del).toMatchObject({ deleted: true, slug: 'house', versions_removed: 1 });
      expect((await callTool(server.url, B, 'delete_brand', { slug: 'house' })).isError).toBe(true);
      const again = await callTool(server.url, B, 'save_brand', { slug: 'house', display_name: 'Bob House 2', colors: { primary: '#0022aa', accent: '#ffcc00', ink: '#000000', paper: '#ffffff' }, fonts: { heading: 'Lora', body: 'Work Sans' } });
      expect(jsonOf(again).version).toBe(2);
    });
  });

  describe('the brand shapes every built-in template', () => {
    const photoDeps = async () => ({ fonts: fonts(), fetchImage: async () => makePhoto(1600, 1400) });
    const inline = (style: NonNullable<BrandInput['style']>, extra: BrandInput = {}): BrandInput => ({ colors: { primary: '#14213d', accent: '#fca311' }, style, ...extra });
    const layoutOf = (id: string, brand: BrandInput, texts: Parameters<typeof layoutText>[0]['texts'], format: keyof typeof FORMATS = 'square') => {
      const template = getTemplate(id)!;
      return layoutText({ template, format: FORMATS[format], texts, brand: resolveBrand(brand, fonts(), []), fonts: fonts(), region: textSafeRect(FORMATS[format]), align: template.defaults.align, position: template.defaults.textPosition, warnings: [] });
    };
    const ACCENT = [0xfc, 0xa3, 0x11];

    it('eyebrow case (upper / title / none) and letter spacing apply on every template that has an eyebrow', () => {
      for (const t of TEMPLATES.filter((x) => x.supports.includes('eyebrow'))) {
        const texts = { ...BUILTIN_INFO[t.id]!.sample, eyebrow: 'new season' };
        const text = (style: NonNullable<BrandInput['style']>): string => layoutOf(t.id, inline(style), texts).lines.find((l) => l.field === 'eyebrow')!.text;
        expect(text({ eyebrow_case: 'upper' }), t.id).toBe('NEW SEASON');
        expect(text({ eyebrow_case: 'title' }), t.id).toBe('New Season');
        expect(text({ eyebrow_case: 'none' }), t.id).toBe('new season');
        expect(layoutOf(t.id, inline({ letter_spacing_eyebrow: 0.3 }), texts).lines.find((l) => l.field === 'eyebrow')!.letterSpacingEm, t.id).toBe(0.3);
      }
    });

    it('CTA button shape follows brand.style.button on every template with a button (pill / rounded / square / underline)', async () => {
      for (const t of TEMPLATES.filter((x) => x.button)) {
        const info = BUILTIN_INFO[t.id]!;
        const draw = async (button: 'pill' | 'rounded' | 'square' | 'underline') => {
          const brand = inline({ button, radius: 'medium' });
          const out = await composePost({ template: t.id, format: 'square', texts: info.sample, background: { color: '#14213d' }, brand, options: { output: 'png' } }, await photoDeps());
          return { layout: out.layout, p: await pixels(out.data) };
        };
        const pill = await draw('pill');
        const rounded = await draw('rounded');
        const square = await draw('square');
        const under = await draw('underline');
        const at = (r: Awaited<ReturnType<typeof draw>>, dx: number, dy: number) => pixelAt(r.p, r.layout.button!.x + dx, r.layout.button!.y + dy);
        expect(at(square, 3, 3), `${t.id} square`).toEqual(ACCENT);
        expect(at(rounded, 3, 3), `${t.id} rounded corner`).not.toEqual(ACCENT);
        expect(at(rounded, 9, 9), `${t.id} rounded inside`).toEqual(ACCENT);
        expect(at(pill, 9, 9), `${t.id} pill`).not.toEqual(ACCENT);
        const mid = (r: Awaited<ReturnType<typeof draw>>) => pixelAt(r.p, r.layout.button!.x + Math.round(r.layout.button!.w / 2), r.layout.button!.y + Math.round(r.layout.button!.h / 2));
        expect(mid(pill)).toBeDefined();
        // underline: no filled box, a bar under the text
        expect(under.layout.button!.underline).toBeDefined();
        const bar = under.layout.button!.underline!;
        expect(pixelAt(under.p, under.layout.button!.x + Math.round(under.layout.button!.w / 2), bar.y + Math.floor(bar.h / 2))).toEqual(ACCENT);
        expect(at(under, 1, 1)).not.toEqual(ACCENT);
      }
    });

    it('radius controls the number tag (carousel-point) and the badge shape follows the button style (minimal-badge)', async () => {
      const chip = async (radius: 'none' | 'pill') => {
        const brand = inline({ radius });
        const out = await composePost({ template: 'carousel-point', format: 'square', texts: { headline: 'Title', number: '2' }, brand, options: { output: 'png' } }, await photoDeps());
        return pixelAt(await pixels(out.data), out.layout.chip!.x + 2, out.layout.chip!.y + 2);
      };
      expect(await chip('none')).toEqual(ACCENT);
      expect(await chip('pill')).not.toEqual(ACCENT);
      const badge = async (button: 'pill' | 'square') => {
        const brand = inline({ button });
        const out = await composePost({ template: 'minimal-badge', format: 'square', texts: { headline: 'From $12' }, background: { image_url: 'x' }, brand, options: { output: 'png', scrim: 'none' } }, await photoDeps());
        return pixelAt(await pixels(out.data), out.layout.badge!.x + 2, out.layout.badge!.y + 2);
      };
      expect(await badge('square')).toEqual(ACCENT);
      expect(await badge('pill')).not.toEqual(ACCENT);
    });

    it('logo position and size apply (small 12 % ... large 20 % of the width)', async () => {
      const widthOf = async (size: 'small' | 'medium' | 'large', corner: 'top-left' | 'bottom-right') => {
        const deps = { fonts: fonts(), fetchImage: async (url: string) => (url.includes('logo') ? makeLogo() : makePhoto(1600, 1400)) };
        const opts = { output: 'png', scrim: 'none', text_position: corner.startsWith('top') ? 'bottom' : 'top' } as const;
        const base = { template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: 'x' }, options: opts } as const;
        const withLogo = await composePost({ ...base, brand: { logo_url: 'https://x/logo.png', style: { logo_size: size, logo_position: corner } } }, deps);
        const without = await composePost({ ...base }, deps);
        const box = diffBox(await pixels(withLogo.data), await pixels(without.data), 4)!;
        expect(withLogo.applied.style.logo_corner).toBe(corner);
        return { width: box.x1 - box.x0 + 1, box };
      };
      const small = await widthOf('small', 'top-left');
      const medium = await widthOf('medium', 'top-left');
      const large = await widthOf('large', 'bottom-right');
      expect(small.width / 1080).toBeCloseTo(0.12, 1);
      expect(medium.width / 1080).toBeCloseTo(0.16, 1);
      expect(large.width / 1080).toBeCloseTo(0.2, 1);
      expect(large.box.y1).toBeGreaterThan(900); // bottom corner
      expect(small.box.x0).toBeLessThan(60); // left corner
    });

    it('the brand scrim is the default for photos; the call’s own option wins; minimal-badge defaults to soft', async () => {
      const scrim = async (id: string, brandScrim: 'auto' | 'soft' | 'strong' | 'none', option?: 'none' | 'strong') => {
        const out = await composePost(
          { template: id, format: 'square', texts: BUILTIN_INFO[id]!.sample, background: { image_url: 'x' }, brand: inline({ scrim: brandScrim }), options: { output: 'png', ...(option ? { scrim: option } : {}) } },
          await photoDeps(),
        );
        return out.applied.scrim;
      };
      expect(await scrim('photo-headline', 'auto')).toBe('auto');
      expect(await scrim('photo-headline', 'soft')).toBe('soft');
      expect(await scrim('photo-headline', 'strong')).toBe('strong');
      expect(await scrim('photo-headline', 'none')).toBe('none');
      expect(await scrim('photo-headline', 'none', 'strong')).toBe('strong');
      expect(await scrim('photo-headline', 'strong', 'none')).toBe('none');
      expect(await scrim('minimal-badge', 'auto')).toBe('soft'); // the template's own default
      expect(await scrim('minimal-badge', 'strong')).toBe('strong'); // the brand's explicit preference wins over it
      expect(await scrim('carousel-cover', 'soft')).toBe('soft');
    });

    it('soft scrim is lighter than auto, strong darker', async () => {
      const luma = async (scrimMode: 'auto' | 'soft' | 'strong') => {
        const out = await composePost({ template: 'photo-headline', format: 'square', texts: { headline: 'Titular' }, background: { image_url: 'x' }, brand: inline({ scrim: scrimMode }), options: { output: 'png' } }, { fonts: fonts(), fetchImage: async () => sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#f2f2f2' } }).png().toBuffer() });
        return pixelAt(await pixels(out.data), 20, 1060)[0];
      };
      const [soft, auto, strong] = [await luma('soft'), await luma('auto'), await luma('strong')];
      expect(soft).toBeGreaterThanOrEqual(auto);
      expect(strong).toBeLessThanOrEqual(auto);
    });

    it('uploaded fonts are used (compose_post, compose_custom) and a missing font file falls back with a warning', async () => {
      const custom = async (brand: string | object) =>
        jsonOf(await callTool(server.url, A, 'compose_custom', { format: 'square', brand, html: `<div style="display:flex;width:{{format.width}}px;height:{{format.height}}px;background:#fff;color:#000;align-items:center;justify-content:center;font-family:{{brand.font.heading}};font-size:120px">Hola</div>` }));
      const withUpload = await custom('nova-clinic');
      expect(withUpload.applied.fonts).toContain('Brand Serif');
      expect(withUpload.warnings.filter((w: any) => w.code === 'font_unavailable')).toEqual([]);
      const plain = await custom({});
      expect(plain.applied.fonts).not.toContain('Brand Serif');
      const a = (await rawRequest(server.url, 'GET', new URL(withUpload.url).pathname)).body;
      const b = (await rawRequest(server.url, 'GET', new URL(plain.url).pathname)).body;
      expect(a.equals(b)).toBe(false); // a different face was drawn

      // built-in templates draw the uploaded heading font too: compare with the bundled Lora Bold it is a copy of
      const args = { template: 'photo-headline', format: 'square', background: { color: '#336699' }, texts: { headline: 'Café de especialidad' }, options: { output: 'png', scrim: 'none' } };
      const uploaded = jsonOf(await callTool(server.url, A, 'compose_post', { ...args, brand: 'nova-clinic' }));
      const bundledLora = jsonOf(await callTool(server.url, A, 'compose_post', { ...args, brand: { colors: { primary: '#0f766e', secondary: '#ecfdf5', accent: '#f59e0b' }, fonts: { heading: 'Lora', body: 'Work Sans', accent: 'Outfit' }, logo_url: 'https://cdn.example.test/logo.png', logo_url_light: 'https://cdn.example.test/logo-light.png', logo_position: 'top-right', style: { logo_size: 'large', radius: 'large', button: 'rounded', eyebrow_case: 'title', scrim: 'soft' } } }));
      const bytes = async (d: { url: string }) => (await rawRequest(server.url, 'GET', new URL(d.url).pathname)).body;
      expect((await bytes(uploaded)).equals(await bytes(bundledLora))).toBe(true); // "Brand Serif" bold == Lora Bold: same pixels

      // The same brand with its font files gone from the volume
      await callTool(server.url, A, 'save_brand', novaClinic({ slug: 'will-lose-font' }));
      const lostDir = path.join(server.dataDir, 'fonts', 'alice', 'will-lose-font');
      for (const f of readdirSync(lostDir)) rmSync(path.join(lostDir, f));
      const r = jsonOf(await callTool(server.url, A, 'compose_post', { ...args, brand: 'will-lose-font' }));
      const codes = r.warnings.map((w: any) => w.code);
      expect(codes).toContain('brand_font_missing');
      expect(codes).toContain('font_unavailable');
      expect(r.url).toBeDefined(); // still rendered, with the default font
    });

    it('brand default_templates fill in a missing template per format', async () => {
      const story = jsonOf(await callTool(server.url, A, 'compose_post', { format: 'story', brand: 'nova-clinic', background: { color: '#336699' }, texts: { headline: 'Hola' } }));
      expect(story.template).toBe('photo-headline');
      const square = jsonOf(await callTool(server.url, A, 'compose_post', { format: 'square', brand: 'nova-clinic', texts: { headline: 'Una frase' } }));
      expect(square.template).toBe('quote-card');
      const none = await callTool(server.url, A, 'compose_post', { format: 'link', brand: 'nova-clinic', texts: { headline: 'Hola' } });
      expect(none.isError).toBe(true);
      expect(textOf(none)).toMatch(/no default template for this format/);
      const noBrand = await callTool(server.url, A, 'compose_post', { format: 'square', texts: { headline: 'Hola' } });
      expect(noBrand.isError).toBe(true);
    });

    it('an inline brand object accepts the new style, accent font and a saved brand works in compose_carousel and save_template previews', async () => {
      const inlineBrand = jsonOf(await callTool(server.url, A, 'compose_post', { template: 'cta-card', format: 'square', brand: { colors: { primary: '#14213d' }, fonts: { accent: 'Lora' }, style: { button: 'square', eyebrow_case: 'none' } }, texts: { headline: 'Hola', cta: 'Reservar' } }));
      expect(inlineBrand.applied.style).toMatchObject({ button: 'square', eyebrow_case: 'none' });
      const carousel = await callTool(server.url, A, 'compose_carousel', { format: 'square', brand: 'nova-clinic', slides: [{ texts: { headline: 'Hola' }, background: { image_url: PHOTO } }, { texts: { headline: 'Fin' } }] });
      expect(carousel.isError, textOf(carousel)).toBeUndefined();
      const tpl = await callTool(server.url, A, 'save_template', {
        name: 'brand-card',
        description: 'Card in the brand colors',
        html: '<div style="display:flex;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.primary}};color:#fff;font-family:{{brand.font.heading}};font-size:{{px.90}}px;align-items:center;justify-content:center">{{var.title}}</div>',
        variables: [{ name: 'title', kind: 'text', example: 'Hola' }],
        brand: 'nova-clinic',
      });
      expect(tpl.isError, textOf(tpl)).toBeUndefined();
      const img = (await rawRequest(server.url, 'GET', new URL(jsonOf(tpl).preview_url).pathname)).body;
      expect(pixelAt(await pixels(img), 6, 6)[1]).toBeGreaterThan(100); // teal primary (#0f766e), not the default navy
    });

    it('custom HTML tokens: {{brand.color.*}} incl. extras, aliases, fonts, logo, radius and style', async () => {
      const brand = jsonOf(await callTool(server.url, A, 'get_brand', { slug: 'nova-clinic' }));
      expect(brand.brand.colors.extra[0].name).toBe('sand');
      const html = (tokens: { primary: string; sand: string }): string =>
        `<div style="display:flex;width:{{format.width}}px;height:{{format.height}}px;background:${tokens.primary}"><div style="display:flex;width:300px;height:300px;margin:80px;background:${tokens.sand};border-radius:{{brand.radius}}px"></div><img src="{{brand.logo}}" style="position:absolute;right:{{safe.right}}px;bottom:{{safe.bottom}}px;width:400px;height:140px" /></div>`;
      const renderWith = async (h: string) => {
        const d = jsonOf(await callTool(server.url, A, 'compose_custom', { format: 'square', brand: 'nova-clinic', output: 'png', html: h }));
        expect(d.warnings.map((w: any) => w.code), JSON.stringify(d.warnings)).not.toContain('unknown_token');
        return (await rawRequest(server.url, 'GET', new URL(d.url).pathname)).body;
      };
      const a = await renderWith(html({ primary: '{{brand.color.primary}}', sand: '{{brand.color.sand}}' }));
      const b = await renderWith(html({ primary: '{{brand.primary}}', sand: '#e8dcc4' }));
      expect(a.equals(b)).toBe(true); // the old alias is the same color
      const p = await pixels(a);
      expect(pixelAt(p, 5, 5)).toEqual([0x0f, 0x76, 0x6e]);
      expect(pixelAt(p, 200, 200)).toEqual([0xe8, 0xdc, 0xc4]);
      // radius "large" = 48 px at 1080: the box corner is rounded
      expect(pixelAt(p, 82, 82)).toEqual([0x0f, 0x76, 0x6e]);
      // the stored logo is drawn bottom-right
      let whitePixels = 0;
      for (let y = 840; y < 970; y += 2) for (let x = 580; x < 970; x += 2) if (pixelAt(p, x, y)[0] > 200) whitePixels += 1;
      expect(whitePixels).toBeGreaterThan(20); // the white "LOGO" lettering of the stored teal logo
      const styleDoc = jsonOf(await callTool(server.url, A, 'compose_custom', { format: 'square', brand: 'nova-clinic', html: '<div data-name="{{brand.style.button}}|{{brand.style.eyebrow_transform}}|{{brand.style.logo_position}}|{{brand.name}}" style="display:flex;width:{{format.width}}px;height:{{format.height}}px"></div>' }));
      expect(styleDoc.warnings.map((w: any) => w.code)).not.toContain('unknown_token');
    });

    it('writes two brand-applied posts as samples', async () => {
      const mk = async (args: Record<string, unknown>, name: string) => {
        const d = jsonOf(await callTool(server.url, A, 'compose_post', { brand: 'nova-clinic', ...args }));
        const body = (await rawRequest(server.url, 'GET', new URL(d.url).pathname)).body;
        writeFileSync(new URL(`brand-post-${name}.${d.output}`, SAMPLES_DIR), body);
        expect(d.warnings.filter((w: any) => w.code === 'headline_too_long')).toEqual([]);
        return d;
      };
      await mk({ template: 'photo-headline', format: 'portrait', background: { image_url: PHOTO }, texts: { eyebrow: 'nueva temporada', headline: 'Cuidamos tu sonrisa', body: 'Reserva tu primera consulta esta semana.' } }, 'photo-headline');
      await mk({ template: 'cta-card', format: 'square', texts: { eyebrow: 'agenda abierta', headline: 'Tu cita en un clic', cta: 'Reservar ahora', footer: 'novaclinic.example' } }, 'cta-card');
    });
  });
});

describe('BrandStore (unit)', () => {
  it('versions, shared resolution (own first, then most recently updated shared), soft delete', () => {
    let t = 5000;
    const store = new BrandStore(':memory:', () => (t += 10));
    const mk = (slug: string, shared = false) => ({ slug, display_name: slug.toUpperCase(), data: { n: 1 }, shared });
    expect(store.save('alice', mk('acme')).version).toBe(1);
    expect(store.save('alice', mk('acme', true)).version).toBe(2);
    store.save('carol', mk('acme', true));
    store.save('bob', mk('mine'));
    expect(store.find('bob', 'acme')?.owner).toBe('carol');
    expect(store.find('alice', 'acme')?.owner).toBe('alice');
    expect(store.find('alice', 'bob/mine')).toBeUndefined();
    expect(store.find('bob', 'alice/acme')?.version).toBe(2);
    expect(store.list('bob').map((b) => `${b.owner}/${b.slug}@${b.version}`)).toEqual(['alice/acme@2', 'carol/acme@1', 'bob/mine@1']);
    expect(store.delete('alice', 'acme')).toBe(2);
    expect(store.find('alice', 'acme')?.owner).toBe('carol');
    expect(store.save('alice', mk('acme')).version).toBe(3);
    store.close();
  });
});

describe('brand tokens in renderCustom (no server)', () => {
  it('brand.style and extra colors are visible as tokens', async () => {
    const brand = { ...resolveBrand({ colors: { primary: '#112233' }, style: { button: 'square', radius: 'pill' } }, fonts(), []), extraColors: [{ name: 'sand', hex: '#e8dcc4' }] };
    const out = await renderCustom(
      { html: '<div data-name="{{brand.style.button}}" style="display:flex;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.sand}}"></div>', format: FORMATS.square, brand, output: 'png' },
      { fonts: fonts(), fetchImage: async () => makePhoto() },
    );
    expect(out.warnings.map((w) => w.code)).not.toContain('unknown_token');
    expect(pixelAt(await pixels(out.data), 10, 10)).toEqual([0xe8, 0xdc, 0xc4]);
  });
});
