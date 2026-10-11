import { Resvg } from '@resvg/resvg-js';
// Satori renders a plain { type, props } element tree (no React needed) to an SVG string.
// Docs: https://github.com/vercel/satori#documentation  ·  CSS support: https://github.com/vercel/satori#css
import satori from 'satori';
import { rgba } from './color.js';
import type { Appearance } from './contrast.js';
import type { FontFace } from './fonts.js';
import type { FormatSpec, Rect } from './formats.js';
import type { Layout, PlacedLine } from './layout.js';

/**
 * Builds the transparent overlay (scrim + text + button) as Satori elements, rasterizes it with resvg
 * (https://github.com/yisibl/resvg-js) and returns an RGBA PNG for sharp to composite over the background.
 *
 * Every text LINE is its own absolutely positioned, non-wrapping element: line breaks and sizes are decided
 * by our own fitter (fit.ts), so Satori never re-wraps and the picture matches what we measured.
 */

interface El {
  type: string;
  props: { style: Record<string, string | number>; children?: El | El[] | string };
}

const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;

function textStyle(line: PlacedLine, color: string): Record<string, string | number> {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: JUSTIFY[line.align],
    whiteSpace: 'nowrap',
    fontFamily: line.face.family,
    fontWeight: line.face.weight,
    fontStyle: line.face.italic ? 'italic' : 'normal',
    fontSize: line.size,
    letterSpacing: Math.round(line.letterSpacingEm * line.size * 100) / 100,
    lineHeight: 1,
    color,
  };
}

function lineElement(line: PlacedLine, color: string): El {
  return {
    type: 'div',
    props: {
      style: { position: 'absolute', left: line.x, top: line.y, width: line.w, height: line.h, ...textStyle(line, color) },
      children: line.text,
    },
  };
}

function colorFor(line: PlacedLine, look: Appearance): string {
  if (line.tone === 'accent') return look.accent;
  if (line.tone === 'muted') return look.muted;
  return look.ink;
}

/** Smoothstep: eased 0..1 (zero slope at both ends), so the scrim has no visible start or kink. */
const ease = (u: number): number => u * u * (3 - 2 * u);
/** Positions (0..1 along the ramp) of the intermediate stops; 8-bit alpha is smooth enough with this many. */
const RAMP_STEPS = [0, 0.1, 0.22, 0.36, 0.5, 0.64, 0.78, 0.9, 1] as const;

/**
 * Smooth vertical scrim (DESIGN section 5.1): fully clear about 30 % of the canvas height before the text block
 * (34 % for `strong`), eased up to the computed strength just above the text, then slightly darker toward the
 * canvas edge. Rendered inside the Satori SVG, so resvg anti-aliases it; there are no hard edges.
 */
export function scrimGradient(look: NonNullable<Appearance['scrim']>, layout: Layout, format: FormatSpec): string {
  const { color, alpha, strong } = look;
  const H = format.height;
  const edgeAlpha = Math.min(0.95, alpha + 0.08); // max alpha sits at the canvas edge
  const reach = Math.round(H * (strong ? 0.34 : 0.3));
  const pad = Math.round(H * 0.03);
  const { y, h } = layout.rect;
  const stop = (a: number, px: number): string =>
    `${rgba(color, Math.round(a * 1000) / 1000)} ${Math.max(0, Math.min(100, (px / H) * 100)).toFixed(2)}%`;
  /** Eased ramp from `from` (clear) to `to` (full `alpha`), in canvas pixels. */
  const ramp = (from: number, to: number): string[] => RAMP_STEPS.map((u) => stop(alpha * ease(u), from + (to - from) * u));

  if (layout.anchor === 'bottom') {
    const full = Math.max(0, y - pad);
    const start = Math.max(0, full - reach);
    return `linear-gradient(to bottom, ${[...ramp(start, full), stop(edgeAlpha, H)].join(', ')})`;
  }
  if (layout.anchor === 'top') {
    const full = Math.min(H, y + h + pad);
    const end = Math.min(H, full + reach);
    const down = ramp(end, full).reverse(); // clear at `end`, full at `full`, listed top to bottom
    return `linear-gradient(to bottom, ${[stop(edgeAlpha, 0), ...down].join(', ')})`;
  }
  const fullTop = Math.max(0, y - pad);
  const fullBottom = Math.min(H, y + h + pad);
  const up = ramp(Math.max(0, fullTop - reach), fullTop);
  const down = ramp(Math.min(H, fullBottom + reach), fullBottom).reverse();
  return `linear-gradient(to bottom, ${[...up, ...down].join(', ')})`;
}

export interface OverlayArgs {
  format: FormatSpec;
  layout: Layout;
  look: Appearance;
}

function usedFaces(layout: Layout): FontFace[] {
  const faces = new Map<string, FontFace>();
  const lines = [...layout.lines, ...(layout.button ? [layout.button.line] : [])];
  for (const l of lines) faces.set(l.face.file, l.face);
  return [...faces.values()];
}

export async function renderOverlay({ format, layout, look }: OverlayArgs): Promise<Buffer> {
  const children: El[] = [];

  if (look.scrim) {
    children.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: format.width,
          height: format.height,
          backgroundImage: scrimGradient(look.scrim, layout, format),
        },
      },
    });
  }

  for (const line of layout.lines) children.push(lineElement(line, colorFor(line, look)));

  if (layout.button) {
    const b = layout.button;
    children.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          left: b.x,
          top: b.y,
          width: b.w,
          height: b.h,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: Math.round(b.h / 2),
          backgroundColor: look.buttonBg,
        },
        children: {
          type: 'div',
          props: { style: { ...textStyle(b.line, look.buttonText), justifyContent: 'center' }, children: b.line.text },
        },
      },
    });
  }

  const tree: El = {
    type: 'div',
    props: {
      style: { display: 'flex', position: 'relative', width: format.width, height: format.height },
      children,
    },
  };

  const svg = await satori(tree as never, {
    width: format.width,
    height: format.height,
    fonts: usedFaces(layout).map((f) => ({
      name: f.family,
      data: f.data,
      weight: f.weight as 400 | 700,
      style: f.italic ? ('italic' as const) : ('normal' as const),
    })),
  });

  return new Resvg(svg, { fitTo: { mode: 'width', value: format.width }, font: { loadSystemFonts: false } }).render().asPng();
}

export type { Rect };
