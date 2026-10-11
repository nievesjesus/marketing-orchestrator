import path from 'node:path';
import type { Config } from './config.js';
import { TokenAuth } from './auth.js';
import { fetchSafe } from './fetchsafe.js';
import { Ledger } from './ledger.js';
import type { Logger } from './logger.js';
import { FontRegistry } from './render/fonts.js';
import { LocalStorage, type Storage } from './storage.js';

/** Everything the HTTP layer and the tools share. Built once at startup; tests build one with overrides. */
export interface AppContext {
  config: Config;
  logger: Logger;
  auth: TokenAuth;
  storage: Storage;
  ledger: Ledger;
  fonts: FontRegistry;
  /** Download a user-supplied image through the SSRF guard. */
  fetchImage(url: string): Promise<Buffer>;
}

export type ContextOverrides = Partial<Pick<AppContext, 'storage' | 'ledger' | 'fetchImage' | 'fonts'>>;

export function createContext(config: Config, logger: Logger, overrides: ContextOverrides = {}): AppContext {
  return {
    config,
    logger,
    auth: new TokenAuth(config.accessTokens),
    storage:
      overrides.storage ??
      new LocalStorage({ dataDir: config.dataDir, publicBaseUrl: config.publicBaseUrl, retentionDays: config.retentionDays }),
    ledger:
      overrides.ledger ??
      new Ledger(path.join(config.dataDir, 'app.db'), {
        dailyImages: config.limits.dailyImages,
        dailyUsd: config.limits.dailyUsd,
        dailyRenders: config.limits.dailyRenders,
      }),
    fonts: overrides.fonts ?? new FontRegistry(config.fontsDir),
    fetchImage:
      overrides.fetchImage ??
      (async (url) => (await fetchSafe(url, { kind: 'image', allowInsecureLocalhost: config.allowInsecureLocalhost })).data),
  };
}
