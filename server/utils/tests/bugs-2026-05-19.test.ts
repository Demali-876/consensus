/**
 * Bug Hunt — 2026-05-19
 *
 * Three bugs discovered via code review:
 *
 * [BUG-5] Critical · Performance/Correctness
 *   ConsensusProxy.pendingRequests is never populated.
 *   pendingRequests.set() is nowhere in the codebase; the Map is only ever
 *   read (.get) and deleted (.delete), never written.  This means:
 *     - getStats().pending_requests is permanently 0
 *     - Concurrent identical requests are NOT coalesced; every call fires its
 *       own upstream HTTP request, multiplying load and defeating the core
 *       deduplication guarantee.
 *   Fix: after the SSRF check resolves and before dispatching to executeDirect /
 *   executeViaNode, register the execution promise:
 *     const p = this.executeDirect(...);
 *     this.pendingRequests.set(dedupeKey, p);
 *     try { return await p; } finally { this.pendingRequests.delete(dedupeKey); }
 *
 * [BUG-6] High · Security
 *   handleNodeProxiedSession does not enforce the data limit.
 *   Both handleLocalSession (line 241) and handleNodeTunnelSession (line 426)
 *   check `session.usage.totalBytes >= limits.dataLimit` in their message
 *   handlers and close the session when the limit is breached.
 *   handleNodeProxiedSession accumulates totalBytes but has no corresponding
 *   guard, so a client on the node-proxied path can transfer unlimited data
 *   after paying for a small quota.
 *   Fix: add the same totalBytes >= dataLimit check (+ close + session_expired)
 *   to both the clientWs and nodeWs message handlers in handleNodeProxiedSession.
 *
 * [BUG-7] Medium · Security / Availability
 *   executeProxyRequest in wss.ts calls `upstream.text()` with no size cap.
 *   proxy.ts protects itself with MAX_RESPONSE_BYTES (50 MB) via Axios's
 *   maxContentLength, but the WebSocket local-session proxy uses native fetch
 *   and has no equivalent guard.  A client with a valid session can point the
 *   proxy at a multi-gigabyte URL and exhaust server heap.
 *   Fix: check Content-Length before calling text(), and reject after reading if
 *   the body exceeds a configured limit (e.g. 10 MB matching MAX_BODY_BYTES).
 *
 * Run:
 *   cd server && npx tsx --test utils/tests/bugs-2026-05-19.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert   from 'node:assert/strict';
import http     from 'node:http';
import crypto   from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// ─── shared helpers ───────────────────────────────────────────────────────────

function closeServer(srv: http.Server): Promise<void> {
  return new Promise((resolve) => {
    (srv as any).closeAllConnections?.();
    srv.close(() => resolve());
  });
}

/**
 * Returns a Promise that resolves to { serverWs, clientWs } once both sides
 * of a new WebSocket connection are ready.
 */
function openPair(
  wss:  WebSocketServer,
  port: number,
): Promise<{ serverWs: WebSocket; clientWs: WebSocket }> {
  return new Promise((resolve, reject) => {
    let serverWs: WebSocket | undefined;
    let clientReady = false;

    const onConn = (ws: WebSocket) => {
      serverWs = ws;
      if (clientReady) resolve({ serverWs: ws, clientWs });
    };
    wss.once('connection', onConn);

    const clientWs = new WebSocket(`ws://localhost:${port}`);
    clientWs.once('open',  () => { clientReady = true; if (serverWs) resolve({ serverWs, clientWs }); });
    clientWs.once('error', (e) => { wss.off('connection', onConn); reject(e); });
  });
}

