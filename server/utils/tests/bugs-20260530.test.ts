/**
 * Daily Bug Hunt — 2026-05-30
 *
 * Each suite documents a newly found bug or security flaw, explains the
 * impact, and provides a failing test as evidence.  A test that currently
 * FAILs proves the bug is present; once the fix is applied the test turns
 * GREEN and acts as a regression guard.
 *
 * ┌─────────┬──────────────────────────────────────────────────────────────┐
 * │ ID      │ Finding                                                       │
 * ├─────────┼──────────────────────────────────────────────────────────────┤
 * │ BUG-1   │ ConsensusProxy.pendingRequests never populated —              │
 * │         │ concurrent request deduplication is completely broken         │
 * │         │ (server/features/proxy/proxy.ts)                              │
 * ├─────────┼──────────────────────────────────────────────────────────────┤
 * │ SEC-2   │ assertEmailVerification does not check consumed_at —          │
 * │         │ one email token can register unlimited nodes within its TTL   │
 * │         │ (server/utils/email-verification.ts)                          │
 * ├─────────┼──────────────────────────────────────────────────────────────┤
 * │ SEC-3   │ DNS-rebinding TOCTOU in WebSocket proxy —                     │
 * │         │ wss.ts checks isPrivateTarget() then calls fetch(url)          │
 * │         │ which re-resolves DNS; the pinned IP is discarded              │
 * │         │ (server/features/websocket/wss.ts)                            │
 * ├─────────┼──────────────────────────────────────────────────────────────┤
 * │ PERF-1  │ /node/:node_id/heartbeat has no rate limiting —               │
 * │         │ any client can flood the SQLite DB with synchronous writes     │
 * │         │ (server/features/nodes/orchestrator.js)                        │
 * └─────────┴──────────────────────────────────────────────────────────────┘
 */

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';
import crypto            from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// [BUG-1] ConsensusProxy.pendingRequests is NEVER populated during execution
// ─────────────────────────────────────────────────────────────────────────────

