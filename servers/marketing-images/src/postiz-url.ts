/**
 * `POSTIZ_URL` normalization. The Postiz Public API lives at different paths depending on where Postiz runs
 * (servers listed in https://docs.postiz.com/public-api/openapi.json):
 *
 *   Postiz Cloud   https://api.postiz.com/public/v1
 *   Self-hosted    https://{your-domain}/api/public/v1
 *
 * Owners paste whichever URL they have at hand, so `POSTIZ_URL` may be the API base itself, the app URL, or the
 * backend URL (`.../api`). All of these end up as the same API base:
 *
 *   https://api.postiz.com                        -> https://api.postiz.com/public/v1
 *   https://platform.postiz.com  (Cloud app)      -> https://api.postiz.com/public/v1
 *   https://postiz.example.com                    -> https://postiz.example.com/api/public/v1
 *   https://postiz.example.com/api                -> https://postiz.example.com/api/public/v1
 *   https://postiz.example.com/api/public/v1      -> unchanged
 */

export class PostizUrlError extends Error {
  override readonly name = 'PostizUrlError';
}

const CLOUD_API_BASE = 'https://api.postiz.com/public/v1';

function isPostizCloudHost(hostname: string): boolean {
  return hostname === 'postiz.com' || hostname.endsWith('.postiz.com');
}

/** Returns the Public API base without a trailing slash. Throws `PostizUrlError` (message never contains the input). */
export function normalizePostizBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PostizUrlError('POSTIZ_URL must be an absolute URL such as https://postiz.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PostizUrlError('POSTIZ_URL must start with https:// (or http:// for a local Postiz).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PostizUrlError('POSTIZ_URL must not contain credentials, a query string or a fragment.');
  }
  const hostname = url.hostname.toLowerCase();
  if (isPostizCloudHost(hostname)) return CLOUD_API_BASE;

  const origin = url.origin;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/public/v1')) return `${origin}${pathname}`;
  if (pathname.endsWith('/public')) return `${origin}${pathname}/v1`;
  if (pathname.endsWith('/api')) return `${origin}${pathname}/public/v1`;
  return `${origin}${pathname}/api/public/v1`;
}

/** True for hosts where sending the API key over plain http is acceptable (the machine itself). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}
