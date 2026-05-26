/**
 * Bug Hunt 2026-05-26 — Security & Performance findings
 *
 * Each suite documents a NEW finding, explains its impact, and asserts the
 * CORRECT behavior so the test FAILS while the bug is present and PASSES once
 * the fix is applied.  Run in isolation:
 *
 *   node --import tsx/esm --test utils/tests/bugs-2026-05-26.test.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG-C] wss.ts — executeProxyRequest buffers entire upstream body with no
 *         size cap.  Severity: HIGH (DoS / OOM).
 *         Fix: check Content-Length header before calling upstream.text(); abort
 *              when it exceeds MAX_WS_RESPONSE_BYTES (50 MB, same as proxy.ts).
 *
 * [BUG-D] wss.ts — response bytes are never checked against the session data
 *         limit.  Severity: HIGH (billing / quota bypass).
 *         Fix: after sendProxyResult updates session.usage.bytesSent, compare
 *              session.usage.totalBytes with limits.dataLimit and close the
 *              session when the limit is exceeded.
 *
 * [BUG-E] router.ts — requestToNode sticky-session map has no maximum size.
 *         Severity: MEDIUM (unbounded heap growth).
 *         Fix: cap the map at a fixed maximum (e.g. 10 000 entries) and evict
 *              the oldest entry when the cap is reached.
 *
 * [BUG-F] node_store.js — listNodesForRoutingStmt fetches ALL nodes regardless
 *         of status, then filters in JavaScript.
 *         Severity: MEDIUM (full-table scan on every routing cycle).
 *         Fix: add WHERE status = 'active' to use the existing nodes.status
 *              index and avoid loading inactive rows entirely.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NOTE ON SSRF-SAFE TEST URLS
 * ---------------------------
 * Tests for [BUG-C] and [BUG-D] need a URL that (a) passes the SSRF check and
 * (b) is interceptable by a globalThis.fetch mock.  We use http://1.1.1.1/ —
 * a literal, well-known public IP (Cloudflare DNS) — so no DNS lookup is ever
 * performed and the SSRF check resolves synchronously.  The mock intercepts
 * the actual fetch call so nothing is sent over the network.
 */

import { describe, it, before, after } from 'node:test';
import assert   from 'node:assert/strict';
import http     from 'node:http';
import crypto   from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  handleLocalSession,
} from '../../features/websocket/wss.ts';

// ─── helpers ──────────────────────────────────────────────────────────────────

function closeServer(srv: http.Server): Promise<void> {
  return new Promise((r) => { (srv as any).closeAllConnections?.(); srv.close(() => r()); });
}

function collectMessages(ws: WebSocket, n: number, timeoutMs = 5_000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = [];
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`collectMessages timed out after ${timeoutMs} ms (got ${msgs.length}/${n})`));
    }, timeoutMs);
    const onMsg = (raw: Buffer) => {
      let val: any;
      try { val = JSON.parse(raw.toString()); } catch { val = raw.toString(); }
      msgs.push(val);
      if (msgs.length === n) { clearTimeout(timer); ws.off('message', onMsg); resolve(msgs); }
    };
    ws.on('message', onMsg);
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function openClientPair(
  wss:  WebSocketServer,
  port: number,
): Promise<{ serverWs: WebSocket; clientWs: WebSocket }> {
  return new Promise((resolve, reject) => {
    let serverWs: WebSocket | undefined;
    let clientReady = false;
    const onConn = (ws: WebSocket) => { serverWs = ws; if (clientReady) resolve({ serverWs: ws, clientWs }); };
    wss.once('connection', onConn);
    const clientWs = new WebSocket(`ws://localhost:${port}`);
    clientWs.once('open',  () => { clientReady = true; if (serverWs) resolve({ serverWs: serverWs!, clientWs }); });
    clientWs.once('error', (e) => { wss.off('connection', onConn); reject(e); });
  });
}

