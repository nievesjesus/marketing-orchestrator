import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { defaultFetchSafeDeps, fetchSafe, sniffFormat, type FetchSafeDeps, type TransportRequest, type TransportResponse } from '../src/fetchsafe.js';
import { isBlockedAddress, isLoopbackAddress, parseIPv6 } from '../src/ip.js';

// Real magic-byte prefixes, padded.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(16)]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(4), Buffer.from('mif1avif'), Buffer.alloc(8)]);
const TTF = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(32)]);
const OTF = Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(32)]);

interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | Buffer[];
}

/** Fake DNS + transport: nothing touches the network. */
function fakeDeps(
  hosts: Record<string, string[]>,
  replies: Record<string, FakeReply | ((req: TransportRequest) => FakeReply)>,
  seen: TransportRequest[] = [],
): FetchSafeDeps {
  return {
    async lookup(hostname) {
      const addrs = hosts[hostname];
      if (!addrs) throw new Error('ENOTFOUND');
      return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);
    },
    async transport(req): Promise<TransportResponse> {
      seen.push(req);
      const entry = replies[req.url.toString()];
      if (!entry) throw new Error(`unexpected request to ${req.url.toString()}`);
      const reply = typeof entry === 'function' ? entry(req) : entry;
      const chunks = Array.isArray(reply.body) ? reply.body : reply.body ? [reply.body] : [];
      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
        body: (async function* () {
          for (const c of chunks) yield c;
        })(),
        destroy: () => undefined,
      };
    },
  };
}

const PUBLIC = { 'cdn.example.com': ['93.184.216.34'] };

async function expectBlocked(url: string, deps: FetchSafeDeps, code = 'url_blocked'): Promise<void> {
  const err = await fetchSafe(url, { kind: 'image' }, deps).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UserFacingError);
  expect((err as UserFacingError).code).toBe(code);
}

describe('IP classification', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::1', '2001::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:192.168.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a00:1',
    '::7f00:1', 'not-an-ip',
  ];
  const allowed = ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'];

  it.each(blocked)('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(allowed)('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it('parses IPv6 forms', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('fe80::1%eth0')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });

  it('recognizes loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });
});

describe('fetchSafe: URL and address checks', () => {
  const deps = fakeDeps({ ...PUBLIC, 'evil.example.com': ['10.0.0.5'], 'mixed.example.com': ['93.184.216.34', '169.254.169.254'], 'v6.example.com': ['fd00::1'] }, {});

  it.each([
    ['http://cdn.example.com/a.png', 'plain http'],
    ['ftp://cdn.example.com/a.png', 'ftp'],
    ['file:///etc/passwd', 'file'],
    ['https://user:pass@cdn.example.com/a.png', 'credentials in URL'],
    ['https://cdn.example.com:8443/a.png', 'non-standard port'],
    ['https://127.0.0.1/a.png', 'loopback literal'],
    ['https://[::1]/a.png', 'IPv6 loopback literal'],
    ['https://169.254.169.254/latest/meta-data', 'cloud metadata literal'],
    ['https://10.1.2.3/a.png', 'private literal'],
    ['https://[::ffff:127.0.0.1]/a.png', 'IPv4-mapped loopback literal'],
    ['https://metadata.google.internal/a.png', '.internal name'],
    ['https://printer.local/a.png', '.local name'],
    ['https://localhost/a.png', 'localhost without the dev switch'],
    ['https://evil.example.com/a.png', 'DNS answers a private address'],
    ['https://mixed.example.com/a.png', 'one private address among public ones'],
    ['https://v6.example.com/a.png', 'DNS answers an IPv6 ULA'],
  ])('refuses %s (%s)', async (url) => {
    await expectBlocked(url, deps);
  });

  it('reports DNS failures plainly', async () => {
    await expectBlocked('https://nope.example.com/a.png', deps, 'dns_failed');
  });

  it('rejects malformed URLs', async () => {
    await expectBlocked('not a url', deps, 'url_invalid');
  });

  it('error messages never include the query string, path or credentials', async () => {
    const err = await fetchSafe('https://user:secret@cdn.example.com/path/photo.png?sig=SUPERSECRET', { kind: 'image' }, deps).catch((e: unknown) => e);
    const text = `${(err as UserFacingError).message} ${(err as UserFacingError).suggestion ?? ''}`;
    expect(text).not.toMatch(/SUPERSECRET|secret|sig=|photo\.png/);
  });
});

