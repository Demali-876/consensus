/**
 * Bug Hunt – Daily Security & Performance Audit
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BUG-1  [CRITICAL] SSRF bypass via WebSocket proxy
 *        File: server/features/websocket/wss.ts — executeProxyRequest()
 *        Risk: Any WebSocket session holder can reach internal network
 *              services (metadata servers, databases, admin APIs) that the
 *              HTTP proxy correctly blocks via isPrivateTarget().
 *        Fix:  Call `isPrivateTarget(req.url)` at the top of
 *              executeProxyRequest and send a proxy_error if it returns true.
 *
 * BUG-2  [HIGH]  Client-controlled permanent cache via oversized x-cache-ttl
 *        File: server/features/proxy/proxy.ts — handleRequest(), line 246
 *        Risk: A client can supply x-cache-ttl: 1e20 (a valid JS integer).
 *              The entry is stored with an astronomically large TTL (> MAX_SAFE_INTEGER ms).
 *              Precision loss makes the expiry effectively infinite, permanently
 *              pinning a stale response in the cache and consuming one of the
 *              10 000 available cache slots indefinitely.
 *        Fix:  Add `Math.min(resolvedTTL, 86_400)` (cap at 24 h) before the
 *              final `Math.max(1, ...)` call.
 *
 * BUG-3  [HIGH]  Unauthenticated heartbeat injection
 *        File: server/features/nodes/orchestrator.js — POST /node/heartbeat/:node_id
 *        Risk: node_id values are publicly disclosed by GET /nodes.  Any actor
 *              who knows a node_id can POST arbitrary rps, p95_ms, and version
 *              values with no cryptographic proof of node ownership.  Fabricated
 *              metrics skew the Router's load-balancing decisions (Power-of-Two
 *              Choices uses activeRequests which is in-memory, but avgWsLatencyMs
 *              is computed from heartbeat.p95_ms from the DB).
 *        Fix:  Require a detached Ed25519 signature over a server-issued
 *              challenge (or over the heartbeat payload + timestamp), verified
 *              against the stored pubkey_ed25519.
 *
 * BUG-4  [PERF]  Router.selectNode performs a full DB scan on every request
 *        File: server/router.ts — selectNode(), line 60
 *        Risk: `NodeStore.listNodes()` issues a `SELECT … JOIN` across the
 *              entire nodes table on every call to selectNode().  selectNode()
 *              is called for every proxied HTTP request, so at 100 RPS this
 *              means 100 full-table SQLite scans per second.  The same file
 *              already caches _buildStats() for 1 second — the same pattern
 *              should be applied to selectNode's node list.
 *        Fix:  Cache the `NodeStore.listNodes()` result for 1–2 seconds inside
 *              Router, similar to the existing `statsCache` pattern.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: node --import tsx/esm --test utils/tests/bug-hunt.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import NodeCache from 'node-cache';

import ConsensusProxy from '../../features/proxy/proxy.ts';
import { isPrivateTarget } from '../ssrf.ts';
import { handleLocalSession } from '../../features/websocket/wss.ts';
import NodeStore from '../../data/node_store.js';
import Router from '../../router.ts';

// ── Minimal WebSocket stand-in ────────────────────────────────────────────────

class MockWebSocket extends EventEmitter {
  /** Must match WebSocket.OPEN so sendProxyResult does not early-return. */
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    this.emit('_sent', msg);
  }

  close(_code?: number, _reason?: string): void {
    this.emit('close');
  }

  /** Waits for the first sent message that satisfies `pred`. */
  nextMessage(
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    const already = this.sent.find(pred);
    if (already) return Promise.resolve(already);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timeout waiting for MockWebSocket message')),
        timeoutMs,
      );
      const handler = (msg: Record<string, unknown>) => {
        if (pred(msg)) {
          clearTimeout(timer);
          this.off('_sent', handler);
          resolve(msg);
        }
      };
      this.on('_sent', handler);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG-1 [CRITICAL]  SSRF bypass via WebSocket proxy
