import { describe, expect, it } from 'vitest';
import { RATIOS, modelsFor } from '../src/models.js';
import { isProviderError } from '../src/providers/errors.js';
import { LeonardoAdapter, buildBody, errorInfo, parseCreated } from '../src/providers/leonardo.js';
import type { JobHandle } from '../src/providers/types.js';
import { FAKE_KEYS, MockFetch, adapterDeps, imageResponse, jsonResponse, request, tinyPng } from './providerMocks.js';

const LUCID = 'lucid-origin';
const PHOENIX = 'phoenix-v1.0';
const KONTEXT = 'flux-kontext-pro';
const V2 = 'https://cloud.leonardo.ai/api/rest/v2/generations';
const V1 = 'https://cloud.leonardo.ai/api/rest/v1/generations';

const adapterFor = (mock: MockFetch, now?: () => number): LeonardoAdapter => new LeonardoAdapter(adapterDeps(mock, FAKE_KEYS.leonardo, now ? { now } : {}));

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (isProviderError(err)) return err;
    throw err;
  }
  throw new Error('expected a ProviderError');
}

async function created(mock: MockFetch, body: unknown = { generationId: 'gen-1', apiCreditCost: 12 }, over = {}, now?: () => number): Promise<JobHandle> {
  mock.route(V2, () => jsonResponse(200, body), 'POST');
  const started = await adapterFor(mock, now).generate(request(LUCID, over));
  if (started.state !== 'pending') throw new Error('Leonardo always queues');
  return started.handle;
}

