import { kindFromStatus, providerError, sanitizeDetail, type ProviderError } from './errors.js';
import { asString, assertPublicHttps, downloadOutput, httpJson, isRecord, type HttpResult } from './http.js';
import type { AdapterDeps, AdapterRequest, Completed, JobHandle, PollResult, ProviderAdapter, RawOutput, StartResult } from './types.js';

/**
 * fal.ai queue API. Submit, then poll the status URL, then read the result URL.
 *
 * Docs consulted 2026-10-11:
 *  - https://fal.ai/docs/model-apis/model-endpoints/queue        (submit/status/result/cancel, IN_QUEUE|IN_PROGRESS|COMPLETED, `error`/`error_type` on COMPLETED)
 *  - https://fal.ai/docs/documentation/model-apis/errors         (422 detail[] with type "content_policy_violation", request-level errors with `error_type`)
 *  - https://fal.ai/docs/documentation/model-apis/authentication (Authorization: Key <FAL_KEY>)
 *  - per-model input/output schemas: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<model id>
 *    (the id of the image field, `image_url` vs `image_urls`, is DATA in models.ts: `ref_field`)
 *
 * `status_url` and `response_url` are used verbatim: the docs say sub-route app ids resolve to the base app, so
 * rebuilding the URL from the model id would be wrong for some endpoints. Because our key is sent to those URLs
 * they must point at fal's own hosts; anything else is refused.
 */

const QUEUE = 'https://queue.fal.run';
const REQUEST_TIMEOUT_MS = 30_000;

const isFalHost = (host: string): boolean => host === 'fal.run' || host.endsWith('.fal.run') || host === 'fal.ai' || host.endsWith('.fal.ai');

/** 422 types that mean "one of your input images could not be used". */
const BAD_REFERENCE_TYPE = /download|image_load|image_too|unsupported_image|invalid_image|image_url|file_/i;

export class FalAdapter implements ProviderAdapter {
  readonly id = 'fal' as const;

  constructor(private readonly deps: AdapterDeps) {}

  generate(req: AdapterRequest): Promise<StartResult> {
    return this.submit(req);
  }

  edit(req: AdapterRequest): Promise<StartResult> {
    return this.submit(req);
  }

  private async submit(req: AdapterRequest): Promise<StartResult> {
    const response = await this.call('POST', `${QUEUE}/${req.model.id}`, buildInput(req));
    if (!response.ok) throw this.classify(response);

    const json = response.json;
    const requestId = isRecord(json) ? asString(json.request_id) : undefined;
    const statusUrl = isRecord(json) ? asString(json.status_url) : undefined;
    const responseUrl = isRecord(json) ? asString(json.response_url) : undefined;
    if (!requestId || !statusUrl || !responseUrl) throw providerError('server', 'fal');
    assertPublicHttps('fal', statusUrl, isFalHost);
    assertPublicHttps('fal', responseUrl, isFalHost);

    const handle: JobHandle = {
      provider: 'fal',
      model: req.model.id,
      submittedAt: this.deps.now(),
      ref: { request_id: requestId, status_url: statusUrl, response_url: responseUrl },
    };
    return { state: 'pending', handle };
  }

  async poll(handle: JobHandle): Promise<PollResult> {
    const statusUrl = handle.ref.status_url;
    const responseUrl = handle.ref.response_url;
    if (!statusUrl || !responseUrl) throw providerError('server', 'fal');
    assertPublicHttps('fal', statusUrl, isFalHost);
    assertPublicHttps('fal', responseUrl, isFalHost);

    const status = await this.call('GET', statusUrl);
    if (!status.ok) throw this.classify(status);
    const body = isRecord(status.json) ? status.json : {};
    if (body.status !== 'COMPLETED') return { state: 'pending' }; // IN_QUEUE | IN_PROGRESS

    // A run that failed is reported as COMPLETED with `error` / `error_type`.
    if (asString(body.error) || asString(body.error_type)) throw this.failedRun(body);

    const result = await this.call('GET', responseUrl);
    if (!result.ok) throw this.classify(result);
    return this.parseResult(result.json);
  }

