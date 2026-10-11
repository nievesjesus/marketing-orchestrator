import { createReadStream } from 'node:fs';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
// Official MCP TypeScript SDK, v2 line (stable since 2026-07-27): `@modelcontextprotocol/server`.
// A standalone Streamable HTTP server is `createMcpHandler(factory)` (stateless: a fresh McpServer per
// request, no sessions) wrapped for node:http with `toNodeHandler` from `@modelcontextprotocol/node`.
// Docs: https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md  ·  README: https://github.com/modelcontextprotocol/typescript-sdk
// (v1 `@modelcontextprotocol/sdk` + StreamableHTTPServerTransport is the legacy line, bug fixes only.)
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { AppContext } from './context.js';
import { serializeError } from './logger.js';
import { createMcpServer } from './mcp.js';

/**
 * HTTP surface (DESIGN section 2):
 *   POST|GET|DELETE /mcp/:token   MCP Streamable HTTP, stateless; unknown token -> 404
 *   GET|HEAD        /i/*          stored images (immutable cache, allow-listed paths only)
 *   GET|HEAD        /healthz      liveness
 * Everything else is 404. Logs use route labels, never raw paths (the path of /mcp/* IS the secret).
 */

type Route = 'mcp' | 'images' | 'health' | 'other';

interface Classified {
  route: Route;
  /** Raw (undecoded) token segment for `mcp`, or the path after `/i/` for `images`. */
  param: string;
}

function classify(pathname: string): Classified {
  if (pathname === '/healthz') return { route: 'health', param: '' };
  if (pathname.startsWith('/i/')) return { route: 'images', param: pathname.slice(3) };
  if (pathname.startsWith('/mcp/')) {
    const rest = pathname.slice(5).replace(/\/$/, '');
    if (rest !== '' && !rest.includes('/')) return { route: 'mcp', param: rest };
  }
  return { route: 'other', param: '' };
}

const ROUTE_LABEL: Record<Route, string> = { mcp: '/mcp/:token', images: '/i/*', health: '/healthz', other: 'other' };

function send(res: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

const notFound = (res: http.ServerResponse): void => send(res, 404, 'Not found');

export interface RunningServer {
  server: http.Server;
  /** Stop accepting requests and tear down the MCP handler. */
  close(): Promise<void>;
}

export function createHttpServer(ctx: AppContext): RunningServer {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      // authInfo is set by us after token verification (the SDK never verifies tokens itself).
      const user = authInfo?.clientId;
      if (!user) throw new Error('MCP request without an authenticated user');
      return createMcpServer(ctx, user);
    },
    { onerror: (err) => ctx.logger.warn('mcp_handler_error', serializeError(err)) },
  );
  const toNode = toNodeHandler(handler, { onerror: (err) => ctx.logger.error('mcp_adapter_error', serializeError(err)) });
  const isLoopbackBind = ['127.0.0.1', '::1', 'localhost'].includes(ctx.config.host);
  const hostGuard = isLoopbackBind ? localhostHostValidation() : null;

  const serveImage = async (req: http.IncomingMessage, res: http.ServerResponse, rawPath: string): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'Method not allowed');
    }
    let rel: string;
    try {
      rel = decodeURIComponent(rawPath);
    } catch {
      return notFound(res);
    }
    const file = await ctx.storage.open(rel);
    if (!file) return notFound(res);
    res.writeHead(200, {
      'Content-Type': file.contentType,
      'Content-Length': file.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    try {
      await pipeline(createReadStream(file.absPath), res);
    } catch {
      res.destroy();
    }
  };

  const serveMcp = async (req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<string | undefined> => {
    const user = ctx.auth.authenticate(token);
    if (!user) {
      notFound(res);
      return undefined;
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'POST, GET, DELETE');
      send(res, 405, 'Method not allowed');
      return user;
    }
    if (hostGuard && !hostGuard(req, res)) return user;
    // The SDK forwards `req.auth` as authInfo; the real token is deliberately not passed along.
    (req as http.IncomingMessage & { auth?: unknown }).auth = { token: '', clientId: user, scopes: [] };
    await toNode(req as never, res as never);
    return user;
  };

  const server = http.createServer((req, res) => {
    const started = Date.now();
    let route: Route = 'other';
    let user: string | undefined;
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.on('finish', () => {
      ctx.logger.info('http_request', {
        method: req.method,
        route: ROUTE_LABEL[route],
        status: res.statusCode,
        ms: Date.now() - started,
        ...(user ? { user } : {}),
      });
    });

    void (async () => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        return send(res, 400, 'Bad request');
      }
      const target = classify(pathname);
      route = target.route;

      switch (target.route) {
        case 'health':
          if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
          return send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json');
        case 'images':
          return serveImage(req, res, target.param);
        case 'mcp':
          user = await serveMcp(req, res, target.param);
          return;
        default:
          return notFound(res);
      }
    })().catch((err: unknown) => {
      ctx.logger.error('request_failed', { route: ROUTE_LABEL[route], ...serializeError(err) });
      if (!res.headersSent) send(res, 500, 'Internal server error');
      else res.destroy();
    });
  });

  // Keep-alive slightly above the usual 60 s proxy idle timeout (Coolify/Traefik, nginx) to avoid resets.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  return {
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await handler.close();
    },
  };
}
