// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveBrandArg } from '../brands.js';
import type { AppContext } from '../context.js';
import { UserFacingError, isUserFacingError } from '../errors.js';
import { composePost } from '../render/compose.js';
import { FORMAT_NAMES } from '../render/formats.js';
import { makePreview, PreviewBudget } from '../render/preview.js';
import type { RenderWarning } from '../render/warnings.js';
import { backgroundSchema, optionsSchema, textsSchema } from './composePost.js';
import { fileRef, handoffClause, postizFor, uploadToPostizField } from './postizHelpers.js';
import { jsonResult, runTool } from './run.js';
import { BLOCKING_WARNINGS, CUSTOM_BLOCKING_WARNINGS, assetsSchema, brandArgSchema, renderSavedTemplate, resolveTemplateRef, variablesSchema, type TemplateRef } from './shared.js';

const MIN_SLIDES = 2;
const MAX_SLIDES = 10;
const PREVIEW_SLIDES = 3;

const slideSchema = z.object({
  template: z
    .string()
    .min(1)
    .max(81)
    .optional()
    .describe('Built-in template or saved template name for this slide. Default by position: the first slide carousel-cover, the last carousel-end, the others carousel-point.'),
  texts: textsSchema.optional().describe('Words for this slide (see compose_post). carousel-point numbers itself (1, 2, 3...) when `number` is not given.'),
  variables: variablesSchema.optional().describe('Saved templates only.'),
  assets: assetsSchema.optional().describe('Saved templates only.'),
  background: backgroundSchema.optional().describe('This slide’s photo (image_url), color or gradient. Only one.'),
  options: optionsSchema.optional().describe('Overrides the carousel-wide options for this slide.'),
});

const inputSchema = z.object({
  format: z.enum(FORMAT_NAMES).describe('One size for every slide: portrait (4:5) or square are the usual choices for carousels.'),
  slides: z.array(slideSchema).min(MIN_SLIDES).max(MAX_SLIDES).describe('2 to 10 slides, in order.'),
  brand: brandArgSchema.optional(),
  options: optionsSchema.optional().describe('Options applied to every slide unless the slide overrides them.'),
  counter: z
    .union([z.boolean(), z.object({ position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional() })])
    .optional()
    .describe('Slide counter chip such as "2/5" in a corner (default true; false for none). It never covers the logo.'),
  upload_to_postiz: uploadToPostizField,
});

