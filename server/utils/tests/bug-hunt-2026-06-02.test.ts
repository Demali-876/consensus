/**
 * Bug Hunt — 2026-06-02
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  BUG-A · pendingRequests never populated  (Critical · Core feature broken)
 *
 *  Root cause: handleRequest called resolveAndCheckTarget() — an async DNS
 *  operation — BEFORE computing the dedupeKey.  Because the dedupeKey was
 *  computed after the first `await`, two concurrent calls with the same request
 *  identity would both pass the `pendingRequests.get()` check (miss) and launch
 *  independent outbound HTTP requests.  Additionally, pendingRequests.set() was
 *  never called at all, so the Map was perpetually empty and
 *  getStats().pending_requests always reported 0.
 *
 *  Fix: server/features/proxy/proxy.ts
 *    1. Moved dedupeKey computation to before any async operation (synchronous).
 *    2. Introduced _resolveAndExecute() to hold the SSRF check + routing.
 *    3. Registered the execution promise via pendingRequests.set() synchronously
 *       (before the first await) so concurrent callers always find it.
 *    4. Added try/finally to delete the entry after the promise settles.
 *
 *  Regression: if pendingRequests.set() is removed or moved after an await,
 *  the concurrent deduplication breaks and upstream receives multiple calls.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  BUG-B · ssrfCheck option missing from ProxyConfig  (Medium · Test-only)
 *
 *  Root cause: security-perf.test.ts already used
 *    new ConsensusProxy({ ssrfCheck: noSsrf })
 *  expecting an injectable SSRF bypass for unit tests against localhost
 *  servers, but ProxyConfig had no such field.  The option was silently ignored,
 *  so BUG-1 (decompression bomb) and BUG-2 (unbounded TTL) tests received
 *  "Forbidden target_url" SSRF errors instead of testing the intended behaviour.
 *
 *  Fix: server/features/proxy/proxy.ts
 *    Added ssrfCheck?: (url: string) => Promise<boolean> to ProxyConfig and
 *    wired it up in _resolveAndExecute() so that when it is supplied it replaces
 *    the real resolveAndCheckTarget() call.
 *
 *  Regression: if ssrfCheck is removed from ProxyConfig, passing it to the
 *  constructor has no effect and localhost-targeted tests silently fail on SSRF.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Run:
 *   npx tsx --test server/utils/tests/bug-hunt-2026-06-02.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http   from 'node:http';
import ConsensusProxy, { type ProxyConfig } from '../../features/proxy/proxy.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

const noSsrf = async (_url: string): Promise<boolean> => false;

function listen(srv: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.once('error',     reject);
    srv.once('listening', resolve);
    srv.listen(port);
  });
}

function close(srv: http.Server): Promise<void> {
  return new Promise(r => srv.close(r as () => void));
}

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-B · ssrfCheck option missing from ProxyConfig
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-B · ssrfCheck option is accepted and bypasses SSRF for localhost targets', () => {
  /**
   * Before the fix, passing { ssrfCheck: noSsrf } was silently ignored.
   * The constructor would call resolveAndCheckTarget for every request, which
   * throws TypeError("Forbidden target_url") for 127.0.0.1.  Tests that relied
   * on the bypass therefore always received an SSRF error rather than testing
   * the actual proxy behaviour.
   *
   * After the fix, ssrfCheck is stored on the instance and _resolveAndExecute
   * calls it instead of resolveAndCheckTarget when it is present.
   */

  const PORT = 44_001;
  let upstream: http.Server;
  let proxy:    ConsensusProxy;

  before(async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    await listen(upstream, PORT);
    proxy = new ConsensusProxy({ ssrfCheck: noSsrf } satisfies ProxyConfig);
  });

  after(async () => {
    proxy.destroy();
    await close(upstream);
  });

  it('ssrfCheck field is present in ProxyConfig (type-level regression guard)', () => {
    // If ProxyConfig is missing ssrfCheck, the `satisfies ProxyConfig` above
    // would be a TypeScript compile error, and this import would fail at runtime.
    const cfg: ProxyConfig = { ssrfCheck: noSsrf };
    assert.equal(typeof cfg.ssrfCheck, 'function',
      'BUG-B: ssrfCheck must be accepted by ProxyConfig');
  });

  it('proxy with ssrfCheck: noSsrf reaches a localhost upstream without SSRF error', async () => {
    const result = await proxy.handleRequest(`http://localhost:${PORT}/test`, 'GET');
    assert.equal(result.status, 200,
      'BUG-B: request to localhost should succeed when ssrfCheck: noSsrf is provided');
    assert.deepEqual((result.data as any).hello, 'world');
  });

  it('proxy without ssrfCheck blocks the same localhost URL with SSRF error', async () => {
    const strictProxy = new ConsensusProxy(); // no ssrfCheck — uses real SSRF guard
    await assert.rejects(
      () => strictProxy.handleRequest(`http://localhost:${PORT}/test`, 'GET'),
      (err: unknown) =>
        err instanceof TypeError &&
        (err as TypeError).message.includes('Forbidden'),
      'BUG-B regression guard: without ssrfCheck, localhost must still be blocked',
    );
    strictProxy.destroy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-A · pendingRequests never populated — concurrent deduplication broken
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-A · Concurrent deduplication — pendingRequests must be populated', () => {
  /**
   * Before the fix, two concurrent calls to handleRequest() with identical
   * request parameters would both miss the pendingRequests check (the Map was
   * never written to) and each would independently reach the upstream, doubling
   * outbound traffic.  getStats().pending_requests was always 0.
   *
   * After the fix the dedupeKey is computed synchronously before any await, the
   * execution promise is stored in pendingRequests synchronously, and the second
   * concurrent call awaits the already-registered promise.
   *
   * These tests patch proxy.makeRequest to avoid real network I/O, giving fully
   * deterministic control over when responses are emitted.
   */

  it('getStats().pending_requests is 0 on a fresh proxy instance', () => {
    const proxy = new ConsensusProxy({ ssrfCheck: noSsrf });
    assert.equal(proxy.getStats().pending_requests, 0, 'starts empty');
    proxy.destroy();
  });

  it('pending_requests is 1 immediately after the first call starts (synchronous registration)', () => {
    const proxy = new ConsensusProxy({ ssrfCheck: noSsrf });

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>(r => { releaseBarrier = r; });

    // Patch makeRequest so the in-flight request is held open.
    (proxy as any).makeRequest = async () => {
      await barrier;
      return { status: 200, statusText: 'OK', headers: {}, data: {}, timestamp: Date.now() };
    };

    // Start the first request.  pendingRequests.set() is called synchronously
    // inside handleRequest BEFORE it yields, so the Map should be non-empty
    // immediately — no await needed.
    const p1 = proxy.handleRequest('http://example.test/r', 'GET');

    // BUG-A: without the fix this is always 0 because pendingRequests.set() was
    // never called in the original handleRequest.
    assert.equal(proxy.getStats().pending_requests, 1,
      'BUG-A: pending_requests must be 1 immediately after the first call starts ' +
      '(pendingRequests.set() was missing before the fix)');

    // Tidy up — release and discard the promise.
    releaseBarrier();
    void p1.catch(() => {});
    proxy.destroy();
  });

  it('two concurrent identical requests share one in-flight makeRequest call', async () => {
    const proxy = new ConsensusProxy({ ssrfCheck: noSsrf });

    let makeRequestCalls = 0;
    let releaseBarrier!:  () => void;
    const barrier = new Promise<void>(r => { releaseBarrier = r; });

    (proxy as any).makeRequest = async () => {
      makeRequestCalls++;
      await barrier;
      return { status: 200, statusText: 'OK', headers: {}, data: { ok: true }, timestamp: Date.now() };
    };

    const url = 'http://example.test/resource';

    // Fire both requests in the same synchronous block.
    const p1 = proxy.handleRequest(url, 'GET');
    const p2 = proxy.handleRequest(url, 'GET');

    // pendingRequests.set() is synchronous, so no await is needed to see it.
    assert.equal(proxy.getStats().pending_requests, 1,
      'BUG-A: expected 1 pending entry after both calls started');

    // Let the noSsrf microtask resolve so makeRequest is actually invoked.
    await Promise.resolve();
    await Promise.resolve();

    // BUG-A core assertion: makeRequest must have been called exactly once.
    // Before the fix, both concurrent calls would each launch their own outbound
    // request, so makeRequestCalls would be 2.
    assert.equal(makeRequestCalls, 1,
      'BUG-A: makeRequest must be called exactly once for two concurrent identical requests; ' +
      `got ${makeRequestCalls} — deduplication is broken without the fix`);

    // Release the barrier and await both callers.
    releaseBarrier();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, 200, 'first caller must succeed');
    assert.equal(r2.status, 200, 'second caller must succeed');
    assert.deepEqual(r1.data,   r2.data,
      'BUG-A: both callers must receive identical data from the shared execution');

    // After settlement the pending entry is cleaned up.
    assert.equal(proxy.getStats().pending_requests, 0,
      'BUG-A: pending_requests must return to 0 after execution settles');

    assert.equal(makeRequestCalls, 1, 'makeRequest still only called once after completion');

    proxy.destroy();
  });

  it('N concurrent identical requests all resolve to the same data with one makeRequest call', async () => {
    const proxy = new ConsensusProxy({ ssrfCheck: noSsrf });

    let makeRequestCalls = 0;
    let releaseBarrier!:  () => void;
    const barrier = new Promise<void>(r => { releaseBarrier = r; });

    (proxy as any).makeRequest = async () => {
      makeRequestCalls++;
      await barrier;
      return { status: 200, statusText: 'OK', headers: {}, data: { batch: true }, timestamp: Date.now() };
    };

    const url = 'http://example.test/batch';
    const N   = 10;

    const promises = Array.from({ length: N }, () => proxy.handleRequest(url, 'GET'));

    // One pending entry for N callers.
    assert.equal(proxy.getStats().pending_requests, 1,
      `BUG-A: ${N} concurrent requests must share exactly 1 pending-requests entry`);

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(makeRequestCalls, 1,
      `BUG-A: ${N} concurrent identical requests must produce exactly 1 makeRequest call; ` +
      `got ${makeRequestCalls}`);

    releaseBarrier();
    const results = await Promise.all(promises);

    assert.ok(results.every(r => r.status === 200), 'all callers must receive HTTP 200');
    assert.equal(makeRequestCalls, 1,
      'makeRequest still only called once after all callers resolve');

    proxy.destroy();
  });
});
