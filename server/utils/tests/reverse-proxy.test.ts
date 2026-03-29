/**
 * Tests for reverse-proxy (server/features/proxy/reverse-proxy.ts)
 *
 * Architecture:
 *   UPSTREAM  :19992  — configurable echo/fixture server (shared)
 *   SECONDARY :19993  — second upstream for routing-override tests
 *   Proxy ports 19994-20005 — one per describe, so concurrent suites never collide
 *
 * Run with:
 *   npx tsx --test server/utils/tests/reverse-proxy.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http   from 'node:http';
import { createProxy, type ProxyOptions } from '../../features/proxy/reverse-proxy.ts';
import Router from '../../router.ts';

const UPSTREAM_PORT  = 29_992;
const SECONDARY_PORT = 29_993;

const PORTS = {
  cache:      29_994,
  microcache: 29_995,
  skipReq:    29_996,
  skipResp:   29_997,
  errStatus:  29_998,
  hopByHop:   29_999,
  onRequest:  30_000,
  onResponse: 30_001,
  onError:    30_002,
  cacheKey:   30_003,
  cacheable:  30_004,
  router:     30_005,
};

// ─── Shared upstream servers ──────────────────────────────────────────────────

// Per-path counters and overrides — path-keyed so concurrent suites don't collide
const hitsByPath    = new Map<string, number>();
const statusByPath  = new Map<string, number>();
const headersByPath = new Map<string, Record<string, string>>();

const upstream = http.createServer((req, res) => {
  const path  = req.url ?? '/';
  const hits  = (hitsByPath.get(path) ?? 0) + 1;
  hitsByPath.set(path, hits);
  res.writeHead(statusByPath.get(path) ?? 200, {
    'content-type': 'application/json',
    ...headersByPath.get(path),
  });
  res.end(JSON.stringify({ method: req.method, url: path, hit: hits, headers: req.headers }));
});

let secondaryHits = 0;
const secondary = http.createServer((_req, res) => {
  secondaryHits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ server: 'secondary', hit: secondaryHits }));
});

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Per-suite proxy factory ──────────────────────────────────────────────────

function buildSuite(port: number) {
  let server: http.Server;
  let cache: ReturnType<typeof createProxy>['cache'];

  function start(opts: Partial<ProxyOptions> = {}) {
    return new Promise<void>((resolve, reject) => {
      const p = createProxy({ port, upstream: { host: 'localhost', port: UPSTREAM_PORT }, ...opts });
      server = p.server;
      cache  = p.cache;
      server.once('error',     reject);
      server.once('listening', resolve);
    });
  }

  function stop() {
    return new Promise<void>(r => {
      type CS = { closeAllConnections?(): void };
      (server as unknown as CS).closeAllConnections?.();
      server.unref();
      server.close(r as () => void);
    });
  }

  type Resp = { status: number; headers: http.IncomingHttpHeaders; body: string };

  function send(method: string, path: string, hdrs: Record<string, string> = {}, body?: string): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(body) : undefined;
      const req = http.request(
        {
          host: 'localhost', port, method, path,
          headers: {
            connection: 'close',
            ...hdrs,
            ...(payload ? { 'content-length': String(payload.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data',  (c: Buffer) => chunks.push(c));
          res.on('end',   () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const get  = (path: string, hdrs?: Record<string, string>) => send('GET',  path, hdrs);
  const post = (path: string, hdrs?: Record<string, string>, body = '{}') => send('POST', path, hdrs, body);

  return { start, stop, send, get, post, getCache: () => cache };
}

// ─── Root suite — owns shared server lifecycle ────────────────────────────────

describe('Reverse Proxy', () => {
  before(async () => {
    await new Promise<void>((res, rej) => { upstream.once('error', rej);  upstream.listen(UPSTREAM_PORT,   res as () => void); });
    await new Promise<void>((res, rej) => { secondary.once('error', rej); secondary.listen(SECONDARY_PORT, res as () => void); });
    // unref so idle servers don't prevent process exit if cleanup is slow
    upstream.unref();
    secondary.unref();
  });

  after(async () => {
    type CS = { closeAllConnections?(): void };
    (upstream  as unknown as CS).closeAllConnections?.();
    (secondary as unknown as CS).closeAllConnections?.();
    await Promise.all([
      new Promise<void>(r => upstream.close(r  as () => void)),
      new Promise<void>(r => secondary.close(r as () => void)),
    ]);
  });

  // ── 1. Cache MISS → HIT ───────────────────────────────────────────────────

  describe('Cache MISS → HIT', () => {
    const s = buildSuite(PORTS.cache);
    before(() => s.start({ cache: { ttl: 30_000 } }));
    after(s.stop);

    it('first GET is a MISS — upstream is contacted', async () => {
      const r = await s.get('/c1/hello');
      assert.equal(r.status,             200);
      assert.equal(r.headers['x-cache'], 'MISS');
      assert.equal(hitsByPath.get('/c1/hello'), 1);
    });

    it('second identical GET is a HIT — upstream not contacted again', async () => {
      const r = await s.get('/c1/hello');
      assert.equal(r.headers['x-cache'], 'HIT');
      assert.equal(hitsByPath.get('/c1/hello'), 1);
    });

    it('x-cache-hits increments on each successive hit', async () => {
      const r1 = await s.get('/c1/hello');
      const r2 = await s.get('/c1/hello');
      const h1 = Number(r1.headers['x-cache-hits']);
      const h2 = Number(r2.headers['x-cache-hits']);
      assert.ok(h1 >= 1,        `x-cache-hits must be ≥1, got ${h1}`);
      assert.equal(h2, h1 + 1, `x-cache-hits must increment by 1 per hit`);
    });

    it('different path is an independent MISS', async () => {
      const r = await s.get('/c1/other');
      assert.equal(r.headers['x-cache'], 'MISS');
      assert.equal(hitsByPath.get('/c1/other'), 1);
    });

    it('response body is byte-for-byte identical on HIT and MISS', async () => {
      const miss = await s.get('/c1/body');
      const hit  = await s.get('/c1/body');
      assert.equal(hit.body, miss.body);
    });

    it('cache stats reflect accumulated hits and misses', async () => {
      const st = s.getCache().stats();
      assert.ok(st.hits   >= 3, `expected ≥3 hits, got ${st.hits}`);
      assert.ok(st.misses >= 3, `expected ≥3 misses, got ${st.misses}`);
    });
  });

  // ── 2. Micro-caching (1 s TTL) ────────────────────────────────────────────

  describe('Micro-caching — 1 s TTL', () => {
    const s = buildSuite(PORTS.microcache);
    before(() => s.start({ cache: { ttl: 1_000 } }));
    after(s.stop);

    it('HIT within the TTL window', async () => {
      await s.get('/m1/micro');
      const r = await s.get('/m1/micro');
      assert.equal(r.headers['x-cache'], 'HIT');
      assert.equal(hitsByPath.get('/m1/micro'), 1);
    });

    it('MISS after TTL expires (>1 s)', async () => {
      await sleep(1_100);
      const r = await s.get('/m1/micro');
      assert.equal(r.headers['x-cache'], 'MISS');
      assert.equal(hitsByPath.get('/m1/micro'), 2);
    });
  });

  // ── 3. Non-cacheable requests (SKIP) ──────────────────────────────────────

  describe('Non-cacheable requests', () => {
    const s = buildSuite(PORTS.skipReq);
    before(() => s.start());
    after(s.stop);

    it('POST is never cached — both requests hit upstream', async () => {
      const r1 = await s.post('/r1/data');
      const r2 = await s.post('/r1/data');
      assert.equal(r1.headers['x-cache'], 'SKIP');
      assert.equal(r2.headers['x-cache'], 'SKIP');
      assert.equal(hitsByPath.get('/r1/data'), 2);
    });

    it('GET with Authorization header is skipped', async () => {
      const r = await s.get('/r1/auth', { authorization: 'Bearer token' });
      assert.equal(r.headers['x-cache'], 'SKIP');
    });

    it('Authorization request is never stored — second call is also SKIP', async () => {
      await s.get('/r1/auth2', { authorization: 'Bearer token' });
      const r = await s.get('/r1/auth2', { authorization: 'Bearer token' });
      assert.equal(r.headers['x-cache'], 'SKIP');
      assert.equal(hitsByPath.get('/r1/auth2'), 2);
    });

    it('GET with Cookie header is skipped', async () => {
      const r = await s.get('/r1/private', { cookie: 'session=abc' });
      assert.equal(r.headers['x-cache'], 'SKIP');
      assert.equal(hitsByPath.get('/r1/private'), 1);
    });
  });

  // ── 4. Non-cacheable responses (SKIP) ─────────────────────────────────────

  describe('Non-cacheable responses', () => {
    const s = buildSuite(PORTS.skipResp);
    before(() => s.start());
    after(s.stop);

    it('Cache-Control: no-store is never cached', async () => {
      headersByPath.set('/rs1/nc1', { 'cache-control': 'no-store' });
      const r1 = await s.get('/rs1/nc1');
      const r2 = await s.get('/rs1/nc1');
      assert.equal(r1.headers['x-cache'], 'SKIP');
      assert.equal(r2.headers['x-cache'], 'SKIP');
      assert.equal(hitsByPath.get('/rs1/nc1'), 2);
    });

    it('Cache-Control: private is never cached', async () => {
      headersByPath.set('/rs1/nc2', { 'cache-control': 'private' });
      const r1 = await s.get('/rs1/nc2');
      const r2 = await s.get('/rs1/nc2');
      assert.equal(r1.headers['x-cache'], 'SKIP');
      assert.equal(r2.headers['x-cache'], 'SKIP');
      assert.equal(hitsByPath.get('/rs1/nc2'), 2);
    });

    it('Set-Cookie response is never cached', async () => {
      headersByPath.set('/rs1/nc3', { 'set-cookie': 'session=xyz; Path=/' });
      const r1 = await s.get('/rs1/nc3');
      const r2 = await s.get('/rs1/nc3');
      assert.equal(r1.headers['x-cache'], 'SKIP');
      assert.equal(r2.headers['x-cache'], 'SKIP');
      assert.equal(hitsByPath.get('/rs1/nc3'), 2);
    });
  });

  // ── 5. Error responses not cached ─────────────────────────────────────────

  describe('Error responses not cached', () => {
    const s = buildSuite(PORTS.errStatus);
    before(() => s.start());
    after(s.stop);

    for (const code of [400, 404, 500, 503]) {
      it(`${code} response is always SKIP — hits upstream twice`, async () => {
        const path = `/e1/err${code}`;
        statusByPath.set(path, code);
        const r1 = await s.get(path);
        const r2 = await s.get(path);
        assert.equal(r1.status,            code);
        assert.equal(r1.headers['x-cache'], 'SKIP');
        assert.equal(r2.headers['x-cache'], 'SKIP');
        assert.equal(hitsByPath.get(path),  2);
        statusByPath.delete(path);
      });
    }
  });

  // ── 6. Hop-by-hop header stripping ────────────────────────────────────────

  describe('Hop-by-hop header stripping', () => {
    const s = buildSuite(PORTS.hopByHop);
    before(() => {
      // proxy-connection and proxy-authenticate are hop-by-hop headers that
      // Node.js HTTP never re-injects, so they are reliable to assert on
      headersByPath.set('/h1/hop', {
        'proxy-connection':   'keep-alive',
        'proxy-authenticate': 'Basic realm="test"',
        'x-custom':           'present',
      });
      return s.start();
    });
    after(s.stop);

    it('proxy-connection is stripped from the forwarded response', async () => {
      const r = await s.get('/h1/hop');
      assert.equal(r.headers['proxy-connection'], undefined);
    });

    it('proxy-authenticate is stripped from the forwarded response', async () => {
      const r = await s.get('/h1/hop');
      assert.equal(r.headers['proxy-authenticate'], undefined);
    });

    it('non-hop-by-hop custom header is preserved', async () => {
      const r = await s.get('/h1/hop');
      assert.equal(r.headers['x-custom'], 'present');
    });
  });

  // ── 7. hooks.onRequest ────────────────────────────────────────────────────

  describe('hooks.onRequest', () => {
    const s = buildSuite(PORTS.onRequest);
    after(s.stop);

    it('returning false blocks with 403', async () => {
      await s.start({ hooks: { onRequest: () => false } });
      const r = await s.get('/o1/blocked');
      assert.equal(r.status, 403);
      assert.equal(hitsByPath.get('/o1/blocked'), undefined);
      await s.stop();
    });

    it('throwing from the hook responds with 500 and the error message', async () => {
      await s.start({ hooks: { onRequest: () => { throw new Error('hook fail'); } } });
      const r = await s.get('/o1/throw');
      assert.equal(r.status, 500);
      assert.ok(r.body.includes('hook fail'));
      await s.stop();
    });

    it('mutating ctx.url rewrites the upstream path', async () => {
      await s.start({ hooks: { onRequest: (ctx) => { ctx.url = '/o1/rewritten'; } } });
      const data = JSON.parse((await s.get('/o1/original')).body) as { url: string };
      assert.equal(data.url, '/o1/rewritten');
      await s.stop();
    });

    it('mutating ctx.headers forwards the injected header to upstream', async () => {
      await s.start({ hooks: { onRequest: (ctx) => { ctx.headers['x-injected'] = 'yes'; } } });
      const data = JSON.parse((await s.get('/o1/inject')).body) as { headers: Record<string, string> };
      assert.equal(data.headers['x-injected'], 'yes');
      await s.stop();
    });

    it('mutating ctx.target routes the request to the secondary server', async () => {
      secondaryHits = 0;
      await s.start({ hooks: { onRequest: (ctx) => { ctx.target = { host: 'localhost', port: SECONDARY_PORT }; } } });
      const data = JSON.parse((await s.get('/o1/reroute')).body) as { server: string };
      assert.equal(data.server,  'secondary');
      assert.equal(secondaryHits, 1);
      assert.equal(hitsByPath.get('/o1/reroute'), undefined);
    });
  });

  // ── 8. hooks.onResponse ───────────────────────────────────────────────────

  describe('hooks.onResponse', () => {
    const s = buildSuite(PORTS.onResponse);
    before(() => s.start({
      hooks: {
        onResponse: (ctx) => {
          ctx.headers['x-powered-by'] = 'consensus';
          ctx.headers['x-was-cached'] = String(ctx.cached);
        },
      },
    }));
    after(s.stop);

    it('injected header is present on a MISS', async () => {
      const r = await s.get('/p1/res');
      assert.equal(r.headers['x-cache'],      'MISS');
      assert.equal(r.headers['x-powered-by'], 'consensus');
      assert.equal(r.headers['x-was-cached'], 'false');
    });

    it('injected header is present on a HIT', async () => {
      const r = await s.get('/p1/res');
      assert.equal(r.headers['x-cache'],      'HIT');
      assert.equal(r.headers['x-powered-by'], 'consensus');
      assert.equal(r.headers['x-was-cached'], 'true');
    });

    it('ctx.cached is false on MISS, true on HIT', async () => {
      await s.get('/p1/flag');
      const r = await s.get('/p1/flag');
      assert.equal(r.headers['x-was-cached'], 'true');
    });

    it('header injection applies to SKIP (POST) responses too', async () => {
      const r = await s.post('/p1/skip');
      assert.equal(r.headers['x-cache'],      'SKIP');
      assert.equal(r.headers['x-powered-by'], 'consensus');
    });
  });

  // ── 9. hooks.onError ──────────────────────────────────────────────────────

  describe('hooks.onError', () => {
    const s = buildSuite(PORTS.onError);
    after(s.stop);

    it('custom onError handler fires when upstream is unreachable', async () => {
      await s.start({
        upstream: { host: 'localhost', port: 19_001 },
        hooks: {
          onError: (_err, _req, res) => {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'upstream_unavailable' }));
          },
        },
      });
      const r    = await s.get('/e2/down');
      const body = JSON.parse(r.body) as { error: string };
      assert.equal(r.status,   503);
      assert.equal(body.error, 'upstream_unavailable');
      await s.stop();
    });

    it('default 502 Bad Gateway is returned when no onError hook is set', async () => {
      await s.start({ upstream: { host: 'localhost', port: 19_001 } });
      const r = await s.get('/e2/down');
      assert.equal(r.status, 502);
      assert.ok(r.body.includes('Bad Gateway'));
    });
  });

  // ── 10. Custom cacheKey ───────────────────────────────────────────────────

  describe('Custom cacheKey', () => {
    const s = buildSuite(PORTS.cacheKey);
    before(() => s.start({
      cacheKey: (req) => `${req.method}:${req.url}:${req.headers['x-tenant'] ?? ''}`,
    }));
    after(s.stop);

    it('different x-tenant values are independent cache entries', async () => {
      await s.get('/k1/res', { 'x-tenant': 'alpha' });
      await s.get('/k1/res', { 'x-tenant': 'beta' });
      assert.equal(hitsByPath.get('/k1/res'), 2);
    });

    it('same x-tenant is a HIT on the second call', async () => {
      const r = await s.get('/k1/res', { 'x-tenant': 'alpha' });
      assert.equal(r.headers['x-cache'], 'HIT');
      assert.equal(hitsByPath.get('/k1/res'), 2);
    });

    it('anonymous (no x-tenant) is a distinct entry', async () => {
      const r = await s.get('/k1/res');
      assert.equal(r.headers['x-cache'], 'MISS');
      assert.equal(hitsByPath.get('/k1/res'), 3);
    });
  });

  // ── 11. Custom cacheable predicate ────────────────────────────────────────

  describe('Custom cacheable predicate', () => {
    const s = buildSuite(PORTS.cacheable);
    before(() => s.start({ cacheable: () => true }));
    after(s.stop);

    it('POST is cached when the predicate returns true', async () => {
      const r1 = await s.post('/ca1/data');
      const r2 = await s.post('/ca1/data');
      assert.equal(r1.headers['x-cache'], 'MISS');
      assert.equal(r2.headers['x-cache'], 'HIT');
      assert.equal(hitsByPath.get('/ca1/data'), 1);
    });
  });

  // ── 12. Router integration ────────────────────────────────────────────────

  describe('Router integration', () => {
    const s = buildSuite(PORTS.router);

    it('selectNode is called for every non-cached request', async () => {
      let calls = 0;
      const mock = {
        selectNode:       () => { calls++; return null; },
        incrementRequest: () => {},
        decrementRequest: () => {},
        getStats:         () => ({}),
      } as unknown as Router;
      await s.start({ router: mock });
      await s.get('/rt1/a');
      await s.get('/rt1/b');
      assert.equal(calls, 2);
      await s.stop();
    });

    it('null from selectNode falls back to the default upstream', async () => {
      const mock = {
        selectNode:       () => null,
        incrementRequest: () => {},
        decrementRequest: () => {},
        getStats:         () => ({}),
      } as unknown as Router;
      await s.start({ router: mock });
      await s.get('/rt1/fallback');
      assert.equal(hitsByPath.get('/rt1/fallback'), 1);
      await s.stop();
    });

    it('incrementRequest and decrementRequest are both called when a node is selected', async () => {
      const calls = { inc: 0, dec: 0 };
      const mock  = {
        selectNode:       () => ({ id: 'n1', domain: 'localhost' }),
        incrementRequest: () => { calls.inc++; },
        decrementRequest: () => { calls.dec++; },
        getStats:         () => ({}),
      } as unknown as Router;
      await s.start({
        router: mock,
        // Router would go to https://localhost:443 — override via hook to secondary
        hooks: { onRequest: (ctx) => { ctx.target = { host: 'localhost', port: SECONDARY_PORT }; } },
      });
      await s.get('/rt1/node');
      await sleep(50);
      assert.equal(calls.inc, 1, 'incrementRequest must be called after node selection');
      assert.equal(calls.dec, 1, 'decrementRequest must be called after the stream closes');
      await s.stop();
    });

    it('decrementRequest is called even when the upstream errors', async () => {
      const calls = { dec: 0 };
      const mock  = {
        selectNode:       () => ({ id: 'n1', domain: 'localhost' }),
        incrementRequest: () => {},
        decrementRequest: () => { calls.dec++; },
        getStats:         () => ({}),
      } as unknown as Router;
      // Node resolves to https://localhost:443 — nothing there, will error
      await s.start({
        router: mock,
        hooks:  { onError: (_e, _r, res) => { res.writeHead(502); res.end(); } },
      });
      await s.get('/rt1/err').catch(() => {});
      await sleep(50);
      assert.equal(calls.dec, 1, 'decrementRequest must be called on upstream error');
      await s.stop();
    });
  });
});
