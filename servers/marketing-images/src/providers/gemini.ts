import { UserFacingError } from '../errors.js';
import { isProviderError, kindFromStatus, providerError, sanitizeDetail, type ProviderError } from './errors.js';
import { asString, httpJson, isRecord, type HttpResult } from './http.js';
import type { AdapterDeps, AdapterRequest, Completed, JobHandle, LoadedImage, PollResult, ProviderAdapter, RawOutput, StartResult } from './types.js';

/**
 * Google Gemini image models (Nano Banana family). Synchronous: one request returns the image.
 *
 * Docs consulted 2026-10-11:
 *  - https://ai.google.dev/gemini-api/docs/image-generation  (model ids, sizes 512/1K/2K/4K, reference limits; the page now documents the Interactions API)
 *  - https://ai.google.dev/api/generate-content               (generateContent request/response, Part.inlineData {mimeType,data}, FinishReason and BlockReason enums, ImageConfig {aspectRatio,imageSize})
 *  - https://ai.google.dev/gemini-api/docs/api-errors         (error codes; invalid keys are reported as 400 API_KEY_INVALID on generateContent)
 *  - https://ai.google.dev/gemini-api/docs/pricing            (per-image prices live in models.ts)
 *
 * Primary path: POST {BASE}/models/{model}:generateContent with `x-goog-api-key`.
 * Fallback (same as tools/scripts/mktlib/gemini.py): on a 400/404 that is not an auth problem, the same request is
 * sent to POST {BASE}/interactions, which is what the current docs show for the newest models.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini cannot hand over a job id, so a slow request is awaited this long (DESIGN section 8). */
export const GEMINI_MAX_WAIT_MS = 120_000;

/** References travel inline (base64) in a request limited to about 20 MB: keep well below it. */
export const MAX_INLINE_REFERENCE_BYTES = 14 * 1024 * 1024;

/** finishReason values (generateContent) that mean "the model refused or the image was blocked". */
const SAFETY_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'NO_IMAGE',
  'IMAGE_OTHER',
  'RECITATION',
  'IMAGE_RECITATION',
  'CONTENT_BLOCKED',
  'ESCALATION',
]);

/** Same signals as lower-case error codes of the Interactions API. */
const SAFETY_ERROR_CODES = new Set([...SAFETY_FINISH_REASONS].map((r) => r.toLowerCase()));

export interface FoundImage {
  mime: string;
  data: string;
}

/**
 * Collect every inline image from any known response shape: `inlineData` / `inline_data` blobs
 * (generateContent) and `{type: "image", data}` blocks (Interactions). Port of `_find_images` in
 * tools/scripts/mktlib/gemini.py, tolerant of schema drift. Interim "thinking" images are skipped:
 * generateContent marks them `thought: true`, Interactions puts them in `type: "thought"` steps.
 * Duplicates (the Interactions `output_image` shortcut repeats the last block) are dropped.
 */
