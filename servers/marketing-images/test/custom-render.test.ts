import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { resolveBrand, type ResolvedBrand } from '../src/render/brand.js';
import { parseStyleAttribute, validateDeclarations } from '../src/render/custom/css.js';
import { MAX_NODES, parseHtml, type HElement } from '../src/render/custom/html.js';
import { renderCustom, type CustomInput } from '../src/render/custom/render.js';
import { substituteTokens, escapeHtml, type TokenValues } from '../src/render/custom/tokens.js';
import { FORMATS, type FormatName } from '../src/render/formats.js';
import type { RenderWarning } from '../src/render/warnings.js';
import { fonts, makeLogo, makePhoto, pixelAt, pixels, solidImage } from './helpers.js';

const SAMPLES_DIR = new URL('../.samples/', import.meta.url);
mkdirSync(SAMPLES_DIR, { recursive: true });

const PHOTO = 'https://assets.example.test/photo.jpg';
const LOGO = 'https://assets.example.test/logo.png';

function brandOf(input: Parameters<typeof resolveBrand>[0] = {}, warnings: RenderWarning[] = []): ResolvedBrand {
  return resolveBrand(input, fonts(), warnings);
}

async function deps(extra: Record<string, Buffer> = {}) {
  const store: Record<string, Buffer> = { [PHOTO]: await makePhoto(1800, 1400), [LOGO]: await makeLogo(), ...extra };
  const calls: string[] = [];
  return {
    calls,
    deps: {
      fonts: fonts(),
      fetchImage: async (url: string): Promise<Buffer> => {
        calls.push(url);
        const hit = store[url];
        if (!hit) throw new UserFacingError('fetch_failed', 'Could not download the file.');
        return hit;
      },
    },
  };
}

const codes = (w: RenderWarning[]): string[] => w.map((x) => x.code);
const canvas = (extra = ''): string => `display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;${extra}`;

async function render(html: string, extra: Partial<CustomInput> = {}, format: FormatName = 'square', more: Record<string, Buffer> = {}) {
  const { deps: d } = await deps(more);
  return renderCustom({ html, format: FORMATS[format], brand: brandOf(), output: 'png', ...extra }, d);
}

const tokenValues = (over: Partial<TokenValues> = {}): TokenValues => ({
  brand: brandOf({ colors: { primary: '#112233', accent: '#ff8800' } }),
  logoUris: {},
  assets: new Map(),
  optionalAssets: new Set(),
  vars: {},
  format: FORMATS.square,
  transparentPixel: 'data:image/png;base64,AAAA',
  ...over,
});

