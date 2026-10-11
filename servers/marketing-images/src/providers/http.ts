import { isIP } from 'node:net';
import { UserFacingError } from '../errors.js';
import { isBlockedAddress } from '../ip.js';
import type { ProviderId } from '../models.js';
import { providerError } from './errors.js';

/**
 * Small HTTP helpers shared by the adapters. They use plain `fetch` (injectable for tests), never log or echo
 * headers, and turn transport failures into `ProviderError`s (timeout / network).
 */

export interface HttpResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  json: unknown;
  /** Raw body text (only ever used for classification, never shown to the user). */
  text: string;
  headers: Headers;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export async function httpJson(fetchFn: typeof fetch, provider: ProviderId, req: HttpRequest): Promise<HttpResult> {
  let response: Response;
  try {
    response = await fetchFn(req.url, {
      method: req.method,
      headers: { Accept: 'application/json', ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...req.headers },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    throw transportError(provider, err);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw transportError(provider, err);
  }
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, ok: response.ok, json, text, headers: response.headers };
}

export function transportError(provider: ProviderId, err: unknown): Error {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return providerError('timeout', provider);
  return providerError('network', provider);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A URL the provider handed back that we are about to download (or send our key to): https only, no embedded
 * credentials and not a literal private address. Throws a ProviderError otherwise.
 */
export function assertPublicHttps(provider: ProviderId, raw: string, allowedHosts?: (host: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw providerError('server', provider);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literal = isIP(host) !== 0;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    (literal && isBlockedAddress(host)) ||
    (allowedHosts && !allowedHosts(host))
  ) {
    throw providerError('server', provider);
  }
  return url;
}

/**
 * First-line check of an input image link before it is handed to fal or Leonardo (which download it themselves;
 * Gemini gets the bytes through `fetchSafe`, the full SSRF guard). https only, no embedded credentials, and not an
 * obviously internal address. http://localhost is allowed in development and tests only.
 */
export function assertPublicReference(raw: string, allowInsecureLocalhost: boolean): void {
  const blocked = (host: string): UserFacingError =>
    new UserFacingError(
      'url_blocked',
      `That link (${host}) cannot be used: it must be a public https:// address.`,
      'Ask the user for a normal public image link, or upload the file to Postiz and use its link.',
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserFacingError('url_invalid', 'That is not a valid link.', 'Ask the user for the full https:// address.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
  if (allowInsecureLocalhost && local) return;
  const literal = isIP(host) !== 0;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    local ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (literal && isBlockedAddress(host))
  ) {
    throw blocked(url.hostname);
  }
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

/**
 * Download a generated image from the URL a provider returned. No credentials are ever sent (the provider URLs are
 * pre-signed or public), redirects are followed by hand and re-checked, and the size is capped.
 */
export async function downloadOutput(fetchFn: typeof fetch, provider: ProviderId, rawUrl: string, options: DownloadOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;
  let url = assertPublicHttps(provider, rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'image/*,*/*;q=0.5', ...options.headers },
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw transportError(provider, err);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw providerError('server', provider);
      url = assertPublicHttps(provider, new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw providerError('server', provider);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw providerError('server', provider);
    let data: Buffer;
    try {
      data = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      throw transportError(provider, err);
    }
    if (data.length === 0 || data.length > maxBytes) throw providerError('server', provider);
    return data;
  }
  throw providerError('server', provider);
}
