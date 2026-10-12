import { PassThrough } from 'node:stream';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig, LOCAL_USER, type Config } from '../src/config.js';
import { createContext, type AppContext, type ContextOverrides } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { createMcpServer } from '../src/mcp.js';
import { fonts, tmpDir } from './helpers.js';

type Frame = { jsonrpc?: string; id?: number; result?: any; error?: any; method?: string };

export interface StdioHarness {
  ctx: AppContext;
  config: Config;
  dataDir: string;
  rawLogs: string[];
  /** Every line the server wrote to its stdout, parsed (the real stdout is the protocol channel). */
  frames: Frame[];
  rpc(method: string, params?: unknown): Promise<Frame>;
  call(name: string, args: unknown): Promise<{ isError?: boolean; content: any[] }>;
  close(): Promise<void>;
}

/**
 * The stdio server wired to in-memory streams instead of the process stdio: same `serveStdio` + `createMcpServer`
 * the CLI uses, but in this process so tests can mock `fetch` and inspect the context.
 */
export async function startStdioHarness(options: { env?: Record<string, string>; overrides?: ContextOverrides } = {}): Promise<StdioHarness> {
  const { dir, cleanup } = tmpDir('mi-stdio-');
  const config = loadConfig({ DATA_DIR: dir, NODE_ENV: 'test', ...options.env }, { mode: 'stdio', homeDir: dir });
  const rawLogs: string[] = [];
  const logger = createLogger({ sink: (line) => rawLogs.push(line) });
  const ctx = createContext(config, logger, { fonts: fonts(), ...options.overrides });

  const input = new PassThrough();
  const output = new PassThrough();
  const handle = serveStdio(() => createMcpServer(ctx, LOCAL_USER), { transport: new StdioServerTransport(input, output) });

  const frames: Frame[] = [];
  const waiting = new Map<number, (frame: Frame) => void>();
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as Frame;
      frames.push(frame);
      if (typeof frame.id === 'number') waiting.get(frame.id)?.(frame);
    }
  });

  let nextId = 1;
  const rpc = (method: string, params?: unknown): Promise<Frame> => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest-stdio', version: '0' } });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    ctx,
    config,
    dataDir: dir,
    rawLogs,
    frames,
    rpc,
    async call(name, args) {
      const res = await rpc('tools/call', { name, arguments: args });
      if (res.error) throw new Error(`rpc error: ${JSON.stringify(res.error)}`);
      return res.result;
    },
    async close() {
      input.end();
      await handle.close().catch(() => undefined);
      ctx.ledger.close();
      ctx.templates.close();
      ctx.brands.close();
      ctx.owners.close();
      cleanup();
    },
  };
}

export const textOf = (result: { content: { type: string; text?: string }[] }): string => result.content.find((c) => c.type === 'text')?.text ?? '';
export const jsonOf = (result: { content: { type: string; text?: string }[] }): any => JSON.parse(textOf(result));