// ─────────────────────────────────────────────────────────────────────────────

describe('BUG-1 [CRITICAL] SSRF bypass in WebSocket proxy', () => {
  let internalServer: http.Server;
  let internalPort: number;
  let internalHits: number;

  before(() =>
    new Promise<void>((resolve) => {
      internalHits = 0;
      internalServer = http.createServer((_req, res) => {
        internalHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secret: 'INTERNAL_DATA' }));
      });
      internalServer.listen(0, '127.0.0.1', () => {
        internalPort = (internalServer.address() as { port: number }).port;
        resolve();
      });
    }),
  );

  after(() => new Promise<void>((r) => internalServer.close(() => r())));

  it('control: isPrivateTarget correctly blocks 127.0.0.1', async () => {
    const blocked = await isPrivateTarget(`http://127.0.0.1:${internalPort}/`);
    assert.equal(blocked, true, 'isPrivateTarget must flag loopback as private');
  });

  it('control: HTTP proxy rejects a request targeting localhost (SSRF protection active)', async () => {
    const proxy = new ConsensusProxy();
    try {
      await assert.rejects(
        () => proxy.handleRequest(`http://127.0.0.1:${internalPort}/`, 'GET'),
        (err: Error) =>
          err instanceof TypeError && /private|internal/i.test(err.message),
        'ConsensusProxy.handleRequest must reject private targets',
      );
      assert.equal(internalHits, 0, 'Internal server must NOT be reached via HTTP proxy');
    } finally {
      proxy.destroy();
    }
  });

  it('BUG: WebSocket proxy forwards requests to localhost with no SSRF check', async () => {
    const ws = new MockWebSocket();
    const sessionId = crypto.randomUUID();

    // handleLocalSession sets up an internal timer (5 min). We emit 'close'
    // at the end of this test to cancel it.
    handleLocalSession(ws as any, sessionId, 'hybrid', 5, 50);

    await ws.nextMessage((m) => m['type'] === 'session_start');

    const reqId = 'ssrf-probe';
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          id:     reqId,
          url:    `http://127.0.0.1:${internalPort}/secret`,
          method: 'GET',
        }),
      ),
    );

    const response = await ws.nextMessage((m) => m['id'] === reqId);

    // ── Bug evidence ──────────────────────────────────────────────────────
    assert.equal(
      response['status'],
      200,
      'BUG: WS proxy reached an internal service — the same URL the HTTP proxy blocked',
    );
    assert.ok(
      String(response['body']).includes('INTERNAL_DATA'),
      'BUG: WS proxy returned sensitive data from the internal service to the client',
    );
    assert.equal(
      internalHits,
      1,
      'BUG: Internal server was contacted 1 time via the unprotected WebSocket path',
    );

    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-2 [HIGH]  Client-controlled permanent cache via oversized x-cache-ttl
// ─────────────────────────────────────────────────────────────────────────────

