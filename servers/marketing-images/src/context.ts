import path from 'node:path';
import type { Config } from './config.js';
import { TokenAuth } from './auth.js';
import { BrandStore } from './brands-store.js';
import { fetchSafe } from './fetchsafe.js';
import { Ledger } from './ledger.js';
import type { Logger } from './logger.js';
import { FontRegistry } from './render/fonts.js';
import { LocalStorage, type Storage } from './storage.js';
import { TemplateStore } from './templates-store.js';

/** Everything the HTTP layer and the tools share. Built once at startup; tests build one with overrides. */
export interface AppContext {
  config: Config;
  logger: Logger;
  auth: TokenAuth;
  storage: Storage;
  ledger: Ledger;
  fonts: FontRegistry;
  /** Saved templates (own SQLite connection to `app.db`). */
  templates: TemplateStore;
  /** Saved brands (own SQLite connection to `app.db`). */
  brands: BrandStore;
  /** Download a user-supplied image through the SSRF guard (`svg: true` also accepts SVG: brand logos only). */
  fetchImage(url: string, opts?: { svg?: boolean }): Promise<Buffer>;
  /** Download a TTF/OTF font through the SSRF guard (WOFF/WOFF2 are rejected with a clear message). */
  fetchFont(url: string): Promise<Buffer>;
  /** Outbound HTTP for the image providers (tests replace it; defaults to the global fetch). */
  providerFetch: typeof fetch;
}

export type ContextOverrides = Partial<
  Pick<AppContext, 'storage' | 'ledger' | 'fetchImage' | 'fetchFont' | 'fonts' | 'templates' | 'brands' | 'providerFetch'>
>;

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
    templates: overrides.templates ?? new TemplateStore(path.join(config.dataDir, 'app.db')),
    brands: overrides.brands ?? new BrandStore(path.join(config.dataDir, 'app.db')),
    fetchImage:
      overrides.fetchImage ??
      (async (url, opts) => (await fetchSafe(url, { kind: 'image', allowInsecureLocalhost: config.allowInsecureLocalhost, allowSvg: opts?.svg === true })).data),
    fetchFont:
      overrides.fetchFont ??
      (async (url) => (await fetchSafe(url, { kind: 'font', maxBytes: 8 * 1024 * 1024, allowInsecureLocalhost: config.allowInsecureLocalhost })).data),
    providerFetch: overrides.providerFetch ?? ((input, init) => fetch(input, init)),
  };
}