describe('token substitution and escaping', () => {
  it('replaces brand, format and safe tokens, with the original aliases', () => {
    const warnings: RenderWarning[] = [];
    const brand = brandOf({ colors: { primary: '#112233', accent: '#ff8800' }, fonts: { heading: 'Lora', body: 'Work Sans', accent: 'Outfit' }, style: { radius: 'large', button: 'square', eyebrow_case: 'title' } });
    const html = '{{brand.color.primary}}|{{brand.primary}}|{{brand.color.accent}}|{{brand.font.heading}}|{{brand.font.accent}}|{{brand.radius}}|{{brand.style.button}}|{{brand.style.eyebrow_transform}}|{{format.width}}x{{format.height}}|{{safe.left}}|{{safe.top}}|{{ safe.right }}';
    const out = substituteTokens(html, tokenValues({ brand }), warnings);
    expect(out).toBe('#112233|#112233|#ff8800|Lora|Outfit|48|square|capitalize|1080x1080|108|108|108');
    expect(warnings).toEqual([]);
    // story safe zones follow the platform UI bands
    const story = substituteTokens('{{safe.top}}/{{safe.bottom}}', tokenValues({ format: FORMATS.story }), []);
    expect(story).toBe('250/400');
  });

  it('extra brand colors and pill radius', () => {
    const brand: ResolvedBrand = { ...brandOf({ style: { radius: 'pill' } }), extraColors: [{ name: 'sand', hex: '#e8dcc4' }] };
    expect(substituteTokens('{{brand.color.sand}} {{brand.radius}}', tokenValues({ brand }), [])).toBe('#e8dcc4 9999');
  });

  it('{{var.*}} is HTML-escaped: a variable can never add markup', () => {
    const evil = '</div><img src="x" onerror="alert(1)"><script>alert(2)</script> & \'q\'';
    const html = substituteTokens('<div data-name="{{var.x}}">{{var.x}}</div>', tokenValues({ vars: { x: evil } }), []);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    const parsed = parseHtml(html, []);
    expect(parsed.nodeCount).toBe(1); // still just the one div
    const div = parsed.roots[0] as HElement;
    expect(div.children).toEqual([evil]); // the text node is the literal string
    expect(Object.keys(div.attrs)).toEqual(['data-name']); // no extra attributes were smuggled in
    expect(div.attrs['data-name']).toBe(evil);
  });

  it('a replaced value is never scanned again (no token injection through variables)', () => {
    const warnings: RenderWarning[] = [];
    const out = substituteTokens('{{var.a}}', tokenValues({ vars: { a: '{{brand.color.primary}} {{var.b}}', b: 'SECRET' } }), warnings);
    expect(out).toBe('{{brand.color.primary}} {{var.b}}');
  });

  it('unknown tokens and missing variables are replaced by nothing and reported', () => {
    const warnings: RenderWarning[] = [];
    const out = substituteTokens('[{{nope.x}}][{{var.missing}}][{{asset.ghost}}][{{brand.logo}}]', tokenValues(), warnings);
    expect(out).toBe('[][][data:image/png;base64,AAAA][data:image/png;base64,AAAA]');
    expect(codes(warnings).sort()).toEqual(['asset_missing', 'brand_logo_missing', 'unknown_token', 'variable_missing']);
  });

  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('a variable inside a style attribute cannot load an external image either', async () => {
    const out = await render(`<div style="${canvas('background:#fff')}"><div style="display:flex;width:200px;height:200px;background-image:{{var.x}}"></div></div>`, { variables: { x: 'url(https://evil.example/a.png)' } });
    expect(codes(out.warnings)).toContain('external_url_blocked');
  });

  it('an image token dropped into text does not put megabytes into a paragraph', async () => {
    await expect(render(`<div style="${canvas('background:#fff')}">{{asset.hero}}</div>`, { assets: { hero: PHOTO } })).rejects.toMatchObject({ code: 'text_too_long' });
  });

  it('end to end: markup in a variable is drawn as text and does not change the layout tree', async () => {
    const out = await render(`<div style="${canvas('background:#fff;color:#000;font-size:60px')}">{{var.x}}</div>`, { variables: { x: '<img src="https://evil.example/x.png"><script>1</script>' } });
    expect(out.warnings.map((w) => w.code)).not.toContain('script_removed');
    expect(out.warnings.map((w) => w.code)).not.toContain('external_url_blocked');
    expect(out.applied.nodes).toBe(1);
  });
});

describe('inline style parsing and the CSS whitelist', () => {
  it('splits declarations with quotes and data URIs containing semicolons', () => {
    const decls = parseStyleAttribute(`color: red; background-image:url(data:image/png;base64,AAAA); font-family: "A;B", serif !important; -webkit-text-stroke: 2px #000`);
    expect(decls.map((d) => d.prop)).toEqual(['color', 'backgroundImage', 'fontFamily', 'WebkitTextStroke']);
    expect(decls[1]!.value).toBe('url(data:image/png;base64,AAAA)');
    expect(decls[2]!.value).toBe('"A;B", serif');
  });

  it('keeps supported properties and reports the rest as warnings, not errors', () => {
    const { style, issues } = validateDeclarations(parseStyleAttribute('display:flex; columns:2; box-shadow:0 1px 2px #000; transition:all 1s; writing-mode:vertical-rl'));
    expect(Object.keys(style)).toEqual(['display', 'boxShadow']);
    expect(issues.map((i) => i.prop)).toEqual(['columns', 'transition', 'writingMode']);
    expect(issues[0]!.detail).toMatch(/flex or display:grid/);
  });

  it('blocks external urls in CSS and extreme values', () => {
    const { style, issues } = validateDeclarations(parseStyleAttribute('background-image:url(https://evil.example/a.png); width:99999px; filter:blur(900px); color:#fff; background:url(data:image/png;base64,AAAA)'));
    expect(Object.keys(style)).toEqual(['color', 'background']);
    expect(issues.map((i) => i.code)).toEqual(['external_url_blocked', 'css_value_too_large', 'css_value_too_large']);
  });

  it('end to end: unsupported properties come back as warnings with the element and a hint', async () => {
    const out = await render(`<div style="${canvas('background:#fff;columns:2;transition:all 1s')}"><div style="display:flex;color:#000;font-size:40px;cursor:pointer">Hi</div></div>`);
    const w = out.warnings.filter((x) => x.code === 'css_unsupported');
    expect(w.map((x) => x.message).join(' ')).toMatch(/"columns".*<div>/);
    expect(w.find((x) => x.message.includes('"transition"'))?.suggestion).toMatch(/static image/);
    expect(w.some((x) => x.message.includes('"cursor"'))).toBe(true);
  });

  it('invalid values of supported properties are reported through Satori and do not fail the render', async () => {
    const out = await render(`<div style="${canvas('background:#fff;display:table')}"><div style="display:flex;color:#000;font-size:40px">Hi</div></div>`);
    expect(codes(out.warnings)).toContain('css_invalid_value');
    expect((await sharp(out.data).metadata()).width).toBe(1080);
  });

  it('strips <script>, ignores <style> and class with a warning, removes unsupported tags', async () => {
    const out = await render(
      `<style>.a{color:red}</style><script>alert(1)</script><div class="a" style="${canvas('background:#fff')}"><iframe src="https://evil.example"></iframe><div style="display:flex;color:#000;font-size:40px" onclick="x()">Hello</div></div>`,
    );
    expect(codes(out.warnings)).toEqual(expect.arrayContaining(['script_removed', 'style_block_ignored', 'class_ignored', 'html_tag_unsupported']));
    expect(out.applied.nodes).toBe(2);
  });

  it('external images are never loaded: <img> and url() fall back with a warning', async () => {
    const { deps: d, calls } = await deps();
    const out = await renderCustom(
      { html: `<div style="${canvas("background:#fff;background-image:url('https://evil.example/bg.png')")}"><img src="https://evil.example/pic.png" width="100" height="100" /></div>`, format: FORMATS.square, brand: brandOf(), output: 'png' },
      d,
    );
    expect(calls).toEqual([]);
    expect(codes(out.warnings)).toContain('external_url_blocked');
  });
});

