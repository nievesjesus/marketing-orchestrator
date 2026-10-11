// parse5: spec-compliant HTML5 parser (MIT) https://github.com/inikulin/parse5 · API https://parse5.js.org/functions/parseFragment.html
import { parseFragment } from 'parse5';
import { UserFacingError } from '../../errors.js';
import { warn, type RenderWarning } from '../warnings.js';
import { parseStyleAttribute, toKebab, validateDeclarations, type CssIssue } from './css.js';

/**
 * HTML -> element tree for compose_custom.
 *
 * Why not `satori-html`? (evaluated 2026-10, https://github.com/natemoo-re/satori-html, README + dist/index.js of 0.3.2, MIT, last release 2022-12):
 *  - it wraps everything in its own 100%x100% flex root and turns `class` into Tailwind `tw` props, which we do not want;
 *  - it trims every text node, losing the space in `<b>a</b> <i>b</i>`, and leaves holes in `children` when whitespace-only nodes are skipped;
 *  - it does not strip `<script>`, count or limit nodes, report dropped constructs, or give nodes stable keys (we need keys to map Satori's
 *    layout callback back to elements for the post-render checks).
 * So this module walks a parse5 tree itself (parse5 handles entities, void elements and error recovery exactly like a browser).
 */

export const MAX_HTML_BYTES = 50 * 1024;
export const MAX_NODES = 200;
/** Total characters of text in the whole layout (a token like {{asset.x}} dropped into text would otherwise put megabytes in one paragraph). */
export const MAX_TEXT_CHARS = 30_000;

export interface HElement {
  /** The tag as written (lower case). */
  tag: string;
  /** Element type handed to Satori. */
  type: string;
  /** Stable key (`n1`, `n2`...): Satori reports it back with each node's layout. */
  key: string;
  /** Attributes that matter (img src/width/height, svg attributes, data-* directives, id). */
  attrs: Record<string, string>;
  /** Validated inline style. */
  style: Record<string, string>;
  children: HChild[];
  /** Inside (or being) an inline <svg>: attributes are passed through, no layout checks. */
  svg: boolean;
}
export type HChild = HElement | string;

export interface ParsedHtml {
  roots: HChild[];
  nodeCount: number;
  cssIssues: { issue: CssIssue; tag: string }[];
}

const BLOCK_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption', 'address', 'blockquote', 'details', 'summary',
  'form', 'fieldset', 'hgroup', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'picture',
]);
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col']);
/** Kept with Satori's own element presets (headings and paragraphs behave like in a browser). */
const KEEP_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'small', 'sub', 'sup', 'mark', 'code', 'pre', 'br']);
const INLINE_TO_SPAN = new Set(['a', 'button', 'label', 'abbr', 'cite', 'q', 'kbd', 'var', 'samp', 'time', 'font', 'strike', 'big', 'tt']);
const INLINE_TAGS = new Set([...KEEP_TAGS, ...INLINE_TO_SPAN, 'img']);
const DROPPED_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'title', 'head', 'template', 'noscript', 'video', 'audio',
  'canvas', 'source', 'track', 'base', 'input', 'textarea', 'select', 'option', 'optgroup', 'dialog', 'map', 'area', 'math', 'applet',
]);
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'pattern',
]);

const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export { TRANSPARENT_PIXEL };

const SAFE_IMG_SRC = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;

interface Ctx {
  warnings: RenderWarning[];
  count: number;
  cssIssues: { issue: CssIssue; tag: string }[];
  dropped: Set<string>;
}

// parse5's default tree adapter nodes (loosely typed on purpose: only the fields used here).
interface P5Node {
  nodeName: string;
  value?: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  content?: { childNodes: P5Node[] };
}

function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '');
}

function attrMap(node: P5Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of node.attrs ?? []) out[a.name] = a.value;
  return out;
}

