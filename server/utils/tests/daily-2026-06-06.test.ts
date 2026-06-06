/**
 * Daily Bug Hunt — 2026-06-06
 *
 * Security and performance audit findings.  Each suite names the bug, explains
 * why it matters, and then asserts the fix is in place.  Tests that FAIL prove
 * the bug still exists; tests that PASS are regression guards for confirmed fixes.
 *
 * Run:
 *   node_modules/.bin/tsx --test utils/tests/daily-2026-06-06.test.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG-3] proxy.ts — pendingRequests map is never populated (concurrent
 *          request coalescing is completely non-functional)
 *
 * [SEC-2] x402-proxy/server.js — /fetch endpoint missing requireLoopback;
 *          the server binds 0.0.0.0 so any host with a valid API key can
 *          trigger payment-signed requests remotely.
 *
 * [PERF-3] ssrf.ts — DNS_CACHE Map has no size cap and no periodic sweeper;
 *          an attacker can exhaust server memory by sending many unique hostnames.
 *
 * [PERF-4] reverse-proxy.ts — response body is buffered in an unbounded
 *          chunks[] array with no maxContentLength guard (contrast: proxy.ts
 *          caps at MAX_RESPONSE_BYTES = 50 MB).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import http   from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path   from 'node:path';

import ConsensusProxy      from '../../features/proxy/proxy.ts';
import { createProxy }     from '../../features/proxy/reverse-proxy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── path helpers ─────────────────────────────────────────────────────────────

function proxySource():        string { return fs.readFileSync(path.join(__dirname, '../../features/proxy/proxy.ts'),         'utf8'); }
function reverseProxySource(): string { return fs.readFileSync(path.join(__dirname, '../../features/proxy/reverse-proxy.ts'), 'utf8'); }
function ssrfSource():         string { return fs.readFileSync(path.join(__dirname, '../../utils/ssrf.ts'),                   'utf8'); }
function x402ServerSource():   string { return fs.readFileSync(path.join(__dirname, '../../../x402-proxy/server.js'),       'utf8'); }

function closeServer(srv: http.Server): Promise<void> {
  return new Promise(resolve => { (srv as any).closeAllConnections?.(); srv.close(() => resolve()); });
}

// ══════════════════════════════════════════════════════════════════════════════
// [BUG-3]  proxy.ts — pendingRequests map is never populated
//
// Root cause: The `pendingRequests` field is declared (line 206), initialised
// to an empty Map (line 221), and read in handleRequest (line 275), but
// this.pendingRequests.set() is never called anywhere in the file.
//
// Impact (critical — functional correctness):
//   The entire concurrent-request deduplication feature is dead code.  When N
//   canister replicas send the same request at the same moment the proxy fires
//   N upstream HTTP calls instead of 1, defeating the "93 % reduction" claim.
//   Each replica also independently pays the x402 fee.
//
// Fix: inside handleRequest, before calling executeDirect / executeViaNode,
//   register the in-flight promise:
//
//     const promise = this.executeDirect(...);
//     this.pendingRequests.set(dedupeKey, promise);
//     try { return await promise; }
//     finally { this.pendingRequests.delete(dedupeKey); }
// ══════════════════════════════════════════════════════════════════════════════

describe('[BUG-3] proxy.ts — pendingRequests.set() is never called; coalescing is dead code', () => {
  it('pendingRequests.set() call is absent from proxy.ts source — concurrent deduplication cannot work', () => {
    const src = proxySource();

    // The map is declared, initialised, read, and deleted from — but never written.
    assert.ok(src.includes('pendingRequests'),            'field must exist in source');
    assert.ok(src.includes('pendingRequests.get('),       'get() call must exist (reads are present)');
    assert.ok(src.includes('pendingRequests.delete('),    'delete() call must exist (cleanup present)');

    // THIS is the bug: set() is absent.  The assertion below FAILS, proving the bug.
    assert.ok(
      src.includes('pendingRequests.set('),
      '[BUG-3] FAIL — pendingRequests.set() is never called in proxy.ts. ' +
      'The concurrent-request coalescence check on line 275 reads from the map but nothing ' +
      'ever writes to it, so the "Cache HIT - Pending" path is unreachable. ' +
      'Every concurrent request with the same dedupe key independently fires an upstream call.',
    );
  });

  it('pendingRequests map stays empty after a request is attempted', async () => {
    const proxy = new ConsensusProxy();
    const pendingMap = (proxy as any).pendingRequests as Map<string, unknown>;

    assert.equal(pendingMap.size, 0, 'starts empty');

    // A private SSRF-blocked call still exercises the early-exit path and
    // confirms the map is never touched by any code branch.
    await proxy.handleRequest('http://127.0.0.1/ssrf-block', 'GET').catch(() => {});

    assert.equal(
      pendingMap.size, 0,
      '[BUG-3] pendingRequests is empty even after handleRequest() — no code path ever populates it.',
    );

    proxy.destroy();
  });

  it('getStats() reports pending_requests as 0 regardless of concurrent load — coalescing invisible', () => {
    const proxy = new ConsensusProxy();

    // Directly populate the map as the fix would do, to show the stats surface works when used.
    const fakeKey  = crypto.randomUUID();
    const fakePromise = Promise.resolve({} as any);
    (proxy as any).pendingRequests.set(fakeKey, fakePromise);

    const stats = proxy.getStats();
    assert.equal(stats.pending_requests, 1, 'stats must reflect injected pending entry');

    (proxy as any).pendingRequests.delete(fakeKey);
    const stats2 = proxy.getStats();
    assert.equal(stats2.pending_requests, 0, 'stat returns 0 after removal');

    proxy.destroy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [SEC-2]  x402-proxy/server.js — /fetch missing requireLoopback middleware
//
// Root cause: /register-wallet applies requireLoopback before validateApiKey,
//   but /fetch only applies validateApiKey.  The server explicitly binds to
//   0.0.0.0 (server.js line 268), so the port is reachable from any network
//   interface.
//
// Impact (high — security):
//   Any attacker who learns a valid API key (e.g. from ~/.consensus/config.json,
//   a leaked log, or by owning the user's machine transiently) can remotely
//   call /fetch from an external host and trigger payment-signed HTTP requests,
//   draining the victim's on-chain wallet without local access.
//
// Fix: add requireLoopback before validateApiKey in the /fetch route:
//   app.post('/fetch', requireLoopback, validateApiKey, async (req, res) => { … })
// ══════════════════════════════════════════════════════════════════════════════

describe('[SEC-2] x402-proxy /fetch endpoint — requireLoopback middleware is missing', () => {
  it('/register-wallet applies requireLoopback but /fetch does not — asymmetric protection', () => {
    const src = x402ServerSource();

    // Confirm the loopback guard exists and is used on /register-wallet.
    assert.ok(
      /app\.post\s*\(\s*['"]\/register-wallet['"][\s\S]{0,60}requireLoopback/.test(src),
      '/register-wallet must include requireLoopback (baseline check)',
    );

    // Extract the /fetch route signature.
    const fetchMatch = src.match(/app\.post\s*\(\s*['"]\/fetch['"]([^{]+)\{/);
    const fetchSignature = fetchMatch ? fetchMatch[1] : '';

    // THIS assertion FAILS, proving the bug.
    assert.ok(
      fetchSignature.includes('requireLoopback'),
      '[SEC-2] FAIL — /fetch route does not include requireLoopback middleware. ' +
      `Found route signature: "${fetchSignature.replace(/\s+/g, ' ').trim()}". ` +
      'The server listens on 0.0.0.0; any external host with a valid API key can POST ' +
      'to /fetch and trigger payment-signed requests, potentially draining the wallet.',
    );
  });

  it('server listens on 0.0.0.0 — confirms external reachability of unguarded /fetch', () => {
    const src = x402ServerSource();

    // Confirm the bind address, which makes the missing guard dangerous.
    assert.ok(
      src.includes("'0.0.0.0'") || src.includes('"0.0.0.0"'),
      '[SEC-2] Server must bind to 0.0.0.0 (confirms external exposure of /fetch)',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [PERF-3]  ssrf.ts — DNS_CACHE Map has no size cap or periodic sweeper
//
// Root cause: DNS_CACHE is a plain Map<string, DnsCacheEntry> with a 30-second
//   positive TTL and 5-second negative TTL.  Entries are evicted only on access
//   (lazy expiry).  There is no maximum size limit and no setInterval sweeper.
//
// Impact (high — availability / DoS):
//   An attacker continuously POSTing to /proxy with new unique hostname values
//   (e.g. <uuid>.attacker.com) forces one DNS lookup and one Map entry per
//   request.  Negative-TTL entries last 5 seconds, but with ≥1 req/s the
//   cache grows without bound.  At 10 000 entries (trivial to reach) each
//   entry consumes ~200 bytes → 2 MB.  At 100 req/s this is ~10 MB/s of
//   permanent heap growth until the process OOMs or is restarted.
//
// ResponseCache in reverse-proxy.ts (same pattern) correctly uses:
//   this.sweeper = setInterval(() => this.sweep(), 60_000);
//   and enforces maxSize in set().
//
// Fix: add both to ssrf.ts —
//   const DNS_CACHE_MAX_SIZE = 10_000;
//   const dnsCacheSweeper = setInterval(() => { … prune expired … }, 60_000);
//   dnsCacheSweeper.unref();
//   and evict the oldest entry in resolveAndCheckTarget when size >= DNS_CACHE_MAX_SIZE.
// ══════════════════════════════════════════════════════════════════════════════

describe('[PERF-3] ssrf.ts — DNS_CACHE is unbounded (no size cap, no sweeper)', () => {
  it('DNS_CACHE has no setInterval sweeper — expired entries accumulate until accessed', () => {
    const src = ssrfSource();

    const hasSweeper =
      /setInterval[\s\S]{0,120}DNS_CACHE/.test(src) ||
      /DNS_CACHE[\s\S]{0,120}setInterval/.test(src);

    // THIS assertion FAILS, proving the bug.
    assert.ok(
      hasSweeper,
      '[PERF-3] FAIL — ssrf.ts has no setInterval sweeper for DNS_CACHE. ' +
      'Expired cache entries (TTL 30 s positive / 5 s negative) are only pruned on access. ' +
      'Under adversarial load the Map grows without bound. ' +
      'ResponseCache in reverse-proxy.ts correctly calls setInterval(() => this.sweep(), 60_000); ' +
      '— apply the same pattern here.',
    );
  });

  it('DNS_CACHE has no maximum size limit — single Map grows forever under flood', () => {
    const src = ssrfSource();

    const hasMaxSize =
      src.includes('DNS_CACHE_MAX') ||
      /DNS_CACHE\.size\s*(>=|>|===)/.test(src);

    // THIS assertion FAILS, proving the bug.
    assert.ok(
      hasMaxSize,
      '[PERF-3] FAIL — DNS_CACHE has no maximum size enforcement. ' +
      'At 100 unique-hostname requests/second the cache grows ~2 MB/s permanently. ' +
      'Fix: add a DNS_CACHE_MAX_SIZE constant and evict the oldest (or a random) entry ' +
      'when the limit is reached, mirroring the LRU eviction in ResponseCache.set().',
    );
  });

  it('ResponseCache (reverse-proxy.ts) has the protections DNS_CACHE lacks — structural contrast', () => {
    const src = reverseProxySource();

    // Confirm the reference implementation has both safeguards.
    assert.ok(
      src.includes('setInterval') && /this\.sweep\(\)/.test(src),
      'ResponseCache must have a setInterval sweeper (regression guard)',
    );
    assert.ok(
      /this\.store\.size\s*>=\s*this\.maxSize/.test(src),
      'ResponseCache must have a maxSize eviction guard (regression guard)',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [PERF-4]  reverse-proxy.ts — response body buffered without size cap
//
// Root cause: when a cacheable upstream response arrives, all data chunks are
//   collected in a plain Buffer array:
//
//     const chunks: Buffer[] = [];
//     upstreamRes.on('data', (c: Buffer) => chunks.push(c));
//     upstreamRes.on('end', () => { const body = Buffer.concat(chunks); ... });
//
//   There is no equivalent of proxy.ts's `maxContentLength: MAX_RESPONSE_BYTES`
//   (50 MB).  A malicious or misconfigured upstream can send an arbitrarily
//   large response that is fully buffered in heap before the client or cache
//   receives it.
//
// Impact (medium — availability):
//   A single slow-drip 10 GB upstream response fully occupies a single Node.js
//   process heap until the connection closes or the process OOMs.  Unlike
//   proxy.ts, which delegates to axios with `maxContentLength`, the reverse
//   proxy has no circuit-breaker.
//
// Fix: accumulate a running byte total inside the 'data' handler and destroy
//   the upstream response + reply with 502 when the limit is exceeded:
//
//     let bytesReceived = 0;
//     upstreamRes.on('data', (c: Buffer) => {
//       bytesReceived += c.length;
//       if (bytesReceived > MAX_BODY_BYTES) {
//         upstreamRes.destroy();
//         res.writeHead(502);
//         res.end('upstream response too large');
//         return;
//       }
//       chunks.push(c);
//     });
// ══════════════════════════════════════════════════════════════════════════════

describe('[PERF-4] reverse-proxy.ts — response body buffers without size cap', () => {
  it('chunks array is accumulated with no size guard — source-level proof', () => {
    const src = reverseProxySource();

    const hasChunkAccumulation = src.includes('chunks.push');
    const hasSizeGuard =
      src.includes('MAX_RESPONSE') ||
      src.includes('MAX_BODY')     ||
      /bytesReceived\s*(>|>=)/.test(src) ||
      /chunks[\s\S]{0,60}length\s*(>|>=)/.test(src);

    assert.ok(
      hasChunkAccumulation,
      'reverse-proxy.ts must have chunk accumulation (baseline check)',
    );

    // THIS assertion FAILS, proving the bug.
    assert.ok(
      hasSizeGuard,
      '[PERF-4] FAIL — reverse-proxy.ts accumulates response chunks (chunks.push) ' +
      'without any size guard. proxy.ts caps at MAX_RESPONSE_BYTES (50 MB) via axios ' +
      'maxContentLength, but reverse-proxy.ts has no equivalent limit. ' +
      'Fix: track bytesReceived in the data handler and abort when it exceeds a cap.',
    );
  });

  it('proxy.ts has MAX_RESPONSE_BYTES but reverse-proxy.ts does not — asymmetric protection', () => {
    assert.ok(
      proxySource().includes('MAX_RESPONSE_BYTES'),
      'proxy.ts must define MAX_RESPONSE_BYTES (regression guard)',
    );
    assert.ok(
      !reverseProxySource().includes('MAX_RESPONSE_BYTES'),
      '[PERF-4] reverse-proxy.ts does not define any MAX_RESPONSE_BYTES constant — confirms the gap',
    );
  });

  it('behavioural — reverse proxy fully buffers a 2 MB response without error (demonstrates missing cap)', async () => {
    const RESPONSE_SIZE = 2 * 1024 * 1024; // 2 MB — safely under RAM, proves no cap enforced
    const UPSTREAM_PORT = 41_100;
    const PROXY_PORT    = 41_101;

    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type':   'application/octet-stream',
        'content-length': String(RESPONSE_SIZE),
        'cache-control':  'public, max-age=60',
      });
      res.end(Buffer.alloc(RESPONSE_SIZE, 0x42)); // 2 MB of 'B'
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.once('listening', resolve);
      upstream.listen(UPSTREAM_PORT);
    });

    const { server: proxyServer } = createProxy({
      port:     PROXY_PORT,
      upstream: { host: '127.0.0.1', port: UPSTREAM_PORT, protocol: 'http' },
      cache:    { ttl: 5_000, maxSize: 10 },
    });

    // Wait for proxy to be ready.
    await new Promise<void>((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.once('listening', resolve);
    });

    let receivedBytes = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PROXY_PORT, path: '/' }, (res) => {
          res.on('data', (chunk: Buffer) => { receivedBytes += chunk.length; });
          res.on('end',  resolve);
          res.on('error', reject);
        });
        req.on('error', reject);
      });

      // The proxy returned the full 2 MB without error — proving no cap.
      assert.equal(
        receivedBytes, RESPONSE_SIZE,
        `[PERF-4] reverse proxy delivered all ${RESPONSE_SIZE} bytes without a size check. ` +
        'With a larger payload this would OOM the process.',
      );

      // Re-request to confirm it was cached (shows the full body entered the cache).
      let cachedBytes = 0;
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PROXY_PORT, path: '/' }, (res) => {
          assert.equal(res.headers['x-cache'], 'HIT', 'second request must be served from cache');
          res.on('data', (c: Buffer) => { cachedBytes += c.length; });
          res.on('end',  resolve);
          res.on('error', reject);
        });
        req.on('error', reject);
      });

      assert.equal(
        cachedBytes, RESPONSE_SIZE,
        `[PERF-4] The full ${RESPONSE_SIZE}-byte body was stored in the cache with no size limit enforced.`,
      );
    } finally {
      await Promise.all([closeServer(proxyServer), closeServer(upstream)]);
    }
  });
});