describe('limits', () => {
  it('rejects HTML larger than 50 KB', async () => {
    const html = `<div style="${canvas('background:#fff')}">${'x'.repeat(51 * 1024)}</div>`;
    await expect(render(html)).rejects.toMatchObject({ code: 'html_too_large' });
  });

  it('accepts HTML just under 50 KB', async () => {
    const vars = Array.from({ length: 5100 }, (_, i) => `--v${i}:1;`).join('');
    const html = `<div style="${canvas('background:#fff')}${vars}"></div>`;
    expect(Buffer.byteLength(html)).toBeGreaterThan(45 * 1024);
    expect(Buffer.byteLength(html)).toBeLessThan(50 * 1024);
    const out = await render(html);
    expect(out.width).toBe(1080);
  }, 30_000);

  it('rejects more than 30,000 characters of text in total', async () => {
    await expect(render(`<div style="${canvas('background:#fff;color:#000')}">${'x '.repeat(16000)}</div>`)).rejects.toMatchObject({ code: expect.stringMatching(/html_too_large|text_too_long/) });
    await expect(render(`<div style="${canvas('background:#fff;color:#000')}">{{var.a}}{{var.b}}{{var.c}}{{var.d}}{{var.e}}{{var.f}}{{var.g}}{{var.h}}{{var.i}}{{var.j}}{{var.k}}{{var.l}}{{var.m}}{{var.n}}{{var.o}}{{var.p}}</div>`, { variables: Object.fromEntries('abcdefghijklmnop'.split('').map((k) => [k, 'x'.repeat(2000)])) })).rejects.toMatchObject({ code: 'text_too_long' });
  }, 30_000);

  it('rejects more than 200 elements (and accepts 200)', async () => {
    const mk = (n: number): string => `<div style="${canvas('background:#fff;flex-wrap:wrap')}">${'<div style="display:flex;width:2px;height:2px;background:#000"></div>'.repeat(n)}</div>`;
    await expect(render(mk(MAX_NODES))).rejects.toMatchObject({ code: 'too_many_nodes' }); // 200 children + the root = 201
    const ok = await render(mk(MAX_NODES - 1));
    expect(ok.applied.nodes).toBe(MAX_NODES);
  });

  it('at most 8 assets, with valid names', async () => {
    const assets = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`a${i}`, PHOTO]));
    await expect(render(`<div style="${canvas()}"></div>`, { assets })).rejects.toMatchObject({ code: 'too_many_assets' });
    await expect(render(`<div style="${canvas()}"></div>`, { assets: { 'Bad Name': PHOTO } })).rejects.toMatchObject({ code: 'asset_name_invalid' });
  });

  it('limits variables (count, name, length)', async () => {
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`v${i}`, 'x']));
    await expect(render(`<div style="${canvas()}"></div>`, { variables: many })).rejects.toMatchObject({ code: 'too_many_variables' });
    await expect(render(`<div style="${canvas()}"></div>`, { variables: { 'bad name': 'x' } })).rejects.toMatchObject({ code: 'variable_name_invalid' });
    await expect(render(`<div style="${canvas()}"></div>`, { variables: { a: 'x'.repeat(2001) } })).rejects.toMatchObject({ code: 'variable_too_long' });
  });

  it('empty HTML and render timeout are plain errors', async () => {
    await expect(render('   ')).rejects.toMatchObject({ code: 'html_empty' });
    let t = 0;
    const slowClock = (): number => (t += 4000); // every check moves the clock 4 s
    await expect(render(`<div style="${canvas('background:#fff')}"></div>`, { now: slowClock })).rejects.toMatchObject({ code: 'render_timeout' });
  });
});

