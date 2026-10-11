// DNS: https://nodejs.org/docs/latest-v22.x/api/dns.html#dnspromiseslookuphostname-options
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { UserFacingError } from './errors.js';
import { isBlockedAddress, isLoopbackAddress } from './ip.js';

/**
 * SSRF-safe downloads for every URL a user gives us (backgrounds, logos, fonts). DESIGN section 10.
 *
 *  - https only (http is allowed for localhost only when `allowInsecureLocalhost`, i.e. NODE_ENV=test|development)
 *  - the hostname is resolved HERE, every address must be public (IPv4 + IPv6), and the connection is pinned
 *    to the vetted address, so a DNS answer that changes between check and connect (DNS rebinding) cannot win
 *  - redirects are followed manually (max 3) and every hop is vetted again
 *  - max 15 MB, 15 s total, content type plus magic bytes (jpeg/png/webp/avif; ttf/otf for fonts)
 *
 * Node's HTTP client: https://nodejs.org/docs/latest-v22.x/api/https.html#httpsrequestoptions-callback
 * (`servername` keeps SNI and certificate checks on the real hostname while `host` is the pinned IP).
 */

export type FetchKind = 'image' | 'font';
export type FetchedFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'svg' | 'ttf' | 'otf';

export interface FetchSafeOptions {
  kind: FetchKind;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowInsecureLocalhost?: boolean;
  /** Accept SVG as an image (off by default: only brand logos opt in, and they are rasterized by the caller). */
  allowSvg?: boolean;
}