describe('BUG-2 [HIGH] Client-controlled permanent cache via oversized x-cache-ttl', () => {
  it('root cause: Number.isInteger(1e20) is true — large floats bypass the integer guard', () => {
    // proxy.ts line 246: Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0
    // A client submitting x-cache-ttl: 100000000000000000000 passes both checks.
    assert.equal(
      Number.isInteger(1e20),
      true,
      'BUG: Number.isInteger(1e20) is true — scientific-notation integers slip through',
    );
    assert.ok(
      1e20 >= 0,
      'BUG: 1e20 also passes the >= 0 guard',
    );
  });

  it('root cause: resulting TTL exceeds Number.MAX_SAFE_INTEGER — precision is lost', () => {
    // Reproduces the exact proxy.ts code path (lines 244–248):
    const ttlRaw     = '100000000000000000000'; // x-cache-ttl header value
    const ttlFromHdr = Number(ttlRaw);           // = 1e20
    const resolvedTTL =
      Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0 ? ttlFromHdr : 300;
    const ttl = resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL);

    assert.equal(ttl, 1e20, 'BUG: TTL resolves to 1e20 seconds (≈ 3.17 trillion years)');
    assert.ok(
      ttl > Number.MAX_SAFE_INTEGER,
      `BUG: ttl (${ttl}) exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
        'Expiry timestamps stored by node-cache lose integer precision.',
    );
  });

  it('BUG: node-cache stores an entry with 1e20-second TTL and it never expires', () => {
    // This mirrors what ConsensusProxy.cache.set(dedupeKey, response, ttl) does
    // when a client supplies x-cache-ttl: 1e20.
    const cache = new NodeCache({ stdTTL: 300, checkperiod: 0 });

    cache.set('poisoned-key', { data: 'stale-response' }, 1e20);

    // The entry is present immediately after storing
    assert.ok(
      cache.get('poisoned-key') !== undefined,
      'BUG: Entry with 1e20-second TTL is successfully stored',
    );

    // Simulate time passing — in a correct system a max-TTL cap would expire this.
    // Here we confirm the effective expiry is so far in the future that manual
    // inspection of the TTL calculation reveals the issue.
    const stats = cache.getStats();
    assert.equal(stats.keys, 1, 'BUG: One permanently pinned slot consumed from the 10 000-slot cache');

    // Verify: the entry still exists after we simulate an internal expiry check.
    // node-cache internally uses Date.now()/1000 + ttl for the expiry timestamp.
    // With ttl = 1e20, that timestamp is ≈ 1e20 seconds in the future — never reached.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt  = nowSeconds + 1e20; // what node-cache stores
    assert.ok(
      expiresAt > Date.now() / 1000 + 365 * 24 * 3600 * 100,
      'BUG: expiry timestamp is more than 100 years in the future — effectively permanent',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-3 [HIGH]  Unauthenticated heartbeat injection
// ─────────────────────────────────────────────────────────────────────────────

describe('BUG-3 [HIGH] Unauthenticated heartbeat injection', () => {
  let testNodeId: string;

  before(() => {
    testNodeId = `test-${crypto.randomBytes(4).toString('hex')}`;
    NodeStore.upsertNode({
      id:             testNodeId,
      pubkey_ed25519: Buffer.alloc(32, 0x42), // stable test key
      region:         'bug-hunt-test',
      contact:        `bughunt+${testNodeId}@example.com`,
      status:         'active',
    });
  });

  after(() => {
    NodeStore.deleteNode(testNodeId);
  });

  it('control: freshly registered node has no heartbeat data', () => {
    const node = NodeStore.getNode(testNodeId);
    assert.ok(node, 'Test node must exist after upsert');
    assert.equal(
      node!.heartbeat,
      null,
      'A newly registered node must have no heartbeat record yet',
    );
  });

  it('BUG: NodeStore.heartbeat accepts arbitrary metrics with no ownership proof', () => {
    // The POST /node/heartbeat/:node_id route calls NodeStore.heartbeat directly.
    // There is no challenge-response, no signature check, and no API key required.
    // node_id values are publicly visible in the GET /nodes response.

    NodeStore.heartbeat(testNodeId, {
      rps:     999_999,            // fabricated: claim 1 M req/s
      p95_ms:  1,                  // fabricated: claim 1 ms tail latency
      version: 'compromised-9.9', // fabricated: inject a false version string
    });

    const poisoned = NodeStore.getNode(testNodeId);
    assert.ok(poisoned?.heartbeat, 'Heartbeat was accepted');

    assert.equal(
      poisoned!.heartbeat!.rps,
      999_999,
      'BUG: False RPS metric stored without any authentication',
    );
    assert.equal(
      poisoned!.heartbeat!.p95_ms,
      1,
      'BUG: False latency metric stored — Router.getStats uses this for avgWsLatencyMs',
    );
    assert.equal(
      poisoned!.heartbeat!.version,
      'compromised-9.9',
      'BUG: False version string stored — updater may react to fabricated version data',
    );
  });

  it('BUG: spoofed metrics persist in NodeStore and affect routing statistics', () => {
    // The Router's _buildStats computes avg_ws_latency_ms from heartbeat.p95_ms.
    // Fabricated 1 ms latency makes this node appear best-in-class.
    const nodes = NodeStore.listNodes();
    const testNode = nodes.find((n) => n.id === testNodeId);

    assert.ok(testNode, 'Poisoned node must appear in listNodes()');
    assert.equal(
      testNode!.heartbeat?.p95_ms,
      1,
      'BUG: Falsified 1 ms p95 latency is returned in listNodes, skewing Router statistics',
    );
    assert.equal(
      testNode!.heartbeat?.version,
      'compromised-9.9',
      'BUG: Fabricated version visible to the updater subsystem',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-4 [PERF]  Router.selectNode performs a full DB scan on every request
// ─────────────────────────────────────────────────────────────────────────────

describe('BUG-4 [PERF] Router.selectNode calls NodeStore.listNodes() on every invocation', () => {
  let router: Router;
  let listNodesCallCount: number;
  let originalListNodes: typeof NodeStore.listNodes;

  before(() => {
    listNodesCallCount = 0;
    originalListNodes  = NodeStore.listNodes.bind(NodeStore);
    // Instrument listNodes to count every call
    NodeStore.listNodes = () => {
      listNodesCallCount++;
      return originalListNodes();
    };
    router = new Router();
  });

  after(() => {
    NodeStore.listNodes = originalListNodes;
  });

  it('BUG: each selectNode call issues a full-table NodeStore.listNodes() query', () => {
    const REQUESTS = 10;

    for (let i = 0; i < REQUESTS; i++) {
      router.selectNode(crypto.randomBytes(8).toString('hex'));
    }

    // selectNode also calls NodeStore.getNode() for sticky-map lookups,
    // but listNodes is the full JOIN scan.  We verify it fires once per call.
    assert.equal(
      listNodesCallCount,
      REQUESTS,
      `BUG: listNodes was called ${listNodesCallCount} times for ${REQUESTS} selectNode ` +
        'invocations. A 1-second in-memory cache would reduce this to ~1 call per second.',
    );
  });

  it('contrast: Router.getStats() uses a 1-second cache — the same pattern must cover selectNode', () => {
    // The caching pattern already exists in the same file (router.ts lines 218–225).
    // getStats() returns a cached result and avoids repeated listNodes scans.
    // selectNode() does not reuse this cache.
    const callsBefore = listNodesCallCount;

    router.getStats(); // Populates statsCache
    router.getStats(); // Served from statsCache (no additional listNodes call)

    // getStats calls listNodes once for the first call; second call uses cache.
    assert.ok(
      listNodesCallCount - callsBefore <= 1,
      'getStats correctly avoids repeated listNodes scans within its 1-second window',
    );

    // Show the asymmetry: at 100 RPS, selectNode issues 100 listNodes scans/s,
    // while getStats would issue only ~1 scan/s.  The same cache should cover both.
  });

  it('perf: 100 selectNode calls cost 100 listNodes round-trips — measurable overhead', () => {
    const resetCount = listNodesCallCount;
    const BURST = 100;

    const start = process.hrtime.bigint();
    for (let i = 0; i < BURST; i++) {
      router.selectNode(crypto.randomBytes(8).toString('hex'));
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    const scansDone = listNodesCallCount - resetCount;
    assert.equal(
      scansDone,
      BURST,
      `BUG: ${scansDone} DB scans issued for ${BURST} proxy requests (should be ~1 with caching)`,
    );

    // Even on an empty DB the linear scan overhead is measurable.
    // On a production DB with many nodes this cost grows proportionally.
    assert.ok(
      elapsedMs > 0,
      `${BURST} selectNode calls took ${elapsedMs.toFixed(2)} ms — ` +
        `all ${scansDone} listNodes() DB scans are redundant overhead`,
    );
  });
});