function waitClose(ws: WebSocket, timeoutMs = 500): Promise<number> {
  return new Promise((resolve) => {
    ws.on('error', () => {});
    const timer = setTimeout(() => resolve(-1), timeoutMs);
    ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-C] wss.ts — no response body size cap in executeProxyRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-C] wss.ts executeProxyRequest buffers upstream body with no size cap', () => {
  /**
   * PROBLEM
   * -------
   * proxy.ts (the HTTP proxy path) enforces a 50 MB response limit via axios:
   *
   *   maxContentLength: MAX_RESPONSE_BYTES  // 50 MB
   *
   * The WebSocket proxy path (executeProxyRequest in wss.ts) uses native fetch()
   * with NO equivalent guard:
   *
   *   const upstream = await fetch(req.url, init);
   *   const body     = await upstream.text();   // ← no size check at all
   *
   * A paid client can direct the proxy at any public URL.  If the upstream
   * returns hundreds of MB (or claims to via Content-Length), the entire body
   * is buffered in-process before being JSON-serialised and forwarded.  Under
   * concurrent attack this causes OOM and process termination.
   *
   * FIX
   * ---
   * Before calling upstream.text(), read the Content-Length response header.
   * If it exceeds MAX_WS_RESPONSE_BYTES (50 MB), call sendProxyResult with
   * error: 'fetch_failed' and return early.  Add the same check after reading
   * to guard against servers that omit Content-Length.
   */

  const WS_PORT = 39_110;
  // 1.1.1.1 is a public IP (literal) — SSRF check is synchronous, no DNS needed.
  const TEST_URL              = 'http://1.1.1.1/bug-c-test';
  const LARGE_CONTENT_LEN     = 60 * 1024 * 1024;   // 60 MB > 50 MB limit
  const MAX_WS_RESPONSE_BYTES = 50 * 1024 * 1024;

  let wsSrv:    http.Server;
  let wsServer: WebSocketServer;

  before(async () => {
    wsSrv    = http.createServer();
    wsServer = new WebSocketServer({ server: wsSrv });
    await new Promise<void>((r) => wsSrv.listen(WS_PORT, r));
  });

  after(async () => {
    // Forcibly terminate any lingering WS connections so the HTTP server closes cleanly.
    for (const c of wsServer.clients) c.terminate();
    await closeServer(wsSrv);
  });

  it('should return fetch_failed when Content-Length exceeds 50 MB — currently returns 200', async () => {
    /**
     * The fix must check the Content-Length header before reading the body and
     * abort with fetch_failed.  Until the fix is applied this test FAILS: the
     * proxy ignores Content-Length and succeeds with the small mock body.
     */
    const origFetch = globalThis.fetch;
    // Mock fetch: claims a 60 MB body but only sends 1 KB (so the test is fast).
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response('A'.repeat(1_024), {
        status:  200,
        headers: {
          'content-type':   'text/plain',
          'content-length': String(LARGE_CONTENT_LEN),
        },
      });

    try {
      const { serverWs, clientWs } = await openClientPair(wsServer, WS_PORT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);
      await collectMessages(clientWs, 1);  // discard session_start

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: TEST_URL }));
      const [res] = await resPromise;

      // Close before asserting so the connection is gone even when the assertion throws.
      clientWs.close();
      await new Promise<void>((r) => setTimeout(r, 50));

      // EXPECTED after fix:  error === 'fetch_failed' with a size-limit message.
      // ACTUAL before fix:   status === 200 with the 1 KB mock body.
      assert.equal(
        res.error, 'fetch_failed',
        `[BUG-C] executeProxyRequest must reject upstream responses whose ` +
        `Content-Length (${LARGE_CONTENT_LEN} B) exceeds MAX_WS_RESPONSE_BYTES ` +
        `(${MAX_WS_RESPONSE_BYTES} B).  Currently it reads the full body with no ` +
        `size guard — an attacker can trigger OOM by pointing the proxy at a ` +
        `large resource.  Fix: check Content-Length before upstream.text().`,
      );
      assert.match(
        String(res.message ?? ''),
        /limit|size|too large|exceed/i,
        'Error message must describe the size-limit violation',
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('should not reject responses whose Content-Length is within the 50 MB limit (regression guard)', async () => {
    const origFetch = globalThis.fetch;
    const SMALL_BODY = 'Hello from upstream';
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(SMALL_BODY, {
        status:  200,
        headers: {
          'content-type':   'text/plain',
          'content-length': String(SMALL_BODY.length),
        },
      });

    try {
      const { serverWs, clientWs } = await openClientPair(wsServer, WS_PORT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 5, 50);
      await collectMessages(clientWs, 1);  // session_start

      const resPromise = collectMessages(clientWs, 1);
      clientWs.send(JSON.stringify({ url: TEST_URL }));
      const [res] = await resPromise;

      clientWs.close();
      await new Promise<void>((r) => setTimeout(r, 50));

      assert.equal(res.status, 200, 'Small response must still succeed once BUG-C is fixed');
      assert.equal(res.body,   SMALL_BODY);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-D] wss.ts — outbound response bytes never enforced against data limit
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-D] wss.ts sendProxyResult does not enforce session data limit on outbound bytes', () => {
  /**
   * PROBLEM
   * -------
   * The data-limit check in handleLocalSession is applied ONLY to inbound
   * message bytes (the ws.on('message') handler):
   *
   *   session.usage.bytesReceived += size;          // inbound JSON request
   *   if (session.usage.totalBytes >= limits.dataLimit) { ws.close(1008); return; }
   *   void executeProxyRequest(ws, session, data);
   *
   * sendProxyResult() increments session.usage.bytesSent and totalBytes, but
   * does NOT re-check the limit before or after sending:
   *
   *   session.usage.bytesSent  += size;   // outbound response
   *   session.usage.totalBytes  = ...;
   *   ws.send(msg);                       // ← no limit enforcement here
   *
   * As a result, a client who pays for (say) 1 KB of data can receive a 2 MB
   * response without the session being terminated.  The limit is only re-tested
   * on the NEXT inbound message — one full round-trip too late.
   *
   * FIX
   * ---
   * After the bytesSent update in sendProxyResult(), check whether
   * session.usage.totalBytes >= limits.dataLimit.  If so, send a
   * session_expired message and close the WebSocket.
   */

  const WS_PORT  = 39_111;
  const TEST_URL = 'http://1.1.1.1/bug-d-test';
  // Response body is 2 000 chars; the JSON envelope adds ~70 bytes overhead,
  // so bytesSent ≈ 2 070.  Together with the ~60-byte inbound message the
  // running total ≈ 2 130, well above the ~1 049-byte dataLimit.
  const LARGE_BODY = 'X'.repeat(2_000);

  let wsSrv:    http.Server;
  let wsServer: WebSocketServer;

  before(async () => {
    wsSrv    = http.createServer();
    wsServer = new WebSocketServer({ server: wsSrv });
    await new Promise<void>((r) => wsSrv.listen(WS_PORT, r));
  });

  after(async () => {
    for (const c of wsServer.clients) c.terminate();
    await closeServer(wsSrv);
  });

  it('session must close (1008) after response bytes push totalBytes over the data limit — currently stays open', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(LARGE_BODY, {
        status:  200,
        headers: { 'content-type': 'text/plain' },
      });

    try {
      const { serverWs, clientWs } = await openClientPair(wsServer, WS_PORT);

      // megabytes=0.001 → dataLimit ≈ 1 049 bytes (hybrid model).
      // The inbound JSON request (~60 B) is under the limit, so the call
      // proceeds.  The 2 000-byte response body alone exceeds the limit.
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 60, 0.001);
      await collectMessages(clientWs, 1);  // discard session_start

      clientWs.send(JSON.stringify({ url: TEST_URL }));

      // Wait for the proxy response to arrive.
      const [res] = await collectMessages(clientWs, 1);
      assert.equal(res.status, 200, 'upstream response must arrive first');

      // After the response the session should detect the limit breach and close.
      const code = await waitClose(clientWs, 500);

      // Ensure the connection is closed regardless of assertion outcome.
      if (clientWs.readyState !== WebSocket.CLOSED) clientWs.terminate();

      // EXPECTED after fix:  code === 1008 (Policy Violation — data limit).
      // ACTUAL before fix:   code === -1  (connection is still open after 500 ms).
      assert.equal(
        code, 1008,
        `[BUG-D] Session must be closed with code 1008 when outbound response ` +
        `bytes (~2 070 B) push totalBytes above the data limit (~1 049 B). ` +
        `Currently sendProxyResult updates usage.bytesSent but never re-checks ` +
        `the cap — a client can receive arbitrarily large responses before the ` +
        `next inbound message triggers the close.`,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('session must send session_expired with reason data_limit_reached before closing', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(LARGE_BODY, { status: 200, headers: { 'content-type': 'text/plain' } });

    try {
      const { serverWs, clientWs } = await openClientPair(wsServer, WS_PORT);
      handleLocalSession(serverWs, crypto.randomUUID(), 'hybrid', 60, 0.001);
      await collectMessages(clientWs, 1);  // session_start

      clientWs.send(JSON.stringify({ url: TEST_URL }));

      // Collect up to 2 messages: the proxy response THEN the session_expired notice.
      // With the bug only 1 message arrives (no session_expired).
      const msgs = await collectMessages(clientWs, 2, 800).catch(() => [] as any[]);

      // Once the fix is applied we expect [ { status:200, body:...}, { type:'session_expired', reason:'data_limit_reached' } ]
      const expired = msgs.find((m: any) => m?.type === 'session_expired');

      assert.ok(
        expired !== undefined,
        `[BUG-D] A session_expired message with reason='data_limit_reached' must ` +
        `be emitted when outbound bytes breach the data limit. ` +
        `Currently no such message is sent (msgs received: ${msgs.length}).`,
      );
      if (clientWs.readyState !== WebSocket.CLOSED) clientWs.terminate();

      assert.equal(
        expired?.reason, 'data_limit_reached',
        `session_expired reason must be 'data_limit_reached', got '${expired?.reason}'`,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-E] router.ts — requestToNode sticky map has no maximum size bound
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-E] router.ts requestToNode sticky map has no maximum size', () => {
  /**
   * PROBLEM
   * -------
   * Every successful selectNode() call inserts into requestToNode:
   *
   *   this.requestToNode.set(dedupeKey, { nodeId: selected.id, at: Date.now() });
   *
   * The cleanup sweep (sweepSticky) runs every 60 seconds and removes entries
   * older than 10 minutes — but it has NO size cap.  During the 10-minute
   * window before the first cleanup, a burst of unique dedupeKeys fills the
   * map without limit.
   *
   * Scale: at 1 000 RPS with unique keys the map accumulates 600 000 entries
   * in 10 minutes.  Each entry is roughly 100–150 bytes on V8 heap (string key
   * + {nodeId:string, at:number} object), yielding ~60–90 MB of uncontrolled
   * heap growth before the first sweep.
   *
   * FIX
   * ---
   * Enforce a hard cap (e.g. 10 000 entries) on requestToNode.  On each insert,
   * if the map is at the cap, evict the oldest entry (or skip the insert).
   */

  it('requestToNode map grows to arbitrary size — must be capped at a fixed maximum', async () => {
    const { default: Router } = await import('../../router.ts');

    const router = new Router();

    // Inject a single active mock node so selectNode actually records entries.
    (router as any).getNodes = () => [{
      id:           'mock-node-bug-e',
      region:       'us-east',
      status:       'active',
      domain:       'mock.example.com',
      capabilities: {},
    }];

    const INSERTS = 10_001;
    for (let i = 0; i < INSERTS; i++) {
      router.selectNode(`dedupe-bug-e-${i}`, {});
    }

    const mapSize: number = (router as any).requestToNode.size;

    // EXPECTED after fix:  mapSize <= 10 000 (entries evicted at cap).
    // ACTUAL before fix:   mapSize === 10 001 (no eviction at all).
    assert.ok(
      mapSize <= 10_000,
      `[BUG-E] requestToNode must be capped (≤ 10 000 entries) to prevent ` +
      `unbounded memory growth.  After ${INSERTS} unique selectNode() calls the ` +
      `map contains ${mapSize} entries — no upper bound is enforced.  ` +
      `At 1 000 RPS this accumulates ~600 000 entries in 10 minutes before ` +
      `the first sweep runs.`,
    );
  });

  it('documents the exposure window: 60 000 entries accumulate in a simulated 1-minute burst', async () => {
    /**
     * This test PASSES today — it documents that the map CAN hold 60 000
     * entries, proving the scale of the problem.  Once BUG-E is fixed with a
     * cap (e.g. 10 000), mapSize will be ≤ 10 000 and this test should be
     * updated to assert the cap.
     */
    const { default: Router } = await import('../../router.ts');
    const router = new Router();

    (router as any).getNodes = () => [{
      id: 'mock-node-scale', region: 'us', status: 'active', domain: 'd.x.com', capabilities: {},
    }];

    const BURST = 60_000;
    for (let i = 0; i < BURST; i++) router.selectNode(`burst-bug-e-${i}`, {});

    const mapSize: number = (router as any).requestToNode.size;

    // This assertion documents the current (buggy) state: the map holds all BURST entries.
    // After the fix is applied this should fail and must be changed to: mapSize <= CAP.
    assert.equal(
      mapSize, BURST,
      `[BUG-E] Map is unbounded: after ${BURST} inserts, mapSize=${mapSize}. ` +
      `Once the cap fix is applied, mapSize must be ≤ the configured cap even ` +
      `after ${BURST} inserts.`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-F] node_store.js — listNodesForRouting full-table scan
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-F] node_store.js listNodesForRouting returns ALL nodes — no SQL status filter', () => {
  /**
   * PROBLEM
   * -------
   * The prepared statement for the hot routing path is:
   *
   *   SELECT id, region, status, domain, capabilities
   *   FROM nodes
   *   ORDER BY created_at DESC
   *
   * Every call transfers ALL node rows to the application layer.
   * Router.selectNode() then filters in JavaScript:
   *
   *   eligibleNodes = allNodes.filter(n => n.status === 'active' && ...)
   *
   * In a production cluster with 1 000 nodes, many may be 'provisioning',
   * 'offline', or 'updating'.  These rows are never used but cost I/O and
   * deserialisation on every routing cache refresh (every 3 seconds).
   *
   * The schema has no explicit status index, but adding one and the WHERE
   * clause would let SQLite use a covering index scan on status='active'
   * instead of a full table scan.
   *
   * FIX
   * ---
   * Add WHERE status = 'active' to listNodesForRoutingStmt (and a matching
   * CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes(status) to the
   * schema).  Remove the JavaScript status filter from Router.selectNode().
   */

  const TEST_ACTIVE = `TEST-BUG-F-ACTIVE-${Date.now()}`;
  const TEST_PROV   = `TEST-BUG-F-PROV-${Date.now()}`;

  let NodeStore: any;
  let db:        any;

  before(async () => {
    ({ NodeStore, db } = await import('../../data/node_store.js'));

    const dummyKey = Buffer.alloc(32, 0xab);
    NodeStore.upsertNode({ id: TEST_ACTIVE, pubkey_ed25519: dummyKey, region: 'test', contact: 'a@a.test', status: 'active' });
    NodeStore.upsertNode({ id: TEST_PROV,   pubkey_ed25519: dummyKey, region: 'test', contact: 'b@b.test', status: 'provisioning' });
  });

  after(() => {
    try { NodeStore?.deleteNode(TEST_ACTIVE); } catch { /* ignore */ }
    try { NodeStore?.deleteNode(TEST_PROV);   } catch { /* ignore */ }
  });

  it('must NOT return provisioning/inactive nodes — currently it does (WHERE clause is missing)', () => {
    const routing: Array<{ id: string; status: string }> = NodeStore.listNodesForRouting();

    const provIncluded = routing.some((n: any) => n.id === TEST_PROV);

    // EXPECTED after fix:  provIncluded === false (SQL WHERE filters it out).
    // ACTUAL before fix:   provIncluded === true  (all rows returned, no SQL filter).
    assert.equal(
      provIncluded, false,
      `[BUG-F] listNodesForRouting must only return active nodes ` +
      `(needs WHERE status = 'active' in the SQL).  The provisioning node ` +
      `'${TEST_PROV}' appears in the result when it should be excluded.  ` +
      `With 1 000 nodes in mixed states this adds unnecessary DB→JS transfer ` +
      `and deserialisation on every routing cache miss (every 3 seconds).`,
    );
  });

  it('must return active nodes (sanity / regression guard)', () => {
    const routing: Array<{ id: string }> = NodeStore.listNodesForRouting();
    assert.ok(
      routing.some((n: any) => n.id === TEST_ACTIVE),
      `Active node '${TEST_ACTIVE}' must appear in the routing list`,
    );
  });

  it('all returned routing rows must have status === active — verifies the fix end-to-end', () => {
    const routing: Array<{ id: string; status: string }> = NodeStore.listNodesForRouting();

    // Check only test-inserted rows to avoid false positives from real prod data.
    const testRows    = routing.filter((n: any) => n.id.startsWith('TEST-BUG-F-'));
    const nonActive   = testRows.filter((n: any) => n.status !== 'active');

    // EXPECTED after fix:  nonActive.length === 0.
    // ACTUAL before fix:   nonActive contains the 'provisioning' test node.
    assert.equal(
      nonActive.length, 0,
      `[BUG-F] Every routing row must have status='active'.  ` +
      `Found ${nonActive.length} non-active test row(s): ` +
      `${nonActive.map((n: any) => `${n.id}(${n.status})`).join(', ')}.  ` +
      `Fix: add WHERE status = 'active' to listNodesForRoutingStmt.`,
    );
  });

  it('query plan shows full SCAN — documents why the status index is needed', () => {
    /**
     * SQLite EXPLAIN QUERY PLAN reveals whether a table scan or an index is used.
     * This test documents the CURRENT (bad) plan so developers can see the
     * improvement after adding the WHERE clause and status index.
     */
    const plan: Array<{ detail: string }> = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, region, status, domain, capabilities
         FROM nodes
         ORDER BY created_at DESC`,
      )
      .all();

    const planText = plan.map((r: any) => r.detail).join(' | ');
    const isFullScan = plan.some((r: any) => r.detail.toUpperCase().includes('SCAN'));

    // PASSES today: confirms the current query does a full table scan.
    // After the fix (WHERE + index) this plan should show SEARCH and this
    // assertion must be changed to: assert.ok(!isFullScan, ...).
    assert.ok(
      isFullScan,
      `[BUG-F] Expected full SCAN in query plan (documenting the current state). ` +
      `If this fails, the query was already optimised.  Plan: ${planText}`,
    );

    console.log(`\n  [BUG-F] Current query plan: ${planText}`);
    console.log(`  [BUG-F] After fix (WHERE status='active' + index), plan should use SEARCH.`);
  });
});
