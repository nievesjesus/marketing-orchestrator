import type { ModelEntry, ProviderId, Ratio } from '../models.js';

/**
 * The seam between the orchestration (routing, quota, jobs) and the three providers (DESIGN section 6).
 * An adapter turns one `AdapterRequest` into the provider's HTTP calls and hands back raw image bytes;
 * it knows nothing about quota, storage or fallback.
 */

export type ImageTask = 'generate' | 'edit';

export interface AdapterRequest {
  task: ImageTask;
  model: ModelEntry;
  /** The full prompt (hints for text, empty space and negative prompts already merged by `buildPrompt`). */
  prompt: string;
  /** Only set when the model supports it natively (otherwise it was merged into `prompt`). */
  negativePrompt?: string;
  /** Output ratio. Missing for an edit that keeps the input image's own ratio. */
  ratio?: Ratio;
  /** Size token from `model.sizes` ("1K", "2K"); ignored by models that have a single size. */
  size?: string;
  /** Images wanted (1-4). */
  n: number;
  seed?: number;
  /**
   * Public https links. Edit: the image to edit first, then optional extra references.
   * Generate: optional style/subject references.
   */
  images: string[];
}

export interface RawOutput {
  data: Buffer;
}

export interface Completed {
  state: 'done';
  outputs: RawOutput[];
  /** Real cost in USD when the provider reports one (Leonardo). */
  costUsd?: number;
  /** Images the provider made but flagged and we dropped (fal `has_nsfw_concepts`, Leonardo `nsfw`). */
  dropped: number;
  /** Plain-language notes for the caller (partial results, ignored options). */
  warnings: string[];
}

/** JSON-safe handle that lets another request (`get_job`) resume a queued job. */
export interface JobHandle {
  provider: ProviderId;
  model: string;
  /** Epoch ms of the submission (providers may answer 403/404 briefly for a brand-new job). */
  submittedAt: number;
  /** Provider-specific ids and URLs: fal `{request_id, status_url, response_url}`, Leonardo `{generation_id}`. */
  ref: Record<string, string>;
  /** Real cost reported at submission time (Leonardo). */
  costUsd?: number;
}

export interface Pending {
  state: 'pending';
  handle: JobHandle;
}

export type StartResult = Completed | Pending;
export type PollResult = Completed | { state: 'pending' };

export interface ProviderAdapter {
  readonly id: ProviderId;
  generate(req: AdapterRequest): Promise<StartResult>;
  edit(req: AdapterRequest): Promise<StartResult>;
  /** One status check. Synchronous providers (Gemini) never create handles, so they never get polled. */
  poll(handle: JobHandle): Promise<PollResult>;
}

export interface LoadedImage {
  mime: string;
  /** Base64 of the (already validated) image bytes. */
  base64: string;
  bytes: number;
}

export interface AdapterDeps {
  apiKey: string;
  fetch: typeof fetch;
  /** Download a user-supplied image through the SSRF guard (Gemini needs the bytes inline). */
  loadImage(url: string): Promise<LoadedImage>;
  now(): number;
}
