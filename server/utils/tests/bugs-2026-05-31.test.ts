/**
 * Bug Hunt — 2026-05-31
 *
 * Three new bugs found across proxy.ts and orchestrator.js.
 *
 * ┌──────────┬──────────────┬─────────────────────────────────────────────────────────────┐
 * │  Tag     │  Severity    │  Description                                                 │
 * ├──────────┼──────────────┼─────────────────────────────────────────────────────────────┤
 * │ PERF-3   │ Critical     │ pendingRequests map is never written — concurrent identical  │
 * │          │ Performance  │ requests ALL fire independently.  The advertised "93% fewer  │
 * │          │              │ requests" is only delivered for cache hits, never for         │
 * │          │              │ in-flight coalescing.                                         │
 * ├──────────┼──────────────┼─────────────────────────────────────────────────────────────┤
 * │ SEC-4    │ High         │ No post-decompression size cap.  A response whose compressed  │
 * │          │ Security     │ size is tiny (passes axios maxContentLength) but whose       │
 * │          │              │ decompressed size is gigantic will be fully buffered in heap. │
 * ├──────────┼──────────────┼─────────────────────────────────────────────────────────────┤
 * │ SEC-5    │ Medium       │ POST /node/heartbeat/:node_id carries no authentication.     │
 * │          │ Security     │ Anyone who discovers a node_id can forge heartbeat metrics   │
 * │          │              │ and abort in-progress updates via clearCompletedUpdateState. │
 * └──────────┴──────────────┴─────────────────────────────────────────────────────────────┘
 *
 * Run:
 *   npx tsx --test server/utils/tests/bugs-2026-05-31.test.ts
 *
 * Each suite is expected to FAIL until the bug is fixed.
 */

import { describe, it, before, after } from 'node:test';
import assert   from 'node:assert/strict';
import crypto   from 'node:crypto';
import http     from 'node:http';
import zlib     from 'node:zlib';
import { promisify } from 'node:util';
import os       from 'node:os';
import path     from 'node:path';
import fs       from 'node:fs';

import type { SafeResolution } from '../../utils/ssrf.ts';
import ConsensusProxy from '../../features/proxy/proxy.ts';

const gzipAsync = promisify(zlib.gzip);

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // must match proxy.ts

const closeServer = (srv: http.Server): Promise<void> =>
  new Promise((resolve) => { (srv as any).closeAllConnections?.(); srv.close(() => resolve()); });

/**
 * SSRF resolver that allows localhost connections — safe for tests because
 * test servers are explicitly controlled.  Passes the pre-resolved IP straight
 * through so proxy.ts can pin the connection to it.
 */
