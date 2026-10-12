import { parseArgs } from 'node:util';

/**
 * Command line of `marketing-images`:
 *
 *   marketing-images [--stdio | --http] [--port N] [--env PATH] [--data-dir PATH] [--help] [--version]
 *
 * No transport flag means stdio, the mode an MCP client launches (`npx -y @codeame/marketing-images`).
 */

export type CliMode = 'stdio' | 'http';

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; mode: CliMode; port?: number; envFile?: string; dataDir?: string };

export class CliUsageError extends Error {
  override readonly name = 'CliUsageError';
}

export const USAGE = `marketing-images: MCP server for social-media graphics (AI images + exact-text post composer)

Usage:
  marketing-images [--stdio | --http] [--port N] [--env PATH] [--data-dir PATH]
  marketing-images --help | --version

Options:
  --stdio            Serve one MCP client over stdin/stdout (default). No access token; images are stored on this
                     computer and tool results include a local file_path.
  --http             Serve MCP over Streamable HTTP at /mcp/<token> (ACCESS_TOKENS required), images at /i/*.
  --port N           HTTP port (default 8080, or $PORT). Only with --http.
  --env PATH         Load settings from this file. Default: $XDG_CONFIG_HOME/marketing-images/.env, then
                     ~/.config/marketing-images/.env, when present. Real environment variables win over the file.
  --data-dir PATH    Where the database and images live (default: $DATA_DIR, else $MARKETING_IMAGES_HOME,
                     else ~/.marketing-images).
  -h, --help         Show this help.
  -v, --version      Show the version.

Settings (environment or env file; see .env.example in the package repository for every variable):
  GEMINI_API_KEY, FAL_KEY, LEONARDO_API_KEY   Image providers (a missing key disables that provider)
  POSTIZ_URL, POSTIZ_API_KEY                  Also upload final graphics (compose_*) to Postiz (optional)
  LOCAL_IMAGE_DIRS                            Folders your own photos may be read from (file:// links)
  PUBLIC_BASE_URL, RETENTION_DAYS, DAILY_IMAGE_LIMIT, DAILY_USD_LIMIT, DAILY_RENDER_LIMIT, LOG_LEVEL
  ACCESS_TOKENS                               HTTP mode only: name:token,name:token

In stdio mode stdout carries only MCP messages; logs go to stderr.
`;

export function parseCliArgs(argv: readonly string[]): CliCommand {
  let values: {
    stdio?: boolean | undefined;
    http?: boolean | undefined;
    port?: string | undefined;
    env?: string | undefined;
    'data-dir'?: string | undefined;
    help?: boolean | undefined;
    version?: boolean | undefined;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        stdio: { type: 'boolean' },
        http: { type: 'boolean' },
        port: { type: 'string' },
        env: { type: 'string' },
        'data-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : 'Invalid arguments.');
  }

  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };
  if (positionals.length > 0) throw new CliUsageError(`Unexpected argument: ${positionals[0]}`);
  if (values.stdio && values.http) throw new CliUsageError('Choose one of --stdio or --http, not both.');
  const mode: CliMode = values.http ? 'http' : 'stdio';

  const command: CliCommand = { kind: 'run', mode };
  if (values.port !== undefined) {
    if (mode !== 'http') throw new CliUsageError('--port only applies with --http.');
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) throw new CliUsageError('--port must be a whole number from 0 to 65535.');
    command.port = Number(values.port);
  }
  for (const [flag, key] of [['env', 'envFile'], ['data-dir', 'dataDir']] as const) {
    const value = values[flag];
    if (value === undefined) continue;
    if (value.trim() === '') throw new CliUsageError(`--${flag} needs a path.`);
    command[key] = value;
  }
  return command;
}
