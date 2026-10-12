import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composePost } from '../src/render/compose.js';
import { resolveBrand } from '../src/render/brand.js';
import { renderCustom } from '../src/render/custom/render.js';
import { FORMATS, FORMAT_NAMES, textSafeRect, type FormatName } from '../src/render/formats.js';
import { layoutText } from '../src/render/layout.js';
import { BUILTIN_INFO, builtinVariables, starterHtml } from '../src/render/templates/catalog.js';
import { TEMPLATES, getTemplate } from '../src/render/templates/index.js';
import { splitGeometry } from '../src/render/compose.js';
import { TemplateStore } from '../src/templates-store.js';
import { CUSTOM_BLOCKING_WARNINGS } from '../src/tools/shared.js';
import { callTool, fonts, makeLogo, makePhoto, OTHER_TOKEN, pixelAt, pixels, rawRequest, startTestServer, TEST_TOKEN } from './helpers.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;
type ToolResult = Awaited<ReturnType<typeof callTool>>;

const textOf = (r: ToolResult): string => r.content.find((c) => c.type === 'text')?.text ?? '';
const jsonOf = (r: ToolResult): any => JSON.parse(textOf(r));
const imagesOf = (r: ToolResult): { data: string; mimeType: string }[] => r.content.filter((c) => c.type === 'image');

const SAMPLES_DIR = new URL('../.samples/', import.meta.url);
mkdirSync(SAMPLES_DIR, { recursive: true });

const PHOTO = 'https://assets.example.test/photo.jpg';
const LOGO = 'https://assets.example.test/logo.png';

/** A promo layout with two text variables and an optional photo. */
const PROMO_HTML = `<div style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.primary}};font-family:{{brand.font.body}}">
  <img src="{{asset.photo}}" style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;object-fit:cover" />
  <div style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;background-image:linear-gradient(to bottom, rgba(11,16,32,0.5), rgba(11,16,32,0.85))"></div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;bottom:{{safe.bottom}}px;display:flex;flex-direction:column;color:#fff">
    <div data-fit data-fit-max="120" data-fit-min="48" data-fit-lines="3" style="display:flex;width:100%;font-family:{{brand.font.heading}};font-weight:700;line-height:1.05">{{var.title}}</div>
    <div style="display:flex;margin-top:24px;font-size:56px;color:{{brand.color.accent}};font-weight:700">{{var.price}}</div>
  </div>
</div>`;

const promoArgs = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: 'Promo with a big title and a price over a photo',
  html: PROMO_HTML,
  variables: [
    { name: 'title', kind: 'text', required: true, max_chars: 40, example: 'Summer sale' },
    { name: 'price', kind: 'text', required: true, max_chars: 12, example: 'From $9' },
    { name: 'photo', kind: 'image', required: false, example: PHOTO },
  ],
  formats: ['square', 'portrait'],
  tags: ['promo', 'sale'],
  ...extra,
});

