/**
 * Fixtures for `scripts/readme-assets.ts`: three FICTIONAL brands, synthetic photo-like backgrounds and
 * logos drawn from the bundled fonts. Everything is generated locally and deterministically (no network,
 * no downloaded photos, no real company names).
 */
import type { Glyph } from 'opentype.js';
import sharp from 'sharp';
import { resolveBrand, type BrandStyleInput, type ResolvedBrand } from '../../src/render/brand.js';
import type { FontFace, FontRegistry } from '../../src/render/fonts.js';
import type { RenderWarning } from '../../src/render/warnings.js';

export type SceneKind = 'lumbre' | 'norte' | 'verde';
type MarkKind = 'flame' | 'north' | 'leaf';

export interface BrandDef {
  slug: string;
  name: string;
  scene: SceneKind;
  colors: { primary: string; secondary: string; accent: string; ink: string; paper: string };
  fonts: { heading: string; body: string; accent: string };
  style: BrandStyleInput;
  extraColors: { name: string; hex: string }[];
  mark: MarkKind;
}

export const LUMBRE: BrandDef = {
  slug: 'cafe-lumbre',
  name: 'Café Lumbre',
  scene: 'lumbre',
  colors: { primary: '#8a3a1c', secondary: '#f3e3c7', accent: '#f2a541', ink: '#2b1409', paper: '#fff8ec' },
  fonts: { heading: 'Young Serif', body: 'Work Sans', accent: 'Outfit' },
  style: { radius: 'large', button: 'pill', eyebrow_case: 'upper', letter_spacing_eyebrow: 0.14, logo_position: 'top-left', logo_size: 'medium' },
  extraColors: [
    { name: 'tueste', hex: '#4a2312' },
    { name: 'canela', hex: '#c9773b' },
    { name: 'espuma', hex: '#fff1d6' },
    { name: 'brasa', hex: '#d9531e' },
  ],
  mark: 'flame',
};

export const NORTE: BrandDef = {
  slug: 'studio-norte',
  name: 'Studio Norte',
  scene: 'norte',
  colors: { primary: '#12355b', secondary: '#e3edf7', accent: '#5ec2e8', ink: '#0b1b2e', paper: '#f7fbff' },
  fonts: { heading: 'Bricolage Grotesque', body: 'Work Sans', accent: 'Outfit' },
  style: { radius: 'small', button: 'rounded', eyebrow_case: 'upper', letter_spacing_eyebrow: 0.12, logo_position: 'top-left', logo_size: 'medium' },
  extraColors: [
    { name: 'hielo', hex: '#cfe4f5' },
    { name: 'fiordo', hex: '#2f6f95' },
    { name: 'noche', hex: '#07192c' },
    { name: 'aurora', hex: '#7ee0c3' },
  ],
  mark: 'north',
};

export const VERDE: BrandDef = {
  slug: 'verde-market',
  name: 'Verde Market',
  scene: 'verde',
  colors: { primary: '#1f6b3a', secondary: '#e9f3d8', accent: '#ffd23f', ink: '#0f2a1a', paper: '#fbfff4' },
  fonts: { heading: 'Outfit', body: 'Work Sans', accent: 'Lora' },
  style: { radius: 'medium', button: 'pill', eyebrow_case: 'upper', letter_spacing_eyebrow: 0.12, logo_position: 'top-left', logo_size: 'medium' },
  extraColors: [
    { name: 'hoja', hex: '#4c9a52' },
    { name: 'brote', hex: '#b7dd7a' },
    { name: 'tierra', hex: '#6b4a2f' },
    { name: 'tomate', hex: '#d64b3a' },
  ],
  mark: 'leaf',
};

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic photos
// ---------------------------------------------------------------------------------------------------------------------

interface ScenePalette {
  sky: [string, string, string];
  glow: string;
  hill: string;
  hill2: string;
  bokeh: string;
}

