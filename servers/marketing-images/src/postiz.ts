import type { PostizSettings } from './config.js';

/**
 * Direct upload to Postiz through its Public API.
 *
 *   POST {apiBase}/upload        multipart/form-data, one field named `file` (binary)  ->  200 MediaFile { id, name, path, ... }
 *   Authorization: <api key>     raw key, no "Bearer" prefix (security scheme `ApiKeyAuth`, header `Authorization`)
 *   Rate limit: 30 requests per hour
 *
 * Spec: https://docs.postiz.com/public-api/openapi.json (operationId `uploadFile`; servers: Cloud
 * https://api.postiz.com/public/v1, self-hosted https://{your-domain}/api/public/v1). `apiBase` comes already
 * normalized from `normalizePostizBase` (src/postiz-url.ts).
 *
 * Failures are reported as `PostizError`s whose messages are safe to show: they never contain the API key, the
 * request URL or the response body. Callers turn them into a `postiz_error` warning; they never fail a tool.
 */

export interface PostizFile {
  data: Buffer;
  filename: string;
  contentType: string;
}

/** The part of Postiz's `MediaFile` we use: `path` is the URL to attach to a post. */
export interface PostizUploaded {
  id: string;
  path: string;
}

export type PostizErrorCode = 'unauthorized' | 'rate_limited' | 'too_large' | 'rejected' | 'server' | 'network' | 'timeout' | 'bad_response';

export class PostizError extends Error {
  override readonly name = 'PostizError';
  constructor(
    readonly code: PostizErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PostizClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per request. Default 30 s. */
  timeoutMs?: number;
  /** Backoff before the single retry after a 429 when Postiz sends no `Retry-After`. Default 2 s. */
  retryBackoffMs?: number;
  /** A `Retry-After` longer than this is not waited for inside a tool call. Default 10 s. */
  maxRetryWaitMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PostizClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly maxRetryWaitMs: number;

  constructor(
    private readonly settings: PostizSettings,
    options: PostizClientOptions = {},
  ) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryBackoffMs = options.retryBackoffMs ?? 2000;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 10_000;
  }

  /** Whether the final graphics (compose_*) are uploaded automatically unless the call opts out. */
  get autoUpload(): boolean {
    return this.settings.autoUpload;
  }

  /** The endpoint, for startup logs and tests. */
  get uploadUrl(): string {
    return `${this.settings.apiBase}/upload`;
  }

  /** Upload one file. One retry (after a backoff) on HTTP 429; everything else fails right away. */
  async upload(file: PostizFile): Promise<PostizUploaded> {
    try {
      return await this.attempt(file);
    } catch (err) {
      if (!(err instanceof RateLimited)) throw err;
      if (err.waitMs > this.maxRetryWaitMs) throw err;
      await this.sleep(err.waitMs);
      return this.attempt(file);
    }
  }

  private async attempt(file: PostizFile): Promise<PostizUploaded> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.filename);

    let response: Response;
    try {
      response = await this.fetchFn(this.uploadUrl, {
        method: 'POST',
        headers: { Authorization: this.settings.apiKey, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new PostizError('timeout', 'Postiz took too long to answer the upload.');
      throw new PostizError('network', 'Could not reach Postiz (network error). Check POSTIZ_URL.');
    }

    if (response.ok) return parseUploaded(await readJson(response));

    // Drain the body so the connection can be reused; its content is never used or shown.
    await response.arrayBuffer().catch(() => undefined);
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new PostizError('unauthorized', `Postiz rejected the API key (HTTP ${status}). Check POSTIZ_API_KEY (Postiz > Settings > Public API).`);
    }
    if (status === 429) throw new RateLimited(retryAfterMs(response.headers.get('retry-after'), this.retryBackoffMs));
    if (status === 413) throw new PostizError('too_large', 'Postiz refused the file because it is too large (HTTP 413).');
    if (status >= 500) throw new PostizError('server', `Postiz had a server error (HTTP ${status}).`);
    throw new PostizError('rejected', `Postiz refused the upload (HTTP ${status}).`);
  }
}

/** Internal: a 429 that remembers how long Postiz asked us to wait. Its message is what callers see if the retry is not made. */
class RateLimited extends PostizError {
  constructor(readonly waitMs: number) {
    super('rate_limited', 'Postiz rate limit reached (the Public API allows 30 requests per hour). Try again later.');
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date; anything unreadable falls back to the default backoff. */
function retryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new PostizError('bad_response', 'Postiz answered with something that is not JSON.');
  }
}

function parseUploaded(json: unknown): PostizUploaded {
  if (json && typeof json === 'object') {
    const { id, path } = json as { id?: unknown; path?: unknown };
    if (typeof id === 'string' && id !== '' && typeof path === 'string' && path !== '') return { id, path };
  }
  throw new PostizError('bad_response', 'Postiz answered without a file id and path.');
}

export const IMAGE_CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg' } as const;