describe('assets: fetched through the injected fetcher (fetchsafe in production) and embedded', () => {
  it('fetches only declared assets that the HTML uses, once each, and warns about unused ones', async () => {
    const { deps: d, calls } = await deps({ 'https://assets.example.test/unused.jpg': await makePhoto(200, 200) });
    const out = await renderCustom(
      {
        html: `<div style="${canvas('background:#000')}"><img src="{{asset.hero}}" style="width:100%;height:100%;object-fit:cover" /></div>`,
        format: FORMATS.square,
        brand: brandOf(),
        assets: { hero: PHOTO, spare: 'https://assets.example.test/unused.jpg' },
      },
      d,
    );
    expect(calls).toEqual([PHOTO]);
    expect(out.applied.assets).toEqual(['hero']);
    expect(codes(out.warnings)).toContain('asset_unused');
    expect(out.ext).toBe('jpg'); // photos -> JPEG by default
    const p = await pixels(out.data);
    expect(pixelAt(p, 540, 540)).not.toEqual([0, 0, 0]); // the photo is there
  });

  it('a failing asset is a plain error that names it', async () => {
    await expect(render(`<div style="${canvas()}"><img src="{{asset.hero}}" /></div>`, { assets: { hero: 'https://assets.example.test/missing.jpg' } })).rejects.toMatchObject({ code: 'asset_failed', message: expect.stringContaining('"hero"') });
  });

  it('asset width/height tokens give the natural size; a missing optional asset is a silent transparent pixel', async () => {
    const out = await render(`<div style="${canvas('background:#fff')}"><div data-name="{{asset.hero.width}}x{{asset.hero.height}}" style="display:flex"></div><img src="{{asset.nothing}}" width="10" height="10" /></div>`, { assets: { hero: PHOTO }, optionalAssets: ['nothing'] });
    expect(codes(out.warnings)).not.toContain('asset_missing');
    expect(out.applied.nodes).toBe(3);
  });

  it('{{brand.logo}} embeds the brand logo (link or stored bytes), and warns when the brand has none', async () => {
    const withLogo = await render(`<div style="${canvas('background:#fff;align-items:center;justify-content:center')}"><img src="{{brand.logo}}" style="width:400px;height:140px" /></div>`, { brand: brandOf({ logo_url: LOGO }) });
    const p = await pixels(withLogo.data);
    expect(pixelAt(p, 360, 540)[0]).toBeLessThan(60); // navy logo plate (left of the orange "LOGO" text)
    const none = await render(`<div style="${canvas('background:#fff')}"><img src="{{brand.logo}}" style="width:400px;height:140px" /></div>`);
    expect(codes(none.warnings)).toContain('brand_logo_missing');
    const stored = await render(`<div style="${canvas('background:#fff;align-items:center;justify-content:center')}"><img src="{{brand.logo}}" style="width:400px;height:140px" /></div>`, { brand: { ...brandOf(), logos: { primary: await makeLogo('#aa0000') } } });
    expect(pixelAt(await pixels(stored.data), 360, 540)[0]).toBeGreaterThan(120);
  });
});