export function registerComposeCarousel(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'compose_carousel',
    {
      title: 'Create a carousel of post graphics',
      description:
        'Draws 2 to 10 slides that share one brand and format, for an Instagram/LinkedIn/Facebook carousel. Each slide uses a built-in template (carousel-cover, carousel-point, carousel-end, or any other) ' +
        'or one of the user’s saved templates, with its own texts, variables, images and background. By default the first slide is a cover, the last a closing call to action and the ones in between numbered points, ' +
        'and a small "2/5" counter chip is drawn in a corner. Returns the image links IN ORDER (`urls`) plus small previews of the first 3 slides. ' +
        'Each slide counts as one composed graphic against the daily limit. Free (no AI cost), the same input gives the same pictures. ' +
        'Get the slide copy approved first; read `warnings` per slide (too-long headline, low contrast) and fix them before showing the user; then hand the `urls` in order to the scheduling tool (e.g. Postiz uploadFromUrlTool). Nothing is published by this tool. ' +
        'In local (stdio) mode each slide also has `file_path`. When Postiz credentials are configured, this tool uploads every final slide automatically (pass upload_to_postiz=false to skip it): the slides then have `postiz.path` and `postiz_paths` lists them in order, so use those paths directly, in that order, as the Postiz attachments (skip uploadFromUrlTool). A `postiz_error` on a slide is only a warning (call upload_to_postiz for that slide, or attach the file yourself). Each upload counts against Postiz’s 30 requests per hour.',
      inputSchema,
      annotations: { title: 'Create a carousel of post graphics', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'compose_carousel', async (meta) => {
        const total = args.slides.length;
        meta.format = args.format;
        meta.slides = total;

        // Everything that can be checked without drawing is checked first, so a typo in slide 7 does not cost 6 renders.
        const brandWarnings: RenderWarning[] = [];
        const brand = await resolveBrandArg(ctx, user, args.brand, brandWarnings);
        const refs: TemplateRef[] = args.slides.map((slide, i) => {
          const name = slide.template ?? (i === 0 ? 'carousel-cover' : i === total - 1 ? 'carousel-end' : 'carousel-point');
          try {
            return resolveTemplateRef(ctx, user, name);
          } catch (err) {
            if (isUserFacingError(err)) throw new UserFacingError(err.code, `Slide ${i + 1}: ${err.message}`, err.suggestion);
            throw err;
          }
        });
        args.slides.forEach((slide, i) => {
          const bg = slide.background;
          if ([bg?.image_url, bg?.color, bg?.gradient].filter((v) => v !== undefined).length > 1) {
            throw new UserFacingError('background_ambiguous', `Slide ${i + 1}: give only one background: image_url, color or gradient.`);
          }
          if (refs[i]?.kind === 'builtin' && !slide.texts?.headline?.trim()) {
            throw new UserFacingError('missing_headline', `Slide ${i + 1}: a headline is required.`, 'Provide texts.headline for every slide that uses a built-in template.');
          }
        });
        const before = ctx.ledger.quota(user).renders;
        if (before.left < total) {
          throw new UserFacingError('render_limit', `This carousel needs ${total} composed graphics but only ${before.left} are left today (limit ${before.limit}); it resets at 00:00 UTC.`, 'Make a shorter carousel, or try again tomorrow.');
        }

        const counterOn = args.counter !== false;
        const position = typeof args.counter === 'object' ? args.counter.position : undefined;
        const budget = new PreviewBudget();
        const images: { type: 'image'; data: string; mimeType: string }[] = [];
        const slides: Record<string, unknown>[] = [];
        const urls: string[] = [];
        const allWarnings: (RenderWarning & { slide: number })[] = [];
        const postizPaths: string[] = [];
        let pointNumber = 0;
        let left = before.left;

        for (let i = 0; i < total; i += 1) {
          const slide = args.slides[i]!;
          const ref = refs[i]!;
          const counter = counterOn ? { index: i + 1, total, position } : undefined;
          const options = { ...(args.options ?? {}), ...(slide.options ?? {}) };
          try {
            const quota = ctx.ledger.countRender(user);
            left = quota.left;
            let data: Buffer;
            let ext: 'png' | 'jpg';
            let width: number;
            let height: number;
            let warnings: RenderWarning[];
            let templateName: string;
            let blocking: ReadonlySet<string>;
            if (ref.kind === 'builtin') {
              const texts = { ...slide.texts, headline: slide.texts?.headline as string };
              if (ref.spec.id === 'carousel-point') {
                pointNumber += 1;
                if (texts.number === undefined) texts.number = String(pointNumber);
              }
              const out = await composePost(
                { template: ref.spec.id, format: args.format, texts, ...(slide.background ? { background: slide.background } : {}), brand, options, ...(counter ? { counter } : {}) },
                { fonts: ctx.fonts, fetchImage: (url) => ctx.fetchImage(url) },
              );
              ({ data, ext, width, height, warnings } = out);
              templateName = ref.spec.id;
              blocking = BLOCKING_WARNINGS;
            } else {
              const record = ref.record;
              const variables: Record<string, string> = { ...(slide.variables ?? {}) };
              for (const [k, v] of Object.entries(slide.texts ?? {})) if (v !== undefined && variables[k] === undefined) variables[k] = v;
              const assets: Record<string, string> = { ...(slide.assets ?? {}) };
              if (slide.background?.image_url && assets.background === undefined && record.variables.some((v) => v.kind === 'image' && v.name === 'background')) assets.background = slide.background.image_url;
              const out = await renderSavedTemplate({ ctx, record, format: args.format, brand, variables, assets, output: options.output, ...(counter ? { counter } : {}) });
              ({ data, ext, width, height, warnings } = out);
              templateName = record.owner === user ? record.name : `${record.owner}/${record.name}`;
              blocking = CUSTOM_BLOCKING_WARNINGS;
            }
            const stored = await ctx.storage.put(data, ext);
            urls.push(stored.url);
            if (i < PREVIEW_SLIDES) {
              const preview = await makePreview(data, Math.floor(budget.remaining / (PREVIEW_SLIDES - i)));
              if (preview) {
                budget.consume(preview.data.length);
                images.push({ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType });
              }
            }
            for (const w of warnings) allWarnings.push({ ...w, slide: i + 1 });
            const slideNeedsAttention = warnings.some((w) => blocking.has(w.code));
            const postiz = await postizFor(ctx, stored.key, args.upload_to_postiz, { autoDefault: true, data, meta, draft: slideNeedsAttention });
            if (postiz.postiz) postizPaths.push(postiz.postiz.path);
            slides.push({
              slide: i + 1,
              url: stored.url,
              ...fileRef(ctx, stored.key),
              ...postiz,
              template: templateName,
              width,
              height,
              output: ext,
              warnings,
              needs_attention: slideNeedsAttention,
            });
          } catch (err) {
            if (isUserFacingError(err)) throw new UserFacingError(err.code, `Slide ${i + 1} of ${total}: ${err.message}${i > 0 ? ` (slides 1-${i} were drawn: ${urls.join(' ')})` : ''}`, err.suggestion);
            throw err;
          }
        }

        const needsAttention = slides.some((s) => s.needs_attention === true);
        const allUploaded = postizPaths.length === total;
        meta.warnings = allWarnings.map((w) => w.code);
        return jsonResult(
          {
            count: total,
            format: args.format,
            urls,
            ...(allUploaded ? { postiz_paths: postizPaths } : {}),
            slides,
            previews_for_slides: images.map((_, i) => i + 1),
            ...(brand.slug ? { brand: brand.slug } : {}),
            warnings: [...brandWarnings, ...allWarnings],
            needs_attention: needsAttention,
            graphics_left_today: left,
            next_step: needsAttention
              ? 'Some slides need attention (see `slides[].warnings`): fix those texts and call compose_carousel again before showing the user.'
              : `Show the previews to the user. Once they approve, ${handoffClause(ctx, 'many', allUploaded)}`,
          },
          images,
        );
      }),
  );
}
