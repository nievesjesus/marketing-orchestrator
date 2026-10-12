import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextOverrides } from '../src/context.js';
import { OTHER_TOKEN, TEST_TOKEN, callTool, makePhoto, startTestServer } from './helpers.js';
import { FAKE_KEYS, MockFetch, imageResponse, jsonResponse, tinyPng } from './providerMocks.js';
import { POSTIZ_ENV, POSTIZ_KEY, POSTIZ_UPLOAD_URL, postizMock } from './postizMock.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

const textOf = (result: { content: { type: string; text?: string }[] }): string => result.content.find((c) => c.type === 'text')?.text ?? '';
const jsonOf = (result: { content: { type: string; text?: string }[] }): any => JSON.parse(textOf(result));

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

async function start(
  mock: ReturnType<typeof postizMock>,
  extra: Record<string, string> = {},
  overrides: ContextOverrides = {},
): Promise<Server> {
  const s = await startTestServer({
    configExtra: { ...POSTIZ_ENV, POSTIZ_ALLOW_IN_HTTP: 'true', ...extra },
    overrides: { postizFetch: mock.fetch, ...overrides },
  });
  servers.push(s);
  return s;
}

const CARD = { template: 'cta-card', format: 'square', texts: { headline: 'Open late' }, background: { color: '#1F3A5F' } } as const;

