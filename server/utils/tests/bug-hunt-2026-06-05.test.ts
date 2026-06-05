/**
 * Daily Bug Hunt — 2026-06-05
 *
 * Three confirmed bugs found today, ranked by impact.
 *
 * BUG-5  CRITICAL   In-flight deduplication is dead code —
 *                   pendingRequests.set() is never called, so every concurrent
 *                   request for the same key fires an independent upstream hit.
 *
 * BUG-6  MEDIUM     /admin/manifest returns HTTP 503 (not 401/403) when
 *                   ADMIN_KEY env var is absent, leaking server config state.
 *
 * BUG-7  HIGH       /fetch in x402-proxy has no per-API-key rate limiting;
 *                   one compromised key can exhaust the global quota for all
 *                   users in the same 15-minute window.
 *
 * Run:
 *   node --import tsx/esm --test server/utils/tests/bug-hunt-2026-06-05.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import http    from 'node:http';
import express from 'express';
import rateLimit from 'express-rate-limit';
import ConsensusProxy      from '../../features/proxy/proxy.ts';
import { registerUpdater } from '../../updater.ts';
import type { SafeResolution } from '../../utils/ssrf.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// SSRF bypass for localhost tests: skip DNS/private-range checks so tests can
// use a local upstream server without a public IP.
const bypassSsrf = async (urlString: string): Promise<SafeResolution> => {
  const u = new URL(urlString);
  return { ip: '127.0.0.1', family: 4, hostname: u.hostname, isLiteral: false };
};

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-5 · pendingRequests.set() is never called — in-flight deduplication
//          is completely broken  (Critical · Correctness + Performance)
//
//  Root cause:
//    ConsensusProxy initialises this.pendingRequests = new Map() and checks
//    this.pendingRequests.get(dedupeKey) in handleRequest(), but there is no
//    corresponding this.pendingRequests.set(dedupeKey, promise) call anywhere
//    in the codebase.  The guard at proxy.ts:275-281 is therefore dead code.
//
//  Impact:
//    • N concurrent identical requests all reach upstream — no coalescing.
//    • In a paid-proxy scenario this means N payments charged instead of 1.
//    • Under load, popular endpoints receive a thundering-herd of backend hits
//      that the deduplication layer was designed to absorb.
//
//  Expected fix:
//    Before dispatching the upstream call, register the in-flight promise:
//      const promise = this.executeDirect(...);
//      this.pendingRequests.set(dedupeKey, promise);
//    and remove it in a finally block after the promise resolves/rejects.
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-5 · pendingRequests never populated — in-flight deduplication is dead code', () => {
  const PORT       = 39_201;
  const BASE       = `http://localhost:${PORT}`;
  let upstreamHits = 0;
  let upstream:  http.Server;
  let proxy:     ConsensusProxy;

  before(async () => {
    upstream = http.createServer((_req, res) => {
      upstreamHits++;
      // 80 ms delay forces real concurrency overlap between Promise.all branches
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hit: upstreamHits }));
      }, 80);
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error',     reject);
      upstream.once('listening', resolve);
      upstream.listen(PORT);
    });

    proxy = new ConsensusProxy({ ssrfCheck: bypassSsrf });
  });

  after(() => {
    proxy.destroy();
    return new Promise<void>(r => upstream.close(r as () => void));
  });

  it('FAILS TODAY: 5 concurrent identical requests each hit upstream independently (should be 1 hit)', async () => {
    upstreamHits = 0;
    const url    = `${BASE}/concurrent-dedup`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => proxy.handleRequest(url, 'GET', {}, undefined, 60)),
    );

    // BUG: all 5 reach upstream because pendingRequests is never populated.
    // CORRECT behavior (after fix): upstreamHits === 1, all results share same data.
    assert.equal(
      upstreamHits,
      1,
      `REGRESSION: pendingRequests deduplication is broken — ` +
      `expected 1 upstream hit but got ${upstreamHits}. ` +
      `Fix: add this.pendingRequests.set(dedupeKey, promise) in handleRequest() ` +
      `before dispatching the upstream call.`,
    );

    // All responses should carry the same data (from the single upstream call).
    const first = JSON.stringify(results[0]!.data);
    for (const r of results) {
      assert.equal(
        JSON.stringify(r.data),
        first,
        'All coalesced responses must share the same upstream payload',
      );
    }
  });

  it('FAILS TODAY: coalesced followers must be marked cached:true, only the first cached:false', async () => {
    upstreamHits = 0;
    const url    = `${BASE}/concurrent-cached-flag`;

    const results = await Promise.all(
      Array.from({ length: 4 }, () => proxy.handleRequest(url, 'GET', {}, undefined, 60)),
    );

    // After fix: only 1 upstream hit; ≥3 of the 4 results carry cached:true.
    const cachedCount = results.filter(r => r.cached === true).length;
    assert.ok(
      cachedCount >= 3,
      `REGRESSION: expected ≥3 coalesced responses to be marked cached:true, ` +
      `got ${cachedCount} (upstreamHits=${upstreamHits}). ` +
      `This confirms pendingRequests is never set — followers never see the in-flight promise.`,
    );
  });

  it('FAILS TODAY: getStats().pending_requests is always 0 even while a request is in-flight', async () => {
    upstreamHits = 0;

    // Fire a slow request but do NOT await it yet.
    const inflight = proxy.handleRequest(`${BASE}/pending-stats`, 'GET', {}, undefined, 60);

    // Sample stats immediately while the request is outstanding.
    // BUG: pending_requests should be 1 here, but it is always 0 because
    // pendingRequests.set() is never called.
    const statsWhileInflight = proxy.getStats();

    await inflight; // let it complete

    assert.equal(
      statsWhileInflight.pending_requests,
      1,
      `REGRESSION: pending_requests should be 1 while a request is in-flight, ` +
      `but it is ${statsWhileInflight.pending_requests}. ` +
      `This proves pendingRequests.set() is never called anywhere in the codebase.`,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-6 · /admin/manifest returns HTTP 503 when ADMIN_KEY is absent
//          instead of 401/404  (Medium · Security — information disclosure)
//
//  Root cause: updater.ts:183
//    if (!config.adminKey) {
//      return res.status(503).json({ error: "Admin key not configured" });
//    }
//
//  Impact:
//    HTTP 503 (Service Unavailable) is a recognised signal that the service is
//    temporarily down.  An attacker probing /admin/manifest learns:
//      1. The endpoint exists.
//      2. The ADMIN_KEY environment variable is NOT configured on this instance.
//    This distinction lets an attacker differentiate unprotected instances from
//    protected ones without needing a valid key.  A 401 or a generic 404 would
//    give the same rejection without leaking configuration state.
//
//  Expected fix:
//    Replace res.status(503) with res.status(401) (or 404 to obscure existence).
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-6 · /admin/manifest leaks config state via HTTP 503', () => {
  let appServer: http.Server;
  let baseUrl:   string;

  before(async () => {
    const app = express();
    app.use(express.json());

    // Register the updater with NO adminKey to trigger the bug.
    registerUpdater(app, { adminKey: undefined });

    appServer = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      appServer.once('error',     reject);
      appServer.once('listening', resolve);
      appServer.listen(0);
    });

    const addr = appServer.address() as { port: number };
    baseUrl    = `http://localhost:${addr.port}`;
  });

  after(() => new Promise<void>(r => appServer.close(r as () => void)));

  it('FAILS TODAY: returns 503 (should be 401/403) when ADMIN_KEY is not configured', async () => {
    const response = await fetch(`${baseUrl}/admin/manifest`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ manifest: { version: '1.0.0' } }),
    });

    // BUG: currently 503 — leaks "admin key not configured".
    // CORRECT: 401 Unauthorized (or 404 to obscure existence entirely).
    assert.notEqual(
      response.status,
      503,
      `REGRESSION: /admin/manifest must not return 503 when ADMIN_KEY is missing. ` +
      `HTTP 503 leaks server configuration state (env var absent). ` +
      `Fix: change res.status(503) → res.status(401) in updater.ts:183.`,
    );

    assert.ok(
      response.status === 401 || response.status === 403 || response.status === 404,
      `Expected 401/403/404, got ${response.status}. ` +
      `Endpoint must not reveal whether ADMIN_KEY is configured or merely wrong.`,
    );
  });

  it('FAILS TODAY: error body must not expose the phrase "admin key not configured"', async () => {
    const response = await fetch(`${baseUrl}/admin/manifest`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ manifest: { version: '1.0.0' } }),
    });

    const body = await response.json() as Record<string, unknown>;

    assert.ok(
      !JSON.stringify(body).toLowerCase().includes('not configured'),
      `REGRESSION: error message leaks config state: "${JSON.stringify(body)}". ` +
      `Replace with a generic "Unauthorized" message.`,
    );
  });

  it('a request with a wrong key returns 403 (not 503), confirming 503 is config-leak only', async () => {
    // Register updater WITH a key so we can compare the two rejection paths.
    const app2 = express();
    app2.use(express.json());
    registerUpdater(app2, { adminKey: 'super-secret-key' });

    const srv2 = http.createServer(app2);
    await new Promise<void>((resolve, reject) => {
      srv2.once('error',     reject);
      srv2.once('listening', resolve);
      srv2.listen(0);
    });

    const addr2 = srv2.address() as { port: number };

    try {
      const r = await fetch(`http://localhost:${addr2.port}/admin/manifest`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key':  'wrong-key',
        },
        body: JSON.stringify({ manifest: { version: '1.0.0' } }),
      });

      // When ADMIN_KEY is configured but wrong key is presented → 403.
      // The BUG is that the missing-key path returns a *different* status (503 vs 403)
      // exposing the distinction to an unauthenticated caller.
      assert.equal(r.status, 403,
        `Wrong-key rejection should be 403, got ${r.status}`);
    } finally {
      await new Promise<void>(r => srv2.close(r as () => void));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-7 · No per-API-key rate limiting on /fetch  (High · Security — DoS)
//
//  Root cause: x402-proxy/server.js:42
//    app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, ... }));
//    app.post('/fetch', validateApiKey, async (req, res) => { ... });
//
//  There is only a single global rate limiter (1 000 req / 15 min) shared
//  across ALL API keys.  The /fetch handler has no per-wallet throttle.
//
//  Impact:
//    • A single compromised API key can exhaust the entire 1 000-request quota,
//      making the service unavailable for every other legitimate key.
//    • Legitimate users sharing the same server IP see 429 responses even though
//      their own keys are well within a fair-use threshold.
//    • No audit trail distinguishes a single abusive key from coordinated abuse.
//
//  Expected fix:
//    Add a per-key limiter on the /fetch route:
//      app.post('/fetch', perKeyLimiter, validateApiKey, ...)
//    where perKeyLimiter uses keyGenerator: (req) => req.headers['x-api-key'].
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-7 · No per-API-key rate limiting on /fetch — single key can starve all users', () => {
  /**
   * Minimal reproduction of the x402-proxy rate-limit architecture:
   * one global limiter, two distinct API keys, no per-key limiter.
   */
  function buildVulnerableFetchServer(globalMax: number): http.Server {
    const app = express();
    app.use(express.json());
    app.set('trust proxy', 1);

    // Global limiter — mirrors x402-proxy/server.js:42
    app.use(rateLimit({
      windowMs:        60_000,
      max:             globalMax,
      standardHeaders: true,
      legacyHeaders:   false,
    }));

    // Minimal /fetch stub — no per-key limiter, same as production
    app.post('/fetch', (req: express.Request, res: express.Response) => {
      const key = req.headers['x-api-key'];
      if (!key) return void res.status(401).json({ error: 'Missing API key' });
      res.json({ ok: true, key });
    });

    return http.createServer(app);
  }

  it('FAILS TODAY: key-A exhausts global quota, causing key-B requests to receive 429', async () => {
    const GLOBAL_MAX = 5;  // small cap for test speed
    const srv        = buildVulnerableFetchServer(GLOBAL_MAX);

    await new Promise<void>((resolve, reject) => {
      srv.once('error',     reject);
      srv.once('listening', resolve);
      srv.listen(0);
    });

    const { port } = srv.address() as { port: number };
    const url      = `http://localhost:${port}/fetch`;

    try {
      // key-A fires GLOBAL_MAX requests, exhausting the entire quota
      for (let i = 0; i < GLOBAL_MAX; i++) {
        await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': 'key-A' },
          body:    JSON.stringify({ target_url: 'https://example.com' }),
        });
      }

      // key-B's FIRST legitimate request hits the global cap
      const keyBResponse = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'key-B' },
        body:    JSON.stringify({ target_url: 'https://example.com' }),
      });

      // This assertion FAILS (proving the bug) because key-B gets 429 even
      // though it has never made a single request.
      // After the fix (per-key limiter), key-B's first request should be 200.
      assert.equal(
        keyBResponse.status,
        200,
        `REGRESSION: key-B received HTTP ${keyBResponse.status} after key-A exhausted ` +
        `the global quota. Per-API-key rate limiting is absent. ` +
        `Fix: add keyGenerator: (req) => req.headers['x-api-key'] to the rate limiter, ` +
        `or add a separate per-key limiter on the /fetch route in x402-proxy/server.js.`,
      );
    } finally {
      await new Promise<void>(r => srv.close(r as () => void));
    }
  });

  it('FIX VERIFICATION: per-key limiter isolates keys — key-B is unaffected by key-A exhaustion', async () => {
    // Same scenario but WITH per-key isolation to prove the fix works.
    const GLOBAL_MAX  = 100;
    const PER_KEY_MAX = 5;

    const app = express();
    app.use(express.json());
    app.set('trust proxy', 1);

    // Global limiter (high so it never fires in this test)
    app.use(rateLimit({ windowMs: 60_000, max: GLOBAL_MAX, standardHeaders: true, legacyHeaders: false }));

    // Per-API-key limiter — THE FIX
    // validate.keyGeneratorIpFallback disabled because we key on API header, not IP.
    const perKeyLimiter = rateLimit({
      windowMs:        60_000,
      max:             PER_KEY_MAX,
      standardHeaders: true,
      legacyHeaders:   false,
      keyGenerator:    (req: express.Request) =>
        String(req.headers['x-api-key'] ?? req.ip),
      validate:        { keyGeneratorIpFallback: false },
    } as Parameters<typeof rateLimit>[0]);

    app.post('/fetch', perKeyLimiter, (req: express.Request, res: express.Response) => {
      const key = req.headers['x-api-key'];
      if (!key) return void res.status(401).json({ error: 'Missing API key' });
      res.json({ ok: true, key });
    });

    const srv = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      srv.once('error',     reject);
      srv.once('listening', resolve);
      srv.listen(0);
    });

    const { port } = srv.address() as { port: number };
    const url      = `http://localhost:${port}/fetch`;

    try {
      // key-A exhausts its own per-key quota
      for (let i = 0; i < PER_KEY_MAX; i++) {
        await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': 'key-A' },
          body:    JSON.stringify({ target_url: 'https://example.com' }),
        });
      }

      // key-B's first request succeeds even though key-A is exhausted
      const keyBResponse = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'key-B' },
        body:    JSON.stringify({ target_url: 'https://example.com' }),
      });

      assert.equal(keyBResponse.status, 200,
        `FIX VERIFICATION: key-B must succeed (200) when isolated by per-key limiting, ` +
        `got ${keyBResponse.status}`);

      // key-A's next request is blocked by its own quota
      const keyAOverLimit = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'key-A' },
        body:    JSON.stringify({ target_url: 'https://example.com' }),
      });

      assert.equal(keyAOverLimit.status, 429,
        `FIX VERIFICATION: key-A must be throttled (429) after exceeding its per-key limit, ` +
        `got ${keyAOverLimit.status}`);
    } finally {
      await new Promise<void>(r => srv.close(r as () => void));
    }
  });
});
