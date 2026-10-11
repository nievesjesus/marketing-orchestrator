import sharp from 'sharp';
import * as z from 'zod/v4';
import { resolveBrandArg, brandStyleSchema } from '../brands.js';
import type { AppContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import type { TemplateRecord, VariableSpec } from '../templates-store.js';
import { composePost, type ComposeDeps } from '../render/compose.js';
import { renderCustom, type CustomOutput } from '../render/custom/render.js';
import { FORMATS, type FormatName } from '../render/formats.js';
import { samplePhoto } from '../render/samplePhoto.js';
import { BUILTIN_INFO } from '../render/templates/catalog.js';
import { getTemplate, type TemplateSpec } from '../render/templates/index.js';
import { warn, type RenderWarning } from '../render/warnings.js';
import type { ResolvedBrand } from '../render/brand.js';

// ---- schemas shared by the compose tools -----------------------------------------------------

const hex = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex color such as #1F3A5F')
  .describe('Hex color such as #1F3A5F');

export const hexColor = hex;

export const brandInlineSchema = z.object({
  colors: z
    .object({
      primary: hex.optional().describe('Main brand color (card backgrounds, panels).'),
      secondary: hex.optional(),
      accent: hex.optional().describe('Highlight color (eyebrow text, buttons, tags).'),
      ink: hex.optional().describe('Dark text color.'),
      paper: hex.optional().describe('Light text color.'),
    })
    .optional(),
  fonts: z
    .object({
      heading: z.string().max(60).optional().describe('One of: Outfit (default), Work Sans, Bricolage Grotesque, Lora, Instrument Serif, Young Serif.'),
      body: z.string().max(60).optional().describe('Same list. Default: Work Sans.'),
      accent: z.string().max(60).optional().describe('Same list. Used for eyebrows, buttons and tags. Default: the heading font.'),
    })
    .optional(),
  logo_url: z.url().optional().describe('Public https link to the logo (PNG with transparency is best).'),
  logo_url_light: z.url().optional().describe('Optional logo variant for DARK backgrounds (light-colored logo).'),
  logo_url_dark: z.url().optional().describe('Optional logo variant for LIGHT backgrounds (dark-colored logo).'),
  logo_position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  style: brandStyleSchema.optional(),
});

export const brandArgSchema = z
  .union([z.string().regex(/^([A-Za-z0-9_-]{1,40}\/)?[a-z0-9][a-z0-9-]{0,39}$/, 'A saved brand slug such as "nova-clinic"').describe('Slug of a saved brand'), brandInlineSchema])
  .describe(
    'The user’s brand: EITHER the slug of a saved brand (a string such as "nova-clinic"; own brands first, then shared ones; see list_brands) ' +
      'OR an inline object { colors, fonts, logo_url, logo_position, style }. Missing parts fall back to a neutral palette and the default fonts. ' +
      'A saved brand also brings its uploaded fonts, stored logos and style rules (button shape, radius, eyebrow case, logo size, scrim).',
  );

export type BrandArg = z.infer<typeof brandArgSchema>;

export const assetsSchema = z
  .record(z.string(), z.url())
  .describe('Images the layout uses, as {"name": "https://..."} (at most 8; names are lower-case letters, digits, "-" or "_"). Use them as {{asset.<name>}}. Public JPEG, PNG, WebP or AVIF links only.');

export const variablesSchema = z
  .record(z.string(), z.string().max(2000))
  .describe('Texts for the {{var.<name>}} tokens, as {"name": "text"} (at most 40). They are drawn as plain text: markup in them is shown, never interpreted.');

// ---- templates ---------------------------------------------------------------------------------

export type TemplateRef = { kind: 'builtin'; spec: TemplateSpec } | { kind: 'saved'; record: TemplateRecord };

export function resolveTemplateRef(ctx: AppContext, user: string, ref: string): TemplateRef {
  const spec = getTemplate(ref);
  if (spec) return { kind: 'builtin', spec };
  const record = ctx.templates.find(user, ref);
  if (record) return { kind: 'saved', record };
  const saved = ctx.templates.list(user).map((t) => (t.owner === user ? t.name : `${t.owner}/${t.name}`));
  throw new UserFacingError(
    'unknown_template',
    `There is no template called "${ref}" that you can use.`,
    `Built-in: ${['photo-headline', 'cta-card', 'quote-card', 'split', 'minimal-badge', 'carousel-cover', 'carousel-point', 'carousel-end'].join(', ')}.${saved.length > 0 ? ` Saved: ${saved.join(', ')}.` : ''} Call list_templates to see them all.`,
  );
}

export interface SavedRenderArgs {
  ctx: AppContext;
  record: Pick<TemplateRecord, 'html' | 'variables' | 'formats' | 'name'>;
  format: FormatName;
  brand: ResolvedBrand;
  variables?: Record<string, string> | undefined;
  assets?: Record<string, string> | undefined;
  output?: 'auto' | 'png' | 'jpg' | undefined;
  counter?: { index: number; total: number; position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | undefined } | undefined;
  checks?: boolean | undefined;
}

export function composeDeps(ctx: AppContext, fonts = ctx.fonts): ComposeDeps {
  return { fonts, fetchImage: (url) => ctx.fetchImage(url) };
}

/** Render a saved template: required variables are enforced, lengths and formats produce warnings. */
export async function renderSavedTemplate(args: SavedRenderArgs): Promise<CustomOutput> {
  const { record } = args;
  const warnings: RenderWarning[] = [];
  const variables: Record<string, string> = { ...(args.variables ?? {}) };
  const assets: Record<string, string> = { ...(args.assets ?? {}) };
  const missing: string[] = [];
  const optionalAssets: string[] = [];
  for (const spec of record.variables) {
    if (spec.kind === 'text') {
      const value = variables[spec.name];
      if (value === undefined || value.trim() === '') {
        if (spec.required) missing.push(`${spec.name} (text)`);
        variables[spec.name] = '';
      } else if (spec.max_chars !== undefined && [...value].length > spec.max_chars) {
        warn(warnings, 'variable_too_long', `The text for "${spec.name}" has ${[...value].length} characters; this template was designed for at most ${spec.max_chars}.`, 'Shorten it, or check the preview for overflow warnings.');
      }
    } else if (assets[spec.name] === undefined) {
      if (spec.required) missing.push(`${spec.name} (image link)`);
      else optionalAssets.push(spec.name);
    }
  }
  if (missing.length > 0) {
    throw new UserFacingError('missing_variables', `The template "${record.name}" needs: ${missing.join(', ')}.`, 'Pass texts in `variables` and image links in `assets` (see get_template for the list).');
  }
  if (record.formats.length > 0 && !record.formats.includes(args.format)) {
    warn(warnings, 'template_format_mismatch', `The template "${record.name}" was designed for ${record.formats.join(', ')}, not ${args.format}; the layout may not fit.`, 'Check the preview and the warnings, or pick one of the designed formats.');
  }
  const out = await renderCustom(
    {
      html: record.html,
      format: FORMATS[args.format],
      brand: args.brand,
      assets,
      variables,
      optionalAssets,
      output: args.output,
      counter: args.counter,
      checks: args.checks,
    },
    composeDeps(args.ctx, args.brand.fontRegistry),
  );
  return { ...out, warnings: [...warnings, ...out.warnings] };
}

// ---- previews ----------------------------------------------------------------------------------

export async function thumbnail(image: Buffer, side = 640): Promise<Buffer> {
  return sharp(image).resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

/** True when `url` is one of our stored images that still exists (the retention sweep deletes old files). */
export async function isStoredUrl(ctx: AppContext, url: string | null | undefined): Promise<boolean> {
  if (!url) return false;
  const prefix = `${ctx.config.publicBaseUrl}/i/`;
  if (!url.startsWith(prefix)) return false;
  return (await ctx.storage.open(url.slice(prefix.length))) !== null;
}

/** Bump when the built-in templates or the catalog sample content change, so cached previews are rendered again. */
const PREVIEW_VERSION = 'v1';

/** Preview of a built-in template with sample content: rendered once per (template, format) on first request, then cached in storage. */
export async function builtinPreviewUrl(ctx: AppContext, id: string, format: FormatName): Promise<string | undefined> {
  const info = BUILTIN_INFO[id];
  if (!info) return undefined;
  const key = `builtin:${id}:${format}:${PREVIEW_VERSION}`;
  const cached = ctx.templates.getCachedPreview(key);
  if (cached && (await isStoredUrl(ctx, cached))) return cached;
  try {
    const photo = info.photo ? await samplePhoto(1600, 1600) : undefined;
    const out = await composePost(
      { template: id, format, texts: info.sample, ...(photo ? { background: { image_url: 'sample:photo' } } : {}), options: { output: 'jpg' } },
      { fonts: ctx.fonts, fetchImage: async () => photo as Buffer },
    );
    const stored = await ctx.storage.put(await thumbnail(out.data), 'jpg');
    ctx.templates.setCachedPreview(key, stored.url);
    return stored.url;
  } catch (err) {
    ctx.logger.warn('builtin_preview_failed', { template: id, format, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/** Example values of a saved template's variables, used for its preview. */
export function exampleInputs(variables: readonly VariableSpec[]): { variables: Record<string, string>; assets: Record<string, string> } {
  const vars: Record<string, string> = {};
  const assets: Record<string, string> = {};
  for (const v of variables) {
    if (v.example === undefined) continue;
    if (v.kind === 'text') vars[v.name] = v.example;
    else assets[v.name] = v.example;
  }
  return { variables: vars, assets };
}

/** The preview URL of a saved template; renders it again (from the examples) when the stored file has expired. */
export async function templatePreviewUrl(ctx: AppContext, record: TemplateRecord): Promise<string | null> {
  if (record.preview_url && (await isStoredUrl(ctx, record.preview_url))) return record.preview_url;
  try {
    const examples = exampleInputs(record.variables);
    const format: FormatName = record.formats[0] ?? 'square';
    const brand = await resolveBrandArg(ctx, record.owner, undefined, []);
    const out = await renderSavedTemplate({ ctx, record, format, brand, variables: examples.variables, assets: examples.assets, output: 'jpg', checks: false });
    const stored = await ctx.storage.put(await thumbnail(out.data), 'jpg');
    ctx.templates.setPreviewUrl(record.id, stored.url);
    return stored.url;
  } catch (err) {
    ctx.logger.warn('template_preview_failed', { template: record.name, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Warning codes that mean "the picture is not good enough to publish yet". */
export const BLOCKING_WARNINGS = new Set(['headline_too_long']);
export const CUSTOM_BLOCKING_WARNINGS = new Set(['text_overflow', 'text_does_not_fit', 'text_outside_canvas', 'low_contrast', 'text_outside_safe_zone']);