/** Parse the (already token-substituted) HTML into a validated element tree. Throws when the node limit is exceeded. */
export function parseHtml(html: string, warnings: RenderWarning[]): ParsedHtml {
  const fragment = parseFragment(html) as unknown as P5Node;
  const ctx: Ctx = { warnings, count: 0, cssIssues: [], dropped: new Set() };
  const roots = convertChildren(fragment.childNodes ?? [], ctx, false, undefined);
  trimBlockEdges(roots);
  let textChars = 0;
  walk(roots, (el) => {
    for (const c of el.children) if (typeof c === 'string') textChars += c.length;
  });
  for (const c of roots) if (typeof c === 'string') textChars += c.length;
  if (textChars > MAX_TEXT_CHARS) {
    throw new UserFacingError('text_too_long', `The layout has more than ${MAX_TEXT_CHARS} characters of text.`, 'Shorten the texts. (Image tokens such as {{asset.x}} belong in <img src> or url(), not in text.)');
  }
  reportIssues(ctx);
  return { roots, nodeCount: ctx.count, cssIssues: ctx.cssIssues };
}

function convertChildren(nodes: P5Node[], ctx: Ctx, inSvg: boolean, parentStyle: Record<string, string> | undefined): HChild[] {
  const out: HChild[] = [];
  for (const node of nodes) {
    if (node.nodeName === '#text') {
      const text = cleanText(node.value ?? '');
      if (text !== '') out.push(text);
      continue;
    }
    if (node.nodeName === '#comment' || node.nodeName === '#documentType') continue;
    const el = convertElement(node, ctx, inSvg, parentStyle);
    if (el) out.push(el);
  }
  return collapseWhitespace(out, parentStyle);
}

/** Collapse whitespace like a browser (unless `white-space: pre*`), and drop whitespace-only text between block-level siblings. */
function collapseWhitespace(children: HChild[], parentStyle: Record<string, string> | undefined): HChild[] {
  const pre = /^pre/.test(parentStyle?.whiteSpace ?? '');
  const hasBlock = children.some((c) => typeof c !== 'string' && !INLINE_TAGS.has(c.tag) && !c.svg);
  const out: HChild[] = [];
  children.forEach((child, i) => {
    if (typeof child !== 'string') {
      out.push(child);
      return;
    }
    if (pre) {
      out.push(child);
      return;
    }
    const collapsed = child.replace(/[ \t\r\n\f]+/g, ' ');
    if (collapsed.trim() === '') {
      // Whitespace-only: keep a single space only between two inline neighbours.
      const prev = children[i - 1];
      const next = children[i + 1];
      const between = prev !== undefined && next !== undefined && !hasBlock;
      if (between) out.push(' ');
      return;
    }
    out.push(collapsed);
  });
  // Merge adjacent strings produced by dropped elements.
  const merged: HChild[] = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (typeof c === 'string' && typeof last === 'string') merged[merged.length - 1] = last + c;
    else merged.push(c);
  }
  return merged;
}

/** Trim leading/trailing spaces of text that starts or ends a block (the browser does not draw them). Inline elements keep theirs. */
function trimBlockEdges(children: HChild[]): void {
  const first = children[0];
  if (typeof first === 'string') children[0] = first.replace(/^ +/, '');
  const lastIndex = children.length - 1;
  const last = children[lastIndex];
  if (typeof last === 'string') children[lastIndex] = last.replace(/ +$/, '');
  for (let i = children.length - 1; i >= 0; i -= 1) if (children[i] === '') children.splice(i, 1);
  for (const c of children) if (typeof c !== 'string' && !c.svg && !INLINE_TAGS.has(c.tag)) trimBlockEdges(c.children);
}

