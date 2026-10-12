import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvFileError, defaultEnvFiles, loadEnv } from '../src/envfile.js';
import { tmpDir } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function sandbox(): { dir: string } {
  const t = tmpDir('mi-env-');
  cleanups.push(t.cleanup);
  return { dir: t.dir };
}

function writeEnv(file: string, content: string, mode = 0o600): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

const SECRET = 'fake-secret-value-should-never-be-logged-123';

describe('env file loading', () => {
  it('uses --env, and the process environment wins over the file', () => {
    const { dir } = sandbox();
    const file = writeEnv(path.join(dir, 'custom.env'), `GEMINI_API_KEY=${SECRET}\nRETENTION_DAYS=7\nFAL_KEY="quoted value"\n# comment\nexport LOG_LEVEL=debug\n`);
    const loaded = loadEnv({ envFile: file, processEnv: { RETENTION_DAYS: '14', PATH: '/bin' }, homeDir: dir });
    expect(loaded.file).toBe(file);
    expect(loaded.env.GEMINI_API_KEY).toBe(SECRET);
    expect(loaded.env.RETENTION_DAYS).toBe('14'); // process env wins
    expect(loaded.env.FAL_KEY).toBe('quoted value');
    expect(loaded.env.LOG_LEVEL).toBe('debug');
    expect(loaded.env.PATH).toBe('/bin');
    expect(loaded.names.sort()).toEqual(['FAL_KEY', 'GEMINI_API_KEY', 'LOG_LEVEL', 'RETENTION_DAYS']);
  });

  it('treats an empty process variable as unset', () => {
    const { dir } = sandbox();
    const file = writeEnv(path.join(dir, 'a.env'), 'FAL_KEY=from-file\n');
    expect(loadEnv({ envFile: file, processEnv: { FAL_KEY: '' }, homeDir: dir }).env.FAL_KEY).toBe('from-file');
  });

  it('does not change the process environment object it was given', () => {
    const { dir } = sandbox();
    const file = writeEnv(path.join(dir, 'a.env'), 'FAL_KEY=from-file\n');
    const processEnv: NodeJS.ProcessEnv = { A: '1' };
    loadEnv({ envFile: file, processEnv, homeDir: dir });
    expect(processEnv).toEqual({ A: '1' });
  });

  it('finds ~/.config/marketing-images/.env by default, and prefers $XDG_CONFIG_HOME', () => {
    const { dir } = sandbox();
    const home = path.join(dir, 'home');
    const xdg = path.join(dir, 'xdg');
    expect(loadEnv({ processEnv: {}, homeDir: home }).file).toBeNull();

    const homeFile = writeEnv(path.join(home, '.config', 'marketing-images', '.env'), 'FAL_KEY=home\n');
    expect(loadEnv({ processEnv: {}, homeDir: home }).file).toBe(homeFile);
    expect(loadEnv({ processEnv: {}, homeDir: home }).env.FAL_KEY).toBe('home');

    const xdgFile = writeEnv(path.join(xdg, 'marketing-images', '.env'), 'FAL_KEY=xdg\n');
    const both = loadEnv({ processEnv: { XDG_CONFIG_HOME: xdg }, homeDir: home });
    expect(both.file).toBe(xdgFile);
    expect(both.env.FAL_KEY).toBe('xdg');
    expect(defaultEnvFiles({ XDG_CONFIG_HOME: xdg }, home)).toEqual([xdgFile, homeFile]);
    // a relative XDG_CONFIG_HOME is ignored (the XDG spec says so)
    expect(defaultEnvFiles({ XDG_CONFIG_HOME: 'relative/dir' }, home)).toEqual([homeFile]);
  });

  it('expands a leading ~ in --env', () => {
    const { dir } = sandbox();
    const file = writeEnv(path.join(dir, 'conf', 'x.env'), 'FAL_KEY=tilde\n');
    expect(loadEnv({ envFile: '~/conf/x.env', processEnv: {}, homeDir: dir }).file).toBe(file);
  });

  it('fails clearly when an explicit --env file does not exist, naming only the path', () => {
    const { dir } = sandbox();
    const missing = path.join(dir, 'nope.env');
    expect(() => loadEnv({ envFile: missing, processEnv: {}, homeDir: dir })).toThrow(EnvFileError);
    expect(() => loadEnv({ envFile: missing, processEnv: {}, homeDir: dir })).toThrow(missing);
  });

  it.skipIf(process.platform === 'win32')('warns (does not refuse) when the file is readable by others, and never prints a value', () => {
    const { dir } = sandbox();
    const file = writeEnv(path.join(dir, 'open.env'), `GEMINI_API_KEY=${SECRET}\n`, 0o644);
    const warnings: string[] = [];
    const loaded = loadEnv({ envFile: file, processEnv: {}, homeDir: dir, warn: (m) => warnings.push(m) });
    expect(loaded.env.GEMINI_API_KEY).toBe(SECRET); // still loaded
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/chmod 600/);
    expect(warnings[0]).toContain('644');
    expect(warnings[0]).toContain(file);
    expect(warnings.join('\n')).not.toContain(SECRET);
  });

  it.skipIf(process.platform === 'win32')('is silent for a 0600 file', () => {
    const { dir } = sandbox();
    const file = writeEnv(path.join(dir, 'ok.env'), `GEMINI_API_KEY=${SECRET}\n`, 0o600);
    const warnings: string[] = [];
    loadEnv({ envFile: file, processEnv: {}, homeDir: dir, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it('error messages never contain values from the file', () => {
    const { dir } = sandbox();
    const file = writeEnv(path.join(dir, 'secrets.env'), `GEMINI_API_KEY=${SECRET}\n`);
    chmodSync(file, 0o000);
    try {
      loadEnv({ envFile: file, processEnv: {}, homeDir: dir });
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});
