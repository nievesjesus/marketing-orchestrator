import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from './logger.js';
import { normalizePostizBase, PostizUrlError } from './postiz-url.js';

/**
 * Environment configuration (DESIGN section 11). Secrets are read here and
 * nowhere else; error messages name the variable, never its value.
 */

export interface AccessToken {
  name: string;
  token: string;
}

/** `http`: Streamable HTTP server with access tokens. `stdio`: local single-user server for one MCP client. */
export type RunMode = 'http' | 'stdio';

/** Owner name used for every image, quota and saved item in stdio mode (a single local user). */
export const LOCAL_USER = 'local';

export interface PostizSettings {
  /** Normalized Public API base, e.g. `https://api.postiz.com/public/v1`. */
  apiBase: string;
  apiKey: string;
  /** Upload the final graphics of compose_post / compose_custom / compose_carousel automatically (`POSTIZ_AUTO_UPLOAD`, default true). generate_image and edit_image never upload unless the call says so. */
  autoUpload: boolean;
  /** False in HTTP mode unless `POSTIZ_ALLOW_IN_HTTP=true` (the Postiz key is single-tenant). */
  enabled: boolean;
}

export interface Config {
  mode: RunMode;
  port: number;
  host: string;
  /** Base of the image links (`<base>/i/...`). Null in stdio mode without PUBLIC_BASE_URL: links are `file://` URLs. */
  publicBaseUrl: string | null;
  dataDir: string;
  fontsDir: string;
  accessTokens: AccessToken[];
  keys: { gemini?: string; fal?: string; leonardo?: string };
  retentionDays: number;
  limits: { dailyImages: number; dailyUsd: number; dailyRenders: number };
  syncWaitMs: number;
  nodeEnv: string;
  /** http:// and loopback fetches are allowed only in dev/test (see fetchsafe). */
  allowInsecureLocalhost: boolean;
  logLevel: LogLevel;
  /** Direct Postiz upload (POSTIZ_URL + POSTIZ_API_KEY), or null when not configured. */
  postiz: PostizSettings | null;
  /** Extra absolute directories (stdio mode only) from which local `file://` images may be read; own images are always allowed. */
  localImageDirs: string[];
}

