import { describe, expect, it } from 'vitest';
import type { PostizSettings } from '../src/config.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { PostizClient, PostizError } from '../src/postiz.js';
import { PostizUrlError, normalizePostizBase } from '../src/postiz-url.js';

const KEY = 'pk-test-fake-postiz-key-do-not-leak';
const CLOUD = 'https://api.postiz.com/public/v1';

describe('POSTIZ_URL normalization', () => {
  it.each([
    // Postiz Cloud: the API host, the API base itself, or the web app all end at api.postiz.com/public/v1
    ['https://api.postiz.com', CLOUD],
    ['https://api.postiz.com/', CLOUD],
    ['https://api.postiz.com/public/v1', CLOUD],
    ['https://platform.postiz.com', CLOUD],
    ['https://postiz.com', CLOUD],
    // self-hosted: the app URL, the backend URL (/api) or the API base
    ['https://postiz.example.com', 'https://postiz.example.com/api/public/v1'],
    ['https://postiz.example.com/', 'https://postiz.example.com/api/public/v1'],
    ['https://postiz.example.com/api', 'https://postiz.example.com/api/public/v1'],
    ['https://postiz.example.com/api/', 'https://postiz.example.com/api/public/v1'],
    ['https://postiz.example.com/api/public/v1', 'https://postiz.example.com/api/public/v1'],
    ['https://postiz.example.com/api/public/v1/', 'https://postiz.example.com/api/public/v1'],
    ['https://postiz.example.com/api/public', 'https://postiz.example.com/api/public/v1'],
    ['http://localhost:5000', 'http://localhost:5000/api/public/v1'],
    ['https://example.com/postiz', 'https://example.com/postiz/api/public/v1'],
    ['  https://postiz.example.com  ', 'https://postiz.example.com/api/public/v1'],
    // look-alike hosts are NOT the cloud
    ['https://evilpostiz.com', 'https://evilpostiz.com/api/public/v1'],
    ['https://postiz.com.evil.test', 'https://postiz.com.evil.test/api/public/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePostizBase(input)).toBe(expected);
  });

  it.each([
    'not a url',
    '',
    'ftp://postiz.example.com',
    'https://user:topsecret@postiz.example.com',
    'https://postiz.example.com?token=topsecret',
    'https://postiz.example.com/#frag',
  ])('rejects %j without echoing it', (input) => {
    expect(() => normalizePostizBase(input)).toThrow(PostizUrlError);
    try {
      normalizePostizBase(input);
    } catch (err) {
      expect((err as Error).message).not.toContain('topsecret');
    }
  });
});

describe('Postiz settings in the config', () => {
  const base = { DATA_DIR: '/tmp/x' };
  it('are null without credentials', () => {
    expect(loadConfig({ ...base, ACCESS_TOKENS: 'a:aaaaaaaaaaaaaaaa' }).postiz).toBeNull();
  });

  it('need both POSTIZ_URL and POSTIZ_API_KEY, naming the missing one', () => {
    expect(() => loadConfig({ ...base, ACCESS_TOKENS: 'a:aaaaaaaaaaaaaaaa', POSTIZ_URL: 'https://p.example.com' })).toThrow(/POSTIZ_API_KEY/);
    expect(() => loadConfig({ ...base, POSTIZ_API_KEY: KEY }, { mode: 'stdio' })).toThrow(/POSTIZ_URL/);
    try {
      loadConfig({ ...base, POSTIZ_API_KEY: KEY }, { mode: 'stdio' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('stdio: enabled, auto-upload on by default, URL normalized', () => {
    const c = loadConfig({ ...base, POSTIZ_URL: 'https://postiz.example.com', POSTIZ_API_KEY: KEY }, { mode: 'stdio' });
    expect(c.postiz).toEqual({ apiBase: 'https://postiz.example.com/api/public/v1', apiKey: KEY, autoUpload: true, enabled: true });
  });

  it('POSTIZ_AUTO_UPLOAD=false turns the automatic upload off; junk values are rejected', () => {
    const env = { ...base, POSTIZ_URL: 'https://api.postiz.com', POSTIZ_API_KEY: KEY };
    expect(loadConfig({ ...env, POSTIZ_AUTO_UPLOAD: 'false' }, { mode: 'stdio' }).postiz).toMatchObject({ autoUpload: false, apiBase: CLOUD });
    expect(loadConfig({ ...env, POSTIZ_AUTO_UPLOAD: '0' }, { mode: 'stdio' }).postiz?.autoUpload).toBe(false);
    expect(loadConfig({ ...env, POSTIZ_AUTO_UPLOAD: 'yes' }, { mode: 'stdio' }).postiz?.autoUpload).toBe(true);
    expect(() => loadConfig({ ...env, POSTIZ_AUTO_UPLOAD: 'maybe' }, { mode: 'stdio' })).toThrow(/POSTIZ_AUTO_UPLOAD must be true or false/);
  });

  it('HTTP mode: disabled unless POSTIZ_ALLOW_IN_HTTP=true (the key is single-tenant)', () => {
    const env = { ...base, ACCESS_TOKENS: 'a:aaaaaaaaaaaaaaaa', POSTIZ_URL: 'https://postiz.example.com', POSTIZ_API_KEY: KEY };
    expect(loadConfig(env).postiz?.enabled).toBe(false);
    expect(loadConfig({ ...env, POSTIZ_ALLOW_IN_HTTP: 'true' }).postiz?.enabled).toBe(true);
  });
});

// ---- the client ---------------------------------------------------------------------------------------------

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: FormData | undefined;
}

function scripted(answers: (Response | Error)[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const queue = [...answers];
  const fn: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({ url: String(input), method: init?.method ?? 'GET', headers, form: init?.body instanceof FormData ? init.body : undefined });
    const next = queue.shift() ?? new Response('unexpected extra call', { status: 599 });
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fn, seen };
}

const ok = (over: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ id: 'media-1', name: 'img.png', path: 'https://uploads.postiz.test/img.png', organizationId: 'o', ...over }), { status: 200, headers: { 'content-type': 'application/json' } });

const settings = (over: Partial<PostizSettings> = {}): PostizSettings => ({ apiBase: CLOUD, apiKey: KEY, autoUpload: true, enabled: true, ...over });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const file = { data: PNG, filename: 'abc.png', contentType: 'image/png' };

describe('PostizClient.upload', () => {
  it('POSTs multipart to {base}/upload with the field "file" and the RAW key in Authorization', async () => {
    const { fetch, seen } = scripted([ok()]);
    const client = new PostizClient(settings(), { fetch });
    const result = await client.upload(file);

    expect(result).toEqual({ id: 'media-1', path: 'https://uploads.postiz.test/img.png' });
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.url).toBe(`${CLOUD}/upload`);
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(KEY); // raw key: no "Bearer"
    expect(call.headers.authorization).not.toMatch(/bearer/i);
    expect(call.headers['content-type']).toBeUndefined(); // fetch adds multipart/form-data with the boundary itself
    expect(call.form).toBeInstanceOf(FormData);
    expect([...call.form!.keys()]).toEqual(['file']);
    const part = call.form!.get('file') as File;
    expect(part.name).toBe('abc.png');
    expect(part.type).toBe('image/png');
    expect(Buffer.from(await part.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('uses the self-hosted base for a self-hosted URL', async () => {
    const { fetch, seen } = scripted([ok()]);
    await new PostizClient(settings({ apiBase: normalizePostizBase('https://postiz.example.com') }), { fetch }).upload(file);
    expect(seen[0]!.url).toBe('https://postiz.example.com/api/public/v1/upload');
  });

  it('retries ONCE after a 429, waiting for Retry-After', async () => {
    const { fetch, seen } = scripted([new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }), ok()]);
    const sleeps: number[] = [];
    const result = await new PostizClient(settings(), { fetch, sleep: async (ms) => void sleeps.push(ms) }).upload(file);
    expect(result.id).toBe('media-1');
    expect(seen).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('backs off 2 s by default when a 429 has no Retry-After', async () => {
    const { fetch } = scripted([new Response('', { status: 429 }), ok()]);
    const sleeps: number[] = [];
    await new PostizClient(settings(), { fetch, sleep: async (ms) => void sleeps.push(ms) }).upload(file);
    expect(sleeps).toEqual([2000]);
  });

  it('gives up after the single retry and says so (no key in the message)', async () => {
    const { fetch, seen } = scripted([new Response('', { status: 429, headers: { 'retry-after': '0' } }), new Response('', { status: 429 })]);
    const error = await new PostizClient(settings(), { fetch, sleep: async () => undefined }).upload(file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PostizError);
    expect((error as PostizError).code).toBe('rate_limited');
    expect((error as Error).message).toMatch(/30 requests per hour/);
    expect((error as Error).message).not.toContain(KEY);
    expect(seen).toHaveLength(2);
  });

  it('does not wait for a Retry-After longer than the cap', async () => {
    const { fetch, seen } = scripted([new Response('', { status: 429, headers: { 'retry-after': '3600' } }), ok()]);
    const sleeps: number[] = [];
    const error = await new PostizClient(settings(), { fetch, sleep: async (ms) => void sleeps.push(ms) }).upload(file).catch((e: unknown) => e);
    expect((error as PostizError).code).toBe('rate_limited');
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([
    [401, 'unauthorized', /rejected the API key/],
    [403, 'unauthorized', /rejected the API key/],
    [413, 'too_large', /too large/],
    [400, 'rejected', /refused the upload \(HTTP 400\)/],
    [500, 'server', /server error \(HTTP 500\)/],
  ] as const)('HTTP %i -> %s', async (status, code, message) => {
    // the body echoes the key, as a misbehaving proxy might: it must never reach the message
    const { fetch, seen } = scripted([new Response(`error for ${KEY}`, { status })]);
    const error = await new PostizClient(settings(), { fetch }).upload(file).catch((e: unknown) => e);
    expect((error as PostizError).code).toBe(code);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain(KEY);
    expect(seen).toHaveLength(1); // only 429 is retried
  });

  it('network errors and timeouts become safe messages even if the cause mentions the key', async () => {
    const net = await new PostizClient(settings(), { fetch: scripted([new TypeError(`fetch failed (Authorization: ${KEY})`)]).fetch }).upload(file).catch((e: unknown) => e);
    expect((net as PostizError).code).toBe('network');
    expect((net as Error).message).not.toContain(KEY);

    const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const timeout = await new PostizClient(settings(), { fetch: scripted([abort]).fetch }).upload(file).catch((e: unknown) => e);
    expect((timeout as PostizError).code).toBe('timeout');
  });

  it.each([
    ['not json', new Response('<html>', { status: 200 })],
    ['no id', new Response(JSON.stringify({ path: 'https://x.test/a.png' }), { status: 200 })],
    ['no path', new Response(JSON.stringify({ id: 'a' }), { status: 200 })],
    ['empty object', new Response('{}', { status: 200 })],
  ])('a 200 with %s is a bad response', async (_name, response) => {
    const error = await new PostizClient(settings(), { fetch: scripted([response]).fetch }).upload(file).catch((e: unknown) => e);
    expect((error as PostizError).code).toBe('bad_response');
  });
});