  private async parseResult(json: unknown): Promise<Completed> {
    const images = isRecord(json) && Array.isArray(json.images) ? json.images : [];
    const flags = isRecord(json) && Array.isArray(json.has_nsfw_concepts) ? json.has_nsfw_concepts : [];

    const urls: string[] = [];
    let dropped = 0;
    images.forEach((image: unknown, index: number) => {
      const url = isRecord(image) ? asString(image.url) : undefined;
      if (flags[index] === true) dropped += 1; // flagged by fal's safety checker: never handed on
      else if (url) urls.push(url);
    });
    if (urls.length === 0) throw providerError(dropped > 0 ? 'safety' : 'no_image', 'fal');

    // fal file URLs are not ours to keep: copy the bytes now (the caller stores them in our own storage).
    const outputs: RawOutput[] = await Promise.all(
      urls.map(async (url) => ({ data: await downloadOutput(this.deps.fetch, 'fal', url) })),
    );
    const warnings = dropped > 0 ? [`${dropped} image${dropped === 1 ? ' was' : 's were'} removed by the provider's safety filter.`] : [];
    return { state: 'done', outputs, dropped, warnings };
  }

  private call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<HttpResult> {
    return httpJson(this.deps.fetch, 'fal', {
      method,
      url,
      headers: { Authorization: `Key ${this.deps.apiKey}` },
      ...(body !== undefined ? { body } : {}),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  private failedRun(body: Record<string, unknown>): ProviderError {
    const type = asString(body.error_type) ?? '';
    const text = `${type} ${asString(body.error) ?? ''}`;
    if (/content_policy|nsfw|safety|moderat/i.test(text)) return providerError('safety', 'fal');
    if (/timeout/i.test(type)) return providerError('timeout', 'fal');
    if (/bad_request|validation/i.test(type)) {
      const detail = sanitizeDetail(asString(body.error), [this.deps.apiKey]);
      return providerError('validation', 'fal', detail ? { detail } : {});
    }
    return providerError('server', 'fal');
  }

  private classify(response: HttpResult): ProviderError {
    const json = response.json;
    const detail = isRecord(json) ? json.detail : undefined;
    const entries = Array.isArray(detail) ? detail.filter(isRecord) : [];
    const types = entries.map((entry) => asString(entry.type) ?? '');
    const errorType = response.headers.get('x-fal-error-type') ?? (isRecord(json) ? asString(json.error_type) : undefined) ?? '';

    if (types.includes('content_policy_violation')) return providerError('safety', 'fal');
    if (types.includes('no_media_generated')) return providerError('no_image', 'fal');
    if (types.some((type) => BAD_REFERENCE_TYPE.test(type))) return providerError('bad_reference', 'fal');

    const status = response.status;
    if (status === 401 || status === 403) {
      // A locked account (balance below the lock threshold) answers 403; an unknown key answers 401.
      return /locked|exhaust|balance|top ?up|billing|credit/i.test(response.text) ? providerError('credits', 'fal') : providerError('auth', 'fal');
    }
    if (/timeout/i.test(errorType) && status >= 500) return providerError('timeout', 'fal');

    const kind = kindFromStatus(status);
    if (kind === 'validation') {
      const first = entries.map((entry) => asString(entry.msg)).find((msg) => msg !== undefined);
      const text = first ?? (typeof detail === 'string' ? detail : undefined);
      const clean = sanitizeDetail(text, [this.deps.apiKey]);
      return providerError('validation', 'fal', clean ? { detail: clean } : {});
    }
    return providerError(kind, 'fal');
  }
}

/** Model input: prompt + the per-ratio fragment from models.ts + optional reference image field (also data). */
export function buildInput(req: AdapterRequest): Record<string, unknown> {
  const params = req.ratio ? req.model.aspect[req.ratio] : {};
  const input: Record<string, unknown> = { prompt: req.prompt, num_images: req.n, ...params };

  if (req.seed !== undefined && req.model.capabilities.seed) input.seed = req.seed;
  if (req.size && req.model.sizes.includes(req.size) && /^\d(\.\d)?K$/.test(req.size)) input.resolution = req.size;
  // FLUX text-to-image models take an explicit {width,height}; keep their safety checker on (it is the schema default).
  if ('image_size' in params) input.enable_safety_checker = true;

  if (req.images.length > 0) {
    if (req.model.ref_field === 'image_urls') input.image_urls = req.images;
    else if (req.model.ref_field === 'image_url') input.image_url = req.images[0];
  }
  return input;
}
