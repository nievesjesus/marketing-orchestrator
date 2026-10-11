// registerTool, annotations and image content blocks: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { RATIOS } from '../models.js';
import { adaptersFor } from '../providers/index.js';
import { defaultDeps, runImageRequest } from '../providers/orchestrator.js';
import { assertPromptAllowed } from '../safety.js';
import { logCandidate, modelField, numImagesField, outcomeResult, providerField, sizeField } from './imageResult.js';
import { runTool } from './run.js';

const inputSchema = z.object({
  image_url: z.url().describe('Public https link to the photo to edit (JPEG, PNG or WebP), for example the link of a photo the user uploaded through Postiz.'),
  instruction: z.string().min(3).max(1200).describe('What to change, in one or two plain sentences ("replace the background with a sunny beach", "make the colors warmer"). Everything not mentioned is kept.'),
  provider: providerField,
  model: modelField,
  aspect_ratio: z.enum(RATIOS).optional().describe('Output shape. Leave empty to keep the photo’s own shape; set it (for example 4:5) to reframe the result for a post.'),
  size: sizeField,
  num_images: numImagesField,
  reference_image_urls: z.array(z.url()).max(13).optional().describe('Optional extra images to borrow from (a logo, a product, a style), public https links.'),
  text_on_image: z.string().max(150).optional().describe('ONLY if the user explicitly wants words drawn into the picture. Leave empty otherwise; use compose_post for headlines.'),
  style: z.string().max(200).optional().describe('Optional visual style to apply, in a few words.'),
  seed: z.number().int().min(0).max(2147483647).optional(),
});

export function registerEditImage(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'edit_image',
    {
      title: 'Edit or restyle a photo with AI',
      description:
        'Changes an existing photo according to an instruction (new background, different lighting, remove an object, restyle) with Gemini, fal.ai or Leonardo. ' +
        'The photo can be the user’s own picture, for example one they uploaded through Postiz; pass its public link as image_url. ' +
        'This COSTS MONEY (roughly US$0.04-0.13 per image) and counts against the daily allowance: show the user a 2-3 line brief and the price from estimate_cost and call only after they say OK. ' +
        'The original is never changed; the edited picture is a new link kept for about 30 days. ' +
        'Asking to add a real person, another company’s logo or a cartoon character is refused. ' +
        'The answer says which provider was used and why another was tried first (`fallback_from`). If `status` is "pending", call get_job with the `job_id` after about 15 seconds. ' +
        'To put a headline on the result, use compose_post with the new link as the background.',
      inputSchema,
      annotations: { title: 'Edit or restyle a photo with AI', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'edit_image', async (meta) => {
        meta.n = args.num_images;
        assertPromptAllowed('edit', [args.instruction, args.style, args.text_on_image]);

        const outcome = await runImageRequest(
          ctx,
          user,
          {
            task: 'edit',
            text: args.instruction,
            provider: args.provider,
            model: args.model,
            ratio: args.aspect_ratio,
            size: args.size,
            numImages: args.num_images,
            style: args.style,
            textOnImage: args.text_on_image,
            references: args.reference_image_urls ?? [],
            imageUrl: args.image_url,
            seed: args.seed,
          },
          defaultDeps(adaptersFor(ctx)),
          { onCandidate: logCandidate(meta) },
        );
        return outcomeResult(ctx, user, outcome, meta);
      }),
  );
}
