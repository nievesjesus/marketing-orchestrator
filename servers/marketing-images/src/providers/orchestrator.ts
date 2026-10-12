import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { AppContext } from '../context.js';
import { isUserFacingError, UserFacingError } from '../errors.js';
import type { JobRecord } from '../ledger.js';
import { PROVIDER_IDS, type ModelEntry, type ProviderId, type Ratio } from '../models.js';
import { planRoute, type Candidate, type RoutePlan } from '../router.js';
import { effectiveSize, estimateUsd, perImageUsd } from './cost.js';
import { FALLBACK_KINDS, isProviderError, providerError, ProviderError, TRANSIENT_KINDS, tryInstead } from './errors.js';
import { assertPublicReference } from './http.js';
import type { Adapters } from './index.js';
import { ingestOutput, nearestRatio, type StoredOutput } from './outputs.js';
import { buildPrompt, type LeaveSpace } from './prompt.js';
import type { AdapterRequest, Completed, ImageTask, JobHandle, ProviderAdapter, RawOutput } from './types.js';

/**
 * Runs one image request end to end (DESIGN sections 7, 8 and 9):
 *
 *   route -> reserve quota -> call the provider -> wait (backoff 1 s x1.5, cap 5 s, up to SYNC_WAIT_MS)
 *         -> copy the outputs into our storage -> settle the reservation with the real (or estimated) cost
 *
 * - A provider failure that is the provider's fault (5xx, timeout, 429, credits, auth) releases the reservation and
 *   moves on to the next candidate when the provider was `auto`. Safety refusals and validation errors never do.
 * - A queued job (fal, Leonardo) that is still running when the sync wait ends is saved in SQLite together with its
 *   reservation and returned as a `job_id`; `checkJob` (get_job) resumes it. The sweep refunds jobs nobody collected.
 */

export interface ImageRequest {
  task: ImageTask;
  /** The prompt (generate) or the instruction (edit). */
  text: string;
  provider: 'auto' | ProviderId;
  model?: string | undefined;
  /** Output ratio. An edit may leave it out to keep the photo's own shape. */
  ratio?: Ratio | undefined;
  size?: string | undefined;
  numImages: number;
  negativePrompt?: string | undefined;
  style?: string | undefined;
  /** From a saved or inline brand: its photo style and palette phrase, added to the prompt after `style` (never used for routing). */
  brandPhotoStyle?: string | undefined;
  brandPalette?: string | undefined;
  textOnImage?: string | undefined;
  /** Reference images (generate) or extra references next to the photo (edit). */
  references: string[];
  /** The photo to edit (edit only). */
  imageUrl?: string | undefined;
  seed?: number | undefined;
  leaveSpace?: LeaveSpace | undefined;
}

export interface DeliveredImage {
  key: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
  /** Present only right after the copy (to build the preview); never stored in a job. */
  data?: Buffer;
}

interface OutcomeBase {
  provider: ProviderId;
  model: string;
  modelLabel: string;
  fallbackFrom: string | null;
  warnings: string[];
  /** Which routing rule decided (see router.ts). */
  rule: string;
}

export interface DoneOutcome extends OutcomeBase {
  status: 'done';
  images: DeliveredImage[];
  costUsd: number;
  costIsEstimate: boolean;
}

export interface PendingOutcome extends OutcomeBase {
  status: 'pending';
  jobId: string;
  retryAfterSeconds: number;
  note?: string;
}

export type ImageOutcome = DoneOutcome | PendingOutcome;

