import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as z from 'zod/v4';
import type { BrandRecord } from './brands-store.js';
import type { AppContext } from './context.js';
import { UserFacingError, isUserFacingError } from './errors.js';
import { sniffFormat } from './fetchsafe.js';
import {
  BRAND_SCRIMS,
  BUTTON_STYLES,
  EYEBROW_CASES,
  LOGO_CORNERS,
  LOGO_SIZES,
  RADIUS_NAMES,
  isResolvedBrand,
  resolveBrand,
  resolveStyle,
  type BrandInput,
  type BrandStyle,
  type ResolvedBrand,
} from './render/brand.js';
import { toHex } from './render/color.js';
import { DEFAULT_BODY_FAMILY, DEFAULT_HEADING_FAMILY, familyKey, parseFontFace, type FontFace } from './render/fonts.js';
import { FORMAT_NAMES } from './render/formats.js';
import { warn, type RenderWarning } from './render/warnings.js';

/**
 * Saved brands. A brand is everything the renderers need to look like one company: colors, fonts (bundled families or fonts the
 * owner uploaded), logos, and a style (corner radius, button shape, eyebrow case, logo position/size, scrim, default templates).
 *
 * Assets are DOWNLOADED ONCE at save time (fetchsafe) and kept on the server's persistent volume, never hot-linked:
 *   fonts  -> DATA_DIR/fonts/<owner>/<slug>/<sha256-16>.<ttf|otf>
 *   logos  -> DATA_DIR/brands/<owner>/<slug>/<sha256-16>.png   (SVG is rasterized with sharp at density 300)
 * (Not in the public image storage: that one is swept after RETENTION_DAYS, a brand must not lose its logo.)
 * Only the host of each source URL is kept, because links can carry signatures.
 */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FONT_BYTES = 8 * 1024 * 1024;
const MAX_FONT_FILES = 6;

const hex = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex color such as #1F3A5F')
  .describe('Hex color such as #1F3A5F');

export const brandStyleSchema = z
  .object({
    radius: z.enum(RADIUS_NAMES).optional().describe('Corner roundness of tags, panels and badges: none, small, medium (default), large, pill.'),
    button: z.enum(BUTTON_STYLES).optional().describe('Call-to-action button shape: pill (default), rounded, square or underline (text with an accent underline).'),
    eyebrow_case: z.enum(EYEBROW_CASES).optional().describe('Letter case of the small label above headlines: upper (default), title or none (as written).'),
    letter_spacing_eyebrow: z.number().min(0).max(0.4).optional().describe('Eyebrow letter spacing in em, 0 to 0.4 (default 0.14 for upper case).'),
    logo_position: z.enum(LOGO_CORNERS).optional().describe('Corner for the logo (default top-left).'),
    logo_size: z.enum(LOGO_SIZES).optional().describe('Logo width: small 12%, medium 16% (default), large 20% of the image width.'),
    scrim: z.enum(BRAND_SCRIMS).optional().describe('Default darkening behind text on photos: auto (default), soft, strong or none. A scrim given in a compose call wins.'),
    default_templates: z.partialRecord(z.enum(FORMAT_NAMES), z.string().min(1).max(60)).optional().describe('Template to use per format when a compose call gives none, e.g. {"story": "photo-headline", "square": "quote-card"}.'),
    photo_style: z.string().max(300).optional().describe('Plain text describing the photo look for image prompts, e.g. "warm natural light, minimal, beige tones". Not used by the renderer.'),
  })
  .describe('Look-and-feel rules the built-in templates apply (and custom HTML can read as {{brand.style.*}} / {{brand.radius}}).');

