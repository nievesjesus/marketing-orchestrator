import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from './logger.js';

/**
 * Environment configuration (DESIGN section 11). Secrets are read here and
 * nowhere else; error messages name the variable, never its value.
 */

export interface AccessToken {
  name: string;
  token: string;
}

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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

  return {
    port,
    host: optional(env, 'HOST') ?? (nodeEnv === 'development' || nodeEnv === 'test' ? '127.0.0.1' : '0.0.0.0'),
    publicBaseUrl: parseBaseUrl(optional(env, 'PUBLIC_BASE_URL') ?? `http://localhost:${port || 8080}`),
    dataDir: path.resolve(optional(env, 'DATA_DIR') ?? '/data'),
    fontsDir: path.resolve(optional(env, 'FONTS_DIR') ?? defaultFontsDir()),
    accessTokens: parseAccessTokens(env.ACCESS_TOKENS),
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
  };
}

/** Every secret value in the config, for log masking. */
export function configSecrets(config: Config): string[] {
  return [
    ...config.accessTokens.map((t) => t.token),
    ...Object.values(config.keys).filter((v): v is string => typeof v === 'string'),
  ];
}
