import { describe, expect, it } from 'vitest';
import { RATIOS, modelsFor } from '../src/models.js';
import { isProviderError } from '../src/providers/errors.js';
import { FalAdapter, buildInput } from '../src/providers/fal.js';
import type { JobHandle } from '../src/providers/types.js';
import { FAKE_KEYS, MockFetch, adapterDeps, imageResponse, jsonResponse, request, tinyPng } from './providerMocks.js';

const SCHNELL = 'fal-ai/flux/schnell';
const NANO = 'fal-ai/nano-banana-2';
const NANO_EDIT = 'fal-ai/nano-banana-2/edit';
const KONTEXT = 'fal-ai/flux-pro/kontext';

const adapterFor = (mock: MockFetch): FalAdapter => new FalAdapter(adapterDeps(mock, FAKE_KEYS.fal));

const submitResponse = (id = 'req-1', app = NANO) =>
  jsonResponse(200, {
    request_id: id,
    response_url: `https://queue.fal.run/${app}/requests/${id}`,
    status_url: `https://queue.fal.run/${app}/requests/${id}/status`,
    cancel_url: `https://queue.fal.run/${app}/requests/${id}/cancel`,
    queue_position: 0,
  });

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (isProviderError(err)) return err;
    throw err;
  }
  throw new Error('expected a ProviderError');
}

async function submitted(mock: MockFetch, modelId: string, over = {}): Promise<JobHandle> {
  mock.route('queue.fal.run/' + modelId, () => submitResponse('req-1', modelId), 'POST');
  const started = await adapterFor(mock).generate(request(modelId, over));
  if (started.state !== 'pending') throw new Error('fal always queues');
  return started.handle;
}

