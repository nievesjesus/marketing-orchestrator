import { afterEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { Ledger } from '../src/ledger.js';

const limits = { dailyImages: 5, dailyUsd: 1, dailyRenders: 3 };
const DAY1 = Date.UTC(2026, 9, 11, 12, 0, 0);

let ledger: Ledger | undefined;
afterEach(() => ledger?.close());

function make(now: () => number = () => DAY1, l = limits): Ledger {
  ledger = new Ledger(':memory:', l, now);
  return ledger;
}

describe('render cap (compose_post)', () => {
  it('counts renders and refuses past DAILY_RENDER_LIMIT with a user-facing error', () => {
    const l = make();
    expect(l.countRender('alice')).toEqual({ used: 1, limit: 3, left: 2 });
    l.countRender('alice');
    expect(l.countRender('alice').left).toBe(0);
    expect(() => l.countRender('alice')).toThrow(UserFacingError);
    try {
      l.countRender('alice');
    } catch (err) {
      expect((err as UserFacingError).code).toBe('render_limit');
      expect((err as UserFacingError).message).toMatch(/00:00 UTC/);
    }
    // another user is unaffected
    expect(l.countRender('bob').used).toBe(1);
  });

  it('resets at 00:00 UTC', () => {
    let now = DAY1;
    const l = make(() => now);
    for (let i = 0; i < 3; i += 1) l.countRender('alice');
    expect(() => l.countRender('alice')).toThrow(UserFacingError);
    now = Date.UTC(2026, 9, 12, 0, 0, 1);
    expect(l.countRender('alice').used).toBe(1);
  });

  it('a limit of 0 blocks everything', () => {
    const l = make(() => DAY1, { ...limits, dailyRenders: 0 });
    expect(() => l.countRender('alice')).toThrow(UserFacingError);
  });
});

describe('reserve / settle / release', () => {
  it('reserve counts against the cap before settling', () => {
    const l = make();
    l.reserve('alice', { images: 2, usd: 0.4 });
    const q = l.quota('alice');
    expect(q.images).toMatchObject({ used: 0, reserved: 2, left: 3 });
    expect(q.usd).toMatchObject({ used: 0, reserved: 0.4, left: 0.6 });
  });

  it('refuses over the image cap without touching anything', () => {
    const l = make();
    l.reserve('alice', { images: 4, usd: 0.1 });
    expect(() => l.reserve('alice', { images: 2, usd: 0.1 })).toThrow(/5 images/);
    expect(l.quota('alice').images.reserved).toBe(4);
  });

  it('refuses over the USD cap', () => {
    const l = make();
    l.reserve('alice', { images: 1, usd: 0.8 });
    try {
      l.reserve('alice', { images: 1, usd: 0.3 });
      expect.unreachable();
    } catch (err) {
      expect((err as UserFacingError).code).toBe('quota_usd');
      expect((err as UserFacingError).message).toMatch(/US\$1\.00/);
    }
  });

  it('settle books the real cost; without it the estimate is booked (never 0)', () => {
    const l = make();
    const a = l.reserve('alice', { images: 1, usd: 0.2 });
    l.settle(a.id, { usd: 0.35 });
    const b = l.reserve('alice', { images: 1, usd: 0.1 });
    l.settle(b.id); // estimate
    const c = l.reserve('alice', { images: 1, usd: 0.05 });
    l.settle(c.id, { usd: 0 }); // 0 is not a real cost: keep the estimate
    const q = l.quota('alice');
    expect(q.images).toMatchObject({ used: 3, reserved: 0 });
    expect(q.usd).toMatchObject({ used: 0.5, reserved: 0 });
  });

  it('settle can book fewer images than reserved', () => {
    const l = make();
    const r = l.reserve('alice', { images: 4, usd: 0.4 });
    l.settle(r.id, { images: 3 });
    expect(l.quota('alice').images.used).toBe(3);
  });

  it('release refunds the reservation and is idempotent', () => {
    const l = make();
    const r = l.reserve('alice', { images: 3, usd: 0.5 });
    l.release(r.id);
    l.release(r.id);
    expect(l.quota('alice').images).toMatchObject({ used: 0, reserved: 0, left: 5 });
  });

  it('settling twice or an unknown id throws (internal error, not user-facing)', () => {
    const l = make();
    const r = l.reserve('alice', { images: 1, usd: 0.1 });
    l.settle(r.id);
    expect(() => l.settle(r.id)).toThrow(/unknown or already settled/);
  });

  it('users are isolated and the day rolls over', () => {
    let now = DAY1;
    const l = make(() => now);
    l.settle(l.reserve('alice', { images: 5, usd: 0.5 }).id);
    expect(() => l.reserve('alice', { images: 1, usd: 0.1 })).toThrow(UserFacingError);
    expect(l.reserve('bob', { images: 1, usd: 0.1 }).user).toBe('bob');
    now = Date.UTC(2026, 9, 12, 0, 0, 0);
    expect(l.quota('alice').images.left).toBe(5);
    expect(l.reserve('alice', { images: 1, usd: 0.1 }).day).toBe('2026-10-12');
  });

  it('expireReservations frees budget held by crashed requests', () => {
    let now = DAY1;
    const l = make(() => now);
    l.reserve('alice', { images: 5, usd: 0.9 });
    now += 2 * 60 * 60 * 1000;
    expect(l.expireReservations(60 * 60 * 1000)).toBe(1);
    expect(l.quota('alice').images.left).toBe(5);
  });

  it('money is exact in micro-dollars (no float drift)', () => {
    const l = make(() => DAY1, { dailyImages: 100, dailyUsd: 1, dailyRenders: 10 });
    for (let i = 0; i < 10; i += 1) l.settle(l.reserve('alice', { images: 1, usd: 0.1 }).id);
    expect(l.quota('alice').usd).toMatchObject({ used: 1, left: 0 });
    expect(() => l.reserve('alice', { images: 1, usd: 0.0001 })).toThrow(UserFacingError);
  });
});
