import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
// node:sqlite is built into Node >= 22.13 and needs no flag (still "active development", so the
// ExperimentalWarning is silenced via --disable-warning in the npm scripts / Dockerfile).
// Docs: https://nodejs.org/docs/latest-v22.x/api/sqlite.html
import { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from './errors.js';

/**
 * Cost and quota ledger (DESIGN section 9) on SQLite.
 *
 * Money is stored as integer micro-dollars so repeated additions never drift.
 * Days are UTC (`yyyy-mm-dd`); every quota resets at 00:00 UTC.
 *
 * Flow for paid calls (used from plan step 4):  reserve -> provider call -> settle | release.
 * Free renders (`compose_post`) only use `countRender`, a separate generous cap.
 */

export interface LedgerLimits {
  dailyImages: number;
  dailyUsd: number;
  dailyRenders: number;
}

export interface Quota {
  day: string;
  resets_at: string;
  images: { used: number; reserved: number; limit: number; left: number };
  usd: { used: number; reserved: number; limit: number; left: number };
  renders: { used: number; limit: number; left: number };
}

export interface ReserveRequest {
  images: number;
  usd: number;
}

export interface Reservation {
  id: string;
  user: string;
  day: string;
  images: number;
  usd: number;
}

export interface Settlement {
  /** Real cost reported by the provider. Missing or non-positive: the reserved estimate is booked (never 0). */
  usd?: number;
  /** Images actually produced. Defaults to the reserved count. */
  images?: number;
}

const MICROS = 1_000_000;
const toMicros = (usd: number): number => Math.round(usd * MICROS);
const fromMicros = (micros: number): number => micros / MICROS;
const formatUsd = (usd: number): string => `US$${usd.toFixed(2)}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  user    TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  images  INTEGER NOT NULL DEFAULT 0,
  usd_micros INTEGER NOT NULL DEFAULT 0,
  renders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, day)
);
CREATE TABLE IF NOT EXISTS reservations (
  id         TEXT    PRIMARY KEY,
  user       TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  images     INTEGER NOT NULL,
  usd_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_user_day ON reservations (user, day);
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT    PRIMARY KEY,
  user           TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  upstream       TEXT,
  request_summary TEXT,
  reservation_id TEXT,
  reserved_usd_micros INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs (user, created_at);
`;

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(
    dbPath: string,
    private readonly limits: LedgerLimits,
    now: () => number = Date.now,
  ) {
    this.now = now;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private resetsAt(): string {
    const d = new Date(this.now());
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private usageRow(user: string, day: string): { images: number; usd_micros: number; renders: number } {
    const row = this.db
      .prepare('SELECT images, usd_micros, renders FROM usage WHERE user = ? AND day = ?')
      .get(user, day) as { images: number; usd_micros: number; renders: number } | undefined;
    return row ?? { images: 0, usd_micros: 0, renders: 0 };
  }

  private reservedTotals(user: string, day: string): { images: number; usd_micros: number } {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(images), 0) AS images, COALESCE(SUM(usd_micros), 0) AS usd_micros FROM reservations WHERE user = ? AND day = ?',
      )
      .get(user, day) as { images: number; usd_micros: number };
    return row;
  }

  /** Read-only snapshot for `list_providers`. */
  quota(user: string): Quota {
    const day = this.today();
    const used = this.usageRow(user, day);
    const reserved = this.reservedTotals(user, day);
    const usdUsed = fromMicros(used.usd_micros);
    const usdReserved = fromMicros(reserved.usd_micros);
    return {
      day,
      resets_at: this.resetsAt(),
      images: {
        used: used.images,
        reserved: reserved.images,
        limit: this.limits.dailyImages,
        left: Math.max(0, this.limits.dailyImages - used.images - reserved.images),
      },
      usd: {
        used: round2(usdUsed),
        reserved: round2(usdReserved),
        limit: this.limits.dailyUsd,
        left: round2(Math.max(0, this.limits.dailyUsd - usdUsed - usdReserved)),
      },
      renders: {
        used: used.renders,
        limit: this.limits.dailyRenders,
        left: Math.max(0, this.limits.dailyRenders - used.renders),
      },
    };
  }

  /**
   * Count one free render against `DAILY_RENDER_LIMIT` (atomic check-and-increment).
   * Throws a user-facing error when the cap is reached.
   */
  countRender(user: string): Quota['renders'] {
    const day = this.today();
    return this.transaction(() => {
      const used = this.usageRow(user, day).renders;
      if (used >= this.limits.dailyRenders) {
        throw new UserFacingError(
          'render_limit',
          `You've reached today's limit of ${this.limits.dailyRenders} composed graphics; it resets at 00:00 UTC.`,
          'Try again tomorrow, or ask the owner to raise the limit.',
        );
      }
      this.db
        .prepare(
          `INSERT INTO usage (user, day, renders) VALUES (?, ?, 1)
           ON CONFLICT (user, day) DO UPDATE SET renders = renders + 1`,
        )
        .run(user, day);
      const now = used + 1;
      return { used: now, limit: this.limits.dailyRenders, left: this.limits.dailyRenders - now };
    });
  }

  /**
   * Reserve budget before a paid provider call. Throws (and the caller must NOT call the provider)
   * when `used + reserved + request` would exceed the image or USD cap.
   */
  reserve(user: string, request: ReserveRequest): Reservation {
    const day = this.today();
    const reqMicros = toMicros(request.usd);
    return this.transaction(() => {
      const used = this.usageRow(user, day);
      const reserved = this.reservedTotals(user, day);

      if (used.images + reserved.images + request.images > this.limits.dailyImages) {
        throw new UserFacingError(
          'quota_images',
          `You've used today's ${this.limits.dailyImages} images; it resets at 00:00 UTC.`,
          'Use fewer images, or continue tomorrow.',
        );
      }
      if (used.usd_micros + reserved.usd_micros + reqMicros > toMicros(this.limits.dailyUsd)) {
        throw new UserFacingError(
          'quota_usd',
          `This request (about ${formatUsd(request.usd)}) would pass today's ${formatUsd(this.limits.dailyUsd)} budget (${formatUsd(fromMicros(used.usd_micros + reserved.usd_micros))} already used or reserved); it resets at 00:00 UTC.`,
          'Ask for fewer images or a cheaper model, or continue tomorrow.',
        );
      }

      const reservation: Reservation = {
        id: randomUUID(),
        user,
        day,
        images: request.images,
        usd: request.usd,
      };
      this.db
        .prepare(
          'INSERT INTO reservations (id, user, day, images, usd_micros, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(reservation.id, user, day, request.images, reqMicros, this.now());
      return reservation;
    });
  }

  /** Book the real outcome of a reservation into `usage` and delete the reservation. */
  settle(reservationId: string, actual: Settlement = {}): void {
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT user, day, images, usd_micros FROM reservations WHERE id = ?')
        .get(reservationId) as { user: string; day: string; images: number; usd_micros: number } | undefined;
      if (!row) throw new Error('settle: unknown or already settled reservation');
      const images = actual.images ?? row.images;
      const usdMicros = actual.usd !== undefined && actual.usd > 0 ? toMicros(actual.usd) : row.usd_micros;
      this.db
        .prepare(
          `INSERT INTO usage (user, day, images, usd_micros) VALUES (?, ?, ?, ?)
           ON CONFLICT (user, day) DO UPDATE SET images = images + excluded.images, usd_micros = usd_micros + excluded.usd_micros`,
        )
        .run(row.user, row.day, images, usdMicros);
      this.db.prepare('DELETE FROM reservations WHERE id = ?').run(reservationId);
    });
  }

  /** Refund a reservation (provider failure or safety refusal). Safe to call twice. */
  release(reservationId: string): void {
    this.db.prepare('DELETE FROM reservations WHERE id = ?').run(reservationId);
  }

  /** Drop reservations older than `maxAgeMs` (crashed requests). Returns how many were released. */
  expireReservations(maxAgeMs: number): number {
    const result = this.db.prepare('DELETE FROM reservations WHERE created_at < ?').run(this.now() - maxAgeMs);
    return Number(result.changes);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
