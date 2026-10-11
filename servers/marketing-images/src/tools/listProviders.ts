// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { MODELS, PROVIDERS, PROVIDER_IDS, RATIOS, estimateImageUsd, modelsFor, type ModelEntry, type ProviderId } from '../models.js';
import { jsonResult, runTool } from './run.js';

function keyPresent(ctx: AppContext, provider: ProviderId): boolean {
  return Boolean(ctx.config.keys[provider]);
}

function describeModel(model: ModelEntry): Record<string, unknown> {
  const price =
    'usd_per_mp' in model.price
      ? { usd_per_megapixel: model.price.usd_per_mp, approx_usd_per_image: round(estimateImageUsd(model)) }
      : { usd_per_image: model.price.usd_per_image };
  return {
    id: model.id,
    label: model.label,
    default_for: model.default_for ?? [],
    opt_in_only: model.opt_in ?? false,
    can: {
      create_from_text: model.capabilities.t2i,
      edit_photos: model.capabilities.edit,
      use_reference_images: model.capabilities.refs,
      draw_text_in_image: model.capabilities.text,
      negative_prompt: model.capabilities.negative_prompt,
      seed: model.capabilities.seed,
    },
    max_reference_images: model.max_refs,
    aspect_ratios: RATIOS.filter((r) => !(model.approx_ratios ?? []).includes(r)),
    approximate_ratios: model.approx_ratios ?? [],
    sizes: model.sizes,
    price,
    cost_is_estimate: model.price.estimate ?? false,
    notes: model.notes,
    prices_verified_on: model.verified_on,
    docs: model.doc_url,
  };
}

const round = (n: number): number => Math.round(n * 10000) / 10000;

export function registerListProviders(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'list_providers',
    {
      title: 'List image providers and today’s allowance',
      description:
        'Shows which AI image providers and models this server can use (Google Gemini, fal.ai, Leonardo), what each is good at, rough prices, ' +
        'whether it is set up on this server (`available`), and how much of today’s allowance is left (images, budget in USD, composed graphics). ' +
        'Read-only and free; call it before planning images so you can tell the user what is possible and what it costs. ' +
        'Use the plain "can" list to explain strengths in everyday words (for example "good at text inside the picture"). ' +
        'Note: AI image generation tools are being added to this server step by step; until generate_image appears in the tool list, ' +
        'use compose_post with a photo link the user provided, or a color/gradient background.',
      inputSchema: z.object({}),
      annotations: { title: 'List image providers and today’s allowance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      runTool(ctx, user, 'list_providers', async () => {
        const quota = ctx.ledger.quota(user);
        return jsonResult({
          providers: PROVIDER_IDS.map((id) => ({
            id,
            label: PROVIDERS[id].label,
            available: keyPresent(ctx, id),
            about: PROVIDERS[id].notes,
            models: modelsFor(id).map(describeModel),
          })),
          model_count: MODELS.length,
          today: {
            resets_at: quota.resets_at,
            images_left: quota.images.left,
            image_limit: quota.images.limit,
            budget_left_usd: quota.usd.left,
            budget_limit_usd: quota.usd.limit,
            composed_graphics_left: quota.renders.left,
            composed_graphics_limit: quota.renders.limit,
          },
          status:
            'generate_image and edit_image are not enabled in this server version yet; compose_post and list_templates are. `available` only tells whether the provider key is configured.',
        });
      }),
  );
}
