import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, LOCAL_USER, loadConfig, localHome } from '../src/config.js';
import { ImageOwners } from '../src/image-owners.js';
import { LocalStorage } from '../src/storage.js';
import { OTHER_TOKEN, TEST_TOKEN, callTool, makePhoto, startTestServer, tmpDir } from './helpers.js';
import { POSTIZ_ENV, postizMock } from './postizMock.js';
import { FAKE_KEYS, MockFetch, jsonResponse } from './providerMocks.js';
import { jsonOf, startStdioHarness, textOf, type StdioHarness } from './stdioHarness.js';

const harnesses: StdioHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
});
async function local(options: Parameters<typeof startStdioHarness>[0] = {}): Promise<StdioHarness> {
  const h = await startStdioHarness(options);
  harnesses.push(h);
  return h;
}

const CARD = { template: 'cta-card', format: 'square', texts: { headline: 'Open late' }, background: { color: '#1F3A5F' } } as const;

describe('stdio configuration', () => {
  it('needs no access tokens, ignores ACCESS_TOKENS and uses ~/.marketing-images by default', () => {
    const c = loadConfig({}, { mode: 'stdio', homeDir: '/home/jo' });
    expect(c.mode).toBe('stdio');
    expect(c.accessTokens).toEqual([]);
    expect(c.dataDir).toBe(path.join('/home/jo', '.marketing-images'));
    expect(c.publicBaseUrl).toBeNull();
    expect(c.postiz).toBeNull();
    expect(loadConfig({ ACCESS_TOKENS: 'not-valid' }, { mode: 'stdio' }).accessTokens).toEqual([]);
  });

  it('DATA_DIR beats MARKETING_IMAGES_HOME, which beats the home default', () => {
    expect(loadConfig({ MARKETING_IMAGES_HOME: '/srv/mi' }, { mode: 'stdio', homeDir: '/home/jo' }).dataDir).toBe('/srv/mi');
    expect(loadConfig({ MARKETING_IMAGES_HOME: '/srv/mi', DATA_DIR: '/var/mi' }, { mode: 'stdio', homeDir: '/home/jo' }).dataDir).toBe('/var/mi');
    expect(localHome({ MARKETING_IMAGES_HOME: '/srv/mi' })).toBe('/srv/mi');
  });

  it('PUBLIC_BASE_URL switches the links from file:// to http(s)', () => {
    expect(loadConfig({ PUBLIC_BASE_URL: 'https://img.example.com/' }, { mode: 'stdio' }).publicBaseUrl).toBe('https://img.example.com');
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'ftp://x' }, { mode: 'stdio' })).toThrow(/http/);
  });

  it('HTTP mode is unchanged: tokens required, /data by default, no local image dirs', () => {
    expect(() => loadConfig({}, { mode: 'http' })).toThrow(/ACCESS_TOKENS is required/);
    const c = loadConfig({ ACCESS_TOKENS: 'a:aaaaaaaaaaaaaaaa', LOCAL_IMAGE_DIRS: '/photos' });
    expect(c.mode).toBe('http');
    expect(c.dataDir).toBe('/data');
    expect(c.localImageDirs).toEqual([]);
  });

  it('LOCAL_IMAGE_DIRS takes absolute folders separated by the platform delimiter', () => {
    const dirs = ['/photos', '/more/photos'].join(path.delimiter);
    expect(loadConfig({ LOCAL_IMAGE_DIRS: dirs }, { mode: 'stdio' }).localImageDirs).toEqual(['/photos', '/more/photos']);
    expect(() => loadConfig({ LOCAL_IMAGE_DIRS: 'relative/dir' }, { mode: 'stdio' })).toThrow(ConfigError);
  });

  it('LOCAL_IMAGE_DIRS also accepts commas and a leading ~ (the home folder)', () => {
    const c = loadConfig({ LOCAL_IMAGE_DIRS: '~/Pictures/marketing, /photos ,~' }, { mode: 'stdio', homeDir: '/home/jo' });
    expect(c.localImageDirs).toEqual(['/home/jo/Pictures/marketing', '/photos', '/home/jo']);
    expect(() => loadConfig({ LOCAL_IMAGE_DIRS: '/photos,relative' }, { mode: 'stdio' })).toThrow(/absolute paths or start with ~\//);
  });
});

