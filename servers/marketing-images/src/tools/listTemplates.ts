// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { estimateCapacityChars, TextMeter } from '../render/fit.js';
import { DEFAULT_HEADING_FAMILY } from '../render/fonts.js';
import { FLOORS } from '../render/layout.js';
import { FORMAT_NAMES, FORMATS, scaleOf, textSafeRect, type FormatName } from '../render/formats.js';
import { BUILTIN_INFO, builtinVariables } from '../render/templates/catalog.js';
import { TEMPLATES, type TemplateSpec } from '../render/templates/index.js';
import { jsonResult, runTool } from './run.js';
import { builtinPreviewUrl, templatePreviewUrl } from './shared.js';
import { variableLine } from './templates.js';

function formatInfo(ctx: AppContext, template: TemplateSpec, name: FormatName): Record<string, unknown> {
  const format = FORMATS[name];
  const spec = template.slots.headline;
  let headlineMaxChars: number | undefined;
  if (spec && !template.badge) {
    const face = ctx.fonts.resolve(DEFAULT_HEADING_FAMILY, DEFAULT_HEADING_FAMILY, spec.weight, false).face;
    const width = Math.min(textSafeRect(format).w, template.block.maxWidth[format.orientation] * format.width);
    headlineMaxChars = estimateCapacityChars(new TextMeter(face), Math.round(FLOORS[spec.role] * scaleOf(format)), width, spec.maxLines);
  }
  return {
    width: format.width,
    height: format.height,
    use: format.description,
    ...(headlineMaxChars !== undefined ? { headline_max_chars_approx: headlineMaxChars } : {}),
  };
}

const MAX_SAVED_PREVIEW_REPAIRS = 3;

export function registerListTemplates(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'list_templates',
    {
      title: 'List post layouts',
      description:
        'Lists every layout compose_post can draw: the built-in templates (photo-headline, cta-card, quote-card, split, minimal-badge, carousel-cover, carousel-point, carousel-end), ' +
        'the user’s own saved templates, and templates other users shared. For each: what it is best for, its variables (the texts and images it takes), the formats with pixel sizes ' +
        '(and roughly how many characters a headline can have), tags, who owns it, whether it is shared, and a preview picture link (built-in previews use sample content and are created on first request). ' +
        'Read-only and free. Use it to pick a layout for the user’s goal and to keep headlines short enough before composing. ' +
        'Pass `format` to see only layouts that work for it (and previews in that format), and `tag` to filter (e.g. "carousel", "quote", "photo"). ' +
        'To pass a saved template to compose_post use the `use_as` value.',
      inputSchema: z.object({
        format: z.enum(FORMAT_NAMES).optional().describe('Only show this format: square, portrait (4:5), story (9:16), landscape (16:9) or link (1200x627).'),
        tag: z.string().max(24).optional().describe('Only templates with this tag, e.g. "carousel", "quote", "photo", "badge", or a tag you saved.'),
      }),
      annotations: { title: 'List post layouts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ format, tag }) =>
      runTool(ctx, user, 'list_templates', async (meta) => {
        const names = format ? [format] : FORMAT_NAMES;
        const previewFormat: FormatName = format ?? 'square';
        meta.format = format ?? 'all';
        const wanted = tag?.toLowerCase();

        const builtins = TEMPLATES.filter((t) => wanted === undefined || (BUILTIN_INFO[t.id]?.tags ?? []).includes(wanted));
        const builtinEntries = [];
        for (const t of builtins) {
          const previewUrl = await builtinPreviewUrl(ctx, t.id, previewFormat);
          const formats = Object.fromEntries(
            names.map((n) => [n, { ...formatInfo(ctx, t, n), ...(n === previewFormat && previewUrl ? { preview_url: previewUrl } : {}) }]),
          );
          builtinEntries.push({
            id: t.id,
            use_as: t.id,
            kind: 'built-in',
            title: t.title,
            description: t.description,
            best_for: t.best_for,
            owner: 'built-in',
            own: false,
            shared: true,
            tags: BUILTIN_INFO[t.id]?.tags ?? [],
            texts: {
              required: ['headline'],
              optional: t.supports.filter((f) => f !== 'headline'),
              note: 'Texts not listed for a template are ignored with a warning.',
            },
            variables: builtinVariables(t).map(variableLine),
            background: t.background === 'photo' ? 'a photo link (image_url), or a color/gradient' : 'brand primary color by default; a color, gradient or photo can be given',
            defaults: { align: t.defaults.align, text_position: t.defaults.textPosition, logo_corner: t.logo.corner },
            formats,
            preview_format: previewFormat,
            preview_url: previewUrl ?? null,
          });
        }

        let repairs = 0;
        const savedEntries = [];
        for (const rec of ctx.templates.list(user)) {
          if (wanted !== undefined && !rec.tags.includes(wanted)) continue;
          if (format && rec.formats.length > 0 && !rec.formats.includes(format)) continue;
          const own = rec.owner === user;
          let previewUrl = rec.preview_url;
          if (repairs < MAX_SAVED_PREVIEW_REPAIRS) {
            const before = previewUrl;
            previewUrl = await templatePreviewUrl(ctx, rec);
            if (previewUrl !== before) repairs += 1;
          }
          const designed = rec.formats.length > 0 ? rec.formats : [...FORMAT_NAMES];
          savedEntries.push({
            id: rec.name,
            use_as: own ? rec.name : `${rec.owner}/${rec.name}`,
            kind: 'saved',
            title: rec.name,
            description: rec.description,
            best_for: rec.description,
            owner: rec.owner,
            own,
            shared: rec.shared,
            version: rec.version,
            tags: rec.tags,
            variables: rec.variables.map(variableLine),
            formats: Object.fromEntries(designed.filter((n) => !format || n === format).map((n) => [n, { width: FORMATS[n].width, height: FORMATS[n].height, use: FORMATS[n].description }])),
            designed_for: rec.formats.length > 0 ? rec.formats : 'any',
            preview_url: previewUrl,
            updated_at: new Date(rec.updated_at).toISOString(),
          });
        }

        meta.count = builtinEntries.length + savedEntries.length;
        return jsonResult({
          templates: [...builtinEntries, ...savedEntries],
          tips: [
            'Keep the headline short: it is never cut off, and a headline that is too long returns a warning asking for a shorter one.',
            'Text is drawn by the server (sharp and spelled exactly as written); never ask an image model to draw the words.',
            'Story (9:16) keeps text clear of the top 250 px and bottom 400 px where the app interface covers the image.',
            'For a carousel use compose_carousel: carousel-cover first, carousel-point for the middle slides, carousel-end last. Need something none of these can do? compose_custom draws your own HTML layout, and save_template keeps it.',
            ...(format ? [] : ['Previews are shown for the square format; pass `format` to get previews in another one.']),
          ],
        });
      }),
  );
}
