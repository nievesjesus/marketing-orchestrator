import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { UserFacingError } from '../src/errors.js';
import { createAdapters } from '../src/providers/index.js';
import { backoffDelays, checkJob, defaultSleep, runImageRequest, type DoneOutcome, type ImageRequest, type PendingOutcome, type RunDeps } from '../src/providers/orchestrator.js';
import { isProviderError } from '../src/providers/errors.js';
import { DAY, FAKE_KEYS, imageResponse, jsonResponse, makeHarness, tinyPng, tinyPngBase64, type MockFetch, type TestHarness } from './providerMocks.js';

const HOUR = 60 * 60 * 1000;
const BASE: ImageRequest = { task: 'generate', text: 'a calm lake', provider: 'auto', ratio: '1:1', numImages: 1, references: [] };

let h: TestHarness;
afterEach(() => {
  vi.useRealTimers();
  if (h) {
    h.cleanup();
    h = undefined as unknown as TestHarness;
  }
});

/**
 * Under fake timers the real sleep/clock are used (the tests advance them). Otherwise sleeping is instant on a virtual
 * clock, so tests that are not about timing do not wait for the 1 s backoff.
 */
function depsFor(harness: TestHarness): RunDeps {
  const adapters = createAdapters(harness.ctx);
  if (vi.isFakeTimers()) return { adapters, sleep: defaultSleep, now: () => Date.now() };
  let virtual = Date.now();
  return {
    adapters,
    sleep: async (ms) => {
      virtual += ms;
    },
    now: () => virtual,
  };
}
const run = (req: Partial<ImageRequest> = {}, user = 'alice') => runImageRequest(h.ctx, user, { ...BASE, ...req }, depsFor(h));

async function geminiOk(mock: MockFetch): Promise<void> {
  const data = await tinyPngBase64();
  mock.route(':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] }, finishReason: 'STOP' }] }));
}

interface FalScript {
  /** Statuses returned by successive status calls; the last one repeats. */
  statuses: string[];
  result?: unknown;
  bytes?: Buffer;
  times?: number[];
}

function scriptFal(mock: MockFetch, script: FalScript, bytes: Buffer): void {
  mock.route('queue.fal.run/fal-ai/', () => jsonResponse(200, { request_id: 'fr1', status_url: 'https://queue.fal.run/fal-ai/x/requests/fr1/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/fr1' }), 'POST');
  mock.route('/requests/fr1/status', () => {
    script.times?.push(Date.now());
    const status = script.statuses.length > 1 ? script.statuses.shift()! : script.statuses[0]!;
    return jsonResponse(200, { status });
  });
  mock.route('/requests/fr1', () => jsonResponse(200, script.result ?? { images: [{ url: 'https://v3.fal.media/files/out.png', width: 64, height: 80 }], description: '' }));
  mock.route('v3.fal.media', () => imageResponse(script.bytes ?? bytes));
}

function scriptLeonardo(mock: MockFetch, opts: { createBody?: unknown; statuses?: string[]; bytes: Buffer; count?: number }): void {
  const statuses = opts.statuses ?? ['COMPLETE'];
  mock.route('rest/v2/generations', () => jsonResponse(200, opts.createBody ?? { generate: { generationId: 'lg1', cost: { amount: 0.0275, unit: 'DOLLARS' } } }), 'POST');
  mock.route('rest/v1/generations/lg1', () => {
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    return jsonResponse(200, { generations_by_pk: { status, generated_images: status === 'COMPLETE' ? Array.from({ length: opts.count ?? 1 }, (_v, i) => ({ url: `https://cdn.leonardo.ai/o${i}.jpg`, nsfw: false })) : [] } });
  });
  mock.route('cdn.leonardo.ai', () => imageResponse(opts.bytes, 'image/jpeg'));
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as Error & { kind?: string; code?: string };
  }
  throw new Error('expected a failure');
}

const quota = (user = 'alice') => h.ledger.quota(user);