describe('local storage links', () => {
  it('without a public base URL, put() returns a file:// URL and keyForUrl/keyForPath map back to the key', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const storage = new LocalStorage({ dataDir: dir, publicBaseUrl: null, retentionDays: 30 });
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
      const stored = await storage.put(png, 'png');
      const filePath = storage.localPath(stored.key)!;
      expect(stored.url).toBe(pathToFileURL(filePath).href);
      expect(fileURLToPath(stored.url)).toBe(filePath);
      expect(existsSync(filePath)).toBe(true);
      expect(storage.keyForUrl(stored.url)).toBe(stored.key);
      expect(storage.keyForPath(filePath)).toBe(stored.key);

      // anything that is not exactly {yyyy}/{mm}/{uuid}.{png|jpg} inside the store is not a key
      for (const bad of [path.join(dir, 'app.db'), path.join(dir, 'images', '..', 'app.db'), '/etc/passwd', 'images/2026/10/x.png', path.join(dir, 'images', '2026', '10', 'notauuid.png')]) {
        expect(storage.keyForPath(bad), bad).toBeNull();
      }
      expect(storage.keyForUrl('https://example.com/i/2026/10/x.png')).toBeNull();
      expect(storage.keyForUrl('file:///etc/passwd')).toBeNull();
      expect(storage.keyForUrl('not a url')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('with a public base URL it keeps http links and still understands file:// ones', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const storage = new LocalStorage({ dataDir: dir, publicBaseUrl: 'https://img.example.com', retentionDays: 30 });
      const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
      const stored = await storage.put(jpg, 'jpg');
      expect(stored.url).toBe(`https://img.example.com/i/${stored.key}`);
      expect(storage.keyForUrl(stored.url)).toBe(stored.key);
      expect(storage.keyForUrl(pathToFileURL(storage.localPath(stored.key)!).href)).toBe(stored.key);
    } finally {
      cleanup();
    }
  });
});

describe('ImageOwners', () => {
  it('records the maker, remembers the Postiz copy and prunes old rows', () => {
    let now = 1_000_000;
    const owners = new ImageOwners(':memory:', () => now);
    owners.record('2026/10/a.png', 'alice');
    owners.record('2026/10/a.png', 'bob'); // the first maker keeps it
    expect(owners.ownerOf('2026/10/a.png')).toBe('alice');
    expect(owners.isOwnedBy('2026/10/a.png', 'bob')).toBe(false);
    expect(owners.ownerOf('missing')).toBeNull();
    expect(owners.getPostiz('2026/10/a.png')).toBeNull();
    owners.setPostiz('2026/10/a.png', { id: 'm1', path: 'https://p.test/a.png' });
    expect(owners.getPostiz('2026/10/a.png')).toEqual({ id: 'm1', path: 'https://p.test/a.png' });
    now += 10_000;
    owners.record('2026/10/b.png', 'alice');
    expect(owners.prune(5_000)).toBe(1);
    expect(owners.ownerOf('2026/10/a.png')).toBeNull();
    expect(owners.ownerOf('2026/10/b.png')).toBe('alice');
    owners.close();
  });
});

