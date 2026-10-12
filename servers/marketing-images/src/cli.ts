#!/usr/bin/env node
import path from 'node:path';
import { CliUsageError, USAGE, parseCliArgs } from './cli-args.js';
import { VERSION } from './version.js';

/**
 * The `marketing-images` command. Only light modules are imported statically so `--help` and `--version` answer
 * instantly; the server (sharp, satori, SQLite...) is loaded after the arguments and the env file are settled.
 *
 * Stdout rule: in stdio mode (the default) stdout carries only MCP frames. This file prints to stdout only for
 * `--help` and `--version`, which never start a server.
 */

const stderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/** `node:sqlite` still prints an ExperimentalWarning on import; drop that one line (other warnings pass through). */
function hideSqliteWarning(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const text = typeof warning === 'string' ? warning : warning.message;
    if ((type ?? (warning as Error).name) === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

async function main(): Promise<void> {
  let command;
  try {
    command = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliUsageError) {
      stderr(`marketing-images: ${err.message}\nRun "marketing-images --help" for usage.`);
      process.exit(2);
    }
    throw err;
  }
  if (command.kind === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (command.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  hideSqliteWarning();
  const { EnvFileError, loadEnv } = await import('./envfile.js');
  const { localHome } = await import('./config.js');
  const { reportFatal, runServer } = await import('./app.js');

  try {
    const loaded = loadEnv({ envFile: command.envFile, processEnv: process.env, warn: stderr });
    const env = loaded.env;
    if (command.dataDir) env.DATA_DIR = path.resolve(command.dataDir);
    if (command.port !== undefined) env.PORT = String(command.port);
    if (command.mode === 'http') {
      // Run from the command line (not from the container): keep data in the user's home and listen on loopback unless told otherwise.
      if (!env.DATA_DIR?.trim() && !env.MARKETING_IMAGES_HOME?.trim()) env.DATA_DIR = localHome(env);
      if (!env.HOST?.trim()) env.HOST = '127.0.0.1';
    }
    await runServer({ mode: command.mode, env, envFile: { file: loaded.file, names: loaded.names } });
  } catch (err) {
    if (err instanceof EnvFileError) {
      stderr(`marketing-images: ${err.message}`);
      process.exit(1);
    }
    reportFatal(err);
  }
}

main().catch((err: unknown) => {
  stderr(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
