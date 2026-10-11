import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { configSecrets } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { RATIOS } from '../src/models.js';
import { createHttpServer } from '../src/server.js';
import { OTHER_TOKEN, TEST_TOKEN, callTool, fonts, makePhoto, rawRequest, rpc, testConfig, tmpDir } from './helpers.js';
import { FAKE_KEYS, MockFetch, imageResponse, jsonResponse, tinyPng } from './providerMocks.js';

interface ImageServer {
  url: string;
  ctx: AppContext;
  mock: MockFetch;
  rawLogs: string[];
  close(): Promise<void>;
}

const servers: ImageServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

async function startImageServer(
  options: { env?: Record<string, string>; mask?: boolean } = {},
): Promise<ImageServer> {
  const { dir, cleanup } = tmpDir();
  const config = testConfig(dir, { GEMINI_API_KEY: FAKE_KEYS.gemini, FAL_KEY: FAKE_KEYS.fal, LEONARDO_API_KEY: FAKE_KEYS.leonardo, ...options.env });
  const rawLogs: string[] = [];
  // mask:false proves that the code itself never writes a key; the logger's safety net is not what is being tested
  const logger = createLogger({ sink: (line) => rawLogs.push(line), secrets: options.mask === false ? [] : configSecrets(config) });
  const mock = new MockFetch();
  const ctx = createContext(config, logger, { fonts: fonts(), providerFetch: mock.fetch, fetchImage: async () => tinyPng() });
  const running = createHttpServer(ctx);
  await new Promise<void>((resolve) => running.server.listen(0, '127.0.0.1', resolve));
  const { port } = running.server.address() as AddressInfo;
  const server: ImageServer = {
    url: `http://127.0.0.1:${port}`,
    ctx,
    mock,
    rawLogs,
    async close() {
      await running.close();
      ctx.ledger.close();
      cleanup();
    },
  };
  servers.push(server);
  return server;
}

const textOf = (result: { content: { type: string; text?: string }[] }): string => result.content.find((c) => c.type === 'text')?.text ?? '';
const jsonOf = (result: { content: { type: string; text?: string }[] }): any => JSON.parse(textOf(result));
const imagesOf = (result: { content: { type: string }[] }) => result.content.filter((c) => c.type === 'image') as unknown as { data: string; mimeType: string }[];

