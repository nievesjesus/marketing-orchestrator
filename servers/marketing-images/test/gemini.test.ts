import { describe, expect, it } from 'vitest';
import { RATIOS, modelsFor } from '../src/models.js';
import { isProviderError } from '../src/providers/errors.js';
import { GeminiAdapter, findImages } from '../src/providers/gemini.js';
import { FAKE_KEYS, MockFetch, adapterDeps, jsonResponse, request, tinyPngBase64 } from './providerMocks.js';

const MODEL = 'gemini-3.1-flash-image';
const OK_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const adapterFor = (mock: MockFetch, over = {}): GeminiAdapter => new GeminiAdapter(adapterDeps(mock, FAKE_KEYS.gemini, over));

const okBody = async (parts?: unknown[]): Promise<unknown> => ({
  candidates: [{ content: { parts: parts ?? [{ text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: await tinyPngBase64() } }] }, finishReason: 'STOP' }],
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

describe('Gemini request shape', () => {
  it('POSTs generateContent with the x-goog-api-key header and the documented body', async () => {
    const mock = new MockFetch().route(':generateContent', async () => jsonResponse(200, await okBody()));
    const result = await adapterFor(mock).generate(request(MODEL, { prompt: 'a lighthouse at dawn', ratio: '4:5', size: '2K' }));

    expect(result.state).toBe('done');
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(OK_URL);
    expect(call.headers['x-goog-api-key']).toBe(FAKE_KEYS.gemini);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.url).not.toContain(FAKE_KEYS.gemini); // never in the URL
    expect(call.body.contents[0].role).toBe('user');
    expect(call.body.contents[0].parts).toEqual([{ text: 'a lighthouse at dawn' }]);
    expect(call.body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:5', imageSize: '2K' } });
  });

  it('sends reference images inline after the prompt, in order', async () => {
    const mock = new MockFetch().route(':generateContent', async () => jsonResponse(200, await okBody()));
    const loaded: string[] = [];
    const adapter = adapterFor(mock, {
      loadImage: async (url: string) => {
        loaded.push(url);
        return { mime: url.endsWith('.jpg') ? 'image/jpeg' : 'image/png', base64: `b64-of-${url}`, bytes: 10 };
      },
    });
    await adapter.edit(request(MODEL, { task: 'edit', images: ['https://x.test/photo.jpg', 'https://x.test/logo.png'] }));
    const parts = mock.calls[0]!.body.contents[0].parts;
    expect(loaded).toEqual(['https://x.test/photo.jpg', 'https://x.test/logo.png']);
    expect(parts[0]).toEqual({ text: 'a red bicycle' });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'b64-of-https://x.test/photo.jpg' } });
    expect(parts[2]).toEqual({ inlineData: { mimeType: 'image/png', data: 'b64-of-https://x.test/logo.png' } });
  });

  it('an edit without a ratio keeps the photo shape: no aspectRatio, and no imageConfig at all when no size either', async () => {
    const mock = new MockFetch().route(':generateContent', async () => jsonResponse(200, await okBody()));
    const req = request(MODEL, { task: 'edit', images: ['https://x.test/photo.png'] });
    delete (req as { ratio?: unknown }).ratio;
    await adapterFor(mock).edit(req);
    expect(mock.calls[0]!.body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] });
  });

  it.each(modelsFor('gemini').flatMap((m) => RATIOS.map((r) => [m.id, r] as const)))('%s passes ratio %s through unchanged', async (modelId, ratio) => {
    const mock = new MockFetch().route(':generateContent', async () => jsonResponse(200, await okBody()));
    await adapterFor(mock).generate(request(modelId, { ratio }));
    expect(mock.calls[0]!.url).toContain(`/models/${modelId}:generateContent`);
    expect(mock.calls[0]!.body.generationConfig.imageConfig.aspectRatio).toBe(ratio);
  });

  it('does not send a size the model does not list', async () => {
    const mock = new MockFetch().route(':generateContent', async () => jsonResponse(200, await okBody()));
    await adapterFor(mock).generate(request(MODEL, { size: '4K' }));
    expect(mock.calls[0]!.body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
  });

  it('makes n pictures with n parallel requests', async () => {
    const mock = new MockFetch().route(':generateContent', async () => jsonResponse(200, await okBody()));
    const result = await adapterFor(mock).generate(request(MODEL, { n: 3 }));
    expect(mock.calls).toHaveLength(3);
    expect(result.state === 'done' && result.outputs.length).toBe(3);
  });

  it('keeps the good pictures and warns when only some requests fail', async () => {
    let calls = 0;
    const mock = new MockFetch().route(':generateContent', async () => (++calls === 2 ? jsonResponse(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }) : jsonResponse(200, await okBody())));
    const result = await adapterFor(mock).generate(request(MODEL, { n: 3 }));
    expect(result.state).toBe('done');
    if (result.state === 'done') {
      expect(result.outputs).toHaveLength(2);
      expect(result.warnings.join(' ')).toMatch(/2 of 3/);
    }
  });
});