export const brandSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Use lower-case letters, digits and "-" (max 40), e.g. "nova-clinic"').describe('Short id, unique per owner. Saving an existing slug adds a new version.'),
  display_name: z.string().min(1).max(80).describe('Name shown to people, e.g. "Nova Clinic".'),
  shared: z.boolean().optional().describe('true = every user of this server can use the brand (not edit or delete it). Default false (private).'),
  colors: z
    .object({
      primary: hex.describe('Main brand color: card backgrounds, panels.'),
      secondary: hex.optional().describe('Second brand color (optional).'),
      accent: hex.describe('Highlight color: eyebrow text, buttons, tags.'),
      ink: hex.describe('Text color on LIGHT backgrounds (dark).'),
      paper: hex.describe('Background / text color on DARK backgrounds (light).'),
      extra: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/, 'lower-case letters, digits, "-"'), hex })).max(10).optional().describe('More named colors, available as {{brand.color.<name>}} in custom HTML.'),
    })
    .describe('Brand palette.'),
  fonts: z
    .object({
      heading: z.string().min(1).max(60).describe('Family for headlines: a bundled font or one listed in font_files.'),
      body: z.string().min(1).max(60).describe('Family for paragraphs.'),
      accent: z.string().min(1).max(60).optional().describe('Family for eyebrows, buttons and tags (default: the heading font).'),
    })
    .describe('Font families by name. Bundled: Outfit, Work Sans, Bricolage Grotesque, Lora, Instrument Serif, Young Serif.'),
  font_files: z
    .array(
      z.object({
        family: z.string().min(1).max(60).describe('The family name this file belongs to (the one used in `fonts`).'),
        weight: z.number().int().min(100).max(900).describe('400 = regular, 700 = bold.'),
        style: z.enum(['normal', 'italic']),
        url: z.url().describe('Public https link to a .ttf or .otf file (WOFF/WOFF2 are rejected). Downloaded once and stored.'),
      }),
    )
    .max(MAX_FONT_FILES)
    .optional()
    .describe('Fonts to upload, TTF/OTF only, up to 6 files.'),
  logos: z
    .object({
      primary: z.url().optional().describe('Main logo (PNG with transparency is best; SVG is rasterized).'),
      light: z.url().optional().describe('Light-colored logo variant for DARK backgrounds.'),
      dark: z.url().optional().describe('Dark-colored logo variant for LIGHT backgrounds.'),
    })
    .optional()
    .describe('Public https links; downloaded once and stored.'),
  style: brandStyleSchema.optional(),
  voice: z
    .object({
      tone_words: z.array(z.string().max(40)).max(12).optional(),
      avoid_words: z.array(z.string().max(40)).max(20).optional(),
      hashtags: z.array(z.string().max(40)).max(20).optional(),
      language: z.string().max(20).optional().describe('e.g. "es", "en-US"'),
    })
    .optional()
    .describe('Tone of voice, stored for convenience (the image renderer does not use it).'),
});
export type BrandSaveInput = z.infer<typeof brandSchema>;

export interface StoredFontFile {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  file: string;
  bytes: number;
  source_host: string;
}

export interface StoredLogo {
  file: string;
  width: number;
  height: number;
  source_host: string;
}

export interface StoredBrandData {
  colors: { primary: string; secondary: string; accent: string; ink: string; paper: string; extra: { name: string; hex: string }[] };
  fonts: { heading: string; body: string; accent?: string };
  font_files: StoredFontFile[];
  logos: { primary?: StoredLogo; light?: StoredLogo; dark?: StoredLogo };
  style: BrandStyle;
  voice?: NonNullable<BrandSaveInput['voice']>;
}

// ---- paths ----------------------------------------------------------------------------------

function assetDir(ctx: AppContext, kind: 'fonts' | 'brands', owner: string, slug: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(owner) || !SLUG_RE.test(slug)) throw new Error('unsafe brand path');
  const base = path.resolve(ctx.config.dataDir, kind);
  const dir = path.resolve(base, owner, slug);
  if (!dir.startsWith(base + path.sep)) throw new Error('unsafe brand path');
  return dir;
}

const sha16 = (data: Buffer): string => createHash('sha256').update(data).digest('hex').slice(0, 16);
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
};

// ---- font and logo ingestion --------------------------------------------------------------

