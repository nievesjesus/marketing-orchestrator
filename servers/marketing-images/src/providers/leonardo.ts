import { kindFromStatus, providerError, sanitizeDetail, type ProviderError } from './errors.js';
import { asString, downloadOutput, httpJson, isRecord, type HttpResult } from './http.js';
import type { AdapterDeps, AdapterRequest, Completed, JobHandle, PollResult, ProviderAdapter, RawOutput, StartResult } from './types.js';

/**
 * Leonardo.Ai: create with API v2, poll with API v1, download from cdn.leonardo.ai.
 *
 * Docs consulted 2026-10-11:
 *  - https://docs.leonardo.ai/reference/creategeneration.md  (v2 OpenAPI: `{model, parameters, public}`, response `{generationId, apiCreditCost}`,
 *    `guidances.image_reference[].image` = `{type: "URL"|"BASE64"|"UPLOADED"|..., url|data|id}`, at most 4 items)
 *  - https://docs.leonardo.ai/docs/lucid-origin.md · /docs/phoenix.md · /docs/flux-1-kontext-pro.md  (slugs, width/height ranges, quantity, parameters)
 *  - https://docs.leonardo.ai/docs/api-error-messages.md      (error bodies: flat `{error, path, code}` objects or `{errors:[{message, extensions:{code}}]}` lists)
 *  - https://docs.leonardo.ai/docs/api-faq                    (poll until status is COMPLETE or FAILED; PENDING with empty images means "not finished")
 *
 * Verified live in earlier work (not in the current docs; UNCONFIRMED against them):
 *  - the v1 `GET /generations/{id}` status endpoint (`generations_by_pk.status` PENDING|COMPLETE|FAILED, `generated_images[] {url, nsfw}`)
 *    and that it can answer 403/404 for a few seconds right after a v2 create;
 *  - the create response sometimes arrives wrapped, `{generate: {generationId, cost: {amount, unit: "DOLLARS"}}}`;
 *  - cdn.leonardo.ai rejects downloads without a browser-like User-Agent.
 */

