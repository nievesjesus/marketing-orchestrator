// registerTool, annotations and image content blocks: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
// Tool spec: https://modelcontextprotocol.io/specification/latest/server/tools · Zod schemas: https://zod.dev/api
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import { composePost } from '../render/compose.js';
import { FORMAT_NAMES } from '../render/formats.js';
import { makePreview, PreviewBudget } from '../render/preview.js';
import { TEMPLATE_IDS } from '../render/templates/index.js';
import { jsonResult, runTool } from './run.js';

const hex = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex color such as #1F3A5F')
  .describe('Hex color such as #1F3A5F');

const inputSchema = z.object({
  template: z.enum(TEMPLATE_IDS).describe('Layout to use. photo-headline = photo with big headline at the bottom; cta-card = brand-color card with a button. See list_templates.'),
  format: z.enum(FORMAT_NAMES).describe('Image size: square 1080x1080, portrait 1080x1350 (4:5), story 1080x1920 (9:16), landscape 1920x1080, link 1200x627.'),
  texts: z
    .object({
      headline: z.string().min(1).max(200).describe('Main message. Keep it SHORT (about 25-45 characters); it is never cut off, and too-long headlines come back with a warning.'),
      eyebrow: z.string().max(80).optional().describe('Small label above the headline (e.g. "New season"). Drawn in capitals.'),
      body: z.string().max(600).optional().describe('Optional short paragraph under the headline (1-2 sentences).'),
      cta: z.string().max(60).optional().describe('Call to action drawn as a button (cta-card only), 2-4 words, e.g. "Book now".'),
      footer: z.string().max(100).optional().describe('Small line at the bottom of the text block, e.g. a website or @handle.'),
    })
    .describe('The words on the image. Written exactly as given (accents and ñ are fine; emoji are not supported).'),
  background: z
    .object({
      image_url: z.url().optional().describe('Public https link to a photo (JPEG, PNG, WebP or AVIF), e.g. from the user’s Postiz media or a generated image.'),
      color: hex.optional(),
      gradient: z
        .object({ from: hex, to: hex, angle: z.number().min(0).max(360).optional().describe('Degrees: 0 = bottom to top, 90 = left to right, 180 = top to bottom. Default 160.') })
        .optional(),
    })
    .optional()
    .describe('Give exactly ONE of image_url, color or gradient. If omitted, photo-headline uses a brand gradient and cta-card uses the brand primary color.'),
  brand: z
    .object({
      colors: z
        .object({
          primary: hex.optional().describe('Main brand color (cta-card background).'),
          secondary: hex.optional(),
          accent: hex.optional().describe('Highlight color (eyebrow text, button).'),
          ink: hex.optional().describe('Dark text color.'),
          paper: hex.optional().describe('Light text color.'),
        })
        .optional(),
      fonts: z
        .object({
          heading: z.string().max(60).optional().describe('One of: Outfit (default), Work Sans, Bricolage Grotesque, Lora, Instrument Serif, Young Serif.'),
          body: z.string().max(60).optional().describe('Same list. Default: Work Sans.'),
        })
        .optional(),
      logo_url: z.url().optional().describe('Public https link to the logo (PNG with transparency is best).'),
      logo_url_light: z.url().optional().describe('Optional logo variant for DARK backgrounds (light-colored logo).'),
      logo_url_dark: z.url().optional().describe('Optional logo variant for LIGHT backgrounds (dark-colored logo).'),
      logo_position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
    })
    .optional()
    .describe('The user’s brand card. Missing parts fall back to a neutral palette and the default fonts.'),
  options: z
    .object({
      scrim: z.enum(['auto', 'none', 'strong']).optional().describe('Dark gradient behind text on photos so it stays readable. auto (default), none, or strong for busy photos.'),
      align: z.enum(['left', 'center', 'right']).optional(),
      text_position: z.enum(['top', 'center', 'bottom']).optional(),
      output: z.enum(['auto', 'png', 'jpg']).optional().describe('auto (default): jpg for photos, png for flat colors.'),
    })
    .optional(),
});

/** Warning codes that mean "the picture is not good enough to publish yet". */
const BLOCKING_WARNINGS = new Set(['headline_too_long']);

export function registerComposePost(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'compose_post',
    {
      title: 'Create a finished post graphic',
      description:
        'Draws a finished, ready-to-post image: the user’s headline (and optional eyebrow, short paragraph, button and footer) on top of a photo, color or gradient, ' +
        'with the brand colors and logo, in the right size for Instagram, Facebook, LinkedIn, X or stories. ' +
        'The text is drawn by this server, so it is always sharp and spelled exactly as given: never ask an AI image model to put words in a picture. ' +
        'Free (no AI cost), fast, and the same input always gives the same picture. ' +
        'Typical use: get the copy approved first, then call this with the photo link the user chose (or just a brand color), show the returned preview to the user, and only then pass the returned `url` to the scheduling tool (for example Postiz uploadFromUrlTool). ' +
        'Always read `warnings`: if one says the headline is too long, ask for or write a shorter headline and call again; if contrast is low, retry with options.scrim = "strong". ' +
        'The link stays available for about 30 days. Creating a graphic does not publish anything.',
      inputSchema,
      annotations: { title: 'Create a finished post graphic', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'compose_post', async (meta) => {
        meta.template = args.template;
        meta.format = args.format;

        const bg = args.background;
        const given = [bg?.image_url, bg?.color, bg?.gradient].filter((v) => v !== undefined).length;
        if (given > 1) {
          throw new UserFacingError('background_ambiguous', 'Give only one background: image_url, color or gradient.', 'Choose one and call compose_post again.');
        }

        const quota = ctx.ledger.countRender(user);

        const out = await composePost(
          {
            template: args.template,
            format: args.format,
            texts: args.texts,
            ...(args.background ? { background: args.background } : {}),
            ...(args.brand ? { brand: args.brand } : {}),
            ...(args.options ? { options: args.options } : {}),
          },
          { fonts: ctx.fonts, fetchImage: ctx.fetchImage },
        );

        const stored = await ctx.storage.put(out.data, out.ext);
        const preview = await makePreview(out.data, new PreviewBudget().remaining);
        meta.output = out.ext;
        meta.bytes = stored.bytes;
        meta.warnings = out.warnings.map((w) => w.code);

        const needsAttention = out.warnings.some((w) => BLOCKING_WARNINGS.has(w.code));
        return jsonResult(
          {
            url: stored.url,
            width: out.width,
            height: out.height,
            format: out.applied.format,
            template: out.applied.template,
            output: out.ext,
            bytes: stored.bytes,
            applied: { background: out.applied.background, scrim: out.applied.scrim, logo: out.applied.logo },
            warnings: out.warnings,
            needs_attention: needsAttention,
            graphics_left_today: quota.left,
            next_step: needsAttention
              ? 'Do not use this image yet: fix the warning (usually a shorter headline) and call compose_post again.'
              : 'Show the preview to the user. Once they approve, give `url` to the scheduling tool (e.g. Postiz uploadFromUrlTool); the link is kept for about 30 days.',
          },
          preview ? [{ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType }] : [],
        );
      }),
  );
}
