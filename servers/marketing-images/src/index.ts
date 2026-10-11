import { mkdirSync } from 'node:fs';
import { ConfigError, configSecrets, loadConfig } from './config.js';
import { createContext } from './context.js';
import { createLogger, serializeError } from './logger.js';
import { createHttpServer } from './server.js';
import { VERSION } from './version.js';

const HOUR_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, secrets: configSecrets(config) });

  mkdirSync(config.dataDir, { recursive: true });
  const ctx = createContext(config, logger);
  const { server, close } = createHttpServer(ctx);

  // Retention sweep (DESIGN section 4): once at startup, then hourly.
  const sweep = (): void => {
    ctx.storage
      .sweep()
      .then((r) => {
        if (r.deleted > 0) logger.info('retention_sweep', { deleted: r.deleted, bytes: r.bytes });
      })
      .catch((err: unknown) => logger.warn('retention_sweep_failed', serializeError(err)));
    // Reservations older than an hour belong to crashed requests: give the budget back.
    const refunded = ctx.ledger.expireReservations(HOUR_MS);
    if (refunded > 0) logger.info('reservations_expired', { count: refunded });
    // Jobs nobody collected within 24 h expire and their reservation is refunded (DESIGN section 8).
    const jobs = ctx.ledger.expireJobs(24 * HOUR_MS);
    if (jobs.expired > 0 || jobs.deleted > 0) logger.info('jobs_expired', jobs);
  };
  sweep();
  const timer = setInterval(sweep, HOUR_MS);
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  logger.info('server_started', {
    version: VERSION,
    host: config.host,
    port: config.port,
    public_base_url: config.publicBaseUrl,
    users: config.accessTokens.map((t) => t.name),
    providers: Object.fromEntries(['gemini', 'fal', 'leonardo'].map((p) => [p, Boolean(config.keys[p as keyof typeof config.keys])])),
    retention_days: config.retentionDays,
  });
  for (const t of config.accessTokens) {
    if (t.token.length < 32) logger.warn('weak_access_token', { user: t.name, hint: 'use `openssl rand -hex 24`' });
  }
  if (config.nodeEnv === 'production' && !config.publicBaseUrl.startsWith('https://')) {
    logger.warn('public_base_url_not_https', { hint: 'image links handed to Postiz should be https' });
  }

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting_down', { signal });
    clearInterval(timer);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    close()
      .catch((err: unknown) => logger.error('shutdown_error', serializeError(err)))
      .finally(() => {
        ctx.ledger.close();
        ctx.templates.close();
        ctx.brands.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${err.message}\n`);
  } else {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
