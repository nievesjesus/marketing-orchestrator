import type { DatabaseSync } from 'node:sqlite';
import { openAppDb, transaction } from './appdb.js';
import type { FormatName } from './render/formats.js';

/**
 * Saved templates (DESIGN section 5.2): SQLite table `templates`, one row per (owner, name, version).
 * The owner is the access-token NAME of whoever saved it. Saving the same name again adds a version (old versions are kept);
 * deleting is a soft delete of every version. A template is visible to its owner, and to everyone when its LATEST version is `shared`.
 */

export interface VariableSpec {
  name: string;
  kind: 'text' | 'image';
  required: boolean;
  max_chars?: number | undefined;
  example?: string | undefined;
  description?: string | undefined;
}

export interface TemplateRecord {
  id: number;
  owner: string;
  name: string;
  version: number;
  description: string;
  html: string;
  variables: VariableSpec[];
  formats: FormatName[];
  tags: string[];
  shared: boolean;
  preview_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface SaveTemplateInput {
  name: string;
  description: string;
  html: string;
  variables: VariableSpec[];
  formats: FormatName[];
  tags: string[];
  shared: boolean;
}

/** Separate migration function: creates only this module's tables (the ledger's tables are not touched). */
export function migrateTemplates(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner          TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  version        INTEGER NOT NULL,
  description    TEXT    NOT NULL,
  html           TEXT    NOT NULL,
  variables_json TEXT    NOT NULL,
  formats_json   TEXT    NOT NULL,
  tags_json      TEXT    NOT NULL,
  shared         INTEGER NOT NULL DEFAULT 0,
  preview_url    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  UNIQUE (owner, name, version)
);
CREATE INDEX IF NOT EXISTS templates_shared ON templates (shared, name);
CREATE TABLE IF NOT EXISTS preview_cache (
  cache_key  TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
}

interface Row {
  id: number;
  owner: string;
  name: string;
  version: number;
  description: string;
  html: string;
  variables_json: string;
  formats_json: string;
  tags_json: string;
  shared: number;
  preview_url: string | null;
  created_at: number;
  updated_at: number;
}

function toRecord(row: Row): TemplateRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    version: row.version,
    description: row.description,
    html: row.html,
    variables: JSON.parse(row.variables_json) as VariableSpec[],
    formats: JSON.parse(row.formats_json) as FormatName[],
    tags: JSON.parse(row.tags_json) as string[],
    shared: row.shared === 1,
    preview_url: row.preview_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const LATEST = `deleted_at IS NULL AND version = (SELECT MAX(version) FROM templates t2 WHERE t2.owner = templates.owner AND t2.name = templates.name AND t2.deleted_at IS NULL)`;

export class TemplateStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = openAppDb(dbPath);
    migrateTemplates(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Create the next version of (owner, name). Versions keep counting after a delete, so (owner, name, version) stays unique. */
  save(owner: string, input: SaveTemplateInput): TemplateRecord {
    return transaction(this.db, () => {
      const max = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM templates WHERE owner = ? AND name = ?').get(owner, input.name) as { v: number };
      const version = max.v + 1;
      const t = this.now();
      const result = this.db
        .prepare(
          `INSERT INTO templates (owner, name, version, description, html, variables_json, formats_json, tags_json, shared, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(owner, input.name, version, input.description, input.html, JSON.stringify(input.variables), JSON.stringify(input.formats), JSON.stringify(input.tags), input.shared ? 1 : 0, t, t);
      const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as Row;
      return toRecord(row);
    });
  }

  /** One of the owner's own templates: the latest version, or a specific one. */
  getOwn(owner: string, name: string, version?: number): TemplateRecord | undefined {
    const row = (
      version === undefined
        ? this.db.prepare(`SELECT * FROM templates WHERE owner = ? AND name = ? AND ${LATEST}`).get(owner, name)
        : this.db.prepare('SELECT * FROM templates WHERE owner = ? AND name = ? AND version = ? AND deleted_at IS NULL').get(owner, name, version)
    ) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /**
   * What `viewer` gets for a reference: `name` (own first, then shared by anyone, most recently updated first) or `owner/name`
   * (that owner's template if it is the viewer's own or shared). Other owners' private templates are never returned.
   */
  find(viewer: string, ref: string): TemplateRecord | undefined {
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const owner = ref.slice(0, slash);
      const name = ref.slice(slash + 1);
      const found = this.getOwn(owner, name);
      return found && (found.owner === viewer || found.shared) ? found : undefined;
    }
    const own = this.getOwn(viewer, ref);
    if (own) return own;
    const row = this.db.prepare(`SELECT * FROM templates WHERE name = ? AND shared = 1 AND ${LATEST} ORDER BY updated_at DESC, owner ASC LIMIT 1`).get(ref) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Latest version of every template the viewer may see: own, plus shared by others. */
  list(viewer: string): TemplateRecord[] {
    const rows = this.db.prepare(`SELECT * FROM templates WHERE (owner = ? OR shared = 1) AND ${LATEST} ORDER BY name ASC, owner ASC`).all(viewer) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Soft-delete every version of one of the owner's templates. Returns how many versions were removed. */
  delete(owner: string, name: string): number {
    const result = this.db.prepare('UPDATE templates SET deleted_at = ? WHERE owner = ? AND name = ? AND deleted_at IS NULL').run(this.now(), owner, name);
    return Number(result.changes);
  }

  setPreviewUrl(id: number, url: string): void {
    this.db.prepare('UPDATE templates SET preview_url = ? WHERE id = ?').run(url, id);
  }

  /** Cached catalog previews (built-in templates): key -> public URL. */
  getCachedPreview(key: string): string | undefined {
    const row = this.db.prepare('SELECT url FROM preview_cache WHERE cache_key = ?').get(key) as { url: string } | undefined;
    return row?.url;
  }

  setCachedPreview(key: string, url: string): void {
    this.db.prepare('INSERT INTO preview_cache (cache_key, url, created_at) VALUES (?, ?, ?) ON CONFLICT (cache_key) DO UPDATE SET url = excluded.url, created_at = excluded.created_at').run(key, url, this.now());
  }
}