describe('fal submit', () => {
  it('POSTs the model input to queue.fal.run/{model} with "Authorization: Key ..." and keeps the returned URLs verbatim', async () => {
    const mock = new MockFetch();
    const handle = await submitted(mock, NANO, { prompt: 'a red bicycle', ratio: '9:16', n: 2, seed: 7, size: '2K' });

    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`https://queue.fal.run/${NANO}`);
    expect(call.headers.authorization).toBe(`Key ${FAKE_KEYS.fal}`);
    expect(call.url).not.toContain(FAKE_KEYS.fal);
    expect(call.body).toEqual({ prompt: 'a red bicycle', num_images: 2, aspect_ratio: '9:16', seed: 7, resolution: '2K' });

    expect(handle.provider).toBe('fal');
    expect(handle.model).toBe(NANO);
    expect(handle.ref).toEqual({
      request_id: 'req-1',
      status_url: `https://queue.fal.run/${NANO}/requests/req-1/status`,
      response_url: `https://queue.fal.run/${NANO}/requests/req-1`,
    });
  });

  it('uses the reference field declared in models.ts: image_urls[] for nano-banana-2/edit, image_url for Kontext, nothing for text-to-image', () => {
    const edit = buildInput(request(NANO_EDIT, { task: 'edit', images: ['https://x.test/a.png', 'https://x.test/b.png'] }));
    expect(edit.image_urls).toEqual(['https://x.test/a.png', 'https://x.test/b.png']);
    expect('image_url' in edit).toBe(false);

    const kontext = buildInput(request(KONTEXT, { task: 'edit', images: ['https://x.test/a.png'] }));
    expect(kontext.image_url).toBe('https://x.test/a.png');
    expect('image_urls' in kontext).toBe(false);

    const t2i = buildInput(request(NANO));
    expect('image_url' in t2i || 'image_urls' in t2i).toBe(false);
  });

  it('FLUX schnell gets an explicit image_size object and keeps its safety checker on', () => {
    const input = buildInput(request(SCHNELL, { ratio: '4:5', n: 3 }));
    expect(input).toEqual({ prompt: 'a red bicycle', num_images: 3, image_size: { width: 912, height: 1136 }, enable_safety_checker: true });
  });

  it('only sends resolution for "K" size tokens the model lists; seeds only to models that take one', () => {
    expect(buildInput(request(SCHNELL, { size: '2K' })).resolution).toBeUndefined();
    expect(buildInput(request(KONTEXT, { task: 'edit', images: ['https://x.test/a.png'], size: '1K' })).resolution).toBeUndefined();
    expect(buildInput(request(NANO, { size: '1K' })).resolution).toBe('1K');
    expect(buildInput(request(NANO, { size: '4K' })).resolution).toBeUndefined();
    expect(buildInput(request(NANO, { seed: 0 })).seed).toBe(0);
  });

  it.each(modelsFor('fal').flatMap((m) => RATIOS.map((r) => [m.id, r] as const)))('%s maps ratio %s from the catalog into the request', (modelId, ratio) => {
    const input = buildInput(request(modelId, { ratio }));
    const params = modelsFor('fal').find((m) => m.id === modelId)!.aspect[ratio];
    for (const [key, value] of Object.entries(params)) expect(input[key]).toEqual(value);
    if (modelId === KONTEXT && ratio === '4:5') expect(input.aspect_ratio).toBe('3:4');
    if (modelId === NANO || modelId === NANO_EDIT) expect(input.aspect_ratio).toBe(ratio);
    if (modelId === SCHNELL) {
      const { width, height } = input.image_size as { width: number; height: number };
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
    }
  });

  it('an edit without a ratio sends no aspect_ratio (fal keeps the input image shape)', () => {
    const req = request(NANO_EDIT, { task: 'edit', images: ['https://x.test/a.png'] });
    delete (req as { ratio?: unknown }).ratio;
    expect(buildInput(req).aspect_ratio).toBeUndefined();
  });

  it('refuses status/response URLs that are not fal hosts, so the key never goes elsewhere', async () => {
    const mock = new MockFetch().route('queue.fal.run', () => jsonResponse(200, { request_id: 'x', status_url: 'https://evil.example.test/status', response_url: 'https://queue.fal.run/a/requests/x' }));
    const err = await failureOf(adapterFor(mock).generate(request(NANO)));
    expect(err.kind).toBe('server');
    expect(mock.calls).toHaveLength(1);
  });

  it('refuses a handle whose URLs were tampered with before polling', async () => {
    const mock = new MockFetch();
    const handle = await submitted(mock, NANO);
    const tampered: JobHandle = { ...handle, ref: { ...handle.ref, status_url: 'http://127.0.0.1:8080/steal' } };
    const err = await failureOf(adapterFor(mock).poll(tampered));
    expect(err.kind).toBe('server');
    expect(mock.calls).toHaveLength(1); // only the submit
  });
});