describe('Leonardo create (API v2)', () => {
  it('POSTs {model, parameters, public:false} to /api/rest/v2/generations with a Bearer key', async () => {
    const mock = new MockFetch();
    await created(mock, undefined, { prompt: 'a red bicycle', ratio: '4:5', n: 2, seed: 99 });
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(V2);
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_KEYS.leonardo}`);
    expect(call.url).not.toContain(FAKE_KEYS.leonardo);
    expect(call.body).toEqual({ model: LUCID, parameters: { prompt: 'a red bicycle', width: 912, height: 1136, quantity: 2, seed: 99 }, public: false });
  });

  it('parses the documented shape {generationId, apiCreditCost}: no dollar cost, so the estimate stays', async () => {
    const handle = await created(new MockFetch(), { generationId: 'gen-1', apiCreditCost: 12 });
    expect(handle.ref).toEqual({ generation_id: 'gen-1' });
    expect(handle.costUsd).toBeUndefined();
  });

  it('parses the wrapped live shape {generate:{generationId, cost:{amount, unit:"DOLLARS"}}} and keeps the real cost', async () => {
    const handle = await created(new MockFetch(), { generate: { generationId: 'gen-2', cost: { amount: '0.0275', unit: 'DOLLARS' }, apiCreditCost: 5 } });
    expect(handle.ref.generation_id).toBe('gen-2');
    expect(handle.costUsd).toBe(0.0275);
  });

  it('ignores a cost that is not in dollars', () => {
    expect(parseCreated({ generate: { generationId: 'g', cost: { amount: 25, unit: 'CREDITS' } } })).toEqual({ generationId: 'g' });
    expect(parseCreated({ generationId: 'g', cost: { amount: 0, unit: 'DOLLARS' } })).toEqual({ generationId: 'g' });
    expect(parseCreated({ sdGenerationJob: { generationId: 'old' } })).toEqual({ generationId: 'old' });
    expect(parseCreated({ nothing: true })).toBeUndefined();
    expect(parseCreated('x')).toBeUndefined();
  });

  it('a create answer without any generation id is a server error', async () => {
    const mock = new MockFetch().route(V2, () => jsonResponse(200, { something: 'else' }));
    expect((await failureOf(adapterFor(mock).generate(request(LUCID)))).kind).toBe('server');
  });

  it.each(modelsFor('leonardo').flatMap((m) => RATIOS.map((r) => [m.id, r] as const)))('%s maps ratio %s to the catalog width x height (multiples of 8)', (modelId, ratio) => {
    const body = buildBody(request(modelId, { ratio })) as { parameters: { width: number; height: number } };
    const entry = modelsFor('leonardo').find((m) => m.id === modelId)!;
    expect(body.parameters.width).toBe((entry.aspect[ratio] as { width: number }).width);
    expect(body.parameters.height).toBe((entry.aspect[ratio] as { height: number }).height);
    expect(body.parameters.width % 8).toBe(0);
    expect(body.parameters.height % 8).toBe(0);
  });

  it('sends negative_prompt only when the orchestrator passes it (Phoenix), and references as guidances.image_reference URL entries', () => {
    const phoenix = buildBody(request(PHOENIX, { negativePrompt: 'blurry' })) as { parameters: Record<string, unknown> };
    expect(phoenix.parameters.negative_prompt).toBe('blurry');
    expect(buildBody(request(LUCID)) as object).not.toHaveProperty('parameters.negative_prompt');

    const edit = buildBody(request(KONTEXT, { task: 'edit', images: ['https://x.test/a.png', 'https://x.test/b.png'] })) as { model: string; parameters: Record<string, any> };
    expect(edit.model).toBe(KONTEXT);
    expect(edit.parameters.guidances).toEqual({
      image_reference: [
        { image: { type: 'URL', url: 'https://x.test/a.png' } },
        { image: { type: 'URL', url: 'https://x.test/b.png' } },
      ],
    });
    expect(buildBody(request(LUCID)).parameters).not.toHaveProperty('guidances');
  });
});

describe('Leonardo polling (API v1) and download', () => {
  const generation = (status: string, images: unknown[] = []) => jsonResponse(200, { generations_by_pk: { id: 'gen-1', status, generated_images: images } });

  it('PENDING is pending; COMPLETE downloads each image with a browser-like User-Agent and no Authorization header', async () => {
    const mock = new MockFetch();
    const handle = await created(mock, { generate: { generationId: 'gen-1', cost: { amount: 0.03, unit: 'DOLLARS' } } });
    const png = await tinyPng();
    const statuses = ['PENDING', 'COMPLETE'];
    mock.route(`${V1}/gen-1`, () => generation(statuses.shift()!, [{ url: 'https://cdn.leonardo.ai/users/u/generations/g/a.jpg', nsfw: false }, { url: 'https://cdn.leonardo.ai/users/u/generations/g/b.jpg' }]));
    mock.route('cdn.leonardo.ai', () => imageResponse(png, 'image/jpeg'));

    const adapter = adapterFor(mock);
    expect((await adapter.poll(handle)).state).toBe('pending');
    const done = await adapter.poll(handle);
    expect(done.state).toBe('done');
    if (done.state === 'done') {
      expect(done.outputs).toHaveLength(2);
      expect(done.costUsd).toBe(0.03); // the real cost travels with the job
    }

    const status = mock.calls.find((c) => c.url === `${V1}/gen-1`)!;
    expect(status.method).toBe('GET');
    expect(status.headers.authorization).toBe(`Bearer ${FAKE_KEYS.leonardo}`);
    const downloads = mock.callsTo('cdn.leonardo.ai');
    expect(downloads).toHaveLength(2);
    for (const d of downloads) {
      expect(d.headers['user-agent']).toMatch(/^Mozilla\/5\.0 .*Chrome/);
      expect(d.headers.authorization).toBeUndefined();
    }
  });

  it('drops nsfw images; all nsfw is a safety refusal', async () => {
    const png = await tinyPng();
    const run = async (flags: boolean[]) => {
      const mock = new MockFetch();
      const handle = await created(mock);
      mock.route(`${V1}/gen-1`, () => generation('COMPLETE', flags.map((nsfw, i) => ({ url: `https://cdn.leonardo.ai/i${i}.jpg`, nsfw }))));
      mock.route('cdn.leonardo.ai', () => imageResponse(png));
      return adapterFor(mock).poll(handle);
    };
    const partial = await run([true, false]);
    expect(partial.state === 'done' && partial.outputs.length).toBe(1);
    expect(partial.state === 'done' && partial.dropped).toBe(1);
    expect((await failureOf(run([true, true]))).kind).toBe('safety');
  });

  it('FAILED is a server error; COMPLETE without images is "no image"', async () => {
    const failed = new MockFetch();
    const handleA = await created(failed);
    failed.route(`${V1}/gen-1`, () => generation('FAILED'));
    expect((await failureOf(adapterFor(failed).poll(handleA))).kind).toBe('server');

    const empty = new MockFetch();
    const handleB = await created(empty);
    empty.route(`${V1}/gen-1`, () => generation('COMPLETE', []));
    expect((await failureOf(adapterFor(empty).poll(handleB))).kind).toBe('no_image');
  });

  it('a brand-new job may answer 403/404 on the v1 status endpoint for a while: keep waiting, then give up', async () => {
    let now = 1_000_000;
    const mock = new MockFetch();
    const handle = await created(mock, undefined, {}, () => now);
    mock.route(`${V1}/gen-1`, () => jsonResponse(404, { error: 'not found', code: 'unexpected' }));
    const adapter = adapterFor(mock, () => now);
    expect((await adapter.poll(handle)).state).toBe('pending');
    now += 60_000;
    expect((await adapter.poll(handle)).state).toBe('pending');
    now += 120_000; // past the grace window
    expect((await failureOf(adapter.poll(handle))).kind).toBe('model_unavailable');
  });

  it('refuses to download from a non-https or private address', async () => {
    for (const url of ['http://cdn.leonardo.ai/a.jpg', 'https://169.254.169.254/latest', 'https://user:pw@cdn.leonardo.ai/a.jpg']) {
      const mock = new MockFetch();
      const handle = await created(mock);
      mock.route(`${V1}/gen-1`, () => generation('COMPLETE', [{ url }]));
      expect((await failureOf(adapterFor(mock).poll(handle))).kind, url).toBe('server');
      expect(mock.calls.filter((c) => !c.url.startsWith('https://cloud.leonardo.ai'))).toHaveLength(0);
    }
  });
});