describe('fonts: registry only, with fallback and warning', () => {
  it('uses registry families (any spelling) and reports unknown ones', async () => {
    const html = (family: string): string => `<div style="${canvas('background:#fff;color:#000;font-size:80px;align-items:center;justify-content:center')};font-family:${family}">Hola</div>`;
    const known = await render(html("'work-sans', sans-serif"));
    expect(known.warnings.filter((w) => w.code === 'font_unavailable')).toEqual([]);
    expect(known.applied.fonts).toContain('Work Sans');
    const unknown = await render(html('Comic Sans MS'));
    const w = unknown.warnings.find((x) => x.code === 'font_unavailable');
    expect(w?.message).toMatch(/Comic Sans MS/);
    expect(w?.suggestion).toMatch(/Outfit.*Work Sans/);
    // the fallback is the brand body font, so the picture equals an explicit Work Sans render
    const explicit = await render(html('Work Sans'));
    expect(unknown.data.equals(explicit.data)).toBe(true);
  });

  it('removes characters no font can draw (emoji) and says so', async () => {
    const out = await render(`<div style="${canvas('background:#fff;color:#000;font-size:60px')}">Hola \u{1F600} mundo</div>`);
    expect(codes(out.warnings)).toContain('unsupported_characters');
  });

  it('draws Spanish accents', async () => {
    const out = await render(`<div style="${canvas('background:#fff;color:#000;font-size:60px')}">¿Qué tal una mañana? ÁÉÍÓÚ ñ</div>`);
    expect(codes(out.warnings)).not.toContain('unsupported_characters');
  });
});

describe('data-fit', () => {
  const fitHtml = (text: string, attrs = 'data-fit data-fit-max="200" data-fit-min="30" data-fit-lines="2"', box = 'width:800px'): string =>
    `<div style="${canvas('background:#fff')}"><div ${attrs} data-name="t" style="position:absolute;left:100px;top:100px;${box};color:#000;font-family:Outfit;font-weight:700;line-height:1.05">${text}</div></div>`;

  it('picks the largest size that fits the lines and the width, and shrinks for longer text', async () => {
    const short = await render(fitHtml('Hola'));
    const long = await render(fitHtml('Una frase bastante larga para una caja pequeña de dos líneas'));
    expect(short.applied.fit[0]!.font_size).toBe(200); // fits at the maximum
    const size = long.applied.fit[0]!.font_size;
    expect(size).toBeLessThan(200);
    expect(size).toBeGreaterThanOrEqual(30);
    expect(long.applied.fit[0]).toMatchObject({ lines: 2, fits: true });
    expect(codes(long.warnings)).not.toContain('text_does_not_fit');
    const veryLong = await render(fitHtml('Una frase bastante larga para una caja pequeña de dos líneas y todavía más palabras para forzar un tamaño menor'));
    expect(veryLong.applied.fit[0]!.font_size).toBeLessThan(size);
  });

  it('the fitted text really is inside its box in the picture (text pixels stay within 800 px of width)', async () => {
    const out = await render(fitHtml('Una frase bastante larga para una caja pequeña de dos líneas'));
    const p = await pixels(out.data);
    let maxX = 0;
    for (let y = 100; y < 400; y += 2) for (let x = 100; x < 1080; x += 2) if (pixelAt(p, x, y)[0] < 100) maxX = Math.max(maxX, x);
    expect(maxX).toBeLessThanOrEqual(100 + 800 + 4);
  });

  it('uses the box height when it has one, measures % widths, and reports text that cannot fit', async () => {
    const tall = await render(fitHtml('Titular de prueba que necesita varias líneas', 'data-fit data-fit-max="200" data-fit-min="20"', 'width:50%;height:300px'));
    expect(tall.applied.fit[0]!.fits).toBe(true);
    const tiny = await render(fitHtml('Una frase larga que nunca cabrá en una caja diminuta de cincuenta píxeles', 'data-fit data-fit-max="100" data-fit-min="40" data-fit-lines="1"', 'width:200px;height:50px'));
    expect(tiny.applied.fit[0]!.fits).toBe(false);
    expect(codes(tiny.warnings)).toContain('text_does_not_fit');
    expect(codes(tiny.warnings)).not.toContain('text_overflow'); // already reported once
  });

  it('is ignored (with a warning) on elements that contain other elements', async () => {
    const out = await render(`<div style="${canvas('background:#fff')}"><div data-fit style="display:flex;width:400px"><span>a</span><span>b</span></div></div>`);
    expect(codes(out.warnings)).toContain('data_fit_ignored');
  });

  it('defaults to shrinking from the declared font-size', async () => {
    const out = await render(`<div style="${canvas('background:#fff')}"><div data-fit data-fit-lines="1" style="position:absolute;left:100px;top:100px;width:300px;color:#000;font-size:90px;font-family:Outfit">Un texto largo para una línea</div></div>`);
    expect(out.applied.fit[0]!.font_size).toBeLessThan(90);
  });
});