describe('generate: reserve, call, copy to our storage, settle', () => {
  it('a Gemini image is stored in our storage under our own URL and booked at the catalog price', async () => {
    h = makeHarness();
    await geminiOk(h.mock);
    const outcome = (await run({ ratio: '4:5' })) as DoneOutcome;

    expect(outcome).toMatchObject({ status: 'done', provider: 'gemini', model: 'gemini-3.1-flash-image', fallbackFrom: null, costUsd: 0.067, costIsEstimate: false, rule: 'default' });
    expect(outcome.images).toHaveLength(1);
    const image = outcome.images[0]!;
    expect(image.url).toMatch(/^https:\/\/images\.example\.test\/i\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(image).toMatchObject({ width: 64, height: 80, contentType: 'image/png' });
    expect(await h.ctx.storage.open(image.key)).not.toBeNull();
    expect(quota()).toMatchObject({ images: { used: 1, reserved: 0, left: 29 }, usd: { used: 0.07, reserved: 0 } });
  });

  it('copies fal outputs into our storage byte for byte; the answer never points at the provider\'s file host', async () => {
    h = makeHarness();
    const png = await tinyPng();
    scriptFal(h.mock, { statuses: ['COMPLETED'] }, png);
    const outcome = (await run({ provider: 'fal' })) as DoneOutcome;
    // (the first poll happens after the first 1 s backoff)
    expect(outcome.provider).toBe('fal');
    const image = outcome.images[0]!;
    expect(image.url).not.toMatch(/fal\.media|fal\.run/);
    const file = await h.ctx.storage.open(image.key);
    expect(file).not.toBeNull();
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(file!.absPath)).equals(png)).toBe(true);
  }, 15_000);

  it('keeps JPEG as JPEG and converts WebP to PNG', async () => {
    h = makeHarness();
    const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#aa5500' } }).jpeg().toBuffer();
    scriptLeonardo(h.mock, { bytes: jpeg });
    const asJpeg = (await run({ provider: 'leonardo' })) as DoneOutcome;
    expect(asJpeg.images[0]).toMatchObject({ contentType: 'image/jpeg', width: 40, height: 30 });
    expect(asJpeg.images[0]!.url).toMatch(/\.jpg$/);

    const webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#00aa55' } }).webp().toBuffer();
    const second = makeHarness();
    scriptLeonardo(second.mock, { bytes: webp });
    const converted = (await runImageRequest(second.ctx, 'alice', { ...BASE, provider: 'leonardo' }, depsFor(second))) as DoneOutcome;
    expect(converted.images[0]!.contentType).toBe('image/png');
    second.cleanup();
  }, 15_000);

  it('bytes that are not an image are a provider error and give the allowance back', async () => {
    h = makeHarness();
    scriptFal(h.mock, { statuses: ['COMPLETED'] }, Buffer.from('definitely not an image'));
    const err = await failureOf(run({ provider: 'fal' }));
    expect(isProviderError(err) && err.kind).toBe('server');
    expect(quota().images).toMatchObject({ used: 0, reserved: 0 });
  }, 15_000);

  it('Leonardo\'s real dollar cost is what gets booked; without one the catalog estimate is, flagged as an estimate', async () => {
    h = makeHarness();
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    scriptLeonardo(h.mock, { bytes: jpeg });
    const real = (await run({ provider: 'leonardo', numImages: 2 })) as DoneOutcome;
    expect(real).toMatchObject({ costUsd: 0.0275, costIsEstimate: false });
    expect(quota().usd.used).toBe(0.03); // rounded for display, exact in the ledger

    const estimated = makeHarness();
    scriptLeonardo(estimated.mock, { createBody: { generationId: 'lg1', apiCreditCost: 12 }, bytes: jpeg, count: 2 });
    const outcome = (await runImageRequest(estimated.ctx, 'alice', { ...BASE, provider: 'leonardo', numImages: 2 }, depsFor(estimated))) as DoneOutcome;
    expect(outcome).toMatchObject({ costUsd: 0.04, costIsEstimate: true });
    estimated.cleanup();
  }, 20_000);

  it('images the provider flagged are dropped but still billed; the rest are delivered', async () => {
    h = makeHarness();
    const png = await tinyPng();
    scriptFal(h.mock, { statuses: ['COMPLETED'], result: { images: [{ url: 'https://v3.fal.media/a.png' }, { url: 'https://v3.fal.media/b.png' }], has_nsfw_concepts: [false, true] } }, png);
    const outcome = (await run({ provider: 'fal', numImages: 2 })) as DoneOutcome;
    expect(outcome.images).toHaveLength(1);
    expect(outcome.warnings.join(' ')).toMatch(/removed by the provider's safety filter/);
    expect(outcome.costUsd).toBe(0.16); // both images were made and billed by fal
    expect(quota().images.used).toBe(1);
  }, 15_000);

  it('warns about options a model ignores or cannot do exactly', async () => {
    h = makeHarness();
    await geminiOk(h.mock);
    const seeded = (await run({ seed: 5 })) as DoneOutcome;
    expect(seeded.warnings.join(' ')).toMatch(/ignores the seed/);

    const kontext = makeHarness();
    const png = await tinyPng();
    scriptFal(kontext.mock, { statuses: ['COMPLETED'] }, png);
    const edit = (await runImageRequest(kontext.ctx, 'alice', { ...BASE, task: 'edit', imageUrl: 'https://x.test/p.png', ratio: '4:5', model: 'fal-ai/flux-pro/kontext' }, depsFor(kontext))) as DoneOutcome;
    expect(edit.warnings.join(' ')).toMatch(/cannot make 4:5 exactly \(it makes 3:4\)/);
    kontext.cleanup();
  }, 20_000);
});

