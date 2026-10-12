// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveBrandArg } from '../brands.js';
import type { AppContext } from '../context.js';
import { renderCustom } from '../render/custom/render.js';
import { FORMAT_NAMES, FORMATS } from '../render/formats.js';
import { makePreview, PreviewBudget } from '../render/preview.js';
import type { RenderWarning } from '../render/warnings.js';
import { fileRef, handoffClause, postizFor, uploadToPostizField } from './postizHelpers.js';
import { jsonResult, runTool } from './run.js';
import { CUSTOM_BLOCKING_WARNINGS, assetsSchema, brandArgSchema, composeDeps, variablesSchema } from './shared.js';

export const CUSTOM_HTML_GUIDE =
  'HTML with INLINE styles only (style="..."): div, span, p, h1-h6, img, br, b/strong/i/em/u and inline <svg> (path, circle, rect, line, g, linearGradient...). ' +
  'No <script> (removed), no <style> blocks or classes (ignored with a warning), no external links: images must be declared in `assets`. ' +
  'Layout = CSS flexbox (display:flex; flex-direction; gap; align-items; justify-content; flex:1), grid, block flow, position:absolute with left/top/right/bottom, width/height in px or %. ' +
  'Look = linear/radial-gradient backgrounds, box-shadow, text-shadow, border + border-radius, opacity, transform (rotate/scale/translate), object-fit on <img>, filter: blur(), -webkit-text-stroke, mix-blend-mode, overflow:hidden, clip-path. ' +
  'Text = font-family (ONLY the registry fonts or the brand fonts; an unknown family falls back with a warning), font-size/weight/style, line-height, letter-spacing, text-transform, text-align, text-wrap:balance, white-space. ' +
  'Not supported (ignored with a warning): classes/stylesheets, transitions/animations, columns, writing-mode, direction, pseudo-elements, tables, emoji. ' +
  'The outer element should be exactly the canvas: style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px" (widths/heights do NOT include padding unless you add box-sizing:border-box). ' +
  'TOKENS (replaced before drawing): {{brand.color.primary|secondary|accent|ink|paper|<extra name>}}, {{brand.font.heading|body|accent}} (use as font-family), ' +
  '{{brand.logo}} {{brand.logo_light}} {{brand.logo_dark}} (use as <img src>), {{brand.radius}} (px), {{brand.style.radius|button|eyebrow_case|eyebrow_transform|logo_position|logo_size|scrim}}, ' +
  '{{asset.<name>}} (+ .width / .height), {{var.<name>}} (plain text, HTML-escaped), {{format.width|height|scale}}, {{px.<n>}} (n px at the 1080-px reference, scaled to the format: font-size:{{px.40}}px keeps proportions on every format), {{safe.top|bottom|left|right|width|height}} (title-safe insets in px: keep text inside them). ' +
  'AUTO-FIT: on a text element add data-fit (optionally data-fit-min / data-fit-max in px and data-fit-lines) and the server picks the largest font size that fits its box; the element must contain only text. ' +
  'Add data-decor to an element to skip the safe-zone/overflow/contrast checks (intentional bleed or overlap). ' +
  'Limits: html up to 50 KB, 8 assets, 200 elements, 10 s per render.';

const inputSchema = z.object({
  format: z.enum(FORMAT_NAMES).describe('Image size: square 1080x1080, portrait 1080x1350 (4:5), story 1080x1920 (9:16, keep text out of the top 250 px and bottom 400 px), landscape 1920x1080, link 1200x627.'),
  html: z.string().min(1).max(50 * 1024).describe('The layout as HTML with inline styles and tokens (see the tool description).'),
  brand: brandArgSchema.optional(),
  assets: assetsSchema.optional(),
  variables: variablesSchema.optional(),
  output: z.enum(['auto', 'png', 'jpg']).optional().describe('auto (default): jpg when the layout uses photos (assets), png otherwise.'),
  upload_to_postiz: uploadToPostizField,
});

export function registerComposeCustom(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'compose_custom',
    {
      title: 'Draw a custom layout from HTML',
      description:
        'Draws a finished post graphic from a layout YOU design as HTML with inline styles, when the built-in templates (compose_post) are not enough: magazine covers, price lists, ' +
        'multi-column menus, badges, collages, any composition of photos, shapes and text. The server draws it with the same engine and the brand fonts/colors, so text is always sharp and spelled exactly as written. ' +
        'Free (no AI cost) and deterministic. After drawing, the server checks the result and returns `warnings` for text outside the safe area, text overflowing its box or cut off by the edge, and low contrast against the background: ' +
        'read them, fix the HTML and call again until `needs_attention` is false, then show the preview to the user before using the link. ' +
        'Saving a layout you will reuse: save_template. ' +
        'In local (stdio) mode the result also has `file_path`; When Postiz credentials are configured, this tool uploads the final graphic automatically (pass upload_to_postiz=false to skip it): if the result has `postiz.path`, the image is already in Postiz, so use that path directly as the Postiz attachment (skip uploadFromUrlTool); a `postiz_error` is only a warning (call upload_to_postiz once, or attach the file yourself). ' +
        CUSTOM_HTML_GUIDE,
      inputSchema,
      annotations: { title: 'Draw a custom layout from HTML', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'compose_custom', async (meta) => {
        meta.format = args.format;
        meta.template = 'custom';
        const brandWarnings: RenderWarning[] = [];
        const brand = await resolveBrandArg(ctx, user, args.brand, brandWarnings);
        const quota = ctx.ledger.countRender(user);
        const out = await renderCustom(
          { html: args.html, format: FORMATS[args.format], brand, assets: args.assets, variables: args.variables, output: args.output },
          composeDeps(ctx, brand.fontRegistry),
        );
        const warnings = [...brandWarnings, ...out.warnings];
        const stored = await ctx.storage.put(out.data, out.ext);
        const preview = await makePreview(out.data, new PreviewBudget().remaining);
        meta.output = out.ext;
        meta.bytes = stored.bytes;
        meta.nodes = out.applied.nodes;
        meta.warnings = warnings.map((w) => w.code);
        const needsAttention = warnings.some((w) => CUSTOM_BLOCKING_WARNINGS.has(w.code));
        const postiz = await postizFor(ctx, stored.key, args.upload_to_postiz, { autoDefault: true, data: out.data, meta, draft: needsAttention });
        return jsonResult(
          {
            url: stored.url,
            ...fileRef(ctx, stored.key),
            ...postiz,
            width: out.width,
            height: out.height,
            format: args.format,
            output: out.ext,
            bytes: stored.bytes,
            applied: { elements: out.applied.nodes, assets: out.applied.assets, fonts: out.applied.fonts, auto_fit: out.applied.fit, render_ms: out.applied.ms },
            ...(brand.slug ? { brand: brand.slug } : {}),
            warnings,
            needs_attention: needsAttention,
            graphics_left_today: quota.left,
            next_step: needsAttention
              ? 'Do not use this image yet: fix the warnings that concern text (overflow, safe area, contrast) in the HTML and call compose_custom again.'
              : `Show the preview to the user. Once they approve, ${handoffClause(ctx, 'one', postiz.postiz !== undefined)} To reuse this layout, call save_template.`,
          },
          preview ? [{ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType }] : [],
        );
      }),
  );
}
