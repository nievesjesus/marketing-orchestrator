import { describe, expect, it } from 'vitest';
import { FALLBACK_KINDS, ProviderError, TRANSIENT_KINDS, kindFromStatus, providerError, sanitizeDetail, type ProviderErrorKind } from '../src/providers/errors.js';

const KINDS: ProviderErrorKind[] = ['not_configured', 'auth', 'credits', 'rate_limit', 'timeout', 'server', 'network', 'model_unavailable', 'safety', 'validation', 'bad_reference', 'no_image'];

describe('UserFacingError mapping table', () => {
  it('every kind has a plain message and a next step, mentions the provider by name and never a URL or a stack', () => {
    for (const kind of KINDS) {
      for (const provider of ['gemini', 'fal', 'leonardo'] as const) {
        const err = providerError(kind, provider, { alternatives: provider === 'gemini' ? ['fal'] : ['gemini'] });
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.code).toBe(`provider_${kind}`);
        expect(err.message.length).toBeGreaterThan(10);
        expect(err.toToolText()).not.toMatch(/https?:|\bat \w+\.|Error:/);
        expect(err.toToolText().length).toBeGreaterThan(err.message.length);
      }
    }
  });

  it('missing key: "X isn\'t set up on this server, try Y"', () => {
    expect(providerError('not_configured', 'leonardo', { alternatives: ['gemini', 'fal'] }).message).toBe("Leonardo isn't set up on this server, try Gemini or fal.ai instead.");
    expect(providerError('not_configured', 'fal').suggestion).toMatch(/FAL_KEY/);
  });

  it('auth / credits / rate limit suggest another provider when there is one, else something the owner or user can do', () => {
    expect(providerError('auth', 'gemini', { alternatives: ['fal'] }).suggestion).toBe('Try fal.ai instead.');
    expect(providerError('auth', 'gemini').suggestion).toMatch(/Ask the server owner.*GEMINI_API_KEY/);
    expect(providerError('credits', 'leonardo').message).toBe('Leonardo has run out of credits.');
    expect(providerError('credits', 'leonardo').suggestion).toMatch(/top up/);
    expect(providerError('rate_limit', 'fal', { alternatives: ['gemini'] }).suggestion).toBe('Wait a minute and retry, or try Gemini instead.');
    expect(providerError('rate_limit', 'fal').suggestion).toBe('Wait a minute and try again.');
  });

  it('safety refusals say plainly that the request is not retried elsewhere', () => {
    const err = providerError('safety', 'gemini');
    expect(err.message).toMatch(/declined to make this image for safety reasons/);
    expect(err.suggestion).toMatch(/not retried on another provider/);
  });

  it('bad reference links get an actionable hint', () => {
    expect(providerError('bad_reference', 'fal').suggestion).toMatch(/direct public link/);
  });
});

describe('fallback policy (DESIGN section 7)', () => {
  it('provider-side failures may fall back; safety refusals, validation errors and bad references never do', () => {
    for (const kind of ['not_configured', 'auth', 'credits', 'rate_limit', 'timeout', 'server', 'network', 'model_unavailable'] as const) expect(FALLBACK_KINDS.has(kind), kind).toBe(true);
    for (const kind of ['safety', 'validation', 'bad_reference', 'no_image'] as const) expect(FALLBACK_KINDS.has(kind), kind).toBe(false);
  });

  it('only temporary kinds are retried while waiting for a queued job', () => {
    expect([...TRANSIENT_KINDS].sort()).toEqual(['network', 'rate_limit', 'server', 'timeout']);
  });

  it('exposes a short reason for fallback_from', () => {
    expect(providerError('credits', 'leonardo').fallbackReason).toBe('out of credits');
    expect(providerError('timeout', 'gemini').fallbackReason).toBe('timed out');
  });

  it('status codes map to kinds', () => {
    const table: [number, ProviderErrorKind][] = [[401, 'auth'], [403, 'auth'], [402, 'credits'], [404, 'model_unavailable'], [408, 'timeout'], [429, 'rate_limit'], [500, 'server'], [504, 'timeout'], [400, 'validation'], [422, 'validation']];
    for (const [status, kind] of table) expect(kindFromStatus(status), String(status)).toBe(kind);
  });
});

describe('sanitizeDetail', () => {
  it('removes links, the given secrets and key-like tokens, collapses whitespace and caps the length', () => {
    const out = sanitizeDetail('Bad  request\nsee https://example.test/a?key=abc123 token=abcdefghijklmnop1234 and my-secret-key-123', ['my-secret-key-123']);
    expect(out).toBe('Bad request see [link] [redacted] and [redacted]');
    expect(sanitizeDetail('x'.repeat(500))!.length).toBeLessThanOrEqual(140);
    expect(sanitizeDetail('   ')).toBeUndefined();
    expect(sanitizeDetail(42)).toBeUndefined();
  });
});
