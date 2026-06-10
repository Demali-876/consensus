/**
 * Pen test for ConsensusProxy deduplication.
 *
 * Run from the repo root:
 *
 *   bun server/utils/tests/proxy-dedupe.test.ts
 *
 * What this verifies (module-level, no real network):
 *
 *   1. Dedupe key is stable across non-semantic header changes (User-Agent)
 *      and distinct across body / method / x-api-key scope.
 *   2. In-flight coalescing — N concurrent requests for the same key hit
 *      upstream exactly once and all receive the same response. This is the
 *      regression test for the `pendingRequests` write that was missing.
 *   3. Post-completion cache — follow-ups within TTL serve from cache and do
 *      NOT touch upstream.
 *   4. Different dedupe keys do NOT collapse — each gets its own upstream call.
 *   5. Different x-api-key scopes do NOT cross-pollute even with the same URL.
 *   6. Upstream failures (non-2xx) are NOT cached and do NOT poison subsequent
 *      attempts with that key.
 *   7. Concurrent requests across MANY distinct keys still get correct
 *      one-upstream-per-key behaviour under load.
 *
 * How we avoid real network:
 *   - axios.defaults.adapter is replaced with a counting mock that returns a
 *     synthetic response. No socket ever opens.
 *   - The SSRF guard runs against example.com (public, resolves) so we don't
 *     have to patch the guard.
 *   - Router is stubbed to always return `null` — handleRequest falls through
 *     to executeDirect, which goes through axios and lands in our mock.
 */

import axios from 'axios';
import { strict as assert } from 'node:assert';
import ConsensusProxy from '../../features/proxy/proxy.ts';

// ─── Quiet the proxy's chatty console.log so test output stays readable ──────
const originalLog = console.log;
console.log = () => {};

// ─── Axios mock: counts calls per request path, returns synthetic 2xx ────────
type CallRecord = { path: string; method: string; host: string; at: number };
const calls: CallRecord[] = [];
const callsByPath = new Map<string, number>();

let mode: 'ok' | 'fail' = 'ok';

axios.defaults.adapter = async (config) => {
  // The proxy rewrites the URL host to the resolved IP and puts the original
  // hostname in the Host header. We key on path so different "logical" URLs
  // are distinguishable even though they all share the same resolved IP.
  const u = new URL(config.url ?? '', 'http://placeholder');
  const path = u.pathname + u.search;
  calls.push({
    path,
    method: String(config.method ?? 'get').toUpperCase(),
    host:   String((config.headers ?? {})['host'] ?? u.host),
    at:     Date.now(),
  });
  callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);

  // Small artificial latency so concurrent requests genuinely overlap and
  // exercise the in-flight pending-requests map. Without this the first call
  // would resolve before the second one even enters handleRequest.
  await new Promise((r) => setTimeout(r, 25));

  if (mode === 'fail') {
    return {
      data:       Buffer.from('upstream down'),
      status:     503,
      statusText: 'Service Unavailable',
      headers:    { 'content-type': 'text/plain' },
      config,
      request:    {},
    } as any;
  }

  const body = JSON.stringify({ echo: path, at: Date.now() });
  return {
    data:       Buffer.from(body),
    status:     200,
    statusText: 'OK',
    headers:    { 'content-type': 'application/json' },
    config,
    request:    {},
  } as any;
};

// ─── Router stub: never returns a node so handleRequest takes executeDirect ──
const routerStub = {
  selectNode:        () => null,
  incrementRequest:  () => {},
  decrementRequest:  () => {},
  incrementSession:  () => {},
  decrementSession:  () => {},
  getStats:          () => ({}),
} as any;

const proxy = new ConsensusProxy({ router: routerStub });

// ─── Helpers ─────────────────────────────────────────────────────────────────
const TARGET_BASE = 'http://example.com';

function resetCounters(): void {
  calls.length = 0;
  callsByPath.clear();
}

async function callProxy(
  pathAndQuery: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: any,
): Promise<any> {
  return proxy.handleRequest(`${TARGET_BASE}${pathAndQuery}`, method, headers, body);
}

function fmtPass(label: string): void {
  originalLog(`  \x1b[32m✓\x1b[0m ${label}`);
}

