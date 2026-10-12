/**
 * HTML layouts for `scripts/readme-assets.ts`, written for `compose_custom` (inline styles, tokens, the CSS subset the
 * engine supports). The magazine cover and the price list follow `skills/marketing-orchestrator/references/design-guide.md`.
 */

const esc = (s: string): string => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------------------------------------------------------------
// Figure shells: a flat canvas with soft tile shadows and labels; the rendered posts are composited on top with sharp.
// ---------------------------------------------------------------------------------------------------------------------

export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Bold first line under the tile. */
  title: string;
  /** Muted second line. */
  sub?: string;
}

export const CANVAS_BG = '#f5f2ec';
export const TILE_RADIUS = 18;

export function shell(width: number, height: number, slots: Slot[], extra = ''): string {
  const parts = slots.map((s) => {
    const shadow = `<div style="position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;border-radius:${TILE_RADIUS}px;background:#d9d4c9;box-shadow:0 10px 26px rgba(40,32,20,0.22)"></div>`;
    const label = `<div style="position:absolute;left:${s.x}px;top:${s.y + s.h + 12}px;width:${s.w}px;display:flex;flex-direction:column">
      <div style="display:flex;font-family:Outfit;font-weight:700;font-size:20px;color:#1d2230">${esc(s.title)}</div>
      ${s.sub ? `<div style="display:flex;margin-top:3px;font-family:Work Sans;font-size:16px;color:#6a6f7a">${esc(s.sub)}</div>` : ''}
    </div>`;
    return shadow + label;
  });
  return `<div style="display:flex;position:relative;width:${width}px;height:${height}px;background:${CANVAS_BG}">${parts.join('')}${extra}</div>`;
}

/** A thin chevron between two carousel slides. */
export function chevron(cx: number, cy: number): string {
  return `<svg style="position:absolute;left:${cx - 11}px;top:${cy - 18}px" width="22" height="36" viewBox="0 0 22 36"><path d="M5 4 L17 18 L5 32" fill="none" stroke="#9a9484" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hero banner (1280 x 640)
// ---------------------------------------------------------------------------------------------------------------------

export interface HeroCard {
  asset: string;
  name: string;
  meta: string;
  initial: string;
  avatar: string;
  chip: { text: string; bg: string; fg: string };
  x: number;
  y: number;
  w: number;
  rot: number;
}

function heroCard(c: HeroCard): string {
  return `<div style="position:absolute;left:${c.x}px;top:${c.y}px;display:flex;flex-direction:column;width:${c.w}px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 26px 50px rgba(2,6,18,0.5);transform:rotate(${c.rot}deg)">
    <div style="display:flex;align-items:center;padding:12px 14px">
      <div style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9999px;background:${c.avatar};color:#ffffff;font-family:Outfit;font-weight:700;font-size:16px">${esc(c.initial)}</div>
      <div style="display:flex;flex-direction:column;margin-left:10px">
        <div style="display:flex;font-family:Outfit;font-weight:700;font-size:15px;color:#16181d">${esc(c.name)}</div>
        <div style="display:flex;font-family:Work Sans;font-size:12px;color:#6b6f78">${esc(c.meta)}</div>
      </div>
    </div>
    <img src="{{asset.${c.asset}}}" style="width:${c.w}px;height:${c.w}px" />
    <div style="display:flex;padding:11px 14px">
      <div style="display:flex;padding:4px 11px;border-radius:9999px;background:${c.chip.bg};color:${c.chip.fg};font-family:Work Sans;font-weight:700;font-size:12px">${esc(c.chip.text)}</div>
    </div>
  </div>`;
}

function step(label: string, last = false): string {
  const arrow = last
    ? ''
    : `<svg style="margin:0 12px" width="20" height="14" viewBox="0 0 20 14"><path d="M1 7 H17 M11 1.5 L17 7 L11 12.5" fill="none" stroke="#7d8aa6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const bg = last ? '#ffb84d' : 'rgba(255,255,255,0.1)';
  const fg = last ? '#1a1305' : '#e8edf7';
  return `<div style="display:flex;align-items:center"><div style="display:flex;padding:8px 18px;border-radius:9999px;background:${bg};color:${fg};font-family:Outfit;font-weight:700;font-size:19px">${label}</div>${arrow}</div>`;
}

