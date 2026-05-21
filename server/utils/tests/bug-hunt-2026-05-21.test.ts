/**
 * Daily Bug Hunt — 2026-05-21
 *
 * [BUG-NEW-1] In-flight request deduplication broken (proxy.ts)
 *   pendingRequests.set() is never called in handleRequest(); the Map is
 *   declared (line 207) and checked (line 275) but never populated.  The
 *   comment at line 401 describes the intent but the .set() call was dropped
 *   during a refactor.  Consequence: every concurrent handleRequest with the
 *   same dedupeKey fires its own upstream call instead of coalescing.
 *
 * [SEC-NEW-1] SSRF bypass via HTTP redirect following (proxy.ts)
 *   makeRequest() passes maxRedirects:5 to axios (line 471).
 *   resolveAndCheckTarget() is called ONCE before the first request.
 *   If the upstream responds with a 3xx whose Location points at a private
 *   address, axios follows it unconditionally — the redirect target is never
 *   re-validated against the SSRF allowlist.
 *
 * [SEC-NEW-2] Unauthenticated heartbeat endpoint (orchestrator.js)
 *   POST /node/heartbeat/:node_id has no auth middleware.  Any internet
 *   client that knows a node_id can (a) spoof rps/p95_ms metrics, biasing
 *   load balancing, or (b) send a fake version string to prematurely clear
 *   update_state, silently disrupting rolling updates.
 *
 * [PERF-NEW-1] N+1 SQLite queries in Router._buildStats() (router.ts)
 *   _buildStats() calls NodeStore.listNodes() (1 query) then iterates
 *   this.activeRequests.keys() and calls NodeStore.getNode() per key —
 *   O(N) synchronous DB reads on every stats request when the 1-second
 *   stats cache is cold.
 */

import { describe, it, before, after } from 'node:test';
import assert   from 'node:assert/strict';
import http     from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath }   from 'node:url';
import type { AddressInfo } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── [BUG-NEW-1] In-flight deduplication is broken ───────────────────────────

describe('[BUG-NEW-1] pendingRequests.set() never called — concurrent dedup is dead code', () => {
  /**
   * STRUCTURAL PROOF:
   *   proxy.ts declares `private pendingRequests: Map<string, Promise<…>>`
   *   and checks it at line ~275, but no .set() call exists anywhere.
   *   As a result, pendingRequests.size is always 0 even during in-flight
   *   requests.  Any second call with the same dedupeKey sees an empty map
   *   and fires a redundant upstream request.
   */

  it('pendingRequests.size is 0 during an active in-flight request (set() is missing)', async () => {
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();
    const pendingMap = (proxy as any).pendingRequests as Map<string, unknown>;

    // Fire a real request (httpbin.org passes SSRF); don't await it yet.
    const reqPromise = proxy.handleRequest('https://httpbin.org/get', 'GET', {}, undefined, 60);

    // Yield to the microtask queue so handleRequest can begin its async work
    // (pass resolveAndCheckTarget, compute dedupeKey, register the pending entry).
    await new Promise<void>((r) => setImmediate(r));

    // BUG: a correct implementation would have pendingMap.size === 1 here.
    // The missing this.pendingRequests.set(dedupeKey, promise) means the
    // map is perpetually empty.
    assert.equal(
      pendingMap.size, 0,
      'BUG-NEW-1 CONFIRMED: pendingRequests.size is 0 during an in-flight request. ' +
      'Fix: in handleRequest() store the execution promise with ' +
      'this.pendingRequests.set(dedupeKey, requestPromise) before returning.',
    );

    await reqPromise.catch(() => {});
    proxy.destroy();
  }, { timeout: 15_000 });

  it('5 concurrent identical requests each reach upstream independently (should coalesce to 1)', async () => {
    /**
     * httpbin.org/delay/2 holds the connection for 2 seconds.
     * All 5 handleRequest calls start before any completes, so they all
     * check pendingRequests — which is empty because .set() was never called.
     * All 5 fire independent upstream requests.  The test asserts 1 upstream
     * call; it currently fails with 5, proving the deduplication is broken.
     */
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        proxy.handleRequest('https://httpbin.org/delay/2', 'GET', {}, undefined, 60),
      ),
    );

    const upstreamCalls = results.filter((r) => !r.cached).length;

    assert.equal(
      upstreamCalls, 1,
      `BUG-NEW-1 CONFIRMED: ${upstreamCalls} upstream calls made instead of 1. ` +
      'Root cause: this.pendingRequests.set() is never called; concurrent requests ' +
      'cannot find the in-flight promise. Fix: wrap the execution in a promise, ' +
      'store it with .set() before returning, and delete it in .finally().',
    );

    proxy.destroy();
  }, { timeout: 25_000 });
});

