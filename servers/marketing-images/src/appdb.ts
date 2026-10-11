import { mkdirSync } from 'node:fs';
import path from 'node:path';
// node:sqlite is built into Node >= 22.13 (see ledger.ts). Docs: https://nodejs.org/docs/latest-v22.x/api/sqlite.html
import { DatabaseSync } from 'node:sqlite';

/**
 * Opens the app database (`DATA_DIR/app.db`, WAL) for the templates and brands stores.
 * The ledger keeps its own connection to the same file; WAL plus `busy_timeout` let both write safely.
 */
export function openAppDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
