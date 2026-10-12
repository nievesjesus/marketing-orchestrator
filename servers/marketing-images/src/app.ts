import { mkdirSync } from 'node:fs';
// Stdio serving in the MCP SDK v2: `serveStdio(factory)` from `@modelcontextprotocol/server/stdio` owns the
// StdioServerTransport (v1's `server.connect(new StdioServerTransport())` is replaced by it).
// Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.md ("stdout is the JSON-RPC channel": log to stderr only).
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, LOCAL_USER, configSecrets, loadConfig, type Config, type RunMode } from './config.js';
import { createContext, type AppContext } from './context.js';
import { createLogger, serializeError, stderrSink, type Logger } from './logger.js';
import { createMcpServer } from './mcp.js';
import { isLoopbackHost } from './postiz-url.js';
import { createHttpServer } from './server.js';
import { VERSION } from './version.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RunOptions {
  mode: RunMode;
  env: NodeJS.ProcessEnv;
  /** The env file that was loaded (for the startup log): path and variable NAMES only. */
  envFile?: { file: string | null; names: string[] };
}

/** Retention sweep (DESIGN section 4): once at startup, then hourly. Returns the timer (unref'd). */
function startSweeps(ctx: AppContext, logger: Logger): NodeJS.Timeout {
  const sweep = (): void => {
    ctx.storage
      .sweep()
      .then((r) => {
        if (r.deleted > 0) logger.info('retention_sweep', { deleted: r.deleted, bytes: r.bytes });
      })
      .catch((err: unknown) => logger.warn('retention_sweep_failed', serializeError(err)));
    try {
      ctx.owners.prune(ctx.config.retentionDays * DAY_MS + DAY_MS);
    } catch (err) {
      logger.warn('owners_prune_failed', serializeError(err));
    }
    // Reservations older than an hour belong to crashed requests: give the budget back.
    const refunded = ctx.ledger.expireReservations(HOUR_MS);
    if (refunded > 0) logger.info('reservations_expired', { count: refunded });
    // Jobs nobody collected within 24 h expire and their reservation is refunded (DESIGN section 8).
    const jobs = ctx.ledger.expireJobs(DAY_MS);
    if (jobs.expired > 0 || jobs.deleted > 0) logger.info('jobs_expired', jobs);
  };
  sweep();
  const timer = setInterval(sweep, HOUR_MS);
  timer.unref();
  return timer;
}

function closeStores(ctx: AppContext): void {
  ctx.ledger.close();
  ctx.templates.close();
  ctx.brands.close();
  ctx.owners.close();
}

function providerFlags(config: Config): Record<string, boolean> {
  return Object.fromEntries(['gemini', 'fal', 'leonardo'].map((p) => [p, Boolean(config.keys[p as keyof typeof config.keys])]));
}

function postizSummary(config: Config): Record<string, unknown> {
  if (!config.postiz) return { configured: false };
  return {
    configured: true,
    enabled: config.postiz.enabled,
    auto_upload: config.postiz.autoUpload,
    host: new URL(config.postiz.apiBase).host,
  };
}

function postizWarnings(config: Config, logger: Logger): void {
  const postiz = config.postiz;
  if (!postiz) return;
  if (!postiz.enabled) {
    logger.warn('postiz_ignored_in_http', {
      hint: 'POSTIZ_URL/POSTIZ_API_KEY are ignored in HTTP mode: the Postiz key belongs to one account, not to every user of this server. Set POSTIZ_ALLOW_IN_HTTP=true only for a single-tenant deployment.',
    });
    return;
  }
  const url = new URL(postiz.apiBase);
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    logger.warn('postiz_not_https', { host: url.host, hint: 'the Postiz API key would travel unencrypted; use an https:// POSTIZ_URL' });
  }
}

export async function runServer(options: RunOptions): Promise<void> {
  const config = loadConfig(options.env, { mode: options.mode });
  const stdio = config.mode === 'stdio';
  // In stdio mode stdout is the protocol channel: nothing else may write to it, so logs go to stderr and any stray
  // console.log/info/debug is redirected there too.
  if (stdio) {
    console.log = console.error;
    console.info = console.error;
    console.debug = console.error;
  }
  const logger = createLogger({ level: config.logLevel, secrets: configSecrets(config), ...(stdio ? { sink: stderrSink } : {}) });

  // The data directory holds the database (brands, quota) and every image: private to the user in local mode.
  mkdirSync(config.dataDir, { recursive: true, ...(stdio ? { mode: 0o700 } : {}) });
  const ctx = createContext(config, logger);
  const timer = startSweeps(ctx, logger);

  let stopping = false;
  let closeServer: () => Promise<void> = async () => undefined;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting_down', { signal });
    clearInterval(timer);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    closeServer()
      .catch((err: unknown) => logger.error('shutdown_error', serializeError(err)))
      .finally(() => {
        closeStores(ctx);
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  if (stdio) {
    const handle = serveStdio(() => createMcpServer(ctx, LOCAL_USER), {
      onerror: (err) => logger.warn('mcp_stdio_error', serializeError(err)),
    });
    closeServer = () => handle.close();
    // The client closing its end of the pipe is the normal way to stop a stdio server.
    process.stdin.once('end', () => stop('stdin_closed'));
    logger.info('server_started', {
      version: VERSION,
      mode: 'stdio',
      data_dir: config.dataDir,
      url_style: config.publicBaseUrl ? 'public_base_url' : 'file',
      providers: providerFlags(config),
      postiz: postizSummary(config),
      env_file: options.envFile?.file ?? null,
      env_file_variables: options.envFile?.names.length ?? 0,
      retention_days: config.retentionDays,
    });
    postizWarnings(config, logger);
    return;
  }

  const { server, close } = createHttpServer(ctx);
  closeServer = close;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  logger.info('server_started', {
    version: VERSION,
    mode: 'http',
    host: config.host,
    port: config.port,
    public_base_url: config.publicBaseUrl,
    users: config.accessTokens.map((t) => t.name),
    providers: providerFlags(config),
    postiz: postizSummary(config),
    retention_days: config.retentionDays,
  });
  for (const t of config.accessTokens) {
    if (t.token.length < 32) logger.warn('weak_access_token', { user: t.name, hint: 'use `openssl rand -hex 24`' });
  }
  if (config.nodeEnv === 'production' && !config.publicBaseUrl?.startsWith('https://')) {
    logger.warn('public_base_url_not_https', { hint: 'image links handed to Postiz should be https' });
  }
  postizWarnings(config, logger);
}

/** Last-resort handler for startup failures: message on stderr (never stdout), exit code 1. */
export function reportFatal(err: unknown): never {
  if (err instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${err.message}\n`);
  } else {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}
