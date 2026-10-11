import { RADIUS_PX, type ResolvedBrand } from '../brand.js';
import { scaleOf, textSafeRect, type FormatSpec } from '../formats.js';
import { warn, type RenderWarning } from '../warnings.js';

/**
 * Token substitution for compose_custom and saved templates (DESIGN section 5.2).
 *
 * Tokens are written `{{path}}`. They are replaced BEFORE the HTML is parsed, in ONE pass (a replaced value is never scanned again), and
 * `{{var.*}}` values are HTML-escaped, so a variable can never add markup, only text (or attribute text).
 *
 *   {{brand.color.primary|secondary|accent|ink|paper|<extra name>}}   (aliases: {{brand.primary}} ... {{brand.paper}})
 *   {{brand.font.heading|body|accent}}      font family name, usable unquoted or quoted in font-family
 *   {{brand.logo}} {{brand.logo_light}} {{brand.logo_dark}}   embedded image (use as <img src>); transparent pixel if the brand has none
 *   {{brand.radius}}                        corner radius in px for this format (9999 for "pill")
 *   {{brand.style.radius|button|eyebrow_case|eyebrow_transform|logo_position|logo_size|scrim|photo_style}}
 *   {{brand.name}}                          display name of a saved brand
 *   {{asset.<name>}}  {{asset.<name>.width}}  {{asset.<name>.height}}   declared images, embedded
 *   {{var.<name>}}                          text variable, HTML-escaped
 *   {{format.width|height|name|scale}}      canvas (scale = short side / 1080, the reference the built-in templates are designed at)
 *   {{px.<n>}}                              n px at the 1080-px reference, scaled to this format (e.g. font-size:{{px.40}}px)
 *   {{safe.top|bottom|left|right|width|height}}   title-safe insets (px from each edge) and the safe area size
 */

export interface AssetData {
  uri: string;
  width: number;
  height: number;
  /** Tiny version of the same image: the analysis pass draws this instead (resvg cost grows with image size, and the checks only need average colors). */
  thumb?: string;
}

export interface TokenValues {
  brand: ResolvedBrand;
  logoUris: Partial<Record<'logo' | 'logo_light' | 'logo_dark', string>>;
  assets: ReadonlyMap<string, AssetData>;
  /** Declared-optional assets (template image variables that were not provided) resolve to a transparent pixel without a warning. */
  optionalAssets: ReadonlySet<string>;
  vars: Readonly<Record<string, string>>;
  format: FormatSpec;
  transparentPixel: string;
}

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Every token path used in the HTML (e.g. `asset.hero`, `brand.logo`). */
export function scanTokens(html: string): Set<string> {
  const found = new Set<string>();
  for (const m of html.matchAll(TOKEN_RE)) found.add(m[1] as string);
  return found;
}

const COLOR_NAMES = ['primary', 'secondary', 'accent', 'ink', 'paper'] as const;

export function safeInsets(format: FormatSpec): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
  const r = textSafeRect(format);
  return { top: r.y, bottom: format.height - (r.y + r.h), left: r.x, right: format.width - (r.x + r.w), width: r.w, height: r.h };
}

