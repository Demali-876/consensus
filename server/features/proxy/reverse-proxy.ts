import http  from 'node:http';
import https from 'node:https';
import Router from '../../router.ts';

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  statusCode: number;
  headers:    http.IncomingHttpHeaders;
  body:       Buffer;
  expiresAt:  number;
  hits:       number;
}

export interface CacheStats {
  hits:    number;
  misses:  number;
  size:    number;
  maxSize: number;
}

class ResponseCache {
  private store   = new Map<string, CacheEntry>();
  private stats_  = { hits: 0, misses: 0 };

  constructor(private ttl: number, private maxSize: number) {}

  get(key: string): CacheEntry | null {
    const entry = this.store.get(key);
    if (!entry)                    { this.stats_.misses++; return null; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.stats_.misses++;
      return null;
    }
    entry.hits++;
    this.stats_.hits++;
    return entry;
  }

  set(key: string, statusCode: number, headers: http.IncomingHttpHeaders, body: Buffer): void {
    if (this.store.size >= this.maxSize)
      this.store.delete(this.store.keys().next().value!);
    this.store.set(key, { statusCode, headers, body, expiresAt: Date.now() + this.ttl, hits: 0 });
  }

  stats(): CacheStats {
    return { hits: this.stats_.hits, misses: this.stats_.misses, size: this.store.size, maxSize: this.maxSize };
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpstreamTarget {
  host:      string;
  port:      number;
  protocol?: 'http' | 'https';
}

/** Passed to `hooks.onRequest`. Mutate any field to reroute, rewrite, or modify headers.
 *  Return `false` to block the request with 403. */
export interface RequestContext {
  req:     http.IncomingMessage;
  target:  UpstreamTarget;
  headers: http.OutgoingHttpHeaders;
  url:     string;
  method:  string;
}

/** Passed to `hooks.onResponse`. Mutate `headers` to inject or strip response headers.
 *  Fires on both cache hits and upstream responses. */
export interface ResponseContext {
  req:        http.IncomingMessage;
  statusCode: number;
  headers:    http.IncomingHttpHeaders;
  cached:     boolean;
}

export interface ProxyOptions {
  port:     number;
  /** Default upstream — used when the router has no available nodes. */
  upstream: UpstreamTarget;
  /** When a node is available its domain is used as the upstream (HTTPS, port 443).
   *  Falls back to `upstream` when no node can be selected. */
  router?:  Router;
  cache?: {
    ttl?:     number;   // ms — default 30 000
    maxSize?: number;   // entries — default 1 000
  };
  /** Override the cache key. Default: `"${method}:${url}"`. */
  cacheKey?:  (req: http.IncomingMessage) => string;
  /** Which requests are eligible for caching. Default: GET/HEAD, no auth/cookie. */
  cacheable?: (req: http.IncomingMessage) => boolean;
  hooks?: {
    onRequest?:  (ctx: RequestContext)  => void | false | Promise<void | false>;
    onResponse?: (ctx: ResponseContext) => void | Promise<void>;
    onError?:    (err: Error, req: http.IncomingMessage, res: http.ServerResponse) => void;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'transfer-encoding', 'connection', 'keep-alive',
  'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'upgrade',
]);

const ROUTER_PREF_HEADERS = ['x-node-region', 'x-node-domain', 'x-node-exclude'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultCacheable(req: http.IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers['authorization'])                   return false;
  if (req.headers['cookie'])                          return false;
  return true;
}

function isCacheableResponse(headers: http.IncomingHttpHeaders): boolean {
  const cc = headers['cache-control'] ?? '';
  if (cc.includes('no-store') || cc.includes('private')) return false;
  if (headers['set-cookie'])                             return false;
  return true;
}

interface NodeRecord { id: string; domain: string; }

function resolveUpstream(
  cacheKey: string,
  req:      http.IncomingMessage,
  opts:     ProxyOptions,
): { target: UpstreamTarget; nodeId: string | null } {
  if (opts.router) {
    const prefs: Record<string, string> = {};
    for (const k of ROUTER_PREF_HEADERS) {
      const v = req.headers[k];
      if (typeof v === 'string') prefs[k] = v;
    }
    const node = opts.router.selectNode(cacheKey, prefs) as NodeRecord | null;
    if (node && typeof node.id === 'string' && typeof node.domain === 'string')
      return { target: { host: node.domain, port: 443, protocol: 'https' }, nodeId: node.id };
  }
  return { target: opts.upstream, nodeId: null };
}

// ─── createProxy ─────────────────────────────────────────────────────────────

export function createProxy(opts: ProxyOptions) {
  const cache       = new ResponseCache(opts.cache?.ttl ?? 30_000, opts.cache?.maxSize ?? 1_000);
  const isCacheable = opts.cacheable ?? defaultCacheable;
  const getCacheKey = opts.cacheKey  ?? ((req) => `${req.method}:${req.url}`);

  const server = http.createServer(async (req, res) => {
    const cacheKey = getCacheKey(req);
    const tryCache = isCacheable(req);

    if (tryCache) {
      const entry = cache.get(cacheKey);
      if (entry) {
        const rctx: ResponseContext = { req, statusCode: entry.statusCode, headers: { ...entry.headers }, cached: true };
        try { await opts.hooks?.onResponse?.(rctx); } catch { /* never let hook errors drop the response */ }
        res.writeHead(rctx.statusCode, { ...rctx.headers, 'x-cache': 'HIT', 'x-cache-hits': String(entry.hits) });
        res.end(entry.body);
        return;
      }
    }

    const { target, nodeId } = resolveUpstream(cacheKey, req, opts);
    if (nodeId) opts.router!.incrementRequest(nodeId);

    let decremented = false;
    const decrement = () => {
      if (!decremented && nodeId) { decremented = true; opts.router!.decrementRequest(nodeId); }
    };

    const ctx: RequestContext = {
      req,
      target:  { ...target },
      headers: { ...req.headers } as http.OutgoingHttpHeaders,
      url:     req.url    ?? '/',
      method:  req.method ?? 'GET',
    };

    try {
      const result = await opts.hooks?.onRequest?.(ctx);
      if (result === false) {
        decrement();
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    } catch (err) {
      decrement();
      res.writeHead(500);
      res.end(`Hook error: ${(err as Error).message}`);
      return;
    }

    const transport = ctx.target.protocol === 'https' ? https : http;

    const upstreamReq = transport.request(
      { host: ctx.target.host, port: ctx.target.port, path: ctx.url, method: ctx.method, headers: ctx.headers },
      async (upstreamRes) => {
        upstreamRes.once('close', decrement);

        const responseHeaders: http.IncomingHttpHeaders = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(k)) responseHeaders[k] = v;
        }

        const willCache =
          tryCache &&
          upstreamRes.statusCode! >= 200 &&
          upstreamRes.statusCode! < 300  &&
          isCacheableResponse(upstreamRes.headers);

        const rctx: ResponseContext = { req, statusCode: upstreamRes.statusCode!, headers: responseHeaders, cached: false };
        try { await opts.hooks?.onResponse?.(rctx); } catch { /* ignore */ }

        if (!willCache) {
          res.writeHead(rctx.statusCode, { ...rctx.headers, 'x-cache': 'SKIP' });
          upstreamRes.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        upstreamRes.on('data', (c: Buffer) => chunks.push(c));
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks);
          cache.set(cacheKey, rctx.statusCode, rctx.headers, body);
          // Explicit content-length prevents the HTTP layer from switching to chunked encoding
          res.writeHead(rctx.statusCode, { ...rctx.headers, 'x-cache': 'MISS', 'content-length': String(body.length) });
          res.end(body);
        });
      },
    );

    upstreamReq.on('error', (err) => {
      decrement();
      if (opts.hooks?.onError) { opts.hooks.onError(err, req, res); return; }
      if (!res.headersSent) { res.writeHead(502); res.end(`Bad Gateway: ${err.message}`); }
    });

    req.pipe(upstreamReq);
  });

  server.listen(opts.port, () =>
    console.log(`[ReverseProxy] :${opts.port} → ${opts.upstream.protocol ?? 'http'}://${opts.upstream.host}:${opts.upstream.port}`),
  );

  return { server, cache };
}