export interface FetchSafeResult {
  data: Buffer;
  /** Sniffed from the bytes, not trusted from the server. */
  contentType: string;
  format: FetchedFormat;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface TransportRequest {
  url: URL;
  address: ResolvedAddress;
  signal: AbortSignal;
  headers: Record<string, string>;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export interface FetchSafeDeps {
  lookup(hostname: string): Promise<ResolvedAddress[]>;
  transport(request: TransportRequest): Promise<TransportResponse>;
}

export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const USER_AGENT = 'marketing-images/0.1 (+https://github.com/nievesjesus/marketing-orchestrator)';

// ---- Default dependencies (real DNS + real sockets) ---------------------------------

const defaultLookup: FetchSafeDeps['lookup'] = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

const nodeTransport: FetchSafeDeps['transport'] = ({ url, address, signal, headers }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = client.request(
      {
        host: address.address,
        family: address.family,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
        ...(isHttps && isIP(hostname) === 0 ? { servername: hostname } : {}),
        signal,
        agent: false,
      },
      (res) => {
        const outHeaders: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          outHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        resolve({ status: res.statusCode ?? 0, headers: outHeaders, body: res, destroy: () => res.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });

export const defaultFetchSafeDeps: FetchSafeDeps = { lookup: defaultLookup, transport: nodeTransport };

// ---- Helpers ---------------------------------------------------------------------------

/** Host only: query strings and paths can carry signatures, so they never appear in messages. */
function hostLabel(url: URL): string {
  return url.hostname;
}

function isLocalhostName(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

function blocked(url: URL): UserFacingError {
  return new UserFacingError(
    'url_blocked',
    `That link (${hostLabel(url)}) cannot be used: it must be a public https:// address.`,
    'Ask the user for a normal public image link, or upload the file to Postiz and use its link.',
  );
}

async function vet(url: URL, options: FetchSafeOptions, deps: FetchSafeDeps): Promise<ResolvedAddress> {
  const devLocalhost = options.allowInsecureLocalhost === true && isLocalhostName(url.hostname);

  if (url.username || url.password) throw blocked(url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && devLocalhost)) throw blocked(url);
  if (url.protocol === 'https:' && url.port && url.port !== '443' && !devLocalhost) throw blocked(url);

  const bare = url.hostname.replace(/^\[|\]$/g, '');
  const lower = bare.toLowerCase();
  if (!devLocalhost && (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.localhost'))) {
    throw blocked(url);
  }

  let addresses: ResolvedAddress[];
  const literalFamily = isIP(bare);
  if (literalFamily !== 0) {
    addresses = [{ address: bare, family: literalFamily === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await deps.lookup(bare);
    } catch {
      throw new UserFacingError(
        'dns_failed',
        `The link's host (${hostLabel(url)}) could not be found.`,
        'Check the link, or ask the user for another one.',
      );
    }
  }
  if (addresses.length === 0) {
    throw new UserFacingError('dns_failed', `The link's host (${hostLabel(url)}) could not be found.`);
  }
  // Every answer must be public; a single private address poisons the host.
  for (const a of addresses) {
    const allowedLoopback = devLocalhost && isLoopbackAddress(a.address);
    if (isBlockedAddress(a.address) && !allowedLoopback) throw blocked(url);
  }
  return addresses[0] as ResolvedAddress;
}

function contentTypeAllowed(header: string | undefined, kind: FetchKind): boolean {
  if (!header) return true;
  const type = header.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream') return true;
  if (kind === 'image') return type.startsWith('image/');
  return (
    type.startsWith('font/') ||
    type.startsWith('application/font') ||
    type.startsWith('application/x-font') ||
    type === 'application/vnd.ms-opentype'
  );
}

/** Identify the file from its first bytes. Returns null for anything we do not accept. */
export function sniffFormat(buf: Uint8Array, kind: FetchKind, allowSvg = false): { format: FetchedFormat; mime: string } | null {
  const at = (i: number): number => buf[i] ?? -1;
  const ascii = (start: number, text: string): boolean => [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));

  if (kind === 'image') {
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { format: 'jpeg', mime: 'image/jpeg' };
    if (at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
      return { format: 'png', mime: 'image/png' };
    }
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { format: 'webp', mime: 'image/webp' };
    if (ascii(4, 'ftyp')) {
      // ISO BMFF: major brand at 8, compatible brands from 16 up to the box size.
      const boxSize = Math.min(((at(0) << 24) | (at(1) << 16) | (at(2) << 8) | at(3)) >>> 0, 64, buf.length);
      for (let i = 8; i + 4 <= boxSize; i += i === 8 ? 8 : 4) {
        if (ascii(i, 'avif') || ascii(i, 'avis')) return { format: 'avif', mime: 'image/avif' };
      }
    }
    if (allowSvg && looksLikeSvg(buf)) return { format: 'svg', mime: 'image/svg+xml' };
    return null;
  }
  if ((at(0) === 0x00 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00) || ascii(0, 'true')) {
    return { format: 'ttf', mime: 'font/ttf' };
  }
  if (ascii(0, 'OTTO')) return { format: 'otf', mime: 'font/otf' };
  return null;
}

/** Text that starts (after a BOM, whitespace, an XML declaration or comments) with an `<svg` element. */
function looksLikeSvg(buf: Uint8Array): boolean {
  const head = Buffer.from(buf.subarray(0, 2048)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const stripped = head.replace(/^(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*)+/i, '');
  return /^<svg[\s>]/i.test(stripped);
}

function notSupported(kind: FetchKind, buf: Uint8Array): UserFacingError {
  const isWoff = (n: string): boolean => [...n].every((ch, i) => buf[i] === ch.charCodeAt(0));
  if (kind === 'font') {
    if (isWoff('wOFF') || isWoff('wOF2')) {
      return new UserFacingError(
        'font_unsupported',
        'WOFF and WOFF2 fonts are not supported.',
        'Use a .ttf or .otf font file, or pick one of the built-in fonts.',
      );
    }
    return new UserFacingError('font_unsupported', 'That file is not a TTF or OTF font.', 'Use a .ttf or .otf link.');
  }
  return new UserFacingError(
    'not_an_image',
    'That link does not point to a supported image (JPEG, PNG, WebP or AVIF).',
    'Ask the user for a direct link to the image file, not to a web page; SVG and GIF are not supported.',
  );
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---- Public API --------------------------------------------------------------------------

export async function fetchSafe(
  rawUrl: string,
  options: FetchSafeOptions,
  deps: FetchSafeDeps = defaultFetchSafeDeps,
): Promise<FetchSafeResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new UserFacingError('url_invalid', 'That is not a valid link.', 'Ask the user for the full https:// address.');
  }

  const controller = new AbortController();
  const timeoutError = new UserFacingError(
    'fetch_timeout',
    `Downloading from ${hostLabel(current)} took longer than ${Math.round(timeoutMs / 1000)} seconds.`,
    'Try again, or use a smaller or faster-hosted file.',
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  deadline.catch(() => undefined); // avoid an unhandled rejection when the work finishes first

  const run = async (): Promise<FetchSafeResult> => {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const address = await vet(current, options, deps);
      const response = await deps.transport({
        url: current,
        address,
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: options.kind === 'image' ? 'image/*,*/*;q=0.5' : '*/*' },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        response.destroy();
        const location = response.headers.location;
        if (!location) throw new UserFacingError('fetch_failed', 'The link redirected without saying where.');
        try {
          current = new URL(location, current);
        } catch {
          throw new UserFacingError('fetch_failed', 'The link redirected to an invalid address.');
        }
        continue; // the next iteration vets the new URL (scheme, port, DNS, ranges) again
      }

      if (response.status !== 200) {
        response.destroy();
        throw new UserFacingError(
          'fetch_failed',
          `Could not download the file (the server answered ${response.status}).`,
          'Check that the link is public and still valid, or ask for another one.',
        );
      }
      if (!contentTypeAllowed(response.headers['content-type'], options.kind)) {
        response.destroy();
        throw notSupported(options.kind, new Uint8Array());
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        throw tooLarge(maxBytes);
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          throw tooLarge(maxBytes);
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const sniffed = sniffFormat(data, options.kind, options.allowSvg === true);
      if (!sniffed) throw notSupported(options.kind, data);
      return { data, contentType: sniffed.mime, format: sniffed.format };
    }
    throw new UserFacingError('fetch_failed', 'The link redirected too many times.', 'Ask the user for the direct link.');
  };

  try {
    return await Promise.race([run(), deadline]);
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    if (controller.signal.aborted) throw timeoutError;
    throw new UserFacingError(
      'fetch_failed',
      `Could not download from ${hostLabel(current)}.`,
      'Check that the link is public, or ask for another one.',
    );
  } finally {
    clearTimeout(timer);
    controller.abort(); // release the socket if the work ended early
  }
}

function tooLarge(maxBytes: number): UserFacingError {
  return new UserFacingError(
    'file_too_large',
    `That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    'Ask for a smaller version (a normal social-media size is plenty).',
  );
}