describe('stdio tools', () => {
  it('compose_post returns the local file_path next to a file:// url; the owner is "local"', async () => {
    const h = await local();
    const result = await h.call('compose_post', CARD);
    expect(result.isError).toBeUndefined();
    const data = jsonOf(result);
    expect(data.url).toMatch(/^file:\/\//);
    expect(data.file_path).toBe(fileURLToPath(data.url));
    expect(path.isAbsolute(data.file_path)).toBe(true);
    expect(data.file_path.startsWith(path.join(h.dataDir, 'images'))).toBe(true);
    expect((await sharp(await readFile(data.file_path)).metadata()).width).toBe(1080);
    expect(data.width).toBe(1080);
    expect(data.next_step).toMatch(/local file/);
    expect(data.next_step).toMatch(/cannot reach/);
    expect(data.next_step).not.toMatch(/give `url` to the scheduling tool/);
    expect(h.ctx.owners.ownerOf(h.ctx.storage.keyForPath(data.file_path)!)).toBe(LOCAL_USER);
    expect(result.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
  });

  it('every stdout frame is a JSON-RPC message and logs stay on the logger sink', async () => {
    const h = await local();
    await h.call('compose_post', CARD);
    await h.rpc('tools/list');
    expect(h.frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of h.frames) expect(frame.jsonrpc).toBe('2.0');
    expect(h.rawLogs.some((l) => l.includes('"tool_call"'))).toBe(true);
  });

  it('the server instructions describe the local hand-off', async () => {
    const h = await local();
    const init = (await h.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'again', version: '0' } })).result;
    expect(init.instructions).toMatch(/LOCAL file/);
    expect(init.instructions).toMatch(/file_path/);
    expect(init.instructions).toMatch(/cannot reach local files/);
    expect(init.instructions).not.toMatch(/postiz\.path/); // Postiz is not configured here
  });

  it('with PUBLIC_BASE_URL the url is a normal link, but file_path is still returned', async () => {
    const h = await local({ env: { PUBLIC_BASE_URL: 'https://img.example.com' } });
    const data = jsonOf(await h.call('compose_post', CARD));
    expect(data.url).toMatch(/^https:\/\/img\.example\.com\/i\/\d{4}\/\d{2}\//);
    expect(data.file_path).toBeDefined();
    expect(data.next_step).toMatch(/Postiz uploadFromUrlTool/);
  });

  it('a file:// url from one result works as the photo of the next compose_post', async () => {
    const h = await local();
    const first = jsonOf(await h.call('compose_post', { template: 'cta-card', format: 'landscape', texts: { headline: 'First' }, background: { gradient: { from: '#112233', to: '#aabbcc' } } }));
    const second = await h.call('compose_post', { template: 'photo-headline', format: 'square', texts: { headline: 'Second' }, background: { image_url: first.url } });
    expect(second.isError).toBeUndefined();
    const data = jsonOf(second);
    expect(data.applied.background).toBe('photo');
    expect((await sharp(await readFile(data.file_path)).metadata()).height).toBe(1080);
  });

  it('refuses local files outside the allowed folders, with one answer for existing and missing paths', async () => {
    const h = await local();
    const outside = path.join(h.dataDir, '..', 'definitely-outside.png');
    writeFileSync(outside, await makePhoto(200, 200));
    const asked = (url: string) => h.call('compose_post', { template: 'photo-headline', format: 'square', texts: { headline: 'x' }, background: { image_url: url } });
    const a = await asked(pathToFileURL(outside).href);
    const b = await asked(pathToFileURL('/definitely/not/here.png').href);
    const c = await asked('file:///etc/passwd');
    for (const r of [a, b, c]) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/outside the folders this server may read/);
    }
  });

  it('LOCAL_IMAGE_DIRS lets the user bring their own photos; symlinks out of the folder and non-images are still refused', async () => {
    const photos = tmpDir('mi-photos-');
    const secret = tmpDir('mi-secret-');
    try {
      writeFileSync(path.join(photos.dir, 'mine.jpg'), await makePhoto(900, 700));
      writeFileSync(path.join(photos.dir, 'notes.txt'), 'just text');
      writeFileSync(path.join(secret.dir, 'private.jpg'), await makePhoto(900, 700));
      symlinkSync(path.join(secret.dir, 'private.jpg'), path.join(photos.dir, 'link.jpg'));
      const h = await local({ env: { LOCAL_IMAGE_DIRS: photos.dir } });
      const asked = (name: string) =>
        h.call('compose_post', { template: 'photo-headline', format: 'square', texts: { headline: 'Mine' }, background: { image_url: pathToFileURL(path.join(photos.dir, name)).href } });

      const good = await asked('mine.jpg');
      expect(good.isError).toBeUndefined();
      expect(jsonOf(good).applied.background).toBe('photo');

      const linked = await asked('link.jpg');
      expect(linked.isError).toBe(true);
      expect(textOf(linked)).toMatch(/outside the folders/);

      const text = await asked('notes.txt');
      expect(text.isError).toBe(true);
      expect(textOf(text)).toMatch(/not a supported image/);
    } finally {
      photos.cleanup();
      secret.cleanup();
    }
  });

  it('generate_image gives file_path; edit_image takes the local url back (Gemini reads the bytes); fal and Leonardo cannot', async () => {
    const providers = new MockFetch();
    const photo = (await makePhoto(1200, 900)).toString('base64');
    providers.route(':generateContent', () => jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo } }] }, finishReason: 'STOP' }] }));
    const h = await local({ env: { GEMINI_API_KEY: FAKE_KEYS.gemini, FAL_KEY: FAKE_KEYS.fal }, overrides: { providerFetch: providers.fetch } });

    const made = jsonOf(await h.call('generate_image', { prompt: 'a calm lake at sunrise, soft mist' }));
    expect(made.status).toBe('done');
    const image = made.images[0];
    expect(image.url).toMatch(/^file:\/\//);
    expect(image.file_path).toBe(fileURLToPath(image.url));
    expect(existsSync(image.file_path)).toBe(true);
    expect(made.next_step).toMatch(/local files/);

    const edited = await h.call('edit_image', { image_url: image.url, instruction: 'make the colors warmer' });
    expect(edited.isError).toBeUndefined();
    const sent = JSON.stringify(providers.calls.at(-1)!.body);
    expect(sent).toContain('inlineData'); // the local picture travelled as bytes
    expect(sent).not.toContain('file://');

    const fal = await h.call('edit_image', { image_url: image.url, instruction: 'make the colors warmer', provider: 'fal' });
    expect(fal.isError).toBe(true);
    expect(textOf(fal)).toMatch(/only be used as a reference with Gemini/);
  });

  it('without a Gemini key a local reference explains what to do instead of sending a file:// link to fal', async () => {
    const h = await local({ env: { FAL_KEY: FAKE_KEYS.fal } });
    const made = jsonOf(await h.call('compose_post', CARD));
    const res = await h.call('edit_image', { image_url: made.url, instruction: 'make the colors warmer' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/GEMINI_API_KEY/);
  });

  it('Postiz: uploads, shows postiz.path, and upload_to_postiz works from the local file_path', async () => {
    const mock = postizMock();
    const h = await local({ env: { ...POSTIZ_ENV, POSTIZ_AUTO_UPLOAD: 'false' }, overrides: { postizFetch: mock.fetch } });
    const init = (await h.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'again', version: '0' } })).result;
    expect(init.instructions).toMatch(/Postiz upload is on/);
    expect(init.instructions).toMatch(/skip uploadFromUrlTool/);
    expect(init.instructions).toMatch(/compose_post, compose_custom and compose_carousel upload the final graphic automatically/);
    expect(init.instructions).toMatch(/generate_image, edit_image and get_job do NOT upload unless upload_to_postiz=true/);

    const made = jsonOf(await h.call('compose_post', CARD));
    expect(made.postiz).toBeUndefined();
    const up = jsonOf(await h.call('upload_to_postiz', { file_path: made.file_path }));
    expect(up.path).toBe('https://uploads.postiz.test/media-1.png');
    expect(mock.calls[0]!.bytes.equals(await readFile(made.file_path))).toBe(true);

    const viaUrl = jsonOf(await h.call('upload_to_postiz', { url: made.url }));
    expect(viaUrl.already_uploaded).toBe(true);
    expect(mock.calls).toHaveLength(1);

    // auto-upload (the default once credentials exist) and the hint in next_step
    const auto = await local({ env: { ...POSTIZ_ENV }, overrides: { postizFetch: postizMock().fetch } });
    const withPostiz = jsonOf(await auto.call('compose_post', CARD));
    expect(withPostiz.postiz.path).toMatch(/^https:\/\/uploads\.postiz\.test\//);
    expect(withPostiz.next_step).toMatch(/postiz\.path/);
    expect(withPostiz.file_path).toBeDefined();
  });
});

describe('HTTP mode never reads local files', () => {
  it('a file:// background is refused like any non-https link', async () => {
    const s = await startTestServer({ overrides: { fetchImage: undefined } });
    try {
      const res = await callTool(s.url, TEST_TOKEN, 'compose_post', { template: 'photo-headline', format: 'square', texts: { headline: 'x' }, background: { image_url: 'file:///etc/passwd' } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/must be a public https/);
      expect(s.ctx.localFiles).toBeNull();
      // and a second user cannot use the first user's file_path / url as a file either
      const other = await callTool(s.url, OTHER_TOKEN, 'compose_post', { template: 'photo-headline', format: 'square', texts: { headline: 'x' }, background: { image_url: 'file:///tmp/whatever.png' } });
      expect(other.isError).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('results carry no file_path', async () => {
    const s = await startTestServer();
    try {
      mkdirSync(s.dataDir, { recursive: true });
      const data = jsonOf(await callTool(s.url, TEST_TOKEN, 'compose_post', CARD));
      expect(data.file_path).toBeUndefined();
      expect(data.url).toMatch(/^https:\/\/images\.example\.test\/i\//);
      expect(data.next_step).toMatch(/Postiz uploadFromUrlTool/);
    } finally {
      await s.close();
    }
  });
});