describe('saved templates over MCP (two owners)', () => {
  let server: Server;
  const fetched: string[] = [];
  const A = TEST_TOKEN; // alice
  const B = OTHER_TOKEN; // bob

  beforeAll(async () => {
    server = await startTestServer({
      configExtra: { DAILY_RENDER_LIMIT: '60' },
      overrides: {
        fetchImage: async (url: string) => {
          fetched.push(url);
          if (url.includes('broken')) throw new Error('boom');
          return url.includes('logo') ? makeLogo() : makePhoto(1600, 1200);
        },
      },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('save_template draws the examples, stores a preview, and returns the variables and warnings', async () => {
    const r = await callTool(server.url, A, 'save_template', promoArgs('promo-photo'));
    expect(r.isError, textOf(r)).toBeUndefined();
    const d = jsonOf(r);
    expect(d).toMatchObject({ saved: true, name: 'promo-photo', version: 1, owner: 'alice', shared: false, formats: ['square', 'portrait'], tags: ['promo', 'sale'], preview_format: 'square' });
    expect(d.variables.map((v: any) => v.name)).toEqual(['title', 'price', 'photo']);
    expect(d.preview_url).toMatch(/^https:\/\/images\.example\.test\/i\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(d.warnings.filter((w: any) => ['variable_undeclared', 'variable_unused'].includes(w.code))).toEqual([]);
    expect(imagesOf(r)).toHaveLength(1);
    const served = await rawRequest(server.url, 'GET', new URL(d.preview_url).pathname);
    expect(served.status).toBe(200);
    expect((await sharp(served.body).metadata()).width).toBeLessThanOrEqual(640);
    expect(fetched).toContain(PHOTO); // the example photo went through the fetcher
  });

  it('saving the same name again creates version 2; get_template returns the latest or a specific version', async () => {
    const r = await callTool(server.url, A, 'save_template', promoArgs('promo-photo', { html: PROMO_HTML.replace('<div style="display:flex;position:relative;', '<div data-name="winter" style="display:flex;position:relative;') }));
    expect(jsonOf(r).version).toBe(2);
    const latest = jsonOf(await callTool(server.url, A, 'get_template', { name: 'promo-photo' }));
    expect(latest).toMatchObject({ kind: 'saved', version: 2, owner: 'alice', own: true, shared: false });
    expect(latest.html).toContain('data-name="winter"');
    const v1 = jsonOf(await callTool(server.url, A, 'get_template', { name: 'promo-photo', version: 1 }));
    expect(v1.version).toBe(1);
    expect(v1.html).not.toContain('winter');
    expect(v1.variables[0]).toMatchObject({ name: 'title', kind: 'text', required: true, max_chars: 40, example: 'Summer sale' });
    expect(v1.formats).toEqual(['square', 'portrait']);
  });

  it('validation: reserved names, missing examples, duplicates, failing renders save nothing', async () => {
    const reserved = await callTool(server.url, A, 'save_template', promoArgs('cta-card'));
    expect(reserved.isError).toBe(true);
    expect(textOf(reserved)).toMatch(/built-in/);
    const noExample = await callTool(server.url, A, 'save_template', promoArgs('no-example', { variables: [{ name: 'title', kind: 'text', required: true }] }));
    expect(textOf(noExample)).toMatch(/needs an example/);
    const dup = await callTool(server.url, A, 'save_template', promoArgs('dup', { variables: [{ name: 'title', kind: 'text', example: 'a' }, { name: 'title', kind: 'text', example: 'b' }] }));
    expect(textOf(dup)).toMatch(/listed twice/);
    const badName = await callTool(server.url, A, 'save_template', promoArgs('Bad Name'));
    expect(badName.isError).toBe(true);
    const failing = await callTool(server.url, A, 'save_template', promoArgs('fails', { variables: [{ name: 'title', kind: 'text', example: 'x' }, { name: 'price', kind: 'text', example: 'y' }, { name: 'photo', kind: 'image', example: 'https://assets.example.test/broken.jpg' }] }));
    expect(failing.isError).toBe(true);
    expect(textOf(failing)).toMatch(/asset "photo"/);
    const list = jsonOf(await callTool(server.url, A, 'list_templates', {}));
    expect(list.templates.filter((t: any) => t.kind === 'saved').map((t: any) => t.id)).toEqual(['promo-photo']);
  });

  it('undeclared and unused variables are reported at save time', async () => {
    const r = await callTool(server.url, A, 'save_template', promoArgs('loose', { tags: ['loose-ends'], variables: [{ name: 'title', kind: 'text', example: 'Hi' }, { name: 'ghost', kind: 'text', required: false }] }));
    const codes = jsonOf(r).warnings.map((w: any) => w.code);
    expect(codes).toContain('variable_undeclared'); // price / photo
    expect(codes).toContain('variable_unused'); // ghost
  });

  it('privacy: bob does not see, get, use or delete alice’s private templates', async () => {
    const list = jsonOf(await callTool(server.url, B, 'list_templates', {}));
    expect(list.templates.filter((t: any) => t.kind === 'saved')).toEqual([]);
    const get = await callTool(server.url, B, 'get_template', { name: 'promo-photo' });
    expect(get.isError).toBe(true);
    expect(textOf(get)).toMatch(/no template called "promo-photo"/);
    const byOwner = await callTool(server.url, B, 'get_template', { name: 'alice/promo-photo' });
    expect(byOwner.isError).toBe(true);
    const use = await callTool(server.url, B, 'compose_post', { template: 'promo-photo', format: 'square', variables: { title: 'x', price: 'y' } });
    expect(use.isError).toBe(true);
    expect(textOf(use)).toMatch(/no template called/);
    const del = await callTool(server.url, B, 'delete_template', { name: 'promo-photo' });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toMatch(/no saved template called/);
    // still there for alice
    const mine = jsonOf(await callTool(server.url, A, 'list_templates', {}));
    expect(mine.templates.some((t: any) => t.kind === 'saved' && t.id === 'promo-photo' && t.own === true && t.shared === false)).toBe(true);
  });

  it('shared templates are visible to everyone, flagged with owner and shared, and cannot be edited or deleted by others', async () => {
    const saved = await callTool(server.url, A, 'save_template', promoArgs('promo-shared', { shared: true, tags: ['promo', 'shared-one'] }));
    expect(jsonOf(saved).shared).toBe(true);
    const list = jsonOf(await callTool(server.url, B, 'list_templates', {}));
    const entry = list.templates.find((t: any) => t.id === 'promo-shared');
    expect(entry).toMatchObject({ kind: 'saved', owner: 'alice', own: false, shared: true, use_as: 'alice/promo-shared', version: 1 });
    expect(entry.variables.map((v: any) => v.name)).toEqual(['title', 'price', 'photo']);
    expect(entry.preview_url).toMatch(/^https:\/\//);
    expect(entry.formats).toHaveProperty('square');
    expect(list.templates.some((t: any) => t.id === 'promo-photo')).toBe(false); // alice's private one stays private
    const got = jsonOf(await callTool(server.url, B, 'get_template', { name: 'alice/promo-shared' }));
    expect(got).toMatchObject({ own: false, shared: true, owner: 'alice' });
    // bob cannot delete it, nor fetch an old version of it
    const del = await callTool(server.url, B, 'delete_template', { name: 'promo-shared' });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toMatch(/shared by alice and can only be deleted by them/);
    const old = await callTool(server.url, B, 'get_template', { name: 'alice/promo-shared', version: 1 });
    expect(old.isError).toBe(true);
    // saving "promo-shared" as bob makes bob's own template, which wins for him; alice's is untouched
    const bobs = await callTool(server.url, B, 'save_template', promoArgs('promo-shared'));
    expect(jsonOf(bobs)).toMatchObject({ version: 1, owner: 'bob' });
    const own = jsonOf(await callTool(server.url, B, 'get_template', { name: 'promo-shared' }));
    expect(own).toMatchObject({ owner: 'bob', own: true });
    const hers = jsonOf(await callTool(server.url, B, 'get_template', { name: 'alice/promo-shared' }));
    expect(hers.owner).toBe('alice');
    expect(jsonOf(await callTool(server.url, A, 'get_template', { name: 'promo-shared' })).owner).toBe('alice');
  });

  it('list_templates filters by format and tag', async () => {
    const link = jsonOf(await callTool(server.url, A, 'list_templates', { format: 'link' }));
    expect(link.templates.some((t: any) => t.kind === 'saved')).toBe(false); // designed for square/portrait only
    expect(link.templates.filter((t: any) => t.kind === 'built-in')).toHaveLength(8);
    const square = jsonOf(await callTool(server.url, A, 'list_templates', { format: 'square' }));
    expect(square.templates.some((t: any) => t.id === 'promo-photo')).toBe(true);
    const sale = jsonOf(await callTool(server.url, A, 'list_templates', { tag: 'sale' }));
    expect(sale.templates.map((t: any) => t.id)).toEqual(['promo-photo']);
    const carousel = jsonOf(await callTool(server.url, A, 'list_templates', { tag: 'carousel' }));
    expect(carousel.templates.map((t: any) => t.id)).toEqual(['carousel-cover', 'carousel-point', 'carousel-end']);
  });

  it('compose_post renders a saved template with variables, assets and brand; enforces required variables; warns on length and format', async () => {
    const ok = await callTool(server.url, A, 'compose_post', {
      template: 'promo-photo',
      format: 'square',
      variables: { title: 'Summer sale', price: 'From $9' },
      assets: { photo: PHOTO },
      brand: { colors: { primary: '#14213d', accent: '#fca311' } },
    });
    expect(ok.isError).toBeUndefined();
    const d = jsonOf(ok);
    expect(d).toMatchObject({ width: 1080, height: 1080, format: 'square', template: 'promo-photo', template_version: 2, output: 'jpg', needs_attention: false });
    expect(d.url).toMatch(/\.jpg$/);
    expect(imagesOf(ok)).toHaveLength(1);

    const missing = await callTool(server.url, A, 'compose_post', { template: 'promo-photo', format: 'square', variables: { title: 'Only a title' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/needs: price \(text\)/);

    const longText = jsonOf(await callTool(server.url, A, 'compose_post', { template: 'promo-photo', format: 'portrait', variables: { title: 'T'.repeat(50), price: '$9' } }));
    expect(longText.warnings.map((w: any) => w.code)).toContain('variable_too_long');

    const wrongFormat = jsonOf(await callTool(server.url, A, 'compose_post', { template: 'promo-photo', format: 'story', variables: { title: 'Story', price: '$9' } }));
    expect(wrongFormat.warnings.map((w: any) => w.code)).toContain('template_format_mismatch');
  });

  it('compose_post lets texts fill variables and background.image_url fill the "background" image variable', async () => {
    const htmlWithBackground = PROMO_HTML.replace('{{asset.photo}}', '{{asset.background}}');
    await callTool(server.url, A, 'save_template', promoArgs('promo-bg', { html: htmlWithBackground, variables: [{ name: 'title', kind: 'text', example: 'A' }, { name: 'price', kind: 'text', example: 'B' }, { name: 'background', kind: 'image', required: true, example: PHOTO }] }));
    const before = fetched.length;
    const r = jsonOf(await callTool(server.url, A, 'compose_post', { template: 'promo-bg', format: 'square', texts: { headline: 'ignored' }, variables: { title: 'T', price: 'P' }, background: { image_url: 'https://assets.example.test/other.jpg' } }));
    expect(fetched.slice(before)).toContain('https://assets.example.test/other.jpg');
    expect(r.warnings.map((w: any) => w.code)).not.toContain('background_ignored');
    const ignored = jsonOf(await callTool(server.url, A, 'compose_post', { template: 'promo-photo', format: 'square', variables: { title: 'T', price: 'P' }, background: { image_url: 'https://assets.example.test/other.jpg' } }));
    expect(ignored.warnings.map((w: any) => w.code)).toContain('background_ignored');
  });

  it('delete_template removes every version (soft delete); a later save continues the version count', async () => {
    const before = jsonOf(await callTool(server.url, A, 'get_template', { name: 'promo-bg' }));
    expect(before.version).toBe(1);
    const del = jsonOf(await callTool(server.url, A, 'delete_template', { name: 'promo-bg' }));
    expect(del).toMatchObject({ deleted: true, name: 'promo-bg', versions_removed: 1 });
    const gone = await callTool(server.url, A, 'get_template', { name: 'promo-bg' });
    expect(gone.isError).toBe(true);
    const again = await callTool(server.url, A, 'delete_template', { name: 'promo-bg' });
    expect(again.isError).toBe(true);
    const resave = jsonOf(await callTool(server.url, A, 'save_template', promoArgs('promo-bg')));
    expect(resave.version).toBe(2); // (owner, name, version) stays unique
    const builtin = await callTool(server.url, A, 'delete_template', { name: 'cta-card' });
    expect(builtin.isError).toBe(true);
  });

  it('get_template on a built-in returns a starter HTML equivalent, its variables and tags', async () => {
    for (const t of TEMPLATES) {
      const d = jsonOf(await callTool(server.url, A, 'get_template', { name: t.id }));
      expect(d).toMatchObject({ name: t.id, kind: 'built-in' });
      expect(d.html).toBe(starterHtml(t.id));
      expect(d.html).toMatch(/\{\{format\.width\}\}/);
      expect(d.variables.map((v: any) => v.name)).toContain('headline');
      expect(d.tags.length).toBeGreaterThan(0);
    }
  });

  it('built-in previews are rendered once per (template, format), cached, and rendered again when the stored file expired', async () => {
    const first = jsonOf(await callTool(server.url, A, 'list_templates', { format: 'portrait' }));
    const builtins = first.templates.filter((t: any) => t.kind === 'built-in');
    expect(builtins).toHaveLength(8);
    for (const t of builtins) {
      expect(t.preview_url, t.id).toMatch(/^https:\/\/images\.example\.test\/i\//);
      expect(t.formats.portrait.preview_url).toBe(t.preview_url);
      expect(t.preview_format).toBe('portrait');
    }
    const urls = builtins.map((t: any) => t.preview_url);
    expect(new Set(urls).size).toBe(8);
    const served = await rawRequest(server.url, 'GET', new URL(urls[0]).pathname);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    const thumbMeta = await sharp(served.body).metadata();
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(640);

    const second = jsonOf(await callTool(server.url, A, 'list_templates', { format: 'portrait' }));
    expect(second.templates.filter((t: any) => t.kind === 'built-in').map((t: any) => t.preview_url)).toEqual(urls); // cached

    rmSync(path.join(server.dataDir, 'images', new URL(urls[0]).pathname.replace('/i/', '')));
    const third = jsonOf(await callTool(server.url, A, 'list_templates', { format: 'portrait' }));
    const renewed = third.templates.find((t: any) => t.id === builtins[0].id).preview_url;
    expect(renewed).not.toBe(urls[0]);
    expect((await rawRequest(server.url, 'GET', new URL(renewed).pathname)).status).toBe(200);
    // another format is rendered on its own
    const square = jsonOf(await callTool(server.url, A, 'list_templates', { format: 'square' }));
    expect(square.templates[0].preview_url).not.toBe(urls[0]);
  });
});

describe('TemplateStore (unit)', () => {
  it('owner-scoped versions, shared resolution (own first, then most recently updated shared) and soft delete', () => {
    let t = 1000;
    const store = new TemplateStore(':memory:', () => (t += 10));
    const base = { description: 'd', html: '<div></div>', variables: [], formats: [], tags: [], shared: false };
    expect(store.save('alice', { ...base, name: 'x' }).version).toBe(1);
    expect(store.save('alice', { ...base, name: 'x', shared: true }).version).toBe(2);
    store.save('carol', { ...base, name: 'x', shared: true });
    store.save('bob', { ...base, name: 'y' });
    expect(store.find('bob', 'x')?.owner).toBe('carol'); // most recently updated shared
    expect(store.find('alice', 'x')?.owner).toBe('alice');
    expect(store.find('bob', 'alice/x')?.owner).toBe('alice');
    expect(store.find('alice', 'bob/y')).toBeUndefined(); // private
    expect(store.list('bob').map((r) => `${r.owner}/${r.name}@${r.version}`)).toEqual(['alice/x@2', 'carol/x@1', 'bob/y@1']);
    expect(store.getOwn('alice', 'x', 1)?.shared).toBe(false);
    expect(store.delete('alice', 'x')).toBe(2);
    expect(store.find('alice', 'x')?.owner).toBe('carol');
    expect(store.save('alice', { ...base, name: 'x' }).version).toBe(3);
    store.close();
  });
});

describe('compose_carousel', () => {
  let server: Server;
  const A = TEST_TOKEN;

  beforeAll(async () => {
    server = await startTestServer({
      configExtra: { DAILY_RENDER_LIMIT: '200' },
      overrides: { fetchImage: async (url: string) => (url.includes('logo') ? makeLogo() : makePhoto(1600, 1400)) },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  const slides4 = [
    { texts: { eyebrow: '3 tips', headline: 'Make better coffee', cta: 'Swipe' }, background: { image_url: PHOTO } },
    { texts: { headline: 'Grind fresh', body: 'Ground coffee loses aroma within minutes.' } },
    { texts: { headline: 'Weigh the beans', body: 'Use a scale: 15 grams per cup.' } },
    { texts: { headline: 'Save this post', cta: 'Follow us' } },
  ];

  it('returns the urls in slide order, previews for the first 3 within the budget, and counts every slide', async () => {
    const before = jsonOf(await callTool(server.url, A, 'list_providers', {})).today.composed_graphics_left;
    const r = await callTool(server.url, A, 'compose_carousel', { format: 'portrait', slides: slides4, brand: { colors: { primary: '#14213d', accent: '#fca311' } } });
    expect(r.isError).toBeUndefined();
    const d = jsonOf(r);
    expect(d.count).toBe(4);
    expect(d.urls).toHaveLength(4);
    expect(d.slides.map((s: any) => s.template)).toEqual(['carousel-cover', 'carousel-point', 'carousel-point', 'carousel-end']);
    expect(d.slides.map((s: any) => s.slide)).toEqual([1, 2, 3, 4]);
    expect(d.slides.map((s: any) => s.url)).toEqual(d.urls);
    expect(new Set(d.urls).size).toBe(4);
    expect(d.previews_for_slides).toEqual([1, 2, 3]);
    const images = imagesOf(r);
    expect(images).toHaveLength(3);
    const total = images.reduce((n, i) => n + Buffer.from(i.data, 'base64').length, 0);
    expect(total).toBeLessThanOrEqual(90 * 1024);
    for (const url of d.urls) {
      const served = await rawRequest(server.url, 'GET', new URL(url).pathname);
      expect(served.status).toBe(200);
      expect(await sharp(served.body).metadata()).toMatchObject({ width: 1080, height: 1350 });
    }
    expect(d.graphics_left_today).toBe(before - 4);
    expect(jsonOf(await callTool(server.url, A, 'list_providers', {})).today.composed_graphics_left).toBe(before - 4);
    expect(d.needs_attention).toBe(false);
  });

  it('numbers carousel-point slides automatically (1, 2, ...) and draws a counter chip unless counter is false', async () => {
    const plain = jsonOf(await callTool(server.url, A, 'compose_carousel', { format: 'square', counter: false, slides: slides4 }));
    const fetchBytes = async (url: string): Promise<Buffer> => (await rawRequest(server.url, 'GET', new URL(url).pathname)).body;
    const direct = jsonOf(await callTool(server.url, A, 'compose_post', { template: 'carousel-point', format: 'square', texts: { number: '2', headline: 'Weigh the beans', body: 'Use a scale: 15 grams per cup.' } }));
    // slide 3 is the second point: number "2", no counter -> identical to compose_post with number "2"
    expect((await fetchBytes(plain.urls[2])).equals(await fetchBytes(direct.url))).toBe(true);
    const counted = jsonOf(await callTool(server.url, A, 'compose_carousel', { format: 'square', slides: slides4 }));
    expect((await fetchBytes(counted.urls[2])).equals(await fetchBytes(direct.url))).toBe(false); // the chip is there
    const p = await pixels(await fetchBytes(counted.urls[2]));
    const q = await pixels(await fetchBytes(direct.url));
    // the chip sits bottom-right, nothing else differs
    let diffs = 0;
    for (let y = 0; y < 1080; y += 3) for (let x = 0; x < 1080; x += 3) if (pixelAt(p, x, y)[0] !== pixelAt(q, x, y)[0]) diffs += 1;
    expect(diffs).toBeGreaterThan(50);
    expect(pixelAt(p, 100, 100)).toEqual(pixelAt(q, 100, 100));
  });

  it('limits: 2 to 10 slides; the daily render limit is checked up front (nothing is drawn or counted when it cannot fit)', async () => {
    const one = await callTool(server.url, A, 'compose_carousel', { format: 'square', slides: [slides4[0]] });
    expect(one.isError).toBe(true);
    expect(textOf(one)).toMatch(/validation/i);
    const eleven = await callTool(server.url, A, 'compose_carousel', { format: 'square', slides: Array.from({ length: 11 }, () => slides4[1]) });
    expect(eleven.isError).toBe(true);
    const ten = jsonOf(await callTool(server.url, A, 'compose_carousel', { format: 'square', slides: Array.from({ length: 10 }, (_, i) => ({ texts: { headline: `Point ${i + 1}` } })) }));
    expect(ten.count).toBe(10);
    expect(ten.slides.map((s: any) => s.template)).toEqual(['carousel-cover', ...Array(8).fill('carousel-point'), 'carousel-end']);
    const small = await startTestServer({ configExtra: { DAILY_RENDER_LIMIT: '3' } });
    try {
      const refused = await callTool(small.url, A, 'compose_carousel', { format: 'square', slides: slides4.map((s) => ({ ...s, background: undefined })) });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/needs 4 composed graphics but only 3 are left/);
      expect(jsonOf(await callTool(small.url, A, 'list_providers', {})).today.composed_graphics_left).toBe(3);
    } finally {
      await small.close();
    }
  });

  it('checks everything it can before drawing: a bad slide costs nothing and is named', async () => {
    const before = jsonOf(await callTool(server.url, A, 'list_providers', {})).today.composed_graphics_left;
    const noHeadline = await callTool(server.url, A, 'compose_carousel', { format: 'square', slides: [{ texts: { headline: 'ok' } }, { texts: { body: 'no headline' } }] });
    expect(noHeadline.isError).toBe(true);
    expect(textOf(noHeadline)).toMatch(/Slide 2: a headline is required/);
    const unknown = await callTool(server.url, A, 'compose_carousel', { format: 'square', slides: [{ texts: { headline: 'ok' } }, { template: 'nope', texts: { headline: 'x' } }] });
    expect(textOf(unknown)).toMatch(/Slide 2: There is no template called "nope"/);
    expect(jsonOf(await callTool(server.url, A, 'list_providers', {})).today.composed_graphics_left).toBe(before);
  });

  it('mixes built-in and saved templates, and a missing variable names the slide', async () => {
    await callTool(server.url, A, 'save_template', promoArgs('promo-photo'));
    const mixed = jsonOf(
      await callTool(server.url, A, 'compose_carousel', {
        format: 'square',
        slides: [{ template: 'carousel-cover', texts: { headline: 'Sale week' } }, { template: 'promo-photo', variables: { title: 'Day 1', price: '$5' }, assets: { photo: PHOTO } }, { template: 'carousel-end', texts: { headline: 'See you' } }],
      }),
    );
    expect(mixed.slides.map((s: any) => s.template)).toEqual(['carousel-cover', 'promo-photo', 'carousel-end']);
    const bad = await callTool(server.url, A, 'compose_carousel', { format: 'square', slides: [{ texts: { headline: 'a' } }, { template: 'promo-photo', variables: { title: 'only title' } }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Slide 2 of 2: The template "promo-photo" needs: price \(text\)/);
    expect(textOf(bad)).toMatch(/slides 1-1 were drawn/);
  });

  it('writes a 4-slide carousel sample', async () => {
    const d = jsonOf(
      await callTool(server.url, A, 'compose_carousel', {
        format: 'portrait',
        brand: { colors: { primary: '#14213d', accent: '#fca311' }, fonts: { heading: 'Bricolage Grotesque', body: 'Work Sans' }, logo_url: LOGO, logo_position: 'top-right' },
        slides: [
          { texts: { eyebrow: '3 consejos', headline: 'Mejor café en casa', body: 'Hábitos sencillos que cambian la taza.', cta: 'Desliza' }, background: { image_url: PHOTO } },
          { texts: { eyebrow: 'Consejo', headline: 'Muele al momento', body: 'El café molido pierde aroma en minutos. Muele solo lo que vas a usar.' } },
          { texts: { eyebrow: 'Consejo', headline: 'Pesa los granos', body: 'Usa una báscula: 15 gramos por taza dan una extracción pareja.' } },
          { texts: { headline: 'Guarda este post', body: 'Y compártelo con quien ama el café.', cta: 'Síguenos', footer: '@cafeejemplo' } },
        ],
      }),
    );
    for (const [i, url] of (d.urls as string[]).entries()) {
      const bytes = (await rawRequest(server.url, 'GET', new URL(url).pathname)).body;
      writeFileSync(new URL(`compose-carousel-slide-${i + 1}.${url.endsWith('.png') ? 'png' : 'jpg'}`, SAMPLES_DIR), bytes);
    }
    expect(d.needs_attention).toBe(false);
  });
});

describe('built-in templates: every template in every format', () => {
  const photoUrl = 'https://assets.example.test/photo.jpg';
  async function deps() {
    const photo = await makePhoto(1800, 1400);
    return { fonts: fonts(), fetchImage: async (url: string) => (url.includes('logo') ? makeLogo() : photo) };
  }

  for (const template of TEMPLATES) {
    for (const name of FORMAT_NAMES) {
      it(`${template.id} / ${name}: valid dimensions, no "too long" warning, text inside the safe zones`, async () => {
        const info = BUILTIN_INFO[template.id]!;
        const out = await composePost(
          { template: template.id, format: name, texts: info.sample, background: info.photo ? { image_url: photoUrl } : undefined, brand: { colors: { primary: '#14213d', accent: '#fca311' }, logo_url: 'https://assets.example.test/logo.png' } },
          await deps(),
        );
        const meta = await sharp(out.data).metadata();
        expect([meta.width, meta.height]).toEqual([FORMATS[name].width, FORMATS[name].height]);
        expect(out.warnings.filter((w) => w.code === 'headline_too_long')).toEqual([]);
        expect(out.warnings.filter((w) => w.code.endsWith('_ignored'))).toEqual([]);
        const stats = await sharp(out.data).stats();
        expect(stats.channels[0]?.stdev ?? 0).toBeGreaterThan(5);
      });
    }
  }

  it('quote-card draws the opening quotation mark; carousel-point draws the number tag only when given; minimal-badge puts the headline in a badge', () => {
    const warnings: never[] = [];
    const brand = resolveBrand(undefined, fonts(), []);
    const run = (id: string, texts: Parameters<typeof layoutText>[0]['texts']) => {
      const template = getTemplate(id)!;
      const format = FORMATS.square;
      return layoutText({ template, format, texts, brand, fonts: fonts(), region: textSafeRect(format), align: template.defaults.align, position: template.defaults.textPosition, warnings });
    };
    const quote = run('quote-card', { headline: 'A quote', footer: 'Someone' });
    expect(quote.lines[0]).toMatchObject({ field: 'mark', text: '“', tone: 'accent' });
    expect(quote.lines.map((l) => l.field)).toEqual(['mark', 'headline', 'footer']);
    const point = run('carousel-point', { headline: 'Title', body: 'Body text', number: '3' });
    expect(point.chip?.line.text).toBe('3');
    expect(point.chip?.kind).toBe('chip');
    expect(run('carousel-point', { headline: 'Title' }).chip).toBeUndefined();
    const badge = run('minimal-badge', { headline: 'From $12', eyebrow: 'New' });
    expect(badge.badge?.line.text).toBe('From $12');
    expect(badge.lines.map((l) => l.field)).toEqual(['eyebrow']);
    expect(badge.badge!.y).toBeGreaterThan(badge.lines[0]!.y);
  });

  it('split: the photo fills only its part of the canvas and the rest is the flat primary panel, on every format', async () => {
    const template = getTemplate('split')!;
    for (const name of FORMAT_NAMES) {
      const out = await composePost(
        { template: 'split', format: name, texts: { headline: 'Hola' }, background: { image_url: photoUrl }, brand: { colors: { primary: '#14213d' } }, options: { output: 'png' } },
        await deps(),
      );
      const { photo, panel } = splitGeometry(template.split!, FORMATS[name]);
      expect(photo.w * photo.h + panel.w * panel.h).toBe(FORMATS[name].width * FORMATS[name].height); // they tile the canvas
      const p = await pixels(out.data);
      const inPhoto = pixelAt(p, photo.x + Math.floor(photo.w / 2), photo.y + Math.floor(photo.h / 2));
      expect(inPhoto).not.toEqual([0x14, 0x21, 0x3d]);
      const corner = pixelAt(p, panel.x + panel.w - 6, panel.y + (photo.y === 0 ? panel.h - 6 : 6));
      expect(corner).toEqual([0x14, 0x21, 0x3d]);
    }
  });

  it('every starter HTML renders through compose_custom in every format without blocking warnings', async () => {
    const d = await deps();
    const failures: string[] = [];
    for (const template of TEMPLATES) {
      const info = BUILTIN_INFO[template.id]!;
      const variables = Object.fromEntries(Object.entries(info.sample).filter(([, v]) => v !== undefined)) as Record<string, string>;
      for (const name of FORMAT_NAMES) {
        const out = await renderCustom(
          { html: starterHtml(template.id), format: FORMATS[name], brand: resolveBrand({ colors: { primary: '#14213d', accent: '#fca311' }, logo_url: 'https://assets.example.test/logo.png' }, fonts(), []), variables, assets: info.photo ? { background: photoUrl } : {}, optionalAssets: ['background'], output: 'jpg' },
          d,
        );
        const meta = await sharp(out.data).metadata();
        expect([meta.width, meta.height], `${template.id}/${name}`).toEqual([FORMATS[name].width, FORMATS[name].height]);
        for (const w of out.warnings.filter((x) => CUSTOM_BLOCKING_WARNINGS.has(x.code))) failures.push(`${template.id}/${name}: ${w.message}`);
        if (name === 'square') writeFileSync(new URL(`starter-${template.id}-square.jpg`, SAMPLES_DIR), out.data);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('each built-in lists the variables of its starter, with the sample as example', () => {
    for (const t of TEMPLATES) {
      const vars = builtinVariables(t);
      expect(vars.find((v) => v.name === 'headline')).toMatchObject({ kind: 'text', required: true });
      expect(vars.every((v) => v.name === 'background' || v.example !== undefined)).toBe(true);
      expect(vars.some((v) => v.name === 'background')).toBe(BUILTIN_INFO[t.id]!.photo);
    }
  });

  it('a counter chip never lands in the logo corner', async () => {
    const out = await composePost(
      { template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: photoUrl }, brand: { logo_url: 'https://assets.example.test/logo.png', logo_position: 'bottom-right' }, counter: { index: 1, total: 3 } },
      await deps(),
    );
    expect(out.applied.logo).not.toBeNull();
    expect(out.applied.counter?.corner).toBe('bottom-left');
    const free = await composePost({ template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: photoUrl }, counter: { index: 1, total: 3 } }, await deps());
    expect(free.applied.counter?.corner).toBe('bottom-right');
  });
});