// ─── [SEC-NEW-1] SSRF bypass via HTTP redirect ────────────────────────────────

describe('[SEC-NEW-1] SSRF bypass — proxy follows server-issued redirects to private IPs', () => {
  /**
   * makeRequest() uses maxRedirects:5 in its axios config (proxy.ts ~line 471).
   * The SSRF check (resolveAndCheckTarget) runs once on the caller-supplied URL.
   * If the upstream returns `302 Location: http://169.254.169.254/…` (or any
   * private host), axios follows the redirect and connects to the private IP
   * without any re-validation — a classic Server-Side Request Forgery bypass.
   *
   * httpbin.org/redirect-to?url=<target> is a live redirect service we can use
   * to reproduce the attack without controlling DNS.
   */

  let secretServer: http.Server;
  let secretPort:   number;
  const SECRET = 'INTERNAL_SECRET_MUST_NOT_LEAK_VIA_PROXY_REDIRECT';

  before(async () => {
    secretServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(SECRET);
    });
    await new Promise<void>((r) => secretServer.listen(0, '127.0.0.1', r));
    secretPort = (secretServer.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((r) => secretServer.close(() => r())));

  it('private server secret must not reach the proxy response via redirect', async () => {
    /**
     * Two tiers of protection (either is sufficient):
     *   Tier 1 (applied) — maxRedirects:0: axios returns the raw 302 from
     *     httpbin.org without following it; the private secret never appears.
     *   Tier 2 (future) — manual redirect validation: each Location header is
     *     checked through resolveAndCheckTarget(); redirects to private IPs
     *     throw TypeError('Forbidden target_url …').
     *
     * BEFORE fix (maxRedirects:5): axios followed the 302 to 127.0.0.1,
     * the private secret appeared verbatim in result.data — CRITICAL SSRF.
     * AFTER  fix (maxRedirects:0): the 302 is returned as-is; no connection
     * to 127.0.0.1 is attempted and the secret is not in the response.
     */
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    const target = encodeURIComponent(`http://127.0.0.1:${secretPort}/secret`);
    const url    = `https://httpbin.org/redirect-to?url=${target}`;

    try {
      const result = await proxy.handleRequest(url, 'GET', {}, undefined, 60);
      const body = typeof result.data === 'string'
        ? result.data : JSON.stringify(result.data ?? '');

      // The private server secret must NEVER appear in the response body.
      assert.ok(
        !body.includes(SECRET),
        `CRITICAL SEC-NEW-1 — private secret leaked via redirect SSRF! ` +
        `Fix: set maxRedirects:0 in makeRequest() (proxy.ts).`,
      );

      // After the maxRedirects:0 fix the upstream 302 is returned as-is;
      // a 2xx here means the redirect was followed to 127.0.0.1.
      assert.ok(
        result.status >= 300 && result.status < 400,
        `SEC-NEW-1 CONFIRMED: proxy followed redirect to 127.0.0.1 and returned ` +
        `status ${result.status}. Fix: maxRedirects must be 0.`,
      );
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // "Forbidden target_url" = Tier-2 hardening (redirect re-validated). ✓
      // Anything else (ECONNREFUSED, ETIMEDOUT …) = connection was attempted. ✗
      assert.ok(
        msg.includes('Forbidden target_url'),
        `SEC-NEW-1 CONFIRMED: redirect to 127.0.0.1 was not blocked. ` +
        `Got: "${msg}". Expected: 3xx response OR TypeError("Forbidden target_url …"). ` +
        `Fix: ensure maxRedirects:0 is set in makeRequest() (proxy.ts).`,
      );
    } finally {
      proxy.destroy();
    }
  }, { timeout: 15_000 });
});

