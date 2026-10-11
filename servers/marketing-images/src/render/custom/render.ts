import { Resvg } from '@resvg/resvg-js';
// Satori: https://github.com/vercel/satori#documentation (options `onNodeDetected`, `onStyleError` are in satori/dist/*.d.ts, SatoriOptions)
import satori from 'satori';
import sharp from 'sharp';
import { UserFacingError, isUserFacingError } from '../../errors.js';
import type { ResolvedBrand } from '../brand.js';
import { hexToRgb } from '../color.js';
import type { CounterSpec } from '../counter.js';
import { applyCounter } from '../counter.js';
import type { ComposeDeps } from '../compose.js';
import { DEFAULT_BODY_FAMILY, DEFAULT_HEADING_FAMILY, type FontFace, type FontRegistry } from '../fonts.js';
import type { FormatSpec } from '../formats.js';
import { warn, type RenderWarning } from '../warnings.js';
import { embedLogo, loadAssets, type DeclaredAssets } from './assets.js';
import { runChecks, type TextlessRaster } from './checks.js';
import { applyFits, fitTargets, type Box, type FitReport } from './datafit.js';
import { MAX_HTML_BYTES, parseHtml, TRANSPARENT_PIXEL, walk, type HChild, type HElement } from './html.js';
import { scanTokens, substituteTokens, type AssetData } from './tokens.js';

/**
 * compose_custom pipeline (DESIGN section 5.2):
 * tokens -> assets (fetchsafe, embedded) -> HTML parse + CSS whitelist -> fonts from the registry only -> data-fit
 * -> Satori (analysis pass for the checks, final pass for the picture) -> resvg -> sharp -> encode.
 * Same input, same pixels.
 */

export const RENDER_TIMEOUT_MS = 10_000;
export const MAX_VARIABLES = 40;
export const MAX_VARIABLE_CHARS = 2000;

export interface CustomInput {
  html: string;
  format: FormatSpec;
  brand: ResolvedBrand;
  assets?: DeclaredAssets | undefined;
  variables?: Record<string, string> | undefined;
  /** Assets a saved template declares as optional: if not provided they resolve to a transparent pixel without a warning. */
  optionalAssets?: readonly string[] | undefined;
  output?: 'auto' | 'png' | 'jpg' | undefined;
  counter?: CounterSpec | undefined;
  /** false = skip the post-render checks (brand sheet, catalog previews). */
  checks?: boolean | undefined;
  /** Test hook: replaces the clock. */
  now?: () => number;
}

export interface CustomOutput {
  data: Buffer;
  ext: 'png' | 'jpg';
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  warnings: RenderWarning[];
  applied: {
    format: string;
    nodes: number;
    assets: string[];
    fit: FitReport[];
    fonts: string[];
    ms: number;
    counter?: { corner: string };
  };
}

interface SatoriEl {
  type: string;
  key?: string;
  props: Record<string, unknown>;
}

type Mode = 'final' | 'measure' | 'analysis';

interface BuildOptions {
  mode: Mode;
  overrides: ReadonlyMap<string, Record<string, string>>;
  imageSizes: ReadonlyMap<string, { width: number; height: number }>;
  /** Full image URI -> thumbnail URI, swapped in for the analysis pass. */
  thumbs: ReadonlyMap<string, string>;
  fitKeys: ReadonlySet<string>;
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', 'revert']);

/** Text styling removed in the analysis pass so only backgrounds remain. */
const TEXT_PAINT = ['textShadow', 'WebkitTextStrokeWidth', 'WebkitTextStrokeColor', 'WebkitTextStroke', 'WebkitTextFillColor', 'textDecoration', 'textDecorationColor'];

function numericOrString(value: string): string | number {
  return value;
}

function swapThumbs(value: string, thumbs: ReadonlyMap<string, string>): string {
  if (!value.includes('data:image')) return value;
  let out = value;
  for (const [full, thumb] of thumbs) if (out.includes(full)) out = out.split(full).join(thumb);
  return out;
}

function styleFor(el: HElement, o: BuildOptions): Record<string, string | number> {
  const style: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(el.style)) style[k] = o.mode !== 'final' ? swapThumbs(v, o.thumbs) : numericOrString(v);
  const override = o.overrides.get(el.key);
  if (override) Object.assign(style, override);
  if (o.mode === 'analysis') {
    for (const p of TEXT_PAINT) delete style[p];
    style.color = 'transparent';
  }
  return style;
}