describe('Leonardo error mapping (object, list and GraphQL-style bodies)', () => {
  const createFailure = async (status: number, body: unknown) => {
    const mock = new MockFetch().route(V2, () => jsonResponse(status, body));
    return failureOf(adapterFor(mock).generate(request(LUCID)));
  };

  it('reads the message and code from every body shape', () => {
    expect(errorInfo({ error: 'Authentication hook unauthorized this request', path: '$', code: 'access-denied' })).toEqual({ message: 'Authentication hook unauthorized this request', code: 'access-denied' });
    expect(errorInfo([{ message: 'Bad thing', extensions: { path: '$', code: 'unexpected' } }])).toEqual({ message: 'Bad thing', code: 'unexpected' });
    expect(errorInfo({ errors: [{ message: 'In a wrapper', extensions: { code: 'validation-failed' } }] })).toEqual({ message: 'In a wrapper', code: 'validation-failed' });
    expect(errorInfo({ error: { message: 'nested' } })).toEqual({ message: 'nested' });
    expect(errorInfo('plain text')).toEqual({ message: 'plain text' });
    expect(errorInfo(undefined)).toEqual({ message: '' });
  });

  it('invalid key (either documented message, any status) is auth', async () => {
    expect((await createFailure(403, { error: 'Authentication hook unauthorized this request', path: '$', code: 'access-denied' })).kind).toBe('auth');
    expect((await createFailure(401, [{ message: 'Invalid response from authorization hook', extensions: { code: 'unexpected' } }])).kind).toBe('auth');
  });

  it('content moderation is a safety refusal, even though it arrives as 403', async () => {
    expect((await createFailure(403, { error: 'Your prompt appears to contain inappropriate content', path: '$', code: 'unexpected' })).kind).toBe('safety');
    expect((await createFailure(400, [{ message: 'content moderation filter: naked', extensions: { code: 'unexpected' } }])).kind).toBe('safety');
  });

  it('out of credits is credits; 429 is rate_limit; 5xx is server', async () => {
    expect((await createFailure(400, { error: 'Not enough API credits to run this generation', code: 'unexpected' })).kind).toBe('credits');
    expect((await createFailure(402, {})).kind).toBe('credits');
    expect((await createFailure(429, { error: 'Too many requests' })).kind).toBe('rate_limit');
    expect((await createFailure(502, 'bad gateway')).kind).toBe('server');
  });

  it('model not allowed is model_unavailable; unreadable reference is bad_reference; other 400s are validation', async () => {
    expect((await createFailure(400, { error: 'flux-kontext-pro is not supported within the Production API', code: 'unexpected' })).kind).toBe('model_unavailable');
    expect((await createFailure(400, { error: "couldn't access image", code: 'unexpected' })).kind).toBe('bad_reference');
    const validation = await createFailure(400, [{ message: `invalid dimensions for ${FAKE_KEYS.leonardo} see https://docs.leonardo.ai/x`, extensions: { code: 'unexpected' } }]);
    expect(validation.kind).toBe('validation');
    expect(validation.toToolText()).toMatch(/invalid dimensions/);
    expect(validation.toToolText()).not.toContain(FAKE_KEYS.leonardo);
    expect(validation.toToolText()).not.toMatch(/https?:/);
  });
});
