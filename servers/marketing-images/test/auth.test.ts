import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenAuth } from '../src/auth.js';
import { OTHER_TOKEN, TEST_TOKEN, callTool, initialize, rawRequest, rpc, startTestServer } from './helpers.js';

describe('TokenAuth', () => {
  const auth = new TokenAuth([
    { name: 'alice', token: 'aaaaaaaaaaaaaaaa' },
    { name: 'bob', token: 'bbbbbbbbbbbbbbbb' },
  ]);

  it('maps a token to its user name', () => {
    expect(auth.authenticate('aaaaaaaaaaaaaaaa')).toBe('alice');
    expect(auth.authenticate('bbbbbbbbbbbbbbbb')).toBe('bob');
  });

  it('returns null for anything else', () => {
    for (const candidate of [undefined, '', 'aaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaa', 'AAAAAAAAAAAAAAAA', 'alice', 'x'.repeat(5000)]) {
      expect(auth.authenticate(candidate)).toBeNull();
    }
  });
});

describe('HTTP auth and routing', () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('an unknown token is a plain 404 (the endpoint is not revealed)', async () => {
    for (const method of ['POST', 'GET', 'DELETE']) {
      const res = await rawRequest(server.url, method, '/mcp/not-a-real-token');
      expect(res.status).toBe(404);
      expect(res.body.toString()).toBe('Not found');
    }
  });

  it('a missing token or extra path segments are 404', async () => {
    for (const path of ['/mcp', '/mcp/', '/mcp//', `/mcp/${TEST_TOKEN}/extra`, '/MCP/' + TEST_TOKEN, '/mcp']) {
      expect((await rawRequest(server.url, 'POST', path)).status, path).toBe(404);
    }
  });

  it('a valid token reaches the MCP handler and identifies the user', async () => {
    const res = await initialize(server.url, TEST_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.result.serverInfo.name).toBe('marketing-images');
    const other = await initialize(server.url, OTHER_TOKEN);
    expect(other.status).toBe(200);
  });

  it('a trailing slash after the token is accepted', async () => {
    const res = await fetch(`${server.url}/mcp/${TEST_TOKEN}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });

  it('stateless: GET/DELETE session operations are not offered, other verbs are 405 for a valid token', async () => {
    expect((await rawRequest(server.url, 'PUT', `/mcp/${TEST_TOKEN}`)).status).toBe(405);
    expect((await rawRequest(server.url, 'PATCH', `/mcp/${TEST_TOKEN}`)).status).toBe(405);
    // Per the SDK, stateless legacy serving answers GET (standalone SSE) and DELETE (terminate session) with 405.
    expect((await rawRequest(server.url, 'DELETE', `/mcp/${TEST_TOKEN}`)).status).toBe(405);
    const get = await fetch(`${server.url}/mcp/${TEST_TOKEN}`, { headers: { Accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
  });

  it('works without any session id between calls', async () => {
    const a = await rpc(server.url, TEST_TOKEN, 'tools/list');
    const b = await rpc(server.url, TEST_TOKEN, 'tools/list');
    expect(a.json.result.tools.map((t: { name: string }) => t.name)).toEqual(b.json.result.tools.map((t: { name: string }) => t.name));
  });

  it('logs the token NAME and never the token', async () => {
    await rawRequest(server.url, 'POST', '/mcp/wrong-token-should-not-appear');
    await callTool(server.url, TEST_TOKEN, 'list_templates', {});
    await callTool(server.url, OTHER_TOKEN, 'list_providers', {});
    const text = server.rawLogs.join('\n');
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain(OTHER_TOKEN);
    expect(text).not.toContain('wrong-token-should-not-appear');
    expect(text).not.toContain('/mcp/' + 'testtoken');
    const entries = server.logs;
    expect(entries.some((l) => l.msg === 'http_request' && l.user === 'alice' && l.route === '/mcp/:token')).toBe(true);
    expect(entries.some((l) => l.msg === 'tool_call' && l.tool === 'list_providers' && l.user === 'bob')).toBe(true);
    // unauthenticated requests are logged with a route label, without a user and without the path
    expect(entries.some((l) => l.msg === 'http_request' && l.status === 404 && l.user === undefined && l.route === '/mcp/:token')).toBe(true);
  });

  it('health check and unknown routes', async () => {
    const health = await fetch(`${server.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect((await rawRequest(server.url, 'POST', '/healthz')).status).toBe(405);
    expect((await rawRequest(server.url, 'GET', '/')).status).toBe(404);
    expect((await rawRequest(server.url, 'GET', '/admin')).status).toBe(404);
    expect((await fetch(`${server.url}/healthz`)).headers.get('referrer-policy')).toBe('no-referrer');
  });
});
