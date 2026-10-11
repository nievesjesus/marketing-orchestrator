/**
 * Inline-style parsing and validation for compose_custom (DESIGN section 5.2).
 *
 * Satori supports a SUBSET of CSS and silently ignores properties it does not know
 * (https://github.com/vercel/satori#css, note 3: "Properties that aren't listed are ignored"), so the agent would never learn that
 * `box-shadow-x` or `columns` did nothing. This module keeps a whitelist taken from that table and reports everything else as a warning.
 * Invalid VALUES of supported properties are reported by Satori itself through `onStyleError` (see render.ts).
 */

export interface Declaration {
  /** camelCase property name as Satori expects (`font-size` -> `fontSize`, `-webkit-text-stroke` -> `WebkitTextStroke`). Custom properties keep `--name`. */
  prop: string;
  value: string;
}

/** Split `a:b; c:url(data:image/png;base64,xx)` into declarations, honoring quotes and parentheses (data URIs contain `;`). */
export function parseStyleAttribute(text: string): Declaration[] {
  const out: Declaration[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const pushPart = (end: number): void => {
    const part = text.slice(start, end).trim();
    start = end + 1;
    if (!part) return;
    let colon = -1;
    let d = 0;
    let q = '';
    for (let i = 0; i < part.length; i += 1) {
      const ch = part[i] as string;
      if (q) {
        if (ch === q) q = '';
        continue;
      }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '(') d += 1;
      else if (ch === ')') d = Math.max(0, d - 1);
      else if (ch === ':' && d === 0) {
        colon = i;
        break;
      }
    }
    if (colon <= 0) return;
    const rawProp = part.slice(0, colon).trim();
    let value = part.slice(colon + 1).trim();
    value = value.replace(/\s*!important\s*$/i, '');
    if (!rawProp || value === '') return;
    out.push({ prop: toCamel(rawProp), value });
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) pushPart(i);
  }
  pushPart(text.length);
  return out;
}

export function toCamel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  const lower = prop.toLowerCase();
  // Vendor prefixes: -webkit-text-stroke -> WebkitTextStroke
  return lower.replace(/^-/, '').replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase()).replace(/^webkit/, 'Webkit').replace(/^moz/, 'Moz');
}

/** Properties Satori 0.47 supports, from its README table. */
const SUPPORTED = new Set<string>([
  'display', 'position', 'float', 'clear', 'zIndex', 'visibility', 'color',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'top', 'right', 'bottom', 'left', 'inset',
  'width', 'height', 'aspectRatio', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'border', 'borderWidth', 'borderStyle', 'borderColor',
  'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  'outline', 'outlineWidth', 'outlineStyle', 'outlineColor', 'outlineOffset',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'cornerShape', 'cornerTopLeftShape', 'cornerTopRightShape', 'cornerBottomLeftShape', 'cornerBottomRightShape',
  'cornerTopShape', 'cornerRightShape', 'cornerBottomShape', 'cornerLeftShape',
  'flex', 'flexFlow', 'flexDirection', 'flexWrap', 'flexGrow', 'flexShrink', 'flexBasis',
  'alignItems', 'alignContent', 'alignSelf', 'justifyContent', 'gap', 'rowGap', 'columnGap', 'order',
  'gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas', 'gridAutoColumns', 'gridAutoRows', 'gridAutoFlow',
  'gridRow', 'gridColumn', 'gridArea', 'gridRowStart', 'gridRowEnd', 'gridColumnStart', 'gridColumnEnd',
  'justifyItems', 'justifySelf', 'placeItems', 'placeContent', 'placeSelf', 'grid', 'gridTemplate',
  'listStyle', 'listStyleType', 'listStylePosition', 'listStyleImage', 'counterReset', 'counterIncrement', 'counterSet',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontFeatureSettings', 'fontKerning',
  'fontVariant', 'fontVariantCaps', 'fontVariantNumeric', 'fontVariantLigatures', 'fontVariantPosition',
  'fontVariantEastAsian', 'fontVariantAlternates', 'fontVariantEmoji',
  'tabSize', 'textAlign', 'textIndent', 'verticalAlign', 'textTransform', 'textOverflow',
  'textDecoration', 'textDecorationLine', 'textDecorationStyle', 'textDecorationColor', 'textDecorationThickness',
  'textShadow', 'lineHeight', 'letterSpacing', 'wordSpacing', 'whiteSpace', 'wordBreak', 'overflowWrap', 'wordWrap', 'textWrap',
  'background', 'backgroundColor', 'backgroundImage', 'backgroundPosition', 'backgroundSize', 'backgroundClip',
  'WebkitBackgroundClip', 'backgroundRepeat', 'backgroundOrigin', 'backgroundBlendMode',
  'transform', 'transformOrigin', 'transformStyle', 'backfaceVisibility', 'perspective', 'perspectiveOrigin',
  'translate', 'rotate', 'scale',
  'objectFit', 'objectPosition', 'opacity', 'mixBlendMode', 'isolation', 'boxSizing', 'boxShadow',
  'overflow', 'overflowX', 'overflowY', 'overflowClipMargin', 'filter', 'backdropFilter', 'clipPath',
  'lineClamp', 'WebkitLineClamp', 'WebkitBoxOrient',
  'maskImage', 'WebkitMaskImage', 'maskPosition', 'maskSize', 'maskRepeat', 'maskOrigin',
  'WebkitTextStroke', 'WebkitTextStrokeWidth', 'WebkitTextStrokeColor', 'WebkitTextFillColor', 'paintOrder',
]);

