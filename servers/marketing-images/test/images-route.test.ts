import { mkdirSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from '../src/storage.js';
import { rawRequest, solidImage, startTestServer, tmpDir } from './helpers.js';

describe('GET /i/*', () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let key: string;
  let png: Buffer;

  beforeAll(async () => {
    server = await startTestServer();
    png = await solidImage(64, 64, '#336699');
    key = (await server.ctx.storage.put(png, 'png')).key;
    // A secret next to the images that must never be reachable.
    writeFileSync(path.join(server.dataDir, 'app.secret'), 'TOP-SECRET');
  });
  afterAll(async () => {
    await server.close();
  });

  it('serves a stored image with immutable cache headers', async () => {
    const res = await rawRequest(server.url, 'GET', `/i/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(res.headers['content-length'])).toBe(png.length);
    expect(res.body.equals(png)).toBe(true);
  });

  it('supports HEAD without a body', async () => {
    const res = await rawRequest(server.url, 'HEAD', `/i/${key}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
    expect(res.headers['content-length']).toBe(String(png.length));
  });

  it('does not serve images with other methods', async () => {
    expect((await rawRequest(server.url, 'POST', `/i/${key}`)).status).toBe(405);
  });

  it('has no directory listing', async () => {
    const [yyyy, mm] = key.split('/');
    for (const p of ['/i/', '/i', `/i/${yyyy}`, `/i/${yyyy}/`, `/i/${yyyy}/${mm}`, `/i/${yyyy}/${mm}/`]) {
      const res = await rawRequest(server.url, 'GET', p);
      expect(res.status, p).toBe(404);
      expect(res.body.toString()).toBe('Not found');
    }
  });

  it.each([
    '/i/../app.secret',
    '/i/../../etc/passwd',
    '/i/%2e%2e/app.secret',
    '/i/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/i/2026/10/../../app.secret',
    '/i/2026/10/..%2f..%2fapp.secret',
    '/i/..%5c..%5capp.secret',
    '/i/2026/10/%2e%2e/%2e%2e/app.secret',
    '/i/%00',
    '/i/2026/10/\u0000.png',
    '/i//etc/passwd',
    '/i/....//app.secret',
    '/i/%252e%252e/app.secret',
    '/i/app.db',
    '/i/2026/10/not-a-uuid.png',
    '/i/2026/10/00000000-0000-0000-0000-000000000000.png', // well-formed but absent
  ])('path traversal / junk is refused: %s', async (p) => {
    const res = await rawRequest(server.url, 'GET', encodeURI(p).replace(/%25/g, '%'));
    expect(res.status).toBe(404);
    expect(res.body.toString()).not.toContain('TOP-SECRET');
  });

  it('only png/jpg files with uuid names are ever served', async () => {
    const dir = path.join(server.dataDir, 'images', '2026', '10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'readme.txt'), 'plain');
    writeFileSync(path.join(dir, '11111111-1111-1111-1111-111111111111.svg'), '<svg/>');
    writeFileSync(path.join(dir, '11111111-1111-1111-1111-111111111111.html'), '<html/>');
    for (const name of ['readme.txt', '11111111-1111-1111-1111-111111111111.svg', '11111111-1111-1111-1111-111111111111.html']) {
      expect((await rawRequest(server.url, 'GET', `/i/2026/10/${name}`)).status, name).toBe(404);
    }
  });

  it('refuses a symlink that escapes the images directory', async () => {
    const dir = path.join(server.dataDir, 'images', '2026', '10');
    mkdirSync(dir, { recursive: true });
    const name = '22222222-2222-2222-2222-222222222222.png';
    symlinkSync(path.join(server.dataDir, 'app.secret'), path.join(dir, name));
    const res = await rawRequest(server.url, 'GET', `/i/2026/10/${name}`);
    expect(res.status).toBe(404);
    expect(res.body.toString()).not.toContain('TOP-SECRET');
  });
});

describe('LocalStorage', () => {
  it('stores under images/{yyyy}/{mm}/{uuid}.{ext} and returns PUBLIC_BASE_URL/i/...', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const storage = new LocalStorage({ dataDir: dir, publicBaseUrl: 'https://img.example.test', retentionDays: 30, now: () => Date.UTC(2026, 9, 11) });
      const a = await storage.put(Buffer.from('a'), 'png');
      const b = await storage.put(Buffer.from('b'), 'jpg');
      expect(a.key).toMatch(/^2026\/10\/[0-9a-f-]{36}\.png$/);
      expect(b.key).toMatch(/^2026\/10\/[0-9a-f-]{36}\.jpg$/);
      expect(a.url).toBe(`https://img.example.test/i/${a.key}`);
      expect(a.contentType).toBe('image/png');
      expect(b.contentType).toBe('image/jpeg');
      expect(a.key).not.toBe(b.key);
      expect(existsSync(path.join(dir, 'images', a.key))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('the retention sweep deletes files older than RETENTION_DAYS, keeps recent ones and prunes empty folders', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const NOW = Date.UTC(2026, 9, 11, 12);
      const storage = new LocalStorage({ dataDir: dir, publicBaseUrl: 'https://img.example.test', retentionDays: 30, now: () => NOW });
      const old = await storage.put(Buffer.from('old'), 'png');
      const fresh = await storage.put(Buffer.from('fresh'), 'jpg');
      const borderline = await storage.put(Buffer.from('border'), 'png');
      const day = 24 * 60 * 60;
      utimesSync(path.join(dir, 'images', old.key), NOW / 1000 - 31 * day, NOW / 1000 - 31 * day);
      utimesSync(path.join(dir, 'images', borderline.key), NOW / 1000 - 29 * day, NOW / 1000 - 29 * day);

      // a stale temp file from a crashed write, and an unrelated file that must be left alone
      const monthDir = path.join(dir, 'images', '2026', '10');
      const tmp = path.join(monthDir, '.tmp-33333333-3333-3333-3333-333333333333');
      writeFileSync(tmp, 'x');
      utimesSync(tmp, NOW / 1000 - 3 * 3600, NOW / 1000 - 3 * 3600);
      writeFileSync(path.join(monthDir, 'keep.txt'), 'x');

      const result = await storage.sweep();
      expect(result.deleted).toBe(2);
      expect(existsSync(path.join(dir, 'images', old.key))).toBe(false);
      expect(existsSync(tmp)).toBe(false);
      expect(existsSync(path.join(dir, 'images', fresh.key))).toBe(true);
      expect(existsSync(path.join(dir, 'images', borderline.key))).toBe(true);
      expect(existsSync(path.join(monthDir, 'keep.txt'))).toBe(true);

      // everything old gone -> the folders disappear
      utimesSync(path.join(dir, 'images', fresh.key), NOW / 1000 - 40 * day, NOW / 1000 - 40 * day);
      utimesSync(path.join(dir, 'images', borderline.key), NOW / 1000 - 40 * day, NOW / 1000 - 40 * day);
      await storage.sweep();
      expect(existsSync(path.join(dir, 'images', fresh.key))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('sweeping an empty or missing images folder is harmless', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const storage = new LocalStorage({ dataDir: dir, publicBaseUrl: 'https://x.test', retentionDays: 1 });
      await expect(storage.sweep()).resolves.toEqual({ deleted: 0, bytes: 0 });
    } finally {
      cleanup();
    }
  });
});