describe('edit input images', () => {
  it('Gemini gets the photo through the SSRF-safe loader (inline); fal gets the link untouched', async () => {
    h = makeHarness();
    await geminiOk(h.mock);
    await run({ task: 'edit', text: 'make it sunset', imageUrl: 'https://photos.example.test/me.jpg', ratio: undefined });
    expect(h.fetchedImages).toEqual(['https://photos.example.test/me.jpg']);
    const parts = h.mock.callsTo(':generateContent')[0]!.body.contents[0].parts;
    expect(parts[1].inlineData.mimeType).toBe('image/png');
    expect(typeof parts[1].inlineData.data).toBe('string');
    expect(parts[0].text).toContain('Edit the attached image: make it sunset');

    const second = makeHarness();
    scriptFal(second.mock, { statuses: ['COMPLETED'] }, await tinyPng());
    await runImageRequest(second.ctx, 'alice', { ...BASE, task: 'edit', text: 'x', provider: 'fal', imageUrl: 'https://photos.example.test/me.jpg', references: ['https://photos.example.test/logo.png'] }, depsFor(second));
    expect(second.fetchedImages).toEqual([]);
    const submit = second.mock.calls.find((c) => c.method === 'POST')!;
    expect(submit.url).toBe('https://queue.fal.run/fal-ai/nano-banana-2/edit');
    expect(submit.body.image_urls).toEqual(['https://photos.example.test/me.jpg', 'https://photos.example.test/logo.png']);
    second.cleanup();
  }, 20_000);

  it.each(['http://example.test/a.png', 'https://10.0.0.1/a.png', 'https://169.254.169.254/latest', 'https://user:pw@example.test/a.png', 'https://printer.local/a.png', 'https://localhost/a.png', 'https://[::1]/a.png'])(
    'refuses %s as an input image before reserving anything or calling any provider (production settings)',
    async (link) => {
      h = makeHarness({ config: { NODE_ENV: 'production' } }); // development and tests allow localhost links; production never does
      for (const provider of ['auto', 'fal', 'leonardo'] as const) {
        const asPhoto = (await failureOf(run({ task: 'edit', text: 'x', provider, imageUrl: link }))) as UserFacingError;
        expect(asPhoto.code).toBe('url_blocked');
        const asReference = (await failureOf(run({ provider, references: [link] }))) as UserFacingError;
        expect(asReference.code).toBe('url_blocked');
      }
      expect(h.mock.calls).toHaveLength(0);
      expect(quota().images).toMatchObject({ used: 0, reserved: 0 });
    },
  );

  it('Leonardo edit without a ratio uses the photo\'s own shape (64x80 -> 4:5 -> 912x1136)', async () => {
    h = makeHarness();
    scriptLeonardo(h.mock, { bytes: await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer() });
    await run({ task: 'edit', provider: 'leonardo', text: 'x', imageUrl: 'https://photos.example.test/me.jpg', ratio: undefined });
    const body = h.mock.callsTo('rest/v2/generations')[0]!.body;
    expect(body.model).toBe('flux-kontext-pro');
    expect(body.parameters).toMatchObject({ width: 912, height: 1136 });
    expect(body.parameters.guidances.image_reference[0]).toEqual({ image: { type: 'URL', url: 'https://photos.example.test/me.jpg' } });
  }, 15_000);
});

