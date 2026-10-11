import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { fetchSafe } from '../src/fetchsafe.js';
import { callTool, makePhoto, rawRequest, rpc, startTestServer, TEST_TOKEN } from './helpers.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

const textOf = (result: { content: { type: string; text?: string }[] }): string => result.content.find((c) => c.type === 'text')?.text ?? '';
const jsonOf = (result: { content: { type: string; text?: string }[] }): any => JSON.parse(textOf(result));

describe('MCP tools over HTTP', () => {
  let server: Server;
  const fetched: string[] = [];

  beforeAll(async () => {
    server = await startTestServer({
      configExtra: { GEMINI_API_KEY: 'fake-gemini-key-do-not-leak', DAILY_RENDER_LIMIT: '6' },
      overrides: {
        fetchImage: async (url: string) => {
          fetched.push(url);
          if (url.includes('boom')) throw new Error('kaboom internal detail');
          return makePhoto(1600, 1200);
        },
      },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('initialize advertises tools and instructions', async () => {
    const res = await rpc(server.url, TEST_TOKEN, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } });
    expect(res.json.result.capabilities.tools).toBeDefined();
    expect(res.json.result.instructions).toMatch(/compose_post/);
  });

  it('tools/list: every tool has a title, annotations and a description for an LLM', async () => {
    const res = await rpc(server.url, TEST_TOKEN, 'tools/list');
    const tools = res.json.result.tools as { name: string; title?: string; description: string; annotations: Record<string, boolean>; inputSchema: any }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compose_carousel',
      'compose_custom',
      'compose_post',
      'delete_brand',
      'delete_template',
      'get_brand',
      'get_template',
      'list_brands',
      'list_providers',
      'list_templates',
      'save_brand',
      'save_template',
    ]);
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.title?.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(80);
      expect(t.annotations.title).toBeDefined();
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
      expect(t.inputSchema.type).toBe('object');
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_providers!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.list_templates!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.compose_post!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(byName.delete_template!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.delete_template!.description).toMatch(/confirm/i);
    expect(byName.delete_brand!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.delete_brand!.description).toMatch(/confirm/i);
    for (const name of ['get_template', 'get_brand', 'list_brands']) expect(byName[name]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.compose_custom!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(byName.compose_custom!.description).toMatch(/\{\{brand\.color/);
    expect(byName.compose_custom!.description).toMatch(/data-fit/);
    expect(byName.compose_post!.inputSchema.required).toEqual(['format']);
    expect(byName.compose_post!.description).toMatch(/never ask an AI image model/i);
    // field docs reach the model
    expect(byName.compose_post!.inputSchema.properties.texts.properties.headline.description).toMatch(/SHORT/);
    expect(byName.compose_post!.inputSchema.properties.template.description).toMatch(/quote-card.*split.*minimal-badge/);
    expect(byName.compose_post!.inputSchema.properties.format.enum).toEqual(['square', 'portrait', 'story', 'landscape', 'link']);
  });

  it('list_providers reports availability from keys, the catalog and the quota; never a key', async () => {
    const result = await callTool(server.url, TEST_TOKEN, 'list_providers', {});
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).not.toContain('fake-gemini-key-do-not-leak');
    const data = JSON.parse(text);
    const byId = Object.fromEntries(data.providers.map((p: any) => [p.id, p]));
    expect(byId.gemini.available).toBe(true);
    expect(byId.fal.available).toBe(false);
    expect(byId.leonardo.available).toBe(false);
    expect(byId.gemini.models.map((m: any) => m.id)).toEqual(['gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-3-pro-image']);
    expect(byId.gemini.models[0]).toMatchObject({ default_for: ['generate', 'edit', 'text'], can: { draw_text_in_image: true }, prices_verified_on: '2026-10-10' });
    expect(byId.leonardo.models[0].cost_is_estimate).toBe(true);
    expect(byId.fal.models[0].price.approx_usd_per_image).toBeGreaterThan(0);
    expect(data.today).toMatchObject({ images_left: 30, image_limit: 30, budget_left_usd: 3, budget_limit_usd: 3, composed_graphics_limit: 6 });
    expect(data.status).toMatch(/not enabled/);
  });

  it('list_templates describes the built-in templates, all formats and the headline hints; supports a format filter', async () => {
    const data = jsonOf(await callTool(server.url, TEST_TOKEN, 'list_templates', {}));
    expect(data.templates.map((t: any) => t.id)).toEqual(['photo-headline', 'cta-card', 'quote-card', 'split', 'minimal-badge', 'carousel-cover', 'carousel-point', 'carousel-end']);
    const photo = data.templates[0];
    expect(photo.texts.required).toEqual(['headline']);
    expect(photo.texts.optional).toEqual(['eyebrow', 'body', 'footer']);
    expect(Object.keys(photo.formats)).toEqual(['square', 'portrait', 'story', 'landscape', 'link']);
    expect(photo.formats.story).toMatchObject({ width: 1080, height: 1920 });
    expect(photo.formats.square.headline_max_chars_approx).toBeGreaterThan(20);
    const only = jsonOf(await callTool(server.url, TEST_TOKEN, 'list_templates', { format: 'link' }));
    expect(Object.keys(only.templates[1].formats)).toEqual(['link']);
    expect(only.templates[1].texts.optional).toContain('cta');
  });

  it('compose_post returns a public URL, a small JPEG preview and the warnings', async () => {
    const result = await callTool(server.url, TEST_TOKEN, 'compose_post', {
      template: 'photo-headline',
      format: 'square',
      background: { image_url: 'https://assets.example.test/photo.jpg' },
      texts: { eyebrow: 'Nueva temporada', headline: 'Café de especialidad', body: 'Ven a probar el menú de otoño.' },
      brand: { colors: { primary: '#14213d', accent: '#fca311' } },
    });
    expect(result.isError).toBeUndefined();
    const data = jsonOf(result);
    expect(data).toMatchObject({ width: 1080, height: 1080, format: 'square', template: 'photo-headline', output: 'jpg', needs_attention: false });
    expect(data.url).toMatch(/^https:\/\/images\.example\.test\/i\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(data.warnings).toEqual([]);
    expect(fetched).toContain('https://assets.example.test/photo.jpg');

    const image = result.content.find((c) => c.type === 'image')!;
    expect(image.mimeType).toBe('image/jpeg');
    const preview = Buffer.from(image.data, 'base64');
    expect(preview.length).toBeLessThanOrEqual(90 * 1024);
    const meta = await sharp(preview).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768);

    // The stored file is served from /i/ with the right size.
    const path = new URL(data.url).pathname;
    const served = await rawRequest(server.url, 'GET', path);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    const servedMeta = await sharp(served.body).metadata();
    expect(servedMeta).toMatchObject({ width: 1080, height: 1080, format: 'jpeg' });
  });

  it('compose_post works with only a color and returns PNG for flat backgrounds', async () => {
    const result = await callTool(server.url, TEST_TOKEN, 'compose_post', {
      template: 'cta-card',
      format: 'story',
      texts: { headline: 'Reserva tu mesa', cta: 'Reservar ahora' },
    });
    const data = jsonOf(result);
    expect(data).toMatchObject({ width: 1080, height: 1920, output: 'png' });
    const served = await rawRequest(server.url, 'GET', new URL(data.url).pathname);
    expect(served.headers['content-type']).toBe('image/png');
    expect((await sharp(served.body).metadata()).height).toBe(1920);
  });

  it('a too-long headline comes back flagged so the model asks for a shorter one', async () => {
    const result = await callTool(server.url, TEST_TOKEN, 'compose_post', {
      template: 'photo-headline',
      format: 'square',
      texts: { headline: 'Este titular es muchisimo mas largo de lo que cualquier imagen cuadrada podria mostrar de forma legible y clara' },
    });
    const data = jsonOf(result);
    expect(data.needs_attention).toBe(true);
    expect(data.warnings.map((w: { code: string }) => w.code)).toContain('headline_too_long');
    expect(data.next_step).toMatch(/Do not use this image/);
  });

  it('input validation errors are plain tool errors, not protocol errors', async () => {
    const bad = await callTool(server.url, TEST_TOKEN, 'compose_post', { template: 'nope', format: 'square', texts: { headline: 'Hola' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/no template called "nope"/i);
    const badFormat = await callTool(server.url, TEST_TOKEN, 'compose_post', { template: 'cta-card', format: 'huge', texts: { headline: 'Hola' } });
    expect(badFormat.isError).toBe(true);
    expect(textOf(badFormat)).toMatch(/validation/i);
    const missing = await callTool(server.url, TEST_TOKEN, 'compose_post', { template: 'cta-card', format: 'square', texts: {} });
    expect(missing.isError).toBe(true);
  });

  it('two backgrounds at once are refused with a clear message', async () => {
    const result = await callTool(server.url, TEST_TOKEN, 'compose_post', {
      template: 'cta-card',
      format: 'square',
      texts: { headline: 'Hola' },
      background: { color: '#112233', image_url: 'https://assets.example.test/photo.jpg' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/only one background/i);
  });

  it('internal failures are generic to the user and detailed only in the log', async () => {
    const result = await callTool(server.url, TEST_TOKEN, 'compose_post', {
      template: 'photo-headline',
      format: 'square',
      texts: { headline: 'Hola' },
      background: { image_url: 'https://assets.example.test/boom.jpg' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('kaboom');
    expect(textOf(result)).toMatch(/Something went wrong/);
    const entry = server.logs.find((l) => l.msg === 'tool_call' && l.outcome === 'error');
    expect(entry).toMatchObject({ tool: 'compose_post', user: 'alice', error_code: 'internal' });
    expect(String(entry?.error_message)).toContain('kaboom');
  });

  it('logs one structured line per call without prompts or tokens', async () => {
    const calls = server.logs.filter((l) => l.msg === 'tool_call' && l.tool === 'compose_post' && l.outcome === 'ok');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).toMatchObject({ user: 'alice', template: expect.any(String), format: expect.any(String), ms: expect.any(Number) });
      expect(JSON.stringify(c)).not.toMatch(/Reserva tu mesa|especialidad|TEST|testtoken/);
    }
  });

  it('enforces DAILY_RENDER_LIMIT per user and lists the remaining count', async () => {
    const args = { template: 'cta-card', format: 'square', texts: { headline: 'Hola' } };
    // alice already used some renders above; bob has his own counter
    let refused: Awaited<ReturnType<typeof callTool>> | undefined;
    for (let i = 0; i < 10 && !refused; i += 1) {
      const r = await callTool(server.url, TEST_TOKEN, 'compose_post', args);
      if (r.isError && /limit of 6/.test(textOf(r))) refused = r;
    }
    expect(refused).toBeDefined();
    expect(textOf(refused!)).toMatch(/00:00 UTC/);
    const providers = jsonOf(await callTool(server.url, TEST_TOKEN, 'list_providers', {}));
    expect(providers.today.composed_graphics_left).toBe(0);
    // another user is unaffected
    const bob = await callTool(server.url, 'othertoken-fedcba9876543210', 'compose_post', args);
    expect(bob.isError).toBeUndefined();
  });
});

describe('SSRF protection through the real tool', () => {
  it('compose_post refuses private and non-https image links with a plain message', async () => {
    const server = await startTestServer({ overrides: { fetchImage: async (url: string) => (await fetchSafe(url, { kind: 'image', allowInsecureLocalhost: false })).data } });
    try {
      for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/a.png', 'https://10.0.0.1/a.png', 'http://example.com/a.png']) {
        const r = await callTool(server.url, TEST_TOKEN, 'compose_post', { template: 'photo-headline', format: 'square', texts: { headline: 'Hola' }, background: { image_url: url } });
        expect(r.isError, url).toBe(true);
        expect(textOf(r)).toMatch(/cannot be used/);
      }
    } finally {
      await server.close();
    }
  });

  it('compose_custom assets and save_brand logos/fonts go through the same guard', async () => {
    const server = await startTestServer({
      overrides: {
        fetchImage: async (url: string, opts?: { svg?: boolean }) => (await fetchSafe(url, { kind: 'image', allowInsecureLocalhost: false, allowSvg: opts?.svg === true })).data,
        fetchFont: async (url: string) => (await fetchSafe(url, { kind: 'font', allowInsecureLocalhost: false })).data,
      },
    });
    try {
      for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/a.png', 'https://10.0.0.1/a.png', 'http://example.com/a.png']) {
        const custom = await callTool(server.url, TEST_TOKEN, 'compose_custom', { format: 'square', html: '<div style="display:flex;width:{{format.width}}px;height:{{format.height}}px"><img src="{{asset.x}}" /></div>', assets: { x: url } });
        expect(custom.isError, url).toBe(true);
        expect(textOf(custom), url).toMatch(/asset "x".*cannot be used/);
        const brand = await callTool(server.url, TEST_TOKEN, 'save_brand', {
          slug: 'ssrf',
          display_name: 'SSRF',
          colors: { primary: '#112233', accent: '#ffaa00', ink: '#000000', paper: '#ffffff' },
          fonts: { heading: 'Outfit', body: 'Work Sans' },
          logos: { primary: url },
        });
        expect(brand.isError, url).toBe(true);
        expect(textOf(brand), url).toMatch(/cannot be used/);
        const font = await callTool(server.url, TEST_TOKEN, 'save_brand', {
          slug: 'ssrf',
          display_name: 'SSRF',
          colors: { primary: '#112233', accent: '#ffaa00', ink: '#000000', paper: '#ffffff' },
          fonts: { heading: 'Evil', body: 'Work Sans' },
          font_files: [{ family: 'Evil', weight: 400, style: 'normal', url }],
        });
        expect(font.isError, url).toBe(true);
        expect(textOf(font), url).toMatch(/cannot be used/);
      }
      const none = await callTool(server.url, TEST_TOKEN, 'list_brands', {});
      expect(JSON.parse(textOf(none)).brands).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
