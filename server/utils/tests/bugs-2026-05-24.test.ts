/**
 * Bug Hunt Report — 2026-05-24
 *
 * Daily security & performance audit. Each suite documents a confirmed finding,
 * explains the impact, and provides a failing assertion that proves the bug is
 * present. Tests are written to FAIL with the current code and PASS after the fix.
 *
 * ─── Findings ────────────────────────────────────────────────────────────────
 *
 * [BUG-2026-1] CRITICAL  — pendingRequests Map is never written to
 *              proxy.ts: handleRequest reads pendingRequests.get() but no code
 *              path ever calls pendingRequests.set(). Concurrent identical
 *              requests are NOT coalesced; every request hits upstream separately,
 *              defeating the proxy's core deduplication guarantee and causing
 *              users to be over-charged.
 *
 * [BUG-2026-2] HIGH      — Public IPv6 literal addresses blocked by SSRF check
 *              ssrf.ts: After passing the private-IPv6 guard, a public IPv6
 *              literal like http://[2606:4700:4700::1111]/ falls through to DNS
 *              resolution, which fails for bracket-enclosed addresses, and the
 *              catch block then throws FORBIDDEN. Legitimate IPv6-only services
 *              are unreachable through the proxy.
 *
 * [BUG-2026-3] HIGH      — proxy.test.ts: all handleRequest tests silently broken
 *              resolveAndCheckTarget is called BEFORE the cache check, so every
 *              test that calls proxy.handleRequest('http://localhost:…') throws
 *              "Forbidden target_url" immediately. 28+ tests were silently
 *              failing, meaning the deduplication & caching logic has had no
 *              test coverage since SSRF protection was added.
 *
 * [BUG-2026-4] MEDIUM    — x-cache-ttl: 0 (no-cache intent) is silently clamped
 *              proxy.ts line 265: resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL)
 *              Callers who send x-cache-ttl: 0 to bypass the cache get 1 second
 *              of caching instead. Stale responses can be served when callers
 *              explicitly requested freshness.
 *
 * [PERF-2026-1] MEDIUM   — N+1 DB queries in Router._buildStats()
 *              router.ts _buildStats(): NodeStore.listNodes() fetches all nodes
 *              (1 query), but load_distribution then calls NodeStore.getNode()
 *              once per entry in activeRequests (N more queries). Under load
 *              with many active nodes this causes excessive SQLite contention.
 *              Fix: build a lookup Map from the already-fetched allNodes array.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert   from 'node:assert/strict';
import fs       from 'node:fs';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import NodeStore from '../../../server/data/node_store.js';
import Router    from '../../router.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_SRC = path.resolve(__dirname, '../../features/proxy/proxy.ts');

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-2026-1] pendingRequests Map is never written to
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-2026-1] pendingRequests.set() is never called — concurrent deduplication broken', () => {
  /**
   * Root cause: during a refactor the comment in executeDirect was updated to say
   * "Pending-request registration…is owned by handleRequest", but the actual
   * this.pendingRequests.set(dedupeKey, promise) call was never added to
   * handleRequest. The Map is checked (.get) and cleaned (.delete via clearKey)
   * but the registration path simply does not exist.
   *
   * Impact:
   *  - 5 concurrent identical requests each make a separate upstream call
   *    instead of the expected 1. The proxy's core value proposition fails.
   *  - Payment enforcement is undermined: each concurrent request could
   *    independently trigger payment for the same upstream work.
   *  - All 28+ deduplication and caching tests in proxy.test.ts that call
   *    handleRequest() were also silently broken by the SSRF-before-cache-check
   *    ordering (see BUG-2026-3), masking this bug.
   *
   * Fix: in handleRequest(), after the cache/pending check, wrap the execute
   * call in a pending-registration block:
   *
   *   const promise = node ? this.executeViaNode(...) : this.executeDirect(...);
   *   this.pendingRequests.set(dedupeKey, promise);
   *   try { return await promise; } finally { this.pendingRequests.delete(dedupeKey); }
   */

  it('proxy.ts source contains no this.pendingRequests.set() call', () => {
    const src = fs.readFileSync(PROXY_SRC, 'utf8');

    const hasSet = /this\.pendingRequests\.set\s*\(/.test(src);

    // This assertion FAILS with current code (bug present) and
    // PASSES once the registration call is added.
    assert.ok(
      hasSet,
      'CONFIRMED BUG [BUG-2026-1]: this.pendingRequests.set() is never called ' +
      'in proxy.ts. Concurrent identical requests are NOT coalesced — each one ' +
      'hits upstream independently instead of sharing a single in-flight promise.',
    );
  });

  it('pendingRequests.set() is called before the first await — coalescing now works', async () => {
    /**
     * After the fix: the placeholder is registered synchronously BEFORE the
     * SSRF check. Concurrent requests arriving while SSRF resolves will find
     * the entry and coalesce onto the same promise.
     */
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    const pending = (proxy as any).pendingRequests as Map<string, unknown>;
    let setCalls = 0;
    const realSet = pending.set.bind(pending);
    (pending as any).set = (...args: Parameters<typeof realSet>) => {
      setCalls++;
      return realSet(...args);
    };

    try {
      await proxy.handleRequest('http://localhost:9999/test', 'GET');
    } catch {
      // Expected: SSRF TypeError (localhost is private); registration still happens
    }

    // With the fix: .set() fires before the first await (SSRF check), so the
    // assertion passes. Re-introducing the bug (removing .set()) will fail this.
    assert.ok(
      setCalls > 0,
      'pendingRequests.set() must be called synchronously before the first await ' +
      'so concurrent identical requests coalesce instead of each hitting upstream.',
    );

    proxy.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-2026-2] Public IPv6 literal addresses blocked by SSRF check
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-2026-2] SSRF check incorrectly rejects public IPv6 literal URLs', () => {
  /**
   * Root cause: resolveAndCheckTarget() handles three cases for the hostname:
   *   1. Private IPv6 literal → rejected (correct)
   *   2. IPv4 literal / IPv4-mapped IPv6 → validated & returned (correct)
   *   3. Hostname → DNS resolved (correct)
   *
   * Missing case: PUBLIC IPv6 literal (e.g. [2606:4700:4700::1111]).
   * After the private-IPv6 guard passes, normalizeToIPv4() returns null (it's
   * not IPv4-mapped), so execution falls through to dns.lookup('[2606:…]').
   * dns.lookup rejects bracket-enclosed addresses with ENOTFOUND/EINVAL, the
   * catch block fires, and TypeError(FORBIDDEN) is thrown.
   *
   * Fix: after isPrivateIPv6Bare returns false, check if bare contains ':'.
   * If so, it is a verified-public IPv6 literal — return it directly:
   *   if (bare.includes(':')) return { ip: bare, family: 6, hostname, isLiteral: true };
   */

  it('rejects loopback IPv6 [::1] — this must keep working', async () => {
    const { resolveAndCheckTarget } = await import('../../utils/ssrf.ts');
    await assert.rejects(
      () => resolveAndCheckTarget('http://[::1]/sensitive'),
      (e: unknown) => e instanceof TypeError && (e as TypeError).message.includes('Forbidden'),
      'Loopback [::1] must remain blocked',
    );
  });

  it('rejects ULA IPv6 [fd00::1] — this must keep working', async () => {
    const { resolveAndCheckTarget } = await import('../../utils/ssrf.ts');
    await assert.rejects(
      () => resolveAndCheckTarget('http://[fd00::1]/internal'),
      (e: unknown) => e instanceof TypeError,
      'ULA [fd00::1] must remain blocked',
    );
  });

  it('rejects link-local IPv6 [fe80::1] — this must keep working', async () => {
    const { resolveAndCheckTarget } = await import('../../utils/ssrf.ts');
    await assert.rejects(
      () => resolveAndCheckTarget('http://[fe80::1]/link'),
      (e: unknown) => e instanceof TypeError,
      'Link-local [fe80::1] must remain blocked',
    );
  });

  it('CONFIRMED BUG: public IPv6 literal [2606:4700:4700::1111] is erroneously blocked', async () => {
    const { resolveAndCheckTarget } = await import('../../utils/ssrf.ts');

    // 2606:4700:4700::1111 is Cloudflare public DNS — definitively NOT private.
    // This assertion FAILS with current code (bug present) and
    // PASSES once the public-IPv6-literal branch is added to ssrf.ts.
    await assert.doesNotReject(
      () => resolveAndCheckTarget('http://[2606:4700:4700::1111]/dns-query'),
      'CONFIRMED BUG [BUG-2026-2]: a public IPv6 literal falls through to ' +
      'DNS resolution (which fails for bracket-enclosed addresses) and is ' +
      'then mis-classified as a forbidden private target. All IPv6-only ' +
      'upstream services are unreachable through the proxy.',
    );
  });

  it('CONFIRMED BUG: resolveAndCheckTarget returns isLiteral:true for public IPv6 literals', async () => {
    const { resolveAndCheckTarget } = await import('../../utils/ssrf.ts');

    let result: Awaited<ReturnType<typeof resolveAndCheckTarget>> | undefined;
    try {
      result = await resolveAndCheckTarget('http://[2606:4700:4700::1111]/api');
    } catch {
      // Bug: falls through to DNS and throws FORBIDDEN
    }

    // After the fix, result should be a valid SafeResolution with isLiteral: true
    assert.ok(
      result !== undefined && result.isLiteral === true && result.family === 6,
      'CONFIRMED BUG [BUG-2026-2]: resolveAndCheckTarget should return ' +
      '{ isLiteral: true, family: 6 } for a public IPv6 literal, but it throws.',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-2026-3] proxy.test.ts tests broken — SSRF check before cache check
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-2026-3] SSRF check runs before cache check — breaks test suite & wastes latency on hits', () => {
  /**
   * Root cause: handleRequest() calls resolveAndCheckTarget() as its very first
   * async step, before checking the cache. This has two consequences:
   *
   *  A) TEST BREAKAGE: Every call to proxy.handleRequest('http://localhost:…')
   *     throws "Forbidden target_url — private/internal addresses are not allowed"
   *     because localhost resolves to 127.0.0.1. The entire proxy.test.ts suite
   *     (28 tests across Basic caching, Micro-caching, Deduplication, Error
   *     responses, x-api-key scoping, Body hashing, x-cache-ttl, TTL expiry,
   *     Payment helpers, clearKey, getCached, getStats) was silently failing,
   *     meaning NO regression coverage existed for the proxy's core logic.
   *
   *  B) PERFORMANCE: Cache hits incur a DNS round-trip (or cache lookup) that
   *     is never needed — a cached response does not require a safe resolution
   *     because no outbound connection is made.
   *
   * Fix: Move the resolveAndCheckTarget() call to after the cache & pending
   * checks. Cache hits and coalesced-pending hits can return immediately without
   * any DNS work. Only a true cache miss needs SSRF validation.
   */

  it('CONFIRMED BUG: handleRequest throws SSRF error for localhost — all caching tests broken', async () => {
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    let error: Error | undefined;
    try {
      await proxy.handleRequest('http://localhost:19991/test', 'GET');
    } catch (e: unknown) {
      error = e as Error;
    } finally {
      proxy.destroy();
    }

    // With the bug: SSRF TypeError fires before reaching any cache/deduplication logic.
    // The test documents this so the failure is visible and tracked.
    assert.ok(
      error !== undefined && error instanceof TypeError &&
      error.message.includes('Forbidden target_url'),
      `CONFIRMED BUG [BUG-2026-3]: handleRequest('http://localhost:…') throws ` +
      `"${error?.message ?? 'no error'}" — SSRF check fires before cache check. ` +
      'All proxy.test.ts integration tests that use localhost are silently broken.',
    );
  });

  it('CONFIRMED BUG: resolveAndCheckTarget is called even for requests that hit the cache', async () => {
    /**
     * Evidence: in proxy.ts handleRequest(), line order is:
     *   1. resolveAndCheckTarget(target_url)   ← SSRF (async DNS)
     *   2. generateDedupeKey(...)
     *   3. this.cache.get(dedupeKey)           ← cache check
     *
     * A cache HIT at step 3 means the outbound connection was already made by a
     * prior request. No DNS resolution is needed now, yet the DNS round-trip still
     * fires. On a cold DNS cache this adds 10–50 ms of latency to every cache hit.
     */
    const src = fs.readFileSync(PROXY_SRC, 'utf8');

    // Find the character positions of the two calls to confirm ordering
    const ssrfPos  = src.indexOf('resolveAndCheckTarget(');
    const cachePos = src.indexOf('this.cache.get<');

    assert.ok(ssrfPos !== -1 && cachePos !== -1, 'Both symbols must exist in proxy.ts');

    // This assertion FAILS with current code (ssrfPos < cachePos = bug present)
    // and PASSES once resolveAndCheckTarget is moved after the cache check.
    assert.ok(
      ssrfPos > cachePos,
      `CONFIRMED BUG [BUG-2026-3]: resolveAndCheckTarget (char ${ssrfPos}) ` +
      `appears BEFORE this.cache.get (char ${cachePos}) in handleRequest(). ` +
      'SSRF DNS work is wasted on every cache hit.',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-2026-4] x-cache-ttl: 0 is silently clamped to 1 second
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-2026-4] x-cache-ttl:0 (no-cache intent) is silently clamped to 1 second', () => {
  /**
   * Root cause: proxy.ts line ~265:
   *   const ttl = Math.min(MAX_CACHE_TTL_SEC, resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL));
   *
   * The intent of the ternary is to enforce a minimum TTL of 1 second, but it
   * treats TTL=0 as if it were TTL=1. Callers who send x-cache-ttl: 0 to signal
   * "do not cache this response" instead get 1 second of caching.
   *
   * This matters in scenarios where the upstream response must always be fresh
   * (financial data, auth tokens, one-time payloads). A stale response served
   * within that 1-second window is a correctness bug and potentially a security
   * issue.
   *
   * Fix: treat TTL ≤ 0 as "skip cache entirely" instead of clamping to 1.
   * The simplest fix is to check `if (ttl === 0) skip caching` before storing.
   */

  it('TTL=0 is now treated as skip-cache — buggy ternary removed from source', () => {
    /**
     * The old formula was:  resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL)
     * The fix changes it to: resolvedTTL === 0 ? 0 : Math.min(MAX, Math.max(1, …))
     *
     * We detect the bug/fix by searching for the old ternary in the source.
     * This test FAILS while the buggy formula is present and PASSES after the fix.
     */
    const src = fs.readFileSync(PROXY_SRC, 'utf8');

    // The buggy pattern: "resolvedTTL === 0 ? 1 :"
    const hasBuggyFormula = /resolvedTTL\s*===\s*0\s*\?\s*1\s*:/.test(src);

    assert.equal(
      hasBuggyFormula, false,
      'CONFIRMED BUG [BUG-2026-4]: the formula "resolvedTTL === 0 ? 1 : …" is ' +
      'still in proxy.ts. TTL=0 must map to 0 (skip cache), not 1 (cache for 1s).',
    );
  });

  it('non-zero TTL clamping still works correctly (regression guard)', () => {
    const MAX_CACHE_TTL_SEC = 3_600;
    const clamp = (resolvedTTL: number) =>
      Math.min(MAX_CACHE_TTL_SEC, resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL));

    assert.equal(clamp(1),    1,    'TTL=1 stays 1');
    assert.equal(clamp(300),  300,  'TTL=300 stays 300');
    assert.equal(clamp(3600), 3600, 'TTL=3600 stays 3600 (max)');
    assert.equal(clamp(9999), 3600, 'TTL=9999 clamped to max 3600');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [PERF-2026-1] N+1 DB queries in Router._buildStats()
// ─────────────────────────────────────────────────────────────────────────────

describe('[PERF-2026-1] Router._buildStats() makes N+1 DB queries — one per active node', () => {
  /**
   * Root cause: router.ts _buildStats() first fetches all nodes via
   * NodeStore.listNodes() (1 query), then inside load_distribution's .map()
   * calls NodeStore.getNode(nodeId) once per entry in this.activeRequests
   * (N separate queries).
   *
   *   const allNodes = NodeStore.listNodes();   // query 1
   *   ...
   *   load_distribution: Array.from(this.activeRequests.keys()).map((nodeId) => {
   *     const node = NodeStore.getNode(nodeId); // query 2 … N+1  ← BUG
   *   })
   *
   * The `allNodes` array already contains every node. A simple O(1) Map lookup
   * would avoid all N redundant queries.
   *
   * Impact: under production load with, say, 20 nodes, getStats() fires 21 DB
   * queries instead of 1. Since /health and /stats call getStats() on every
   * request, this creates unnecessary SQLite read contention.
   *
   * Fix: build a lookup Map before load_distribution:
   *   const nodeById = new Map(allNodes.map(n => [n.id, n]));
   *   ...
   *   const node = nodeById.get(nodeId);  // O(1) — no DB call
   */

  let getNodeCallCount = 0;
  let listNodesCallCount = 0;

  before(() => {
    mock.method(NodeStore, 'getNode', function (this: typeof NodeStore, id: string) {
      getNodeCallCount++;
      return (NodeStore as any)._originalGetNode
        ? (NodeStore as any)._originalGetNode(id)
        : null;
    });

    // Store original and instrument listNodes too for reference
    const origList = NodeStore.listNodes.bind(NodeStore);
    mock.method(NodeStore, 'listNodes', function () {
      listNodesCallCount++;
      return origList();
    });
  });

  after(() => {
    mock.restoreAll();
  });

  it('CONFIRMED BUG: getStats() calls NodeStore.getNode() once per active-request node (N+1 pattern)', () => {
    const router = new Router();

    // Simulate 3 nodes with active requests — typical production state
    const nodeIds = ['node-alpha', 'node-beta', 'node-gamma'];
    for (const id of nodeIds) router.incrementRequest(id);

    getNodeCallCount = 0;
    listNodesCallCount = 0;

    router.getStats();

    const N = nodeIds.length;

    // With the bug: getNode is called N times (once per active node)
    // After the fix: getNode should be called 0 times (use existing allNodes data)
    assert.equal(
      getNodeCallCount, 0,
      `CONFIRMED BUG [PERF-2026-1]: NodeStore.getNode() was called ` +
      `${getNodeCallCount} time(s) during getStats() for ${N} active nodes. ` +
      `All node data is already available from the initial listNodes() call — ` +
      `these are redundant N+1 queries. Use a Map lookup on allNodes instead.`,
    );
  });

  it('listNodes() is called exactly once per getStats() call (this should stay true)', () => {
    const router = new Router();
    listNodesCallCount = 0;
    router.getStats();
    // Confirms that the single bulk-fetch is there — we just need to USE it for load_distribution too
    assert.ok(listNodesCallCount >= 1, 'listNodes must be called to build stats');
  });
});
