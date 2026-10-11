import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Image storage (DESIGN section 4). `Storage` is the seam for a future
 * S3-compatible adapter (R2/MinIO): such an adapter would return direct URLs
 * and make `open()` return null (the `/i/*` route is then unused).
 */

export type ImageExt = 'png' | 'jpg';

export interface StoredImage {
  /** Storage-relative key, e.g. `2026/10/<uuid>.png`. */
  key: string;
  /** Public HTTPS URL to hand to Postiz `uploadFromUrlTool`. */
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
}

const CONTENT_TYPES: Record<ImageExt, string> = { png: 'image/png', jpg: 'image/jpeg' };

/** Strict allow-list: only `{yyyy}/{mm}/{uuid}.{png|jpg}` can ever be served. */
const PUBLIC_PATH_RE =
  /^(\d{4})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg)$/;

const STALE_TEMP_MS = 60 * 60 * 1000;

export interface LocalStorageOptions {
  /** `DATA_DIR`; images live under `<dataDir>/images`. */
  dataDir: string;
  publicBaseUrl: string;
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
      url: `${this.options.publicBaseUrl}/i/${key}`,
      bytes: data.length,
      contentType: CONTENT_TYPES[ext],
    };
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