function header(label: string): void {
  originalLog(`\n  \x1b[1m${label}\x1b[0m`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let failures = 0;
async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    fmtPass(name);
  } catch (err) {
    failures++;
    originalLog(`  \x1b[31m✗ ${name}\x1b[0m`);
    originalLog(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  originalLog('\n  ConsensusProxy dedupe pen test\n');

  // ─── 1. Dedupe-key stability ──────────────────────────────────────────────
  header('1. Dedupe key');

  await run('same URL+method+body → same key', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'GET' });
    assert.equal(k1, k2);
  });

  await run('non-semantic header (user-agent) does NOT change the key', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'GET', headers: { 'user-agent': 'A' } });
    const k2 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'GET', headers: { 'user-agent': 'B' } });
    assert.equal(k1, k2);
  });

  await run('different method → different key', async () => {
    const g = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'GET' });
    const p = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'POST' });
    assert.notEqual(g, p);
  });

  await run('different x-api-key → different scope → different key', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'GET', headers: { 'x-api-key': 'tenant1' } });
    const k2 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'GET', headers: { 'x-api-key': 'tenant2' } });
    assert.notEqual(k1, k2);
  });

  await run('different body → different key', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'POST', body: { x: 1 } });
    const k2 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/a`, method: 'POST', body: { x: 2 } });
    assert.notEqual(k1, k2);
  });

  // ─── 2. In-flight coalescing (regression test for the recent server fix) ──
  header('2. In-flight coalescing');

  await run('50 concurrent requests for one URL → 1 upstream call', async () => {
    resetCounters();
    proxy.clearKey(proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/burst`, method: 'GET' }));
    const results = await Promise.all(
      Array.from({ length: 50 }, () => callProxy('/burst')),
    );
    assert.equal(results.length, 50);
    assert.equal(callsByPath.get('/burst') ?? 0, 1,
      `expected 1 upstream call, got ${callsByPath.get('/burst') ?? 0}`);
    // All responses should describe the same upstream call
    const first = JSON.stringify(results[0].data);
    for (const r of results) {
      assert.equal(JSON.stringify(r.data), first, 'concurrent callers got divergent responses');
    }
  });

  // ─── 3. Post-completion cache ─────────────────────────────────────────────
  header('3. Post-completion cache');

  await run('10 follow-up requests for same URL → 0 new upstream calls', async () => {
    resetCounters();
    proxy.clearKey(proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/cached`, method: 'GET' }));
    await callProxy('/cached');                      // 1 upstream call (miss)
    for (let i = 0; i < 10; i++) await callProxy('/cached'); // 10 cache hits
    assert.equal(callsByPath.get('/cached') ?? 0, 1,
      `expected 1 upstream call total, got ${callsByPath.get('/cached') ?? 0}`);
  });

  // ─── 4. Cross-key independence ────────────────────────────────────────────
  header('4. Cross-key independence');

  await run('different paths each get one upstream call (no cross-collapse)', async () => {
    resetCounters();
    for (const p of ['/x', '/y', '/z']) {
      proxy.clearKey(proxy.computeDedupeKey({ target_url: `${TARGET_BASE}${p}`, method: 'GET' }));
    }
    await Promise.all([
      callProxy('/x'), callProxy('/y'), callProxy('/z'),
      callProxy('/x'), callProxy('/y'), callProxy('/z'),  // duplicates within each → coalesce
    ]);
    assert.equal(callsByPath.get('/x'), 1);
    assert.equal(callsByPath.get('/y'), 1);
    assert.equal(callsByPath.get('/z'), 1);
  });

  await run('different x-api-key scopes do NOT cross-pollute', async () => {
    resetCounters();
    const k0 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/scoped`, method: 'GET' });
    const kA = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/scoped`, method: 'GET', headers: { 'x-api-key': 'A' } });
    const kB = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/scoped`, method: 'GET', headers: { 'x-api-key': 'B' } });
    proxy.clearKey(k0); proxy.clearKey(kA); proxy.clearKey(kB);
    await Promise.all([
      callProxy('/scoped'),
      callProxy('/scoped', { 'x-api-key': 'A' }),
      callProxy('/scoped', { 'x-api-key': 'B' }),
    ]);
    assert.equal(callsByPath.get('/scoped'), 3,
      `expected 3 upstream calls (one per scope), got ${callsByPath.get('/scoped')}`);
  });

  // ─── 5. Failure isolation ─────────────────────────────────────────────────
  header('5. Failure handling');

  await run('upstream 5xx is not cached — next call refetches', async () => {
    resetCounters();
    proxy.clearKey(proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/flaky`, method: 'GET' }));
    mode = 'fail';
    const failed = await Promise.all([callProxy('/flaky'), callProxy('/flaky')]);
    assert.equal(callsByPath.get('/flaky'), 1, 'in-flight dedupe should apply even on failure');
    assert.equal(failed[0].status, 503);

    mode = 'ok';
    await callProxy('/flaky');
    assert.equal(callsByPath.get('/flaky'), 2, 'failed response should NOT have been cached');
  });

  // ─── 6. Body hash canonicalization ────────────────────────────────────────
  header('6. Body hashing');

  await run('object body — key order does NOT change the dedupe key', async () => {
    const k1 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST',
      body: { a: 1, b: 2, c: 3 },
    });
    const k2 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST',
      body: { c: 3, a: 1, b: 2 },
    });
    assert.equal(k1, k2);
  });

  await run('nested object — key order at every depth does NOT change the key', async () => {
    const k1 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST',
      body: { outer: { x: 1, y: 2 }, list: [{ a: 1, b: 2 }, { c: 3 }] },
    });
    const k2 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST',
      body: { list: [{ b: 2, a: 1 }, { c: 3 }], outer: { y: 2, x: 1 } },
    });
    assert.equal(k1, k2);
  });

  await run('array order DOES change the key (arrays are semantic)', async () => {
    const k1 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST', body: [1, 2, 3],
    });
    const k2 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST', body: [3, 2, 1],
    });
    assert.notEqual(k1, k2);
  });

  await run('null vs missing body → same key (both empty bodies)', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/body`, method: 'POST', body: null });
    const k2 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/body`, method: 'POST' });
    assert.equal(k1, k2);
  });

  await run('object body and equivalent JSON string body → same key', async () => {
    const k1 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST', body: { x: 1 },
    });
    const k2 = proxy.computeDedupeKey({
      target_url: `${TARGET_BASE}/body`, method: 'POST', body: '{"x":1}',
    });
    assert.equal(k1, k2);
  });

  // ─── 7. URL canonicalization ──────────────────────────────────────────────
  header('7. URL canonicalization');

  await run('query param order does NOT change the key', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/q?a=1&b=2`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/q?b=2&a=1`, method: 'GET' });
    assert.equal(k1, k2);
  });

  await run('URL fragment is dropped — same key with/without #frag', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/q#section`, method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/q`,         method: 'GET' });
    assert.equal(k1, k2);
  });

  await run('hostname case is normalised', async () => {
    const k1 = proxy.computeDedupeKey({ target_url: 'http://EXAMPLE.com/path',  method: 'GET' });
    const k2 = proxy.computeDedupeKey({ target_url: 'http://example.com/path',  method: 'GET' });
    assert.equal(k1, k2);
  });

  // ─── 8. TTL expiry ────────────────────────────────────────────────────────
  header('8. TTL expiry');

  await run('cache entry expires after x-cache-ttl seconds', async () => {
    resetCounters();
    const key = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/short`, method: 'GET', headers: { 'x-cache-ttl': '1' } });
    proxy.clearKey(key);
    await callProxy('/short', { 'x-cache-ttl': '1' });
    await callProxy('/short', { 'x-cache-ttl': '1' });   // still inside 1s window
    assert.equal(callsByPath.get('/short') ?? 0, 1, 'second call inside TTL should hit cache');
    await new Promise((r) => setTimeout(r, 1_200));      // wait past TTL
    await callProxy('/short', { 'x-cache-ttl': '1' });
    assert.equal(callsByPath.get('/short') ?? 0, 2, 'call after TTL expiry should re-fetch');
  });

  await run('TTL is clamped to a minimum of 1s when 0 is requested', async () => {
    resetCounters();
    const key = proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/zeroTtl`, method: 'GET', headers: { 'x-cache-ttl': '0' } });
    proxy.clearKey(key);
    await callProxy('/zeroTtl', { 'x-cache-ttl': '0' });
    await callProxy('/zeroTtl', { 'x-cache-ttl': '0' }); // immediately after, still cached
    assert.equal(callsByPath.get('/zeroTtl') ?? 0, 1, '0 should be clamped to 1s minimum, not "no cache"');
  });

  // ─── 9. Load / fan-out ────────────────────────────────────────────────────
  header('9. Load fan-out');

  await run('100 concurrent requests across 10 keys → exactly 10 upstream calls', async () => {
    resetCounters();
    for (let i = 0; i < 10; i++) {
      proxy.clearKey(proxy.computeDedupeKey({ target_url: `${TARGET_BASE}/load/${i}`, method: 'GET' }));
    }
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      work.push(callProxy(`/load/${i % 10}`));
    }
    await Promise.all(work);
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const n = callsByPath.get(`/load/${i}`) ?? 0;
      assert.equal(n, 1, `key /load/${i} got ${n} upstream calls (expected 1)`);
      total += n;
    }
    assert.equal(total, 10, `expected 10 total upstream calls, got ${total}`);
  });

  // ─── Done ─────────────────────────────────────────────────────────────────
  console.log = originalLog;
  proxy.destroy();

  if (failures > 0) {
    originalLog(`\n  ${failures} test(s) failed\n`);
    process.exit(1);
  } else {
    originalLog('\n  all dedupe behaviour checks passed.\n');
    process.exit(0);
  }
}

void main().catch((err) => {
  console.log = originalLog;
  originalLog(`\n  fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
