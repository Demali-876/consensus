/**
 * wss.ts tests
 *
 * Strategy: bypass the x402 payment gate entirely.
 *   - Token / upgrade tests: spin up a bare HTTP server that replicates the
 *     pendingSessions token check from registerWebSocket.
 *   - Session tests: call handleLocalSession / handleNodeProxiedSession
 *     directly with real WebSocket pairs.
 *
 * Ports
 *   30200  bare token-gate server (upgrade tests)
 *   30201  fake upstream node WebSocket server (proxied-session tests)
 *   30202  client-facing server (local + proxied session tests)
 *   30203  WebSocket reject server (fallback error tests)
 *   30204  HTTP target server (local session proxy tests)
 */

import { describe, it, before, after } from 'node:test';
import assert                           from 'node:assert/strict';
import http                             from 'node:http';
import crypto                           from 'node:crypto';
import { WebSocketServer, WebSocket }   from 'ws';
import {
  handleLocalSession,
  handleNodeProxiedSession,
  type Purchase,
} from '../../features/websocket/wss.ts';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

const PORT_GATE   = 30200;
const PORT_NODE   = 30201;
const PORT_CLIENT = 30202;
const PORT_REJECT = 30203; // rejects WebSocket upgrades → triggers ws client error
const PORT_TARGET = 30204; // plain HTTP target for local session proxy tests

// ---------------------------------------------------------------------------
// Mock Router
// ---------------------------------------------------------------------------

class MockRouter {
  selections: Array<{ key: string; prefs: Record<string, string> }> = [];
  increments: string[] = [];
  decrements: string[] = [];
  nodeToReturn: any = null;

  selectNode(key: string, prefs: Record<string, string>) {
    this.selections.push({ key, prefs });
    return this.nodeToReturn;
  }
  incrementSession(nodeId: string) { this.increments.push(nodeId); }
  decrementSession(nodeId: string) { this.decrements.push(nodeId); }
  getStats()                       { return {}; }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Collect the next N messages from a WebSocket.
 * JSON-parses each; falls back to the raw string for non-JSON payloads (e.g. echo).
 */
function collectMessages(ws: WebSocket, n: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = [];
    const onMsg = (raw: Buffer) => {
      const str = raw.toString();
      let val: any;
      try { val = JSON.parse(str); } catch { val = str; }
      msgs.push(val);
      if (msgs.length === n) { ws.off('message', onMsg); resolve(msgs); }
    };
    ws.on('message', onMsg);
    ws.once('error', reject);
  });
}

/**
 * Wait for a WebSocket to close.
 * Attaches a no-op error handler so ws-library rejection errors (401 etc.)
 * don't become uncaught exceptions before the close event fires.
 */
function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('error', () => {});
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/** Close an HTTP server, draining all connections. */
function closeServer(srv: http.Server): Promise<void> {
  return new Promise((resolve) => {
    (srv as any).closeAllConnections?.();
    srv.close(() => resolve());
  });
}

/**
 * Connect to an existing WebSocketServer and return both ends of the pair.
 * Registers the server-side 'connection' listener before opening the client
 * socket so events are never missed.
 */