/** The "ask first" moment of the workflow: the assistant waits for a yes before anything is scheduled. */
function approvalCard(x: number, y: number): string {
  return `<div style="position:absolute;left:${x}px;top:${y}px;display:flex;flex-direction:column;box-sizing:border-box;width:372px;padding:15px 18px 17px;background:#ffffff;border-radius:18px;box-shadow:0 22px 44px rgba(2,6,18,0.5)">
    <div style="display:flex;align-items:center">
      <div style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:9999px;background:#ffb84d;color:#1a1305;font-family:Outfit;font-weight:700;font-size:14px">C</div>
      <div style="display:flex;margin-left:10px;font-family:Outfit;font-weight:700;font-size:15px;color:#16181d">Claude</div>
    </div>
    <div style="display:flex;margin-top:9px;font-family:Work Sans;font-size:16px;line-height:1.35;color:#2a2d34">Both posts are ready. Schedule them for Tue 9:30 and Thu 8:30?</div>
    <div style="display:flex;margin-top:13px">
      <div style="display:flex;padding:7px 16px;border-radius:9999px;background:#ffb84d;color:#1a1305;font-family:Outfit;font-weight:700;font-size:15px">Yes, schedule</div>
      <div style="display:flex;margin-left:10px;padding:5px 16px;border-radius:9999px;border:2px solid #cfd4de;color:#3d4658;font-family:Outfit;font-weight:700;font-size:15px">Save as drafts</div>
    </div>
  </div>`;
}

export function hero(cards: HeroCard[]): string {
  return `<div style="display:flex;position:relative;width:1280px;height:640px;overflow:hidden;background:linear-gradient(118deg,#0d1322 0%,#14213d 52%,#1b3a52 100%);color:#f4f1ea">
  <div style="position:absolute;left:700px;top:-150px;width:700px;height:700px;border-radius:9999px;background:radial-gradient(circle, rgba(255,184,77,0.26) 0%, rgba(255,184,77,0) 66%)"></div>
  <div style="position:absolute;left:-180px;top:380px;width:560px;height:560px;border-radius:9999px;background:radial-gradient(circle, rgba(94,194,232,0.16) 0%, rgba(94,194,232,0) 68%)"></div>
  <div style="position:absolute;left:76px;top:58px;display:flex;flex-direction:column;width:590px">
    <div style="display:flex;align-self:flex-start;padding:7px 16px;border-radius:9999px;border:2px solid rgba(255,184,77,0.7);color:#ffb84d;font-family:Outfit;font-weight:700;font-size:15px;letter-spacing:3px;text-transform:uppercase">Agent Skill + MCP server</div>
    <div style="display:flex;flex-direction:column;margin-top:26px;font-family:Outfit;font-weight:700;font-size:88px;line-height:1;letter-spacing:-2px;color:#ffffff">
      <div style="display:flex">Marketing</div>
      <div style="display:flex">Orchestrator</div>
    </div>
    <div style="display:flex;margin-top:26px;width:540px;font-family:Work Sans;font-size:29px;line-height:1.35;color:rgba(244,241,234,0.86)">Campaigns, branded graphics and scheduling — from one conversation with Claude</div>
  </div>
  <div style="position:absolute;left:76px;top:494px;display:flex;flex-direction:column">
    <div style="display:flex;align-items:center">${step('Plan')}${step('Write')}${step('Design')}${step('Schedule', true)}</div>
    <div style="display:flex;margin-top:18px;font-family:Work Sans;font-size:17px;color:rgba(244,241,234,0.62)">Nothing is scheduled or published without your explicit yes.</div>
  </div>
  ${cards.map(heroCard).join('\n  ')}
  ${approvalCard(728, 474)}
</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Custom layouts for the gallery
// ---------------------------------------------------------------------------------------------------------------------

/** Design guide, layout A: magazine cover (portrait; asset `cover`; variables issue, season, title, deck, byline). */
export const MAGAZINE_COVER = `<div style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.primary}}">
  <img src="{{asset.cover}}" style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;object-fit:cover" />
  <div style="position:absolute;left:0;top:0;width:{{format.width}}px;height:{{format.height}}px;background-image:linear-gradient(to bottom, rgba(11,16,32,0.9) 0%, rgba(11,16,32,0.86) 46%, rgba(11,16,32,0.25) 64%, rgba(11,16,32,0.4) 74%, rgba(11,16,32,0.93) 100%)"></div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:{{safe.top}}px;display:flex;justify-content:space-between;color:{{brand.color.paper}};font-family:{{brand.font.accent}};font-size:{{px.26}}px;letter-spacing:{{px.6}}px;text-transform:uppercase">
    <span>{{var.issue}}</span><span>{{var.season}}</span>
  </div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:{{px.260}}px;display:flex;flex-direction:column;color:{{brand.color.paper}}">
    <div style="display:flex;width:{{px.90}}px;height:{{px.8}}px;background:{{brand.color.accent}};margin-bottom:{{px.34}}px"></div>
    <div data-fit data-fit-max="{{px.210}}" data-fit-min="{{px.90}}" data-fit-lines="3" style="display:flex;width:100%;font-family:{{brand.font.heading}};line-height:0.98">{{var.title}}</div>
  </div>
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;bottom:{{safe.bottom}}px;display:flex;flex-direction:column;color:{{brand.color.paper}}">
    <div data-fit data-fit-max="{{px.42}}" data-fit-min="{{px.28}}" data-fit-lines="3" style="display:flex;width:100%;font-family:{{brand.font.body}};line-height:1.3">{{var.deck}}</div>
    <div style="display:flex;margin-top:{{px.30}}px;font-family:{{brand.font.accent}};font-weight:700;font-size:{{px.28}}px;letter-spacing:{{px.4}}px;text-transform:uppercase;color:{{brand.color.accent}}">{{var.byline}}</div>
  </div>
