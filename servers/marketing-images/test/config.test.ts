import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, configSecrets, loadConfig, parseAccessTokens } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { VERSION } from '../src/version.js';

const TOKENS = 'alice:aaaaaaaaaaaaaaaa,bob:bbbbbbbbbbbbbbbb';

describe('ACCESS_TOKENS', () => {
  it('parses name:token pairs', () => {
    expect(parseAccessTokens(TOKENS)).toEqual([
      { name: 'alice', token: 'aaaaaaaaaaaaaaaa' },
      { name: 'bob', token: 'bbbbbbbbbbbbbbbb' },
    ]);
    expect(parseAccessTokens(' alice:aaaaaaaaaaaaaaaa , ')).toHaveLength(1);
  });

  it.each([
    [undefined, /required/],
    ['', /required/],
    ['justatoken', /name:token/],
    ['alice:', /name:token/],
    [':token', /name:token/],
    ['al ice:aaaaaaaaaaaaaaaa', /names may only/],
    ['alice:short', /8-200/],
    ['alice:aaaa/aaaa/aaaa', /URL-safe/],
    ['alice:aaaaaaaaaaaaaaaa,alice:bbbbbbbbbbbbbbbb', /duplicate name/],
    ['alice:aaaaaaaaaaaaaaaa,bob:aaaaaaaaaaaaaaaa', /reuses a token/],
  ])('rejects %j', (raw, message) => {
    expect(() => parseAccessTokens(raw as string | undefined)).toThrow(message);
  });

  it('never puts token values in error messages', () => {
    for (const raw of ['alice:short', 'alice:aaaaaaaaaaaaaaaa,bob:aaaaaaaaaaaaaaaa', 'alice:aaaa/aaaa/aaaa']) {
      try {
        parseAccessTokens(raw);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).not.toMatch(/aaaa|short/);
      }
    }
  });
});

describe('loadConfig defaults (DESIGN section 11)', () => {
  const config = loadConfig({ ACCESS_TOKENS: TOKENS });

  it('uses the documented defaults', () => {
    expect(config.port).toBe(8080);
    expect(config.dataDir).toBe('/data');
    expect(config.retentionDays).toBe(30);
    expect(config.limits).toEqual({ dailyImages: 30, dailyUsd: 3, dailyRenders: 200 });
    expect(config.syncWaitMs).toBe(60_000);
    expect(config.publicBaseUrl).toBe('http://localhost:8080');
    expect(config.keys).toEqual({});
    expect(config.host).toBe('0.0.0.0');
    expect(config.nodeEnv).toBe('production');
    expect(config.allowInsecureLocalhost).toBe(false);
  });

  it('reads overrides, trims the base URL and detects provider keys', () => {
    const c = loadConfig({
      ACCESS_TOKENS: TOKENS,
      PORT: '9000',
      PUBLIC_BASE_URL: 'https://image-mcp.example.com/',
      DATA_DIR: '/tmp/x',
      RETENTION_DAYS: '7',
      DAILY_IMAGE_LIMIT: '10',
      DAILY_USD_LIMIT: '1.5',
      DAILY_RENDER_LIMIT: '50',
      SYNC_WAIT_MS: '30000',
      GEMINI_API_KEY: 'fake-gemini',
      FAL_KEY: ' fake-fal ',
      NODE_ENV: 'development',
    });
    expect(c.port).toBe(9000);
    expect(c.publicBaseUrl).toBe('https://image-mcp.example.com');
    expect(c.retentionDays).toBe(7);
    expect(c.limits).toEqual({ dailyImages: 10, dailyUsd: 1.5, dailyRenders: 50 });
    expect(c.keys).toEqual({ gemini: 'fake-gemini', fal: 'fake-fal' });
    expect(c.allowInsecureLocalhost).toBe(true);
    expect(c.host).toBe('127.0.0.1'); // dev binds loopback unless HOST says otherwise
  });

  it('rejects invalid values without echoing secrets', () => {
    expect(() => loadConfig({ ACCESS_TOKENS: TOKENS, PORT: 'abc' })).toThrow(/PORT must be a number/);
    expect(() => loadConfig({ ACCESS_TOKENS: TOKENS, DAILY_IMAGE_LIMIT: '1.5' })).toThrow(/whole number/);
    expect(() => loadConfig({ ACCESS_TOKENS: TOKENS, RETENTION_DAYS: '0' })).toThrow(/at least 1/);
    expect(() => loadConfig({ ACCESS_TOKENS: TOKENS, PUBLIC_BASE_URL: 'ftp://x' })).toThrow(/http/);
    expect(() => loadConfig({ ACCESS_TOKENS: TOKENS, PUBLIC_BASE_URL: 'https://user:pw@x.com' })).toThrow(/credentials/);
    expect(() => loadConfig({ ACCESS_TOKENS: TOKENS, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('lists every secret for log masking', () => {
    const c = loadConfig({ ACCESS_TOKENS: TOKENS, GEMINI_API_KEY: 'fake-gemini-key' });
    expect(configSecrets(c).sort()).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'fake-gemini-key']);
  });
});

describe('logger', () => {
  it('writes one JSON line per event and masks registered secrets', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), secrets: ['supersecret-token'] });
    log.info('hello', { user: 'alice', note: 'path /mcp/supersecret-token/x' });
    log.debug('hidden');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('supersecret-token');
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: 'info', msg: 'hello', user: 'alice' });
  });

  it('respects the level', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), level: 'warn' });
    log.info('no');
    log.warn('yes');
    expect(lines).toHaveLength(1);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