describe('post-render checks (satori layout callback)', () => {
  const box = (style: string, text: string, extra = ''): string =>
    `<div style="${canvas('background:#fff')}"><div ${extra} style="position:absolute;${style};display:flex;color:#000;font-family:Outfit;font-size:60px">${text}</div></div>`;

  it('is quiet for a clean layout inside the safe area', async () => {
    const out = await render(box('left:{{safe.left}}px;top:{{safe.top}}px;width:500px', 'Todo en orden'));
    expect(out.warnings.filter((w) => ['text_outside_safe_zone', 'text_overflow', 'text_outside_canvas', 'low_contrast'].includes(w.code))).toEqual([]);
  });

  it('warns about text outside the safe area, naming the side and a fix', async () => {
    const out = await render(box('left:20px;top:20px;width:500px', 'Pegado al borde'));
    const w = out.warnings.find((x) => x.code === 'text_outside_safe_zone')!;
    expect(w.message).toMatch(/<div "Pegado al borde">.*left by \d+px.*top by \d+px/);
    expect(w.suggestion).toMatch(/\{\{safe\.left\}\}/);
  });

  it('story: the top 250 px and bottom 400 px are unsafe', async () => {
    const top = await render(box('left:108px;top:120px;width:500px', 'Arriba'), {}, 'story');
    expect(top.warnings.find((x) => x.code === 'text_outside_safe_zone')?.message).toMatch(/top 250 px/);
    const bottom = await render(box('left:108px;top:1600px;width:500px', 'Abajo'), {}, 'story');
    expect(bottom.warnings.find((x) => x.code === 'text_outside_safe_zone')?.message).toMatch(/bottom by/);
    const ok = await render(box('left:108px;top:600px;width:500px', 'Centro'), {}, 'story');
    expect(codes(ok.warnings)).not.toContain('text_outside_safe_zone');
  });

  it('warns about text cut off by the canvas edge', async () => {
    const out = await render(box('left:900px;top:300px;white-space:nowrap', 'Texto demasiado largo para caber'));
    const w = out.warnings.find((x) => x.code === 'text_outside_canvas')!;
    expect(w.message).toMatch(/cut off.*right edge/);
  });

  it('warns about text overflowing a fixed-height box and about a word wider than its box', async () => {
    const tall = await render(box('left:{{safe.left}}px;top:{{safe.top}}px;width:300px;height:80px', 'Este texto necesita muchas líneas para decir lo que quiere decir'));
    expect(tall.warnings.find((x) => x.code === 'text_overflow')?.message).toMatch(/too tall/);
    const wide = await render(box('left:{{safe.left}}px;top:{{safe.top}}px;width:200px', 'Electroencefalografista'));
    expect(wide.warnings.find((x) => x.code === 'text_overflow')?.message).toMatch(/too wide/);
  });

  it('an auto-height box that simply grows with its text is not an overflow', async () => {
    const out = await render(box('left:{{safe.left}}px;top:{{safe.top}}px;width:400px;line-height:0.9', 'Texto que ocupa varias líneas pero la caja crece con él'));
    expect(codes(out.warnings)).not.toContain('text_overflow');
  });

  it('warns about low contrast against the real background, and is quiet when contrast is fine', async () => {
    const bad = await render(`<div style="${canvas('background:#f2f2f2')}"><div style="position:absolute;left:{{safe.left}}px;top:{{safe.top}}px;display:flex;color:#ffffff;font-size:80px;font-family:Outfit">Invisible</div></div>`);
    const w = bad.warnings.find((x) => x.code === 'low_contrast')!;
    expect(w.message).toMatch(/<div "Invisible">.*1\.\d:1/);
    expect(w.suggestion).toMatch(/panel|gradient|darker/i);
    const good = await render(`<div style="${canvas('background:#14213d')}"><div style="position:absolute;left:{{safe.left}}px;top:{{safe.top}}px;display:flex;color:#ffffff;font-size:80px;font-family:Outfit">Visible</div></div>`);
    expect(codes(good.warnings)).not.toContain('low_contrast');
  });

  it('samples the background UNDER the text (a dark panel on a light page is fine; the same text beside it is not)', async () => {
    const out = await render(
      `<div style="${canvas('background:#f4f4f4')}">
        <div style="position:absolute;left:{{safe.left}}px;top:200px;width:500px;height:150px;background:#101820"></div>
        <div style="position:absolute;left:{{safe.left}}px;top:230px;display:flex;color:#fff;font-size:70px;font-family:Outfit">On panel</div>
        <div style="position:absolute;left:{{safe.left}}px;top:600px;display:flex;color:#fff;font-size:70px;font-family:Outfit">Off panel</div>
      </div>`,
    );
    const msgs = out.warnings.filter((w) => w.code === 'low_contrast').map((w) => w.message);
    expect(msgs.some((m) => m.includes('Off panel'))).toBe(true);
    expect(msgs.some((m) => m.includes('On panel'))).toBe(false);
  });

  it('data-decor and data-nocheck switch the checks off for an element', async () => {
    const out = await render(box('left:20px;top:20px;width:500px', 'Intencional', 'data-decor'));
    expect(codes(out.warnings)).not.toContain('text_outside_safe_zone');
  });

  it('warns when the outer element is bigger than the canvas (padding without box-sizing:border-box)', async () => {
    const bad = await render('<div style="display:flex;width:{{format.width}}px;height:{{format.height}}px;padding:60px;background:#123"></div>');
    expect(bad.warnings.find((w) => w.code === 'root_larger_than_canvas')?.suggestion).toMatch(/box-sizing:border-box/);
    const ok = await render('<div style="display:flex;box-sizing:border-box;width:{{format.width}}px;height:{{format.height}}px;padding:60px;background:#123"></div>');
    expect(codes(ok.warnings)).not.toContain('root_larger_than_canvas');
  });

  it('warns when the outer element does not fill the canvas', async () => {
    const out = await render('<div style="display:flex;width:500px;height:500px;background:#123"></div>');
    expect(codes(out.warnings)).toContain('root_not_full_size');
  });
});