</div>`;

export interface PriceColumn {
  title: string;
  rows: { name: string; note: string; price: string }[];
}

function priceColumn(col: PriceColumn): string {
  const rows = col.rows
    .map(
      (r, i) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:{{px.26}}px 0;${i < col.rows.length - 1 ? 'border-bottom:2px solid rgba(255,255,255,0.18)' : ''}">
        <div style="display:flex;flex-direction:column"><div style="display:flex;font-family:{{brand.font.heading}};font-size:{{px.38}}px">${esc(r.name)}</div><div style="display:flex;margin-top:{{px.4}}px;font-size:{{px.26}}px;opacity:0.8">${esc(r.note)}</div></div>
        <div style="display:flex;font-family:{{brand.font.accent}};font-size:{{px.46}}px;font-weight:700;color:{{brand.color.accent}}">${esc(r.price)}</div>
      </div>`,
    )
    .join('');
  return `<div style="display:flex;flex-direction:column;flex:1;padding:{{px.30}}px {{px.36}}px {{px.10}}px;border-radius:{{brand.radius}}px;background:rgba(255,255,255,0.08)">
      <div style="display:flex;padding-bottom:{{px.16}}px;border-bottom:{{px.6}}px solid {{brand.color.accent}};font-family:{{brand.font.accent}};font-weight:700;font-size:{{px.28}}px;letter-spacing:{{px.5}}px;text-transform:uppercase">${esc(col.title)}</div>
      ${rows}
    </div>`;
}

/** Design guide, layout B grown to three column panels (landscape; no assets; variables eyebrow, title, footer). */
export function priceList(columns: PriceColumn[]): string {
  return `<div style="display:flex;position:relative;width:{{format.width}}px;height:{{format.height}}px;background:{{brand.color.ink}};color:{{brand.color.paper}};font-family:{{brand.font.body}}">
  <div style="position:absolute;left:{{safe.left}}px;top:{{safe.top}}px;display:flex;flex-direction:column">
    <div style="display:flex;font-family:{{brand.font.accent}};font-size:{{px.26}}px;letter-spacing:{{px.6}}px;text-transform:uppercase;color:{{brand.color.accent}}">{{var.eyebrow}}</div>
    <div style="display:flex;margin-top:{{px.12}}px;font-family:{{brand.font.heading}};font-size:{{px.84}}px;line-height:1.05">{{var.title}}</div>
  </div>
  <img src="{{brand.logo_light}}" style="position:absolute;right:{{safe.right}}px;top:{{safe.top}}px;width:{{px.300}}px;height:{{px.90}}px;object-fit:contain" />
  <div style="position:absolute;left:{{safe.left}}px;right:{{safe.right}}px;top:{{px.320}}px;display:flex;gap:{{px.32}}px">
    ${columns.map(priceColumn).join('\n    ')}
  </div>
  <div style="position:absolute;left:{{safe.left}}px;bottom:{{safe.bottom}}px;display:flex;font-size:{{px.28}}px;opacity:0.85">{{var.footer}}</div>
</div>`;
}
