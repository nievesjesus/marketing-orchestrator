import { describe, expect, it } from 'vitest';
import { CliUsageError, USAGE, parseCliArgs } from '../src/cli-args.js';

describe('marketing-images command line', () => {
  it('defaults to stdio with no arguments', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'run', mode: 'stdio' });
  });

  it('--stdio and --http pick the transport', () => {
    expect(parseCliArgs(['--stdio'])).toEqual({ kind: 'run', mode: 'stdio' });
    expect(parseCliArgs(['--http'])).toEqual({ kind: 'run', mode: 'http' });
  });

  it('reads --port, --env and --data-dir', () => {
    expect(parseCliArgs(['--http', '--port', '9090', '--env', '/etc/mi.env', '--data-dir', './data'])).toEqual({
      kind: 'run',
      mode: 'http',
      port: 9090,
      envFile: '/etc/mi.env',
      dataDir: './data',
    });
    expect(parseCliArgs(['--env=/x/.env'])).toEqual({ kind: 'run', mode: 'stdio', envFile: '/x/.env' });
    expect(parseCliArgs(['--http', '--port=0'])).toMatchObject({ port: 0 });
  });

  it('--help and --version (long and short) win over everything else', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['--http', '--help'])).toEqual({ kind: 'help' });
  });

  it.each([
    [['--stdio', '--http'], /one of --stdio or --http/],
    [['--port', '8080'], /only applies with --http/],
    [['--stdio', '--port', '8080'], /only applies with --http/],
    [['--http', '--port', 'abc'], /whole number/],
    [['--http', '--port', '70000'], /0 to 65535/],
    [['--http', '--port', '-1'], /./],
    [['--env'], /./],
    [['--env', ' '], /needs a path/],
    [['--env-file', '/x/.env'], /Unknown option '--env-file'/], // renamed: Node 22 intercepts --env-file
    [['--data-dir', ''], /needs a path/],
    [['--nope'], /Unknown option/],
    [['serve'], /Unexpected argument: serve/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it('the help text documents every flag and the stdout rule', () => {
    for (const flag of ['--stdio', '--http', '--port', '--env', '--data-dir', '--help', '--version']) expect(USAGE).toContain(flag);
    expect(USAGE).not.toContain('--env-file');
    expect(USAGE).toMatch(/stdout carries only MCP messages/);
    expect(USAGE).toContain('~/.config/marketing-images/.env');
  });
});
