// Tool errors are results with isError: true (the model can read and react): https://ts.sdk.modelcontextprotocol.io/v2/servers/errors.md
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { isUserFacingError } from '../errors.js';
import { serializeError } from '../logger.js';

/** Extra fields a tool adds to its single log line (never prompts' text, never tokens). */
export type LogMeta = Record<string, unknown>;

export function jsonResult(payload: unknown, extra: CallToolResult['content'] = []): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }, ...extra] };
}

/**
 * Runs a tool, writes the one-line JSON call log (DESIGN section 10) and turns errors into plain tool errors:
 * user-facing errors show their message; anything else becomes a generic message (details only in the log).
 */
export async function runTool(
  ctx: AppContext,
  user: string,
  tool: string,
  fn: (meta: LogMeta) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = Date.now();
  const meta: LogMeta = {};
  try {
    const result = await fn(meta);
    ctx.logger.info('tool_call', { tool, user, ...meta, ms: Date.now() - started, outcome: 'ok' });
    return result;
  } catch (err) {
    if (isUserFacingError(err)) {
      ctx.logger.info('tool_call', { tool, user, ...meta, ms: Date.now() - started, outcome: 'refused', error_code: err.code });
      return { isError: true, content: [{ type: 'text', text: err.toToolText() }] };
    }
    ctx.logger.error('tool_call', { tool, user, ...meta, ms: Date.now() - started, outcome: 'error', error_code: 'internal', ...serializeError(err) });
    return {
      isError: true,
      content: [{ type: 'text', text: 'Something went wrong on the server while doing that. Nothing was published. Please try again in a moment.' }],
    };
  }
}