describe('fal polling and results', () => {
  const doneBody = (images: unknown[], extra: Record<string, unknown> = {}) => ({ images, description: '', ...extra });

  it('IN_QUEUE and IN_PROGRESS are pending; COMPLETED reads response_url verbatim and downloads without credentials', async () => {
    const mock = new MockFetch();
    // A sub-route app id: the status/result URLs point at the base app, not at ".../edit".
    mock.route('queue.fal.run/' + NANO_EDIT, () => jsonResponse(200, {
      request_id: 'r9',
      status_url: 'https://queue.fal.run/fal-ai/nano-banana-2/requests/r9/status',
      response_url: 'https://queue.fal.run/fal-ai/nano-banana-2/requests/r9',
    }), 'POST');
    const started = await adapterFor(mock).edit(request(NANO_EDIT, { task: 'edit', images: ['https://x.test/a.png'] }));
    if (started.state !== 'pending') throw new Error('expected pending');

    const statuses = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'];
    mock.route('/requests/r9/status', () => jsonResponse(200, { status: statuses.shift() }));
    const png = await tinyPng();
    mock.route('/requests/r9', () => jsonResponse(200, doneBody([{ url: 'https://v3.fal.media/files/a.png', width: 64, height: 80, content_type: 'image/png' }])));
    mock.route('v3.fal.media/files/a.png', () => imageResponse(png));

    const adapter = adapterFor(mock);
    expect((await adapter.poll(started.handle)).state).toBe('pending');
    expect((await adapter.poll(started.handle)).state).toBe('pending');
    const done = await adapter.poll(started.handle);
    expect(done.state).toBe('done');
    if (done.state === 'done') {
      expect(done.outputs).toHaveLength(1);
      expect(done.outputs[0]!.data.equals(png)).toBe(true);
      expect(done.dropped).toBe(0);
    }

    const urls = mock.calls.map((c) => c.url);
    expect(urls).toContain('https://queue.fal.run/fal-ai/nano-banana-2/requests/r9/status');
    expect(urls).toContain('https://queue.fal.run/fal-ai/nano-banana-2/requests/r9');
    const download = mock.calls.find((c) => c.url.includes('v3.fal.media'))!;
    expect(download.headers.authorization).toBeUndefined(); // the key never goes to the file host
    const status = mock.calls.find((c) => c.url.endsWith('/status'))!;
    expect(status.headers.authorization).toBe(`Key ${FAKE_KEYS.fal}`);
  });

  it('drops images flagged by has_nsfw_concepts, reports how many, and refuses when all are flagged', async () => {
    const png = await tinyPng();
    const run = async (flags: boolean[]) => {
      const mock = new MockFetch();
      const handle = await submitted(mock, NANO);
      mock.route('/status', () => jsonResponse(200, { status: 'COMPLETED' }));
      mock.route('/requests/req-1', () => jsonResponse(200, doneBody(flags.map((_f, i) => ({ url: `https://v3.fal.media/files/${i}.png` })), { has_nsfw_concepts: flags })));
      mock.route('v3.fal.media', () => imageResponse(png));
      return adapterFor(mock).poll(handle);
    };

    const partial = await run([false, true, false]);
    expect(partial.state === 'done' && partial.outputs.length).toBe(2);
    if (partial.state === 'done') {
      expect(partial.dropped).toBe(1);
      expect(partial.warnings.join(' ')).toMatch(/1 image was removed/);
    }

    const err = await failureOf(run([true, true]));
    expect(err.kind).toBe('safety');
  });

  it('a 422 content_policy_violation (on submit or on the result) is a safety refusal', async () => {
    const violation = { detail: [{ loc: ['body', 'prompt'], msg: 'blocked', type: 'content_policy_violation', url: 'https://docs.fal.ai/x', ctx: {}, input: 'secret prompt text' }] };

    const onSubmit = new MockFetch().route('queue.fal.run', () => jsonResponse(422, violation));
    const submitError = await failureOf(adapterFor(onSubmit).generate(request(NANO)));
    expect(submitError.kind).toBe('safety');
    expect(submitError.toToolText()).not.toContain('secret prompt text');

    const onResult = new MockFetch();
    const handle = await submitted(onResult, NANO);
    onResult.route('/status', () => jsonResponse(200, { status: 'COMPLETED' }));
    onResult.route('/requests/req-1', () => jsonResponse(422, violation));
    expect((await failureOf(adapterFor(onResult).poll(handle))).kind).toBe('safety');
  });

  it('a COMPLETED status that carries error / error_type is a failed run', async () => {
    const run = async (body: Record<string, unknown>) => {
      const mock = new MockFetch();
      const handle = await submitted(mock, NANO);
      mock.route('/status', () => jsonResponse(200, { status: 'COMPLETED', ...body }));
      return failureOf(adapterFor(mock).poll(handle));
    };
    expect((await run({ error: 'Content policy violation', error_type: 'content_policy_violation' })).kind).toBe('safety');
    expect((await run({ error: 'Request timed out', error_type: 'request_timeout' })).kind).toBe('timeout');
    expect((await run({ error: 'runner died', error_type: 'runner_disconnected' })).kind).toBe('server');
  });

  it('an answer with no images and no flags is "no image"', async () => {
    const mock = new MockFetch();
    const handle = await submitted(mock, NANO);
    mock.route('/status', () => jsonResponse(200, { status: 'COMPLETED' }));
    mock.route('/requests/req-1', () => jsonResponse(200, doneBody([])));
    expect((await failureOf(adapterFor(mock).poll(handle))).kind).toBe('no_image');
  });

  it('refuses to download an output from a non-https or private address', async () => {
    for (const url of ['http://v3.fal.media/files/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png']) {
      const mock = new MockFetch();
      const handle = await submitted(mock, NANO);
      mock.route('/status', () => jsonResponse(200, { status: 'COMPLETED' }));
      mock.route('/requests/req-1', () => jsonResponse(200, doneBody([{ url }])));
      expect((await failureOf(adapterFor(mock).poll(handle))).kind, url).toBe('server');
      expect(mock.callsTo('127.0.0.1')).toHaveLength(0);
    }
  });
});