describe('Gemini response walker (port of _find_images)', () => {
  const png = 'QUJD'; // base64 of "ABC"

  it('finds inlineData and inline_data blobs anywhere', () => {
    expect(findImages({ candidates: [{ content: { parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/jpeg', data: png } }] } }] })).toEqual([{ mime: 'image/jpeg', data: png }]);
    expect(findImages({ parts: [{ inline_data: { mime_type: 'image/webp', data: 'REVG' } }] })).toEqual([{ mime: 'image/webp', data: 'REVG' }]);
    expect(findImages({ deeply: { nested: [[{ inlineData: { data: png } }]] } })).toEqual([{ mime: 'image/png', data: png }]);
  });

  it('skips interim "thinking" images (thought: true parts and type: thought steps)', () => {
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, inlineData: { mimeType: 'image/png', data: 'VEhPVUdIVA==' } },
              { inlineData: { mimeType: 'image/png', data: png } },
            ],
          },
        },
      ],
      steps: [
        { type: 'thought', summary: [{ type: 'image', data: 'SU5URVJJTQ==' }] },
        { type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: 'RklOQUw=' }] },
      ],
    };
    expect(findImages(body).map((i) => i.data)).toEqual([png, 'RklOQUw=']);
  });

  it('reads the Interactions shape and drops the duplicate output_image shortcut', () => {
    const block = { type: 'image', mime_type: 'image/png', data: png };
    expect(findImages({ steps: [{ type: 'model_output', content: [block] }], output_image: block })).toEqual([{ mime: 'image/png', data: png }]);
  });

  it('ignores non-image blobs and empty data', () => {
    expect(findImages({ parts: [{ inlineData: { mimeType: 'audio/wav', data: png } }, { inlineData: { mimeType: 'image/png', data: '' } }] })).toEqual([]);
  });
});

describe('Gemini safety and empty answers', () => {
  const noImage = (extra: Record<string, unknown>) => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'I cannot do that.' }] }, ...extra }] });

  it.each(['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'NO_IMAGE'])('finishReason %s with no image is a safety refusal', async (finishReason) => {
    const mock = new MockFetch().route(':generateContent', () => noImage({ finishReason }));
    const err = await failureOf(adapterFor(mock).generate(request(MODEL)));
    expect(err.kind).toBe('safety');
    expect(err.message).toMatch(/safety/i);
    expect(mock.calls).toHaveLength(1); // no retry on the other endpoint
  });

  it('promptFeedback.blockReason is a safety refusal', async () => {
    const mock = new MockFetch().route(':generateContent', () => jsonResponse(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
    expect((await failureOf(adapterFor(mock).generate(request(MODEL)))).kind).toBe('safety');
  });

  it('an unspecified block reason or a plain STOP without an image is just "no image"', async () => {
    const unspecified = new MockFetch().route(':generateContent', () => jsonResponse(200, { promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' }, candidates: [{ finishReason: 'STOP' }] }));
    expect((await failureOf(adapterFor(unspecified).generate(request(MODEL)))).kind).toBe('no_image');
    const other = new MockFetch().route(':generateContent', () => noImage({ finishReason: 'OTHER' }));
    expect((await failureOf(adapterFor(other).generate(request(MODEL)))).kind).toBe('no_image');
  });

  it('returns images even when finishReason says something else', async () => {
    const mock = new MockFetch().route(':generateContent', async () => jsonResponse(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [{ inlineData: { mimeType: 'image/png', data: await tinyPngBase64() } }] } }] }));
    expect((await adapterFor(mock).generate(request(MODEL))).state).toBe('done');
  });
});

