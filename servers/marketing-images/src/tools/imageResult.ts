import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import type { Candidate, RoutePlan } from '../router.js';
import { readStoredImage, type DeliveredImage, type DoneOutcome, type ImageOutcome } from '../providers/orchestrator.js';
import { makePreview, PreviewBudget } from '../render/preview.js';
import { jsonResult, type LogMeta } from './run.js';

/** Zod fragments shared by generate_image, edit_image and estimate_cost. */
export const providerField = z
  .enum(['auto', 'gemini', 'fal', 'leonardo'])
  .default('auto')
  .describe('Which service makes the image. Leave "auto" (recommended): the server picks the best one that is set up and falls back to another if one is down or out of credits.');

export const modelField = z
  .string()
  .max(80)
  .optional()
  .describe('Optional exact model id from list_providers. Leave empty unless the user asked for a specific model; naming one disables the automatic fallback.');

export const sizeField = z
  .enum(['1K', '2K'])
  .optional()
  .describe('Resolution tier for models that have one (1K about 1000 px on the long side, 2K about 2000 px, costs more). Default 1K, which is plenty for social posts.');

export const numImagesField = z.number().int().min(1).max(4).default(1).describe('How many alternatives to make (1-4). Each one is billed.');

/** Logging helper: provider, model and rule as the router picks them (never prompts). */
export function logCandidate(meta: LogMeta) {
  return (candidate: Candidate, plan: RoutePlan): void => {
    meta.provider = candidate.provider;
    meta.model = candidate.model.id;
    meta.routing = plan.rule;
  };
}

const NEXT_STEP_DONE =
  'Show the previews to the user and ask whether they like one. The image has no text on it: add headlines with compose_post using the chosen `url` as background.image_url. ' +
  'Give the final `url` to the scheduling tool (e.g. Postiz uploadFromUrlTool); the links stay available for about 30 days.';

const round = (n: number, digits = 4): number => Math.round(n * 10 ** digits) / 10 ** digits;

/** JPEG previews for the images, sharing one byte budget (DESIGN section 5). */
async function previewsFor(ctx: AppContext, images: DeliveredImage[]): Promise<CallToolResult['content']> {
  const budget = new PreviewBudget();
  const content: CallToolResult['content'] = [];
  for (const [index, image] of images.entries()) {
    const bytes = image.data ?? (await readStoredImage(ctx, image.key));
    if (!bytes) continue;
    const share = Math.floor(budget.remaining / (images.length - index));
    const preview = await makePreview(bytes, share);
    if (!preview) continue;
    budget.consume(preview.data.length);
    content.push({ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType });
  }
  return content;
}

function describeDone(outcome: DoneOutcome): Record<string, unknown> {
  const perImage = outcome.images.length > 0 ? round(outcome.costUsd / outcome.images.length) : 0;
  return {
    status: 'done',
    provider: outcome.provider,
    model: outcome.model,
    model_label: outcome.modelLabel,
    fallback_from: outcome.fallbackFrom,
    routing: outcome.rule,
    images: outcome.images.map((image) => ({
      url: image.url,
      width: image.width,
      height: image.height,
      provider: outcome.provider,
      model: outcome.model,
      cost_usd: perImage,
    })),
    cost_usd: round(outcome.costUsd, 6),
    cost_is_estimate: outcome.costIsEstimate,
    warnings: outcome.warnings,
  };
}

/** The tool result for a finished or queued image request. */
export async function outcomeResult(ctx: AppContext, user: string, outcome: ImageOutcome, meta: LogMeta): Promise<CallToolResult> {
  meta.provider = outcome.provider;
  meta.model = outcome.model;
  meta.routing = outcome.rule;
  if (outcome.fallbackFrom) meta.fallback_from = outcome.fallbackFrom;
  const quota = ctx.ledger.quota(user);
  const allowance = { images_left_today: quota.images.left, budget_left_usd: quota.usd.left, resets_at: quota.resets_at };

  if (outcome.status === 'pending') {
    meta.job = true;
    return jsonResult({
      status: 'pending',
      job_id: outcome.jobId,
      provider: outcome.provider,
      model: outcome.model,
      model_label: outcome.modelLabel,
      fallback_from: outcome.fallbackFrom,
      routing: outcome.rule,
      retry_after_seconds: outcome.retryAfterSeconds,
      warnings: outcome.warnings,
      ...(outcome.note ? { note: outcome.note } : {}),
      ...allowance,
      next_step: `The image is still being made. Tell the user it needs a little longer, then call get_job with this job_id in about ${outcome.retryAfterSeconds} seconds (the job is kept for 24 hours; the allowance is only used once it finishes).`,
    });
  }

  meta.n = outcome.images.length;
  meta.cost_usd = outcome.costUsd;
  return jsonResult(
    {
      ...describeDone(outcome),
      ...allowance,
      next_step: NEXT_STEP_DONE,
    },
    await previewsFor(ctx, outcome.images),
  );
}