const V2 = 'https://cloud.leonardo.ai/api/rest/v2';
const V1 = 'https://cloud.leonardo.ai/api/rest/v1';
const REQUEST_TIMEOUT_MS = 30_000;
/** A brand-new v2 job may be invisible to the v1 status endpoint for a short while. */
const NEW_JOB_GRACE_MS = 120_000;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class LeonardoAdapter implements ProviderAdapter {
  readonly id = 'leonardo' as const;

  constructor(private readonly deps: AdapterDeps) {}

  generate(req: AdapterRequest): Promise<StartResult> {
    return this.submit(req);
  }

  edit(req: AdapterRequest): Promise<StartResult> {
    return this.submit(req);
  }

  private async submit(req: AdapterRequest): Promise<StartResult> {
    const response = await this.call('POST', `${V2}/generations`, buildBody(req));
    if (!response.ok) throw this.classify(response);

    const created = parseCreated(response.json);
    if (!created) throw providerError('server', 'leonardo');
    const handle: JobHandle = {
      provider: 'leonardo',
      model: req.model.id,
      submittedAt: this.deps.now(),
      ref: { generation_id: created.generationId },
      ...(created.costUsd !== undefined ? { costUsd: created.costUsd } : {}),
    };
    return { state: 'pending', handle };
  }

  async poll(handle: JobHandle): Promise<PollResult> {
    const id = handle.ref.generation_id;
    if (!id) throw providerError('server', 'leonardo');
    const isNew = this.deps.now() - handle.submittedAt < NEW_JOB_GRACE_MS;

    const response = await this.call('GET', `${V1}/generations/${encodeURIComponent(id)}`);
    if (!response.ok) {
      if (isNew && (response.status === 403 || response.status === 404)) return { state: 'pending' };
      throw this.classify(response);
    }

    const generation = isRecord(response.json) && isRecord(response.json.generations_by_pk) ? response.json.generations_by_pk : undefined;
    if (!generation) {
      if (isNew) return { state: 'pending' };
      throw providerError('server', 'leonardo');
    }
    const status = asString(generation.status);
    if (status === 'FAILED') throw providerError('server', 'leonardo');
    if (status !== 'COMPLETE') return { state: 'pending' }; // PENDING, or anything not final yet

    const images = Array.isArray(generation.generated_images) ? generation.generated_images : [];
    const urls: string[] = [];
    let dropped = 0;
    for (const image of images) {
      const url = isRecord(image) ? asString(image.url) : undefined;
      if (isRecord(image) && image.nsfw === true) dropped += 1;
      else if (url) urls.push(url);
    }
    if (urls.length === 0) throw providerError(dropped > 0 ? 'safety' : 'no_image', 'leonardo');

    const outputs: RawOutput[] = await Promise.all(
      urls.map(async (url) => ({ data: await downloadOutput(this.deps.fetch, 'leonardo', url, { headers: { 'User-Agent': BROWSER_USER_AGENT } }) })),
    );
    const warnings = dropped > 0 ? [`${dropped} image${dropped === 1 ? ' was' : 's were'} removed by the provider's safety filter.`] : [];
    return { state: 'done', outputs, dropped, warnings, ...(handle.costUsd !== undefined ? { costUsd: handle.costUsd } : {}) } satisfies Completed;
  }

  private call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<HttpResult> {
    return httpJson(this.deps.fetch, 'leonardo', {
      method,
      url,
      headers: { Authorization: `Bearer ${this.deps.apiKey}` },
      ...(body !== undefined ? { body } : {}),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  private classify(response: HttpResult): ProviderError {
    const { message, code } = errorInfo(response.json);
    const text = `${message} ${code ?? ''} ${typeof response.json === 'string' ? response.json : ''}`;
    const status = response.status;

    if (/content moderation|inappropriate content|moderation filter|nsfw/i.test(text)) return providerError('safety', 'leonardo');
    if (/couldn'?t access image|could not access image|invalid init image|invalid image/i.test(text)) return providerError('bad_reference', 'leonardo');
    if (/insufficient|not enough|no (more )?credits|out of credits|run out of|api credits|balance|exceed\w* .*(credit|token)/i.test(text)) {
      return providerError('credits', 'leonardo');
    }
    if (/not supported within the production api/i.test(text)) return providerError('model_unavailable', 'leonardo');
    if (status === 401 || status === 403 || /access-denied|authorization hook|authentication hook|invalid api key|unauthori[sz]ed/i.test(text)) {
      return providerError('auth', 'leonardo');
    }

    const kind = kindFromStatus(status);
    if (kind === 'validation') {
      const detail = sanitizeDetail(message, [this.deps.apiKey]);
      return providerError('validation', 'leonardo', detail ? { detail } : {});
    }
    return providerError(kind, 'leonardo');
  }
}

/** Leonardo errors are a flat object, `{errors: [...]}`, or a bare JSON list (GraphQL style). */
export function errorInfo(json: unknown): { message: string; code?: string } {
  let first: unknown = json;
  if (Array.isArray(json)) first = json[0];
  else if (isRecord(json) && Array.isArray(json.errors)) first = json.errors[0];
  if (!isRecord(first)) return { message: typeof first === 'string' ? first : '' };
  const nested = isRecord(first.error) ? asString(first.error.message) : undefined;
  const extensions = isRecord(first.extensions) ? asString(first.extensions.code) : undefined;
  const message = asString(first.message) ?? asString(first.error) ?? nested ?? '';
  const code = asString(first.code) ?? extensions;
  return code ? { message, code } : { message };
}

/**
 * The create response, in both shapes seen in the wild: documented `{generationId, apiCreditCost}` and wrapped
 * `{generate: {generationId, cost: {amount, unit}}}`. The real cost is only taken when it is in dollars; credits
 * (`apiCreditCost`) have no published dollar price, so they leave the estimate in place.
 */
export function parseCreated(json: unknown): { generationId: string; costUsd?: number } | undefined {
  if (!isRecord(json)) return undefined;
  const inner = isRecord(json.generate) ? json.generate : isRecord(json.sdGenerationJob) ? json.sdGenerationJob : json;
  const generationId = asString(inner.generationId) ?? asString(json.generationId);
  if (!generationId) return undefined;
  const cost = isRecord(inner.cost) ? inner.cost : isRecord(json.cost) ? json.cost : undefined;
  const amount = cost ? Number(cost.amount) : Number.NaN;
  const unit = cost ? String(cost.unit ?? '').toUpperCase() : '';
  return unit === 'DOLLARS' && Number.isFinite(amount) && amount > 0 ? { generationId, costUsd: amount } : { generationId };
}

export function buildBody(req: AdapterRequest): Record<string, unknown> {
  const size = req.model.aspect[req.ratio ?? '1:1'];
  const parameters: Record<string, unknown> = { prompt: req.prompt, ...size, quantity: req.n };
  if (req.seed !== undefined && req.model.capabilities.seed) parameters.seed = req.seed;
  if (req.negativePrompt) parameters.negative_prompt = req.negativePrompt;
  if (req.images.length > 0 && req.model.ref_field === 'guidances.image_reference') {
    parameters.guidances = { image_reference: req.images.map((url) => ({ image: { type: 'URL', url } })) };
  }
  return { model: req.model.id, parameters, public: false };
}