function build(child: HChild, o: BuildOptions): SatoriEl | string {
  if (typeof child === 'string') return child; // wrapping for the analysis pass is done by the parent (needs the key)
  const el = child;
  if (el.svg) return buildSvg(el, o);
  const style = styleFor(el, o);
  const props: Record<string, unknown> = { style };
  if (el.tag === 'img') {
    const src = el.attrs.src ?? TRANSPARENT_PIXEL;
    props.src = o.mode !== 'final' ? (o.thumbs.get(src) ?? src) : src;
    const w = el.attrs.width !== undefined ? Number(el.attrs.width) : undefined;
    const h = el.attrs.height !== undefined ? Number(el.attrs.height) : undefined;
    if (w !== undefined) props.width = w;
    if (h !== undefined) props.height = h;
    if (w === undefined && h === undefined && style.width === undefined && style.height === undefined) {
      const natural = o.imageSizes.get(src);
      props.width = natural?.width ?? 1;
      props.height = natural?.height ?? 1;
    }
    return { type: 'img', key: el.key, props };
  }
  const children: (SatoriEl | string)[] = [];
  const empty = o.mode === 'measure' && o.fitKeys.has(el.key);
  if (!empty) {
    el.children.forEach((c, i) => {
      if (typeof c === 'string') {
        if (o.mode === 'analysis') {
          // The span reports the real extent of the text run. Inside a flex/grid container a run is its own flex item, which would
          // stretch to the container, so there it gets a block wrapper (the run then sits in an inline span inside a block, as in the final tree).
          const run: SatoriEl = { type: 'span', key: `${el.key}#t${i}`, props: { style: { color: 'transparent' }, children: c } };
          const flexParent = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(el.style.display ?? '');
          children.push(flexParent ? { type: 'div', key: `${el.key}#w${i}`, props: { style: { color: 'transparent' }, children: run } } : run);
        } else children.push(c);
      } else children.push(build(c, o));
    });
  }
  if (children.length === 1 && typeof children[0] === 'string') props.children = children[0];
  else if (children.length > 0) props.children = children;
  return { type: el.type, key: el.key, props };
}

function buildSvg(el: HElement, o: BuildOptions): SatoriEl {
  const props: Record<string, unknown> = { ...el.attrs };
  if (Object.keys(el.style).length > 0 || el.tag === 'svg') props.style = styleFor(el, o);
  const children = el.children.filter((c): c is HElement => typeof c !== 'string').map((c) => buildSvg(c, o));
  if (children.length > 0) props.children = children;
  return { type: el.type, key: el.key, props };
}

function fontsOption(faces: readonly FontFace[]): { name: string; data: Buffer; weight: 400 | 700; style: 'normal' | 'italic' }[] {
  return faces.map((f) => ({ name: f.family, data: f.data, weight: f.weight as 400 | 700, style: f.italic ? 'italic' : 'normal' }));
}