function checkFont(buf: Buffer, family: string): { ext: 'ttf' | 'otf'; face: FontFace; warnings: RenderWarning[] } {
  const warnings: RenderWarning[] = [];
  if (buf.length > MAX_FONT_BYTES) throw new UserFacingError('font_too_large', `The font file for "${family}" is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB.`, 'Use a smaller font file (a single weight, Latin subset).');
  const head = buf.subarray(0, 4).toString('latin1');
  if (head === 'wOFF' || head === 'wOF2') {
    throw new UserFacingError('font_unsupported', `The font file for "${family}" is a WOFF/WOFF2 file, which is not supported.`, 'Use a .ttf or .otf file (download the TTF from the font foundry or Google Fonts), or pick one of the bundled fonts.');
  }
  const sniffed = sniffFormat(buf, 'font');
  if (!sniffed) throw new UserFacingError('font_unsupported', `The font file for "${family}" is not a TTF or OTF font.`, 'Use a .ttf or .otf link.');
  let face: FontFace;
  try {
    face = parseFontFace(family, 'upload', 400, false, buf);
  } catch {
    throw new UserFacingError('font_unreadable', `The font file for "${family}" could not be read (it may be damaged).`, 'Try another copy of the font.');
  }
  const probe = ['ñ', 'é', 'á'].filter((ch) => face.font.charToGlyphIndex(ch) === 0);
  if (probe.length > 0) {
    warn(warnings, 'font_missing_glyphs', `The font for "${family}" has no glyphs for ${probe.join(' ')}, so Spanish/Portuguese accents may be missing.`, 'Use a font with Latin Extended support, or pick a bundled font for texts with accents.');
  }
  return { ext: sniffed.format === 'otf' ? 'otf' : 'ttf', face, warnings };
}