/** Short, practical hints for the properties agents most often try. */
const HINTS: Record<string, string> = {
  columns: 'use display:flex or display:grid instead',
  columnCount: 'use display:flex or display:grid instead',
  direction: 'right-to-left text is not supported',
  writingMode: 'vertical text is not supported; use transform:rotate(...)',
  fontStretch: 'pick another font family instead',
  fontSizeAdjust: 'set font-size directly',
  cursor: 'the result is a static image',
  transition: 'the result is a static image',
  animation: 'the result is a static image',
  content: 'pseudo-elements are not supported; add real elements',
  zoom: 'use transform:scale(...)',
  font: 'write font-family, font-size, font-weight and line-height separately',
  textDecorationSkipInk: 'not needed',
  userSelect: 'not applicable to an image',
  pointerEvents: 'not applicable to an image',
  boxDecorationBreak: 'not supported',
  hyphens: 'not supported; shorten the text',
  mask: 'use mask-image (with mask-size / mask-position)',
  maskClip: 'not supported',
  maskComposite: 'not supported',
  maskMode: 'not supported',
  textAlignLast: 'not supported',
  textUnderlinePosition: 'not supported',
  textRendering: 'not supported',
  scrollBehavior: 'not applicable to an image',
  resize: 'not applicable to an image',
  appearance: 'not applicable to an image',
  contain: 'not supported',
  willChange: 'not applicable',
  mixBlend: 'use mix-blend-mode',
  gridGap: 'use gap',
};

export interface CssIssue {
  code: 'css_unsupported' | 'css_value_too_large' | 'external_url_blocked';
  prop: string;
  detail: string;
}

const MAX_PX = 12_000;
const MAX_BLUR = 400;

/** Only embedded raster images are allowed in CSS `url(...)`: external addresses must be declared as assets. */
const SAFE_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;

function checkUrls(value: string): { ok: true } | { ok: false; url: string } {
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gis;
  for (let m = re.exec(value); m !== null; m = re.exec(value)) {
    const url = (m[2] ?? '').trim();
    if (url.startsWith('#')) continue; // reference to an inline <svg> id
    if (!SAFE_URL.test(url)) return { ok: false, url };
  }
  return { ok: true };
}