describe('Gemini Interactions API fallback', () => {
  it.each([400, 404])('a %i from generateContent retries on POST /v1beta/interactions with the same auth', async (status) => {
    const mock = new MockFetch()
      .route(':generateContent', () => jsonResponse(status, { error: { code: status, status: status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT', message: 'model does not support this method' } }))
      .route('/interactions', async () =>
        jsonResponse(200, { steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: await tinyPngBase64() }] }] }),
      );
    const result = await adapterFor(mock).generate(request('gemini-nano-banana-2.1', { ratio: '9:16', size: '1K', prompt: 'x', images: ['https://x.test/a.png'] }));

    expect(result.state).toBe('done');
    expect(mock.calls).toHaveLength(2);
    const second = mock.calls[1]!;
    expect(second.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(second.headers['x-goog-api-key']).toBe(FAKE_KEYS.gemini);
    expect(second.body).toEqual({
      model: 'gemini-nano-banana-2.1',
      input: [
        { type: 'text', text: 'x' },
        { type: 'image', mime_type: 'image/png', data: 'AAAA' },
      ],
      response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: '9:16', image_size: '1K' },
      store: false,
    });
  });

  it('reports the second endpoint\'s error when both fail', async () => {
    const mock = new MockFetch()
      .route(':generateContent', () => jsonResponse(404, { error: { message: 'not found', status: 'NOT_FOUND' } }))
      .route('/interactions', () => jsonResponse(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }));
    const err = await failureOf(adapterFor(mock).generate(request(MODEL)));
    expect(err.kind).toBe('rate_limit');
    expect(mock.calls).toHaveLength(2);
  });

  it('an Interactions safety code is a safety refusal', async () => {
    const mock = new MockFetch()
      .route(':generateContent', () => jsonResponse(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad' } }))
      .route('/interactions', () => jsonResponse(400, { error: { code: 'image_safety', message: 'blocked' } }));
    expect((await failureOf(adapterFor(mock).generate(request(MODEL)))).kind).toBe('safety');
  });

  it('does NOT fall back for auth problems, including the 400 API_KEY_INVALID quirk', async () => {
    const mock = new MockFetch().route(':generateContent', () =>
      jsonResponse(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }),
    );
    const err = await failureOf(adapterFor(mock).generate(request(MODEL)));
    expect(err.kind).toBe('auth');
    expect(mock.calls).toHaveLength(1);
  });
});

describe('Gemini error mapping', () => {
  const cases: [string, number, unknown, string][] = [
    ['401', 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad' } }, 'auth'],
    ['403', 403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no' } }, 'auth'],
    ['400 FAILED_PRECONDITION (billing/region)', 400, { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'billing is not enabled' } }, 'auth'],
    ['402 payment required', 402, { error: { code: 'payment_required', message: 'prepay depleted' } }, 'credits'],
    ['429 RESOURCE_EXHAUSTED', 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 'rate_limit'],
    ['429 with depleted prepay credits', 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted' } }, 'credits'],
    ['500', 500, { error: { code: 500, status: 'INTERNAL', message: 'oops' } }, 'server'],
    ['503', 503, { error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }, 'server'],
    ['504', 504, { error: { code: 504, status: 'DEADLINE_EXCEEDED', message: 'slow' } }, 'timeout'],
  ];
  it.each(cases)('%s -> %s', async (_label, status, body, kind) => {
    const mock = new MockFetch().route(':generateContent', () => jsonResponse(status, body)).route('/interactions', () => jsonResponse(status, body));
    expect((await failureOf(adapterFor(mock).generate(request(MODEL)))).kind).toBe(kind);
  });

  it('a transport failure is a network error and a timeout is a timeout', async () => {
    const down = new MockFetch().on(() => {
      throw new TypeError('fetch failed');
    });
    expect((await failureOf(adapterFor(down).generate(request(MODEL)))).kind).toBe('network');
    const slow = new MockFetch().on(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect((await failureOf(adapterFor(slow).generate(request(MODEL)))).kind).toBe('timeout');
  });

  it('shows a sanitized detail for validation errors and never the key or a link', async () => {
    const message = `Invalid value at 'contents' using key ${FAKE_KEYS.gemini}; see https://ai.google.dev/docs?key=${FAKE_KEYS.gemini}`;
    const mock = new MockFetch().route(':generateContent', () => jsonResponse(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message } })).route('/interactions', () => jsonResponse(400, { error: { code: 'invalid_request', message } }));
    const err = await failureOf(adapterFor(mock).generate(request(MODEL)));
    expect(err.kind).toBe('validation');
    expect(err.toToolText()).not.toContain(FAKE_KEYS.gemini);
    expect(err.toToolText()).not.toMatch(/https?:/);
  });
});