/** Collect the next `n` messages from a WebSocket as parsed JSON. */
function collectMessages(ws: WebSocket, n: number, timeoutMs = 2_000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = [];
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${n} messages`)), timeoutMs);

    const onMsg = (raw: Buffer) => {
      let val: any;
      try { val = JSON.parse(raw.toString()); } catch { val = raw.toString(); }
      msgs.push(val);
      if (msgs.length === n) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msgs);
      }
    };
    ws.on('message', onMsg);
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// [BUG-5]  ConsensusProxy.pendingRequests is never populated
// ═════════════════════════════════════════════════════════════════════════════

describe('[BUG-5] ConsensusProxy.pendingRequests — set() never called, in-flight dedup is dead code', () => {
  /**
   * SYMPTOM: getStats().pending_requests is always 0, even while requests are
   * actively in flight.  Concurrent identical requests all independently hit
   * upstream instead of the second-through-nth waiters sharing the first promise.
   *
   * ROOT CAUSE: grep "pendingRequests.set" server/features/proxy/proxy.ts → 0 results.
   *   • pendingRequests.get()    → line 275  (reads — checks for existing in-flight)
   *   • pendingRequests.delete() → line 541  (clearKey — supposed to cancel in-flight)
   *   • pendingRequests.size     → line 526  (getStats — always 0)
   *   • pendingRequests.set()    → MISSING   (should register in-flight promise)
   *
   * These tests will PASS once the fix is in place (set() is called).
   */

  it('pending_requests stat is always 0 — no in-flight promise is ever registered', async () => {
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    try {
      // Instrument: intercept any call to pendingRequests.set()
      const internal     = proxy as any;
      const origMap      = internal.pendingRequests as Map<string, Promise<any>>;
      let setPendingCalls = 0;
      const origSet      = origMap.set.bind(origMap);
      origMap.set = (...args: Parameters<typeof origMap.set>) => {
        setPendingCalls++;
        return origSet(...args);
      };

      // 8.8.4.4 is a public (non-private) IP — it passes the SSRF check.
      // Port 1 is almost never open, so the connection is refused immediately
      // (ECONNREFUSED within milliseconds) rather than hanging for 30 seconds.
      // We fire-and-forget; catch silences the expected network error.
      proxy.handleRequest('http://8.8.4.4:1/', 'GET').catch(() => {});
      proxy.handleRequest('http://8.8.4.4:1/', 'GET').catch(() => {});

      // Two microtask yields: the first lets resolveAndCheckTarget's resolved
      // promise settle (literal IP → synchronous resolution); the second gives
      // handleRequest the chance to run through dedupeKey computation, cache
      // lookup, and — critically — the spot where pendingRequests.set() should
      // be called before it suspends again at the axios network call.
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(
        setPendingCalls, 0,
        'BUG-5: pendingRequests.set() was never called. ' +
        'Both concurrent requests proceed independently without registration. ' +
        'Fix: call this.pendingRequests.set(dedupeKey, executionPromise) after ' +
        'the SSRF check and before dispatching the upstream request.',
      );

      assert.equal(
        proxy.getStats().pending_requests, 0,
        'getStats().pending_requests is permanently 0 — confirms no in-flight tracking.',
      );
    } finally {
      proxy.destroy();
    }
  });

  it('clearKey() removes from pendingRequests, but the map is always empty — delete is a no-op', async () => {
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    try {
      const internal = proxy as any;
      const pendingMap = internal.pendingRequests as Map<string, unknown>;

      // clearKey is the "cancel in-flight" API — it must call pendingRequests.delete().
      // Since set() is never called the delete is always harmless, but proves
      // the map is perpetually empty.
      const syntheticKey = crypto.randomUUID();
      proxy.clearKey(syntheticKey);

      assert.equal(
        pendingMap.size, 0,
        'pendingRequests is empty before AND after clearKey() — ' +
        'there is nothing to clear because set() was never called by the request pipeline. ' +
        'Fix: the map should contain the in-flight promise between registration and completion.',
      );
    } finally {
      proxy.destroy();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// [BUG-6]  handleNodeProxiedSession — data limit never enforced
// ═════════════════════════════════════════════════════════════════════════════

describe('[BUG-6] handleNodeProxiedSession: data limit not enforced — unlimited data transfer', () => {
  /**
   * handleLocalSession   (line 241): checks totalBytes >= dataLimit → closes ✓
   * handleNodeTunnelSession (line 426): same check → closes ✓
   * handleNodeProxiedSession (lines 331-345): accumulates totalBytes but has
   *   NO check → never closes the session on data overflow  ✗
   *
   * A client who pays for 1 MB on the node-proxied routing path can send
   * or receive unlimited data without being cut off.
   *
   * Control test: handleLocalSession DOES enforce the limit (passes).
   * Bug test:     handleNodeProxiedSession does NOT (fails until fix).
   */

  // ─── tiny quota: 0.001 MB ≈ 1 024 bytes → fast test ──────────────────────
  const DATA_LIMIT_MB    = 0.001;
  const DATA_LIMIT_BYTES = Math.ceil(DATA_LIMIT_MB * 1024 * 1024); // ≈ 1 049 bytes
  const OVERSIZED        = Buffer.alloc(DATA_LIMIT_BYTES + 200, 0xAA); // safely over limit

  const PORT_CLIENT = 42_101;
  const PORT_NODE   = 42_102;

  let clientHttpSrv: http.Server;
  let nodeHttpSrv:   http.Server;
  let clientWss:     WebSocketServer;
  let nodeWss:       WebSocketServer;

  before(async () => {
    clientHttpSrv = http.createServer();
    nodeHttpSrv   = http.createServer();
    clientWss     = new WebSocketServer({ server: clientHttpSrv });
    nodeWss       = new WebSocketServer({ server: nodeHttpSrv });

    await Promise.all([
      new Promise<void>((r) => clientHttpSrv.listen(PORT_CLIENT, r)),
      new Promise<void>((r) => nodeHttpSrv.listen(PORT_NODE,   r)),
    ]);
    // Unref so lingering WS connections don't prevent process exit
    clientHttpSrv.unref();
    nodeHttpSrv.unref();
  });

  after(async () => {
    // Forcibly terminate all lingering WS connections before closing servers.
    // Without this, srv.close() blocks until every connection finishes its
    // close handshake, which can hang when a buggy session has no close event.
    clientWss.clients.forEach((ws) => ws.terminate());
    nodeWss.clients.forEach((ws) => ws.terminate());
    await Promise.all([
      closeServer(clientHttpSrv),
      closeServer(nodeHttpSrv),
    ]);
  });

  // ── control ──────────────────────────────────────────────────────────────

  it('[control] handleLocalSession sends session_expired when data limit exceeded', async () => {
    const { handleLocalSession } = await import('../../features/websocket/wss.ts');
    const { serverWs, clientWs } = await openPair(clientWss, PORT_CLIENT);

    handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, DATA_LIMIT_MB);
    await collectMessages(clientWs, 1); // discard session_start

    const resultPromise = collectMessages(clientWs, 1);
    clientWs.send(OVERSIZED);
    const [msg] = await resultPromise;

    assert.equal(msg?.type, 'session_expired',
      'handleLocalSession MUST send session_expired when data limit is exceeded');
    assert.equal(msg?.reason, 'data_limit_reached');

    clientWs.close();
  });

  // ── bug ──────────────────────────────────────────────────────────────────

  it('[BUG] handleNodeProxiedSession does NOT enforce data limit — session stays open after overflow', async () => {
    const { handleNodeProxiedSession } = await import('../../features/websocket/wss.ts');

    // Server-side WS for the "client" (what handleNodeProxiedSession sees as clientWs)
    const { serverWs: clientServerWs, clientWs: testClientWs } =
      await openPair(clientWss, PORT_CLIENT);

    // Client-side WS for the "node" (what handleNodeProxiedSession sends to)
    // nodeWs is already open; handleNodeProxiedSession's 'open' listener won't fire,
    // but the 'message' listener (where the missing guard lives) is attached immediately.
    const { serverWs: _testNodeWs, clientWs: proxyNodeWs } =
      await openPair(nodeWss, PORT_NODE);

    const mockRouter = { decrementSession: () => {} } as any;

    handleNodeProxiedSession(
      clientServerWs,   // clientWs: server-side connection to the user
      proxyNodeWs,      // nodeWs: client-side connection to the node server
      crypto.randomUUID(),
      'hybrid',
      5,
      DATA_LIMIT_MB,    // tiny quota — oversized payload should trigger enforcement
      mockRouter,
      'test-node-id',
    );

    // Send data that exceeds the quota
    testClientWs.send(OVERSIZED);

    // Wait up to 600 ms for a session_expired message.
    // The correct implementation SHOULD send it; the buggy one never does.
    const gotExpiry = await Promise.race<boolean>([
      new Promise<boolean>((resolve) => {
        testClientWs.once('message', (raw: Buffer) => {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          resolve(msg?.type === 'session_expired' && msg?.reason === 'data_limit_reached');
        });
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 600)),
    ]);

    assert.equal(
      gotExpiry, true,
      'BUG-6: handleNodeProxiedSession MUST send { type: "session_expired", reason: "data_limit_reached" } ' +
      'and close the WebSocket (code 1008) when totalBytes >= dataLimit — ' +
      'currently this check is missing from both message handlers (lines ~335 and ~343 of wss.ts). ' +
      'Fix: mirror the guard that exists in handleLocalSession (line 241) and ' +
      'handleNodeTunnelSession (line 426).',
    );

    testClientWs.close();
    proxyNodeWs.close();
  });

  // ── regression: both message directions ──────────────────────────────────

  it('[BUG] data sent FROM node side also bypasses data limit in handleNodeProxiedSession', async () => {
    const { handleNodeProxiedSession } = await import('../../features/websocket/wss.ts');

    const { serverWs: clientServerWs, clientWs: testClientWs } =
      await openPair(clientWss, PORT_CLIENT);
    const { serverWs: testNodeWs, clientWs: proxyNodeWs } =
      await openPair(nodeWss, PORT_NODE);

    const mockRouter = { decrementSession: () => {} } as any;

    handleNodeProxiedSession(
      clientServerWs,
      proxyNodeWs,
      crypto.randomUUID(),
      'hybrid', 5, DATA_LIMIT_MB,
      mockRouter, 'test-node-id',
    );

    // Simulate the node sending oversized data back to the client.
    // With the fix: the session closes (code 1008) WITHOUT forwarding the data.
    // With the bug: the oversized binary payload is forwarded transparently;
    //   the session stays open and the close event never fires.
    testNodeWs.send(OVERSIZED);

    const sessionClosed1008 = await Promise.race<boolean>([
      new Promise<boolean>((resolve) => {
        testClientWs.once('close', (code: number) => resolve(code === 1008));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 600)),
    ]);

    assert.equal(
      sessionClosed1008, true,
      'BUG-6 (node→client direction): when oversized data arrives from the node, ' +
      'the session MUST be closed with code 1008 (data_limit_reached) WITHOUT forwarding the payload. ' +
      'Currently the nodeWs message handler (lines ~339-345 of wss.ts) has no totalBytes >= dataLimit check. ' +
      'Fix: add the same guard present in handleLocalSession / handleNodeTunnelSession.',
    );

    testClientWs.close();
    testNodeWs.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// [BUG-7]  executeProxyRequest — no response body size cap
// ═════════════════════════════════════════════════════════════════════════════

describe('[BUG-7] executeProxyRequest: upstream.text() has no size limit — potential OOM', () => {
  /**
   * proxy.ts protects itself with MAX_RESPONSE_BYTES = 50 MB via Axios's
   * maxContentLength option.
   *
   * wss.ts's executeProxyRequest uses the native fetch API and calls
   * upstream.text() unconditionally.  There is no Content-Length pre-check
   * and no streaming size guard.  A client with a valid paid session can point
   * the WebSocket proxy at an arbitrarily large URL and exhaust server heap.
   *
   * This test mocks globalThis.fetch to return a response whose body is larger
   * than a reasonable per-request limit (we use 11 MB as a representative cap).
   * The proxy SHOULD reject the response and return { error: 'fetch_failed' }.
   * Currently it accepts and forwards the full 11 MB body.
   */

  const WS_PORT    = 42_103;
  const SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB — same as proxy.ts MAX_BODY_BYTES
  const OVER_LIMIT = SIZE_LIMIT + 1024; // 10 MB + 1 KB

  let wsSrv:    http.Server;
  let wsServer: WebSocketServer;

  before(async () => {
    wsSrv    = http.createServer();
    wsServer = new WebSocketServer({ server: wsSrv });
    await new Promise<void>((r) => wsSrv.listen(WS_PORT, r));
    wsSrv.unref(); // Unref so lingering connections don't prevent process exit
  });

  after(async () => {
    await closeServer(wsSrv);
  });

  it('[control] small responses are forwarded normally', async () => {
    const { handleLocalSession } = await import('../../features/websocket/wss.ts');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status:  200,
        headers: { 'content-type': 'application/json' },
      });

    try {
      const { serverWs, clientWs } = await openPair(wsServer, WS_PORT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);
      await collectMessages(clientWs, 1); // discard session_start

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: 'https://example.com/small' }));
      const [msg] = await resPromise;

      assert.equal(msg?.status, 200, 'small response must be forwarded with status 200');
      clientWs.close();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('[BUG] oversized response is accepted without error — no body size cap', async () => {
    const { handleLocalSession } = await import('../../features/websocket/wss.ts');

    // Mock fetch to return a body that exceeds the expected limit
    const hugeBody  = Buffer.alloc(OVER_LIMIT, 0x58).toString(); // 10 MB + 1 KB of 'X'
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(hugeBody, {
        status:  200,
        headers: {
          'content-type':   'text/plain',
          'content-length': String(Buffer.byteLength(hugeBody)),
        },
      });

    try {
      const { serverWs, clientWs } = await openPair(wsServer, WS_PORT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);
      await collectMessages(clientWs, 1); // discard session_start

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: 'https://example.com/huge' }));
      const [msg] = await resPromise;

      // CORRECT behaviour: oversized body must be rejected
      assert.equal(
        msg?.error, 'fetch_failed',
        'BUG-7: executeProxyRequest MUST reject responses larger than a configured size limit ' +
        `(${SIZE_LIMIT / 1024 / 1024} MB) with { error: "fetch_failed" }. ` +
        'Currently upstream.text() is called with no guard, buffering the entire body into heap. ' +
        'Fix: check Content-Length header before calling text(), or stream with a counting reader, ' +
        'and return { error: "fetch_failed", message: "Response body exceeds size limit" } ' +
        `when the body exceeds the limit. Actual status returned: ${msg?.status ?? '(none)'}.`,
      );

      clientWs.close();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('[BUG] Content-Length header alone does not protect — text() is still called for oversized responses', async () => {
    const { handleLocalSession } = await import('../../features/websocket/wss.ts');

    // A server can signal an oversized response in the Content-Length header
    // before sending any body bytes.  A size-aware proxy should reject early.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('x'.repeat(100), {
        status:  200,
        headers: {
          'content-type':   'text/plain',
          'content-length': String(OVER_LIMIT), // advertises 10+ MB, body is small (mock)
        },
      });

    try {
      const { serverWs, clientWs } = await openPair(wsServer, WS_PORT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);
      await collectMessages(clientWs, 1); // discard session_start

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: 'https://example.com/large-header' }));
      const [msg] = await resPromise;

      // The Content-Length alone should be enough to reject before buffering
      assert.equal(
        msg?.error, 'fetch_failed',
        'BUG-7 (Content-Length pre-check): when Content-Length signals an oversized response, ' +
        'executeProxyRequest should reject WITHOUT calling upstream.text(). ' +
        'Currently there is no pre-check at all — the response is accepted regardless of size.',
      );

      clientWs.close();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
