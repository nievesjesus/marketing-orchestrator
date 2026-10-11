import type { ComposeDeps } from './render/compose.js';
import type { ResolvedBrand } from './render/brand.js';
import { renderCustom } from './render/custom/render.js';
import { FORMATS } from './render/formats.js';
import { RADIUS_PX } from './render/brand.js';

/**
 * The brand sheet: one picture with the palette (swatches and hex codes), a specimen of every font, the logos on a light and a dark tile,
 * and the style rules (radius, button shape, eyebrow case). It is drawn by the same engine as compose_custom, from an HTML template whose
 * only dynamic parts are tokens, so user text can never add markup.
 */

const esc = (s: string): string => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface BrandSheet {
  data: Buffer;
  ext: 'png' | 'jpg';
  warnings: { code: string; message: string; suggestion?: string }[];
}

export async function renderBrandSheet(brand: ResolvedBrand, meta: { name: string; slug: string; version: number }, deps: ComposeDeps): Promise<BrandSheet> {
  const swatches: { name: string; hex: string }[] = [
    { name: 'primary', hex: brand.colors.primary },
    { name: 'secondary', hex: brand.colors.secondary },
    { name: 'accent', hex: brand.colors.accent },
    { name: 'ink', hex: brand.colors.ink },
    { name: 'paper', hex: brand.colors.paper },
    ...brand.extraColors.slice(0, 5),
  ];
  const vars: Record<string, string> = { name: meta.name, meta: `${meta.slug} · v${meta.version}` };
  const swatchHtml = swatches
    .map((s, i) => {
      vars[`sw${i}_name`] = s.name;
      vars[`sw${i}_hex`] = s.hex.toUpperCase();
      return `<div style="display:flex;flex-direction:column;width:180px;margin:0 24px 26px 0">
        <div style="display:flex;height:110px;border-radius:{{brand.radius}}px;background:${esc(s.hex)};border:2px solid rgba(0,0,0,0.10)"></div>
        <div style="display:flex;margin-top:10px;font-size:22px;color:#16181d">{{var.sw${i}_name}}</div>
        <div style="display:flex;font-size:20px;color:#6b6f78;letter-spacing:1px">{{var.sw${i}_hex}}</div>
      </div>`;
    })
    .join('');

  const fonts: { role: string; family: string; css: string; sample: string; size: number; extra: string }[] = [
    { role: 'Heading', family: brand.fonts.heading, css: '{{brand.font.heading}}', sample: 'Aa  The quick brown fox', size: 54, extra: 'line-height:1.1;' },
    { role: 'Body', family: brand.fonts.body, css: '{{brand.font.body}}', sample: 'Pack my box with five dozen liquor jugs. ¿Qué tal una mañana de café?', size: 30, extra: 'line-height:1.35;' },
    { role: 'Accent', family: brand.fonts.accent, css: '{{brand.font.accent}}', sample: 'Eyebrow label sample', size: 28, extra: 'letter-spacing:3px;text-transform:{{brand.style.eyebrow_transform}};' },
  ];
  const fontHtml = fonts
    .map((f, i) => {
      vars[`f${i}_label`] = `${f.role}: ${f.family}`;
      vars[`f${i}_sample`] = f.sample;
      return `<div style="display:flex;flex-direction:column;margin-bottom:30px">
        <div style="display:flex;font-size:20px;color:#6b6f78;margin-bottom:8px">{{var.f${i}_label}}</div>
        <div style="display:flex;font-family:${f.css};font-size:${f.size}px;color:#16181d;${f.extra}">{{var.f${i}_sample}}</div>
      </div>`;
    })
    .join('');

  const hasLogo = Boolean(brand.logos.primary || brand.logos.light || brand.logos.dark);
  const onLight = brand.logos.dark ? '{{brand.logo_dark}}' : brand.logos.primary ? '{{brand.logo}}' : brand.logos.light ? '{{brand.logo_light}}' : '';
  const onDark = brand.logos.light ? '{{brand.logo_light}}' : brand.logos.primary ? '{{brand.logo}}' : brand.logos.dark ? '{{brand.logo_dark}}' : '';
  const tile = (bg: string, src: string, border: string): string =>
    `<div style="display:flex;align-items:center;justify-content:center;width:420px;height:200px;margin-bottom:24px;border-radius:{{brand.radius}}px;background:${bg};border:2px solid ${border}">
      ${src ? `<img src="${src}" style="width:300px;height:140px;object-fit:contain" />` : ''}
    </div>`;
  const logoHtml = hasLogo
    ? tile('#ffffff', onLight, 'rgba(0,0,0,0.10)') + tile('#16181d', onDark, '#16181d')
    : `<div style="display:flex;font-size:24px;color:#6b6f78">No logo saved yet.</div>`;

  const s = brand.style;
  vars.style_line = `Radius ${s.radius} · Buttons ${s.button} · Eyebrow ${s.eyebrow_case} · Logo ${brand.logoCorner ?? s.logo_position ?? 'top-left'}, ${s.logo_size} · Scrim ${s.scrim}`;
  const btnRadius = s.button === 'pill' ? 999 : s.button === 'square' ? 0 : Math.max(RADIUS_PX.small, s.radius === 'pill' ? RADIUS_PX.large : RADIUS_PX[s.radius]);
  const button =
    s.button === 'underline'
      ? `<div style="display:flex;padding-bottom:8px;border-bottom:6px solid {{brand.color.accent}};font-family:{{brand.font.accent}};font-size:30px;color:#16181d">Sample button</div>`
      : `<div style="display:flex;padding:16px 38px;border-radius:${btnRadius}px;background:{{brand.color.accent}};color:{{brand.color.ink}};font-family:{{brand.font.accent}};font-size:28px">Sample button</div>`;

  const html = `<div style="display:flex;flex-direction:column;box-sizing:border-box;width:{{format.width}}px;height:{{format.height}}px;background:#f7f5f0;padding:60px 72px;font-family:{{brand.font.body}}">
  <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:34px">
    <div style="display:flex;flex-direction:column">
      <div style="display:flex;font-size:20px;letter-spacing:5px;text-transform:uppercase;color:#6b6f78">Brand sheet</div>
      <div style="display:flex;font-family:{{brand.font.heading}};font-size:72px;line-height:1.1;color:#16181d">{{var.name}}</div>
    </div>
    <div style="display:flex;font-size:24px;color:#6b6f78">{{var.meta}}</div>
  </div>
  <div style="display:flex;flex:1">
    <div style="display:flex;flex-direction:column;width:640px;margin-right:56px">
      <div style="display:flex;font-size:20px;letter-spacing:4px;text-transform:uppercase;color:#6b6f78;margin-bottom:22px">Colors</div>
      <div style="display:flex;flex-wrap:wrap">${swatchHtml}</div>
    </div>
    <div style="display:flex;flex-direction:column;flex:1;margin-right:56px">
      <div style="display:flex;font-size:20px;letter-spacing:4px;text-transform:uppercase;color:#6b6f78;margin-bottom:22px">Fonts</div>
      ${fontHtml}
    </div>
    <div style="display:flex;flex-direction:column;width:420px">
      <div style="display:flex;font-size:20px;letter-spacing:4px;text-transform:uppercase;color:#6b6f78;margin-bottom:22px">Logo</div>
      ${logoHtml}
    </div>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;font-size:22px;color:#6b6f78">{{var.style_line}}</div>
    ${button}
  </div>
</div>`;

  const out = await renderCustom({ html, format: FORMATS.landscape, brand, variables: vars, output: 'jpg', checks: false }, deps);
  return { data: out.data, ext: out.ext, warnings: out.warnings };
}
