import type { AppContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { Ledger, type LedgerLimits } from '../src/ledger.js';
import { createLogger, type Logger } from '../src/logger.js';
import { getModel, type ModelEntry } from '../src/models.js';
import { LocalStorage } from '../src/storage.js';
import type { AdapterDeps, AdapterRequest } from '../src/providers/types.js';
import { solidImage, tmpDir } from './helpers.js';

export const FAKE_KEYS = {
  gemini: 'fake-gemini-key-do-not-leak',
  fal: 'fake-fal-key-do-not-leak:secret',
  leonardo: 'fake-leonardo-key-do-not-leak',
} as const;

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export type Handler = (call: MockCall) => Response | undefined | Promise<Response | undefined>;

/** A scripted `fetch`: handlers are tried in order, the first that returns a Response wins. Nothing touches the network. */
export class MockFetch {
  readonly calls: MockCall[] = [];
  readonly unmocked: string[] = [];
  private readonly handlers: Handler[] = [];

  on(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  /** Answer calls whose URL contains `fragment` (and optionally a method) with a fixed response factory. */
  route(fragment: string, respond: (call: MockCall) => Response | Promise<Response>, method?: string): this {
    return this.on((call) => (call.url.includes(fragment) && (!method || call.method === method) ? respond(call) : undefined));
  }

  callsTo(fragment: string): MockCall[] {
    return this.calls.filter((c) => c.url.includes(fragment));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: MockCall = { url, method: init?.method ?? 'GET', headers, body };
    this.calls.push(call);
    for (const handler of this.handlers) {
      const response = await handler(call);
      if (response) return response;
    }
    this.unmocked.push(`${call.method} ${call.url}`);
    throw new TypeError(`unmocked request: ${call.method} ${call.url}`);
  };
}

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const imageResponse = (data: Buffer, type = 'image/png', status = 200): Response =>
  new Response(new Uint8Array(data), { status, headers: { 'content-type': type } });

let cachedPng: Buffer | undefined;
/** A small real PNG (so sharp can read it). */
export async function tinyPng(): Promise<Buffer> {
  cachedPng ??= await solidImage(64, 80, '#3366cc');
  return cachedPng;
}

export async function tinyPngBase64(): Promise<string> {
  return (await tinyPng()).toString('base64');
}

/** The model from the catalog, or a test failure. */
export function model(id: string): ModelEntry {
  const entry = getModel(id);
  if (!entry) throw new Error(`test uses an unknown model id: ${id}`);
  return entry;
}

export function request(modelId: string, over: Partial<AdapterRequest> = {}): AdapterRequest {
  return { task: 'generate', model: model(modelId), prompt: 'a red bicycle', ratio: '1:1', n: 1, images: [], ...over };
}

export function adapterDeps(mock: MockFetch, apiKey: string, over: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    apiKey,
    fetch: mock.fetch,
    loadImage: async () => ({ mime: 'image/png', base64: 'AAAA', bytes: 3 }),
    now: () => Date.now(),
    ...over,
  };
}

export interface TestHarness {
  ctx: AppContext;
  mock: MockFetch;
  ledger: Ledger;
  logs: string[];
  fetchedImages: string[];
  setNow(ms: number): void;
  cleanup(): void;
}

export const DAY = Date.UTC(2026, 9, 11, 12, 0, 0);

/**
 * A context for orchestrator/tool-level tests: real storage in a temp dir, in-memory ledger with a controllable
 * clock, scripted provider fetch, configurable keys and limits.
 */
export function makeHarness(
  options: { keys?: Partial<Record<'GEMINI_API_KEY' | 'FAL_KEY' | 'LEONARDO_API_KEY', string>>; limits?: Partial<LedgerLimits>; config?: Record<string, string> } = {},
): TestHarness {
  const { dir, cleanup } = tmpDir();
  const mock = new MockFetch();
  const logs: string[] = [];
  const fetchedImages: string[] = [];
  let now = DAY;
  const keys = options.keys ?? { GEMINI_API_KEY: FAKE_KEYS.gemini, FAL_KEY: FAKE_KEYS.fal, LEONARDO_API_KEY: FAKE_KEYS.leonardo };
  const config = loadConfig({
    ACCESS_TOKENS: 'alice:testtoken-0123456789abcdef,bob:othertoken-fedcba9876543210',
    PUBLIC_BASE_URL: 'https://images.example.test',
    DATA_DIR: dir,
    NODE_ENV: 'test',
    PORT: '0',
    ...keys,
    ...options.config,
  });
  const logger: Logger = createLogger({ sink: (line) => logs.push(line), secrets: Object.values(FAKE_KEYS) });
  const ledger = new Ledger(':memory:', { dailyImages: 30, dailyUsd: 3, dailyRenders: 200, ...options.limits }, () => now);
  const storage = new LocalStorage({ dataDir: dir, publicBaseUrl: config.publicBaseUrl, retentionDays: 30 });
  const ctx = {
    config,
    logger,
    storage,
    ledger,
    providerFetch: mock.fetch,
    fetchImage: async (url: string) => {
      fetchedImages.push(url);
      return tinyPng();
    },
  } as unknown as AppContext;
  return {
    ctx,
    mock,
    ledger,
    logs,
    fetchedImages,
    setNow: (ms) => {
      now = ms;
    },
    cleanup: () => {
      ledger.close();
      cleanup();
    },
  };
}
