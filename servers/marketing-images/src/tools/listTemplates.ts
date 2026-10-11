// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { estimateCapacityChars, TextMeter } from '../render/fit.js';
import { DEFAULT_HEADING_FAMILY } from '../render/fonts.js';
import { FLOORS } from '../render/layout.js';
import { FORMAT_NAMES, FORMATS, scaleOf, textSafeRect, type FormatName } from '../render/formats.js';
import { TEMPLATES, type TemplateSpec } from '../render/templates/index.js';
import { jsonResult, runTool } from './run.js';

function formatInfo(ctx: AppContext, template: TemplateSpec, name: FormatName): Record<string, unknown> {
  const format = FORMATS[name];
  const spec = template.slots.headline;
  let headlineMaxChars: number | undefined;
  if (spec) {
    const face = ctx.fonts.resolve(DEFAULT_HEADING_FAMILY, DEFAULT_HEADING_FAMILY, spec.weight, false).face;
    const width = Math.min(textSafeRect(format).w, template.block.maxWidth[format.orientation] * format.width);
    headlineMaxChars = estimateCapacityChars(new TextMeter(face), Math.round(FLOORS.headline * scaleOf(format)), width, spec.maxLines);
  }
  return {
    width: format.width,
    height: format.height,
    use: format.description,
    ...(headlineMaxChars !== undefined ? { headline_max_chars_approx: headlineMaxChars } : {}),
  };
}

export function registerListTemplates(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'list_templates',
    {
      title: 'List post layouts',
      description:
        'Lists the ready-made layouts compose_post can draw (photo with headline, call-to-action card), what each is best for, which texts it accepts, ' +
        'the available formats with their pixel sizes, and roughly how many characters a headline can have in each format. ' +
        'Read-only and free. Use it to pick a layout for the user’s goal and to keep headlines short enough before composing. ' +
        'Optionally pass `format` to see only that format.',
      inputSchema: z.object({
        format: z
          .enum(FORMAT_NAMES)
          .optional()
          .describe('Only show this format: square, portrait (4:5), story (9:16), landscape (16:9) or link (1200x627).'),
      }),
      annotations: { title: 'List post layouts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ format }) =>
      runTool(ctx, user, 'list_templates', async (meta) => {
        const names = format ? [format] : FORMAT_NAMES;
        meta.format = format ?? 'all';
        return jsonResult({
          templates: TEMPLATES.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            best_for: t.best_for,
            texts: {
              required: ['headline'],
              optional: t.supports.filter((f) => f !== 'headline'),
              note: 'Texts not listed for a template are ignored with a warning.',
            },
            background: t.background === 'photo' ? 'a photo link (image_url), or a color/gradient' : 'brand primary color by default; a color, gradient or photo can be given',
            defaults: { align: t.defaults.align, text_position: t.defaults.textPosition, logo_corner: t.logo.corner },
            formats: Object.fromEntries(names.map((n) => [n, formatInfo(ctx, t, n)])),
          })),
          tips: [
            'Keep the headline short: it is never cut off, and a headline that is too long returns a warning asking for a shorter one.',
            'Text is drawn by the server (sharp and spelled exactly as written); never ask an image model to draw the words.',
            'Story (9:16) keeps text clear of the top 250 px and bottom 400 px where the app interface covers the image.',
          ],
        });
      }),
  );
}
