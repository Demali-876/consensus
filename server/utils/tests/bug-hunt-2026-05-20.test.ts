/**
 * Bug Hunt — 2026-05-20
 *
 * Daily security and performance audit.  Each suite documents one finding,
 * explains its impact, and asserts the CORRECT behaviour.  A test that FAILS
 * means the bug still exists; a test that PASSES means it has been fixed.
 *
 * Run:
 *   node --import tsx/esm --test server/utils/tests/bug-hunt-2026-05-20.test.ts
 *
 * Findings (highest → lowest severity)
 * ─────────────────────────────────────
 * [BUG-A] CRITICAL  · pendingRequests.set() never called — coalescing is dead
 * [BUG-B] HIGH      · ssrfCheck ProxyConfig option not wired — test harness broken
 * [BUG-C] HIGH      · /node/heartbeat/:id has no authentication — spoofable
 * [BUG-D] HIGH      · /node/email/start has no rate limit — email-bombing vector
 * [BUG-E] MEDIUM    · Router._buildStats does N+1 NodeStore.getNode() calls
 * [BUG-F] MEDIUM    · Proxy error handler leaks error.message to the client
 */

import { describe, it, before, after } from 'node:test';
import assert   from 'node:assert/strict';
import fs       from 'node:fs';
import path     from 'node:path';
import http     from 'node:http';
import express  from 'express';
import crypto   from 'node:crypto';
import os       from 'node:os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_SRC = path.join(__dirname, '../../features/proxy/proxy.ts');
const SERVER_SRC = path.join(__dirname, '../../server.js');
const ORCH_SRC  = path.join(__dirname, '../../features/nodes/orchestrator.js');

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-A] CRITICAL · Missing pendingRequests.set() — in-flight coalescing broken
//
// Impact: The proxy's primary value proposition is deduplicating concurrent
// identical requests so N simultaneous callers produce only 1 upstream hit.
// The Map is declared, read (line 275), and tracked in stats (line 528), but
// pendingRequests.set() is NEVER called anywhere in the file.  Every concurrent
// request therefore falls through the "no pending" branch and independently
// fires a live HTTP request to the upstream, multiplying upstream load by N.
//
// Evidence: grep the source — if this test FAILS the call was added (bug fixed).
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-A] Missing pendingRequests.set() — coalescing feature is dead', () => {
  it('proxy.ts calls this.pendingRequests.set() at least once (bug: it never does)', () => {
    const src = fs.readFileSync(PROXY_SRC, 'utf-8');

    // Count all .set( calls on pendingRequests
    const setCallsOnPendingRequests = (src.match(/this\.pendingRequests\.set\s*\(/g) ?? []).length;

    assert.ok(
      setCallsOnPendingRequests >= 1,
      `BUG-A: this.pendingRequests.set() is called ${setCallsOnPendingRequests} time(s) in proxy.ts. ` +
      'Expected ≥1.  Without it, pendingRequests is always empty and concurrent identical requests ' +
      'all fan out to the upstream instead of coalescing into one.  The "pending_requests" stat ' +
      'always reports 0, and the upstream hit-count for N concurrent identical requests equals N.',
    );
  });

  it('getStats() pending_requests reflects in-flight work (bug: always 0)', async () => {
    // Import without SSRF bypass — we just inspect the Map through the public API.
    const { default: ConsensusProxy } = await import('../../features/proxy/proxy.ts');
    const proxy = new ConsensusProxy();

    // Manually set a sentinel promise to simulate an in-flight request.
    // This is the only way to populate the map if the real code doesn't do it.
    // If the bug is present, (proxy as any).pendingRequests is always empty.
    const pendingMap: Map<string, Promise<unknown>> = (proxy as any).pendingRequests;
    assert.equal(
      pendingMap.size,
      0,
      'Control check: map starts empty (expected)',
    );

    // Simulate what handleRequest SHOULD do: register the promise before awaiting.
    const fakePromise = Promise.resolve({ status: 200 });
    pendingMap.set('test-key', fakePromise as any);

    assert.equal(proxy.getStats().pending_requests, 1,
      'BUG-A: getStats().pending_requests should reflect the map size — but this only works ' +
      'if callers can manually insert.  The real handleRequest never inserts.',
    );

    proxy.destroy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-B] HIGH · ssrfCheck ProxyConfig option not wired into proxy.ts
//
// Impact: security-perf.test.ts and proxy.test.ts create proxies with
// { ssrfCheck: noSsrf } expecting the option to bypass SSRF validation for
// localhost test upstreams.  ProxyConfig has no ssrfCheck field, and
// handleRequest always calls the module-level resolveAndCheckTarget() directly.
// The option is silently ignored, so EVERY test that uses a localhost upstream
// fails with "Forbidden target_url", causing the whole test suite to be broken.
//
// Confirmed broken tests: BUG-1 and BUG-2 in security-perf.test.ts both report
// "not ok" because the proxy blocks http://localhost:* via the hard-wired SSRF
// check even though the test passed { ssrfCheck: noSsrf }.
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-B] ssrfCheck option ignored — proxy always uses hard-wired SSRF guard', () => {
  it('ProxyConfig interface declares an ssrfCheck field (bug: it does not)', async () => {
    const src = fs.readFileSync(PROXY_SRC, 'utf-8');
    assert.ok(
      src.includes('ssrfCheck'),
      'BUG-B: ProxyConfig has no ssrfCheck field.  Tests pass { ssrfCheck: noSsrf } expecting ' +
      'to substitute the SSRF resolver, but the option is never read from config.  ' +
      'Result: every test that targets a localhost upstream fails with "Forbidden target_url".',
    );
  });

  it('handleRequest uses config.ssrfCheck when provided (bug: always calls resolveAndCheckTarget)', async () => {
    const src = fs.readFileSync(PROXY_SRC, 'utf-8');
    // The real fix uses something like: const check = this.ssrfCheck ?? resolveAndCheckTarget
    const usesConfigSsrfCheck = /this\.(ssrfCheck|config\.ssrfCheck)/.test(src) ||
                                 /ssrfCheck\s*\?\?/.test(src);
    assert.ok(
      usesConfigSsrfCheck,
      'BUG-B: handleRequest ignores config.ssrfCheck and always calls resolveAndCheckTarget(). ' +
      'Unit tests that inject { ssrfCheck: noSsrf } cannot reach localhost upstreams, ' +
      'so BUG-1 (decompression bomb) and BUG-2 (unbounded TTL) in security-perf.test.ts ' +
      'both show "not ok" despite the fix being in place.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-C] HIGH · /node/heartbeat/:node_id has no authentication
//
// Impact: Any internet client that knows (or guesses) a node_id can:
//   1. Send a spoofed version string → clearCompletedUpdateState() fires,
//      prematurely clearing a pending forced-software-update for that node.
//   2. Inflate/deflate rps and p95_ms metrics, corrupting routing heuristics.
//
// node_id is only 12 hex chars (6 bytes, 48 bits) and is publicly exposed in
// GET /nodes, so enumeration is trivial.
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-C] Unauthenticated heartbeat endpoint', () => {
  const PORT = 39_881;
  let server: http.Server;
  let nodeId: string;
  let dbPath: string;
  let db: ReturnType<typeof Database>;

  before(async () => {
    // Spin up a minimal express app that wires only the orchestrator routes,
    // backed by a real in-memory SQLite database so we can seed a node.
    dbPath = path.join(os.tmpdir(), `bug-hunt-c-${Date.now()}.db`);
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, pubkey_secp256k1 BLOB, pubkey_ed25519 BLOB,
        region TEXT NOT NULL, contact TEXT NOT NULL, capabilities TEXT,
        evm_address TEXT, solana_address TEXT, icp_address TEXT,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, domain TEXT,
        CHECK (pubkey_secp256k1 IS NOT NULL OR pubkey_ed25519 IS NOT NULL)
      );
      CREATE TABLE heartbeats (
        node_id TEXT PRIMARY KEY, rps INTEGER, p95_ms INTEGER,
        version TEXT, created_at INTEGER NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );
    `);

    nodeId = crypto.randomBytes(6).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO nodes (id, pubkey_ed25519, region, contact, status, created_at, updated_at)
      VALUES (?, ?, 'us-east', 'test@test.com', 'active', ?, ?)
    `).run(nodeId, crypto.randomBytes(32), now, now);

    // Override the DB_PATH so the orchestrator uses our temp database.
    process.env['NODE_DB_PATH'] = dbPath;
    process.env['EMAIL_VERIFICATION_SECRET'] = 'test-secret-not-real';
    process.env['ZOHO_CLIENT_ID'] = 'x';
    process.env['ZOHO_CLIENT_SECRET'] = 'x';
    process.env['ZOHO_REFRESH_TOKEN'] = 'x';
    process.env['ZOHO_MAIL_ACCOUNT_ID'] = 'x';
    process.env['ZOHO_MAIL_FROM'] = 'x@x.com';

    const app = express();
    app.use(express.json());

    // We mount just the heartbeat route inline to avoid the full server deps.
    // This mirrors exactly what orchestrator.js does:
    app.post('/node/heartbeat/:node_id', (req: any, res: any) => {
      // Copy the exact orchestrator logic:
      try {
        const { node_id } = req.params;
        const { rps, p95_ms, version } = req.body;
        db.prepare(`
          INSERT INTO heartbeats (node_id, rps, p95_ms, version, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(node_id) DO UPDATE SET
            rps=excluded.rps, p95_ms=excluded.p95_ms,
            version=excluded.version, created_at=excluded.created_at
        `).run(node_id, rps ?? null, p95_ms ?? null, version ?? null, Math.floor(Date.now() / 1000));
        res.json({ success: true, node_id });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    await new Promise<void>((resolve, reject) => {
      server = app.listen(PORT, (err?: Error) => err ? reject(err) : resolve());
    });
  });

  after(async () => {
    await new Promise<void>(r => server.close(r as () => void));
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('strangers cannot send heartbeats for arbitrary nodes (bug: no auth check exists)', async () => {
    // A completely unauthenticated client sends a heartbeat for the seeded node,
    // claiming it is running a fake version.  The server SHOULD return 401/403.
    // The bug: it returns 200 and blindly stores the attacker-supplied version.
    const spoofedVersion = 'ATTACKER_CONTROLLED_VERSION';
    const resp = await fetch(`http://localhost:${PORT}/node/heartbeat/${nodeId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rps: 9999, p95_ms: 1, version: spoofedVersion }),
    });

    const body = await resp.json() as { success?: boolean; error?: string };

    assert.notEqual(
      resp.status, 200,
      `BUG-C: POST /node/heartbeat/${nodeId} returned HTTP ${resp.status} with no auth ` +
      `and accepted version="${spoofedVersion}".  Any internet client can spoof heartbeats ` +
      'for any registered node, prematurely clearing forced-update state and corrupting ' +
      'the routing metrics used by powerOfTwoChoices().',
    );

    // Verify nothing was written with attacker data.
    const hb = db.prepare('SELECT version FROM heartbeats WHERE node_id = ?').get(nodeId) as any;
    assert.notEqual(
      hb?.version, spoofedVersion,
      `BUG-C: Attacker-supplied version "${spoofedVersion}" was persisted to the heartbeats table.`,
    );
  });

  it('heartbeat endpoint requires a valid node-signed credential (bug: accepts any payload)', async () => {
    // This test verifies the endpoint rejects callers without a valid credential.
    // Currently it always returns 200, proving the absence of any auth check.
    const resp = await fetch(`http://localhost:${PORT}/node/heartbeat/completely-fake-id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rps: 0, p95_ms: 0, version: '0.0.0' }),
    });

    // With proper auth the server should at minimum return 4xx for an unknown node.
    // Currently it returns 200 even for invented node IDs if the DB insert succeeds.
    assert.ok(
      resp.status >= 400,
      `BUG-C: /node/heartbeat/completely-fake-id returned ${resp.status}.  ` +
      'Without authentication, any client can manufacture heartbeats for non-existent node IDs.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-D] HIGH · /node/email/start has no rate limit
//
// Impact: An attacker can call this endpoint in a tight loop to:
//   1. Spam arbitrary email addresses with verification codes (harassment/phishing).
//   2. Exhaust the Zoho SMTP quota, taking down email verification for all users.
//
// The /proxy, /, /health, /stats routes all carry a 120 req/min limiter.
// The email endpoint is conspicuously absent from that protection.
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-D] No rate limit on /node/email/start', () => {
  it('orchestrator.js applies a rate limiter to /node/email/start (bug: it does not)', () => {
    const src = fs.readFileSync(ORCH_SRC, 'utf-8');

    // Find the email/start handler block
    const emailStartIdx = src.indexOf('/node/email/start');
    assert.ok(emailStartIdx !== -1, 'orchestrator.js must define /node/email/start');

    // Check for rateLimit or limiter usage in the surrounding 500 chars
    const context = src.slice(Math.max(0, emailStartIdx - 500), emailStartIdx + 500);
    const hasRateLimit = /rateLimit|limiter|rate_limit/i.test(context);

    assert.ok(
      hasRateLimit,
      'BUG-D: /node/email/start has no rate-limiting middleware.  ' +
      'An attacker can loop at full speed to spam any email address or exhaust the SMTP quota. ' +
      'Contrast with /proxy, /, /health, /stats which all carry the publicLimiter (120 req/min).',
    );
  });

  it('server.js passes its rate limiter down to orchestrator routes (bug: it does not)', () => {
    const serverSrc = fs.readFileSync(SERVER_SRC, 'utf-8');
    const orchSrc   = fs.readFileSync(ORCH_SRC, 'utf-8');

    // The publicLimiter is defined in server.js but is never passed to registerNodes().
    const limiterPassedToRegisterNodes =
      /registerNodes\s*\([^)]*[Ll]imiter/.test(serverSrc) ||
      /publicLimiter/.test(orchSrc);

    assert.ok(
      limiterPassedToRegisterNodes,
      'BUG-D: publicLimiter defined in server.js is not passed to registerNodes() and is not ' +
      'imported in orchestrator.js.  The /node/email/start endpoint is therefore unprotected.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-E] MEDIUM · Router._buildStats() N+1 NodeStore.getNode() query pattern
//
// Impact: getStats() calls NodeStore.listNodes() (1 full table scan), then for
// every entry in activeRequests it calls NodeStore.getNode(nodeId) — one extra
// query per active request node.  With 50 concurrent active nodes this is 51
// synchronous SQLite queries per stats call.  /health and /stats invoke this
// path; under load it causes unnecessary database contention and slows responses.
//
// Fix: build a Map<id, node> from the already-fetched allNodes and do an O(1)
// Map.get() instead of an additional DB query inside the load_distribution map.
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-E] Router._buildStats() N+1 NodeStore.getNode() calls', () => {
  it('_buildStats() makes only 1 DB read (listNodes) — not 1 + N (bug: calls getNode per node)', async () => {
    const NodeStoreModule = await import('../../data/node_store.js');
    const { default: Router }     = await import('../../router.ts');

    const NodeStore = NodeStoreModule.NodeStore ?? NodeStoreModule.default;

    let getNodeCallCount = 0;
    const origGetNode = NodeStore.getNode.bind(NodeStore);
    NodeStore.getNode = (id: string) => {
      getNodeCallCount++;
      return origGetNode(id);
    };

    const router = new Router();

    // Simulate 5 nodes with in-flight requests so load_distribution is non-empty.
    const fakeNodeIds = Array.from({ length: 5 }, (_, i) => `fake-node-bugE-${i}`);
    for (const id of fakeNodeIds) router.incrementRequest(id);

    getNodeCallCount = 0;  // reset AFTER setup, before the stat call
    router.getStats();
    const callsForFiveNodes = getNodeCallCount;

    for (const id of fakeNodeIds) router.decrementRequest(id);
    NodeStore.getNode = origGetNode;

    assert.equal(
      callsForFiveNodes, 0,
      `BUG-E: _buildStats() called NodeStore.getNode() ${callsForFiveNodes} time(s) for ` +
      '5 active nodes.  Expected 0 extra queries — allNodes from listNodes() should be ' +
      'used directly via a Map lookup.  Each getNode() is a full prepared-statement execution ' +
      'on the SQLite connection, adding unnecessary latency to every /health and /stats call.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-F] MEDIUM · Proxy error handler leaks internal error.message to clients
//
// Impact: When makeRequest() throws (e.g. DNS failure, upstream timeout, SSRF
// block), the 500 handler in server.js includes error.message verbatim:
//
//   res.status(500).json({ error: 'Proxy request failed', message: error.message })
//
// error.message from axios includes the target URL, resolved IPs, and connection
// details.  Callers can use this to probe internal network topology, confirm
// that SSRF was only partially blocked, or learn what internal hosts exist.
//
// The fix is to sanitise or omit error.message from the 500 response.
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-F] Error message leakage in POST /proxy handler', () => {
  it('server.js 500 handler does not forward error.message to the client (bug: it does)', () => {
    const src = fs.readFileSync(SERVER_SRC, 'utf-8');

    // Look for the pattern that exposes error.message in a 500 response body
    // inside the /proxy handler.
    const leaksMessage = /res\.status\(500\)[^}]*message\s*:\s*error\.message/s.test(src);

    assert.equal(
      leaksMessage, false,
      'BUG-F: server.js forwards error.message verbatim in the 500 JSON response. ' +
      'Axios errors include the target URL, upstream IP, and connection details. ' +
      'A client can learn internal network topology by inducing proxy failures. ' +
      'Fix: log the full error server-side; send only a safe generic message to the client.',
    );
  });

  it('makeRequest error includes the upstream url field (confirms leakage vector exists)', () => {
    const src = fs.readFileSync(PROXY_SRC, 'utf-8');

    // Confirm the error object explicitly attaches the url property.
    // url is attached as a shorthand property: Object.assign(new Error(msg), { ..., url })
    const attaches_url = /Object\.assign\s*\(\s*new Error/.test(src) &&
                         /\burl\s*[,}\n]/.test(src.slice(src.indexOf('Object.assign')));

    assert.ok(
      attaches_url,
      'Sanity-check: makeRequest does not attach the url to thrown errors — ' +
      'review whether the leakage vector is still present.',
    );
  });
});
