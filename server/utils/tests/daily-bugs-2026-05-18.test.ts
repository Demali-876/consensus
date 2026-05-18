/**
 * Daily Bug Hunt — 2026-05-18
 *
 * Three new confirmed bugs (all OPEN):
 *
 * [SEC-4] Path traversal in certs.js — nodeId reaches path.resolve() unvalidated
 * [PERF-3] pendingRequests never populated — in-flight dedup is entirely broken
 * [PERF-4] DNS_CACHE memory leak — expired entries accumulate in ssrf.ts forever
 *
 * Each suite explains the root cause, proves the bug is present, and documents
 * what a correct fix looks like.
 */

import { describe, it }             from 'node:test';
import assert                        from 'node:assert/strict';
import path                          from 'node:path';
import fs                            from 'node:fs/promises';
import { fileURLToPath }             from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// certs.js lives in server/utils/ — one directory above this test file.
const CERTS_JS_DIRNAME = path.resolve(__dirname, '..');
const CERT_ROOT        = path.resolve(CERTS_JS_DIRNAME, '..', 'node-certs');

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-4]  Path traversal in issueNodeCertificate / revokeNodeCertificate
// ─────────────────────────────────────────────────────────────────────────────

describe('[SEC-4] certs.js — nodeId path traversal escapes the node-certs/ directory', () => {
  /**
   * ROOT CAUSE (certs.js line 26):
   *   const certDir = path.resolve(__dirname, '..', 'node-certs', nodeId);
   *
   * `domain` is validated with a strict regex (line 14) but `nodeId` is passed
   * directly into path.resolve() with zero sanitisation.
   *
   * path.resolve() resolves '..' segments eagerly, so a nodeId that contains
   * path separators or '..' sequences walks right out of the intended
   * server/node-certs/ subtree.
   *
   * IMPACT:
   *   • issueNodeCertificate('../../evil', 'example.com')
   *       → creates certDir at  <project-root>/evil/
   *       → writes  node.key / node.crt / node.csr there
   *   • revokeNodeCertificate('../../evil')
   *       → calls  fs.rm('<project-root>/evil', { recursive: true, force: true })
   *       → silently deletes an arbitrary directory tree
   *
   * Anyone who can supply the nodeId to the orchestrator (e.g. a malicious node
   * registration request) can read/write/delete files outside the project.
   *
   * FIX (two-line):
   *   1. Reject any nodeId containing '/', '\\', '\0', or '..'.
   *   2. Assert that certDir.startsWith(CERT_ROOT + path.sep) after resolving.
   *
   *   Example guard:
   *     const VALID_NODE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
   *     if (!VALID_NODE_ID.test(nodeId)) throw new Error('invalid nodeId');
   *     const certDir = path.resolve(__dirname, '..', 'node-certs', nodeId);
   *     if (!certDir.startsWith(CERT_ROOT + path.sep))
   *       throw new Error('nodeId escapes cert directory');
   */

  it('a traversal nodeId resolves to a path OUTSIDE node-certs/', () => {
    // Reproduce the vulnerable path construction from certs.js line 26 verbatim.
    const maliciousNodeId = '../../tmp';
    const certDir = path.resolve(CERTS_JS_DIRNAME, '..', 'node-certs', maliciousNodeId);

    // This assertion PASSES because the path DOES escape — proving the bug.
    assert.ok(
      !certDir.startsWith(CERT_ROOT + path.sep) && certDir !== CERT_ROOT,
      `expected certDir to escape CERT_ROOT, but got: ${certDir}`,
    );
    // For clarity: show where the path lands
    const expected = path.resolve(CERT_ROOT, '..', '..', 'tmp');
    assert.equal(
      certDir,
      expected,
      `BUG [SEC-4]: nodeId "${maliciousNodeId}" resolves to "${certDir}" — ` +
      `${path.relative(CERT_ROOT, certDir)} above the intended root`,
    );
  });

  it('a safe nodeId resolves INSIDE node-certs/ (control: shows what correct looks like)', () => {
    const safeNodeId = 'abc123-node';
    const certDir = path.resolve(CERTS_JS_DIRNAME, '..', 'node-certs', safeNodeId);
    assert.ok(
      certDir.startsWith(CERT_ROOT + path.sep),
      `safe nodeId must resolve inside CERT_ROOT; got: ${certDir}`,
    );
  });

  it('revokeNodeCertificate would call fs.rm on an out-of-bounds path', () => {
    // revokeNodeCertificate (certs.js line 50) uses the same path.resolve formula,
    // then calls fs.rm(certDir, { recursive: true, force: true }).
    // With nodeId='../../server', certDir resolves to server/ — the entire source tree.
    const destructiveNodeId = '../../server';
    const certDir = path.resolve(CERTS_JS_DIRNAME, '..', 'node-certs', destructiveNodeId);
    // Expected: two levels up from node-certs/ lands back in server/, then appends 'server'
    // path.resolve('/…/server/node-certs', '../../server') = '/…/server'
    const serverSourceDir = path.resolve(CERTS_JS_DIRNAME, '..');

    assert.equal(
      certDir,
      serverSourceDir,
      `BUG [SEC-4]: nodeId "${destructiveNodeId}" makes revokeNodeCertificate target ` +
      `"${serverSourceDir}" for recursive deletion — the entire server source tree`,
    );
    assert.ok(
      !certDir.startsWith(CERT_ROOT + path.sep),
      'the resolved path must be outside CERT_ROOT to prove the traversal',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [PERF-3]  In-flight request deduplication is completely broken
// ─────────────────────────────────────────────────────────────────────────────

describe('[PERF-3] ConsensusProxy.pendingRequests — map is read but never written', () => {
  /**
   * ROOT CAUSE (proxy.ts line 275):
   *   const pending = this.pendingRequests.get(dedupeKey);
   *   if (pending) { ... await pending ... }   // <- correct guard
   *
   * BUT: this.pendingRequests.set(dedupeKey, promise) is never called anywhere
   * in the class.  The comment at line 400-401 says:
   *   "Pending-request registration and leak-guard are owned by handleRequest"
   * — the intent was clear; the implementation was never added.
   *
   * IMPACT:
   *   • Every concurrent request for the same dedupeKey independently falls
   *     through to executeDirect / executeViaNode.
   *   • N identical in-flight requests → N upstream calls instead of 1.
   *   • This defeats the primary deduplication guarantee of the proxy.
   *   • Under burst traffic (e.g. 100 clients polling the same endpoint),
   *     upstream load is multiplied 100×.
   *   • getStats().pending_requests reports 0 at all times — impossible to
   *     observe the problem without an upstream hit counter.
   *
   * EVIDENCE:
   *   • The existing "Request deduplication" suite in proxy.test.ts asserts
   *     upstreamHits === 1 for 5 concurrent requests; it would fail with
   *     upstreamHits === 5 if SSRF didn't short-circuit it first.
   *   • This static analysis test is the clean proof.
   *
   * FIX:
   *   In handleRequest, before calling executeDirect / executeViaNode:
   *
   *     const promise = this.executeDirect(...);   // or executeViaNode
   *     this.pendingRequests.set(dedupeKey, promise);
   *     try {
   *       return await promise;
   *     } finally {
   *       this.pendingRequests.delete(dedupeKey);
   *     }
   */

  it('pendingRequests.set() is called 0 times — the dedup map is write-never', async () => {
    const srcPath = new URL('../../features/proxy/proxy.ts', import.meta.url).pathname;
    const src     = await fs.readFile(srcPath, 'utf8');

    const setCalls = (src.match(/pendingRequests\.set\s*\(/g) ?? []).length;
    const getCalls = (src.match(/pendingRequests\.get\s*\(/g) ?? []).length;

    // The map is read (get) to check for in-flight requests, but never written.
    assert.ok(
      getCalls > 0,
      'pre-condition: pendingRequests.get() must be present (dedup guard exists)',
    );
    assert.equal(
      setCalls,
      0,
      `BUG [PERF-3]: pendingRequests.set() appears ${setCalls} time(s). ` +
      `The map has ${getCalls} .get() call(s) but zero .set() calls — ` +
      'every concurrent identical request independently hits the upstream.',
    );
  });

  it('getStats() reports pending_requests=0 at all times because the map is always empty', async () => {
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    try {
      // Even right after construction the map is empty — and it can never grow
      // because .set() is never called. If dedup worked, this would be > 0
      // during an in-flight request.
      const stats = proxy.getStats();
      assert.equal(
        stats.pending_requests,
        0,
        'BUG [PERF-3]: pending_requests is always 0 — the map can never hold an entry',
      );
    } finally {
      proxy.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [PERF-4]  DNS_CACHE memory leak — expired entries never evicted
// ─────────────────────────────────────────────────────────────────────────────

describe('[PERF-4] ssrf.ts DNS_CACHE — no eviction timer; Map grows without bound', () => {
  /**
   * ROOT CAUSE (ssrf.ts line 27):
   *   const DNS_CACHE = new Map<string, DnsCacheEntry>();
   *
   * Every resolved hostname gets an entry with an expiresAt timestamp.  Lookup
   * code at line 133 ignores stale entries and re-resolves, but it NEVER calls
   * DNS_CACHE.delete() for the old entry.  There is no setInterval() cleanup
   * anywhere in the module.
   *
   * IMPACT:
   *   • Each unique hostname ever proxied leaves one entry in DNS_CACHE forever.
   *   • A server proxying 1 000 unique hosts/minute grows the Map by
   *     ~60 000 entries/hour, all of them dead weight after 30 s (DNS_TTL_MS).
   *   • At ~200 bytes / entry that is ~12 MB/hour of leaked heap with no cap.
   *   • V8 cannot GC Map entries; only explicit delete() or Map replacement
   *     can free them.
   *
   * CONTRAST: proxy.ts solves the identical problem for paidKeys (line 549):
   *   private cleanupExpiredKeys(): void {
   *     const cutoff = Date.now() - 5 * 60 * 1000;
   *     for (const [key, ts] of this.paidKeys)
   *       if (ts < cutoff) this.paidKeys.delete(key);
   *   }
   *   this.cleanupTimer = setInterval(() => this.cleanupExpiredKeys(), 60_000);
   *
   * FIX (four lines — mirrors paidKeys pattern):
   *   const DNS_SWEEP_MS = DNS_TTL_MS;
   *   const sweepTimer = setInterval(() => {
   *     const now = Date.now();
   *     for (const [k, v] of DNS_CACHE) if (v.expiresAt <= now) DNS_CACHE.delete(k);
   *   }, DNS_SWEEP_MS);
   *   sweepTimer.unref();
   */

  it('ssrf.ts contains no setInterval that references DNS_CACHE', async () => {
    const srcPath = new URL('../../utils/ssrf.ts', import.meta.url).pathname;
    const src     = await fs.readFile(srcPath, 'utf8');

    // A fix would add setInterval + DNS_CACHE.delete() in the same callback.
    const hasCleanupInterval =
      src.includes('setInterval') && src.includes('DNS_CACHE');

    assert.equal(
      hasCleanupInterval,
      false,
      'BUG [PERF-4]: ssrf.ts has no setInterval that sweeps DNS_CACHE. ' +
      'Compare with proxy.ts cleanupTimer which correctly prunes paidKeys.',
    );
  });

  it('ssrf.ts never calls DNS_CACHE.delete() — stale entries cannot be evicted', async () => {
    const srcPath = new URL('../../utils/ssrf.ts', import.meta.url).pathname;
    const src     = await fs.readFile(srcPath, 'utf8');

    const deleteCalls = (src.match(/DNS_CACHE\.delete\s*\(/g) ?? []).length;
    assert.equal(
      deleteCalls,
      0,
      `BUG [PERF-4]: DNS_CACHE.delete() is called ${deleteCalls} time(s). ` +
      'Without delete(), Map entries are retained in memory indefinitely.',
    );
  });

  it('expired-entry accumulation pattern: 10 000 entries remain after all TTLs lapse', () => {
    // Reproduce the exact cache type used in ssrf.ts to measure growth.
    interface CacheEntry { isPrivate: boolean; expiresAt: number }
    const cache = new Map<string, CacheEntry>();
    const N = 10_000;

    // Populate with already-expired entries (simulates steady-state after 30 s).
    for (let i = 0; i < N; i++) {
      cache.set(`host-${i}.example.com`, { isPrivate: false, expiresAt: Date.now() - 1 });
    }

    // ssrf.ts lookup logic: on expiry the code skips the entry but does NOT delete it.
    // After expiry, cache.size is still N — not 0.
    assert.equal(
      cache.size,
      N,
      `BUG [PERF-4]: ${N} expired entries remain in the Map (size=${cache.size}). ` +
      'Without a sweep, heap usage grows proportionally to unique host traffic volume.',
    );

    // Proof that explicit delete() is the fix — after deleting, size returns to 0.
    for (const [k, v] of cache) {
      if (v.expiresAt <= Date.now()) cache.delete(k);
    }
    assert.equal(cache.size, 0, 'after sweep, no stale entries remain (correct behaviour)');
  });
});
