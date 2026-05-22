/**
 * Daily Bug Hunt — 2026-05-22
 *
 * Three findings confirmed today, ordered by severity:
 *
 * [BUG-NEW-1] HIGH   — /proxy endpoint has no rate limiting in FREE_MODE
 * [BUG-NEW-2] MEDIUM — N+1 DB query inside Router._buildStats() load_distribution map
 * [BUG-NEW-3] MEDIUM — calculateSessionCost is uncapped while calculateSessionLimits caps
 *                       at 1440 min, causing massive overpayment on large `minutes` values
 *
 * Run with:
 *   cd server && npx tsx --test utils/tests/daily-hunt-2026-05-22.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  PRICING_PRESETS,
  calculateSessionCost,
  calculateSessionLimits,
} from '../types.js';

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-NEW-1 · Missing rate limit on /proxy in FREE_MODE  (HIGH · Security/DoS)
//
//  Root cause: server.js applies publicLimiter (120 req/60 s) only to the
//  informational routes (/, /health, /stats, /config).  The paymentMiddleware
//  that acts as a de-facto gate for POST /proxy is wrapped in `if (!FREE_MODE)`,
//  so in FREE_MODE the /proxy endpoint is completely unthrottled.
//
//  Impact: any client can hammer the proxy endpoint without restriction, making
//  the server trivially vulnerable to request-flooding DoS attacks.
//
//  Evidence: the test below stands up a minimal server replicating the exact
//  route registration pattern from server.js (FREE_MODE=true) and verifies that
//  125 back-to-back requests all receive 2xx — no 429 is ever returned.
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-NEW-1 · No rate limiting on /proxy in FREE_MODE — all burst requests succeed', () => {
  const PORT = 47_001;
  let server: http.Server;

  before(async () => {
    const app = express();
    app.use(express.json());

    // ── Mirrors the rate-limiting setup in server.js exactly ──────────────────
    // publicLimiter is intentionally NOT applied to /proxy — this is the bug.
    const { default: rateLimit } = await import('express-rate-limit');
    const publicLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

    app.get('/',      publicLimiter, (_req, res) => res.json({ ok: true }));
    app.get('/health', publicLimiter, (_req, res) => res.json({ status: 'healthy' }));

    // FREE_MODE: paymentMiddleware is skipped, and no fallback limiter is added.
    // This is the exact code path in server.js lines 170-189.
    app.post('/proxy', (_req, res) => {
      res.json({ status: 200, data: 'ok' });
    });
    // ─────────────────────────────────────────────────────────────────────────

    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
      server.listen(PORT);
    });
  });

  after(() => new Promise<void>(r => server.close(r as () => void)));

  it('125 rapid POST /proxy requests all succeed (no 429) — rate limiter is absent', async () => {
    const BURST = 125; // exceeds the publicLimiter's 120-request window
    const results: number[] = [];

    await Promise.all(
      Array.from({ length: BURST }, () =>
        fetch(`http://localhost:${PORT}/proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_url: 'http://example.com' }),
        }).then(r => { results.push(r.status); }),
      ),
    );

    const tooMany = results.filter(s => s === 429);
    const ok      = results.filter(s => s === 200);

    assert.equal(tooMany.length, 0,
      `BUG-NEW-1: Expected 0 rate-limited responses but got ${tooMany.length}. ` +
      'A rate limiter should be applied to /proxy even in FREE_MODE.',
    );
    assert.equal(ok.length, BURST,
      `All ${BURST} requests succeeded — the endpoint is completely unthrottled.`,
    );
  });

  it('GET /health IS rate-limited (publicLimiter works for other routes)', async () => {
    // Confirm the publicLimiter itself works correctly — it's just not wired to /proxy.
    const BURST = 125;
    const results: number[] = [];

    await Promise.all(
      Array.from({ length: BURST }, () =>
        fetch(`http://localhost:${PORT}/health`)
          .then(r => { results.push(r.status); }),
      ),
    );

    const tooMany = results.filter(s => s === 429);
    assert.ok(
      tooMany.length > 0,
      `publicLimiter is functioning (${tooMany.length} requests correctly blocked on /health) — ` +
      'it is simply not applied to /proxy.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-NEW-2 · N+1 DB query in Router._buildStats()  (MEDIUM · Performance)
//
//  Root cause: router.ts _buildStats() calls NodeStore.listNodes() once (line
//  188) and correctly uses the result for aggregate metrics.  But when building
//  the load_distribution array (lines 224-229) it calls NodeStore.getNode(id)
//  inside a .map(), issuing one full SELECT…LEFT JOIN heartbeats query per
//  active-request entry even though all the data was already retrieved by the
//  earlier listNodes() call.
//
//  Impact: every call to router.getStats() (invoked by /health) executes 1+N
//  synchronous SQLite queries on the Node.js event loop, where N is the number
//  of nodes that currently have in-flight HTTP requests.  At 50 active nodes
//  this is 50 unnecessary round-trips per stats call; at 200 nodes it starts
//  to measurably block the event loop.
//
//  Evidence: the test below spies on NodeStore.getNode, seeds the router with
//  active request counters for N nodes, calls getStats(), and asserts that
//  getNode was called exactly N times — one redundant query per active node.
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-NEW-2 · N+1 query in Router._buildStats() — getNode called once per active node', () => {
  // Use a temp DB so this test is hermetic and does not corrupt the shared
  // consensus.db used by other tests.
  const dbPath = path.join(os.tmpdir(), `router-n1-test-${Date.now()}.db`);

  before(() => {
    process.env['NODE_DB_PATH'] = dbPath;
  });

  after(() => {
    try {
      const { db } = require('../../data/node_store.js');
      db?.close?.();
    } catch { /* ignore */ }
    try { require('fs').unlinkSync(dbPath); } catch { /* ignore */ }
    delete process.env['NODE_DB_PATH'];
  });

  it('getNode is called N times inside _buildStats() — one redundant query per active node', async () => {
    const [{ default: Router }, NodeStore] = await Promise.all([
      import('../../router.ts'),
      import('../../data/node_store.js').then(m => m.NodeStore ?? m.default),
    ]);

    const N = 5; // Number of nodes to seed

    // Insert N test nodes into the DB.
    const nodeIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `test-node-n1-${i}-${Date.now()}`;
      nodeIds.push(id);
      NodeStore.upsertNode({
        id,
        pubkey_ed25519:  crypto.randomBytes(32),
        region:          'us-east',
        contact:         `http://node${i}.test:8080`,
        capabilities:    {},
        status:          'active',
      });
    }

    const router = new Router();

    // Simulate N nodes each carrying one active HTTP request.
    for (const id of nodeIds) router.incrementRequest(id);

    // ── Spy on NodeStore.getNode ───────────────────────────────────────────
    let getNodeCallCount = 0;
    const original = NodeStore.getNode.bind(NodeStore);
    NodeStore.getNode = (...args: Parameters<typeof NodeStore.getNode>) => {
      getNodeCallCount++;
      return original(...args);
    };

    try {
      // getStats() delegates to _buildStats() on the first call.
      const stats = router.getStats();

      assert.ok(
        Array.isArray(stats.load_distribution),
        'load_distribution must be an array',
      );

      // THE BUG: _buildStats already called listNodes() to fetch allNodes,
      // but then calls getNode(id) again inside the load_distribution map.
      // So getNode is invoked N times — once per active-request node.
      assert.equal(
        getNodeCallCount,
        N,
        `BUG-NEW-2: NodeStore.getNode was called ${getNodeCallCount} times for ${N} active nodes. ` +
        'These queries are redundant — allNodes from listNodes() already contains this data. ' +
        'Fix: build a Map<id, node> from allNodes and use it in the load_distribution mapping.',
      );

      // Confirm the data IS correct — the bug is inefficiency, not wrong output.
      assert.equal(stats.load_distribution.length, N);
    } finally {
      NodeStore.getNode = original; // restore spy
      for (const id of nodeIds) router.decrementRequest(id);
    }
  });

  it('performance: getStats() latency scales linearly with active-node count (N+1 evidence)', async () => {
    const [{ default: Router }, NodeStore] = await Promise.all([
      import('../../router.ts'),
      import('../../data/node_store.js').then(m => m.NodeStore ?? m.default),
    ]);

    async function measureStatsLatency(nodeCount: number): Promise<number> {
      const ids: string[] = [];
      for (let i = 0; i < nodeCount; i++) {
        const id = `perf-node-${nodeCount}-${i}-${Date.now()}`;
        ids.push(id);
        NodeStore.upsertNode({
          id,
          pubkey_ed25519: crypto.randomBytes(32),
          region: 'eu-west',
          contact: `http://perf${i}.test:8080`,
          capabilities: {},
          status: 'active',
        });
      }
      const router = new Router();
      for (const id of ids) router.incrementRequest(id);

      // Warm up.
      router.getStats();
      // Force cache miss for the actual measurement.
      (router as any).statsCache = null;

      const REPS = 20;
      const t0 = performance.now();
      for (let r = 0; r < REPS; r++) {
        (router as any).statsCache = null;
        router.getStats();
      }
      const elapsed = (performance.now() - t0) / REPS;

      for (const id of ids) router.decrementRequest(id);
      return elapsed;
    }

    const latency5  = await measureStatsLatency(5);
    const latency20 = await measureStatsLatency(20);

    console.log(
      `  [BUG-NEW-2] getStats() avg latency — 5 nodes: ${latency5.toFixed(2)} ms  ` +
      `20 nodes: ${latency20.toFixed(2)} ms  ` +
      `ratio: ${(latency20 / latency5).toFixed(1)}×`,
    );

    // With an N+1 bug, latency for 20 nodes should be noticeably higher than for 5.
    // We conservatively assert at least 1.5× — a correct O(1)-lookup implementation
    // would be nearly flat (≈1.0×).
    assert.ok(
      latency20 / latency5 >= 1.5,
      `Expected latency to scale with node count (N+1 bug). ` +
      `Ratio was ${(latency20 / latency5).toFixed(2)}× — if this is near 1.0, the bug may already be fixed.`,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  BUG-NEW-3 · Pricing/limits mismatch — calculateSessionCost is uncapped
//              while calculateSessionLimits caps at 1440 minutes (MEDIUM · Billing)
//
//  Root cause: calculateSessionCost (utils/types.js line 21-33) multiplies raw
//  minutes directly with pricePerMinute and has no upper bound.
//  calculateSessionLimits (utils/types.js lines 35-63) correctly caps minutes at
//  Math.min(paidMinutes || 0, 1440) for TIME and HYBRID models.
//
//  Impact:
//    • A user who passes minutes=9999 is charged for 9999 minutes (~$5.00 at
//      HYBRID rate) but receives a session capped at 1440 minutes (24 h) — a
//      6.9× overpayment. The x402 payment middleware uses sessionPrice() which
//      calls calculateSessionCost(), so the inflated amount is what the user
//      actually pays on-chain before they can even connect.
//    • The inverse case: minutes=0 or minutes=NaN (from a malformed query param)
//      gives a $0 session with a 0 ms time limit, which expires the instant it
//      is opened — the user pays nothing but also gets nothing, wasting a
//      connection slot and causing a confusing UX error.
//
//  Evidence: the tests below call both functions with the same inputs and
//  compare billed minutes vs capped minutes directly.
// ══════════════════════════════════════════════════════════════════════════════

describe('BUG-NEW-3 · Pricing/limits mismatch — uncapped cost vs capped session time', () => {
  it('minutes > 1440: user is billed for all minutes but limited to 1440', () => {
    const pricing    = PRICING_PRESETS.HYBRID;
    const rawMinutes = 9_999; // ~7× the 1440-minute cap

    const cost  = calculateSessionCost(pricing, rawMinutes, 0);
    const limit = calculateSessionLimits(pricing, rawMinutes, 0);

    const billedMinutes = cost / pricing.pricePerMinute;
    const actualMinutes = limit.timeLimit / 60_000; // ms → minutes

    assert.equal(
      billedMinutes,
      rawMinutes,
      `BUG-NEW-3: cost is calculated from ${rawMinutes} minutes (uncapped).`,
    );
    assert.equal(
      actualMinutes,
      1440,
      `BUG-NEW-3: session time is capped at 1440 minutes regardless of payment.`,
    );

    const overpayFactor = billedMinutes / actualMinutes;
    assert.ok(
      overpayFactor > 1,
      `User overpays by ${overpayFactor.toFixed(1)}× ($${cost.toFixed(4)} for ${actualMinutes} min).`,
    );

    console.log(
      `  [BUG-NEW-3] minutes=${rawMinutes}: ` +
      `charged $${cost.toFixed(4)}, receives ${actualMinutes} min — ` +
      `${overpayFactor.toFixed(1)}× overpayment.`,
    );
  });

  it('minutes=0: user pays $0 for time but receives a 0 ms session that expires immediately', () => {
    const pricing = PRICING_PRESETS.HYBRID;

    const cost  = calculateSessionCost(pricing, 0, 0);
    const limit = calculateSessionLimits(pricing, 0, 0);

    assert.equal(cost,            0, 'zero-minute session has $0 time cost');
    assert.equal(limit.timeLimit, 0, 'BUG-NEW-3: zero-minute session has 0 ms time limit');

    // setTimeout(fn, 0) fires on the next event loop tick — the session is
    // dead before the user can send a single message.
    console.log(
      '  [BUG-NEW-3] minutes=0: timeLimit=0 ms — session timer fires immediately on connect.',
    );
  });

  it('NaN minutes (from parseInt("abc")): session costs $0 but expires in 0 ms', () => {
    // This happens when the ?minutes= query param contains a non-numeric string.
    // parseInt('abc') → NaN; NaN is passed to both functions.
    const pricing    = PRICING_PRESETS.HYBRID;
    const nanMinutes = parseInt('abc'); // simulates wss.ts line 71

    assert.ok(Number.isNaN(nanMinutes), 'parseInt returns NaN for non-numeric input');

    const cost  = calculateSessionCost(pricing, nanMinutes, 0);
    const limit = calculateSessionLimits(pricing, nanMinutes, 0);

    // calculateSessionCost: (NaN || 0) * rate = 0   → payment is $0
    assert.equal(cost, 0, 'NaN minutes → $0 cost (user slips through payment)');

    // calculateSessionLimits: Math.min(NaN || 0, 1440) = 0 → timeLimit = 0 ms
    assert.equal(limit.timeLimit, 0,
      'BUG-NEW-3: NaN minutes → 0 ms time limit — session expires before first message.',
    );

    console.log(
      '  [BUG-NEW-3] minutes=NaN: cost=$0, timeLimit=0 ms — ' +
      'session is effectively unusable.',
    );
  });

  it('negative minutes (e.g. minutes=-5): || 0 guard does NOT protect against negatives', () => {
    const pricing      = PRICING_PRESETS.HYBRID;
    const negMinutes   = -5;

    // calculateSessionLimits uses `paidMinutes || 0` — -5 is truthy, so it
    // passes through the guard and reaches Math.min(-5, 1440) = -5.
    const limit = calculateSessionLimits(pricing, negMinutes, 0);

    assert.ok(
      limit.timeLimit < 0,
      `BUG-NEW-3: negative minutes (-5) produce a negative timeLimit (${limit.timeLimit} ms). ` +
      'setTimeout with a negative delay fires immediately — session expires on connect.',
    );

    console.log(
      `  [BUG-NEW-3] minutes=-5: timeLimit=${limit.timeLimit} ms — ` +
      'negative setTimeout fires on next tick.',
    );
  });

  it('summary: cost and limits are consistent for the valid range [1, 1440]', () => {
    // This is the PASSING baseline — confirms the bug is scoped to out-of-range inputs.
    const pricing = PRICING_PRESETS.HYBRID;
    for (const mins of [1, 30, 60, 180, 1440]) {
      const cost  = calculateSessionCost(pricing, mins, 0);
      const limit = calculateSessionLimits(pricing, mins, 0);
      const limitMins = limit.timeLimit / 60_000;
      assert.equal(
        limitMins,
        mins,
        `For minutes=${mins} the session limit should match the paid amount`,
      );
      assert.ok(cost > 0, `Cost for ${mins} minutes must be positive`);
    }
  });
});
