// registerTool and annotations: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { brandNotFound, brandSchema, loadBrand, publicBrandData, saveBrand, SLUG_RE, type StoredBrandData } from '../brands.js';
import { renderBrandSheet } from '../brand-sheet.js';
import type { BrandRecord } from '../brands-store.js';
import type { AppContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import { makePreview, PreviewBudget } from '../render/preview.js';
import type { RenderWarning } from '../render/warnings.js';
import { jsonResult, runTool } from './run.js';
import { composeDeps, isStoredUrl, thumbnail } from './shared.js';

/** Draw the brand sheet for a stored brand and keep it in the image storage (a 1280-px JPEG). */
async function drawSheet(ctx: AppContext, record: BrandRecord): Promise<{ data: Buffer; url: string; warnings: RenderWarning[] }> {
  const warnings: RenderWarning[] = [];
  const brand = await loadBrand(ctx, record, warnings);
  const sheet = await renderBrandSheet(brand, { name: record.display_name, slug: record.slug, version: record.version }, composeDeps(ctx, brand.fontRegistry));
  const stored = await ctx.storage.put(await thumbnail(sheet.data, 1280), 'jpg');
  ctx.brands.setPreviewUrl(record.id, stored.url);
  return { data: sheet.data, url: stored.url, warnings: [...warnings, ...sheet.warnings] };
}

async function brandPreviewUrl(ctx: AppContext, record: BrandRecord): Promise<string | null> {
  if (record.preview_url && (await isStoredUrl(ctx, record.preview_url))) return record.preview_url;
  try {
    return (await drawSheet(ctx, record)).url;
  } catch (err) {
    ctx.logger.warn('brand_preview_failed', { brand: record.slug, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const summary = (record: BrandRecord, viewer: string): Record<string, unknown> => {
  const data = record.data as StoredBrandData;
  return {
    slug: record.slug,
    use_as: record.owner === viewer ? record.slug : `${record.owner}/${record.slug}`,
    display_name: record.display_name,
    owner: record.owner,
    own: record.owner === viewer,
    shared: record.shared,
    version: record.version,
    colors: { primary: data.colors.primary, accent: data.colors.accent, ink: data.colors.ink, paper: data.colors.paper },
    fonts: data.fonts,
    has_logo: Object.keys(data.logos).length > 0,
    uploaded_fonts: [...new Set(data.font_files.map((f) => f.family))],
    updated_at: new Date(record.updated_at).toISOString(),
  };
};

const MAX_PREVIEW_REPAIRS = 3;

export function registerBrandTools(server: McpServer, ctx: AppContext, user: string): void {
  server.registerTool(
    'save_brand',
    {
      title: 'Save a brand',
      description:
        'Saves a company’s brand under the user’s name so every graphic can match it: pass its slug as `brand` to compose_post, compose_custom and compose_carousel (and to save_template for previews). ' +
        'Saving an existing slug creates a new version. The server validates the colors (hex) and fonts, DOWNLOADS the logos and font files once and stores them (links are never used again), and returns a brand sheet picture ' +
        '(palette swatches, font specimens, logos) to show the user for approval. ' +
        'Data: colors {primary, secondary?, accent, ink = text on light backgrounds, paper = background/text on dark, extra?: [{name, hex}]}; ' +
        'fonts {heading, body, accent?}, each a bundled family (Outfit, Work Sans, Bricolage Grotesque, Lora, Instrument Serif, Young Serif) or a family you upload in font_files [{family, weight, style, url}] (TTF/OTF only, WOFF2 is rejected); ' +
        'logos {primary?, light? (for dark backgrounds), dark? (for light backgrounds)} as https links (PNG best, SVG is rasterized); ' +
        'style {radius: none|small|medium|large|pill, button: pill|rounded|square|underline, eyebrow_case: upper|title|none, letter_spacing_eyebrow?, logo_position, logo_size: small|medium|large, scrim: auto|soft|strong|none, default_templates?: {format: template}, photo_style?}; ' +
        'voice? {tone_words, avoid_words, hashtags, language} is stored for your own use. `shared: true` lets every user of this server use the brand (not change it). ' +
        'Only save a brand the user has given you (or approved).',
      inputSchema: brandSchema,
      annotations: { title: 'Save a brand', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, user, 'save_brand', async (meta) => {
        meta.brand = args.slug;
        const { record, warnings } = await saveBrand(ctx, user, args);
        meta.version = record.version;
        let sheet: Awaited<ReturnType<typeof drawSheet>> | undefined;
        try {
          ctx.ledger.countRender(user);
          sheet = await drawSheet(ctx, record);
        } catch (err) {
          warnings.push({ code: 'sheet_failed', message: 'The brand was saved, but its preview sheet could not be drawn.', suggestion: 'Call get_brand or list_brands later to try again.' });
          ctx.logger.warn('brand_sheet_failed', { brand: record.slug, error: err instanceof Error ? err.message : String(err) });
        }
        const all = [...warnings, ...(sheet?.warnings ?? [])];
        const preview = sheet ? await makePreview(sheet.data, new PreviewBudget().remaining) : null;
        return jsonResult(
          {
            saved: true,
            slug: record.slug,
            version: record.version,
            display_name: record.display_name,
            owner: user,
            shared: record.shared,
            brand: publicBrandData(record),
            preview_url: sheet?.url ?? null,
            warnings: all,
            use_it: `Pass brand: "${record.slug}" to compose_post, compose_custom, compose_carousel or save_template.`,
          },
          preview ? [{ type: 'image', data: preview.data.toString('base64'), mimeType: preview.mimeType }] : [],
        );
      }),
  );

  server.registerTool(
    'list_brands',
    {
      title: 'List saved brands',
      description:
        'Lists the brands the user can use: their own and the ones other users shared, each with slug, display name, main colors, fonts, whether a logo is stored, shared flag, version and a link to its brand sheet picture. ' +
        'Read-only and free. Pass the `use_as` value as `brand` to compose_post, compose_custom or compose_carousel. If there is no brand yet, ask the user for their colors, fonts and logo and call save_brand.',
      inputSchema: z.object({}),
      annotations: { title: 'List saved brands', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      runTool(ctx, user, 'list_brands', async (meta) => {
        const records = ctx.brands.list(user);
        meta.count = records.length;
        let repairs = 0;
        const brands = [];
        for (const rec of records) {
          let previewUrl = rec.preview_url;
          if (repairs < MAX_PREVIEW_REPAIRS) {
            const before = previewUrl;
            previewUrl = await brandPreviewUrl(ctx, rec);
            if (previewUrl !== before) repairs += 1;
          }
          brands.push({ ...summary(rec, user), preview_url: previewUrl });
        }
        return jsonResult({ brands, note: brands.length === 0 ? 'No brands saved yet. Use save_brand.' : 'Use the `use_as` value as `brand` in the compose tools.' });
      }),
  );

  server.registerTool(
    'get_brand',
    {
      title: 'Get a brand’s full data',
      description:
        'Returns everything saved for a brand (own, or shared by someone else): colors incl. extra colors, fonts and uploaded font families, which logos are stored, the style rules, the voice notes (tone words, words to avoid, hashtags, language) ' +
        'and the photo style text you can add to image prompts. Read-only and free. Use it to write copy and image prompts in the brand’s voice.',
      inputSchema: z.object({
        slug: z.string().min(1).max(81).describe('Brand slug ("nova-clinic"), or "owner/slug" for a shared brand from someone else.'),
        version: z.number().int().min(1).optional().describe('Your own brands: a specific older version (default: the latest).'),
      }),
      annotations: { title: 'Get a brand’s full data', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, version }) =>
      runTool(ctx, user, 'get_brand', async (meta) => {
        meta.brand = slug;
        const record = version !== undefined ? ctx.brands.getOwn(user, slug, version) : ctx.brands.find(user, slug);
        if (!record) throw brandNotFound(ctx, user, slug);
        const previewUrl = await brandPreviewUrl(ctx, record);
        return jsonResult({ ...summary(record, user), brand: publicBrandData(record), preview_url: previewUrl });
      }),
  );

  server.registerTool(
    'delete_brand',
    {
      title: 'Delete a saved brand',
      description:
        'Deletes one of the USER’S OWN saved brands (every version, with its stored logos and fonts becoming unused). It cannot be undone through this server, and compose calls that name it will fail. ' +
        'ALWAYS ask the user to confirm first ("Delete the brand nova-clinic?") and only call this after they say yes. Other people’s brands cannot be deleted.',
      inputSchema: z.object({ slug: z.string().regex(SLUG_RE).describe('Slug of one of the user’s own brands.') }),
      annotations: { title: 'Delete a saved brand', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) =>
      runTool(ctx, user, 'delete_brand', async (meta) => {
        meta.brand = slug;
        const removed = ctx.brands.delete(user, slug);
        if (removed === 0) {
          const visible = ctx.brands.find(user, slug); // only returns what the caller may see (own or shared)
          if (visible) throw new UserFacingError('brand_not_yours', `The brand "${slug}" is shared by ${visible.owner} and can only be deleted by them.`, 'You can still use it, or save your own brand under another slug.');
          throw brandNotFound(ctx, user, slug);
        }
        return jsonResult({ deleted: true, slug, versions_removed: removed });
      }),
  );
}
