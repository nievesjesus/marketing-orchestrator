// registerTool, annotations and image content blocks: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
// Tool spec: https://modelcontextprotocol.io/specification/latest/server/tools · Zod schemas: https://zod.dev/api
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveBrandArg } from '../brands.js';
import type { AppContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import { composePost } from '../render/compose.js';
import { FORMAT_NAMES } from '../render/formats.js';
import { makePreview, PreviewBudget } from '../render/preview.js';
import type { RenderWarning } from '../render/warnings.js';
import { BLOCKING_WARNINGS, CUSTOM_BLOCKING_WARNINGS, assetsSchema, brandArgSchema, hexColor as hex, renderSavedTemplate, resolveTemplateRef, variablesSchema } from './shared.js';
import { jsonResult, runTool } from './run.js';

export const textsSchema = z.object({
  headline: z.string().min(1).max(200).optional().describe('Main message. Keep it SHORT (about 25-45 characters); it is never cut off, and too-long headlines come back with a warning. Required for built-in templates.'),
  eyebrow: z.string().max(80).optional().describe('Small label above the headline (e.g. "New season"). Letter case follows the brand style (capitals by default).'),
  body: z.string().max(600).optional().describe('Optional short paragraph under the headline (1-2 sentences).'),
  cta: z.string().max(60).optional().describe('Call to action drawn as a button (cta-card, split, carousel-cover, carousel-end), 2-4 words, e.g. "Book now".'),
  footer: z.string().max(100).optional().describe('Small line at the bottom of the text block, e.g. a website, @handle or the author of a quote.'),
  number: z.string().max(4).optional().describe('Point number in a small tag (carousel-point only), e.g. "1" or "02".'),
});

export const backgroundSchema = z.object({
  image_url: z.url().optional().describe('Public https link to a photo (JPEG, PNG, WebP or AVIF), e.g. from the user’s Postiz media or a generated image.'),
  color: hex.optional(),
  gradient: z
    .object({ from: hex, to: hex, angle: z.number().min(0).max(360).optional().describe('Degrees: 0 = bottom to top, 90 = left to right, 180 = top to bottom. Default 160.') })
    .optional(),
});

export const optionsSchema = z.object({
  scrim: z.enum(['auto', 'soft', 'none', 'strong']).optional().describe('Dark gradient behind text on photos so it stays readable. auto (default), soft (lighter), none, or strong for busy photos. Overrides the brand’s default.'),
  align: z.enum(['left', 'center', 'right']).optional(),
  text_position: z.enum(['top', 'center', 'bottom']).optional(),
  output: z.enum(['auto', 'png', 'jpg']).optional().describe('auto (default): jpg for photos, png for flat colors.'),
});

const inputSchema = z.object({
  template: z
    .string()
    .min(1)
    .max(81)
    .optional()
    .describe(
      'Layout to use. Built-in: photo-headline (photo, big headline at the bottom), cta-card (brand-color card with a button), quote-card (big quote), split (photo + text panel), ' +
        'minimal-badge (photo with a small label/price badge), carousel-cover, carousel-point, carousel-end. Or the name of a saved template (own or shared; "owner/name" picks a specific shared one). ' +
        'If omitted, the brand’s default template for the format is used. See list_templates.',
    ),
  format: z.enum(FORMAT_NAMES).describe('Image size: square 1080x1080, portrait 1080x1350 (4:5), story 1080x1920 (9:16), landscape 1920x1080, link 1200x627.'),
  texts: textsSchema.optional().describe('The words on the image. Written exactly as given (accents and ñ are fine; emoji are not supported). For saved templates these fill the variables of the same name.'),
  background: backgroundSchema
    .optional()
    .describe('Give exactly ONE of image_url, color or gradient. If omitted, photo templates use a brand gradient and card templates the brand primary color. For a saved template, image_url fills its "background" image variable.'),
  variables: variablesSchema.optional().describe('Saved templates only: texts for the template’s variables ({"price": "$12"}). Same names as listed by list_templates.'),
  assets: assetsSchema.optional().describe('Saved templates only: image links for the template’s image variables ({"hero": "https://..."}).'),
  brand: brandArgSchema.optional(),
  options: optionsSchema.optional(),
});

export function registerComposePost(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'compose_post',
    {
      title: 'Create a finished post graphic',
      description:
        'Draws a finished, ready-to-post image: the user’s headline (and optional eyebrow, short paragraph, button and footer) on top of a photo, color or gradient, ' +
        'with the brand colors, fonts and logo, in the right size for Instagram, Facebook, LinkedIn, X or stories. ' +
        'The text is drawn by this server, so it is always sharp and spelled exactly as given: never ask an AI image model to put words in a picture. ' +
        'Free (no AI cost), fast, and the same input always gives the same picture. ' +
        'Typical use: get the copy approved first, then call this with the photo link the user chose (or just a brand color), show the returned preview to the user, and only then pass the returned `url` to the scheduling tool (for example Postiz uploadFromUrlTool). ' +
        'Pass `brand` as the slug of a saved brand (list_brands) so every post matches the company style. ' +
        'Always read `warnings`: if one says the headline is too long, ask for or write a shorter headline and call again; if contrast is low, retry with options.scrim = "strong". ' +
        'The link stays available for about 30 days. Creating a graphic does not publish anything. For several slides use compose_carousel; for a one-off layout of your own design use compose_custom.',
      inputSchema,
      annotations: { title: 'Create a finished post graphic', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'compose_post', async (meta) => {
        meta.format = args.format;

        const bg = args.background;
        const given = [bg?.image_url, bg?.color, bg?.gradient].filter((v) => v !== undefined).length;
        if (given > 1) {
          throw new UserFacingError('background_ambiguous', 'Give only one background: image_url, color or gradient.', 'Choose one and call compose_post again.');
        }

        const brandWarnings: RenderWarning[] = [];
        const brand = await resolveBrandArg(ctx, user, args.brand, brandWarnings);
        const templateName = args.template ?? brand.style.default_templates?.[args.format];
        if (!templateName) {
          throw new UserFacingError('template_required', 'No template was given and the brand has no default template for this format.', 'Pass `template` (see list_templates), or save a brand with style.default_templates.');
        }
        meta.template = templateName;
        const resolved = resolveTemplateRef(ctx, user, templateName);

        const quota = ctx.ledger.countRender(user);
        const budget = new PreviewBudget();

        if (resolved.kind === 'builtin') {
          if (!args.texts?.headline || args.texts.headline.trim() === '') {
            throw new UserFacingError('missing_headline', 'A headline is required.', 'Provide texts.headline (short, ideally under 60 characters).');
          }
          const out = await composePost(
            {
              template: resolved.spec.id,
              format: args.format,
              texts: { ...args.texts, headline: args.texts.headline },
              ...(args.background ? { background: args.background } : {}),
              brand,
              ...(args.options ? { options: args.options } : {}),
            },
            { fonts: ctx.fonts, fetchImage: (url) => ctx.fetchImage(url) },
          );
          const warnings = [...brandWarnings, ...out.warnings];
          const stored = await ctx.storage.put(out.data, out.ext);
          const preview = await makePreview(out.data, budget.remaining);
          meta.output = out.ext;
          meta.bytes = stored.bytes;
          meta.warnings = warnings.map((w) => w.code);

          const needsAttention = warnings.some((w) => BLOCKING_WARNINGS.has(w.code));
          return jsonResult(
            {
              url: stored.url,
              width: out.width,
              height: out.height,
              format: out.applied.format,
              template: out.applied.template,
              output: out.ext,
              bytes: stored.bytes,
              applied: { background: out.applied.background, scrim: out.applied.scrim, logo: out.applied.logo, style: out.applied.style },
              ...(brand.slug ? { brand: brand.slug } : {}),
              warnings,
              needs_attention: needsAttention,
              graphics_left_today: quota.left,
              next_step: needsAttention
                ? 'Do not use this image yet: fix the warning (usually a shorter headline) and call compose_post again.'
                : 'Show the preview to the user. Once they approve, give `url` to the scheduling tool (e.g. Postiz uploadFromUrlTool); the link is kept for about 30 days.',
            },
            preview ? [{ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType }] : [],
          );
        }

        // Saved template: texts fill the variables of the same name; background.image_url fills the "background" image variable.
        const record = resolved.record;
        const variables: Record<string, string> = { ...(args.variables ?? {}) };
        for (const [k, v] of Object.entries(args.texts ?? {})) if (v !== undefined && variables[k] === undefined) variables[k] = v;
        const assets: Record<string, string> = { ...(args.assets ?? {}) };
        const extraWarnings: RenderWarning[] = [];
        if (bg?.image_url) {
          if (record.variables.some((v) => v.kind === 'image' && v.name === 'background') && assets.background === undefined) assets.background = bg.image_url;
          else extraWarnings.push({ code: 'background_ignored', message: 'background.image_url was not used: this template has no image variable called "background".', suggestion: 'Pass the image in `assets` under the name the template expects (see get_template).' });
        } else if (bg?.color || bg?.gradient) {
          extraWarnings.push({ code: 'background_ignored', message: 'background color/gradient is not used by saved templates.', suggestion: 'Use brand colors inside the template, or pick a built-in template.' });
        }
        const out = await renderSavedTemplate({ ctx, record, format: args.format, brand, variables, assets, output: args.options?.output });
        const warnings = [...brandWarnings, ...extraWarnings, ...out.warnings];
        const stored = await ctx.storage.put(out.data, out.ext);
        const preview = await makePreview(out.data, budget.remaining);
        meta.output = out.ext;
        meta.bytes = stored.bytes;
        meta.warnings = warnings.map((w) => w.code);
        const needsAttention = warnings.some((w) => CUSTOM_BLOCKING_WARNINGS.has(w.code));
        return jsonResult(
          {
            url: stored.url,
            width: out.width,
            height: out.height,
            format: args.format,
            template: record.owner === user ? record.name : `${record.owner}/${record.name}`,
            template_version: record.version,
            output: out.ext,
            bytes: stored.bytes,
            applied: { fit: out.applied.fit, fonts: out.applied.fonts },
            ...(brand.slug ? { brand: brand.slug } : {}),
            warnings,
            needs_attention: needsAttention,
            graphics_left_today: quota.left,
            next_step: needsAttention
              ? 'Do not use this image yet: fix the warnings (shorter texts, another format) and call compose_post again.'
              : 'Show the preview to the user. Once they approve, give `url` to the scheduling tool (e.g. Postiz uploadFromUrlTool); the link is kept for about 30 days.',
          },
          preview ? [{ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType }] : [],
        );
      }),
  );
}
