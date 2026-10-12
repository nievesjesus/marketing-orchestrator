import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Image storage (DESIGN section 4). `Storage` is the seam for a future
 * S3-compatible adapter (R2/MinIO): such an adapter would return direct URLs
 * and make `open()` return null (the `/i/*` route is then unused).
 */

export type ImageExt = 'png' | 'jpg';

export interface StoredImage {
  /** Storage-relative key, e.g. `2026/10/<uuid>.png`. */
  key: string;
  /** Public HTTPS URL to hand to Postiz `uploadFromUrlTool` (a `file://` URL in local stdio mode without PUBLIC_BASE_URL). */
  url: string;
  bytes: number;
  contentType: string;
}

export interface PublicFile {
  absPath: string;
  size: number;
  contentType: string;
}

export interface SweepResult {
  deleted: number;
  bytes: number;
}

export interface Storage {
  put(data: Buffer, ext: ImageExt): Promise<StoredImage>;
  /** Resolve a public `/i/<relativePath>` request to a file, or null if it does not exist or is not allowed. */
  open(relativePath: string): Promise<PublicFile | null>;
  /** Delete files older than the retention window. */
  sweep(): Promise<SweepResult>;
  /** Absolute path of a stored key on this machine, or null for storages that are not on a local disk. */
  localPath(key: string): string | null;
  /** The storage key of one of OUR image links (`<base>/i/<key>` or a `file://` URL inside the store), else null. */
  keyForUrl(url: string): string | null;
  /** The storage key of an absolute file path inside the store, else null. Lexical check only: `open()` re-checks real paths. */
  keyForPath(absPath: string): string | null;
}

const CONTENT_TYPES: Record<ImageExt, string> = { png: 'image/png', jpg: 'image/jpeg' };

/** Strict allow-list: only `{yyyy}/{mm}/{uuid}.{png|jpg}` can ever be served. */
const PUBLIC_PATH_RE =
  /^(\d{4})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg)$/;

const STALE_TEMP_MS = 60 * 60 * 1000;

export interface LocalStorageOptions {
  /** `DATA_DIR`; images live under `<dataDir>/images`. */
  dataDir: string;
  /** Base of the image links; null means `file://` URLs (local stdio mode). */
  publicBaseUrl: string | null;
  retentionDays: number;
  now?: () => number;
}

export class LocalStorage implements Storage {
  private readonly root: string;
  private readonly now: () => number;

  constructor(private readonly options: LocalStorageOptions) {
    this.root = path.join(path.resolve(options.dataDir), 'images');
    this.now = options.now ?? Date.now;
  }

  async put(data: Buffer, ext: ImageExt): Promise<StoredImage> {
    const date = new Date(this.now());
    const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const id = randomUUID();
    const key = `${yyyy}/${mm}/${id}.${ext}`;
    const dir = path.join(this.root, yyyy, mm);
    await mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, `${id}.${ext}`);
    const tempPath = path.join(dir, `.tmp-${id}`);
    await writeFile(tempPath, data, { mode: 0o644 });
    await rename(tempPath, finalPath);
    return {
      key,
      url: this.options.publicBaseUrl ? `${this.options.publicBaseUrl}/i/${key}` : pathToFileURL(finalPath).href,
      bytes: data.length,
      contentType: CONTENT_TYPES[ext],
    };
  }

  localPath(key: string): string | null {
    return PUBLIC_PATH_RE.test(key) ? path.join(this.root, key) : null;
  }

  keyForUrl(url: string): string | null {
    const base = this.options.publicBaseUrl;
    if (base && url.startsWith(`${base}/i/`)) {
      const rel = url.slice(base.length + 3);
      return PUBLIC_PATH_RE.test(rel) ? rel : null;
    }
    if (url.startsWith('file:')) {
      try {
        return this.keyForPath(fileURLToPath(url));
      } catch {
        return null;
      }
    }
    return null;
  }

  keyForPath(absPath: string): string | null {
    if (!path.isAbsolute(absPath)) return null;
    const normalized = path.normalize(absPath);
    const roots = [this.root];
    try {
      const real = realpathSync(this.root);
      if (real !== this.root) roots.push(real);
    } catch {
      // The store does not exist yet: nothing can be inside it.
    }
    for (const root of roots) {
      const prefix = root + path.sep;
      if (normalized.startsWith(prefix)) {
        const rel = normalized.slice(prefix.length).split(path.sep).join('/');
        return PUBLIC_PATH_RE.test(rel) ? rel : null;
      }
    }
    return null;
  }

  async open(relativePath: string): Promise<PublicFile | null> {
    const match = PUBLIC_PATH_RE.exec(relativePath);
    if (!match) return null;
    const ext = match[4] as ImageExt;
    const candidate = path.join(this.root, relativePath);
    try {
      // Resolve symlinks and re-check containment: defence in depth on top of the allow-list regex.
      const [realRoot, realFile] = await Promise.all([realpath(this.root), realpath(candidate)]);
      if (!realFile.startsWith(realRoot + path.sep)) return null;
      const info = await stat(realFile);
      if (!info.isFile()) return null;
      return { absPath: realFile, size: info.size, contentType: CONTENT_TYPES[ext] };
    } catch {
      return null;
    }
  }

  async sweep(): Promise<SweepResult> {
    const cutoff = this.now() - this.options.retentionDays * 24 * 60 * 60 * 1000;
    const tempCutoff = this.now() - STALE_TEMP_MS;
    let deleted = 0;
    let bytes = 0;

    const entries = async (dir: string, pattern: RegExp): Promise<string[]> => {
      try {
        return (await readdir(dir)).filter((name) => pattern.test(name));
      } catch {
        return [];
      }
    };

    for (const yyyy of await entries(this.root, /^\d{4}$/)) {
      const yearDir = path.join(this.root, yyyy);
      for (const mm of await entries(yearDir, /^\d{2}$/)) {
        const monthDir = path.join(yearDir, mm);
        for (const name of await entries(monthDir, /^(\.tmp-)?[0-9a-f-]{36}(\.(png|jpg))?$/)) {
          const file = path.join(monthDir, name);
          try {
            const info = await stat(file);
            if (!info.isFile()) continue;
            const limit = name.startsWith('.tmp-') ? tempCutoff : cutoff;
            if (info.mtimeMs < limit) {
              await unlink(file);
              deleted += 1;
              bytes += info.size;
            }
          } catch {
            // Already gone or unreadable: ignore, the next sweep retries.
          }
        }
        try {
          await rmdir(monthDir); // only succeeds when empty
        } catch {
          // not empty
        }
      }
      try {
        await rmdir(yearDir);
      } catch {
        // not empty
      }
    }
    return { deleted, bytes };
  }
}
