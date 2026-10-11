// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { PROVIDER_IDS } from '../models.js';
import { effectiveSize, estimateUsd, perImageUsd } from '../providers/cost.js';
import { planRoute, type Candidate } from '../router.js';
import { modelField, numImagesField, providerField, sizeField } from './imageResult.js';
import { jsonResult, runTool } from './run.js';

const inputSchema = z.object({
  task: z.enum(['generate', 'edit']).default('generate').describe('"generate" for generate_image, "edit" for edit_image.'),
  provider: providerField,
  model: modelField,
  num_images: numImagesField,
  size: sizeField,
  prompt: z.string().max(1200).optional().describe('Optional: the prompt you will use, so the quote follows the same provider choice (for example "fast draft" prompts go to the cheapest model).'),
  text_on_image: z.boolean().default(false).describe('True if the AI must draw words inside the picture (only some models can).'),
  reference_images: z.number().int().min(0).max(13).default(0).describe('How many reference images you will pass in addition to the photo being edited.'),
});

const round = (n: number, digits = 4): number => Math.round(n * 10 ** digits) / 10 ** digits;

export function registerEstimateCost(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'estimate_cost',
    {
      title: 'Quote the price of AI images',
      description:
        'Tells what generate_image or edit_image would cost BEFORE spending anything: which provider and model the server would use, the price per image and in total (US dollars), ' +
        'whether it fits what is left of today’s allowance, and which provider would take over if the first fails. Read-only and free. ' +
        'Call it when planning images, then tell the user the price in one short sentence and wait for their OK. ' +
        'Prices are catalog prices; Leonardo’s are estimates (`cost_is_estimate: true`) until the real cost comes back with the image.',
      inputSchema,
      annotations: { title: 'Quote the price of AI images', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, user, 'estimate_cost', async (meta) => {
        meta.n = args.num_images;
        const available = PROVIDER_IDS.filter((id) => Boolean(ctx.config.keys[id]));
        const plan = planRoute({
          task: args.task,
          provider: args.provider,
          model: args.model,
          prompt: args.prompt ?? '',
          textOnImage: args.text_on_image,
          extraReferences: args.reference_images,
          numImages: args.num_images,
          available,
        });

        const quote = (candidate: Candidate): Record<string, unknown> => ({
          provider: candidate.provider,
          model: candidate.model.id,
          model_label: candidate.model.label,
          size: effectiveSize(candidate.model, args.size),
          per_image_usd: round(perImageUsd(candidate.model, args.size)),
          total_usd: round(estimateUsd(candidate.model, args.size, args.num_images), 6),
          cost_is_estimate: candidate.model.price.estimate ?? false,
        });

        const [first, ...rest] = plan.candidates as [Candidate, ...Candidate[]];
        meta.provider = first.provider;
        meta.model = first.model.id;
        const total = estimateUsd(first.model, args.size, args.num_images);
        const quota = ctx.ledger.quota(user);
        const imagesFit = args.num_images <= quota.images.left;
        const budgetFits = total <= quota.usd.left + 1e-9;
        const fits = imagesFit && budgetFits;

        return jsonResult({
          estimate: quote(first),
          num_images: args.num_images,
          routing: plan.rule,
          fallbacks: plan.fallback ? rest.map(quote) : [],
          fits_allowance: fits,
          allowance: {
            images_left_today: quota.images.left,
            budget_left_usd: quota.usd.left,
            resets_at: quota.resets_at,
          },
          message: fits
            ? `${args.num_images} image${args.num_images === 1 ? '' : 's'} with ${first.model.label} would cost about US$${total.toFixed(2)}.`
            : `${args.num_images} image${args.num_images === 1 ? '' : 's'} (about US$${total.toFixed(2)}) would not fit what is left of today's allowance (${quota.images.left} images, US$${quota.usd.left.toFixed(2)}); it resets at 00:00 UTC.`,
        });
      }),
  );
}