function convertElement(node: P5Node, ctx: Ctx, inSvg: boolean, parentStyle: Record<string, string> | undefined): HElement | undefined {
  const tag = (node.tagName ?? node.nodeName).toLowerCase();
  const attrs = attrMap(node);

  if (inSvg || tag === 'svg') return convertSvg(node, tag, attrs, ctx, inSvg);

  if (DROPPED_WITH_CONTENT.has(tag)) {
    if (tag === 'script') warn(ctx.warnings, 'script_removed', '<script> elements are removed: the renderer draws static HTML only.', 'Remove scripts; use inline styles and the data-fit attribute instead.');
    else if (tag === 'style') warn(ctx.warnings, 'style_block_ignored', '<style> blocks are not applied: only inline style="..." attributes work.', 'Move the CSS into style="..." attributes on each element.');
    else if (!ctx.dropped.has(tag)) {
      ctx.dropped.add(tag);
      warn(ctx.warnings, 'html_tag_unsupported', `<${tag}> is not supported and was removed.`, 'Use div, span, p, h1-h6, img and inline <svg>.');
    }
    return undefined;
  }

  ctx.count += 1;
  if (ctx.count > MAX_NODES) {
    throw new UserFacingError('too_many_nodes', `The layout has more than ${MAX_NODES} elements.`, 'Simplify it: group repeated items into fewer elements, or split the design.');
  }

  let type: string;
  if (BLOCK_TAGS.has(tag)) type = 'div';
  else if (TABLE_TAGS.has(tag)) {
    type = 'div';
    if (!ctx.dropped.has('table')) {
      ctx.dropped.add('table');
      warn(ctx.warnings, 'html_table_not_supported', 'Table elements are drawn as plain blocks (no columns).', 'Use display:flex (or display:grid) rows and columns instead of <table>.');
    }
  } else if (KEEP_TAGS.has(tag) || tag === 'img') type = tag;
  else if (INLINE_TO_SPAN.has(tag)) type = 'span';
  else {
    type = 'div';
    if (!ctx.dropped.has(`?${tag}`)) {
      ctx.dropped.add(`?${tag}`);
      warn(ctx.warnings, 'html_tag_unsupported', `<${tag}> is not a known element; it is drawn as a plain block.`, 'Use div, span, p, h1-h6, img and inline <svg>.');
    }
  }

  const style: Record<string, string> = {};
  if (attrs.style !== undefined) {
    const { style: valid, issues } = validateDeclarations(parseStyleAttribute(attrs.style));
    Object.assign(style, valid);
    for (const issue of issues) ctx.cssIssues.push({ issue, tag });
  }
  if (attrs.class !== undefined) warn(ctx.warnings, 'class_ignored', 'class attributes have no effect: there is no stylesheet.', 'Put the styles in style="..." attributes.');

  const keep: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('data-') || name === 'id' || name === 'aria-label') keep[name] = value;
  }
  if (tag === 'img') {
    const src = attrs.src ?? '';
    if (SAFE_IMG_SRC.test(src.trim())) keep.src = src.trim();
    else {
      keep.src = TRANSPARENT_PIXEL;
      warn(ctx.warnings, 'external_url_blocked', 'An <img> without an embedded image was replaced by a transparent pixel: external links are not loaded.', 'Declare the image in `assets` and use src="{{asset.<name>}}" (or {{brand.logo}} for the logo).');
    }
    if (attrs.width !== undefined && /^\d+(\.\d+)?$/.test(attrs.width)) keep.width = attrs.width;
    if (attrs.height !== undefined && /^\d+(\.\d+)?$/.test(attrs.height)) keep.height = attrs.height;
  }

  const element: HElement = { tag, type, key: `n${ctx.count}`, attrs: keep, style, children: [], svg: false };
  if (tag !== 'img' && tag !== 'br') {
    const content = tag === 'template' ? (node.content?.childNodes ?? []) : (node.childNodes ?? []);
    element.children = convertChildren(content, ctx, false, style.whiteSpace !== undefined ? style : parentStyle);
  }
  return element;
}

