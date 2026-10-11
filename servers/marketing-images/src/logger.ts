/**
 * Structured JSON logger: one line per event on stdout.
 *
 * Secrets never belong in log fields. As a safety net the logger also masks
 * every registered secret (access tokens, API keys) if one slips into a
 * message or field. Log the token NAME, never the token.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Values to mask in every emitted line. Entries shorter than 6 chars are ignored. */
  secrets?: readonly string[];
  /** Where lines go. Defaults to stdout. */
  sink?: (line: string) => void;
}

export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return { error_name: err.name, error_message: err.message, error_stack: err.stack };
  }
  return { error_message: String(err) };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? 'info'];
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 6);
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const mask = (line: string): string => {
    let out = line;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    }
    return out;
  };

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    sink(mask(line));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