describe('quota: reserve -> call -> settle | release (DESIGN section 9)', () => {
  it('over the image cap: a plain message and NO provider call', async () => {
    h = makeHarness({ limits: { dailyImages: 2 } });
    await geminiOk(h.mock);
    const err = (await failureOf(run({ numImages: 3 }))) as UserFacingError;
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.code).toBe('quota_images');
    expect(err.message).toMatch(/2 images; it resets at 00:00 UTC/);
    expect(h.mock.calls).toHaveLength(0);
    expect(quota().images).toMatchObject({ used: 0, reserved: 0 });
  });

  it('over the USD cap: a plain message and NO provider call', async () => {
    h = makeHarness({ limits: { dailyUsd: 0.05 } });
    const err = (await failureOf(run())) as UserFacingError;
    expect(err.code).toBe('quota_usd');
    expect(h.mock.calls).toHaveLength(0);
  });

  it('the allowance is shared across calls: the Nth request that no longer fits is refused', async () => {
    h = makeHarness({ limits: { dailyImages: 3 } });
    await geminiOk(h.mock);
    await run({ numImages: 2 });
    await run({ numImages: 1 });
    const callsBefore = h.mock.calls.length;
    const err = (await failureOf(run())) as UserFacingError;
    expect(err.code).toBe('quota_images');
    expect(h.mock.calls).toHaveLength(callsBefore);
  });

  it('a request is only reserved while it runs: concurrent requests cannot overspend', async () => {
    h = makeHarness({ limits: { dailyImages: 2 } });
    await geminiOk(h.mock);
    const results = await Promise.allSettled([run({ numImages: 2 }), run({ numImages: 2 })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(quota().images).toMatchObject({ used: 2, reserved: 0 });
  });

  it('a failed request releases its reservation', async () => {
    h = makeHarness();
    h.mock.route(':generateContent', () => jsonResponse(500, { error: { code: 500, status: 'INTERNAL', message: 'x' } }));
    await failureOf(run({ provider: 'gemini' }));
    expect(quota()).toMatchObject({ images: { used: 0, reserved: 0 }, usd: { used: 0, reserved: 0 } });
  });

  it('a safety refusal releases its reservation too', async () => {
    h = makeHarness();
    h.mock.route(':generateContent', () => jsonResponse(200, { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }));
    const err = await failureOf(run());
    expect(err.kind).toBe('safety');
    expect(quota().images).toMatchObject({ used: 0, reserved: 0 });
  });
});

describe('fallback (DESIGN section 7)', () => {
  const geminiFailures: [string, number, unknown, string][] = [
    ['5xx', 503, { error: { code: 503, status: 'UNAVAILABLE', message: 'x' } }, 'server error'],
    ['429', 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'x' } }, 'rate limited'],
    ['auth', 403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'x' } }, 'key rejected'],
    ['out of credits', 402, { error: { code: 'payment_required', message: 'x' } }, 'out of credits'],
    ['timeout', 504, { error: { code: 504, status: 'DEADLINE_EXCEEDED', message: 'x' } }, 'timed out'],
  ];

  it.each(geminiFailures)('auto falls back to the next provider on %s and says so', async (_label, status, body, reason) => {
    h = makeHarness();
    h.mock.route(':generateContent', () => jsonResponse(status, body)).route('/interactions', () => jsonResponse(status, body));
    scriptFal(h.mock, { statuses: ['COMPLETED'] }, await tinyPng());

    const outcome = (await run()) as DoneOutcome;
    expect(outcome.provider).toBe('fal');
    expect(outcome.model).toBe('fal-ai/nano-banana-2');
    expect(outcome.fallbackFrom).toBe(`gemini (${reason})`);
    // only the provider that worked is billed
    expect(quota()).toMatchObject({ images: { used: 1, reserved: 0 }, usd: { used: 0.08, reserved: 0 } });
  }, 15_000);

  it('a network failure also falls back', async () => {
    h = makeHarness();
    h.mock.on((call) => {
      if (call.url.includes('googleapis.com')) throw new TypeError('fetch failed');
      return undefined;
    });
    scriptFal(h.mock, { statuses: ['COMPLETED'] }, await tinyPng());
    expect(((await run()) as DoneOutcome).fallbackFrom).toBe('gemini (unreachable)');
  }, 15_000);

  it('never falls back on a safety refusal: the other providers are not even contacted', async () => {
    h = makeHarness();
    h.mock.route(':generateContent', () => jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }));
    const err = await failureOf(run());
    expect(err.kind).toBe('safety');
    expect(h.mock.calls.filter((c) => !c.url.includes('googleapis.com'))).toHaveLength(0);
  });

  it('never falls back on a validation error', async () => {
    h = makeHarness();
    const bad = { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad value' } };
    h.mock.route(':generateContent', () => jsonResponse(400, bad)).route('/interactions', () => jsonResponse(400, bad));
    const err = await failureOf(run());
    expect(err.kind).toBe('validation');
    expect(h.mock.calls.filter((c) => !c.url.includes('googleapis.com'))).toHaveLength(0);
  });

  it('never falls back on a fal content-policy violation (422) either', async () => {
    h = makeHarness({ keys: { FAL_KEY: FAKE_KEYS.fal, LEONARDO_API_KEY: FAKE_KEYS.leonardo } });
    h.mock.route('queue.fal.run', () => jsonResponse(422, { detail: [{ type: 'content_policy_violation', msg: 'no', loc: [] }] }));
    const err = await failureOf(run());
    expect(err.kind).toBe('safety');
    expect(h.mock.callsTo('leonardo.ai')).toHaveLength(0);
  });

  it('an explicit provider gets a plain error with a suggestion, not a fallback', async () => {
    h = makeHarness();
    h.mock.route(':generateContent', () => jsonResponse(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'x' } })).route('/interactions', () => jsonResponse(503, {}));
    const err = (await failureOf(run({ provider: 'gemini' }))) as UserFacingError;
    expect(err.message).toBe('Gemini is having problems right now.');
    expect(err.suggestion).toBe('Try fal.ai or Leonardo instead.');
    expect(h.mock.calls.filter((c) => !c.url.includes('googleapis.com'))).toHaveLength(0);
  });

  it('a named model is also explicit: no fallback', async () => {
    h = makeHarness();
    h.mock.route(':generateContent', () => jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'x' } })).route('/interactions', () => jsonResponse(429, {}));
    const err = await failureOf(run({ model: 'gemini-3-pro-image' }));
    expect(err.kind).toBe('rate_limit');
    expect(h.mock.calls.filter((c) => !c.url.includes('googleapis.com'))).toHaveLength(0);
  });

  it('when everything fails the message lists what was tried, and nothing is billed', async () => {
    h = makeHarness();
    h.mock.route('googleapis.com', () => jsonResponse(503, {})).route('queue.fal.run', () => jsonResponse(500, {})).route('cloud.leonardo.ai', () => jsonResponse(402, {}));
    const err = (await failureOf(run())) as UserFacingError;
    expect(err.message).toBe('Leonardo has run out of credits. Also tried: gemini (server error); fal (server error).');
    expect(quota()).toMatchObject({ images: { used: 0, reserved: 0 }, usd: { used: 0, reserved: 0 } });
  });

  it('a fallback candidate that no longer fits the allowance is skipped, the next one is used', async () => {
    h = makeHarness({ limits: { dailyUsd: 0.07 } }); // Gemini (0.067) fits, fal (0.08) does not, Leonardo (0.02) does
    h.mock.route('googleapis.com', () => jsonResponse(503, {}));
    scriptLeonardo(h.mock, { bytes: await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer() });
    const outcome = (await run()) as DoneOutcome;
    expect(outcome.provider).toBe('leonardo');
    expect(outcome.fallbackFrom).toBe("gemini (server error); fal (over today's allowance)");
    expect(h.mock.callsTo('queue.fal.run')).toHaveLength(0);
  }, 15_000);

  it('a provider that is not set up is never a candidate', async () => {
    h = makeHarness({ keys: { LEONARDO_API_KEY: FAKE_KEYS.leonardo } });
    scriptLeonardo(h.mock, { bytes: await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer() });
    expect(((await run()) as DoneOutcome).provider).toBe('leonardo');
    expect(h.mock.calls.every((c) => c.url.includes('leonardo.ai'))).toBe(true);
  }, 15_000);
});

