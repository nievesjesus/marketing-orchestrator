// registerTool, annotations and image content blocks: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveBrandImageHints } from '../brand-prompt.js';
import type { AppContext } from '../context.js';
import { RATIOS } from '../models.js';
import { adaptersFor } from '../providers/index.js';
import { defaultDeps, runImageRequest } from '../providers/orchestrator.js';
import { assertPromptAllowed } from '../safety.js';
import { brandField, logCandidate, modelField, numImagesField, outcomeResult, providerField, sizeField, uploadField } from './imageResult.js';
import { runTool } from './run.js';

const inputSchema = z.object({
  prompt: z.string().min(3).max(1200).describe('What the picture shows, in plain descriptive sentences: subject, setting, light, mood, camera or art style. No words to print in the image (see text_on_image).'),
  provider: providerField,
  model: modelField,
  aspect_ratio: z
    .enum(RATIOS)
    .default('1:1')
    .describe('Shape: 1:1 square feed post, 4:5 portrait feed (best for Instagram/Facebook/LinkedIn), 9:16 story/reel/TikTok, 16:9 landscape (X, YouTube, link posts), 3:2 and 2:3 photo shapes.'),
  size: sizeField,
  num_images: numImagesField,
  negative_prompt: z.string().max(300).optional().describe('Things to keep out of the picture (for example "blurry, extra fingers").'),
  style: z.string().max(200).optional().describe('The visual style in a few words (for example "warm natural light, muted earth tones, minimalist"). With `brand` set, the brand’s photo style is added already; use this to override or refine it for this picture.'),
  brand: brandField,
  text_on_image: z
    .string()
    .max(150)
    .optional()
    .describe('ONLY when the user explicitly wants the AI model to draw words inside the picture (for example a sign or a label). The exact text to draw. Leave empty otherwise: headlines should be added with compose_post, which spells everything correctly.'),
  reference_image_urls: z.array(z.url()).max(14).optional().describe('Public https links to images that show the subject or style to follow (the user’s product photo, a brand mood image).'),
  seed: z.number().int().min(0).max(2147483647).optional().describe('Repeat a result: the same seed with the same prompt gives the same picture on models that support it.'),
  leave_space: z.enum(['top', 'bottom', 'left', 'right']).optional().describe('Keep that side of the picture calm and empty so a headline can be placed there later with compose_post.'),
  upload_to_postiz: uploadField,
});

export function registerGenerateImage(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'generate_image',
    {
      title: 'Create an AI image',
      description:
        'Creates 1-4 AI pictures from a description (a text-free background, a product scene, an illustration) with Gemini, fal.ai or Leonardo. ' +
        'This COSTS MONEY (roughly US$0.003-0.13 per image) and counts against the user’s daily allowance. ' +
        'Before calling: show the user a 2-3 line brief (what the picture is, shape, how many) plus the price from estimate_cost, and call only after they say OK. ' +
        'Pass `brand` (a saved brand’s slug, see list_brands, or an inline object) so the picture follows the company’s photo style and colors. ' +
        'Keep words out of the picture: leave text_on_image empty and add the headline afterwards with compose_post, which draws perfectly spelled text; use leave_space to keep an area clear for it. ' +
        'Real people, other companies’ brands/logos and cartoon characters are refused. ' +
        'The answer says which provider was used (`provider`) and why another was tried first (`fallback_from`). ' +
        'If `status` is "pending", the image is still being made: call get_job with the `job_id` after about 15 seconds. ' +
        'Results are public links kept for about 30 days plus small previews (in local stdio mode each image also has `file_path`); creating an image does not publish anything. ' +
        'generate_image does not upload to Postiz unless upload_to_postiz=true: the picture is usually a background that gets a headline later, and compose_post uploads the final graphic automatically when Postiz credentials are configured. ' +
        'Pass upload_to_postiz=true only when the picture itself is the finished image: each image then has `postiz.path`, which you use directly as the Postiz attachment (skip uploadFromUrlTool). Postiz allows only 30 uploads per hour.',
      inputSchema,
      annotations: { title: 'Create an AI image', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'generate_image', async (meta) => {
        meta.n = args.num_images;
        const brand = resolveBrandImageHints(ctx, user, args.brand);
        if (args.brand !== undefined) meta.brand = typeof args.brand === 'string' ? args.brand : 'inline';
        assertPromptAllowed('generate', [args.prompt, args.style, args.text_on_image, brand?.photoStyle]);

        const outcome = await runImageRequest(
          ctx,
          user,
          {
            task: 'generate',
            text: args.prompt,
            provider: args.provider,
            model: args.model,
            ratio: args.aspect_ratio,
            size: args.size,
            numImages: args.num_images,
            negativePrompt: args.negative_prompt,
            style: args.style,
            brandPhotoStyle: brand?.photoStyle,
            brandPalette: brand?.palette,
            textOnImage: args.text_on_image,
            references: args.reference_image_urls ?? [],
            seed: args.seed,
            leaveSpace: args.leave_space,
          },
          defaultDeps(adaptersFor(ctx)),
          { onCandidate: logCandidate(meta) },
        );
        return outcomeResult(ctx, user, outcome, meta, args.upload_to_postiz);
      }),
  );
}