export function substituteTokens(html: string, values: TokenValues, warnings: RenderWarning[]): string {
  const { brand, format } = values;
  const safe = safeInsets(format);
  const unknown = new Set<string>();

  const resolve = (path: string): string | undefined => {
    const parts = path.split('.');
    const head = parts[0];
    if (head === 'brand') {
      const rest = parts.slice(1);
      const first = rest[0];
      if (first === undefined) return undefined;
      if ((COLOR_NAMES as readonly string[]).includes(first) && rest.length === 1) return brand.colors[first as (typeof COLOR_NAMES)[number]];
      if (first === 'color' && rest.length === 2) {
        const name = (rest[1] as string).toLowerCase();
        if ((COLOR_NAMES as readonly string[]).includes(name)) return brand.colors[name as (typeof COLOR_NAMES)[number]];
        return brand.extraColors.find((c) => c.name.toLowerCase() === name)?.hex;
      }
      if (first === 'font' && rest.length === 2) {
        const role = rest[1];
        return role === 'heading' || role === 'body' || role === 'accent' ? brand.fonts[role] : undefined;
      }
      if ((first === 'logo' || first === 'logo_light' || first === 'logo_dark') && rest.length === 1) {
        const uri = values.logoUris[first];
        if (uri === undefined) {
          warn(warnings, 'brand_logo_missing', `The brand has no ${first.replace('_', ' ')} image, so {{brand.${first}}} is empty.`, 'Pass brand.logo_url (or save the brand with logos) or remove the logo element.');
          return values.transparentPixel;
        }
        return uri;
      }
      if (first === 'radius' && rest.length === 1) {
        return String(brand.style.radius === 'pill' ? 9999 : Math.round(RADIUS_PX[brand.style.radius] * scaleOf(format)));
      }
      if (first === 'name' && rest.length === 1) return escapeHtml(brand.displayName ?? '');
      if (first === 'style' && rest.length === 2) {
        const key = rest[1];
        const s = brand.style;
        switch (key) {
          case 'radius': return s.radius;
          case 'button': return s.button;
          case 'eyebrow_case': return s.eyebrow_case;
          case 'eyebrow_transform': return s.eyebrow_case === 'upper' ? 'uppercase' : s.eyebrow_case === 'title' ? 'capitalize' : 'none';
          case 'logo_position': return brand.logoCorner ?? s.logo_position ?? 'top-left';
          case 'logo_size': return s.logo_size;
          case 'scrim': return s.scrim;
          case 'photo_style': return escapeHtml(s.photo_style ?? '');
          default: return undefined;
        }
      }
      return undefined;
    }
    if (head === 'asset' && (parts.length === 2 || parts.length === 3)) {
      const name = parts[1] as string;
      const asset = values.assets.get(name);
      if (!asset) {
        if (!values.optionalAssets.has(name)) {
          warn(warnings, 'asset_missing', `{{asset.${name}}} is used but no asset called "${name}" was provided.`, 'Add it to `assets` ({"name": "https://..."}) or remove the element.');
        }
        return parts.length === 3 ? '0' : values.transparentPixel;
      }
      if (parts.length === 2) return asset.uri;
      if (parts[2] === 'width') return String(asset.width);
      if (parts[2] === 'height') return String(asset.height);
      return undefined;
    }
    if (head === 'var' && parts.length === 2) {
      const name = parts[1] as string;
      const value = values.vars[name];
      if (value === undefined) {
        warn(warnings, 'variable_missing', `{{var.${name}}} is used but no variable called "${name}" was provided; it is empty.`, 'Add it to `variables` or remove the token.');
        return '';
      }
      return escapeHtml(value);
    }
    if (head === 'format' && parts.length === 2) {
      if (parts[1] === 'width') return String(format.width);
      if (parts[1] === 'height') return String(format.height);
      if (parts[1] === 'name') return format.name;
      if (parts[1] === 'scale') return String(Math.round(scaleOf(format) * 1000) / 1000);
      return undefined;
    }
    if (head === 'px' && parts.length === 2) {
      const n = Number(parts[1]);
      return Number.isFinite(n) && n >= 0 && n <= 4000 ? String(Math.round(n * scaleOf(format))) : undefined;
    }
    if (head === 'safe' && parts.length === 2) {
      const key = parts[1] as keyof typeof safe;
      return key in safe ? String(safe[key]) : undefined;
    }
    return undefined;
  };

  const out = html.replace(TOKEN_RE, (_m, path: string) => {
    const value = resolve(path);
    if (value === undefined) {
      unknown.add(path);
      return '';
    }
    return value;
  });
  for (const path of unknown) {
    warn(warnings, 'unknown_token', `The token {{${path}}} is not known and was replaced by nothing.`, 'Valid tokens: brand.color.*, brand.font.*, brand.logo, brand.radius, brand.style.*, asset.<name>, var.<name>, format.width|height, safe.top|bottom|left|right.');
  }
  return out;
}