describe('waiting: backoff, sync budget and job hand-off (DESIGN section 8)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(DAY);
  });

  async function advance<T>(promise: Promise<T>, ms: number): Promise<T> {
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ms);
    return promise;
  }

  it('backoff is 1 s, 1.5 s, 2.25 s ... capped at 5 s', () => {
    const delays = backoffDelays();
    expect(Array.from({ length: 8 }, () => delays.next().value)).toEqual([1000, 1500, 2250, 3375, 5000, 5000, 5000, 5000]);
  });

  it('polls on that schedule and returns the finished image inside the sync budget', async () => {
    h = makeHarness();
    const times: number[] = [];
    scriptFal(h.mock, { statuses: ['IN_QUEUE', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED'], times }, await tinyPng());
    const start = Date.now();
    const outcome = (await advance(run({ provider: 'fal' }), 30_000)) as DoneOutcome;
    expect(outcome.status).toBe('done');
    expect(times.map((t) => t - start)).toEqual([1000, 2500, 4750, 8125]); // 1 s, +1.5 s, +2.25 s, +3.375 s
  });

  it('after SYNC_WAIT_MS the job is saved with its reservation and a job_id comes back', async () => {
    h = makeHarness({ config: { SYNC_WAIT_MS: '5000' } });
    const times: number[] = [];
    scriptFal(h.mock, { statuses: ['IN_PROGRESS'], times }, await tinyPng());
    const start = Date.now();
    const outcome = (await advance(run({ provider: 'fal', numImages: 2 }), 20_000)) as PendingOutcome;

    expect(outcome.status).toBe('pending');
    expect(outcome.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome).toMatchObject({ provider: 'fal', model: 'fal-ai/nano-banana-2', retryAfterSeconds: 15 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(5000);
    expect(times.length).toBeLessThanOrEqual(5); // no busy loop
    expect(Math.max(...times) - start).toBeLessThanOrEqual(5000);

    // The money is held, not spent: reserved under the job, nothing used yet.
    expect(quota()).toMatchObject({ images: { used: 0, reserved: 2 }, usd: { used: 0, reserved: 0.16 } });
    const job = h.ledger.getJob('alice', outcome.jobId)!;
    expect(job).toMatchObject({ status: 'pending', provider: 'fal', model: 'fal-ai/nano-banana-2' });
    expect(job.upstream.handle).toMatchObject({ provider: 'fal', ref: { request_id: 'fr1' } });
    expect(JSON.stringify(job)).not.toContain(FAKE_KEYS.fal);
    expect(JSON.stringify(job.request_summary)).not.toContain('calm lake'); // no prompt text is stored
  });

  it('transient status errors (429, 5xx) do not lose the job: they are retried until the budget ends', async () => {
    h = makeHarness({ config: { SYNC_WAIT_MS: '4000' } });
    h.mock.route('queue.fal.run/fal-ai/', () => jsonResponse(200, { request_id: 'fr1', status_url: 'https://queue.fal.run/fal-ai/x/requests/fr1/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/fr1' }), 'POST');
    h.mock.route('/requests/fr1/status', () => jsonResponse(503, { detail: 'busy' }));
    const outcome = await advance(run({ provider: 'fal' }), 20_000);
    expect(outcome.status).toBe('pending');
  });

  it('a permanent status error (safety) ends the wait and gives the allowance back', async () => {
    h = makeHarness();
    h.mock.route('queue.fal.run/fal-ai/', () => jsonResponse(200, { request_id: 'fr1', status_url: 'https://queue.fal.run/fal-ai/x/requests/fr1/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/fr1' }), 'POST');
    h.mock.route('/requests/fr1/status', () => jsonResponse(200, { status: 'COMPLETED', error: 'blocked', error_type: 'content_policy_violation' }));
    const err = await failureOf(advance(run({ provider: 'fal' }), 10_000));
    expect(err.kind).toBe('safety');
    expect(quota().images).toMatchObject({ used: 0, reserved: 0 });
  });

  describe('get_job', () => {
    async function pendingJob(user = 'alice', numImages = 1): Promise<PendingOutcome> {
      return (await advance(runImageRequest(h.ctx, user, { ...BASE, provider: 'fal', numImages }, depsFor(h)), 20_000)) as PendingOutcome;
    }

    it('one check returns "pending" while the provider is still working (no in-call wait with waitMs 0)', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      scriptFal(h.mock, { statuses: ['IN_PROGRESS'] }, await tinyPng());
      const job = await pendingJob();
      const before = h.mock.calls.length;
      const outcome = (await checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0)) as PendingOutcome;
      expect(outcome).toMatchObject({ status: 'pending', jobId: job.jobId, retryAfterSeconds: 15 });
      expect(h.mock.calls.length - before).toBe(1); // exactly one status call
    });

    it('waits at most 20 s inside the call, then answers pending', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      const times: number[] = [];
      scriptFal(h.mock, { statuses: ['IN_PROGRESS'], times }, await tinyPng());
      const job = await pendingJob();
      times.length = 0;
      const start = Date.now();
      const outcome = await advance(checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 120_000), 60_000); // asking for 120 s is capped at 20 s
      expect(outcome.status).toBe('pending');
      expect(Date.now() - start).toBeGreaterThanOrEqual(20_000);
      expect(Math.max(...times) - start).toBeLessThanOrEqual(20_000);
      expect(times.length).toBeLessThanOrEqual(10);
    });

    it('collects a finished job once: copies to storage, settles the reservation, and a second call is served from the saved result', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      const script: FalScript = { statuses: ['IN_PROGRESS'] };
      scriptFal(h.mock, script, await tinyPng());
      const job = await pendingJob('alice', 1);
      expect(quota().images.reserved).toBe(1);

      script.statuses = ['COMPLETED']; // the provider finished meanwhile
      const done = (await checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0)) as DoneOutcome;
      expect(done).toMatchObject({ status: 'done', provider: 'fal', costUsd: 0.08, costIsEstimate: false });
      expect(done.images[0]!.url).toMatch(/^https:\/\/images\.example\.test\/i\//);
      expect(await h.ctx.storage.open(done.images[0]!.key)).not.toBeNull();
      expect(quota()).toMatchObject({ images: { used: 1, reserved: 0 }, usd: { used: 0.08, reserved: 0 } });

      const callsBefore = h.mock.calls.length;
      const again = (await checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0)) as DoneOutcome;
      expect(again.images[0]!.url).toBe(done.images[0]!.url);
      expect(h.mock.calls).toHaveLength(callsBefore); // no provider call
      expect(quota().images.used).toBe(1); // not booked twice
    });

    it('a Leonardo job settles at the real cost reported when it was created', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer();
      const statuses = ['PENDING'];
      scriptLeonardo(h.mock, { statuses, bytes: jpeg });
      const job = (await advance(runImageRequest(h.ctx, 'alice', { ...BASE, provider: 'leonardo' }, depsFor(h)), 20_000)) as PendingOutcome;
      expect(job.status).toBe('pending');
      statuses[0] = 'COMPLETE';
      const done = (await checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0)) as DoneOutcome;
      expect(done).toMatchObject({ costUsd: 0.0275, costIsEstimate: false });
    });

    it('jobs are scoped to their owner: another user gets the same "not found" as for an unknown id, and no provider call', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      scriptFal(h.mock, { statuses: ['IN_PROGRESS'] }, await tinyPng());
      const job = await pendingJob('alice');
      const calls = h.mock.calls.length;

      const foreign = (await failureOf(checkJob(h.ctx, 'bob', job.jobId, depsFor(h), 0))) as UserFacingError;
      const unknown = (await failureOf(checkJob(h.ctx, 'bob', '00000000-0000-0000-0000-000000000000', depsFor(h), 0))) as UserFacingError;
      expect(foreign.code).toBe('job_not_found');
      expect(foreign.message).toBe(unknown.message);
      expect(h.mock.calls).toHaveLength(calls);
      // bob cannot finish it by guessing either, and alice's reservation is untouched
      expect(h.ledger.quota('alice').images.reserved).toBe(1);
      expect(h.ledger.getJob('alice', job.jobId)!.status).toBe('pending');
    });

    it('a job the provider refuses ends as a plain error, refunds the reservation, and stays failed', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      const script: FalScript = { statuses: ['IN_PROGRESS'] };
      scriptFal(h.mock, script, await tinyPng());
      const job = await pendingJob();
      script.statuses = ['COMPLETED'];
      script.result = { images: [{ url: 'https://v3.fal.media/files/a.png' }], has_nsfw_concepts: [true] };

      const first = await failureOf(checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0));
      expect(first.kind).toBe('safety');
      expect(quota().images).toMatchObject({ used: 0, reserved: 0 });
      expect(h.ledger.getJob('alice', job.jobId)!.status).toBe('failed');

      const calls = h.mock.calls.length;
      const second = (await failureOf(checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0))) as UserFacingError;
      expect(second.message).toBe((first as UserFacingError).message);
      expect(h.mock.calls).toHaveLength(calls);
    });

    it('jobs expire after 24 h: the sweep refunds the reservation and get_job says so', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      scriptFal(h.mock, { statuses: ['IN_PROGRESS'] }, await tinyPng());
      const job = await pendingJob('alice', 2);
      expect(quota().images.reserved).toBe(2);

      h.setNow(DAY + 25 * HOUR);
      expect(h.ledger.expireJobs(24 * HOUR).expired).toBe(1);
      expect(h.ledger.quota('alice').images.reserved).toBe(0);
      const err = (await failureOf(checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0))) as UserFacingError;
      expect(err.code).toBe('job_expired');
      expect(err.message).toMatch(/expired.*allowance was returned/);
    });

    it('two concurrent get_job calls on a finished job book it once', async () => {
      h = makeHarness({ config: { SYNC_WAIT_MS: '2000' } });
      const script: FalScript = { statuses: ['IN_PROGRESS'] };
      scriptFal(h.mock, script, await tinyPng());
      const job = await pendingJob();
      script.statuses = ['COMPLETED'];
      const [a, b] = await Promise.all([checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0), checkJob(h.ctx, 'alice', job.jobId, depsFor(h), 0)]);
      expect([a.status, b.status].sort()).toEqual(['done', 'pending']);
      expect(quota().images.used).toBe(1);
    });
  });
});