// ─── [SEC-NEW-2] Unauthenticated heartbeat endpoint ──────────────────────────

describe('[SEC-NEW-2] POST /node/heartbeat/:node_id has no authentication', () => {
  /**
   * The route is registered with no middleware between the path and the
   * handler.  requireLoopback is only used on DELETE /node/:id, not here.
   * Any internet client knowing a valid node_id can POST arbitrary
   * rps / p95_ms / version values, affecting routing decisions and
   * update-state tracking (clearCompletedUpdateState is called on every hit).
   */

  it('heartbeat route has no auth middleware between path and handler', () => {
    const src = readFileSync(
      resolve(__dirname, '../../features/nodes/orchestrator.js'),
      'utf8',
    );

    const routeIdx = src.indexOf("'/node/heartbeat/:node_id'");
    assert.ok(routeIdx !== -1, 'Heartbeat route must exist in orchestrator.js');

    // Capture everything between the route string and the opening brace of the
    // handler function, which is where middleware arguments would appear.
    const handlerBrace = src.indexOf('(req, res)', routeIdx);
    const middlewareStr = src.slice(routeIdx, handlerBrace);

    const hasAuth =
      middlewareStr.includes('requireLoopback') ||
      middlewareStr.includes('requireAuth')     ||
      middlewareStr.includes('verifySignature') ||
      middlewareStr.includes('authenticate')    ||
      middlewareStr.includes('paymentMiddleware');

    assert.equal(
      hasAuth, true,
      'SEC-NEW-2 CONFIRMED: POST /node/heartbeat/:node_id has no authentication. ' +
      'Any client can spoof rps/p95_ms to skew load balancing, or send a fake ' +
      'version to prematurely clear update_state for any registered node. ' +
      'Fix: require nodes to sign heartbeat payloads with their ed25519 key.',
    );
  });
});

// ─── [PERF-NEW-1] N+1 DB queries in Router._buildStats() ─────────────────────

describe('[PERF-NEW-1] Router._buildStats() issues N+1 SQLite queries per call', () => {
  /**
   * router.ts _buildStats() (line ~187):
   *   const allNodes = NodeStore.listNodes();          // 1 query (JOIN)
   *   …
   *   load_distribution: Array.from(this.activeRequests.keys()).map((nodeId) => {
   *     const node = NodeStore.getNode(nodeId);        // 1 query PER active node
   *   })
   *
   * With 10 actively routed nodes, getStats() triggers 11 synchronous SQLite
   * reads each time the 1-second stats cache expires.
   *
   * Fix: build a nodeId→node lookup map from the allNodes array already in
   * memory and replace the per-node DB call with a O(1) map lookup.
   */

  it('NodeStore.getNode is called once per activeRequests entry in _buildStats()', async () => {
    const { default: Router } = await import('../../router.ts');
    const nodeStoreModule = await import('../../data/node_store.js') as any;
    const NodeStore = nodeStoreModule.NodeStore ?? nodeStoreModule.default;

    const router = new Router();

    let getNodeCalls = 0;
    const originalGetNode = NodeStore.getNode.bind(NodeStore);
    NodeStore.getNode = (id: string) => { getNodeCalls++; return originalGetNode(id); };

    try {
      // Register 10 fake in-flight requests so _buildStats has 10 entries to loop over
      const N = 10;
      for (let i = 0; i < N; i++) {
        (router as any).activeRequests.set(`fake-node-${i}`, 1);
      }

      getNodeCalls = 0;
      (router as any)._buildStats(); // bypass the 1-second cache

      // A correct implementation makes 0 extra per-node queries (reuses allNodes data).
      // The buggy implementation makes exactly N=10 extra queries.
      assert.ok(
        getNodeCalls <= 1,
        `PERF-NEW-1 CONFIRMED: NodeStore.getNode() called ${getNodeCalls} times ` +
        `per _buildStats() with ${N} active request keys (expected ≤1). ` +
        `Fix: replace NodeStore.getNode(nodeId) in the load_distribution map() ` +
        `with a lookup into a Map built from the already-fetched allNodes array.`,
      );
    } finally {
      NodeStore.getNode = originalGetNode;
      clearInterval((router as any).sweepTimer);
    }
  });
});
