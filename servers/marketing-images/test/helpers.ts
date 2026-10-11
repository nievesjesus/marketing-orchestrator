import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createContext, type AppContext, type ContextOverrides } from '../src/context.js';
import { defaultFontsDir, loadConfig, type Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createHttpServer } from '../src/server.js';
import { FontRegistry } from '../src/render/fonts.js';

export const TEST_TOKEN = 'testtoken-0123456789abcdef';
export const OTHER_TOKEN = 'othertoken-fedcba9876543210';

let sharedFonts: FontRegistry | undefined;
/** Parsing the bundled fonts takes a moment; share one registry per test file. */
export function fonts(): FontRegistry {
  sharedFonts ??= new FontRegistry(defaultFontsDir());
  return sharedFonts;
}

export function tmpDir(prefix = 'mi-test-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dataDir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    ACCESS_TOKENS: `alice:${TEST_TOKEN},bob:${OTHER_TOKEN}`,
    PUBLIC_BASE_URL: 'https://images.example.test',
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
    PORT: '0',
    ...extra,
  });
}

/**
 * A photo-like background generated locally (no network): a smooth multi-color gradient, soft blurred shapes
 * (a bright "sun", dark "hills") and light deterministic noise. No hard edges, so any visible edge in a render
 * comes from the code under test, not from the picture.
 */
export async function makePhoto(width = 1600, height = 1200, palette: [string, string] = ['#e9d5a1', '#6b8f71']): Promise<Buffer> {
  const blur = (id: string, sigma: number): string =>
    `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${Math.round(sigma)}"/></filter>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[0]}"/><stop offset="0.5" stop-color="#c9a27a"/><stop offset="1" stop-color="${palette[1]}"/></linearGradient>
      ${blur('b1', height * 0.05)}${blur('b2', height * 0.09)}
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.72}" cy="${height * 0.28}" r="${height * 0.2}" fill="#fff1c9" filter="url(#b1)"/>
    <ellipse cx="${width * 0.25}" cy="${height * 0.82}" rx="${width * 0.5}" ry="${height * 0.2}" fill="#3f5a4a" opacity="0.75" filter="url(#b2)"/>
    <ellipse cx="${width * 0.82}" cy="${height * 0.92}" rx="${width * 0.45}" ry="${height * 0.18}" fill="#2f4a5c" opacity="0.65" filter="url(#b2)"/>
  </svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let seed = 20261011; // deterministic noise, about +/-4 levels, like sensor grain
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = Math.max(0, Math.min(255, (data[i] as number) + ((seed >>> 24) % 9) - 4));
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

export async function makeLogo(fill = '#14213d', text = '#fca311'): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="140"><rect width="400" height="140" rx="30" fill="${fill}"/><text x="200" y="92" font-size="60" text-anchor="middle" fill="${text}" font-family="Arial">LOGO</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function solidImage(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

export interface TestServer {
  url: string;
  ctx: AppContext;
  logs: Record<string, unknown>[];
  rawLogs: string[];
  close(): Promise<void>;
}

export async function startTestServer(opts: { configExtra?: Record<string, string>; overrides?: ContextOverrides } = {}): Promise<TestServer & { dataDir: string }> {
  const { dir, cleanup } = tmpDir();
  const config = testConfig(dir, opts.configExtra);
  const rawLogs: string[] = [];
  const logger = createLogger({ sink: (line) => rawLogs.push(line), secrets: [TEST_TOKEN, OTHER_TOKEN] });
  const ctx = createContext(config, logger, {
    fonts: fonts(),
    fetchImage: async () => makePhoto(),
    ...opts.overrides,
  });
  const running = createHttpServer(ctx);
  await new Promise<void>((resolve) => running.server.listen(0, '127.0.0.1', resolve));
  const { port } = running.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    ctx,
    dataDir: dir,
    rawLogs,
    get logs() {
      return rawLogs.map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    async close() {
      await running.close();
      ctx.ledger.close();
      cleanup();
    },
  };
}

/** Raw HTTP request that does NOT normalize the path (fetch would collapse `..`). */
export function rawRequest(baseUrl: string, method: string, rawPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: rawPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

export interface RpcResult {
  status: number;
  json: { result?: any; error?: any; id?: unknown };
}

/** One stateless MCP JSON-RPC call over Streamable HTTP; handles JSON or SSE responses. */
export async function rpc(baseUrl: string, token: string, method: string, params?: unknown, id = 1): Promise<RpcResult> {
  const res = await fetch(`${baseUrl}/mcp/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = dataLine ? dataLine.slice(6) : text;
  return { status: res.status, json: payload ? JSON.parse(payload) : {} };
}

export async function initialize(baseUrl: string, token: string): Promise<RpcResult> {
  return rpc(baseUrl, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0' },
  });
}

export async function callTool(baseUrl: string, token: string, name: string, args: unknown): Promise<{ isError?: boolean; content: any[]; structuredContent?: unknown }> {
  const res = await rpc(baseUrl, token, 'tools/call', { name, arguments: args }, 7);
  if (res.json.error) throw new Error(`rpc error: ${JSON.stringify(res.json.error)}`);
  return res.json.result;
}

export interface Pixels {
  data: Buffer;
  width: number;
  height: number;
}

export async function pixels(image: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export function pixelAt(p: Pixels, x: number, y: number): [number, number, number] {
  const i = (y * p.width + x) * 3;
  return [p.data[i] as number, p.data[i + 1] as number, p.data[i + 2] as number];
}

/** Mean 0..255 luma over a rectangle. */
export function meanLuma(p: Pixels, x: number, y: number, w: number, h: number): number {
  let sum = 0;
  let n = 0;
  for (let yy = y; yy < y + h; yy += 2) {
    for (let xx = x; xx < x + w; xx += 2) {
      const [r, g, b] = pixelAt(p, xx, yy);
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
      n += 1;
    }
  }
  return sum / n;
}

/** Bounding box of the pixels that differ between two same-sized images (null when identical). */
export function diffBox(a: Pixels, b: Pixels, tolerance = 0): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const i = (y * a.width + x) * 3;
      if (
        Math.abs((a.data[i] as number) - (b.data[i] as number)) > tolerance ||
        Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) > tolerance ||
        Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)) > tolerance
      ) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Left half red, right half blue (to check cover-cropping without stretching). */
export function splitImage(width: number, height: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width / 2}" height="${height}" fill="#ff0000"/><rect x="${width / 2}" width="${width / 2}" height="${height}" fill="#0000ff"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Black/white checkerboard: a worst-case busy photo for contrast tests. */
export function checkerboard(width: number, height: number, cell = 16): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 255 : 0;
      const i = (y * width + x) * 3;
      raw[i] = raw[i + 1] = raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