export interface RunDeps {
  adapters: Adapters;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunHooks {
  /** Called with each candidate before it is tried (for the call log). */
  onCandidate?(candidate: Candidate, plan: RoutePlan): void;
}

/** Backoff between status checks: 1 s, 1.5 s, 2.25 s ... capped at 5 s (about 15 requests a minute at most). */
export function backoffDelays(): Generator<number, never, void> {
  return (function* () {
    let delay = 1000;
    for (;;) {
      yield delay;
      delay = Math.min(delay * 1.5, 5000);
    }
  })();
}

export const JOB_RETRY_SECONDS = 15;
export const JOB_MAX_IN_CALL_WAIT_MS = 20_000;

// ---- Waiting ---------------------------------------------------------------------------------------------

/**
 * Check a queued job until it is done or `deadline` passes. Returns undefined at the deadline. Transient errors of the
 * status endpoint (429, 5xx, timeouts) are ignored: the job itself is not lost, the next check may work.
 * Every other provider error stops the wait and propagates.
 */
export async function pollUntil(
  adapter: ProviderAdapter,
  handle: JobHandle,
  options: { deadline: number; sleep(ms: number): Promise<void>; now(): number; immediate: boolean },
): Promise<Completed | undefined> {
  const delays = backoffDelays();
  let first = options.immediate;
  for (;;) {
    if (!first) {
      const remaining = options.deadline - options.now();
      if (remaining <= 0) return undefined;
      await options.sleep(Math.min(delays.next().value, remaining));
    }
    first = false;
    try {
      const result = await adapter.poll(handle);
      if (result.state === 'done') return result;
    } catch (err) {
      if (!(isProviderError(err) && TRANSIENT_KINDS.has(err.kind))) throw err;
    }
    if (options.deadline - options.now() <= 0) return undefined;
  }
}

// ---- Running a request -------------------------------------------------------------------------------------

export async function runImageRequest(
  ctx: AppContext,
  user: string,
  req: ImageRequest,
  deps: RunDeps,
  hooks: RunHooks = {},
): Promise<ImageOutcome> {
  let available = PROVIDER_IDS.filter((id) => deps.adapters[id] !== undefined);
  const deadline = deps.now() + ctx.config.syncWaitMs;
  const links = [...(req.imageUrl ? [req.imageUrl] : []), ...req.references];
  // Local `file://` images (stdio mode) are read from disk and sent as bytes, which only Gemini accepts: fal and
  // Leonardo download reference links themselves, so a file on this machine is out of their reach.
  const localLinks = links.filter((link) => ctx.localFiles?.isLocalRef(link));
  for (const link of links) if (!localLinks.includes(link)) assertPublicReference(link, ctx.config.allowInsecureLocalhost);
  if (localLinks.length > 0) {
    available = available.filter((id) => id === 'gemini');
    if ((req.provider !== 'auto' && req.provider !== 'gemini') || available.length === 0) {
      throw new UserFacingError(
        'local_reference_unsupported',
        'A local image file can only be used as a reference with Gemini: fal.ai and Leonardo download reference images themselves, so they cannot reach a file on this computer.',
        available.length === 0
          ? 'Set GEMINI_API_KEY, or use a public https link to the image instead.'
          : 'Use provider "gemini" (or "auto"), or a public https link to the image instead.',
      );
    }
  }
  const plan = planRoute({
    task: req.task,
    provider: req.provider,
    model: req.model,
    prompt: req.text,
    style: req.style,
    textOnImage: Boolean(req.textOnImage?.trim()),
    extraReferences: req.references.length,
    numImages: req.numImages,
    available,
  });

  const tried: string[] = [];
  let lastError: ProviderError | undefined;
  let ratio = req.ratio;

  for (const [index, candidate] of plan.candidates.entries()) {
    const { provider, model } = candidate;
    const adapter = deps.adapters[provider] as ProviderAdapter;
    hooks.onCandidate?.(candidate, plan);

    const perImage = perImageUsd(model, req.size);
    const estimate = estimateUsd(model, req.size, req.numImages);
    let reservationId: string;
    try {
      reservationId = ctx.ledger.reserve(user, { images: req.numImages, usd: estimate }).id;
    } catch (err) {
      // Over the allowance: say so without calling anyone. A later (cheaper) candidate may still fit.
      if (index > 0 && isUserFacingError(err)) {
        tried.push(`${provider} (over today's allowance)`);
        continue;
      }
      throw err;
    }

    let holdingReservation = true;
    try {
      ratio ??= await impliedRatio(ctx, req, model);
      const built = buildPrompt(
        {
          task: req.task,
          text: req.text,
          style: req.style,
          brandPhotoStyle: req.brandPhotoStyle,
          brandPalette: req.brandPalette,
          textOnImage: req.textOnImage,
          leaveSpace: req.leaveSpace,
          negativePrompt: req.negativePrompt,
          extraReferences: req.references.length,
        },
        model,
      );
      const adapterRequest: AdapterRequest = {
        task: req.task,
        model,
        prompt: built.prompt,
        ...(built.negativePrompt ? { negativePrompt: built.negativePrompt } : {}),
        ...(ratio ? { ratio } : {}),
        ...(req.size ? { size: req.size } : {}),
        n: req.numImages,
        ...(req.seed !== undefined && model.capabilities.seed ? { seed: req.seed } : {}),
        images: [...(req.imageUrl ? [req.imageUrl] : []), ...req.references],
      };
      const warnings = requestWarnings(req, model, ratio);

      const started = await (req.task === 'edit' ? adapter.edit(adapterRequest) : adapter.generate(adapterRequest));
      const base: OutcomeBase = {
        provider,
        model: model.id,
        modelLabel: model.label,
        fallbackFrom: tried.length > 0 ? tried.join('; ') : null,
        warnings,
        rule: plan.rule,
      };

      let completed: Completed | undefined;
      let knownCost: number | undefined;
      if (started.state === 'done') {
        completed = started;
      } else {
        knownCost = started.handle.costUsd;
        completed = await pollUntil(adapter, started.handle, { deadline, sleep: deps.sleep, now: deps.now, immediate: false });
        if (!completed) {
          const job = ctx.ledger.createJob({
            user,
            provider,
            model: model.id,
            upstream: {
              handle: started.handle,
              n: req.numImages,
              size: effectiveSize(model, req.size),
              ratio: ratio ?? null,
              perImageUsd: perImage,
              priceIsEstimate: model.price.estimate ?? false,
              modelLabel: model.label,
              fallbackFrom: base.fallbackFrom,
              warnings,
              rule: plan.rule,
            },
            requestSummary: { task: req.task, n: req.numImages, ratio: ratio ?? null, size: effectiveSize(model, req.size) },
            reservationId,
            reservedUsd: estimate,
          });
          holdingReservation = false; // the job owns it now
          return { status: 'pending', jobId: job.id, retryAfterSeconds: JOB_RETRY_SECONDS, ...base };
        }
      }

      const delivered = await ingestAll(ctx, completed.outputs, provider);
      const billed = delivered.length + completed.dropped;
      const realCost = completed.costUsd ?? knownCost;
      const costUsd = realCost ?? roundMicros(perImage * billed);
      ctx.ledger.settle(reservationId, { usd: costUsd, images: delivered.length });
      holdingReservation = false;

      return {
        status: 'done',
        images: delivered.map(toDelivered),
        costUsd,
        costIsEstimate: realCost === undefined && (model.price.estimate ?? false),
        ...base,
        warnings: [...warnings, ...completed.warnings],
      };
    } catch (err) {
      if (holdingReservation) ctx.ledger.release(reservationId);
      if (!isProviderError(err)) throw err;

      const canFallBack = plan.fallback && FALLBACK_KINDS.has(err.kind) && index < plan.candidates.length - 1;
      if (canFallBack) {
        tried.push(`${provider} (${err.fallbackReason})`);
        lastError = err;
        ctx.logger.warn('provider_fallback', { provider, model: model.id, kind: err.kind, rule: plan.rule });
        continue;
      }
      throw finalError(err, tried, available, plan.fallback);
    }
  }

  // Every remaining candidate was skipped (allowance): report the last provider failure.
  if (lastError) throw finalError(lastError, tried, available, plan.fallback);
  throw new Error('no candidate was attempted');
}

/** Provider failures with an actionable next step: other providers to try, or what was already tried. */
function finalError(err: ProviderError, tried: string[], available: readonly ProviderId[], fallbackWasAllowed: boolean): ProviderError {
  const others = tried.filter((entry) => !entry.startsWith(`${err.provider} `));
  if (others.length > 0) {
    return new ProviderError(err.kind, err.provider, `${err.message} Also tried: ${others.join('; ')}.`, err.suggestion);
  }
  if (tried.length > 0) return err;
  const providerFault = FALLBACK_KINDS.has(err.kind) && err.kind !== 'not_configured';
  const alternatives = available.filter((p) => p !== err.provider);
  if (!fallbackWasAllowed && providerFault && tryInstead(alternatives)) {
    return providerError(err.kind, err.provider, { alternatives });
  }
  return err;
}

function requestWarnings(req: ImageRequest, model: ModelEntry, ratio: Ratio | undefined): string[] {
  const warnings: string[] = [];
  if (req.seed !== undefined && !model.capabilities.seed) warnings.push(`${model.label} ignores the seed, so repeating this request can give a different picture.`);
  if (ratio && model.approx_ratios?.includes(ratio)) {
    const used = model.aspect[ratio].aspect_ratio;
    warnings.push(`${model.label} cannot make ${ratio} exactly${typeof used === 'string' ? ` (it makes ${used})` : ''}: crop to ${ratio} when composing.`);
  }
  return warnings;
}

/** When an edit does not name a ratio but the model needs explicit pixel sizes, use the photo's own shape. */
async function impliedRatio(ctx: AppContext, req: ImageRequest, model: ModelEntry): Promise<Ratio | undefined> {
  if (req.task !== 'edit' || !req.imageUrl || model.dimension_multiple === undefined) return undefined;
  const meta = await sharp(await ctx.fetchImage(req.imageUrl)).metadata();
  return meta.width && meta.height ? nearestRatio(meta.width, meta.height) : '1:1';
}

async function ingestAll(ctx: AppContext, outputs: RawOutput[], provider: ProviderId): Promise<StoredOutput[]> {
  const stored: StoredOutput[] = [];
  for (const output of outputs) stored.push(await ingestOutput(ctx.storage, output.data, provider));
  return stored;
}

function toDelivered(stored: StoredOutput): DeliveredImage {
  return { key: stored.key, url: stored.url, width: stored.width, height: stored.height, bytes: stored.bytes, contentType: stored.contentType, data: stored.data };
}

const roundMicros = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

// ---- Jobs (get_job) ----------------------------------------------------------------------------------------

export type JobOutcome = DoneOutcome | PendingOutcome;

interface StoredResult extends Omit<DoneOutcome, 'status' | 'images'> {
  images: DeliveredImage[];
}

const jobNotFound = (): UserFacingError =>
  new UserFacingError('job_not_found', 'No job with that id was found for you (jobs are kept for 24 hours).', 'Start the image again with generate_image or edit_image.');

/**
 * One check of a saved job, with up to `waitMs` (at most 20 s) of waiting inside the call. Jobs belong to the user who
 * started them. A finished job is collected once (copied to our storage, reservation settled) and then simply returned again.
 */
export async function checkJob(ctx: AppContext, user: string, jobId: string, deps: RunDeps, waitMs = JOB_MAX_IN_CALL_WAIT_MS): Promise<JobOutcome> {
  const job = ctx.ledger.getJob(user, jobId);
  if (!job) throw jobNotFound();

  if (job.status === 'done') return doneFromJob(job);
  if (job.status === 'failed') {
    const error = job.upstream.error as { code?: string; message?: string; suggestion?: string } | undefined;
    throw new UserFacingError(error?.code ?? 'job_failed', error?.message ?? 'This job failed.', error?.suggestion ?? 'Start the image again.');
  }
  if (job.status === 'expired') {
    throw new UserFacingError('job_expired', 'This job expired (jobs are kept for 24 hours) and its allowance was returned.', 'Start the image again with generate_image or edit_image.');
  }

  const provider = job.provider as ProviderId;
  const handle = job.upstream.handle as JobHandle;
  const adapter = deps.adapters[provider];
  if (!adapter) throw providerError('not_configured', provider, { alternatives: PROVIDER_IDS.filter((p) => p !== provider && deps.adapters[p]) });

  const pending = (note?: string): PendingOutcome => ({
    status: 'pending',
    jobId: job.id,
    provider,
    model: job.model,
    modelLabel: String(job.upstream.modelLabel ?? job.model),
    fallbackFrom: (job.upstream.fallbackFrom as string | null | undefined) ?? null,
    warnings: (job.upstream.warnings as string[] | undefined) ?? [],
    rule: String(job.upstream.rule ?? ''),
    retryAfterSeconds: JOB_RETRY_SECONDS,
    ...(note ? { note } : {}),
  });

  let completed: Completed | undefined;
  try {
    const deadline = deps.now() + Math.min(Math.max(waitMs, 0), JOB_MAX_IN_CALL_WAIT_MS);
    completed = await pollUntil(adapter, handle, { deadline, sleep: deps.sleep, now: deps.now, immediate: true });
  } catch (err) {
    if (isProviderError(err)) {
      // The provider gave a final answer (refusal, failure): end the job and give the allowance back.
      ctx.ledger.failJob(job.id, { code: err.code, message: err.message, ...(err.suggestion ? { suggestion: err.suggestion } : {}) });
    }
    throw err;
  }
  if (!completed) return pending();

  if (!ctx.ledger.claimJob(user, job.id)) return pending('Another request is finishing this job; check again in a few seconds.');
  try {
    const delivered = await ingestAll(ctx, completed.outputs, provider);
    const perImage = Number(job.upstream.perImageUsd ?? 0);
    const realCost = completed.costUsd ?? handle.costUsd;
    const costUsd = realCost ?? roundMicros(perImage * (delivered.length + completed.dropped));
    const result: StoredResult = {
      provider,
      model: job.model,
      modelLabel: String(job.upstream.modelLabel ?? job.model),
      fallbackFrom: (job.upstream.fallbackFrom as string | null | undefined) ?? null,
      warnings: [...((job.upstream.warnings as string[] | undefined) ?? []), ...completed.warnings],
      rule: String(job.upstream.rule ?? ''),
      costUsd,
      costIsEstimate: realCost === undefined && Boolean(job.upstream.priceIsEstimate),
      images: delivered.map((d) => ({ key: d.key, url: d.url, width: d.width, height: d.height, bytes: d.bytes, contentType: d.contentType })),
    };
    ctx.ledger.completeJob(job.id, { usd: costUsd, images: delivered.length }, result as unknown as Record<string, unknown>);
    return { status: 'done', ...result, images: delivered.map(toDelivered) };
  } catch (err) {
    ctx.ledger.releaseClaim(job.id);
    throw err;
  }
}

function doneFromJob(job: JobRecord): DoneOutcome {
  const result = job.upstream.result as StoredResult | undefined;
  if (!result) throw new UserFacingError('job_failed', 'This job finished without a result.', 'Start the image again.');
  return { status: 'done', ...result };
}

/** Read a stored image back (for the preview of a job collected earlier). Null when the storage cannot serve it. */
export async function readStoredImage(ctx: AppContext, key: string): Promise<Buffer | null> {
  const file = await ctx.storage.open(key);
  if (!file) return null;
  try {
    return await readFile(file.absPath);
  } catch {
    return null;
  }
}

export function defaultDeps(adapters: Adapters): RunDeps {
  return { adapters, sleep: defaultSleep, now: () => Date.now() };
}