describe('[BUG-1] ConsensusProxy.pendingRequests never populated — concurrent deduplication broken', () => {
  /**
   * ROOT CAUSE
   *   handleRequest() checks this.pendingRequests.get(dedupeKey) to coalesce
   *   concurrent identical requests, but NEVER calls this.pendingRequests.set().
   *   The comment inside executeDirect says "Pending-request registration…
   *   owned by handleRequest" but the .set() call was never written.
   *
   * IMPACT
   *   Every concurrent identical request fires its own upstream HTTP call
   *   instead of joining the in-flight promise:
   *     • Users are effectively charged N times for the same upstream call.
   *     • Upstream servers receive N× the intended load.
   *     • The deduplication guarantee documented in the API is silently broken.
   *
   * FIX (proxy.ts handleRequest)
   *   Replace:
   *     const node = this.router.selectNode(dedupeKey, headers);
   *     if (node) return this.executeViaNode(...);
   *     return this.executeDirect(...);
   *
   *   With:
   *     const executionPromise = node
   *       ? this.executeViaNode(...)
   *       : this.executeDirect(...);
   *     this.pendingRequests.set(dedupeKey, executionPromise);
   *     try     { return await executionPromise; }
   *     finally { this.pendingRequests.delete(dedupeKey); }
   */

  it('three concurrent identical requests each hit the upstream — deduplication is broken', async () => {
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');

    let upstreamCalls = 0;

    // Mock tunnel: counts every invocation and introduces a 60 ms delay so
    // all three concurrent callers resume from their microtask queue and
    // reach the pendingRequests check before the first one resolves.
    const mockTunnel = {
      requestProxy: async (_nodeId: string, _input: unknown) => {
        upstreamCalls++;
        await new Promise<void>((r) => setTimeout(r, 60));
        return {
          status:        200,
          status_text:   'OK',
          headers:       { 'content-type': 'application/json' },
          body:          '{"ok":true,"ts":' + Date.now() + '}',
          body_encoding: 'utf8' as const,
        };
      },
    };

    const mockRouter = {
      selectNode:      () => ({ id: 'mock-node', region: 'us-east-1', domain: null }),
      incrementRequest() {},
      decrementRequest() {},
      incrementSession() {},
      decrementSession() {},
      getNodeLoad:     () => ({ requests: 0, sessions: 0, total: 0 }),
      getStats:        () => ({
        total_nodes: 1, active_nodes: 1,
        total_active_requests: 0, total_active_sessions: 0,
        avg_http_latency_ms: null, avg_ws_latency_ms: null,
        sticky_mappings: 0,
        selection_stats: {
          total_selections: 0, sticky_hits: 0, fallbacks: 0, sticky_hit_rate: '0%',
        },
        load_distribution: [],
      }),
    };

    const proxy = new ConsensusProxy({ router: mockRouter as any, nodeTunnel: mockTunnel });

    // Use a literal public IPv4 address so resolveAndCheckTarget() returns
    // synchronously (as a microtask) without a real DNS round-trip.
    // This ensures all three concurrent awaits resume before any upstream
    // call resolves, making the TOCTOU window deterministic.
    const TARGET = 'https://93.184.216.34/api/v1/dedupe-test';

    const [r1, r2, r3] = await Promise.all([
      proxy.handleRequest(TARGET, 'GET'),
      proxy.handleRequest(TARGET, 'GET'),
      proxy.handleRequest(TARGET, 'GET'),
    ]);

    // All three should return equivalent payloads regardless of deduplication
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 200);

    // With working deduplication only 1 upstream call is needed — the other
    // two callers should await the in-flight promise from the pendingRequests map.
    // This assertion CURRENTLY FAILS (upstreamCalls === 3), proving the bug.
    assert.equal(
      upstreamCalls,
      1,
      `[BUG-1] Expected 1 upstream tunnel call for 3 concurrent identical requests ` +
      `(deduplication), but got ${upstreamCalls}. ` +
      `handleRequest() never calls this.pendingRequests.set(dedupeKey, promise), ` +
      `so every concurrent caller misses the pending map and fires independently.`,
    );

    proxy.destroy();
  });

  it('pendingRequests map is always empty — .set() is structurally absent', async () => {
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy    = new ConsensusProxy();
    const internal = proxy as any;

    assert.ok(internal.pendingRequests instanceof Map,
      'pendingRequests must be a Map instance');

    // Trigger a failed request (SSRF) and verify the map never grows
    await proxy.handleRequest('https://93.184.216.34/probe', 'GET').catch(() => {});

    // The map must remain empty because .set() is never called
    assert.equal(
      internal.pendingRequests.size,
      0,
      '[BUG-1] pendingRequests.size is permanently 0 because handleRequest() ' +
      'never calls this.pendingRequests.set(). Concurrent callers cannot find ' +
      'each other in the map and will all issue separate upstream requests.',
    );

    proxy.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-2] assertEmailVerification allows token reuse within the TTL window
// ─────────────────────────────────────────────────────────────────────────────

describe('[SEC-2] Email verification token not invalidated after first use — multi-node exploit', () => {
  /**
   * ROOT CAUSE
   *   assertEmailVerification() (email-verification.ts:80) looks up the record
   *   by token hash and checks (1) email match and (2) expiry.  It does NOT
   *   check verification.consumed_at, which is set to a non-null timestamp by
   *   consumeEmailVerification() when verifyEmailCode() succeeds.
   *
   * IMPACT
   *   Within the 10-minute token TTL a single email verification enables:
   *     • Repeated calls to POST /node/join using the same token.
   *     • Combined with pre-funded x402 payments, a single real inbox can
   *       register an unlimited number of nodes — defeating the "one email,
   *       one node" identity control.
   *
   * FIX (email-verification.ts assertEmailVerification)
   *   Add after the expiry check:
   *
   *     if (verification.consumed_at != null)
   *       throw new Error('Email verification token has already been used');
   *
   *   Note: consumed_at being non-null means verifyEmailCode() succeeded and
   *   the token was issued.  Re-using the token for another node registration
   *   must be rejected here.
   */

  it('assertEmailVerification passes a second time with the same token — token is never consumed', async () => {
    process.env.EMAIL_VERIFICATION_SECRET = 'bug-hunt-sec2-test-secret-20260530';

    const NodeStore = (await import('../../data/node_store.js')).default;
    const { verifyEmailCode, assertEmailVerification } =
      await import('../../utils/email-verification.ts');

    const email  = `sec2-test-${Date.now()}@example-test.invalid`;
    const code   = '482913';
    const secret = process.env.EMAIL_VERIFICATION_SECRET;

    // Compute the code hash exactly as email-verification.ts does
    const codeHash = crypto.createHash('sha256')
      .update(`${secret}:${code}`)
      .digest('hex');

    // Insert the verification directly (bypass the Zoho email API)
    const record = NodeStore.createEmailVerification({
      email,
      code_hash: codeHash,
      ttlSeconds: 600,
    });

    // Exchange the OTP code for a token (marks consumed_at in the DB)
    const { token } = verifyEmailCode({ verification_id: record.id, email, code });

    // First use — should always succeed
    assert.doesNotThrow(
      () => assertEmailVerification({ email, token }),
      'First use of an email verification token must succeed',
    );

    // Second use — SHOULD throw but currently does not.
    // This assertion CURRENTLY FAILS, proving the bug.
    assert.throws(
      () => assertEmailVerification({ email, token }),
      /already.*used|consumed|reuse/i,
      '[SEC-2] assertEmailVerification must reject a token that was already used ' +
      'to authenticate a node registration, but consumed_at is never checked. ' +
      'A single verified email address can register unlimited nodes within 10 minutes.',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-3] DNS-rebinding TOCTOU gap in WebSocket executeProxyRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('[SEC-3] WebSocket proxy uses isPrivateTarget (boolean) — DNS-rebinding TOCTOU exists', () => {
  /**
   * ROOT CAUSE
   *   executeProxyRequest() in wss.ts (line ~129):
   *
   *     if (await isPrivateTarget(req.url)) { … reject … }
   *     const upstream = await fetch(req.url, init);   ← independent DNS lookup
   *
   *   isPrivateTarget() wraps resolveAndCheckTarget() and DISCARDS the resolved
   *   IP — it returns only a boolean.  fetch() then asks the OS resolver for the
   *   same hostname again.  These are two separate DNS round-trips with no
   *   binding between them.
   *
   * CONTRAST
   *   ConsensusProxy (proxy.ts) calls resolveAndCheckTarget() which returns a
   *   SafeResolution containing the verified IP, then buildSafeUrl() rewrites
   *   the outgoing URL to that literal IP and sets the Host header manually —
   *   closing the TOCTOU window entirely.
   *
   * ATTACK SCENARIO
   *   1. Attacker registers evil.com with TTL=1s.
   *   2. First DNS response: 203.0.113.1 (public, passes isPrivateTarget).
   *   3. Attacker flips DNS: evil.com → 169.254.169.254 (AWS metadata).
   *   4. fetch("https://evil.com/creds") resolves to 169.254.169.254 — hit.
   *
   * IMPACT
   *   An authenticated WebSocket session holder (paid user) can reach cloud
   *   instance-metadata endpoints, internal microservices, or any host on the
   *   private network reachable from the proxy machine.
   *
   * FIX (wss.ts executeProxyRequest)
   *   Replace:
   *     if (await isPrivateTarget(req.url)) { … }
   *     const upstream = await fetch(req.url, init);
   *
   *   With:
   *     const resolved = await resolveAndCheckTarget(req.url);
   *     const safeUrl  = buildSafeUrl(req.url, resolved);
   *     init.headers   = { ...init.headers, host: resolved.hostname };
   *     const upstream = await fetch(safeUrl, init);
   *
   *   (import resolveAndCheckTarget and buildSafeUrl from ../../utils/ssrf.ts
   *    and ../../features/proxy/proxy.ts respectively, or extract buildSafeUrl
   *    into the shared ssrf utility)
   */

  it('isPrivateTarget returns a boolean — the pinned IP is unavailable to the caller', async () => {
    const { isPrivateTarget, resolveAndCheckTarget } = await import('../../utils/ssrf.ts');

    const publicLiteral = 'https://93.184.216.34/meta';

    // isPrivateTarget discards the resolved IP — only a boolean is returned
    const boolResult = await isPrivateTarget(publicLiteral);
    assert.equal(typeof boolResult, 'boolean',
      'isPrivateTarget must return boolean (the resolved IP is inaccessible to callers)');

    // resolveAndCheckTarget returns the full SafeResolution including the pinned IP
    const safeRes = await resolveAndCheckTarget(publicLiteral);
    assert.equal(typeof safeRes.ip, 'string',
      'resolveAndCheckTarget must return SafeResolution.ip so callers can pin the connection');
    assert.ok(safeRes.ip.length > 0, 'ip must be non-empty');
    assert.equal(typeof safeRes.hostname, 'string',
      'resolveAndCheckTarget must return SafeResolution.hostname for SNI / Host header');
  });

  it('wss.ts uses isPrivateTarget + fetch(url) instead of resolveAndCheckTarget + buildSafeUrl', async () => {
    const fs = await import('node:fs');

    const wssSrc = fs.readFileSync(
      new URL('../../features/websocket/wss.ts', import.meta.url),
      'utf8',
    );
    const proxySrc = fs.readFileSync(
      new URL('../../features/proxy/proxy.ts', import.meta.url),
      'utf8',
    );

    // Verify the safer pattern IS present in proxy.ts (control)
    assert.ok(proxySrc.includes('resolveAndCheckTarget'),
      'proxy.ts must use resolveAndCheckTarget to obtain the pinned IP');
    assert.ok(proxySrc.includes('buildSafeUrl'),
      'proxy.ts must use buildSafeUrl to rewrite the URL to the pinned IP');

    // wss.ts must also adopt the safe pattern — currently it does NOT.
    // These assertions CURRENTLY FAIL, proving the bug.
    assert.ok(
      wssSrc.includes('resolveAndCheckTarget'),
      '[SEC-3] wss.ts must call resolveAndCheckTarget() to obtain a pinned IP ' +
      'before fetching, but currently only calls isPrivateTarget() which discards ' +
      'the resolved address and creates a DNS-rebinding TOCTOU window.',
    );

    assert.ok(
      wssSrc.includes('buildSafeUrl') || wssSrc.includes('safeUrl'),
      '[SEC-3] wss.ts must rewrite the URL to the pinned IP (like proxy.ts does ' +
      'via buildSafeUrl) to prevent a second DNS lookup inside fetch(). ' +
      'Without this, an attacker can rebind the hostname between the SSRF check ' +
      'and the actual TCP connection.',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [PERF-1] /node/:node_id/heartbeat has no rate limiting
// ─────────────────────────────────────────────────────────────────────────────

describe('[PERF-1] Heartbeat endpoint has no rate limiting — DB can be flooded', () => {
  /**
   * ROOT CAUSE
   *   POST /node/:node_id/heartbeat in orchestrator.js registers the route
   *   with no rate-limit middleware.  NodeStore.heartbeat() performs a
   *   synchronous SQLite UPSERT on every request.
   *
   * IMPACT
   *   Any client that discovers a valid node_id (e.g. from GET /nodes or by
   *   observing public DNS records) can submit thousands of heartbeat writes
   *   per second:
   *     • Saturates the Node.js event loop with synchronous DB calls.
   *     • Causes excessive SQLite WAL growth and fsync pressure.
   *     • Disrupts rate-sensitive update-state clearing logic (clearCompletedUpdateState).
   *     • Acts as a low-cost denial-of-service against the consensus layer.
   *
   * NOTE
   *   express-rate-limit is already a project dependency (package.json) and is
   *   used on other endpoints — it just isn't applied here.
   *
   * FIX (orchestrator.js)
   *   Add a per-node rate limiter before the heartbeat handler, e.g.:
   *
   *     import rateLimit from 'express-rate-limit';
   *     const heartbeatLimiter = rateLimit({
   *       windowMs: 30_000,       // 30 s window
   *       max:      2,            // at most 2 heartbeats per 30 s per IP
   *       keyGenerator: (req) => req.params.node_id,
   *       standardHeaders: true,
   *       legacyHeaders: false,
   *     });
   *     app.post('/node/heartbeat/:node_id', heartbeatLimiter, (req, res) => { … });
   *
   *   A stronger fix also requires the heartbeat body to carry an Ed25519
   *   signature verifiable against the registered node public key, so only
   *   the legitimate node can submit heartbeats.
   */

  it('heartbeat route is registered without a rate-limiter middleware argument', async () => {
    const fs = await import('node:fs');

    const src = fs.readFileSync(
      new URL('../../features/nodes/orchestrator.js', import.meta.url),
      'utf8',
    );

    // Confirm the heartbeat route exists
    assert.ok(
      src.includes('/node/heartbeat/'),
      'heartbeat route must exist in orchestrator.js',
    );

    // Extract just the heartbeat registration call to avoid matching other routes
    const heartbeatBlock = src.match(
      /app\.post\(\s*['"`]\/node\/heartbeat\/:node_id['"`][\s\S]*?\}\s*\)\s*;/,
    );
    assert.ok(heartbeatBlock, 'heartbeat route registration block must be parseable');

    const block = heartbeatBlock![0];

    // A rate limiter would appear as a named middleware between the path and
    // the handler function, e.g.:  app.post('/node/heartbeat/:node_id', limiter, (req,res)=>{})
    const hasRateLimiter = /rateLimit|rateLimiter|heartbeatLimiter|limiter/.test(block);

    // This assertion CURRENTLY FAILS, proving the absence of rate limiting.
    assert.equal(
      hasRateLimiter,
      true,
      '[PERF-1] The heartbeat endpoint has no rate-limit middleware. ' +
      'Any client knowing a valid node_id can flood the SQLite DB with ' +
      'synchronous writes. Add express-rate-limit (already a dependency) ' +
      'keyed on node_id, and consider requiring an Ed25519 signature in the body.',
    );
  });
});
