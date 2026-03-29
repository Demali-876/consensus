/**
 * Test suite for ConsensusProxy
 *
 * Covers:
 *    Basic cache MISS → HIT
 *    Micro-caching (1 s TTL)
 *    Request deduplication / concurrent coalescing
 *    Non-2xx responses are never cached
 *    URL canonicalization (param order, port, fragment, case)
 *    Semantic header canonicalization
 *    x-api-key scoping
 *    Body hashing (key-order normalisation, null/undefined parity)
 *    TTL expiry (wall-clock)
 *    x-cache-ttl request header
 *    Payment helpers (requiresPayment / markAsPaid / removePaidStatus)
 *    clearKey / getCached
 *    getStats accuracy
 *    Invalid URL rejection
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http   from 'node:http';
import ConsensusProxy from '../../features/proxy/proxy.ts';

const UPSTREAM_PORT = 19_991;
const BASE          = `http://localhost:${UPSTREAM_PORT}`;

let upstreamHits    = 0;
let nextStatus      = 200;
let responseDelayMs = 0;
let nextBodyFn: ((req: http.IncomingMessage, rawBody: string) => unknown) | null = null;

const upstream = http.createServer((req, res) => {
  upstreamHits++;
  const delaySnapshot = responseDelayMs;
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw     = Buffer.concat(chunks).toString();
    const payload = nextBodyFn
      ? nextBodyFn(req, raw)
      : { method: req.method, url: req.url, hit: upstreamHits, body: raw || undefined };
    const respond = () => {
      res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (delaySnapshot > 0) setTimeout(respond, delaySnapshot);
    else respond();
  });
});

function resetUpstream(): void {
  upstreamHits    = 0;
  nextStatus      = 200;
  responseDelayMs = 0;
  nextBodyFn      = null;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let proxy: ConsensusProxy;

function freshProxy(): ConsensusProxy {
  proxy?.destroy();
  proxy = new ConsensusProxy();
  return proxy;
}

before(() => new Promise<void>(resolve => upstream.listen(UPSTREAM_PORT, resolve)));

describe('Basic caching', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('first request is a cache MISS and reaches upstream', async () => {
    const r = await proxy.handleRequest(`${BASE}/hello`, 'GET', {}, undefined, 60);
    assert.equal(r.status,  200);
    assert.equal(r.cached,  false);
    assert.equal(upstreamHits, 1);
  });

  it('second identical request is a cache HIT — upstream not called again', async () => {
    const r = await proxy.handleRequest(`${BASE}/hello`, 'GET', {}, undefined, 60);
    assert.equal(r.status, 200);
    assert.equal(r.cached, true);
    assert.equal(upstreamHits, 1, 'upstream should NOT be called a second time');
  });

  it('different URL is an independent cache MISS', async () => {
    const r = await proxy.handleRequest(`${BASE}/world`, 'GET', {}, undefined, 60);
    assert.equal(r.cached, false);
    assert.equal(upstreamHits, 2);
  });

  it('every response carries a 64-char hex dedupe_key', async () => {
    const r = await proxy.handleRequest(`${BASE}/hello`, 'GET', {}, undefined, 60);
    assert.ok(
      typeof r.dedupe_key === 'string' && /^[0-9a-f]{64}$/.test(r.dedupe_key),
      `Expected 64-char hex key, got: ${r.dedupe_key}`,
    );
  });

  it('served_by is "proxy-direct" when no router nodes are registered', async () => {
    const r = await proxy.handleRequest(`${BASE}/hello`, 'GET', {}, undefined, 60);
    const miss = await proxy.handleRequest(`${BASE}/served-by-test`, 'GET', {}, undefined, 60);
    assert.equal(miss.served_by, 'proxy-direct');
  });
});

describe('Micro-caching — 1 s TTL', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('cache HIT within the TTL window', async () => {
    await proxy.handleRequest(`${BASE}/micro`, 'GET', {}, undefined, 1);
    const r = await proxy.handleRequest(`${BASE}/micro`, 'GET', {}, undefined, 1);
    assert.equal(r.cached, true);
    assert.equal(upstreamHits, 1);
  });

  it('cache MISS after TTL expires (≥1.1 s later)', async () => {
    await sleep(1_100);
    const r = await proxy.handleRequest(`${BASE}/micro`, 'GET', {}, undefined, 1);
    assert.equal(r.cached, false);
    assert.equal(upstreamHits, 2, 'upstream must be contacted again after TTL expiry');
  });

  it('mid-TTL request is still a HIT', async () => {
    // Fresh entry with 2 s TTL; check at ~0.5 s
    await proxy.handleRequest(`${BASE}/mid-ttl`, 'GET', {}, undefined, 2);
    await sleep(500);
    const r = await proxy.handleRequest(`${BASE}/mid-ttl`, 'GET', {}, undefined, 2);
    assert.equal(r.cached, true);
    assert.equal(upstreamHits, 3);
  });
});

describe('Request deduplication', () => {
  before(() => { resetUpstream(); freshProxy(); responseDelayMs = 80; });
  after(()  => { responseDelayMs = 0; });

  it('5 concurrent identical requests share a single upstream call', async () => {
    const url = `${BASE}/concurrent`;
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      proxy.handleRequest(url, 'GET', {}, undefined, 60),
    ));
    assert.equal(upstreamHits, 1, 'upstream should receive exactly one call');
    const first = JSON.stringify(results[0]!.data);
    for (const r of results) assert.equal(JSON.stringify(r.data), first);
  });

  it('followers are marked cached:true; only the winner is cached:false', async () => {
    const url = `${BASE}/concurrent2`;
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      proxy.handleRequest(url, 'GET', {}, undefined, 60),
    ));
    assert.equal(upstreamHits, 2, '1 new upstream call (+ 1 from previous test)');
    const cachedCount = results.filter(r => r.cached).length;
    assert.ok(cachedCount >= 3, `Expected ≥3 coalesced responses marked cached, got ${cachedCount}`);
  });

  it('after coalescing, subsequent request hits the populated cache', async () => {
    const r = await proxy.handleRequest(`${BASE}/concurrent`, 'GET', {}, undefined, 60);
    assert.equal(r.cached, true);
    assert.equal(upstreamHits, 2); 
  });
});
describe('Error responses are not cached', () => {
  before(() => { resetUpstream(); freshProxy(); });

  for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 503]) {
    it(`${status} response is never stored (two hits for two requests)`, async () => {
      nextStatus = status;
      const path = `/err${status}`;
      const r1   = await proxy.handleRequest(`${BASE}${path}`, 'GET', {}, undefined, 60);
      const r2   = await proxy.handleRequest(`${BASE}${path}`, 'GET', {}, undefined, 60);
      assert.equal(r1.status, status);
      assert.equal(r2.cached, false, `${status} should never be served from cache`);
      assert.equal(upstreamHits, 2, `Upstream must be called twice for uncached ${status}`);
      // Reset for next iteration
      upstreamHits = 0;
      nextStatus   = 200;
    });
  }
});

describe('URL canonicalization', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('query parameters in different order produce the same dedupe key', () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${BASE}/q?b=2&a=1`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${BASE}/q?a=1&b=2`, method: 'GET' });
    assert.equal(k1, k2);
  });

  it('uppercase and lowercase method strings produce the same dedupe key', () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${BASE}/m`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${BASE}/m`, method: 'get' });
    assert.equal(k1, k2);
  });

  it('default port 80 stripped from HTTP URL does not change the key', () => {
    const k1 = proxy.computeDedupeKey({ target_url: 'http://example.com:80/p', method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: 'http://example.com/p',    method: 'GET' });
    assert.equal(k1, k2);
  });

  it('default port 443 stripped from HTTPS URL does not change the key', () => {
    const k1 = proxy.computeDedupeKey({ target_url: 'https://example.com:443/p', method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: 'https://example.com/p',     method: 'GET' });
    assert.equal(k1, k2);
  });

  it('URL fragment (#hash) is stripped before hashing', () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${BASE}/frag#section-1`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${BASE}/frag#section-2`, method: 'GET' });
    assert.equal(k1, k2);
  });

  it('different paths produce different dedupe keys', () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${BASE}/path-a`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${BASE}/path-b`, method: 'GET' });
    assert.notEqual(k1, k2);
  });

  it('different query values produce different dedupe keys', () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${BASE}/q?id=1`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${BASE}/q?id=2`, method: 'GET' });
    assert.notEqual(k1, k2);
  });

  it('param-order variants resolve to the same live cache entry', async () => {
    await proxy.handleRequest(`${BASE}/canon?z=3&a=1`, 'GET', {}, undefined, 60);
    const r = await proxy.handleRequest(`${BASE}/canon?a=1&z=3`, 'GET', {}, undefined, 60);
    assert.equal(r.cached, true,  'reversed param order should HIT the same cache entry');
    assert.equal(upstreamHits, 1, 'upstream must not be called for the canonically-identical URL');
  });
});

describe('Semantic headers', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('trace / tracing headers do NOT change the dedupe key', () => {
    const base  = { target_url: `${BASE}/hdrs`, method: 'GET' };
    const k1 = proxy.computeDedupeKey({ ...base, headers: { 'X-Trace-Id': 'aaa', 'X-Request-Id': '111' } });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { 'X-Trace-Id': 'zzz', 'X-Request-Id': '999' } });
    assert.equal(k1, k2);
  });

  it('user-agent does NOT change the dedupe key', () => {
    const base = { target_url: `${BASE}/ua`, method: 'GET' };
    const k1 = proxy.computeDedupeKey({ ...base, headers: { 'user-agent': 'curl/7.0' } });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { 'user-agent': 'Mozilla/5.0' } });
    assert.equal(k1, k2);
  });

  it('accept header DOES change the dedupe key', () => {
    const base = { target_url: `${BASE}/accept`, method: 'GET' };
    const k1 = proxy.computeDedupeKey({ ...base, headers: { accept: 'application/json' } });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { accept: 'text/plain' } });
    assert.notEqual(k1, k2);
  });

  it('content-type header DOES change the dedupe key for POST', () => {
    const base = { target_url: `${BASE}/ct`, method: 'POST', body: { x: 1 } };
    const k1 = proxy.computeDedupeKey({ ...base, headers: { 'content-type': 'application/json' } });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { 'content-type': 'text/plain' } });
    assert.notEqual(k1, k2);
  });

  it('extra whitespace in accept is normalised before hashing', () => {
    const base = { target_url: `${BASE}/ws`, method: 'GET' };
    const k1 = proxy.computeDedupeKey({ ...base, headers: { accept: 'application/json' } });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { accept: 'application/json' } });
    assert.equal(k1, k2);
  });

  it('accept is treated case-insensitively as a header name', () => {
    const base = { target_url: `${BASE}/ci`, method: 'GET' };
    const k1 = proxy.computeDedupeKey({ ...base, headers: { 'Accept': 'application/json' } });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { 'accept': 'application/json' } });
    assert.equal(k1, k2);
  });
});

describe('x-api-key scoping', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('different API keys produce different dedupe keys', () => {
    const base = { target_url: `${BASE}/scoped`, method: 'GET' };
    const k1 = proxy.computeDedupeKey({ ...base, headers: { 'x-api-key': 'alice-token' } });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { 'x-api-key': 'bob-token'   } });
    assert.notEqual(k1, k2);
  });

  it('same API key always produces the same dedupe key', () => {
    const base = { target_url: `${BASE}/scoped`, method: 'GET', headers: { 'x-api-key': 'alice-token' } };
    assert.equal(proxy.computeDedupeKey(base), proxy.computeDedupeKey(base));
  });

  it('anonymous (no x-api-key) and authenticated share a "global" vs scoped namespace', () => {
    const base = { target_url: `${BASE}/scoped`, method: 'GET' };
    const k1 = proxy.computeDedupeKey({ ...base });
    const k2 = proxy.computeDedupeKey({ ...base, headers: { 'x-api-key': 'alice-token' } });
    assert.notEqual(k1, k2);
  });

  it('two different API keys each get their own cache entry', async () => {
    const url = `${BASE}/scoped-cache`;
    await proxy.handleRequest(url, 'GET', { 'x-api-key': 'alice' }, undefined, 60);
    await proxy.handleRequest(url, 'GET', { 'x-api-key': 'bob'   }, undefined, 60);
    assert.equal(upstreamHits, 2, 'each unique scope is an independent cache key');

    // Second call per key should HIT
    const ra = await proxy.handleRequest(url, 'GET', { 'x-api-key': 'alice' }, undefined, 60);
    const rb = await proxy.handleRequest(url, 'GET', { 'x-api-key': 'bob'   }, undefined, 60);
    assert.equal(ra.cached, true);
    assert.equal(rb.cached, true);
    assert.equal(upstreamHits, 2);  // no new upstream calls
  });
});

describe('Request body hashing', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('objects with keys in different order produce the same dedupe key', () => {
    const base = { target_url: `${BASE}/body`, method: 'POST' };
    const k1 = proxy.computeDedupeKey({ ...base, body: { a: 1, b: 2 } });
    const k2 = proxy.computeDedupeKey({ ...base, body: { b: 2, a: 1 } });
    assert.equal(k1, k2, 'body deep-sort should normalise key order');
  });

  it('different body values produce different dedupe keys', () => {
    const base = { target_url: `${BASE}/body`, method: 'POST' };
    const k1 = proxy.computeDedupeKey({ ...base, body: { q: 'hello' } });
    const k2 = proxy.computeDedupeKey({ ...base, body: { q: 'world' } });
    assert.notEqual(k1, k2);
  });

  it('null and undefined bodies are treated identically', () => {
    const base = { target_url: `${BASE}/body`, method: 'POST' };
    const k1 = proxy.computeDedupeKey({ ...base, body: null      });
    const k2 = proxy.computeDedupeKey({ ...base, body: undefined });
    assert.equal(k1, k2);
  });

  it('a string body that is already compact JSON equals its parsed-object equivalent', () => {
    // stableStringify({ a: 1 }) → '{"a":1}', then sha256
    // sha256('{"a":1}') is the same either way — document this intentional parity
    const base = { target_url: `${BASE}/body`, method: 'POST' };
    const k1 = proxy.computeDedupeKey({ ...base, body: '{"a":1}' });
    const k2 = proxy.computeDedupeKey({ ...base, body: { a: 1  } });
    assert.equal(k1, k2, 'compact JSON string and its parsed object hash to the same dedupe key');
  });

  it('POST with the same body gets a cache HIT on the second request', async () => {
    const body = { action: 'search', query: 'consensus' };
    await proxy.handleRequest(`${BASE}/search`, 'POST', { 'content-type': 'application/json' }, body, 60);
    const r = await proxy.handleRequest(`${BASE}/search`, 'POST', { 'content-type': 'application/json' }, body, 60);
    assert.equal(r.cached, true);
    assert.equal(upstreamHits, 1);
  });

  it('POST with a different body is an independent cache MISS', async () => {
    await proxy.handleRequest(`${BASE}/search2`, 'POST', {}, { q: 'foo' }, 60);
    const r = await proxy.handleRequest(`${BASE}/search2`, 'POST', {}, { q: 'bar' }, 60);
    assert.equal(r.cached, false);
    assert.equal(upstreamHits, 3);
  });
});

describe('x-cache-ttl header', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('TTL specified via header expires correctly', async () => {
    const hdrs = { 'x-cache-ttl': '1' };
    await proxy.handleRequest(`${BASE}/hdr-ttl`, 'GET', hdrs);
    assert.equal(upstreamHits, 1);

    const mid = await proxy.handleRequest(`${BASE}/hdr-ttl`, 'GET', hdrs);
    assert.equal(mid.cached, true);

    await sleep(1_100);
    const expired = await proxy.handleRequest(`${BASE}/hdr-ttl`, 'GET', hdrs);
    assert.equal(expired.cached, false);
    assert.equal(upstreamHits, 2);
  });

  it('cacheTTL argument overrides the x-cache-ttl header', async () => {
    await proxy.handleRequest(`${BASE}/ttl-priority`, 'GET', { 'x-cache-ttl': '1' }, undefined, 60);
    await sleep(1_100);
    const r = await proxy.handleRequest(`${BASE}/ttl-priority`, 'GET', { 'x-cache-ttl': '1' }, undefined, 60);
    assert.equal(r.cached, true, 'arg TTL of 60 s should keep the entry alive past 1.1 s');
  });
});

describe('TTL wall-clock expiry', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('entry is a MISS after its TTL has elapsed', async () => {
    await proxy.handleRequest(`${BASE}/expire`, 'GET', {}, undefined, 1);
    assert.equal(upstreamHits, 1);

    await sleep(1_150);

    const r = await proxy.handleRequest(`${BASE}/expire`, 'GET', {}, undefined, 1);
    assert.equal(r.cached, false);
    assert.equal(upstreamHits, 2);
  });
});

describe('Payment helpers', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('requiresPayment returns true for an unknown key', () => {
    assert.equal(proxy.requiresPayment('unknown-key'), true);
  });

  it('requiresPayment returns false after markAsPaid', () => {
    proxy.markAsPaid('paid-key');
    assert.equal(proxy.requiresPayment('paid-key'), false);
  });

  it('removePaidStatus re-requires payment', () => {
    proxy.removePaidStatus('paid-key');
    assert.equal(proxy.requiresPayment('paid-key'), true);
  });

  it('a cached response also satisfies requiresPayment → false', async () => {
    await proxy.handleRequest(`${BASE}/pay-cached`, 'GET', {}, undefined, 60);
    const key = proxy.computeDedupeKey({ target_url: `${BASE}/pay-cached`, method: 'GET' });
    assert.equal(proxy.requiresPayment(key), false, 'cached entry should skip payment requirement');
  });

  it('getPaymentStatus reflects all three dimensions', async () => {
    await proxy.handleRequest(`${BASE}/pay-status`, 'GET', {}, undefined, 60);
    const key    = proxy.computeDedupeKey({ target_url: `${BASE}/pay-status`, method: 'GET' });
    const status = proxy.getPaymentStatus(key);
    assert.equal(status.is_cached,        true);
    assert.equal(status.is_paid,          false);
    assert.equal(status.requires_payment, false);
  });
});

describe('clearKey', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('removes the cache entry so the next request is a MISS', async () => {
    const url = `${BASE}/clear-me`;
    await proxy.handleRequest(url, 'GET', {}, undefined, 60);
    assert.equal(upstreamHits, 1);

    const key = proxy.computeDedupeKey({ target_url: url, method: 'GET' });
    proxy.clearKey(key);

    const r = await proxy.handleRequest(url, 'GET', {}, undefined, 60);
    assert.equal(r.cached, false);
    assert.equal(upstreamHits, 2, 'upstream must be contacted after cache was cleared');
  });

  it('clearKey also removes a paid-key entry', () => {
    proxy.markAsPaid('clear-paid-key');
    assert.equal(proxy.requiresPayment('clear-paid-key'), false);
    proxy.clearKey('clear-paid-key');
    assert.equal(proxy.requiresPayment('clear-paid-key'), true);
  });
});


describe('getCached', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('returns null for a key that has never been requested', () => {
    assert.equal(proxy.getCached('no-such-key'), null);
  });

  it('returns the cached ProxyResponse after a successful request', async () => {
    const url = `${BASE}/get-cached`;
    await proxy.handleRequest(url, 'GET', {}, undefined, 60);
    const key    = proxy.computeDedupeKey({ target_url: url, method: 'GET' });
    const cached = proxy.getCached(key);
    assert.ok(cached !== null, 'getCached should return the stored response');
    assert.equal(cached!.status, 200);
    assert.ok(typeof cached!.timestamp === 'number');
  });

  it('returns null after clearKey', async () => {
    const url = `${BASE}/get-cleared`;
    await proxy.handleRequest(url, 'GET', {}, undefined, 60);
    const key = proxy.computeDedupeKey({ target_url: url, method: 'GET' });
    proxy.clearKey(key);
    assert.equal(proxy.getCached(key), null);
  });
});

describe('getStats', () => {
  before(() => { resetUpstream(); freshProxy(); });

  it('tracks total_requests, cache_hits, cache_misses, hit_rate, and cache_size', async () => {
    // MISS, HIT, MISS, HIT, HIT  →  total=5, hits=3, misses=2, rate=0.6
    await proxy.handleRequest(`${BASE}/s1`, 'GET', {}, undefined, 60);   // MISS
    await proxy.handleRequest(`${BASE}/s1`, 'GET', {}, undefined, 60);   // HIT
    await proxy.handleRequest(`${BASE}/s2`, 'GET', {}, undefined, 60);   // MISS
    await proxy.handleRequest(`${BASE}/s1`, 'GET', {}, undefined, 60);   // HIT
    await proxy.handleRequest(`${BASE}/s2`, 'GET', {}, undefined, 60);   // HIT

    const s = proxy.getStats();
    assert.equal(s.total_requests, 5);
    assert.equal(s.cache_hits,     3);
    assert.equal(s.cache_misses,   2);
    assert.ok(
      Math.abs(s.hit_rate - 0.6) < 0.001,
      `Expected hit_rate ≈ 0.6, got ${s.hit_rate}`,
    );
    assert.equal(s.cache_size, 2, 'Two distinct URLs → two cache entries');
    assert.equal(s.pending_requests, 0, 'No in-flight requests after all awaits settle');
  });

  it('hit_rate is 0 on a fresh proxy with no requests', () => {
    const p = new ConsensusProxy();
    assert.equal(p.getStats().hit_rate, 0);
    p.destroy();
  });
});

describe('Input validation', () => {
  before(() => freshProxy());

  it('throws TypeError for a non-URL target_url', async () => {
    await assert.rejects(
      () => proxy.handleRequest('not-a-url', 'GET'),
      (e: unknown) =>
        e instanceof TypeError && (e as TypeError).message.includes('Invalid target_url'),
    );
  });

  it('throws TypeError for an empty target_url', async () => {
    await assert.rejects(
      () => proxy.handleRequest('', 'GET'),
      TypeError,
    );
  });

  it('computeDedupeKey is deterministic across repeated calls', () => {
    const params = { target_url: `${BASE}/deterministic`, method: 'POST', body: { x: 42 } };
    const keys   = Array.from({ length: 10 }, () => proxy.computeDedupeKey(params));
    assert.ok(new Set(keys).size === 1, 'All 10 calls must produce the same key');
  });
});

after(() => {
  proxy?.destroy();
  return new Promise<void>(resolve => upstream.close(() => resolve()));
});