function tooLarge(value: string): boolean {
  for (const m of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) if (Math.abs(Number(m[1])) > MAX_PX) return true;
  for (const m of value.matchAll(/blur\(\s*(\d+(?:\.\d+)?)px?\s*\)/gi)) if (Number(m[1]) > MAX_BLUR) return true;
  return false;
}

export interface ValidatedStyle {
  style: Record<string, string>;
  issues: CssIssue[];
}

/** Keep supported, safe declarations (later ones win, like CSS); report the rest. */
export function validateDeclarations(decls: Declaration[]): ValidatedStyle {
  const style: Record<string, string> = {};
  const issues: CssIssue[] = [];
  for (const { prop, value } of decls) {
    if (prop.startsWith('--')) {
      style[prop] = value;
      continue;
    }
    if (!SUPPORTED.has(prop)) {
      issues.push({ code: 'css_unsupported', prop, detail: HINTS[prop] ?? 'not supported by the renderer' });
      continue;
    }
    if (value.toLowerCase().includes('url(')) {
      const urls = checkUrls(value);
      if (!urls.ok) {
        issues.push({ code: 'external_url_blocked', prop, detail: 'only images declared in `assets` (or the brand logo) can be used; reference them with {{asset.<name>}} or {{brand.logo}}' });
        continue;
      }
    }
    if (tooLarge(value)) {
      issues.push({ code: 'css_value_too_large', prop, detail: `values above ${MAX_PX}px (or blur above ${MAX_BLUR}px) are not allowed` });
      continue;
    }
    style[prop] = value;
  }
  return { style, issues };
}

/** Kebab-case for messages ("fontSize" -> "font-size"). */
export function toKebab(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.replace(/^Webkit/, '-webkit-').replace(/^Moz/, '-moz-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// ---- value helpers used by data-fit and the checks -----------------------------------

/** `24px` or `24` -> 24; anything else (%, em, auto) -> undefined. */
export function pxValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)(px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : undefined;
}

/** Expand `padding: 10px 20px` (px only) into its four sides; undefined sides are 0. */
export function paddingSides(style: Record<string, string>): { top: number; right: number; bottom: number; left: number } {
  const sides = { top: 0, right: 0, bottom: 0, left: 0 };
  const shorthand = style.padding?.trim().split(/\s+/).map(pxValue);
  if (shorthand && shorthand.every((v) => v !== undefined) && shorthand.length >= 1 && shorthand.length <= 4) {
    const [a, b = a, c = a, d = b] = shorthand as number[];
    sides.top = a as number;
    sides.right = b as number;
    sides.bottom = c as number;
    sides.left = d as number;
  }
  sides.top = pxValue(style.paddingTop) ?? sides.top;
  sides.right = pxValue(style.paddingRight) ?? sides.right;
  sides.bottom = pxValue(style.paddingBottom) ?? sides.bottom;
  sides.left = pxValue(style.paddingLeft) ?? sides.left;
  return sides;
}

// ---- colors ----------------------------------------------------------------------------

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  orange: [255, 165, 0], purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  navy: [0, 0, 128], teal: [0, 128, 128], maroon: [128, 0, 0], pink: [255, 192, 203], brown: [165, 42, 42],
};

/** Parse the color forms agents actually write: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla(), a few names, transparent. */
export function parseColor(text: string | undefined): Rgba | undefined {
  if (!text) return undefined;
  const v = text.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED[v];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1] as string;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map((c) => parseInt(c + c, 16));
      return { r: r as number, g: g as number, b: b as number, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    return undefined;
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const ch = (s: string): number => (s.endsWith('%') ? (Number.parseFloat(s) / 100) * 255 : Number(s));
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    return { r: ch(m[1] as string), g: ch(m[2] as string), b: ch(m[3] as string), a: alpha };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const h = (Number(m[1]) % 360) / 360;
    const s = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t0: number): number => {
      let t = t0;
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255, a: alpha };
  }
  return undefined;
}