async function geminiPhoto(mock: MockFetch, size = 1200): Promise<void> {
  const photo = (await makePhoto(size, Math.round(size * 0.75))).toString('base64');
  mock.route(':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo } }] }, finishReason: 'STOP' }] }));
}

describe('tool registration (DESIGN section 5)', () => {
  it('registers generate_image, edit_image, get_job and estimate_cost with titles, hints and LLM-oriented descriptions', async () => {
    const s = await startImageServer();
    const res = await rpc(s.url, TEST_TOKEN, 'tools/list');
    const tools = res.json.result.tools as { name: string; title?: string; description: string; annotations: Record<string, boolean>; inputSchema: any }[];
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['generate_image', 'edit_image', 'get_job', 'estimate_cost']) {
      const t = byName[name]!;
      expect(t, name).toBeDefined();
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.title!.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(200);
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(byName.estimate_cost!.annotations.readOnlyHint).toBe(true);
    expect(byName.generate_image!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.generate_image!.description).toMatch(/COSTS MONEY/);
    expect(byName.generate_image!.description).toMatch(/only after they say OK/);
    expect(byName.generate_image!.description).toMatch(/get_job/);
    expect(byName.generate_image!.description).toMatch(/compose_post/);
    expect(byName.generate_image!.inputSchema.required).toEqual(['prompt']);
    expect(byName.generate_image!.inputSchema.properties.aspect_ratio.enum).toEqual([...RATIOS]);
    expect(byName.generate_image!.inputSchema.properties.num_images).toMatchObject({ minimum: 1, maximum: 4 });
    expect(byName.generate_image!.inputSchema.properties.provider.enum).toEqual(['auto', 'gemini', 'fal', 'leonardo']);
    expect(byName.generate_image!.inputSchema.properties.leave_space.enum).toEqual(['top', 'bottom', 'left', 'right']);
    expect(Object.keys(byName.generate_image!.inputSchema.properties)).toEqual(
      expect.arrayContaining(['prompt', 'provider', 'model', 'aspect_ratio', 'size', 'num_images', 'negative_prompt', 'style', 'text_on_image', 'reference_image_urls', 'seed', 'leave_space']),
    );
    expect(byName.edit_image!.inputSchema.required).toEqual(['image_url', 'instruction']);
    expect(byName.get_job!.inputSchema.required).toEqual(['job_id']);
  });
});

describe('generate_image', () => {
  it('returns urls, sizes, provider, model, cost and small JPEG previews; the file is served from our /i/ route', async () => {
    const s = await startImageServer();
    await geminiPhoto(s.mock);
    const result = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake at sunrise, soft mist', aspect_ratio: '4:5', leave_space: 'top' });
    expect(result.isError).toBeUndefined();
    const data = jsonOf(result);

    expect(data).toMatchObject({ status: 'done', provider: 'gemini', model: 'gemini-3.1-flash-image', fallback_from: null, cost_usd: 0.067, cost_is_estimate: false, warnings: [] });
    expect(data.images).toHaveLength(1);
    expect(data.images[0]).toMatchObject({ width: 1200, height: 900, provider: 'gemini', model: 'gemini-3.1-flash-image', cost_usd: 0.067 });
    expect(data.images[0].url).toMatch(/^https:\/\/images\.example\.test\/i\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(data.images_left_today).toBe(29);
    expect(data.next_step).toMatch(/compose_post/);

    const previews = imagesOf(result);
    expect(previews).toHaveLength(1);
    expect(previews[0]!.mimeType).toBe('image/jpeg');
    const preview = Buffer.from(previews[0]!.data, 'base64');
    expect(preview.length).toBeLessThanOrEqual(90 * 1024);
    const meta = await sharp(preview).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(768);

    const served = await rawRequest(s.url, 'GET', new URL(data.images[0].url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');

    // the prompt reached the provider with the hints, the key only in the header
    const call = s.mock.callsTo(':generateContent')[0]!;
    expect(call.body.contents[0].parts[0].text).toContain('a calm lake at sunrise, soft mist');
    expect(call.body.contents[0].parts[0].text).toContain('Keep the top area calm, no text.');
    expect(call.body.contents[0].parts[0].text).toContain('No text, letters, logos or watermarks.');
    expect(call.body.generationConfig.imageConfig.aspectRatio).toBe('4:5');
  });

  it('four images share ONE preview budget of 90 KB', async () => {
    const s = await startImageServer();
    await geminiPhoto(s.mock, 1600);
    const result = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a busy market street, many details', num_images: 4 });
    const data = jsonOf(result);
    expect(data.images).toHaveLength(4);
    expect(data.cost_usd).toBe(0.268);
    const previews = imagesOf(result);
    expect(previews).toHaveLength(4);
    const total = previews.reduce((sum, p) => sum + Buffer.from(p.data, 'base64').length, 0);
    expect(total).toBeLessThanOrEqual(90 * 1024);
  });

  it('reports the fallback in the response', async () => {
    const s = await startImageServer();
    s.mock.route('googleapis.com', () => jsonResponse(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'x' } }));
    s.mock.route('queue.fal.run/fal-ai/', () => jsonResponse(200, { request_id: 'r', status_url: 'https://queue.fal.run/fal-ai/x/requests/r/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/r' }), 'POST');
    s.mock.route('/requests/r/status', () => jsonResponse(200, { status: 'COMPLETED' }));
    s.mock.route('/requests/r', () => jsonResponse(200, { images: [{ url: 'https://v3.fal.media/o.png' }], description: '' }));
    s.mock.route('v3.fal.media', async () => imageResponse(await tinyPng()));
    const data = jsonOf(await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a bowl of ramen, steam' }));
    expect(data).toMatchObject({ provider: 'fal', model: 'fal-ai/nano-banana-2', fallback_from: 'gemini (rate limited)', cost_usd: 0.08 });
  }, 20_000);

  it('refuses real people, minors in sensitive contexts and brands BEFORE any provider call or spending', async () => {
    const s = await startImageServer();
    await geminiPhoto(s.mock);
    for (const [prompt, message] of [
      ['a photo of Taylor Swift holding our coffee', /real, identifiable person/],
      ['a teenage girl in a bikini', /children or teenagers/],
      ['a Nike sneaker on a podium', /logos, brands or characters/],
    ] as const) {
      const result = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt });
      expect(result.isError, prompt).toBe(true);
      expect(textOf(result)).toMatch(message);
    }
    const styled = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake', style: 'in the style of Disney' });
    expect(styled.isError).toBe(true);
    const drawn = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a poster', text_on_image: 'Just do it, Nike' });
    expect(drawn.isError).toBe(true);
    expect(s.mock.calls).toHaveLength(0);
    expect(s.ctx.ledger.quota('alice').images.used).toBe(0);
  });

  it('a provider safety block becomes a plain message and is not retried elsewhere', async () => {
    const s = await startImageServer();
    s.mock.route('googleapis.com', () => jsonResponse(200, { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }));
    const result = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a dramatic street scene' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/declined to make this image for safety reasons/);
    expect(s.mock.calls.every((c) => c.url.includes('googleapis.com'))).toBe(true);
    expect(s.ctx.ledger.quota('alice').images).toMatchObject({ used: 0, reserved: 0 });
  });

  it('over the daily allowance: a plain message, no provider call', async () => {
    const s = await startImageServer({ env: { DAILY_IMAGE_LIMIT: '2' } });
    await geminiPhoto(s.mock);
    const result = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake', num_images: 3 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/2 images; it resets at 00:00 UTC/);
    expect(s.mock.calls).toHaveLength(0);
    // the cap is per person
    const bob = await callTool(s.url, OTHER_TOKEN, 'generate_image', { prompt: 'a calm lake', num_images: 2 });
    expect(bob.isError).toBeUndefined();
  });

  it('a provider that is not set up gives "X isn\'t set up on this server, try Y"', async () => {
    const s = await startImageServer({ env: { LEONARDO_API_KEY: '' } });
    const result = await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a calm lake', provider: 'leonardo' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Leonardo isn't set up on this server, try Gemini or fal\.ai instead\./);
    expect(s.mock.calls).toHaveLength(0);
  });

  it('input validation problems are plain tool errors', async () => {
    const s = await startImageServer();
    for (const args of [{ prompt: 'x' }, { prompt: 'a lake', num_images: 9 }, { prompt: 'a lake', aspect_ratio: '7:5' }, { prompt: 'a lake', provider: 'midjourney' }, {}]) {
      const result = await callTool(s.url, TEST_TOKEN, 'generate_image', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(s.mock.calls).toHaveLength(0);
  });

  it('logs one structured line per call without prompts, keys or tokens', async () => {
    const s = await startImageServer({ mask: false });
    await geminiPhoto(s.mock);
    await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a very secret product launch scene', style: 'warm' });
    const entry = s.rawLogs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'tool_call' && l.tool === 'generate_image')!;
    expect(entry).toMatchObject({ user: 'alice', provider: 'gemini', model: 'gemini-3.1-flash-image', n: 1, outcome: 'ok', cost_usd: 0.067, routing: 'default' });
    expect(entry.ms).toEqual(expect.any(Number));
    const all = s.rawLogs.join('\n');
    expect(all).not.toContain('secret product launch');
    expect(all).not.toContain(TEST_TOKEN);
  });
});

describe('edit_image', () => {
  it('edits a photo: the original is loaded through the SSRF-safe path and sent inline to Gemini', async () => {
    const s = await startImageServer();
    await geminiPhoto(s.mock);
    const result = await callTool(s.url, TEST_TOKEN, 'edit_image', { image_url: 'https://photos.example.test/me.jpg', instruction: 'make the background a sunny beach' });
    const data = jsonOf(result);
    expect(data).toMatchObject({ status: 'done', provider: 'gemini', routing: 'plain_edit' });
    const call = s.mock.callsTo(':generateContent')[0]!;
    expect(call.body.contents[0].parts).toHaveLength(2);
    expect(call.body.contents[0].parts[0].text).toContain('Edit the attached image: make the background a sunny beach');
    expect(call.body.generationConfig.imageConfig).toBeUndefined(); // keeps the photo's own shape
  });

  it('refuses asking for a real person in the edit, but a normal edit of the user\'s own photo is fine', async () => {
    const s = await startImageServer();
    await geminiPhoto(s.mock);
    const refused = await callTool(s.url, TEST_TOKEN, 'edit_image', { image_url: 'https://photos.example.test/me.jpg', instruction: 'add Elon Musk standing next to me' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/real, identifiable person/);
    const ok = await callTool(s.url, TEST_TOKEN, 'edit_image', { image_url: 'https://photos.example.test/me.jpg', instruction: 'make me look more professional, soft light' });
    expect(ok.isError).toBeUndefined();
  });

  it('an unusable photo link is a plain message and nothing is spent', async () => {
    const s = await startImageServer();
    const { fetchSafe } = await import('../src/fetchsafe.js');
    s.ctx.fetchImage = async (url) => (await fetchSafe(url, { kind: 'image', allowInsecureLocalhost: false })).data;
    const result = await callTool(s.url, TEST_TOKEN, 'edit_image', { image_url: 'https://10.0.0.1/photo.jpg', instruction: 'brighten the picture' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cannot be used/);
    expect(s.ctx.ledger.quota('alice').images).toMatchObject({ used: 0, reserved: 0 });
    expect(s.mock.calls).toHaveLength(0);
  });
});

describe('estimate_cost', () => {
  it('quotes the provider the server would use, the total, the fallbacks and whether it fits today\'s allowance', async () => {
    const s = await startImageServer();
    const data = jsonOf(await callTool(s.url, TEST_TOKEN, 'estimate_cost', { num_images: 3, size: '2K' }));
    expect(data.estimate).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-flash-image', size: '2K', per_image_usd: 0.101, total_usd: 0.303, cost_is_estimate: false });
    expect(data.fallbacks.map((f: any) => f.provider)).toEqual(['fal', 'leonardo']);
    expect(data.fallbacks[1]).toMatchObject({ per_image_usd: 0.02, cost_is_estimate: true });
    expect(data).toMatchObject({ fits_allowance: true, routing: 'default', allowance: { images_left_today: 30, budget_left_usd: 3 } });
    expect(data.message).toMatch(/3 images with Nano Banana 2 would cost about US\$0\.30/);
    expect(s.mock.calls).toHaveLength(0); // free
  });

  it('follows the same routing as generate_image for edits, text, named models and fast drafts', async () => {
    const s = await startImageServer();
    const q = async (args: object) => jsonOf(await callTool(s.url, TEST_TOKEN, 'estimate_cost', args));
    expect((await q({ task: 'edit' })).estimate.model).toBe('gemini-3.1-flash-image');
    expect((await q({ text_on_image: true })).fallbacks.map((f: any) => f.provider)).toEqual(['fal']);
    expect((await q({ model: 'phoenix-v1.0', num_images: 4 })).estimate).toMatchObject({ provider: 'leonardo', total_usd: 0.08, cost_is_estimate: true });
    const fast = await q({ prompt: 'quick draft', num_images: 4 });
    expect(fast.estimate).toMatchObject({ model: 'fal-ai/flux/schnell', total_usd: 0.012 });
    expect(fast.routing).toBe('fast_drafts');
    expect((await q({ provider: 'fal' })).fallbacks).toEqual([]);
  });

  it('says plainly when it does not fit what is left today (not an error)', async () => {
    const s = await startImageServer({ env: { DAILY_USD_LIMIT: '0.10' } });
    const data = jsonOf(await callTool(s.url, TEST_TOKEN, 'estimate_cost', { num_images: 2 }));
    expect(data.fits_allowance).toBe(false);
    expect(data.message).toMatch(/would not fit.*resets at 00:00 UTC/);
  });

  it('tells which providers are missing instead of guessing', async () => {
    const s = await startImageServer({ env: { GEMINI_API_KEY: '', FAL_KEY: '', LEONARDO_API_KEY: '' } });
    const result = await callTool(s.url, TEST_TOKEN, 'estimate_cost', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No image provider is set up/);
  });
});

describe('get_job', () => {
  it('finishes a pending job end to end through the tools, and only for its owner', async () => {
    const s = await startImageServer({ env: { SYNC_WAIT_MS: '1000' } });
    const png = await tinyPng();
    let finished = false;
    s.mock.route('queue.fal.run/fal-ai/', () => jsonResponse(200, { request_id: 'r', status_url: 'https://queue.fal.run/fal-ai/x/requests/r/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/r' }), 'POST');
    s.mock.route('/requests/r/status', () => jsonResponse(200, { status: finished ? 'COMPLETED' : 'IN_PROGRESS' }));
    s.mock.route('/requests/r', () => jsonResponse(200, { images: [{ url: 'https://v3.fal.media/o.png' }], description: '' }));
    s.mock.route('v3.fal.media', () => imageResponse(png));

    const started = jsonOf(await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a lighthouse', provider: 'fal' }));
    expect(started).toMatchObject({ status: 'pending', provider: 'fal', retry_after_seconds: 15 });
    expect(started.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.next_step).toMatch(/get_job/);
    expect(s.ctx.ledger.quota('alice')).toMatchObject({ images: { used: 0, reserved: 1 } });

    const foreign = await callTool(s.url, OTHER_TOKEN, 'get_job', { job_id: started.job_id });
    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toMatch(/No job with that id was found for you/);

    finished = true;
    const done = await callTool(s.url, TEST_TOKEN, 'get_job', { job_id: started.job_id });
    expect(done.isError).toBeUndefined();
    const data = jsonOf(done);
    expect(data).toMatchObject({ status: 'done', provider: 'fal', cost_usd: 0.08 });
    expect(data.images[0].url).toMatch(/^https:\/\/images\.example\.test\/i\//);
    expect(imagesOf(done)).toHaveLength(1); // previews work for a job collected now...

    const again = await callTool(s.url, TEST_TOKEN, 'get_job', { job_id: started.job_id });
    expect(jsonOf(again).images[0].url).toBe(data.images[0].url);
    expect(imagesOf(again)).toHaveLength(1); // ...and later, read back from storage
    expect(s.ctx.ledger.quota('alice')).toMatchObject({ images: { used: 1, reserved: 0 } });
  }, 30_000);

  it('an unknown job id is a plain message', async () => {
    const s = await startImageServer();
    const result = await callTool(s.url, TEST_TOKEN, 'get_job', { job_id: '00000000-0000-0000-0000-000000000000' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/kept for 24 hours/);
  });
});

describe('secrets never leave the server (DESIGN section 10)', () => {
  it('no tool output and no log line ever contains a provider key, even when upstream errors echo it', async () => {
    const s = await startImageServer({ mask: false });
    const echo = (label: string) => `${label} failed for key ${FAKE_KEYS.gemini} / ${FAKE_KEYS.fal} / ${FAKE_KEYS.leonardo} via https://user:${FAKE_KEYS.fal}@evil.example.test/x?key=${FAKE_KEYS.gemini}`;
    const outputs: string[] = [];
    const collect = (r: { content: { type: string; text?: string }[] }) => outputs.push(r.content.map((c) => c.text ?? '').join('\n'));
    const run = async (name: string, args: object) => {
      const r = await callTool(s.url, TEST_TOKEN, name, args);
      collect(r);
      return r;
    };

    // 1. every provider answers with an error that echoes all the keys, in several statuses
    for (const status of [400, 401, 402, 403, 404, 422, 429, 500, 503]) {
      s.mock.calls.length = 0;
      const handlers = new MockFetch();
      handlers.route('googleapis.com', () => jsonResponse(status, { error: { code: status, status: 'INVALID_ARGUMENT', message: echo('gemini') } }));
      handlers.route('queue.fal.run', () => jsonResponse(status, { detail: [{ type: 'value_error', msg: echo('fal'), loc: [] }], error: echo('fal') }));
      handlers.route('cloud.leonardo.ai', () => jsonResponse(status, [{ message: echo('leonardo'), extensions: { code: 'unexpected' } }]));
      s.ctx.providerFetch = handlers.fetch;
      for (const provider of ['auto', 'gemini', 'fal', 'leonardo']) {
        await run('generate_image', { prompt: 'a calm lake at sunrise', provider });
      }
      await run('edit_image', { image_url: 'https://photos.example.test/me.jpg', instruction: 'brighten the picture', provider: 'fal' });
    }

    // 2. a success, a safety block and a pending job
    s.ctx.providerFetch = s.mock.fetch;
    await geminiPhoto(s.mock);
    await run('generate_image', { prompt: 'a calm lake at sunrise' });
    await run('estimate_cost', {});
    await run('list_providers', {});

    const text = [...outputs, ...s.rawLogs].join('\n');
    for (const key of Object.values(FAKE_KEYS)) {
      expect(text, `key leaked: ${key.slice(0, 12)}...`).not.toContain(key);
      expect(text).not.toContain(encodeURIComponent(key));
    }
    expect(text).not.toContain('evil.example.test');
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain(OTHER_TOKEN);
    expect(outputs.length).toBeGreaterThan(30);
    // the echo really did reach the error path: validation errors carry a sanitized snippet
    expect(outputs.some((o) => o.includes('failed for') && o.includes('[redacted]'))).toBe(true);
    expect(outputs.some((o) => o.includes('[link]'))).toBe(true);
  }, 60_000);

  it('the keys are not stored in jobs either', async () => {
    const s = await startImageServer({ env: { SYNC_WAIT_MS: '1000' } });
    s.mock.route('queue.fal.run/fal-ai/', () => jsonResponse(200, { request_id: 'r', status_url: 'https://queue.fal.run/fal-ai/x/requests/r/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/r' }), 'POST');
    s.mock.route('/requests/r/status', () => jsonResponse(200, { status: 'IN_PROGRESS' }));
    const started = jsonOf(await callTool(s.url, TEST_TOKEN, 'generate_image', { prompt: 'a lighthouse', provider: 'fal' }));
    const job = s.ctx.ledger.getJob('alice', started.job_id)!;
    expect(JSON.stringify(job)).not.toContain(FAKE_KEYS.fal);
    // and no request ever carried a key in its URL or body
    for (const call of s.mock.calls) {
      expect(call.url).not.toContain(FAKE_KEYS.fal);
      expect(JSON.stringify(call.body ?? '')).not.toContain(FAKE_KEYS.fal);
    }
  }, 30_000);
});
