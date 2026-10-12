import type { DatabaseSync } from 'node:sqlite';
import { openAppDb } from './appdb.js';

/**
 * Who made which stored image (table `image_owners` in `app.db`), so tools that take an image back
 * (`upload_to_postiz`) can check that it belongs to the caller. Also remembers the Postiz copy of an image so
 * it is not uploaded twice (Postiz's Public API allows only 30 requests per hour).
 *
 * Rows are pruned together with the files by the retention sweep.
 */

export interface PostizCopy {
  id: string;
  path: string;
}

export function migrateImageOwners(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS image_owners (
  key         TEXT PRIMARY KEY,
  owner       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  postiz_id   TEXT,
  postiz_path TEXT
);
CREATE INDEX IF NOT EXISTS image_owners_created ON image_owners (created_at);
`);
}

interface Row {
  owner: string;
  postiz_id: string | null;
  postiz_path: string | null;
}

export class ImageOwners {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, private readonly now: () => number = Date.now) {
    this.db = openAppDb(dbPath);
    migrateImageOwners(this.db);
  }

  record(key: string, owner: string): void {
    this.db.prepare('INSERT OR IGNORE INTO image_owners (key, owner, created_at) VALUES (?, ?, ?)').run(key, owner, this.now());
  }

  ownerOf(key: string): string | null {
    const row = this.db.prepare('SELECT owner FROM image_owners WHERE key = ?').get(key) as Pick<Row, 'owner'> | undefined;
    return row?.owner ?? null;
  }

  isOwnedBy(key: string, owner: string): boolean {
    return this.ownerOf(key) === owner;
  }

  setPostiz(key: string, copy: PostizCopy): void {
    this.db.prepare('UPDATE image_owners SET postiz_id = ?, postiz_path = ? WHERE key = ?').run(copy.id, copy.path, key);
  }

  getPostiz(key: string): PostizCopy | null {
    const row = this.db.prepare('SELECT postiz_id, postiz_path FROM image_owners WHERE key = ?').get(key) as Pick<Row, 'postiz_id' | 'postiz_path'> | undefined;
    return row?.postiz_id && row.postiz_path ? { id: row.postiz_id, path: row.postiz_path } : null;
  }

  /** Forget rows older than `maxAgeMs` (their files are gone by then). Returns how many were removed. */
  prune(maxAgeMs: number): number {
    const result = this.db.prepare('DELETE FROM image_owners WHERE created_at < ?').run(this.now() - maxAgeMs);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