describe('fetchSafe: downloads', () => {
  it('downloads an image over https and pins the connection to the vetted address', async () => {
    const seen: TransportRequest[] = [];
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/a.png': { headers: { 'content-type': 'image/png' }, body: PNG } }, seen);
    const out = await fetchSafe('https://cdn.example.com/a.png', { kind: 'image' }, deps);
    expect(out).toMatchObject({ format: 'png', contentType: 'image/png' });
    expect(out.data.equals(PNG)).toBe(true);
    expect(seen[0]?.address).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it.each([
    ['jpeg', JPEG, 'image/jpeg'],
    ['png', PNG, 'image/png'],
    ['webp', WEBP, 'image/webp'],
    ['avif', AVIF, 'image/avif'],
  ] as const)('sniffs %s by magic bytes, ignoring a wrong content type', async (format, bytes, mime) => {
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/x': { headers: { 'content-type': 'application/octet-stream' }, body: bytes } });
    const out = await fetchSafe('https://cdn.example.com/x', { kind: 'image' }, deps);
    expect(out.format).toBe(format);
    expect(out.contentType).toBe(mime);
  });

  it('rejects HTML disguised as an image (content type says image/png)', async () => {
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/x.png': { headers: { 'content-type': 'image/png' }, body: Buffer.from('<html><body>hi</body></html>') } });
    await expectBlocked('https://cdn.example.com/x.png', deps, 'not_an_image');
  });

  it('rejects by content type before reading the body', async () => {
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/page': { headers: { 'content-type': 'text/html' }, body: PNG } });
    await expectBlocked('https://cdn.example.com/page', deps, 'not_an_image');
  });

  it('rejects SVG and GIF (not in the allow-list)', async () => {
    const svg = fakeDeps(PUBLIC, { 'https://cdn.example.com/a.svg': { headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') } });
    await expectBlocked('https://cdn.example.com/a.svg', svg, 'not_an_image');
    const gif = fakeDeps(PUBLIC, { 'https://cdn.example.com/a.gif': { body: Buffer.from('GIF89a......') } });
    await expectBlocked('https://cdn.example.com/a.gif', gif, 'not_an_image');
  });

  it('accepts TTF/OTF fonts and explains WOFF/WOFF2', async () => {
    const ok = fakeDeps(PUBLIC, { 'https://cdn.example.com/a.ttf': { body: TTF }, 'https://cdn.example.com/a.otf': { body: OTF } });
    expect((await fetchSafe('https://cdn.example.com/a.ttf', { kind: 'font' }, ok)).format).toBe('ttf');
    expect((await fetchSafe('https://cdn.example.com/a.otf', { kind: 'font' }, ok)).format).toBe('otf');
    const woff = fakeDeps(PUBLIC, { 'https://cdn.example.com/a.woff2': { headers: { 'content-type': 'font/woff2' }, body: Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(16)]) } });
    const err = await fetchSafe('https://cdn.example.com/a.woff2', { kind: 'font' }, woff).catch((e: unknown) => e);
    expect((err as UserFacingError).code).toBe('font_unsupported');
    expect((err as UserFacingError).message).toMatch(/WOFF/);
  });

  it('does not accept an image where a font is expected, or the reverse', async () => {
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/a.png': { body: PNG }, 'https://cdn.example.com/a.ttf': { body: TTF } });
    await expect(fetchSafe('https://cdn.example.com/a.png', { kind: 'font' }, deps)).rejects.toBeInstanceOf(UserFacingError);
    await expect(fetchSafe('https://cdn.example.com/a.ttf', { kind: 'image' }, deps)).rejects.toBeInstanceOf(UserFacingError);
  });

  it('enforces the size limit from Content-Length and while streaming', async () => {
    const declared = fakeDeps(PUBLIC, { 'https://cdn.example.com/big': { headers: { 'content-length': String(20 * 1024 * 1024) }, body: PNG } });
    const a = await fetchSafe('https://cdn.example.com/big', { kind: 'image' }, declared).catch((e: unknown) => e);
    expect((a as UserFacingError).code).toBe('file_too_large');
    expect((a as UserFacingError).message).toMatch(/15 MB/);

    // No Content-Length: stop as soon as the running total passes the cap.
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let pulled = 0;
    const deps: FetchSafeDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield PNG;
          for (let i = 0; i < 100; i += 1) {
            pulled += 1;
            yield chunk;
          }
        })(),
        destroy: () => undefined,
      }),
    };
    const b = await fetchSafe('https://cdn.example.com/stream', { kind: 'image', maxBytes: 3 * 1024 * 1024 }, deps).catch((e: unknown) => e);
    expect((b as UserFacingError).code).toBe('file_too_large');
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it('honours a custom maxBytes at the boundary', async () => {
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/a.png': { body: PNG } });
    await expect(fetchSafe('https://cdn.example.com/a.png', { kind: 'image', maxBytes: PNG.length }, deps)).resolves.toBeTruthy();
    await expect(fetchSafe('https://cdn.example.com/a.png', { kind: 'image', maxBytes: PNG.length - 1 }, deps)).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('times out slow servers', async () => {
    const deps: FetchSafeDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: () => new Promise<TransportResponse>(() => undefined), // never answers
    };
    const err = await fetchSafe('https://cdn.example.com/slow', { kind: 'image', timeoutMs: 60 }, deps).catch((e: unknown) => e);
    expect((err as UserFacingError).code).toBe('fetch_timeout');
  });

  it('turns non-200 answers into a plain message', async () => {
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/missing.png': { status: 404, body: Buffer.from('nope') } });
    const err = await fetchSafe('https://cdn.example.com/missing.png', { kind: 'image' }, deps).catch((e: unknown) => e);
    expect((err as UserFacingError).code).toBe('fetch_failed');
    expect((err as UserFacingError).message).toMatch(/404/);
  });
});

describe('fetchSafe: redirects are vetted at every hop', () => {
  const hosts = { ...PUBLIC, 'img.example.org': ['93.184.216.35'], 'rebind.example.com': ['10.0.0.9'] };

  it('follows a redirect to another public host', async () => {
    const seen: TransportRequest[] = [];
    const deps = fakeDeps(
      hosts,
      {
        'https://cdn.example.com/a': { status: 302, headers: { location: 'https://img.example.org/b.png' } },
        'https://img.example.org/b.png': { body: PNG },
      },
      seen,
    );
    const out = await fetchSafe('https://cdn.example.com/a', { kind: 'image' }, deps);
    expect(out.format).toBe('png');
    expect(seen.map((s) => s.address.address)).toEqual(['93.184.216.34', '93.184.216.35']);
  });

  it('resolves relative Location headers', async () => {
    const deps = fakeDeps(PUBLIC, {
      'https://cdn.example.com/a': { status: 301, headers: { location: '/images/b.png' } },
      'https://cdn.example.com/images/b.png': { body: PNG },
    });
    await expect(fetchSafe('https://cdn.example.com/a', { kind: 'image' }, deps)).resolves.toMatchObject({ format: 'png' });
  });

  it.each([
    ['literal private IP', 'http://169.254.169.254/latest/meta-data'],
    ['https private IP', 'https://10.0.0.1/a.png'],
    ['plain http', 'http://img.example.org/b.png'],
    ['host that resolves to a private address', 'https://rebind.example.com/b.png'],
    ['file scheme', 'file:///etc/passwd'],
  ])('blocks a redirect to a %s', async (_label, target) => {
    const deps = fakeDeps(hosts, { 'https://cdn.example.com/a': { status: 302, headers: { location: target } } });
    await expectBlocked('https://cdn.example.com/a', deps);
  });

  it('gives up after 3 redirects', async () => {
    const replies: Record<string, FakeReply> = {};
    for (let i = 0; i < 6; i += 1) replies[`https://cdn.example.com/${i}`] = { status: 302, headers: { location: `https://cdn.example.com/${i + 1}` } };
    const err = await fetchSafe('https://cdn.example.com/0', { kind: 'image' }, fakeDeps(PUBLIC, replies)).catch((e: unknown) => e);
    expect((err as UserFacingError).message).toMatch(/redirected too many times/);
  });

  it('a redirect without Location fails cleanly', async () => {
    const deps = fakeDeps(PUBLIC, { 'https://cdn.example.com/a': { status: 302 } });
    await expect(fetchSafe('https://cdn.example.com/a', { kind: 'image' }, deps)).rejects.toBeInstanceOf(UserFacingError);
  });
});

describe('fetchSafe: dev/test localhost exception', () => {
  const lookupLocal: FetchSafeDeps['lookup'] = async () => [{ address: '127.0.0.1', family: 4 }];

  it('is OFF by default: localhost is refused', async () => {
    const deps = fakeDeps({ localhost: ['127.0.0.1'] }, {});
    await expectBlocked('http://localhost:8123/a.png', deps);
  });

  it('allows http://localhost only when enabled, and still refuses other private ranges', async () => {
    const deps: FetchSafeDeps = { lookup: lookupLocal, transport: fakeDeps({}, { 'http://localhost:8123/a.png': { body: PNG } }).transport };
    await expect(fetchSafe('http://localhost:8123/a.png', { kind: 'image', allowInsecureLocalhost: true }, deps)).resolves.toMatchObject({ format: 'png' });
    await expect(fetchSafe('http://10.0.0.5:8123/a.png', { kind: 'image', allowInsecureLocalhost: true }, deps)).rejects.toMatchObject({ code: 'url_blocked' });
    await expect(fetchSafe('http://example.com/a.png', { kind: 'image', allowInsecureLocalhost: true }, deps)).rejects.toMatchObject({ code: 'url_blocked' });
  });

  it('the real transport works end to end against a local server (no external network)', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const out = await fetchSafe(`http://127.0.0.1:${port}/x.png`, { kind: 'image', allowInsecureLocalhost: true }, defaultFetchSafeDeps);
      expect(out.format).toBe('png');
      expect(out.data.equals(PNG)).toBe(true);
      // Without the switch the same URL is refused before any connection.
      await expect(fetchSafe(`http://127.0.0.1:${port}/x.png`, { kind: 'image' }, defaultFetchSafeDeps)).rejects.toMatchObject({ code: 'url_blocked' });
    } finally {
      server.close();
    }
  });
});

describe('sniffFormat', () => {
  it('returns null for too-short or unknown data', () => {
    expect(sniffFormat(Buffer.from([1, 2]), 'image')).toBeNull();
    expect(sniffFormat(Buffer.alloc(0), 'font')).toBeNull();
  });
});