const SCENES: Record<SceneKind, ScenePalette> = {
  lumbre: { sky: ['#f6cf8f', '#c4702f', '#3a1d10'], glow: '#ffe2b0', hill: '#4a2514', hill2: '#7a3a1d', bokeh: '#ffdca0' },
  norte: { sky: ['#b8d6ef', '#4a7fb0', '#0f2442'], glow: '#eaf5ff', hill: '#142c4d', hill2: '#2a5a86', bokeh: '#d6ecff' },
  verde: { sky: ['#e1efb4', '#6fae52', '#1a4a2c'], glow: '#fffbd2', hill: '#1b4a2d', hill2: '#3b7f43', bokeh: '#f4ffc9' },
};

/** Small deterministic generator (same one the tests use for grain). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A photo-like picture: smooth multi-stop gradient, a bright light source, soft out-of-focus lights, blurred
 * "hills" and a vignette, plus a hint of grain so gradients do not band. `variant` moves the light and the shapes.
 */
export async function scene(kind: SceneKind, variant: number, width = 1600, height = 1600): Promise<Buffer> {
  const p = SCENES[kind];
  const rnd = lcg(7000 + variant * 131 + kind.length * 17);
  const blur = (id: string, sigma: number): string =>
    `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${Math.round(sigma)}"/></filter>`;
  const short = Math.min(width, height);
  const lightX = width * (0.3 + 0.5 * rnd());
  const lightY = height * (0.18 + 0.2 * rnd());
  const bokeh = Array.from({ length: 16 }, () => {
    const cx = width * rnd();
    const cy = height * (0.05 + 0.7 * rnd());
    const r = short * (0.03 + 0.07 * rnd());
    const o = 0.1 + 0.2 * rnd();
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="${p.bokeh}" opacity="${o.toFixed(2)}" filter="url(#b1)"/>`;
  }).join('');
  const hillA = 0.78 + 0.08 * rnd();
  const hillB = 0.9 + 0.05 * rnd();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="${(0.4 + 0.5 * rnd()).toFixed(2)}" y2="1">
        <stop offset="0" stop-color="${p.sky[0]}"/><stop offset="0.55" stop-color="${p.sky[1]}"/><stop offset="1" stop-color="${p.sky[2]}"/>
      </linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="${p.glow}" stop-opacity="0.95"/><stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient>
      <radialGradient id="vig" cx="50%" cy="45%" r="75%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.34"/></radialGradient>
      ${blur('b1', short * 0.012)}${blur('b2', short * 0.05)}${blur('b3', short * 0.09)}
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${lightX.toFixed(0)}" cy="${lightY.toFixed(0)}" r="${(short * 0.5).toFixed(0)}" fill="url(#glow)"/>
    ${bokeh}
    <ellipse cx="${(width * (0.15 + 0.2 * rnd())).toFixed(0)}" cy="${(height * hillA).toFixed(0)}" rx="${(width * 0.55).toFixed(0)}" ry="${(height * 0.2).toFixed(0)}" fill="${p.hill2}" opacity="0.8" filter="url(#b3)"/>
    <ellipse cx="${(width * (0.7 + 0.2 * rnd())).toFixed(0)}" cy="${(height * hillB).toFixed(0)}" rx="${(width * 0.6).toFixed(0)}" ry="${(height * 0.2).toFixed(0)}" fill="${p.hill}" opacity="0.9" filter="url(#b2)"/>
    <rect width="100%" height="100%" fill="url(#vig)"/>
  </svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const grain = lcg(20261012);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.max(0, Math.min(255, (data[i] as number) + Math.floor(grain() * 5) - 2));
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

// ---------------------------------------------------------------------------------------------------------------------
// Logos (mark + wordmark, text converted to outlines so no font lookup is involved)
// ---------------------------------------------------------------------------------------------------------------------

/** opentype.js 2.0.0 ships no types and src/types/opentype.d.ts declares only what src uses: the one extra method this file needs. */
type OutlineGlyph = Glyph & { getPath(x: number, y: number, fontSize: number): { toPathData(decimals: number): string } };

/**
 * Outline path data for `text`, one path per glyph (a single long path is silently cut short by librsvg in some
 * cases, e.g. "Verde Market" lost "Market"). Glyph advances are summed by hand, see src/render/fit.ts for why.
 */
function textOutline(face: FontFace, text: string, x: number, baseline: number, size: number): { paths: string[]; width: number } {
  const font = face.font;
  const scale = size / font.unitsPerEm;
  let cursor = x;
  const paths: string[] = [];
  let prev: OutlineGlyph | undefined;
  for (const ch of text) {
    const glyph = font.glyphs.get(font.charToGlyphIndex(ch)) as OutlineGlyph;
    if (prev) cursor += font.getKerningValue(prev, glyph) * scale;
    const d = glyph.getPath(cursor, baseline, size).toPathData(2);
    if (d !== '') paths.push(d);
    cursor += (glyph.advanceWidth ?? 0) * scale;
    prev = glyph;
  }
  return { paths, width: cursor - x };
}

function markSvg(kind: MarkKind, disc: string, glyph: string): string {
  const circle = `<circle cx="56" cy="56" r="56" fill="${disc}"/>`;
  if (kind === 'flame') {
    return `${circle}<path d="M56 18 C62 34 80 44 80 66 C80 80 69 92 56 92 C43 92 32 80 32 66 C32 56 38 50 43 44 C44 52 48 56 52 56 C54 44 50 30 56 18 Z" fill="${glyph}"/>`;
  }
  if (kind === 'north') {
    return `${circle}<polygon points="56,16 82,92 56,76 30,92" fill="${glyph}"/>`;
  }
  return `${circle}<path d="M30 82 C28 52 50 28 84 30 C86 62 66 86 30 82 Z" fill="${glyph}"/><path d="M34 78 L66 46" stroke="${disc}" stroke-width="4" stroke-linecap="round" fill="none"/>`;
}

async function logoPng(def: BrandDef, face: FontFace, disc: string, glyph: string, text: string): Promise<Buffer> {
  const size = 56;
  const word = textOutline(face, def.name, 0, 0, size);
  const markW = 112;
  const gap = 22;
  const width = Math.ceil(markW + gap + word.width + 6);
  const height = 112;
  // Vertically center the lowercase/capital mix: baseline sits ~0.34 em below the middle.
  const baseline = Math.round(56 + size * 0.34);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${markSvg(def.mark, disc, glyph)}
    <g transform="translate(${markW + gap} ${baseline})" fill="${text}">${word.paths.map((d) => `<path d="${d}"/>`).join('')}</g>
  </svg>`;
  return sharp(Buffer.from(svg), { density: 288 }).png().toBuffer();
}

export interface Logos {
  /** On dark or mid-tone backgrounds. */
  light: Buffer;
  /** On light backgrounds. */
  dark: Buffer;
}

export async function makeLogos(def: BrandDef, fonts: FontRegistry): Promise<Logos> {
  const face = fonts.resolve(def.fonts.heading, 'Outfit', 700, false).face;
  const c = def.colors;
  return {
    light: await logoPng(def, face, c.accent, c.ink, c.paper),
    dark: await logoPng(def, face, c.primary, c.accent, c.ink),
  };
}

/** A brand as the render functions see it, with generated logo files instead of download links. */
export async function buildBrand(def: BrandDef, fonts: FontRegistry): Promise<ResolvedBrand> {
  const warnings: RenderWarning[] = [];
  const base = resolveBrand({ colors: def.colors, fonts: def.fonts, style: def.style }, fonts, warnings);
  if (warnings.length > 0) throw new Error(`Brand ${def.slug}: ${warnings.map((w) => w.message).join(' ')}`);
  const logos = await makeLogos(def, fonts);
  return { ...base, logos: { primary: logos.light, light: logos.light, dark: logos.dark }, extraColors: def.extraColors, slug: def.slug, displayName: def.name };
}