describe('automatic Postiz upload', () => {
  it('compose_post uploads the finished image and returns postiz {id, path}', async () => {
    const mock = postizMock();
    const s = await start(mock);
    const result = await callTool(s.url, TEST_TOKEN, 'compose_post', CARD);
    expect(result.isError).toBeUndefined();
    const data = jsonOf(result);

    expect(data.postiz).toEqual({ id: 'media-1', path: 'https://uploads.postiz.test/media-1.png' });
    expect(data.postiz_error).toBeUndefined();
    expect(data.next_step).toMatch(/postiz\.path/);
    expect(data.next_step).toMatch(/skip uploadFromUrlTool/);
    expect(data.url).toMatch(/^https:\/\/images\.example\.test\/i\//); // the public link is still there
    expect(data.file_path).toBeUndefined(); // HTTP mode never exposes server paths

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.url).toBe(POSTIZ_UPLOAD_URL);
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(POSTIZ_KEY);
    expect(call.fieldNames).toEqual(['file']);
    expect(call.fileType).toBe('image/png');
    expect(call.fileName).toMatch(/^[0-9a-f-]{36}\.png$/);
    // the uploaded bytes are exactly the stored image
    const key = s.ctx.storage.keyForUrl(data.url)!;
    expect(call.bytes.equals(await readFile(s.ctx.storage.localPath(key)!))).toBe(true);
  });

  it('the key never appears in a result or in the logs', async () => {
    const mock = postizMock();
    const s = await start(mock);
    const ok = await callTool(s.url, TEST_TOKEN, 'compose_post', CARD);
    const failing = postizMock(() => new Response(`echo ${POSTIZ_KEY}`, { status: 401 }));
    const s2 = await start(failing);
    const bad = await callTool(s2.url, TEST_TOKEN, 'compose_post', CARD);
    for (const text of [textOf(ok), textOf(bad), s.rawLogs.join('\n'), s2.rawLogs.join('\n')]) expect(text).not.toContain(POSTIZ_KEY);
  });

  it('upload_to_postiz=false skips it; POSTIZ_AUTO_UPLOAD=false turns the automatic upload off (an explicit true still uploads)', async () => {
    const mock = postizMock();
    const s = await start(mock);
    const skipped = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', { ...CARD, upload_to_postiz: false }));
    expect(skipped.postiz).toBeUndefined();
    expect(skipped.next_step).toMatch(/Postiz uploadFromUrlTool/);
    expect(mock.calls).toHaveLength(0);

    const manual = postizMock();
    const s2 = await start(manual, { POSTIZ_AUTO_UPLOAD: 'false' });
    expect(jsonOf(await callTool(s2.url, TEST_TOKEN, 'compose_post', CARD)).postiz).toBeUndefined();
    expect(manual.calls).toHaveLength(0);
    expect(jsonOf(await callTool(s2.url, TEST_TOKEN, 'compose_post', { ...CARD, upload_to_postiz: true })).postiz.id).toBe('media-1');
    expect(manual.calls).toHaveLength(1);
  });

  it('a Postiz failure never fails the tool: the image comes back with a postiz_error warning', async () => {
    const mock = postizMock(() => new Response('nope', { status: 500 }));
    const s = await start(mock);
    const result = await callTool(s.url, TEST_TOKEN, 'compose_post', CARD);
    expect(result.isError).toBeUndefined();
    const data = jsonOf(result);
    expect(data.url).toMatch(/\/i\//);
    expect(data.postiz).toBeUndefined();
    expect(data.postiz_error).toMatch(/server error \(HTTP 500\)/);
    expect(data.next_step).toMatch(/uploadFromUrlTool/);
    expect(result.content.some((c: { type: string }) => c.type === 'image')).toBe(true); // the preview is still returned
  });

  it('retries once on a 429 (honouring Retry-After) and then succeeds', async () => {
    const mock = postizMock((n) =>
      n === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(JSON.stringify({ id: 'media-2', name: 'x', path: 'https://uploads.postiz.test/media-2.png' }), { status: 200 }),
    );
    const s = await start(mock);
    const data = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', CARD));
    expect(mock.calls).toHaveLength(2);
    expect(data.postiz).toEqual({ id: 'media-2', path: 'https://uploads.postiz.test/media-2.png' });
    expect(data.postiz_error).toBeUndefined();
  });

  it('does not auto-upload a draft that needs attention, unless the call says true', async () => {
    const mock = postizMock();
    const s = await start(mock);
    const tooLong = {
      template: 'photo-headline',
      format: 'square',
      texts: { headline: 'Este titular es muchisimo mas largo de lo que cualquier imagen cuadrada podria mostrar de forma legible y clara' },
    };
    const draft = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', tooLong));
    expect(draft.needs_attention).toBe(true);
    expect(draft.postiz).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
    const forced = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', { ...tooLong, upload_to_postiz: true }));
    expect(forced.postiz.id).toBe('media-1');
  });

  it('compose_custom uploads too', async () => {
    const mock = postizMock();
    const s = await start(mock);
    const html = `<div style="display:flex;width:{{format.width}}px;height:{{format.height}}px;background:#1F3A5F"></div>`;
    const data = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_custom', { format: 'square', html }));
    expect(data.postiz.path).toBe('https://uploads.postiz.test/media-1.png');
    expect(mock.calls).toHaveLength(1);
  });

  it('compose_carousel uploads each slide in order and lists postiz_paths', async () => {
    const mock = postizMock();
    const s = await start(mock);
    const data = jsonOf(
      await callTool(s.url, TEST_TOKEN, 'compose_carousel', {
        format: 'square',
        slides: [{ texts: { headline: 'One' } }, { texts: { headline: 'Two' } }, { texts: { headline: 'Three' } }],
      }),
    );
    expect(mock.calls).toHaveLength(3);
    expect(data.slides.map((x: any) => x.postiz.id)).toEqual(['media-1', 'media-2', 'media-3']);
    expect(data.postiz_paths).toEqual([1, 2, 3].map((i) => `https://uploads.postiz.test/media-${i}.png`));
    expect(data.next_step).toMatch(/postiz\.path/);
  });

  it('generate_image does NOT upload by default (it is usually a background); upload_to_postiz=true uploads each picture', async () => {
    const mock = postizMock();
    const providers = new MockFetch();
    const photo = (await makePhoto(1200, 900)).toString('base64');
    providers.route(':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo } }] }, finishReason: 'STOP' }] }));
    const s = await start(mock, { GEMINI_API_KEY: FAKE_KEYS.gemini }, { providerFetch: providers.fetch });

    const byDefault = jsonOf(await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake at sunrise, soft mist' }));
    expect(byDefault.status).toBe('done');
    expect(byDefault.images[0].postiz).toBeUndefined();
    expect(byDefault.images[0].postiz_error).toBeUndefined();
    expect(byDefault.images[0].url).toMatch(/\/i\//);
    expect(byDefault.next_step).not.toMatch(/postiz\.path/);
    expect(mock.calls).toHaveLength(0);

    const explicitFalse = jsonOf(await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake at sunrise, soft mist', upload_to_postiz: false }));
    expect(explicitFalse.images[0].postiz).toBeUndefined();
    expect(mock.calls).toHaveLength(0);

    const data = jsonOf(await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake at sunrise, soft mist', upload_to_postiz: true }));
    expect(data.images[0].postiz).toEqual({ id: 'media-1', path: 'https://uploads.postiz.test/media-1.png' });
    expect(data.images[0].url).toMatch(/\/i\//);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.fileType).toBe('image/jpeg');
    expect(data.next_step).toMatch(/postiz\.path/);
  });

  it('edit_image does NOT upload by default; upload_to_postiz=true does', async () => {
    const mock = postizMock();
    const providers = new MockFetch();
    const photo = (await makePhoto(1200, 900)).toString('base64');
    providers.route(':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo } }] }, finishReason: 'STOP' }] }));
    const s = await start(mock, { GEMINI_API_KEY: FAKE_KEYS.gemini }, { providerFetch: providers.fetch, fetchImage: async () => makePhoto(800, 600) });
    const args = { image_url: 'https://photos.example.test/shop.jpg', instruction: 'make the light warmer' };

    const byDefault = jsonOf(await callTool(s.url, TEST_TOKEN, 'edit_image', args));
    expect(byDefault.status).toBe('done');
    expect(byDefault.images[0].postiz).toBeUndefined();
    expect(mock.calls).toHaveLength(0);

    const forced = jsonOf(await callTool(s.url, TEST_TOKEN, 'edit_image', { ...args, upload_to_postiz: true }));
    expect(forced.images[0].postiz.id).toBe('media-1');
    expect(mock.calls).toHaveLength(1);
  });

  it('get_job does NOT upload by default; upload_to_postiz=true does', async () => {
    const mock = postizMock();
    const providers = new MockFetch();
    const png = await tinyPng();
    let finished = false;
    providers.route('queue.fal.run/fal-ai/', () => jsonResponse(200, { request_id: 'r', status_url: 'https://queue.fal.run/fal-ai/x/requests/r/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/r' }), 'POST');
    providers.route('/requests/r/status', () => jsonResponse(200, { status: finished ? 'COMPLETED' : 'IN_PROGRESS' }));
    providers.route('/requests/r', () => jsonResponse(200, { images: [{ url: 'https://v3.fal.media/o.png' }], description: '' }));
    providers.route('v3.fal.media', () => imageResponse(png));
    const s = await start(mock, { FAL_KEY: FAKE_KEYS.fal, SYNC_WAIT_MS: '1000' }, { providerFetch: providers.fetch });

    const started = jsonOf(await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a lighthouse', provider: 'fal' }));
    expect(started.status).toBe('pending');
    finished = true;
    const byDefault = jsonOf(await callTool(s.url, TEST_TOKEN, 'get_job', { job_id: started.job_id }));
    expect(byDefault.status).toBe('done');
    expect(byDefault.images[0].postiz).toBeUndefined();
    expect(mock.calls).toHaveLength(0);

    const forced = jsonOf(await callTool(s.url, TEST_TOKEN, 'get_job', { job_id: started.job_id, upload_to_postiz: true }));
    expect(forced.images[0].postiz.id).toBe('media-1');
    expect(mock.calls).toHaveLength(1);
  }, 30_000);

  it('a failed upload requested for generate_image only adds a postiz_error warning', async () => {
    const mock = postizMock(() => new Response('nope', { status: 500 }));
    const providers = new MockFetch();
    const photo = (await makePhoto(1200, 900)).toString('base64');
    providers.route(':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo } }] }, finishReason: 'STOP' }] }));
    const s = await start(mock, { GEMINI_API_KEY: FAKE_KEYS.gemini }, { providerFetch: providers.fetch });
    const result = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake at sunrise, soft mist', upload_to_postiz: true });
    expect(result.isError).toBeUndefined();
    const data = jsonOf(result);
    expect(data.images[0].postiz).toBeUndefined();
    expect(data.images[0].postiz_error).toMatch(/server error \(HTTP 500\)/);
    expect(data.images[0].url).toMatch(/\/i\//);
  });
});

describe('HTTP mode without POSTIZ_ALLOW_IN_HTTP (the key is single-tenant)', () => {
  it('ignores the credentials: no upload, explicit requests get a clear warning, the tool explains', async () => {
    const mock = postizMock();
    const s = await startTestServer({ configExtra: { ...POSTIZ_ENV }, overrides: { postizFetch: mock.fetch } });
    servers.push(s);
    expect(s.ctx.config.postiz?.enabled).toBe(false);
    expect(s.ctx.postiz).toBeNull();

    expect(jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', CARD)).postiz).toBeUndefined();
    const asked = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', { ...CARD, upload_to_postiz: true }));
    expect(asked.postiz).toBeUndefined();
    expect(asked.postiz_error).toMatch(/POSTIZ_ALLOW_IN_HTTP/);

    const tool = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', { url: asked.url });
    expect(tool.isError).toBe(true);
    expect(textOf(tool)).toMatch(/not configured/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('upload_to_postiz', () => {
  it('uploads an image the caller made, once: a second call returns the cached copy without using the rate limit', async () => {
    const mock = postizMock();
    const s = await start(mock, { POSTIZ_AUTO_UPLOAD: 'false' });
    const made = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', CARD));
    expect(made.postiz).toBeUndefined();

    const first = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', { url: made.url });
    expect(first.isError).toBeUndefined();
    expect(jsonOf(first)).toMatchObject({ id: 'media-1', path: 'https://uploads.postiz.test/media-1.png', postiz: { id: 'media-1' }, already_uploaded: false });
    expect(jsonOf(first).next_step).toMatch(/skip uploadFromUrlTool/);

    const again = jsonOf(await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', { url: made.url }));
    expect(again).toMatchObject({ id: 'media-1', already_uploaded: true });
    expect(mock.calls).toHaveLength(1);

    // an auto-upload afterwards reuses the copy too
    const composeAgain = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', { ...CARD, upload_to_postiz: true }));
    expect(composeAgain.postiz.id).toBe('media-2'); // a NEW image gets its own upload
    expect(mock.calls).toHaveLength(2);
  });

  it('accepts the server-side file path as well as the url', async () => {
    const mock = postizMock();
    const s = await start(mock, { POSTIZ_AUTO_UPLOAD: 'false' });
    const made = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', CARD));
    const filePath = s.ctx.storage.localPath(s.ctx.storage.keyForUrl(made.url)!)!;
    const result = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', { file_path: filePath });
    expect(jsonOf(result).id).toBe('media-1');
  });

  it('ownership: another user cannot upload my image, and the answer does not reveal that it exists', async () => {
    const mock = postizMock();
    const s = await start(mock, { POSTIZ_AUTO_UPLOAD: 'false' });
    const alices = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', CARD));

    const stolen = await callTool(s.url, OTHER_TOKEN, 'upload_to_postiz', { url: alices.url });
    expect(stolen.isError).toBe(true);
    expect(textOf(stolen)).toMatch(/No image made for you/);

    const unknown = await callTool(s.url, OTHER_TOKEN, 'upload_to_postiz', { url: 'https://images.example.test/i/2026/10/00000000-0000-4000-8000-000000000000.png' });
    expect(textOf(unknown)).toBe(textOf(stolen)); // same answer for "not yours" and "does not exist"
    expect(mock.calls).toHaveLength(0);

    const mine = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', { url: alices.url });
    expect(mine.isError).toBeUndefined();
    expect(mock.calls).toHaveLength(1);
  });

  it('refuses anything that is not an image this server made', async () => {
    const mock = postizMock();
    const s = await start(mock);
    const made = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', { ...CARD, upload_to_postiz: false }));
    const key = s.ctx.storage.keyForUrl(made.url)!;
    const root = s.ctx.storage.localPath(key)!.slice(0, s.ctx.storage.localPath(key)!.indexOf('/images/') + '/images'.length);
    const attempts: Record<string, string>[] = [
      { url: 'https://example.com/photo.png' },
      { url: 'http://169.254.169.254/latest/meta-data' },
      { file_path: '/etc/passwd' },
      { file_path: `${root}/../app.db` },
      { file_path: `${root}/2026/10/../../app.db` },
      { file_path: 'relative/path.png' },
      { url: `file://${root}/../app.db` },
    ];
    for (const args of attempts) {
      const res = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(res), JSON.stringify(args)).toMatch(/No image made for you/);
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('needs exactly one of url or file_path', async () => {
    const s = await start(postizMock());
    const none = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/exactly one/);
    const both = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', { url: 'https://x.test/a.png', file_path: '/a.png' });
    expect(textOf(both)).toMatch(/exactly one/);
  });

  it('a Postiz failure is a clear tool error (this tool exists to upload) without the key', async () => {
    const mock = postizMock(() => new Response(`bad ${POSTIZ_KEY}`, { status: 401 }));
    const s = await start(mock, { POSTIZ_AUTO_UPLOAD: 'false' });
    const made = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', CARD));
    const res = await callTool(s.url, TEST_TOKEN, 'upload_to_postiz', { url: made.url });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rejected the API key/);
    expect(textOf(res)).not.toContain(POSTIZ_KEY);
    expect(s.rawLogs.join('\n')).not.toContain(POSTIZ_KEY);
  });

  it('is advertised with a description that points at postiz.path and the rate limit', async () => {
    const s = await start(postizMock());
    const { rpc } = await import('./helpers.js');
    const list = await rpc(s.url, TEST_TOKEN, 'tools/list');
    const tool = (list.json.result.tools as any[]).find((t) => t.name === 'upload_to_postiz');
    expect(tool.description).toMatch(/postiz\.path/);
    expect(tool.description).toMatch(/30 requests per hour/);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    const init = await rpc(s.url, TEST_TOKEN, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v', version: '0' } });
    expect(init.json.result.instructions).toMatch(/postiz\.path/);
    expect(init.json.result.instructions).toMatch(/skip uploadFromUrlTool/);
  });
});