async function runSatori(
  tree: SatoriEl,
  format: FormatSpec,
  faces: readonly FontFace[],
  hooks: { nodes?: Map<string, Box>; styleErrors?: string[] } = {},
): Promise<string> {
  try {
    return await satori(tree as never, {
      width: format.width,
      height: format.height,
      fonts: fontsOption(faces),
      onNodeDetected: (n) => {
        if (hooks.nodes && n.key !== undefined && n.key !== null) hooks.nodes.set(String(n.key), { left: n.left, top: n.top, width: n.width, height: n.height });
      },
      onStyleError: (err) => {
        hooks.styleErrors?.push(err.message.split('\n')[0] ?? 'invalid style');
      },
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 220) ?? 'unknown error';
    throw new UserFacingError('render_failed', `The layout could not be drawn: ${message}`, 'Check the HTML and inline styles for invalid values (see the CSS notes in the tool description) and try again.');
  }
}

function rasterize(svg: string, width: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng();
}

/** Rewrites every `font-family` to registry families (unknown ones fall back, once-per-name warning) and removes characters no loaded font can draw. */
function resolveFonts(
  roots: HChild[],
  registry: FontRegistry,
  brand: ResolvedBrand,
  warnings: RenderWarning[],
): { used: Set<string>; removed: string[] } {
  const used = new Set<string>([brand.fonts.body, brand.fonts.heading]);
  const unknown = new Set<string>();
  walk(roots, (el) => {
    const value = el.style.fontFamily;
    if (value === undefined) return;
    const known: string[] = [];
    for (const raw of value.split(',')) {
      const name = raw.trim().replace(/^['"]|['"]$/g, '');
      if (name === '' || GENERIC_FAMILIES.has(name.toLowerCase())) continue;
      const display = registry.displayName(name);
      if (display) known.push(display);
      else unknown.add(name);
    }
    const finalList = known.length > 0 ? known : [brand.fonts.body];
    for (const f of finalList) used.add(f);
    el.style.fontFamily = finalList.join(', ');
  });
  for (const name of unknown) {
    warn(
      warnings,
      'font_unavailable',
      `The font "${name}" is not available, so the brand body font (${brand.fonts.body}) was used instead.`,
      `Only these fonts can be used: ${registry.listFamilies().join(', ')}. Use {{brand.font.heading}} / {{brand.font.body}} for the brand's fonts.`,
    );
  }

  const faces = [...used].flatMap((f) => registry.facesOf(f));
  const cache = new Map<string, boolean>();
  const drawable = (ch: string): boolean => {
    let ok = cache.get(ch);
    if (ok === undefined) {
      ok = faces.some((f) => f.font.charToGlyphIndex(ch) !== 0);
      cache.set(ch, ok);
    }
    return ok;
  };
  const removed: string[] = [];
  const clean = (el: { children: HChild[] }): void => {
    el.children = el.children.map((c) => {
      if (typeof c !== 'string') {
        if (!c.svg) clean(c);
        return c;
      }
      let out = '';
      for (const ch of c.normalize('NFC')) {
        if (ch === ' ' || ch === '\n' || ch === '\t' || drawable(ch)) out += ch;
        else if (!removed.includes(ch)) removed.push(ch);
      }
      return out;
    });
  };
  clean({ children: roots });
  if (removed.length > 0) {
    warn(warnings, 'unsupported_characters', `Some characters cannot be drawn by the available fonts and were removed: ${removed.join(' ')}`, 'Emoji and symbols are not supported in composed graphics; put them in the post caption instead.');
  }
  return { used, removed };
}

function validateVariables(vars: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(vars ?? {});
  if (entries.length > MAX_VARIABLES) {
    throw new UserFacingError('too_many_variables', `At most ${MAX_VARIABLES} variables can be used (got ${entries.length}).`, 'Combine texts or remove unused variables.');
  }
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
      throw new UserFacingError('variable_name_invalid', `The variable name "${name}" is not valid.`, 'Use letters, digits, "-" and "_" (max 40).');
    }
    if (typeof value !== 'string' || value.length > MAX_VARIABLE_CHARS) {
      throw new UserFacingError('variable_too_long', `The variable "${name}" is longer than ${MAX_VARIABLE_CHARS} characters.`, 'Shorten the text.');
    }
    out[name] = value;
  }
  return out;
}

export async function renderCustom(input: CustomInput, deps: ComposeDeps): Promise<CustomOutput> {
  const now = input.now ?? Date.now;
  const started = now();
  const tick = (): void => {
    if (now() - started > RENDER_TIMEOUT_MS) {
      throw new UserFacingError('render_timeout', `Drawing this layout took longer than ${RENDER_TIMEOUT_MS / 1000} seconds.`, 'Simplify it: fewer elements, no huge blur or shadow values, smaller images.');
    }
  };
  const warnings: RenderWarning[] = [];
  const { format, brand } = input;
  const registry = brand.fontRegistry;

  if (Buffer.byteLength(input.html, 'utf8') > MAX_HTML_BYTES) {
    throw new UserFacingError('html_too_large', `The HTML is larger than ${MAX_HTML_BYTES / 1024} KB.`, 'Simplify the layout: shorter inline styles, fewer elements, and images via assets instead of inline data.');
  }
  if (input.html.trim() === '') throw new UserFacingError('html_empty', 'The HTML is empty.', 'Provide the layout as HTML with inline styles.');
  const variables = validateVariables(input.variables);

  // 1. Tokens that need I/O: declared assets and brand logos (only those the HTML uses).
  const tokens = scanTokens(input.html);
  const declared = input.assets ?? {};
  const assets = await loadAssets(declared, tokens, deps.fetchImage, warnings);
  const logoUris: Partial<Record<'logo' | 'logo_light' | 'logo_dark', string>> = {};
  const logoData = new Map<string, AssetData>();
  for (const [token, variant] of [['brand.logo', 'primary'], ['brand.logo_light', 'light'], ['brand.logo_dark', 'dark']] as const) {
    if (!tokens.has(token)) continue;
    const source = brand.logos[variant];
    if (!source) continue;
    try {
      const data = await embedLogo(source, deps.fetchImage);
      logoUris[token.slice(6) as 'logo' | 'logo_light' | 'logo_dark'] = data.uri;
      logoData.set(data.uri, data);
    } catch (err) {
      const reason = isUserFacingError(err) ? err.message : 'the file could not be read.';
      warn(warnings, 'logo_failed', `The ${variant} logo could not be used: ${reason}`, 'Check the logo link (PNG, JPEG, WebP or AVIF), or continue without a logo.');
    }
  }
  tick();

  // 2. Substitute tokens, parse, validate CSS.
  const html = substituteTokens(
    input.html,
    { brand, logoUris, assets, optionalAssets: new Set(input.optionalAssets ?? []), vars: variables, format, transparentPixel: TRANSPARENT_PIXEL },
    warnings,
  );
  const parsed = parseHtml(html, warnings);
  const roots = parsed.roots;
  if (roots.length === 0) throw new UserFacingError('html_empty', 'The HTML has no visible elements.', 'Provide at least one <div> with inline styles.');

  // 3. Fonts from the registry only, unsupported characters removed.
  const { used: usedFamilies } = resolveFonts(roots, registry, brand, warnings);
  const faces = [...usedFamilies].flatMap((f) => registry.facesOf(f));
  // The default families go first: Satori falls back to the other loaded fonts in order.
  const bodyFaces = registry.facesOf(brand.fonts.body);
  const orderedFaces = [...bodyFaces, ...faces.filter((f) => !bodyFaces.includes(f))];
  if (orderedFaces.length === 0) orderedFaces.push(registry.resolve(DEFAULT_BODY_FAMILY, DEFAULT_HEADING_FAMILY, 400, false).face);

  const imageSizes = new Map<string, { width: number; height: number }>();
  const thumbs = new Map<string, string>();
  for (const a of [...assets.values(), ...logoData.values()]) {
    imageSizes.set(a.uri, a);
    if (a.thumb) thumbs.set(a.uri, a.thumb);
  }

  const wrapperStyle: Record<string, string | number> = {
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    width: format.width,
    height: format.height,
    fontFamily: brand.fonts.body,
    color: brand.colors.ink,
  };
  const wrap = (children: (SatoriEl | string)[]): SatoriEl => ({ type: 'div', key: 'root', props: { style: wrapperStyle, children } });
  const treeOf = (o: BuildOptions): SatoriEl => wrap(roots.map((c) => build(c, o)));

  const parents = new Map<string, string | undefined>();
  walk(roots, (el, parent) => parents.set(el.key, parent?.key));

  // 4. data-fit: measure the boxes (text removed), then pick the sizes.
  const targets = fitTargets(roots);
  const fitKeys = new Set(targets.map((t) => t.key));
  const overrides = new Map<string, Record<string, string>>();
  let fitReport: FitReport[] = [];
  let fitFailed = new Set<string>();
  if (targets.length > 0) {
    const measured = new Map<string, Box>();
    await runSatori(treeOf({ mode: 'measure', overrides, imageSizes, thumbs, fitKeys }), format, orderedFaces, { nodes: measured });
    tick();
    const outcome = applyFits({ roots, measured, parents, registry, brand, warnings });
    // Commit the chosen sizes into the tree so the checks (and the final pass) see the effective font size.
    walk(roots, (el) => {
      const change = outcome.overrides.get(el.key);
      if (change) Object.assign(el.style, change);
    });
    fitReport = outcome.report;
    fitFailed = outcome.failed;
  }

  // 5. Analysis pass (text boxes + background without text) for the checks.
  if (input.checks !== false) {
    const nodes = new Map<string, Box>();
    const svgPlain = await runSatori(treeOf({ mode: 'analysis', overrides, imageSizes, thumbs, fitKeys }), format, orderedFaces, { nodes });
    tick();
    const scale = 0.5;
    const rw = Math.round(format.width * scale);
    const paper = hexToRgb(brand.colors.paper) ?? { r: 255, g: 255, b: 255 };
    const { data: raw, info } = await sharp(rasterize(svgPlain, rw))
      .flatten({ background: paper })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const textless: TextlessRaster = { raw, width: info.width, height: info.height, scale: info.width / format.width };
    runChecks({ roots, format, brand, nodes, textless, fitFailed }, warnings);
    // The wrapper's only child: does the design fill the canvas?
    if (roots.length === 1 && typeof roots[0] !== 'string') {
      const rootBox = nodes.get((roots[0] as HElement).key);
      if (rootBox && (rootBox.width < format.width - 2 || rootBox.height < format.height - 2)) {
        warn(
          warnings,
          'root_not_full_size',
          `The outer element is ${Math.round(rootBox.width)}x${Math.round(rootBox.height)} but the image is ${format.width}x${format.height}; the rest is filled with the brand paper color.`,
          'Give the outer element width:{{format.width}}px; height:{{format.height}}px (or 100%) and a background.',
        );
      } else if (rootBox && (rootBox.width > format.width + 2 || rootBox.height > format.height + 2)) {
        warn(
          warnings,
          'root_larger_than_canvas',
          `The outer element is ${Math.round(rootBox.width)}x${Math.round(rootBox.height)}, larger than the ${format.width}x${format.height} image, so part of the design is cut off.`,
          'If the outer element has padding or a border, add box-sizing:border-box (widths and heights do NOT include padding by default), or reduce its size.',
        );
      }
    }
  }

  // 6. Final render.
  const styleErrors: string[] = [];
  const svg = await runSatori(treeOf({ mode: 'final', overrides, imageSizes, thumbs, fitKeys }), format, orderedFaces, { styleErrors });
  tick();
  const seen = new Set<string>();
  for (const message of styleErrors) {
    if (seen.has(message) || seen.size >= 6) continue;
    seen.add(message);
    warn(warnings, 'css_invalid_value', `A CSS declaration was ignored: ${message}`, 'Fix the value (see the CSS notes in the tool description).');
  }
  const paper = hexToRgb(brand.colors.paper) ?? { r: 255, g: 255, b: 255 };
  const rawOpts = { raw: { width: format.width, height: format.height, channels: 3 as const } };
  let composed: Buffer = await sharp(rasterize(svg, format.width)).flatten({ background: paper }).removeAlpha().raw().toBuffer();
  tick();

  let counterApplied: { corner: string } | undefined;
  if (input.counter) {
    const counted = await applyCounter(composed, format, brand, input.counter, brand.logoCorner);
    composed = counted.raw;
    counterApplied = { corner: counted.corner };
  }

  // 7. Encode: photos (any declared asset used) -> JPEG, otherwise PNG, unless asked.
  const usesPhoto = assets.size > 0;
  const ext: 'png' | 'jpg' = input.output === 'png' ? 'png' : input.output === 'jpg' ? 'jpg' : usesPhoto ? 'jpg' : 'png';
  const encoder = sharp(composed, rawOpts);
  const data =
    ext === 'png' ? await encoder.png({ compressionLevel: 9 }).toBuffer() : await encoder.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();

  return {
    data,
    ext,
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    width: format.width,
    height: format.height,
    warnings,
    applied: {
      format: format.name,
      nodes: parsed.nodeCount,
      assets: [...assets.keys()],
      fit: fitReport,
      fonts: [...usedFamilies],
      ms: now() - started,
      ...(counterApplied ? { counter: counterApplied } : {}),
    },
  };
}