/** Reject SVGs that could reach outside the file or run something: only inline shapes, gradients and embedded images are allowed. */
export function assertSafeSvg(buf: Buffer): void {
  const bad = (): never => {
    throw new UserFacingError('logo_unsafe', 'That SVG logo references outside files, scripts or entities, so it was not used.', 'Export a plain SVG (no scripts, no external images or fonts), or upload a PNG logo instead.');
  };
  if (buf.length > 2 * 1024 * 1024) throw new UserFacingError('logo_too_large', 'The SVG logo is larger than 2 MB.', 'Simplify the SVG or upload a PNG instead.');
  const text = buf.toString('utf8');
  if (/<!ENTITY/i.test(text) || /<script/i.test(text) || /<foreignObject/i.test(text) || /\bon[a-z]+\s*=/i.test(text) || /javascript:/i.test(text) || /@import/i.test(text)) bad();
  for (const m of text.matchAll(/href\s*=\s*["']([^"']*)["']/gi)) {
    const v = (m[1] ?? '').trim();
    if (!(v.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v))) bad();
  }
  for (const m of text.matchAll(/url\(\s*["']?([^"')\s]*)/gi)) {
    const v = (m[1] ?? '').trim();
    if (!(v.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v))) bad();
  }
}

async function normalizeLogo(buf: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const isSvg = sniffFormat(buf, 'image', true)?.format === 'svg';
  if (isSvg) assertSafeSvg(buf);
  try {
    const input = isSvg ? sharp(buf, { density: 300, limitInputPixels: 40_000_000 }) : sharp(buf, { limitInputPixels: 40_000_000, failOn: 'error' });
    const { data, info } = await input.rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch {
    throw new UserFacingError('logo_unreadable', 'A logo file could not be read as an image (it may be damaged or too large).', 'Use a PNG, JPEG, WebP or SVG logo under 15 MB.');
  }
}

// ---- save ------------------------------------------------------------------------------------

function familyKnown(name: string, bundled: readonly string[], uploaded: readonly string[]): boolean {
  const key = familyKey(name);
  return [...bundled, ...uploaded].some((f) => familyKey(f) === key);
}

export async function saveBrand(ctx: AppContext, owner: string, input: BrandSaveInput): Promise<{ record: BrandRecord; warnings: RenderWarning[] }> {
  const warnings: RenderWarning[] = [];

  // Fonts must be resolvable: bundled, or uploaded in this same call.
  const files = input.font_files ?? [];
  const uploadedFamilies = files.map((f) => f.family);
  for (const [role, name] of Object.entries(input.fonts)) {
    if (name !== undefined && !familyKnown(name, ctx.fonts.listFamilies(), uploadedFamilies)) {
      throw new UserFacingError(
        'font_unknown',
        `The ${role} font "${name}" is not a bundled font and no font_files entry provides it.`,
        `Bundled fonts: ${ctx.fonts.listFamilies().join(', ')}. To use another font, add it to font_files (TTF/OTF link) with the same family name.`,
      );
    }
  }
  for (const f of files) {
    if (!familyKnown(f.family, [], [input.fonts.heading, input.fonts.body, ...(input.fonts.accent ? [input.fonts.accent] : [])])) {
      warn(warnings, 'font_file_unused', `The font file for "${f.family}" is not used by fonts.heading, fonts.body or fonts.accent.`, 'Set one of the roles to that family name, or drop the file.');
    }
  }

  const fontDir = assetDir(ctx, 'fonts', owner, input.slug);
  const logoDir = assetDir(ctx, 'brands', owner, input.slug);

  // Download everything first; nothing is written (or versioned) if any asset is rejected.
  const fontFiles: StoredFontFile[] = [];
  const fontBytes = new Map<string, Buffer>();
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = await ctx.fetchFont(f.url);
    } catch (err) {
      if (isUserFacingError(err)) throw new UserFacingError(err.code, `Font "${f.family}" (${f.weight} ${f.style}): ${err.message}`, err.suggestion);
      throw err;
    }
    const checked = checkFont(buf, f.family);
    for (const w of checked.warnings) warn(warnings, w.code, w.message, w.suggestion);
    const file = `${sha16(buf)}.${checked.ext}`;
    fontBytes.set(file, buf);
    fontFiles.push({ family: f.family, weight: f.weight, style: f.style, file, bytes: buf.length, source_host: hostOf(f.url) });
  }

  const logos: StoredBrandData['logos'] = {};
  const logoBytes = new Map<string, Buffer>();
  for (const variant of ['primary', 'light', 'dark'] as const) {
    const url = input.logos?.[variant];
    if (!url) continue;
    let raw: Buffer;
    try {
      raw = await ctx.fetchImage(url, { svg: true });
    } catch (err) {
      if (isUserFacingError(err)) throw new UserFacingError(err.code, `The ${variant} logo: ${err.message}`, err.suggestion);
      throw err;
    }
    const { png, width, height } = await normalizeLogo(raw);
    const file = `${sha16(png)}.png`;
    logoBytes.set(file, png);
    logos[variant] = { file, width, height, source_host: hostOf(url) };
  }

  if (fontBytes.size > 0) await mkdir(fontDir, { recursive: true });
  for (const [file, buf] of fontBytes) await writeFile(path.join(fontDir, file), buf, { mode: 0o644 });
  if (logoBytes.size > 0) await mkdir(logoDir, { recursive: true });
  for (const [file, buf] of logoBytes) await writeFile(path.join(logoDir, file), buf, { mode: 0o644 });

  const c = input.colors;
  const data: StoredBrandData = {
    colors: {
      primary: toHex(c.primary, '#1f3a5f'),
      secondary: toHex(c.secondary ?? '#f4efe6', '#f4efe6'),
      accent: toHex(c.accent, '#f2a541'),
      ink: toHex(c.ink, '#0b1020'),
      paper: toHex(c.paper, '#ffffff'),
      extra: (c.extra ?? []).map((e) => ({ name: e.name, hex: toHex(e.hex, '#000000') })),
    },
    fonts: { heading: input.fonts.heading, body: input.fonts.body, ...(input.fonts.accent ? { accent: input.fonts.accent } : {}) },
    font_files: fontFiles,
    logos,
    style: { ...resolveStyle(input.style), logo_position: input.style?.logo_position ?? 'top-left' },
    ...(input.voice ? { voice: input.voice } : {}),
  };
  const record = ctx.brands.save(owner, { slug: input.slug, display_name: input.display_name, data, shared: input.shared === true });
  return { record, warnings };
}

// ---- resolve and load -------------------------------------------------------------------------

export function brandNotFound(ctx: AppContext, viewer: string, ref: string): UserFacingError {
  const visible = ctx.brands.list(viewer).map((b) => (b.owner === viewer ? b.slug : `${b.owner}/${b.slug}`));
  return new UserFacingError(
    'brand_not_found',
    `There is no saved brand called "${ref}" that you can use.`,
    visible.length > 0 ? `Available brands: ${visible.join(', ')}. Use list_brands to see them, or save_brand to create one.` : 'Use save_brand to create one, or pass the brand inline.',
  );
}

/** Own brand first, then a shared one; `owner/slug` picks a specific shared brand. */
export function findBrand(ctx: AppContext, viewer: string, ref: string): BrandRecord {
  const found = ctx.brands.find(viewer, ref);
  if (!found) throw brandNotFound(ctx, viewer, ref);
  return found;
}

const FACE_CACHE = new Map<string, FontFace>();

