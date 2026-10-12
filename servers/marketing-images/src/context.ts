import path from 'node:path';
import type { Config } from './config.js';
import { TokenAuth } from './auth.js';
import { BrandStore } from './brands-store.js';
import { fetchSafe } from './fetchsafe.js';
import { ImageOwners } from './image-owners.js';
import { Ledger } from './ledger.js';
import { createLocalFiles, type LocalFiles } from './localfiles.js';
import type { Logger } from './logger.js';
import { PostizClient } from './postiz.js';
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
  /** Which user made which stored image, and the Postiz copy of it (own SQLite connection to `app.db`). */
  owners: ImageOwners;
  /** Direct Postiz upload; null when it is not configured (or HTTP mode without POSTIZ_ALLOW_IN_HTTP). */
  postiz: PostizClient | null;
  /** Reads `file://` references from allowed local folders; null in HTTP mode. */
  localFiles: LocalFiles | null;
  /** Download a user-supplied image through the SSRF guard (`svg: true` also accepts SVG: brand logos only). */
  fetchImage(url: string, opts?: { svg?: boolean }): Promise<Buffer>;
  /** Download a TTF/OTF font through the SSRF guard (WOFF/WOFF2 are rejected with a clear message). */
  fetchFont(url: string): Promise<Buffer>;
  /** Outbound HTTP for the image providers (tests replace it; defaults to the global fetch). */
  providerFetch: typeof fetch;
}

export type ContextOverrides = Partial<
  Pick<AppContext, 'storage' | 'ledger' | 'fetchImage' | 'fetchFont' | 'fonts' | 'templates' | 'brands' | 'owners' | 'postiz' | 'localFiles' | 'providerFetch'>
> & {
  /** Replaces the global fetch used by the Postiz client built from the config (tests). */
  postizFetch?: typeof fetch;
};

export function createContext(config: Config, logger: Logger, overrides: ContextOverrides = {}): AppContext {
  const localFiles =
    overrides.localFiles !== undefined
      ? overrides.localFiles
      : config.mode === 'stdio'
        ? createLocalFiles({ roots: [path.join(path.resolve(config.dataDir), 'images'), ...config.localImageDirs] })
        : null;
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
    owners: overrides.owners ?? new ImageOwners(path.join(config.dataDir, 'app.db')),
    postiz:
      overrides.postiz !== undefined
        ? overrides.postiz
        : config.postiz?.enabled
          ? new PostizClient(config.postiz, overrides.postizFetch ? { fetch: overrides.postizFetch } : {})
          : null,
    localFiles,
    fetchImage:
      overrides.fetchImage ??
      (async (url, opts) =>
        localFiles?.isLocalRef(url)
          ? localFiles.read(url, { kind: 'image', allowSvg: opts?.svg === true })
          : (await fetchSafe(url, { kind: 'image', allowInsecureLocalhost: config.allowInsecureLocalhost, allowSvg: opts?.svg === true })).data),
    fetchFont:
      overrides.fetchFont ??
      (async (url) =>
        localFiles?.isLocalRef(url)
          ? localFiles.read(url, { kind: 'font' })
          : (await fetchSafe(url, { kind: 'font', maxBytes: 8 * 1024 * 1024, allowInsecureLocalhost: config.allowInsecureLocalhost })).data),
    providerFetch: overrides.providerFetch ?? ((input, init) => fetch(input, init)),
  };
}
