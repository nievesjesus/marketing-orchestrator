import { existsSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Environment loading for the CLI. The server reads its configuration from environment variables; for a local
 * install it is more comfortable to keep them in a file the MCP client does not need to know about:
 *
 *   1. `--env PATH` (must exist), else the first of
 *   2. `$XDG_CONFIG_HOME/marketing-images/.env`
 *   3. `~/.config/marketing-images/.env`
 *
 * Variables already set in the process environment always win over the file (so an MCP client's `env` block can
 * override one value). An EMPTY variable counts as unset. The file uses the dotenv syntax understood by Node's
 * `util.parseEnv` (KEY=value, quotes, `#` comments, optional `export`).
 *
 * The file holds API keys, so a group- or world-accessible file only produces a warning (recommending `chmod 600`).
 * Values are never logged or put in error messages: only the path and the permission bits are.
 */

export class EnvFileError extends Error {
  override readonly name = 'EnvFileError';
}

export interface LoadEnvOptions {
  /** `--env` value. */
  envFile?: string | undefined;
  processEnv: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Receives human-readable warnings (stderr in the CLI). Never receives values. */
  warn?: (message: string) => void;
}

export interface LoadedEnv {
  env: NodeJS.ProcessEnv;
  /** The file that was read, or null. */
  file: string | null;
  /** Names (never values) of the variables the file defined. */
  names: string[];
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith(`~${path.sep}`)) return path.join(home, p.slice(2));
  return p;
}

/** Default locations, in order of preference. */
export function defaultEnvFiles(processEnv: NodeJS.ProcessEnv, home: string = os.homedir()): string[] {
  const out: string[] = [];
  const xdg = processEnv.XDG_CONFIG_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) out.push(path.join(xdg, 'marketing-images', '.env'));
  out.push(path.join(home, '.config', 'marketing-images', '.env'));
  return [...new Set(out)];
}

export function loadEnv(options: LoadEnvOptions): LoadedEnv {
  const home = options.homeDir ?? os.homedir();
  const warn = options.warn ?? (() => undefined);
  const platform = options.platform ?? process.platform;

  let file: string | null = null;
  if (options.envFile) {
    file = path.resolve(expandHome(options.envFile, home));
    if (!existsSync(file) || !statSync(file).isFile()) throw new EnvFileError(`The env file was not found: ${file}`);
  } else {
    file = defaultEnvFiles(options.processEnv, home).find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
  }
  if (!file) return { env: { ...options.processEnv }, file: null, names: [] };

  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    throw new EnvFileError(`The env file could not be read: ${file}`);
  }
  if (platform !== 'win32') {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warn(`warning: ${file} can be read by other users (mode ${mode.toString(8).padStart(3, '0')}) and it holds API keys. Run: chmod 600 "${file}"`);
    }
  }

  const parsed = parseEnv(content);
  const fromFile: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') fromFile[key] = value;

  const env: NodeJS.ProcessEnv = { ...fromFile };
  for (const [key, value] of Object.entries(options.processEnv)) {
    if (value !== undefined && value !== '') env[key] = value;
    else if (!(key in env)) env[key] = value;
  }
  return { env, file, names: Object.keys(fromFile) };
}