export function findImages(root: unknown): FoundImage[] {
  const found: FoundImage[] = [];
  const seen = new Set<string>();
  const add = (mime: unknown, data: unknown): void => {
    if (typeof data !== 'string' || data === '' || seen.has(data)) return;
    const type = typeof mime === 'string' && mime ? mime : 'image/png';
    if (!type.startsWith('image/')) return;
    seen.add(data);
    found.push({ mime: type, data });
  };
  const walk = (node: unknown, depth: number): void => {
    if (depth > 14 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.thought === true || obj.type === 'thought') return;
    for (const key of ['inlineData', 'inline_data']) {
      const blob = obj[key];
      if (isRecord(blob)) add(blob.mimeType ?? blob.mime_type, blob.data);
    }
    if (obj.type === 'image') add(obj.mime_type ?? obj.mimeType, obj.data);
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'inlineData' && key !== 'inline_data') walk(value, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** All `finishReason` / `blockReason` / error-code style strings found anywhere in a response, upper-cased. */
function collectReasons(root: unknown): { block: string[]; finish: string[]; codes: string[] } {
  const out = { block: [] as string[], finish: [] as string[], codes: [] as string[] };
  const walk = (node: unknown, depth: number): void => {
    if (depth > 10 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (key === 'blockReason' || key === 'block_reason') out.block.push(value.toUpperCase());
        else if (key === 'finishReason' || key === 'finish_reason') out.finish.push(value.toUpperCase());
        else if (key === 'code' || key === 'status') out.codes.push(value.toLowerCase());
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;

  constructor(
    private readonly deps: AdapterDeps,
    private readonly timeoutMs: number = GEMINI_MAX_WAIT_MS,
  ) {}

  generate(req: AdapterRequest): Promise<StartResult> {
    return this.run(req);
  }

  edit(req: AdapterRequest): Promise<StartResult> {
    return this.run(req);
  }

  poll(_handle: JobHandle): Promise<PollResult> {
    // Gemini answers in the same request; no job is ever created for it.
    return Promise.reject(new Error('Gemini has no jobs to poll'));
  }

  private async run(req: AdapterRequest): Promise<Completed> {
    const refs = await Promise.all(req.images.map((url) => this.deps.loadImage(url)));
    if (refs.reduce((sum, ref) => sum + ref.bytes, 0) > MAX_INLINE_REFERENCE_BYTES) {
      throw new UserFacingError('reference_too_large', 'The reference images together are too large to send to the model.', 'Use fewer or smaller images (a normal social-media size is plenty).');
    }
    // One image per request: the image models return a single picture, so n pictures are n parallel requests.
    const settled = await Promise.allSettled(Array.from({ length: req.n }, () => this.oneRequest(req, refs)));

    const outputs: RawOutput[] = [];
    const failures: ProviderError[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        outputs.push(...result.value);
      } else if (isProviderError(result.reason)) {
        failures.push(result.reason);
      } else {
        throw result.reason;
      }
    }
    if (outputs.length === 0) throw failures[0] as ProviderError;

    const warnings: string[] = [];
    if (failures.length > 0) {
      warnings.push(`Only ${Math.min(outputs.length, req.n)} of ${req.n} images could be made (${(failures[0] as ProviderError).fallbackReason}).`);
    }
    return { state: 'done', outputs: outputs.slice(0, req.n), dropped: 0, warnings };
  }

  /** One image: generateContent first, the Interactions API when the model/shape is rejected. */
  private async oneRequest(req: AdapterRequest, refs: LoadedImage[]): Promise<RawOutput[]> {
    const first = await this.post(`${BASE}/models/${req.model.id}:generateContent`, generateContentBody(req, refs));
    if (first.ok) return this.extract(first);

    const failure = this.classify(first);
    // Only a rejected request/model is worth retrying on the other endpoint; auth, quota and safety are not.
    if (failure.kind !== 'validation' && failure.kind !== 'model_unavailable') throw failure;

    const second = await this.post(`${BASE}/interactions`, interactionsBody(req, refs));
    if (second.ok) return this.extract(second);
    throw this.classify(second);
  }

  private post(url: string, body: unknown): Promise<HttpResult> {
    return httpJson(this.deps.fetch, 'gemini', {
      method: 'POST',
      url,
      headers: { 'x-goog-api-key': this.deps.apiKey },
      body,
      timeoutMs: this.timeoutMs,
    });
  }

  private extract(result: HttpResult): RawOutput[] {
    const images = findImages(result.json);
    if (images.length === 0) throw this.noImage(result.json);
    return images.map((image) => ({ data: Buffer.from(image.data, 'base64') })).filter((o) => o.data.length > 0);
  }

  /** A successful answer without a picture: a safety/policy stop (no fallback) or an unexplained empty answer. */
  private noImage(json: unknown): ProviderError {
    const reasons = collectReasons(json);
    const blocked = reasons.block.some((r) => r !== 'BLOCK_REASON_UNSPECIFIED');
    const stopped = reasons.finish.some((r) => SAFETY_FINISH_REASONS.has(r));
    const coded = reasons.codes.some((c) => SAFETY_ERROR_CODES.has(c));
    return blocked || stopped || coded ? providerError('safety', 'gemini') : providerError('no_image', 'gemini');
  }

  private classify(result: HttpResult): ProviderError {
    const status = result.status;
    const error = isRecord(result.json) && isRecord(result.json.error) ? result.json.error : undefined;
    const code = asString(error?.code)?.toLowerCase(); // Interactions: "image_safety", "payment_required", ...
    const gstatus = asString(error?.status)?.toUpperCase(); // generateContent: "INVALID_ARGUMENT", "RESOURCE_EXHAUSTED", ...
    const message = asString(error?.message) ?? '';

    // Gemini reports an invalid key as 400 INVALID_ARGUMENT with reason API_KEY_INVALID, not as 401/403.
    if (/API_KEY_INVALID|API key not valid|API key expired|API_KEY_/i.test(result.text)) return providerError('auth', 'gemini');
    if (code && SAFETY_ERROR_CODES.has(code)) return providerError('safety', 'gemini');
    if (status === 401 || status === 403 || code === 'authentication' || code === 'permission_denied' || gstatus === 'PERMISSION_DENIED' || gstatus === 'UNAUTHENTICATED') {
      return providerError('auth', 'gemini');
    }
    if (status === 402 || code === 'payment_required') return providerError('credits', 'gemini');
    if (status === 400 && (gstatus === 'FAILED_PRECONDITION' || code === 'failed_precondition')) {
      // Billing not enabled, or the account's region is not supported: an account problem, not a bad request.
      return providerError('auth', 'gemini');
    }
    if (status === 429 || code === 'rate_limit_exceeded' || code === 'quota_exceeded' || code === 'too_many_requests' || gstatus === 'RESOURCE_EXHAUSTED') {
      return /prepay|credit|billing/i.test(message) ? providerError('credits', 'gemini') : providerError('rate_limit', 'gemini');
    }
    if (status === 404 || code === 'not_found' || code === 'model_not_found' || gstatus === 'NOT_FOUND') return providerError('model_unavailable', 'gemini');

    const kind = kindFromStatus(status);
    if (kind === 'validation') {
      const detail = sanitizeDetail(message, [this.deps.apiKey]);
      return providerError('validation', 'gemini', detail ? { detail } : {});
    }
    return providerError(kind, 'gemini');
  }
}

function imageConfig(req: AdapterRequest): Record<string, unknown> | undefined {
  const cfg: Record<string, unknown> = {};
  // Edits without an explicit ratio keep the input image's own ratio.
  if (req.ratio) Object.assign(cfg, req.model.aspect[req.ratio]);
  if (req.size && req.model.sizes.includes(req.size)) cfg.imageSize = req.size;
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

export function generateContentBody(req: AdapterRequest, refs: LoadedImage[]): Record<string, unknown> {
  const cfg = imageConfig(req);
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: req.prompt }, ...refs.map((ref) => ({ inlineData: { mimeType: ref.mime, data: ref.base64 } }))],
      },
    ],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(cfg ? { imageConfig: cfg } : {}) },
  };
}

export function interactionsBody(req: AdapterRequest, refs: LoadedImage[]): Record<string, unknown> {
  const aspect = req.ratio ? req.model.aspect[req.ratio].aspectRatio : undefined;
  const size = req.size && req.model.sizes.includes(req.size) ? req.size : undefined;
  return {
    model: req.model.id,
    input: [{ type: 'text', text: req.prompt }, ...refs.map((ref) => ({ type: 'image', mime_type: ref.mime, data: ref.base64 }))],
    response_format: {
      type: 'image',
      mime_type: 'image/png',
      ...(typeof aspect === 'string' ? { aspect_ratio: aspect } : {}),
      ...(size ? { image_size: size } : {}),
    },
    store: false,
  };
}