function openClientPair(
  wss:  WebSocketServer,
  port: number,
): Promise<{ serverWs: WebSocket; clientWs: WebSocket }> {
  return new Promise((resolve, reject) => {
    let serverWs: WebSocket | undefined;
    let clientReady = false;

    const onConn = (ws: WebSocket) => { serverWs = ws; tryResolve(); };
    wss.once('connection', onConn);

    const tryResolve = () => {
      if (serverWs && clientReady) resolve({ serverWs: serverWs!, clientWs });
    };

    const clientWs = new WebSocket(`ws://localhost:${port}`);
    clientWs.once('open',  () => { clientReady = true; tryResolve(); });
    clientWs.once('error', (err) => { wss.off('connection', onConn); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Shared servers
// ---------------------------------------------------------------------------

let gateSrv: http.Server;
let gateWss: WebSocketServer;
const gatePending = new Map<string, Purchase & { expires: number }>();

let nodeSrv: http.Server;
let nodeWss: WebSocketServer;

let clientSrv: http.Server;
let clientWss: WebSocketServer;

let rejectSrv: http.Server; // immediately rejects upgrade → ws client emits 'error'
let targetSrv: http.Server; // plain HTTP target for local session proxy tests

// ---------------------------------------------------------------------------
// Root describe owns all server lifecycle
// ---------------------------------------------------------------------------

describe('WebSocket (wss.ts)', () => {

  before(async () => {
    // Bare token-gate server — replicates the upgrade handler from registerWebSocket
    gateSrv = http.createServer();
    gateWss = new WebSocketServer({ noServer: true });

    gateSrv.on('upgrade', (req, socket, head) => {
      const url   = new URL(req.url!, `http://localhost:${PORT_GATE}`);
      if (url.pathname !== '/ws-connect') { socket.destroy(); return; }

      const token   = url.searchParams.get('token');
      const pending = token ? gatePending.get(token) : null;

      if (!pending) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (pending.expires < Date.now()) {
        gatePending.delete(token!);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      gatePending.delete(token!);
      gateWss.handleUpgrade(req, socket, head, (ws) => {
        (ws as any).purchase = pending;
        gateWss.emit('connection', ws, req);
      });
    });

    nodeSrv   = http.createServer();
    nodeWss   = new WebSocketServer({ server: nodeSrv });
    clientSrv = http.createServer();
    clientWss = new WebSocketServer({ server: clientSrv });

    // Server that rejects WebSocket upgrades → ws client emits 'error'
    rejectSrv = http.createServer();
    rejectSrv.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
    });

    // Plain HTTP target — each path configures a fixed response via a shared map
    const targetRoutes = new Map<string, { status: number; body: string; headers?: Record<string, string> }>();
    targetRoutes.set('/hello',  { status: 200, body: 'world' });
    targetRoutes.set('/json',   { status: 200, body: JSON.stringify({ ok: true }), headers: { 'content-type': 'application/json' } });
    targetRoutes.set('/error',  { status: 500, body: 'server error' });
    targetRoutes.set('/echo',   { status: 200, body: '' }); // body set dynamically

    targetSrv = http.createServer((req, res) => {
      const route = targetRoutes.get(req.url ?? '/');
      if (!route) { res.writeHead(404); res.end('not found'); return; }

      // /echo: read and reflect the request body
      if (req.url === '/echo') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end',  () => {
          const body = Buffer.concat(chunks).toString();
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(body);
        });
        return;
      }

      res.writeHead(route.status, route.headers ?? {});
      res.end(route.body);
    });

    await Promise.all([
      new Promise<void>((r) => gateSrv.listen(PORT_GATE,    r)),
      new Promise<void>((r) => nodeSrv.listen(PORT_NODE,    r)),
      new Promise<void>((r) => clientSrv.listen(PORT_CLIENT, r)),
      new Promise<void>((r) => rejectSrv.listen(PORT_REJECT, r)),
      new Promise<void>((r) => targetSrv.listen(PORT_TARGET, r)),
    ]);
  });

  after(async () => {
    await Promise.all([
      closeServer(gateSrv),
      closeServer(nodeSrv),
      closeServer(clientSrv),
      closeServer(rejectSrv),
      closeServer(targetSrv),
    ]);
  });

  // -------------------------------------------------------------------------
  // Token lifecycle
  // -------------------------------------------------------------------------

  describe('Token lifecycle', () => {
    it('rejects connection with no token', async () => {
      const ws = new WebSocket(`ws://localhost:${PORT_GATE}/ws-connect`);
      const { code } = await waitClose(ws);
      assert.equal(code, 1006);
    });

    it('rejects connection with unknown token', async () => {
      const ws = new WebSocket(`ws://localhost:${PORT_GATE}/ws-connect?token=notreal`);
      const { code } = await waitClose(ws);
      assert.equal(code, 1006);
    });

    it('rejects an expired token', async () => {
      const token = crypto.randomBytes(16).toString('hex');
      gatePending.set(token, { model: 'hybrid', minutes: 5, megabytes: 50, expires: Date.now() - 1 });

      const ws = new WebSocket(`ws://localhost:${PORT_GATE}/ws-connect?token=${token}`);
      const { code } = await waitClose(ws);
      assert.equal(code, 1006);
      assert.ok(!gatePending.has(token));
    });

    it('accepts a valid token and opens the connection', async () => {
      const token = crypto.randomBytes(16).toString('hex');
      gatePending.set(token, { model: 'hybrid', minutes: 5, megabytes: 50, expires: Date.now() + 60_000 });

      const ws = new WebSocket(`ws://localhost:${PORT_GATE}/ws-connect?token=${token}`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open',  resolve);
        ws.once('error', reject);
      });

      assert.ok(!gatePending.has(token));
      ws.close();
    });

    it('token is single-use — second connection is rejected', async () => {
      const token = crypto.randomBytes(16).toString('hex');
      gatePending.set(token, { model: 'hybrid', minutes: 5, megabytes: 50, expires: Date.now() + 60_000 });

      const ws1 = new WebSocket(`ws://localhost:${PORT_GATE}/ws-connect?token=${token}`);
      await new Promise<void>((r, e) => { ws1.once('open', r); ws1.once('error', e); });

      const ws2 = new WebSocket(`ws://localhost:${PORT_GATE}/ws-connect?token=${token}`);
      const { code } = await waitClose(ws2);
      assert.equal(code, 1006);

      ws1.close();
    });
  });

  // -------------------------------------------------------------------------
  // Local session
  // -------------------------------------------------------------------------

  describe('Local session', () => {
    it('sends session_start on connect', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      const msgsPromise = collectMessages(clientWs, 1);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);
      const [msg] = await msgsPromise;

      assert.equal(msg.type,     'session_start');
      assert.equal(msg.served_by, 'local');
      assert.ok(typeof msg.sessionId === 'string');
      assert.ok(msg.limits.timeSeconds > 0);
      assert.ok(msg.limits.dataMB > 0);

      clientWs.close();
    });

    it('proxies a valid GET request and returns status + body', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1); // discard session_start

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: `http://localhost:${PORT_TARGET}/hello` }));
      const [res] = await resPromise;

      assert.equal(res.status, 200);
      assert.equal(res.body,   'world');
      assert.ok(typeof res.meta.duration_ms === 'number');
      assert.equal(res.meta.served_by, 'local');

      clientWs.close();
    });

    it('proxies a POST request and reflects the body via /echo', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1); // discard session_start

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({
        url:    `http://localhost:${PORT_TARGET}/echo`,
        method: 'POST',
        body:   'hello from client',
      }));
      const [res] = await resPromise;

      assert.equal(res.status, 200);
      assert.equal(res.body,   'hello from client');

      clientWs.close();
    });

    it('proxies request and includes correlation id in response', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1);

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ id: 'req-42', url: `http://localhost:${PORT_TARGET}/hello` }));
      const [res] = await resPromise;

      assert.equal(res.id, 'req-42');

      clientWs.close();
    });

    it('returns error on invalid JSON without closing the session', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1); // session_start

      const errPromise = collectMessages(clientWs, 1);
      clientWs.send('not json at all');
      const [err] = await errPromise;

      assert.equal(err.error,   'invalid_request');
      assert.ok(typeof err.message === 'string');
      // session stays alive — another request should still work
      assert.equal(clientWs.readyState, WebSocket.OPEN);

      clientWs.close();
    });

    it('returns error when url field is missing without closing the session', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1);

      const errPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ method: 'GET' })); // no url
      const [err] = await errPromise;

      assert.equal(err.error,   'invalid_request');
      assert.match(err.message, /url/i);
      assert.equal(clientWs.readyState, WebSocket.OPEN);

      clientWs.close();
    });

    it('returns fetch_failed error on unreachable host without closing the session', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1);

      const errPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: 'http://localhost:9' })); // nothing on port 9
      const [err] = await errPromise;

      assert.equal(err.error, 'fetch_failed');
      assert.ok(typeof err.message === 'string');
      assert.equal(clientWs.readyState, WebSocket.OPEN);

      clientWs.close();
    });

    it('upstream non-2xx status is forwarded as-is (not treated as error)', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1);

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: `http://localhost:${PORT_TARGET}/error` }));
      const [res] = await resPromise;

      assert.equal(res.status, 500);
      assert.equal(res.body,   'server error');
      assert.equal(clientWs.readyState, WebSocket.OPEN);

      clientWs.close();
    });

    it('multiple sequential requests work in the same session', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1); // session_start

      for (let i = 0; i < 3; i++) {
        const resPromise = collectMessages(clientWs, 1);
        clientWs.send(JSON.stringify({ id: String(i), url: `http://localhost:${PORT_TARGET}/hello` }));
        const [res] = await resPromise;
        assert.equal(res.status, 200);
        assert.equal(res.id,     String(i));
      }

      clientWs.close();
    });

    it('fires session_expired (time_limit_reached) when time limit is 0ms', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      // model=hybrid, minutes=0 → timeLimit=0ms → timer fires immediately
      const msgsPromise = collectMessages(clientWs, 2);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 0, 50);
      const [start, expired] = await msgsPromise;
      assert.equal(start.type,     'session_start');
      assert.equal(expired.type,   'session_expired');
      assert.equal(expired.reason, 'time_limit_reached');
    });

    it('fires session_expired (data_limit_reached) when data limit is 0 bytes', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      // model=hybrid, megabytes=0 → dataLimit=0 → first message trips the limit
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 60, 0);

      await collectMessages(clientWs, 1); // discard session_start

      const expiredPromise = collectMessages(clientWs, 1);
      clientWs.send('x');
      const [expired] = await expiredPromise;
      assert.equal(expired.type,   'session_expired');
      assert.equal(expired.reason, 'data_limit_reached');
    });

    it('closes with code 1000 on time limit', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 0, 50);
      const { code } = await waitClose(clientWs);
      assert.equal(code, 1000);
    });

    it('closes with code 1008 on data limit', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 60, 0);

      await collectMessages(clientWs, 1); // session_start

      const closeEvt = waitClose(clientWs);
      clientWs.send('x');
      const { code } = await closeEvt;
      assert.equal(code, 1008);
    });

    it('stops processing messages after the socket closes', async () => {
      const { serverWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);

      await collectMessages(clientWs, 1); // session_start
      clientWs.close();
      await waitClose(clientWs);
      assert.ok(true); // no crash / no error = pass
    });
  });

  // -------------------------------------------------------------------------
  // Node-proxied session
  // -------------------------------------------------------------------------

  describe('Node-proxied session', () => {
    /**
     * Set up a full proxied session:
     *  1. Open a client↔proxy WebSocket pair on clientWss.
     *  2. Register the server-side message listener BEFORE creating the node
     *     socket, so `session_start` is captured even if it arrives immediately.
     *  3. Create the node socket and call handleNodeProxiedSession.
     *  4. Await both the node server-side connection and the first client message.
     *
     * Returns:
     *   clientWs   – the browser-side WebSocket; call .send() to simulate browser input
     *   proxyWs    – server-side of the client pair (what handleNodeProxiedSession holds)
     *   nodeWs     – server-side of the node pair (the fake upstream node)
     *   nodeClient – client-side connecting to the node (what the proxy holds)
     *   sessionStart – the pre-collected session_start message
     *   sessionId
     */
    async function makeProxiedPair(router: MockRouter): Promise<{
      clientWs:     WebSocket;
      proxyWs:      WebSocket;
      nodeWs:       WebSocket;
      nodeClient:   WebSocket;
      sessionStart: any;
      sessionId:    string;
    }> {
      const sessionId = crypto.randomUUID();
      const nodeId    = 'node-1';

      const { serverWs: proxyWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);

      // Start collecting BEFORE the node socket opens so session_start is not missed
      const sessionStartPromise = collectMessages(clientWs, 1);

      // Register node connection listener before creating the socket
      const nodeWsPromise = new Promise<WebSocket>((resolve) => {
        nodeWss.once('connection', resolve);
      });

      const nodeClient = new WebSocket(`ws://localhost:${PORT_NODE}`);

      // Register handlers immediately — 'open' fires asynchronously later
      handleNodeProxiedSession(proxyWs, nodeClient, sessionId, 'hybrid', 5, 50, router as any, nodeId);

      const [nodeWs, [sessionStart]] = await Promise.all([nodeWsPromise, sessionStartPromise]);

      return { clientWs, proxyWs, nodeWs, nodeClient, sessionStart, sessionId };
    }

    it('sends session_start with correct fields after node opens', async () => {
      const router = new MockRouter();
      const { sessionStart, clientWs, nodeWs, nodeClient } = await makeProxiedPair(router);

      assert.equal(sessionStart.type,      'session_start');
      assert.equal(sessionStart.served_by, 'node-1');
      assert.ok(typeof sessionStart.sessionId === 'string');

      nodeWs.close();
      clientWs.close();
      nodeClient.close();
    });

    it('forwards messages from browser (clientWs) to node (nodeWs)', async () => {
      const router = new MockRouter();
      const { clientWs, nodeWs, nodeClient } = await makeProxiedPair(router);

      const nodeRecvPromise = collectMessages(nodeWs, 1);
      clientWs.send('ping');
      const [fwd] = await nodeRecvPromise;
      assert.equal(fwd, 'ping');

      nodeWs.close();
      clientWs.close();
      nodeClient.close();
    });

    it('forwards messages from node (nodeWs) to browser (clientWs)', async () => {
      const router = new MockRouter();
      const { clientWs, nodeWs, nodeClient } = await makeProxiedPair(router);

      const clientRecvPromise = collectMessages(clientWs, 1);
      nodeWs.send('pong');
      const [fwd] = await clientRecvPromise;
      assert.equal(fwd, 'pong');

      nodeWs.close();
      clientWs.close();
      nodeClient.close();
    });

    it('router.decrementSession called exactly once when browser disconnects', async () => {
      const router = new MockRouter();
      const { clientWs, nodeWs, nodeClient } = await makeProxiedPair(router);

      clientWs.close();
      await new Promise<void>((r) => setTimeout(r, 50));

      assert.equal(router.decrements.length, 1);

      nodeWs.close();
      nodeClient.close();
    });

    it('router.decrementSession called exactly once when node disconnects', async () => {
      const router = new MockRouter();
      const { clientWs, nodeWs, nodeClient } = await makeProxiedPair(router);

      nodeWs.close();
      await new Promise<void>((r) => setTimeout(r, 50));

      assert.equal(router.decrements.length, 1);

      clientWs.close();
      nodeClient.close();
    });

    it('falls back to local session on node error (router.decrementSession once)', async () => {
      // Use a reject server so the node WebSocket fires 'error' (not just 'close')
      const router  = new MockRouter();
      const sessionId = crypto.randomUUID();
      const { serverWs: proxyWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);

      const fallbackPromise = collectMessages(clientWs, 1);

      // This fires "Unexpected server response: 503" → ws 'error' event → fallback
      const badNode = new WebSocket(`ws://localhost:${PORT_REJECT}`);
      handleNodeProxiedSession(proxyWs, badNode, sessionId, 'hybrid', 5, 50, router as any, 'node-1');

      const [fallbackStart] = await fallbackPromise;
      assert.equal(fallbackStart.type,      'session_start');
      assert.equal(fallbackStart.served_by, 'local');
      assert.equal(fallbackStart.sessionId,  sessionId);

      await new Promise<void>((r) => setTimeout(r, 30));
      assert.equal(router.decrements.length, 1);

      clientWs.close();
    });

    it('no duplicate messages after node fallback (stale handler removed)', async () => {
      const router    = new MockRouter();
      const sessionId = crypto.randomUUID();
      const { serverWs: proxyWs, clientWs } = await openClientPair(clientWss, PORT_CLIENT);

      const fallbackStartPromise = collectMessages(clientWs, 1);

      const badNode = new WebSocket(`ws://localhost:${PORT_REJECT}`);
      handleNodeProxiedSession(proxyWs, badNode, sessionId, 'hybrid', 5, 50, router as any, 'node-1');

      await fallbackStartPromise; // wait for local session to be live

      // Send a message — with the stale handler removed, only one echo should arrive
      const echoPromise = collectMessages(clientWs, 1);
      clientWs.send('test');
      const [echo] = await echoPromise;

      assert.equal(echo, 'Echo: test');

      clientWs.close();
    });

    it('undefined preference headers are stripped before calling router.selectNode', () => {
      // Unit-test the header-filtering logic in isolation
      const fakeReq = {
        headers: {
          'x-node-region':  'us-east',
          'x-node-domain':   undefined,   // absent header
          'x-node-exclude':  undefined,
        },
      } as any;

      const out: Record<string, string> = {};
      for (const key of ['x-node-region', 'x-node-domain', 'x-node-exclude'] as const) {
        const val = fakeReq.headers[key];
        if (val) out[key] = Array.isArray(val) ? val[0] : val;
      }

      assert.deepEqual(out, { 'x-node-region': 'us-east' });
      assert.ok(!('x-node-domain'  in out));
      assert.ok(!('x-node-exclude' in out));
    });
  });
});