function makeLocalSsrfCheck(): (url: string) => Promise<SafeResolution> {
  return async (url: string): Promise<SafeResolution> => {
    const parsed = new URL(url);
    return { ip: '127.0.0.1', family: 4, hostname: parsed.hostname, isLiteral: false };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// [PERF-3] Concurrent request deduplication is dead code
// ─────────────────────────────────────────────────────────────────────────────

describe('[PERF-3] pendingRequests never populated — concurrent identical requests both fire', () => {
  /**
   * ROOT CAUSE
   * ----------
   * ConsensusProxy.handleRequest checks this.pendingRequests.get(dedupeKey) at
   * line ~275 (the "in-flight coalescing" path) but no code path ever calls
   * this.pendingRequests.set(dedupeKey, promise).  The map is permanently empty,
   * so the check is dead code and every concurrent request fires independently.
   *
   * IMPACT
   * ------
   * The core product claim is "only 1 request executes regardless of how many
   * consensus nodes send it".  That guarantee holds for CACHED responses (the
   * cache check above the pending check does work).  But for the first wave of
   * concurrent requests — before any response is back — every caller races to
   * the upstream.  In a 13-node consensus cluster the upstream receives 13
   * identical requests instead of 1.
   *
   * FIX
   * ---
   * Before executing, register the in-flight promise:
   *
   *   const promise = this.executeDirect(...) or executeViaNode(...)
   *   this.pendingRequests.set(dedupeKey, promise);
   *   try {
   *     return await promise;
   *   } finally {
   *     this.pendingRequests.delete(dedupeKey);
   *   }
   */

  const PORT = 43_100;
  let upstream: http.Server;
  let proxy:    ConsensusProxy;
  let hits:     number;

  before(async () => {
    hits = 0;

    // Upstream introduces a 60 ms delay so both concurrent requests are
    // guaranteed to overlap on the wire before either receives a response.
    upstream = http.createServer((_req, res) => {
      hits++;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hit: hits }));
      }, 60);
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.once('listening', resolve);
      upstream.listen(PORT, '127.0.0.1');
    });

    proxy = new ConsensusProxy({ ssrfCheck: makeLocalSsrfCheck() });
  });

  after(async () => {
    proxy.destroy();
    await closeServer(upstream);
  });

  it('two concurrent identical requests must coalesce into one upstream call', async () => {
    const url = `http://localhost:${PORT}/data`;
    hits = 0; // reset per-test

    // Fire both without awaiting sequentially so they genuinely overlap.
    const [r1, r2] = await Promise.all([
      proxy.handleRequest(url, 'GET'),
      proxy.handleRequest(url, 'GET'),
    ]);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    // EXPECTED (fixed):  upstream called exactly once; second request coalesces.
    // ACTUAL   (buggy):  upstream called twice because pendingRequests is never
    //                    populated, so the second request misses the in-flight check.
    assert.equal(
      hits, 1,
      `[PERF-3] Upstream was called ${hits} times for 2 concurrent identical requests. ` +
      'Expected 1 call (coalescing). ' +
      'Fix: store the in-flight promise in this.pendingRequests before awaiting it.',
    );
  });

  it('ten concurrent identical requests must produce exactly one upstream call', async () => {
    const url = `http://localhost:${PORT}/bulk`;
    hits = 0;

    await Promise.all(
      Array.from({ length: 10 }, () => proxy.handleRequest(url, 'GET')),
    );

    assert.equal(
      hits, 1,
      `[PERF-3] Upstream hit ${hits} times for 10 concurrent requests. ` +
      'A 13-node consensus cluster with this bug hammers the upstream 13×.',
    );
  });

  it('sequential (non-concurrent) requests DO hit cache on second call (baseline)', async () => {
    const url = `http://localhost:${PORT}/sequential`;
    hits = 0;

    const r1 = await proxy.handleRequest(url, 'GET');
    const r2 = await proxy.handleRequest(url, 'GET'); // must hit cache

    assert.equal(r1.cached, false);
    assert.equal(r2.cached, true,  'second sequential request must be served from cache');
    assert.equal(hits, 1,          'upstream must be contacted exactly once across two sequential calls');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-4] No post-decompression size cap — decompression bomb
// ─────────────────────────────────────────────────────────────────────────────

describe('[SEC-4] No post-decompression size cap — gzip bomb exhausts heap memory', () => {
  /**
   * ROOT CAUSE
   * ----------
   * proxy.ts passes `decompress: false` to axios (line ~468) so it receives
   * the raw compressed bytes.  The `maxContentLength: MAX_RESPONSE_BYTES` limit
   * therefore applies to the COMPRESSED wire size.
   *
   * A gzip "bomb" is a file whose compressed size is tiny (e.g. 50 KB) but
   * whose decompressed size is enormous (e.g. 100 MB).  After axios accepts
   * the 50 KB payload, proxy.ts calls gunzipAsync(raw) which decompresses the
   * full 100 MB into a Node.js Buffer — with no subsequent size check.
   *
   * The raw.toString('utf8') call that follows converts that buffer to a
   * string, doubling memory to 200 MB.  In production this silently allocates
   * hundreds of megabytes of heap per request and can trigger OOM crashes.
   *
   * IMPACT
   * ------
   * A single malicious upstream (or a MITM response) can exhaust server memory.
   * No authentication is required — the /proxy endpoint accepts requests from
   * any paying x402 client, and the target_url is attacker-controlled.
   *
   * FIX
   * ---
   * After decompression, add:
   *
   *   if (raw.length > MAX_RESPONSE_BYTES)
   *     throw new Error(`Decompressed response exceeds ${MAX_RESPONSE_BYTES} bytes`);
   *
   * This mirrors the pattern that BUG-1 in security-perf.test.ts already
   * documents, but the guard was never added to the source.
   */

  const PORT = 43_101;
  let upstream: http.Server;
  let proxy:    ConsensusProxy;

  before(async () => {
    // Build a gzip payload: compressed ≈ 50 KB, decompressed = MAX + 1 MB.
    // Uniform bytes compress extremely well (~1000:1 ratio).
    const decompressedSize = MAX_RESPONSE_BYTES + 1024 * 1024; // 50 MB + 1 MB over limit
    const plain            = Buffer.alloc(decompressedSize, 0x41);
    const bomb             = await gzipAsync(plain);

    // Sanity: the compressed payload must be well under the wire limit so it
    // passes axios's maxContentLength check and reaches our decompression code.
    assert.ok(
      bomb.length < MAX_RESPONSE_BYTES,
      `Compressed bomb (${bomb.length} bytes) must be < maxContentLength (${MAX_RESPONSE_BYTES} bytes)`,
    );

    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type':     'application/octet-stream',
        'content-encoding': 'gzip',
        'content-length':   String(bomb.length),
      });
      res.end(bomb);
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.once('listening', resolve);
      upstream.listen(PORT, '127.0.0.1');
    });

    proxy = new ConsensusProxy({ ssrfCheck: makeLocalSsrfCheck() });
  });

  after(async () => {
    proxy.destroy();
    await closeServer(upstream);
  });

  it('rejects a gzip bomb whose decompressed size exceeds MAX_RESPONSE_BYTES', async () => {
    // EXPECTED (fixed):  proxy throws with a message mentioning the size limit.
    // ACTUAL   (buggy):  proxy decompresses the full bomb and returns successfully,
    //                    silently allocating 50+ MB of heap per request.
    await assert.rejects(
      () => proxy.handleRequest(`http://localhost:${PORT}/bomb`, 'GET'),
      (err: unknown) => {
        assert.ok(err instanceof Error,
          `[SEC-4] Expected an Error but got: ${String(err)}`);
        assert.ok(
          /exceeds|limit|too large|max.*bytes/i.test((err as Error).message),
          `[SEC-4] Error message must mention the size limit. Got: "${(err as Error).message}". ` +
          'Fix: add a post-decompression size check: ' +
          'if (raw.length > MAX_RESPONSE_BYTES) throw new Error("Decompressed response exceeds limit");',
        );
        return true;
      },
    );
  });

  it('correctly decompresses and returns a response just under MAX_RESPONSE_BYTES', async () => {
    // Safe payload: decompressed size is 1 byte under the cap.
    const safeSize = MAX_RESPONSE_BYTES - 1;
    const safe     = await gzipAsync(Buffer.alloc(safeSize, 0x42));

    const smallServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type':     'application/octet-stream',
        'content-encoding': 'gzip',
        'content-length':   String(safe.length),
      });
      res.end(safe);
    });

    const PORT2 = PORT + 1;
    await new Promise<void>((resolve, reject) => {
      smallServer.once('error', reject);
      smallServer.once('listening', resolve);
      smallServer.listen(PORT2, '127.0.0.1');
    });

    try {
      const r = await proxy.handleRequest(`http://localhost:${PORT2}/safe`, 'GET');
      assert.equal(r.status, 200, 'Sub-limit compressed response must succeed');
    } finally {
      await closeServer(smallServer);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-5] Unauthenticated heartbeat endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('[SEC-5] POST /node/heartbeat/:node_id requires no authentication', () => {
  /**
   * ROOT CAUSE
   * ----------
   * orchestrator.js registers the heartbeat route with no authentication
   * middleware:
   *
   *   app.post('/node/heartbeat/:node_id', (req, res) => { ... });
   *
   * Node IDs are 12 hex characters (6 random bytes) and are publicly listed
   * at GET /nodes, so they are trivially discoverable.
   *
   * IMPACT
   * ------
   * 1. Metric spoofing — any caller can POST fake { rps, p95_ms } values for
   *    any node, corrupting the router's load-balancing signals.
   *
   * 2. Update abort — clearCompletedUpdateState() runs on every heartbeat.
   *    If a node is mid-update targeting version X, an attacker can send
   *    { version: X } in a heartbeat and clear the update_state, causing the
   *    orchestrator to believe the update succeeded and stop monitoring the node.
   *
   * 3. Version poisoning — a fake version string in the heartbeat propagates
   *    to GET /nodes, misleading operators about which software is running.
   *
   * FIX
   * ---
   * Require nodes to sign each heartbeat with their registered Ed25519 key,
   * similar to the join-request flow:
   *
   *   const { signature, timestamp } = req.body;
   *   const payload = Buffer.from(JSON.stringify({ node_id, timestamp, rps, p95_ms, version }));
   *   const valid = crypto.verify(null, payload, node.pubkey_ed25519, Buffer.from(signature, 'base64'));
   *   if (!valid) return res.status(401).json({ error: 'Invalid heartbeat signature' });
   */

  let dbPath: string;
  let srv:    http.Server;
  let port:   number;

  before(async () => {
    dbPath = path.join(os.tmpdir(), `heartbeat-test-${Date.now()}.db`);
    process.env['NODE_DB_PATH'] = dbPath;
    process.env['FREE_MODE']    = 'true';

    const { default: NodeStore } = await import('../../data/node_store.js') as { default: any };

    // Register a live node with a real Ed25519 key pair.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkeyDer = publicKey.export({ format: 'der', type: 'spki' });

    NodeStore.upsertNode({
      id:             'vuln-node-001',
      pubkey_ed25519: pubkeyDer,
      region:         'test-region',
      contact:        'ops@example.com',
      capabilities:   {
        update_state:          'updating',
        update_target_version: '9.9.9',
      },
      evm_address:    '0x' + '0'.repeat(40),
      solana_address: 'A'.repeat(32),
      icp_address:    'test',
      status:         'active',
    });
    NodeStore.setDomain('vuln-node-001', 'vuln001.consensus.canister.software');

    // Minimal Express server with just the orchestrator routes.
    const { default: express }       = await import('express');
    const { registerNodes }          = await import('../../features/nodes/orchestrator.js') as { registerNodes: any };

    const app = express();
    app.use(express.json());
    registerNodes(app, null, {} as any, {
      EVM_PAY_TO:    '0x' + '0'.repeat(40),
      SOLANA_PAY_TO: 'A'.repeat(32),
      ICP_PAY_TO:    'test',
    });

    srv  = http.createServer(app);
    port = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as any).port));
    });
  });

  after(async () => {
    await closeServer(srv);
    delete process.env['FREE_MODE'];
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('accepts a heartbeat with no auth headers and returns 200 (should be 401)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/node/heartbeat/vuln-node-001`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ rps: 9999, p95_ms: 1, version: 'attacker-spoofed' }),
    });
    const body = await res.json() as Record<string, unknown>;

    // EXPECTED (fixed):  401 — unauthenticated callers are rejected.
    // ACTUAL   (buggy):  200 — no auth check; metric is written to the DB.
    assert.equal(
      res.status, 401,
      `[SEC-5] POST /node/heartbeat/:node_id returned HTTP ${res.status} with no auth. ` +
      `Response: ${JSON.stringify(body)}. ` +
      'Fix: validate an Ed25519 signature over {node_id, timestamp, rps, p95_ms, version}.',
    );
  });

  it('an unauthenticated heartbeat with matching update version clears update state (should be blocked)', async () => {
    // Demonstrate impact scenario 2: update abort via spoofed heartbeat.
    const { default: NodeStore } = await import('../../data/node_store.js') as { default: any };

    const before = NodeStore.getNode('vuln-node-001');
    assert.equal(before?.capabilities?.update_state, 'updating',
      'precondition: node must be in updating state');

    // Attacker sends version '9.9.9' — the exact update target — without any key material.
    const res = await fetch(`http://127.0.0.1:${port}/node/heartbeat/vuln-node-001`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ rps: 0, p95_ms: 0, version: '9.9.9' }),
    });

    if (res.status === 200) {
      // Bug is present: check that update_state was cleared by the spoofed heartbeat.
      const after = NodeStore.getNode('vuln-node-001');
      assert.equal(
        after?.capabilities?.update_state, 'updating',
        `[SEC-5] Unauthenticated heartbeat with version=9.9.9 cleared the update_state ` +
        `(was "updating", now "${after?.capabilities?.update_state ?? 'null'}"). ` +
        'An attacker can abort in-progress node updates by replaying the target version.',
      );
    }

    // Either the endpoint rejected the request (fixed) or it did NOT clear the update
    // state despite accepting it — the former is the desired outcome.
    assert.equal(
      res.status, 401,
      `[SEC-5] Heartbeat accepted without authentication (HTTP ${res.status}). ` +
      'Unauthenticated callers must not be able to modify node state.',
    );
  });
});
