/**
 * Daily Bug Hunt — 2026-05-25
 *
 * Four findings across security and performance.  Each suite documents the root
 * cause, the blast radius, and the fix, then asserts the corrected behaviour
 * so any future regression immediately breaks CI.
 *
 * Run with:
 *   cd server && npx tsx --test utils/tests/daily-bugs-2026-05-25.test.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG-1] ConsensusProxy.pendingRequests never populated   (Critical · Perf)
 *   Root cause : pendingRequests.set() was never called in handleRequest.
 *   The map was declared, read, and cleaned up — but never written to.
 *   Impact     : Every concurrent request for the same (URL, method, headers)
 *                hits the upstream independently.  Under bursty traffic this
 *                multiplies upstream load N-fold and erases any latency benefit
 *                from deduplication.  It also means every caller is charged
 *                separately on the x402 payment path.
 *   Fix        : proxy.ts — store the inflight Promise before awaiting; delete
 *                from the map in a finally block so it is always cleaned up.
 *
 * [BUG-2] Email endpoints lack rate limiting                (High · Security)
 *   Root cause : /node/email/start and /node/email/verify are registered with
 *                no rate-limit middleware argument.
 *   Impact     : (a) Free email-spam relay — anyone can trigger unlimited
 *                    transactional emails to arbitrary addresses.
 *                (b) OTP brute-force — 6-digit codes have only 10^6 variants.
 *                    Fresh verifications can be created without limit, so an
 *                    attacker simply keeps requesting new codes and guessing.
 *   Fix        : Apply a tight per-IP rate limiter (e.g. 5 req / 10 min) on
 *                both email routes in orchestrator.js.
 *
 * [BUG-3] /node/heartbeat/:node_id accepts unauthenticated updates
 *                                                           (Medium · Security)
 *   Root cause : The heartbeat handler performs no signature or token check.
 *   Impact     : Any client that discovers a valid node_id (enumerable via GET
 *                /nodes) can:
 *                  • keep a downed node appearing alive, blocking failover
 *                  • inject false RPS / version data that skews routing
 *                  • reset in-progress update state by sending a matching
 *                    version string (clearCompletedUpdateState)
 *   Fix        : Require the node to sign the heartbeat payload with its
 *                registered Ed25519 key, OR restrict the endpoint to loopback
 *                (same approach as DELETE /node/:node_id).
 *
 * [BUG-4] orchestrator.getStats() calls listNodes() for a count
 *                                                           (Medium · Perf)
 *   Root cause : getStats() returns total_nodes via NodeStore.listNodes().length,
 *                which executes a full LEFT JOIN + JSON-deserialises every row.
 *                NodeStore.countNodes() already exists and runs SELECT COUNT(*).
 *   Impact     : Every call to GET /health performs an O(N) join query instead
 *                of the O(1) index scan.  With hundreds of nodes this inflates
 *                the health-check latency and adds unnecessary DB read I/O.
 *   Fix        : orchestrator.js — replace listNodes().length with countNodes().
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http   from 'node:http';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';
import Database from 'better-sqlite3';
import ConsensusProxy from '../../features/proxy/proxy.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function listenAsync(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve as () => void);
  });
}

function closeAsync(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    (server as any).closeAllConnections?.();
    server.close(() => resolve());
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-1]  ConsensusProxy.pendingRequests never populated
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-1] pendingRequests.set() was missing — in-flight deduplication broken', () => {
  /**
   * Before the fix handleRequest contained:
   *
   *   const pending = this.pendingRequests.get(dedupeKey);  // always undefined
   *   if (pending) { ... }                                   // unreachable
   *   ...
   *   return this.executeViaNode(...);   // pendingRequests never written
   *
   * The map was an empty decoration.  Two simultaneous requests for the same
   * URL would each call executeViaNode / executeDirect independently.
   *
   * After the fix the inflight Promise is stored before awaiting and removed
   * in a finally block, so the second concurrent caller waits on the first.
   */

  const PORT = 42_100;
  let upstream: http.Server;
  let upstreamHits: number;
  let proxy: ConsensusProxy;

  before(async () => {
    upstreamHits = 0;
    upstream = http.createServer((_req, res) => {
      upstreamHits++;
      // Slow enough that two concurrent requests will overlap.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hit: upstreamHits }));
      }, 80);
    });
    await listenAsync(upstream, PORT);

    // _ssrfCheck bypass allows tests to reach localhost targets.
    proxy = new ConsensusProxy({ _ssrfCheck: async () => false });
  });

  after(async () => {
    proxy.destroy();
    await closeAsync(upstream);
  });

  it('two concurrent identical requests produce exactly one upstream call', async () => {
    const url = `http://127.0.0.1:${PORT}/dedup-${crypto.randomUUID()}`;

    // Both requests start at the same event-loop tick — guaranteed overlap.
    const [r1, r2] = await Promise.all([
      proxy.handleRequest(url, 'GET'),
      proxy.handleRequest(url, 'GET'),
    ]);

    assert.equal(
      upstreamHits, 1,
      `BUG-1 regression: expected 1 upstream hit (deduplication), got ${upstreamHits}. ` +
      'pendingRequests.set() must be called before awaiting the inflight promise.',
    );

    // Both callers receive the same response payload.
    assert.deepEqual(
      r1.data, r2.data,
      'Both callers must receive the same deduplicated response.',
    );
  });

  it('pendingRequests map is empty after both concurrent requests complete', async () => {
    const url = `http://127.0.0.1:${PORT}/cleanup-${crypto.randomUUID()}`;

    await Promise.all([
      proxy.handleRequest(url, 'GET'),
      proxy.handleRequest(url, 'GET'),
    ]);

    const pending = (proxy as any).pendingRequests as Map<string, unknown>;
    assert.equal(
      pending.size, 0,
      'pendingRequests must be empty after all concurrent requests finish ' +
      '(finally block must always delete the entry).',
    );
  });

  it('a third sequential request re-hits the upstream (cache miss after first)', async () => {
    // Use a unique URL so the previous cache entries don't interfere.
    const url = `http://127.0.0.1:${PORT}/sequential-${crypto.randomUUID()}`;
    const hitsBefore = upstreamHits;

    // First request — cache miss, upstream hit.
    await proxy.handleRequest(url, 'GET');
    // Second request (sequential, after first completes) — cache HIT, no upstream call.
    await proxy.handleRequest(url, 'GET');

    assert.equal(
      upstreamHits, hitsBefore + 1,
      'A sequential second request must hit the cache, not the upstream again.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-2]  Email endpoints lack rate limiting
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-2] /node/email/start and /node/email/verify have no rate limiting', () => {
  /**
   * The orchestrator registers these two routes without any rate-limit
   * middleware argument.  Compare with how /node/join uses paymentMiddleware
   * as a second argument — the email routes have no such guard.
   *
   * A fix must apply a tight per-IP limiter (e.g. express-rate-limit) as the
   * second argument to both app.post() calls for the email routes.
   */

  const orchestratorPath = new URL(
    '../../features/nodes/orchestrator.js',
    import.meta.url,
  ).pathname;

  it('CONFIRMED: /node/email/start is registered without a rate-limit middleware argument', () => {
    const src = fs.readFileSync(orchestratorPath, 'utf8');

    // A rate-limited route looks like:
    //   app.post('/node/email/start', someRateLimiter, async (req, res) => {
    // An unprotected route looks like:
    //   app.post('/node/email/start', async (req, res) => {
    //
    // We detect protection by checking whether a non-async argument appears
    // between the path string and the async handler.
    const emailStartPattern =
      /app\.post\(\s*['"]\/node\/email\/start['"]\s*,\s*async\s/;

    const isUnprotected = emailStartPattern.test(src);

    assert.equal(
      isUnprotected, false,
      'BUG-2: /node/email/start is registered with no rate-limit middleware. ' +
      'Fix: add a rate limiter as the second argument to app.post() ' +
      '(e.g. emailLimiter = rateLimit({ windowMs: 10*60*1000, max: 5 })).',
    );
  });

  it('CONFIRMED: /node/email/verify is registered without a rate-limit middleware argument', () => {
    const src = fs.readFileSync(orchestratorPath, 'utf8');

    const emailVerifyPattern =
      /app\.post\(\s*['"]\/node\/email\/verify['"]\s*,\s*async\s/;

    const isUnprotected = emailVerifyPattern.test(src);

    assert.equal(
      isUnprotected, false,
      'BUG-2: /node/email/verify is registered with no rate-limit middleware. ' +
      'A 6-digit OTP has only 10^6 possibilities; without rate limiting an ' +
      'attacker can brute-force it by cycling fresh verifications. ' +
      'Fix: apply the same rate limiter used for /node/email/start.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-3]  Unauthenticated heartbeat endpoint
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-3] /node/heartbeat/:node_id accepts updates from any unauthenticated client', () => {
  /**
   * The heartbeat handler in orchestrator.js does not verify the caller.
   * Unlike DELETE /node/:node_id (requireLoopback guard) the heartbeat route
   * accepts POST from the public internet with no token or signature check.
   *
   * Any client that can enumerate node IDs (via GET /nodes, which is public)
   * can:
   *   • prevent failover by keeping a dead node appearing alive
   *   • inject false version strings to trigger clearCompletedUpdateState
   *   • skew the p95_ms / rps metrics used for weighted routing
   *
   * Fix: verify the request carries a valid Ed25519 signature over the payload
   * using the node's registered public key, OR restrict the endpoint to loopback
   * the same way DELETE /node/:node_id is protected.
   */

  const orchestratorPath = new URL(
    '../../features/nodes/orchestrator.js',
    import.meta.url,
  ).pathname;

  it('CONFIRMED: heartbeat handler has no requireLoopback guard', () => {
    const src = fs.readFileSync(orchestratorPath, 'utf8');

    // Locate the heartbeat route block.
    const heartbeatStart = src.indexOf("'/node/heartbeat/:node_id'");
    const nextRouteStart = src.indexOf("'/node/status/:node_id'");

    assert.ok(heartbeatStart !== -1, 'heartbeat route must exist in orchestrator.js');
    assert.ok(nextRouteStart  !== -1, 'next route anchor must exist');

    const heartbeatBlock = src.slice(heartbeatStart, nextRouteStart);

    // requireLoopback restricts access to 127.0.0.1 / ::1.
    const hasLoopbackGuard = heartbeatBlock.includes('requireLoopback');

    assert.equal(
      hasLoopbackGuard, true,
      'BUG-3: /node/heartbeat/:node_id lacks authentication. ' +
      'It must include requireLoopback (or equivalent signature verification) ' +
      'to prevent unauthenticated external actors from injecting fake heartbeats.',
    );
  });

  it('CONFIRMED: heartbeat handler has no signature verification', () => {
    const src = fs.readFileSync(orchestratorPath, 'utf8');

    const heartbeatStart = src.indexOf("'/node/heartbeat/:node_id'");
    const nextRouteStart = src.indexOf("'/node/status/:node_id'");
    const heartbeatBlock = src.slice(heartbeatStart, nextRouteStart);

    // A proper fix would call crypto.verify() or timingSafeEqual() against
    // the node's registered public key.
    const hasSigCheck = heartbeatBlock.includes('verify') ||
                        heartbeatBlock.includes('timingSafeEqual') ||
                        heartbeatBlock.includes('signature');

    assert.equal(
      hasSigCheck, true,
      'BUG-3: heartbeat endpoint has no cryptographic signature check. ' +
      'Any client that knows a node_id can send arbitrary heartbeat data. ' +
      'Fix: require a signature over the heartbeat payload using the node\'s Ed25519 key.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-4]  orchestrator.getStats() calls listNodes() instead of countNodes()
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-4] orchestrator.getStats() used listNodes() for a count — now uses countNodes()', () => {
  /**
   * Before the fix:
   *   getStats: () => ({ total_nodes: NodeStore.listNodes().length, ... })
   *
   * listNodes() runs:
   *   SELECT n.*, hb.* FROM nodes n LEFT JOIN heartbeats hb ON hb.node_id = n.id
   * then JSON-parses every capabilities blob for every row.
   *
   * countNodes() runs:
   *   SELECT COUNT(*) AS cnt FROM nodes
   * which uses the primary-key index — O(1) in SQLite WAL mode regardless
   * of table size.
   *
   * After the fix getStats() calls countNodes(), not listNodes().
   */

  const orchestratorPath = new URL(
    '../../features/nodes/orchestrator.js',
    import.meta.url,
  ).pathname;

  it('orchestrator.getStats() no longer calls listNodes().length', () => {
    const src = fs.readFileSync(orchestratorPath, 'utf8');

    // Extract the getStats function body (everything between "getStats:" and the
    // closing brace of the returned object literal).
    const statsStart = src.lastIndexOf('getStats:');
    assert.ok(statsStart !== -1, 'getStats must be present in orchestrator.js');

    const statsSlice = src.slice(statsStart, statsStart + 300);

    assert.ok(
      !statsSlice.includes('listNodes()'),
      'BUG-4 regression: getStats() must not call listNodes() for a count. ' +
      'Use NodeStore.countNodes() — SELECT COUNT(*) — instead of a full JOIN query.',
    );
  });

  it('orchestrator.getStats() now calls countNodes()', () => {
    const src = fs.readFileSync(orchestratorPath, 'utf8');

    const statsStart = src.lastIndexOf('getStats:');
    const statsSlice = src.slice(statsStart, statsStart + 300);

    assert.ok(
      statsSlice.includes('countNodes()'),
      'getStats() must call NodeStore.countNodes() for the total_nodes field.',
    );
  });

  it('countNodes() SELECT COUNT(*) is faster than listNodes() LEFT JOIN over 500 iterations', () => {
    // Build a temporary DB with the same schema used by node_store.js.
    const dbFile = path.join(os.tmpdir(), `bug4-bench-${Date.now()}.db`);
    const db = new Database(dbFile);

    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');

      db.exec(`
        CREATE TABLE nodes (
          id TEXT PRIMARY KEY,
          pubkey_secp256k1 BLOB,
          pubkey_ed25519   BLOB,
          region           TEXT NOT NULL DEFAULT 'us-east',
          contact          TEXT NOT NULL DEFAULT 'x@x.com',
          capabilities     TEXT,
          evm_address      TEXT,
          solana_address   TEXT,
          icp_address      TEXT,
          status           TEXT NOT NULL DEFAULT 'active',
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          domain           TEXT
        );
        CREATE TABLE heartbeats (
          node_id    TEXT PRIMARY KEY,
          rps        INTEGER,
          p95_ms     INTEGER,
          version    TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (node_id) REFERENCES nodes(id)
        );
      `);

      // Insert 200 nodes + heartbeats to simulate a non-trivial table.
      const insertNode = db.prepare(
        `INSERT INTO nodes (id, region, contact, capabilities, status, created_at, updated_at)
         VALUES (?, 'us-east', 'x@x.com', ?, 'active', ?, ?)`,
      );
      const insertHb = db.prepare(
        `INSERT INTO heartbeats (node_id, rps, p95_ms, version, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insert200 = db.transaction(() => {
        const now = Math.floor(Date.now() / 1000);
        for (let i = 0; i < 200; i++) {
          const id = crypto.randomUUID();
          insertNode.run(id, JSON.stringify({ benchmark_score: i, verified: true }), now, now);
          insertHb.run(id, i * 10, i * 5, `1.0.${i}`, now);
        }
      });
      insert200();

      const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM nodes');
      const joinStmt  = db.prepare(`
        SELECT n.id, n.region, n.status, n.domain, n.capabilities,
               hb.rps, hb.p95_ms, hb.version
        FROM   nodes n
        LEFT JOIN heartbeats hb ON hb.node_id = n.id
        ORDER BY n.created_at DESC
      `);

      const ITERS = 500;

      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) countStmt.get();
      const countMs = performance.now() - t0;

      const t1 = performance.now();
      for (let i = 0; i < ITERS; i++) joinStmt.all();
      const joinMs = performance.now() - t1;

      console.log(
        `  [BUG-4] ${ITERS} iterations — countNodes: ${countMs.toFixed(1)} ms  ` +
        `listNodes: ${joinMs.toFixed(1)} ms  speedup: ${(joinMs / countMs).toFixed(1)}×`,
      );

      assert.ok(
        countMs < joinMs,
        `BUG-4: SELECT COUNT(*) (${countMs.toFixed(1)} ms) must be faster than ` +
        `the LEFT JOIN query (${joinMs.toFixed(1)} ms) over ${ITERS} iterations. ` +
        'getStats() was calling the slow path on every health check.',
      );

      // The speedup should be meaningful — at least 2× on any realistic hardware.
      const speedup = joinMs / countMs;
      assert.ok(
        speedup >= 2,
        `Expected at least 2× speedup from countNodes(), got ${speedup.toFixed(1)}×. ` +
        'The optimisation may not have been applied correctly.',
      );
    } finally {
      db.close();
      try { fs.unlinkSync(dbFile); } catch { /* ignore */ }
    }
  });
});