describe('determinism, output and samples', () => {
  it('same input, same bytes; png and jpg encodings', async () => {
    const html = `<div style="${canvas('background:linear-gradient(135deg,#14213d,#fca311)')}"><div style="position:absolute;left:{{safe.left}}px;top:{{safe.top}}px;display:flex;color:#fff;font-size:90px;font-family:Outfit;font-weight:700">Hola</div></div>`;
    const a = await render(html);
    const b = await render(html);
    expect(a.data.equals(b.data)).toBe(true);
    expect(a.data.subarray(0, 4).toString('hex')).toBe('89504e47');
    const jpg = await render(html, { output: 'jpg' });
    expect(jpg.data.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(jpg.contentType).toBe('image/jpeg');
  });

  it.each(['square', 'portrait', 'story', 'landscape', 'link'] as FormatName[])('%s: exact canvas dimensions', async (name) => {
    const out = await render(`<div style="${canvas('background:#14213d')}"></div>`, {}, name);
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([FORMATS[name].width, FORMATS[name].height]);
  });

  it('a slide counter chip can be drawn on top', async () => {
    const html = `<div style="${canvas('background:#14213d')}"></div>`;
    const plain = await render(html);
    const counted = await render(html, { counter: { index: 2, total: 5 } });
    expect(counted.applied.counter?.corner).toBe('bottom-right');
    expect(plain.data.equals(counted.data)).toBe(false);
  });

  it('writes the magazine cover and the 3-column price list samples', async () => {
    const { deps: d } = await deps({ 'https://assets.example.test/cover.jpg': await makePhoto(1800, 2200) });
    const brand = brandOf({ colors: { primary: '#14213d', accent: '#fca311', paper: '#ffffff', ink: '#0b1020' }, fonts: { heading: 'Young Serif', body: 'Work Sans', accent: 'Outfit' } });
    const cover = await renderCustom(
      {
        html: `<div style="${canvas('background:{{brand.color.primary}}')}">
  <img src="{{asset.cover}}" style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;object-fit:cover" />
  <div style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;background-image:linear-gradient(to bottom, rgba(11,16,32,0.9) 0%, rgba(11,16,32,0.86) 46%, rgba(11,16,32,0.25) 64%, rgba(11,16,32,0.4) 74%, rgba(11,16,32,0.93) 100%)"></div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:{{safe.top}}px;display:flex;justify-content:space-between;color:#fff;font-family:{{brand.font.accent}};font-size:26px;letter-spacing:6px;text-transform:uppercase"><span>{{var.issue}}</span><span>{{var.season}}</span></div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:260px;display:flex;flex-direction:column;color:#fff">
    <div style="display:flex;width:90px;height:8px;background:{{brand.color.accent}};margin-bottom:34px"></div>
    <div data-fit data-fit-max="210" data-fit-min="90" data-fit-lines="3" style="display:flex;width:100%;font-family:{{brand.font.heading}};line-height:0.98">{{var.title}}</div>
  </div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;bottom:{{safe.bottom}}px;display:flex;flex-direction:column;color:#fff">
    <div data-fit data-fit-max="42" data-fit-min="28" data-fit-lines="3" style="display:flex;width:100%;max-width:780px;font-family:{{brand.font.body}};line-height:1.3">{{var.deck}}</div>
    <div style="display:flex;margin-top:30px;font-family:{{brand.font.accent}};font-weight:700;font-size:28px;letter-spacing:4px;text-transform:uppercase;color:{{brand.color.accent}}">{{var.byline}}</div>
  </div>
</div>`,
        format: FORMATS.portrait,
        brand,
        assets: { cover: 'https://assets.example.test/cover.jpg' },
        variables: { issue: 'Issue 07', season: 'Autumn 2026', title: 'The quiet art of slow mornings', deck: 'Seven rituals from cafés that refuse to rush, and what they teach us about starting the day.', byline: 'By Ana Morales' },
      },
      d,
    );
    expect(cover.warnings.filter((w) => ['text_overflow', 'text_outside_safe_zone', 'text_outside_canvas', 'low_contrast'].includes(w.code)), JSON.stringify(cover.warnings)).toEqual([]);
    writeFileSync(new URL(`compose-custom-magazine-cover.${cover.ext}`, SAMPLES_DIR), cover.data);

    const row = (name: string, price: string, note: string): string =>
      `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:16px 0;border-bottom:2px solid rgba(255,255,255,0.18)"><div style="display:flex;flex-direction:column"><div style="display:flex;font-size:34px;font-weight:700;font-family:{{brand.font.heading}}">${name}</div><div style="display:flex;font-size:22px;opacity:0.75;margin-top:4px">${note}</div></div><div style="display:flex;font-size:38px;font-weight:700;font-family:{{brand.font.heading}};color:{{brand.color.accent}}">${price}</div></div>`;
    const column = (title: string, rows: string): string =>
      `<div style="display:flex;flex-direction:column;flex:1;margin:0 18px;padding:34px 30px;border-radius:{{brand.radius}}px;background:rgba(255,255,255,0.07)"><div style="display:flex;font-family:{{brand.font.accent}};font-weight:700;font-size:26px;letter-spacing:4px;text-transform:uppercase;color:{{brand.color.accent}};margin-bottom:12px">${title}</div>${rows}</div>`;
    const list = await renderCustom(
      {
        html: `<div style="${canvas('background:{{brand.color.primary}};flex-direction:column;color:#fff;font-family:{{brand.font.body}}')}">
  <div style="display:flex;position:absolute;left:{{safe.left}}px;top:{{safe.top}}px;flex-direction:column">
    <div style="display:flex;font-family:{{brand.font.accent}};font-size:26px;letter-spacing:6px;text-transform:uppercase;color:{{brand.color.accent}}">{{var.kicker}}</div>
    <div style="display:flex;margin-top:12px;font-family:{{brand.font.heading}};font-size:84px;line-height:1.05">{{var.title}}</div>
  </div>
  <div style="display:flex;position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:360px;margin:0 -18px">
    ${column('Coffee', row('Espresso', '$3', 'Single origin') + row('Flat white', '$4', 'Double shot') + row('Filter', '$4', 'Rotating beans'))}
    ${column('Bakery', row('Croissant', '$3', 'Butter, baked daily') + row('Cinnamon roll', '$4', 'Warm') + row('Banana bread', '$3', 'House recipe'))}
    ${column('Brunch', row('Avocado toast', '$9', 'Sourdough, lime') + row('Shakshuka', '$11', 'Two eggs') + row('Granola bowl', '$8', 'Seasonal fruit'))}
  </div>
  <div style="display:flex;position:absolute;left:{{safe.left}}px;bottom:{{safe.bottom}}px;font-size:26px;opacity:0.8">{{var.footer}}</div>
</div>`,
        format: FORMATS.landscape,
        brand,
        variables: { kicker: 'Autumn menu', title: 'Prices at a glance', footer: 'Open daily 8:00 to 18:00 · example.com' },
      },
      d,
    );
    expect(list.warnings.filter((w) => ['text_overflow', 'text_outside_canvas', 'low_contrast'].includes(w.code)), JSON.stringify(list.warnings)).toEqual([]);
    writeFileSync(new URL(`compose-custom-price-list.${list.ext}`, SAMPLES_DIR), list.data);
    expect((await sharp(list.data).metadata()).width).toBe(1920);
    void solidImage;
  }, 60_000);
});