export interface LoadConfigOptions {
  mode?: RunMode;
  /** Home directory used for the stdio default data dir (tests inject one). */
  homeDir?: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

/** `ACCESS_TOKENS=name:token,name:token` (tokens are URL-safe; use `openssl rand -hex 24`). */
export function parseAccessTokens(raw: string | undefined): AccessToken[] {
  if (!raw || !raw.trim()) {
    throw new ConfigError('ACCESS_TOKENS is required (format: name:token,name:token).');
  }
  const seenNames = new Set<string>();
  const seenTokens = new Set<string>();
  const out: AccessToken[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new ConfigError('ACCESS_TOKENS entries must look like name:token.');
    }
    const name = trimmed.slice(0, idx);
    const token = trimmed.slice(idx + 1);
    if (!NAME_RE.test(name)) {
      throw new ConfigError('ACCESS_TOKENS names may only use letters, digits, "_" and "-" (max 40).');
    }
    if (!TOKEN_RE.test(token)) {
      throw new ConfigError(
        `ACCESS_TOKENS token for "${name}" must be 8-200 URL-safe characters (letters, digits, "_" or "-").`,
      );
    }
    if (seenNames.has(name)) throw new ConfigError(`ACCESS_TOKENS has a duplicate name: ${name}.`);
    if (seenTokens.has(token)) throw new ConfigError(`ACCESS_TOKENS reuses a token (see entry "${name}").`);
    seenNames.add(name);
    seenTokens.add(token);
    out.push({ name, token });
  }
  if (out.length === 0) throw new ConfigError('ACCESS_TOKENS has no entries.');
  return out;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, opts: { int?: boolean; min?: number } = {}): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`${key} must be a number.`);
  if (opts.int && !Number.isInteger(value)) throw new ConfigError(`${key} must be a whole number.`);
  if (opts.min !== undefined && value < opts.min) throw new ConfigError(`${key} must be at least ${opts.min}.`);
  return value;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false.`);
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL must be an absolute URL such as https://image-mcp.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('PUBLIC_BASE_URL must start with http:// or https://.');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new ConfigError('PUBLIC_BASE_URL must not contain credentials, a query string or a fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Baked-in fonts live next to src/ (and dist/) so the same relative path works under tsx and in Docker. */
export function defaultFontsDir(): string {
  return fileURLToPath(new URL('../fonts', import.meta.url));
}

/** Default home of the local data: `$MARKETING_IMAGES_HOME` or `~/.marketing-images`. */
export function localHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return path.resolve(optional(env, 'MARKETING_IMAGES_HOME') ?? path.join(homeDir, '.marketing-images'));
}

function parsePostiz(env: NodeJS.ProcessEnv, mode: RunMode): PostizSettings | null {
  const url = optional(env, 'POSTIZ_URL');
  const apiKey = optional(env, 'POSTIZ_API_KEY');
  if (!url && !apiKey) return null;
  if (!url) throw new ConfigError('POSTIZ_API_KEY is set but POSTIZ_URL is not (set both to enable the direct Postiz upload).');
  if (!apiKey) throw new ConfigError('POSTIZ_URL is set but POSTIZ_API_KEY is not (set both to enable the direct Postiz upload).');
  let apiBase: string;
  try {
    apiBase = normalizePostizBase(url);
  } catch (err) {
    throw new ConfigError(err instanceof PostizUrlError ? err.message : 'POSTIZ_URL is not valid.');
  }
  return {
    apiBase,
    apiKey,
    autoUpload: bool(env, 'POSTIZ_AUTO_UPLOAD', true),
    enabled: mode === 'stdio' || bool(env, 'POSTIZ_ALLOW_IN_HTTP', false),
  };
}

/** Folders from `LOCAL_IMAGE_DIRS`: separated by commas or by the platform delimiter; a leading `~` is the home folder. */
function parseLocalImageDirs(env: NodeJS.ProcessEnv, homeDir: string = os.homedir()): string[] {
  const raw = optional(env, 'LOCAL_IMAGE_DIRS');
  if (!raw) return [];
  const dirs: string[] = [];
  for (const entry of raw.split(new RegExp(`[,${path.delimiter}]`))) {
    let trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed === '~') trimmed = homeDir;
    else if (trimmed.startsWith('~/') || trimmed.startsWith(`~${path.sep}`)) trimmed = path.join(homeDir, trimmed.slice(2));
    if (!path.isAbsolute(trimmed)) throw new ConfigError(`LOCAL_IMAGE_DIRS entries must be absolute paths or start with ~/ (separated by commas or "${path.delimiter}").`);
    dirs.push(path.resolve(trimmed));
  }
  return dirs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): Config {
  const mode = options.mode ?? 'http';
  const port = num(env, 'PORT', 8080, { int: true, min: 0 });
  const nodeEnv = env.NODE_ENV?.trim() || 'production';
  const logLevel = (optional(env, 'LOG_LEVEL') ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError('LOG_LEVEL must be debug, info, warn or error.');

  const keys: Config['keys'] = {};
  const gemini = optional(env, 'GEMINI_API_KEY');
  const fal = optional(env, 'FAL_KEY');
  const leonardo = optional(env, 'LEONARDO_API_KEY');
  if (gemini) keys.gemini = gemini;
  if (fal) keys.fal = fal;
  if (leonardo) keys.leonardo = leonardo;

  const explicitBase = optional(env, 'PUBLIC_BASE_URL');
  const publicBaseUrl =
    mode === 'stdio' ? (explicitBase ? parseBaseUrl(explicitBase) : null) : parseBaseUrl(explicitBase ?? `http://localhost:${port || 8080}`);
  const fallbackDataDir = mode === 'stdio' || optional(env, 'MARKETING_IMAGES_HOME') ? localHome(env, options.homeDir) : '/data';

  return {
    mode,
    port,
    host: optional(env, 'HOST') ?? (nodeEnv === 'development' || nodeEnv === 'test' || mode === 'stdio' ? '127.0.0.1' : '0.0.0.0'),
    publicBaseUrl,
    dataDir: path.resolve(optional(env, 'DATA_DIR') ?? fallbackDataDir),
    fontsDir: path.resolve(optional(env, 'FONTS_DIR') ?? defaultFontsDir()),
    // stdio is a single local user: no access tokens (a shared .env may still contain them; they are ignored).
    accessTokens: mode === 'stdio' ? [] : parseAccessTokens(env.ACCESS_TOKENS),
    keys,
    retentionDays: num(env, 'RETENTION_DAYS', 30, { min: 1 }),
    limits: {
      dailyImages: num(env, 'DAILY_IMAGE_LIMIT', 30, { int: true, min: 0 }),
      dailyUsd: num(env, 'DAILY_USD_LIMIT', 3, { min: 0 }),
      dailyRenders: num(env, 'DAILY_RENDER_LIMIT', 200, { int: true, min: 0 }),
    },
    syncWaitMs: num(env, 'SYNC_WAIT_MS', 60_000, { int: true, min: 1000 }),
    nodeEnv,
    allowInsecureLocalhost: nodeEnv === 'test' || nodeEnv === 'development',
    logLevel,
    postiz: parsePostiz(env, mode),
    localImageDirs: mode === 'stdio' ? parseLocalImageDirs(env, options.homeDir) : [],
  };
}

/** Every secret value in the config, for log masking. */
export function configSecrets(config: Config): string[] {
  return [
    ...config.accessTokens.map((t) => t.token),
    ...Object.values(config.keys).filter((v): v is string => typeof v === 'string'),
    ...(config.postiz ? [config.postiz.apiKey] : []),
  ];
}