async function readFace(file: string, family: string, weight: number, italic: boolean, stored: string): Promise<FontFace | undefined> {
  try {
    await stat(file); // a font file that was removed from the volume must be noticed even when it is cached
    const hit = FACE_CACHE.get(file);
    if (hit) return { ...hit, family, weight, italic };
    const data = await readFile(file);
    const face = parseFontFace(family, stored, weight, italic, data);
    if (FACE_CACHE.size >= 64) FACE_CACHE.delete(FACE_CACHE.keys().next().value as string);
    FACE_CACHE.set(file, face);
    return face;
  } catch {
    return undefined;
  }
}

/** Turn a stored brand into what the renderers use: files read from disk, uploaded fonts layered into a registry scoped to this render. */
export async function loadBrand(ctx: AppContext, record: BrandRecord, warnings: RenderWarning[]): Promise<ResolvedBrand> {
  const data = record.data as StoredBrandData;
  const fontDir = assetDir(ctx, 'fonts', record.owner, record.slug);
  const logoDir = assetDir(ctx, 'brands', record.owner, record.slug);

  const faces: FontFace[] = [];
  for (const f of data.font_files) {
    const face = await readFace(path.join(fontDir, f.file), f.family, f.weight, f.style === 'italic', f.file);
    if (face) faces.push(face);
    else warn(warnings, 'brand_font_missing', `The uploaded font file for "${f.family}" (${f.weight} ${f.style}) is missing on the server; a bundled font is used instead.`, 'Save the brand again to re-upload the font.');
  }
  const registry = ctx.fonts.withFaces(faces);
  const pick = (role: string, name: string | undefined, fallback: string): string => {
    if (name === undefined) return fallback;
    const display = registry.displayName(name);
    if (display) return display;
    warn(warnings, 'font_unavailable', `The brand's ${role} font "${name}" is not available; ${fallback} was used instead.`, `Available fonts: ${registry.listFamilies().join(', ')}.`);
    return fallback;
  };
  const heading = pick('heading', data.fonts.heading, DEFAULT_HEADING_FAMILY);
  const body = pick('body', data.fonts.body, DEFAULT_BODY_FAMILY);
  const accent = data.fonts.accent ? pick('accent', data.fonts.accent, heading) : heading;

  const logos: ResolvedBrand['logos'] = {};
  for (const variant of ['primary', 'light', 'dark'] as const) {
    const stored = data.logos[variant];
    if (!stored) continue;
    try {
      logos[variant] = await readFile(path.join(logoDir, stored.file));
    } catch {
      warn(warnings, 'brand_logo_missing', `The stored ${variant} logo is missing on the server.`, 'Save the brand again to re-upload the logo.');
    }
  }

  return {
    resolved: true,
    colors: { primary: data.colors.primary, secondary: data.colors.secondary, accent: data.colors.accent, ink: data.colors.ink, paper: data.colors.paper },
    extraColors: data.colors.extra,
    fonts: { heading, body, accent },
    fontRegistry: registry,
    logos,
    style: data.style,
    ...(data.style.logo_position ? { logoCorner: data.style.logo_position } : {}),
    slug: record.slug,
    displayName: record.display_name,
  };
}

/** What every compose tool accepts for `brand`: nothing, a saved brand's slug (own first, then shared), or an inline object. */
export async function resolveBrandArg(ctx: AppContext, user: string, arg: string | BrandInput | ResolvedBrand | undefined, warnings: RenderWarning[]): Promise<ResolvedBrand> {
  if (isResolvedBrand(arg)) return arg;
  if (typeof arg === 'string') return loadBrand(ctx, findBrand(ctx, user, arg), warnings);
  return resolveBrand(arg, ctx.fonts, warnings);
}

/** The stored data without internal file names, for `get_brand`. */
export function publicBrandData(record: BrandRecord): Record<string, unknown> {
  const data = record.data as StoredBrandData;
  return {
    colors: data.colors,
    fonts: data.fonts,
    font_files: data.font_files.map((f) => ({ family: f.family, weight: f.weight, style: f.style, bytes: f.bytes, stored: true, source_host: f.source_host })),
    logos: Object.fromEntries(Object.entries(data.logos).map(([k, v]) => [k, { stored: true, width: v.width, height: v.height, source_host: v.source_host }])),
    style: data.style,
    ...(data.voice ? { voice: data.voice } : {}),
  };
}
