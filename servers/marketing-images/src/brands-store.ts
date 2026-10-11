import type { DatabaseSync } from 'node:sqlite';
import { openAppDb, transaction } from './appdb.js';

/**
 * Saved brands: SQLite table `brands`, one row per (owner, slug, version); `data_json` holds the brand data
 * (colors, fonts, stored asset references, style, voice). Same ownership rules as templates: the owner is the access-token NAME,
 * saving again adds a version, delete is soft, a brand is visible to its owner and, when its latest version is `shared`, to everyone.
 */

export interface BrandRecord {
  id: number;
  owner: string;
  slug: string;
  version: number;
  display_name: string;
  data: unknown;
  shared: boolean;
  preview_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface SaveBrandInput {
  slug: string;
  display_name: string;
  data: unknown;
  shared: boolean;
}

/** Separate migration function: creates only this module's table. */
export function migrateBrands(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS brands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner        TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  display_name TEXT    NOT NULL,
  data_json    TEXT    NOT NULL,
  shared       INTEGER NOT NULL DEFAULT 0,
  preview_url  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  UNIQUE (owner, slug, version)
);
CREATE INDEX IF NOT EXISTS brands_shared ON brands (shared, slug);
`);
}

interface Row {
  id: number;
  owner: string;
  slug: string;
  version: number;
  display_name: string;
  data_json: string;
  shared: number;
  preview_url: string | null;
  created_at: number;
  updated_at: number;
}

const toRecord = (row: Row): BrandRecord => ({
  id: row.id,
  owner: row.owner,
  slug: row.slug,
  version: row.version,
  display_name: row.display_name,
  data: JSON.parse(row.data_json) as unknown,
  shared: row.shared === 1,
  preview_url: row.preview_url,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const LATEST = `deleted_at IS NULL AND version = (SELECT MAX(version) FROM brands b2 WHERE b2.owner = brands.owner AND b2.slug = brands.slug AND b2.deleted_at IS NULL)`;

export class BrandStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = openAppDb(dbPath);
    migrateBrands(this.db);
  }

  close(): void {
    this.db.close();
  }

  save(owner: string, input: SaveBrandInput): BrandRecord {
    return transaction(this.db, () => {
      const max = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM brands WHERE owner = ? AND slug = ?').get(owner, input.slug) as { v: number };
      const t = this.now();
      const result = this.db
        .prepare('INSERT INTO brands (owner, slug, version, display_name, data_json, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(owner, input.slug, max.v + 1, input.display_name, JSON.stringify(input.data), input.shared ? 1 : 0, t, t);
      return toRecord(this.db.prepare('SELECT * FROM brands WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as Row);
    });
  }

  getOwn(owner: string, slug: string, version?: number): BrandRecord | undefined {
    const row = (
      version === undefined
        ? this.db.prepare(`SELECT * FROM brands WHERE owner = ? AND slug = ? AND ${LATEST}`).get(owner, slug)
        : this.db.prepare('SELECT * FROM brands WHERE owner = ? AND slug = ? AND version = ? AND deleted_at IS NULL').get(owner, slug, version)
    ) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** `slug` (own first, then shared, most recently updated first) or `owner/slug`. Never returns another owner's private brand. */
  find(viewer: string, ref: string): BrandRecord | undefined {
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const found = this.getOwn(ref.slice(0, slash), ref.slice(slash + 1));
      return found && (found.owner === viewer || found.shared) ? found : undefined;
    }
    const own = this.getOwn(viewer, ref);
    if (own) return own;
    const row = this.db.prepare(`SELECT * FROM brands WHERE slug = ? AND shared = 1 AND ${LATEST} ORDER BY updated_at DESC, owner ASC LIMIT 1`).get(ref) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(viewer: string): BrandRecord[] {
    const rows = this.db.prepare(`SELECT * FROM brands WHERE (owner = ? OR shared = 1) AND ${LATEST} ORDER BY slug ASC, owner ASC`).all(viewer) as unknown as Row[];
    return rows.map(toRecord);
  }

  delete(owner: string, slug: string): number {
    const result = this.db.prepare('UPDATE brands SET deleted_at = ? WHERE owner = ? AND slug = ? AND deleted_at IS NULL').run(this.now(), owner, slug);
    return Number(result.changes);
  }

  setPreviewUrl(id: number, url: string): void {
    this.db.prepare('UPDATE brands SET preview_url = ? WHERE id = ?').run(url, id);
  }
}