describe('fal error mapping', () => {
  const submitFailure = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const mock = new MockFetch().route('queue.fal.run', () => jsonResponse(status, body, headers));
    return failureOf(adapterFor(mock).generate(request(NANO)));
  };

  it('401 is auth; 403 "locked / exhausted balance" is credits; 402 is credits', async () => {
    expect((await submitFailure(401, { detail: 'Invalid key' })).kind).toBe('auth');
    expect((await submitFailure(403, { detail: 'User is locked. Reason: Exhausted balance. Top up at fal.ai/dashboard/billing.' })).kind).toBe('credits');
    expect((await submitFailure(403, { detail: 'Forbidden' })).kind).toBe('auth');
    expect((await submitFailure(402, {})).kind).toBe('credits');
  });

  it('429 is rate_limit, 5xx is server, 504 / timeout error types are timeout', async () => {
    expect((await submitFailure(429, { detail: 'slow down' })).kind).toBe('rate_limit');
    expect((await submitFailure(500, { detail: 'boom', error_type: 'internal_error' })).kind).toBe('server');
    expect((await submitFailure(503, { detail: 'x', error_type: 'runner_scheduling_failure' })).kind).toBe('server');
    expect((await submitFailure(504, { detail: 'Request timed out', error_type: 'request_timeout' })).kind).toBe('timeout');
    expect((await submitFailure(504, { detail: 'x' }, { 'x-fal-error-type': 'startup_timeout' })).kind).toBe('timeout');
  });

  it('422 file / image problems are a bad reference; other 422s are validation with a sanitized detail', async () => {
    expect((await submitFailure(422, { detail: [{ loc: ['body', 'image_url'], msg: 'Failed to download', type: 'file_download_error' }] })).kind).toBe('bad_reference');
    expect((await submitFailure(422, { detail: [{ loc: ['body', 'image_urls', 0], msg: 'too big', type: 'image_too_large' }] })).kind).toBe('bad_reference');
    const err = await submitFailure(422, { detail: [{ loc: ['body', 'prompt'], msg: `Prompt too short, see https://fal.ai/docs ${FAKE_KEYS.fal}`, type: 'value_error' }] });
    expect(err.kind).toBe('validation');
    expect(err.toToolText()).toMatch(/Prompt too short/);
    expect(err.toToolText()).not.toMatch(/https?:/);
    expect(err.toToolText()).not.toContain(FAKE_KEYS.fal);
    expect((await submitFailure(422, { detail: [{ type: 'no_media_generated', msg: 'nothing' }] })).kind).toBe('no_image');
  });

  it('network failures map to network', async () => {
    const mock = new MockFetch().on(() => {
      throw new TypeError('fetch failed');
    });
    expect((await failureOf(adapterFor(mock).generate(request(NANO)))).kind).toBe('network');
  });
});