function convertSvg(node: P5Node, tag: string, attrs: Record<string, string>, ctx: Ctx, inSvg: boolean): HElement | undefined {
  if (!SVG_TAGS.has(tag)) {
    if (!ctx.dropped.has(`svg:${tag}`)) {
      ctx.dropped.add(`svg:${tag}`);
      warn(ctx.warnings, 'svg_element_removed', `<${tag}> inside <svg> is not supported and was removed.`, 'Supported: path, circle, ellipse, line, polyline, polygon, rect, g, defs, linearGradient, radialGradient, stop, clipPath.');
    }
    return undefined;
  }
  ctx.count += 1;
  if (ctx.count > MAX_NODES) {
    throw new UserFacingError('too_many_nodes', `The layout has more than ${MAX_NODES} elements.`, 'Simplify it: group repeated items into fewer elements, or split the design.');
  }
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    const n = name.toLowerCase();
    if (n.startsWith('on') || n === 'style' || n === 'class') continue;
    if ((n === 'href' || n === 'xlink:href') && !value.trim().startsWith('#')) continue;
    if (/url\(/i.test(value) && !/^url\(\s*['"]?#[^)]*\)$/i.test(value.trim())) continue;
    safe[name] = value;
  }
  const style: Record<string, string> = {};
  if (!inSvg && attrs.style !== undefined) {
    const { style: valid, issues } = validateDeclarations(parseStyleAttribute(attrs.style));
    Object.assign(style, valid);
    for (const issue of issues) ctx.cssIssues.push({ issue, tag });
  }
  const element: HElement = { tag, type: tag === 'svg' ? 'svg' : (node.tagName ?? tag), key: `n${ctx.count}`, attrs: safe, style, children: [], svg: true };
  element.children = convertChildren(node.childNodes ?? [], ctx, true, undefined).filter((c) => typeof c !== 'string');
  return element;
}

function reportIssues(ctx: Ctx): void {
  const seen = new Set<string>();
  let extra = 0;
  for (const { issue, tag } of ctx.cssIssues) {
    const id = `${issue.code}:${issue.prop}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 8) {
      extra += 1;
      continue;
    }
    const prop = toKebab(issue.prop);
    if (issue.code === 'css_unsupported') {
      warn(ctx.warnings, 'css_unsupported', `CSS property "${prop}" is not supported by the renderer and was ignored (first seen on <${tag}>).`, issue.detail);
    } else if (issue.code === 'external_url_blocked') {
      warn(ctx.warnings, 'external_url_blocked', `"${prop}" on <${tag}> points to an external or unsupported image and was ignored.`, issue.detail);
    } else {
      warn(ctx.warnings, 'css_value_too_large', `"${prop}" on <${tag}> has an extreme value and was ignored.`, issue.detail);
    }
  }
  if (extra > 0) warn(ctx.warnings, 'css_more_issues', `${extra} more CSS declarations were ignored.`, 'Fix the warnings above first.');
}

// ---- helpers shared with fit / checks / render -------------------------------------------

/** Depth-first walk over elements. */
export function walk(children: readonly HChild[], visit: (el: HElement, parent: HElement | undefined, ancestors: HElement[]) => void, parent?: HElement, ancestors: HElement[] = []): void {
  for (const child of children) {
    if (typeof child === 'string') continue;
    visit(child, parent, ancestors);
    walk(child.children, visit, child, [...ancestors, child]);
  }
}

/** Text that belongs directly to this element (`<br>` counts as a newline). */
export function directText(el: HElement): string {
  return el.children.map((c) => (typeof c === 'string' ? c : c.tag === 'br' ? '\n' : '')).join('');
}

export function hasDirectText(el: HElement): boolean {
  return el.children.some((c) => typeof c === 'string' && c.trim() !== '');
}

/** Short, human description of an element for warnings: `<div "Summer sale">` or `<h1#title>`. */
export function labelOf(el: HElement): string {
  const id = el.attrs.id ?? el.attrs['data-name'];
  const text = directText(el).trim().replace(/\s+/g, ' ');
  const snippet = text ? ` "${text.length > 28 ? `${text.slice(0, 27)}...` : text}"` : '';
  return `<${el.tag}${id ? `#${id}` : ''}${snippet}>`;
}
