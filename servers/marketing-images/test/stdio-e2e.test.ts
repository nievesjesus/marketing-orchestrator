import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { tmpDir } from './helpers.js';

/**
 * The real CLI in a child process (through tsx, so no build is needed): this is what an MCP client launches.
 * stdout must carry only JSON-RPC frames; logs go to stderr; secrets from the env file appear nowhere.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'fake-gemini-key-from-env-file-do-not-leak';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

type Driver = (send: (message: object) => void, done: () => void, frames: any[]) => void;

/** Spawns the CLI. `drive` is called once at start and again after every complete stdout frame. */
function runCli(args: string[], env: Record<string, string>, drive?: Driver): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const frames: any[] = [];
    let buffer = '';
    const send = (message: object): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
    const done = (): void => void child.stdin.end();
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      buffer += d.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {
          // left for the assertions on `stdout`
        }
        drive?.(send, done, frames);
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    const guard = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
    if (drive) drive(send, done, frames);
    else child.stdin.end();
  });
}

function home(): { dir: string; env: Record<string, string> } {
  const t = tmpDir('mi-e2e-');
  cleanups.push(t.cleanup);
  return { dir: t.dir, env: { HOME: t.dir, MARKETING_IMAGES_HOME: path.join(t.dir, 'data') } };
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } };

describe('marketing-images --stdio (child process)', () => {
  it('speaks only JSON-RPC on stdout: initialize, tools/list and compose_post produce a real file', async () => {
    const { dir, env } = home();
    const envFile = path.join(dir, 'mi.env');
    writeFileSync(envFile, `GEMINI_API_KEY=${SECRET}\nDAILY_RENDER_LIMIT=7\n`);
    chmodSync(envFile, 0o600);

    let step = 0;
    const run = await runCli(['--stdio', '--env', envFile], env, (send, done, frames) => {
      if (step === 0) {
        step = 1;
        send(INITIALIZE);
      } else if (step === 1 && frames.some((f) => f.id === 1)) {
        step = 2;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'compose_post', arguments: { template: 'cta-card', format: 'square', texts: { headline: 'Hello from stdio' }, background: { color: '#1F3A5F' } } },
        });
      } else if (step === 2 && frames.some((f) => f.id === 2) && frames.some((f) => f.id === 3)) {
        step = 3;
        done(); // closing stdin is how a client stops the server
      }
    });

    expect(run.code).toBe(0);

    // stdout: every non-empty line is a JSON-RPC frame, nothing else
    const lines = run.stdout.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const frames = lines.map((l) => JSON.parse(l) as { jsonrpc?: string; id?: number; result?: any });
    for (const f of frames) expect(f.jsonrpc).toBe('2.0');
    expect(run.stdout).not.toContain('server_started');

    const init = frames.find((f) => f.id === 1)!.result;
    expect(init.serverInfo).toMatchObject({ name: 'marketing-images', version: VERSION });
    const tools = frames.find((f) => f.id === 2)!.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['compose_post', 'generate_image', 'upload_to_postiz']));

    const compose = frames.find((f) => f.id === 3)!.result;
    expect(compose.isError).toBeUndefined();
    const data = JSON.parse(compose.content.find((c: { type: string }) => c.type === 'text').text);
    expect(data.url).toMatch(/^file:\/\//);
    expect(existsSync(data.file_path)).toBe(true);
    expect(data.file_path.startsWith(path.join(env.MARKETING_IMAGES_HOME as string, 'images'))).toBe(true);
    expect(data.graphics_left_today).toBe(6); // DAILY_RENDER_LIMIT=7 came from the env file
    expect(data.width).toBe(1080);

    // stderr: structured logs, no secret values (the key came from the env file)
    expect(run.stderr).toContain('"server_started"');
    expect(run.stderr).toContain('"mode":"stdio"');
    expect(run.stderr).toContain('"gemini":true');
    expect(run.stdout + run.stderr).not.toContain(SECRET);
    expect(run.stderr).not.toContain('ExperimentalWarning');
  }, 120_000);

  it('the default (no flag) is stdio and picks up ~/.config/marketing-images/.env', async () => {
    const { dir, env } = home();
    const conf = path.join(dir, '.config', 'marketing-images');
    mkdirSync(conf, { recursive: true });
    writeFileSync(path.join(conf, '.env'), `FAL_KEY=${SECRET}\n`, { mode: 0o600 });
    let started = false;
    const run = await runCli([], env, (send, done, frames) => {
      if (!started) {
        started = true;
        send(INITIALIZE);
      } else if (frames.length > 0) done();
    });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('"fal":true');
    expect(run.stderr).toContain(path.join(conf, '.env'));
    expect(run.stdout + run.stderr).not.toContain(SECRET);
  }, 120_000);

  it('a missing --env file stops the server with our own exit code 1, names the path on stderr and prints nothing on stdout', async () => {
    const { dir, env } = home();
    const missing = path.join(dir, 'nope.env');
    const run = await runCli(['--env', missing], env);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('marketing-images: The env file was not found:');
    expect(run.stderr).toContain(missing);
  }, 60_000);

  it('--http without ACCESS_TOKENS is a configuration error on stderr (exit 1)', async () => {
    const { env } = home();
    const run = await runCli(['--http'], env);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/Configuration error: ACCESS_TOKENS is required/);
  }, 60_000);

  it('usage errors exit 2; --help and --version print on stdout and exit 0', async () => {
    const { env } = home();
    const bad = await runCli(['--stdio', '--http'], env);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/one of --stdio or --http/);

    const help = await runCli(['--help'], env);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Usage:/);
    expect(help.stdout).toContain('--env PATH');
    expect(help.stdout).not.toContain('--env-file');

    const version = await runCli(['--version'], env);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);
  }, 60_000);
});
