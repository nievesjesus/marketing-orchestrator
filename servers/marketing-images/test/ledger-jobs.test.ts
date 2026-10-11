import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.js';

const limits = { dailyImages: 10, dailyUsd: 2, dailyRenders: 5 };
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

let ledger: Ledger | undefined;
afterEach(() => ledger?.close());

function make(clock: { now: number }): Ledger {
  ledger = new Ledger(':memory:', limits, () => clock.now);
  return ledger;
}

function newJob(l: Ledger, user = 'alice', usd = 0.4, images = 2) {
  const reservation = l.reserve(user, { images, usd });
  const job = l.createJob({ user, provider: 'fal', model: 'm', upstream: { handle: { ref: { a: 'b' } }, n: images }, requestSummary: { n: images }, reservationId: reservation.id, reservedUsd: usd });
  return { job, reservation };
}

describe('ledger jobs (DESIGN section 8)', () => {
  it('stores a job with its reservation still held, and reads it back for the owner only', () => {
    const clock = { now: T0 };
    const l = make(clock);
    const { job } = newJob(l);
    expect(job).toMatchObject({ user: 'alice', provider: 'fal', model: 'm', status: 'pending', reserved_usd: 0.4 });
    expect(job.upstream).toEqual({ handle: { ref: { a: 'b' } }, n: 2 });
    expect(l.getJob('alice', job.id)?.id).toBe(job.id);
    expect(l.getJob('bob', job.id)).toBeUndefined(); // jobs are scoped to the owner
    expect(l.getJob('alice', 'nope')).toBeUndefined();
    expect(l.quota('alice').images).toMatchObject({ reserved: 2, used: 0 });
  });

  it('completeJob settles the reservation (real cost) and stores the result; calling it again changes nothing', () => {
    const l = make({ now: T0 });
    const { job } = newJob(l);
    l.completeJob(job.id, { usd: 0.35, images: 2 }, { images: [{ url: 'u' }] });
    const done = l.getJob('alice', job.id)!;
    expect(done.status).toBe('done');
    expect((done.upstream.result as { images: unknown[] }).images).toHaveLength(1);
    expect(done.upstream.handle).toBeDefined(); // earlier fields are kept
    expect(l.quota('alice')).toMatchObject({ images: { used: 2, reserved: 0 }, usd: { used: 0.35, reserved: 0 } });
    l.completeJob(job.id, { usd: 99, images: 99 }, { images: [] });
    expect(l.quota('alice').usd.used).toBe(0.35);
  });

  it('failJob refunds the reservation and remembers the plain-language error', () => {
    const l = make({ now: T0 });
    const { job } = newJob(l);
    l.failJob(job.id, { code: 'provider_safety', message: 'declined', suggestion: 'rephrase' });
    const failed = l.getJob('alice', job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.upstream.error).toEqual({ code: 'provider_safety', message: 'declined', suggestion: 'rephrase' });
    expect(l.quota('alice').images).toMatchObject({ used: 0, reserved: 0, left: 10 });
    l.failJob(job.id, { code: 'again', message: 'x' }); // idempotent
    expect(l.getJob('alice', job.id)!.upstream.error).toMatchObject({ code: 'provider_safety' });
  });

  it('claimJob gives one caller the right to finish; a stale claim can be taken over; releaseClaim reopens the job', () => {
    const clock = { now: T0 };
    const l = make(clock);
    const { job } = newJob(l);
    expect(l.claimJob('bob', job.id)).toBe(false); // not the owner
    expect(l.claimJob('alice', job.id)).toBe(true);
    expect(l.claimJob('alice', job.id)).toBe(false); // someone is already finishing it
    expect(l.getJob('alice', job.id)!.status).toBe('finishing');
    clock.now += 3 * 60 * 1000;
    expect(l.claimJob('alice', job.id)).toBe(true); // the first claimer crashed
    l.releaseClaim(job.id);
    expect(l.getJob('alice', job.id)!.status).toBe('pending');
    expect(l.claimJob('alice', job.id)).toBe(true);
    l.completeJob(job.id, {}, { ok: true });
    expect(l.claimJob('alice', job.id)).toBe(false); // finished jobs cannot be claimed
  });

  it('updateJobUpstream merges fields', () => {
    const l = make({ now: T0 });
    const { job } = newJob(l);
    l.updateJobUpstream(job.id, { note: 'x' });
    expect(l.getJob('alice', job.id)!.upstream).toMatchObject({ note: 'x', n: 2 });
  });

  it('expireJobs: jobs older than 24 h expire and their reservation is refunded; old rows are purged later', () => {
    const clock = { now: T0 };
    const l = make(clock);
    const old = newJob(l, 'alice', 0.5, 3).job;
    clock.now += 23 * HOUR;
    const fresh = newJob(l, 'bob', 0.3, 1).job;
    clock.now += 2 * HOUR; // old job is now 25 h old, fresh one 2 h
    expect(l.expireJobs(24 * HOUR)).toEqual({ expired: 1, deleted: 0 });
    expect(l.getJob('alice', old.id)!.status).toBe('expired');
    expect(l.getJob('bob', fresh.id)!.status).toBe('pending');
    expect(l.quota('alice').images).toMatchObject({ reserved: 0, used: 0 });
    expect(l.quota('bob').images.reserved).toBe(1); // untouched
    clock.now += 24 * HOUR; // old job is now 49 h old
    expect(l.expireJobs(24 * HOUR).deleted).toBe(1);
    expect(l.getJob('alice', old.id)).toBeUndefined();
  });

  it('expireReservations (the hourly crash sweep) leaves reservations held by live jobs alone', () => {
    const clock = { now: T0 };
    const l = make(clock);
    const { job } = newJob(l, 'alice', 0.5, 3);
    l.reserve('alice', { images: 1, usd: 0.1 }); // a crashed request: no job
    clock.now += 2 * HOUR;
    expect(l.expireReservations(HOUR)).toBe(1);
    expect(l.quota('alice').images.reserved).toBe(3);
    l.failJob(job.id, { code: 'x', message: 'y' });
    expect(l.quota('alice').images.reserved).toBe(0);
  });

  it('nested transactions join the outer one: a failure inside completeJob rolls everything back', () => {
    const l = make({ now: T0 });
    const { job } = newJob(l);
    expect(() => l.completeJob(job.id, { usd: 0.3 }, { circular: BigInt(1) as unknown as number })).toThrow();
    expect(l.getJob('alice', job.id)!.status).toBe('pending');
    expect(l.quota('alice').images.reserved).toBe(2); // the reservation was not consumed
    expect(l.quota('alice').images.used).toBe(0);
  });
});
