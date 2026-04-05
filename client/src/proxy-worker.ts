import http from 'node:http';
import net  from 'node:net';

import { ProxyClient }                          from './proxy-client.js';
import { createPaymentFetch, type PreferNetwork } from './payment-fetch.js';
import type { ResolvedSigners as ResolvedWallet }  from './wallet.js';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// ─── Public stats / handle types ─────────────────────────────────────────────

export type WorkerStats = {
  /** Total HTTP requests handled (including CONNECT). */
  requests:  number;
  /** Responses served from the local cache (reverse mode only). */
  cacheHits?: number;
  /** Bytes sent to downstream clients. */
  bytesSent: number;
  /** Bytes received from upstream. */
  bytesRecv: number;
  /** Worker uptime in milliseconds. */
  uptime:    number;
  /** Total USD spent on x402 payments (forward mode only). */
  spend?:    number;
};

export type ProxyWorkerHandle = {
  readonly type: 'reverse' | 'forward';
  /** The local port the worker is actually listening on. */
  readonly port: number;
  /** Returns a snapshot of current worker metrics. */
  stats: () => WorkerStats;
  /** Gracefully stops the worker. */
  stop:  () => Promise<void>;
};

// ─── Local response cache (reverse proxy only) ───────────────────────────────

interface CacheEntry {
  statusCode: number;
  headers:    Record<string, string>;
  body:       string;
  expiresAt:  number;
  hits:       number;
}

class ResponseCache {
  private store = new Map<string, CacheEntry>();
  hits   = 0;
  misses = 0;

  constructor(private readonly ttl: number, private readonly maxSize: number) {}

  get(key: string): CacheEntry | null {
    const e = this.store.get(key);
    if (!e)                       { this.misses++; return null; }
    if (Date.now() > e.expiresAt) { this.store.delete(key); this.misses++; return null; }
    e.hits++;
    this.hits++;
    return e;
  }

  set(key: string, statusCode: number, headers: Record<string, string>, body: string): void {
    if (this.store.size >= this.maxSize)
      this.store.delete(this.store.keys().next().value!);
    this.store.set(key, { statusCode, headers, body, expiresAt: Date.now() + this.ttl, hits: 0 });
  }
}

// ─── Bind helper — auto-assigns OS port when preferred is undefined ───────────

function bindServer(server: http.Server, preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(preferred ?? 0, () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    });
    server.once('error', reject);
  });
}

// ─── Reverse proxy option types ───────────────────────────────────────────────

export type ReverseRequestCtx = {
  method:  string;
  url:     string;
  headers: Record<string, string>;
  /** Mutate target fields to reroute the request to a different upstream. */
  target:  { host: string; port: number; protocol: 'http' | 'https' };
};

export type ReverseResponseCtx = {
  statusCode: number;
  headers:    Record<string, string>;
  cached:     boolean;
};

export type ReverseWorkerOptions = {
  type:     'reverse';
  /** The upstream server to protect — cache misses are deduplicated via the consensus network before being forwarded here. */
  upstream: { host: string; port: number; protocol?: 'http' | 'https' };
  /** Proxy listen port. Omit to auto-assign. */
  port?:    number;
  /**
   * Payment-capable fetch function.
   * If omitted, createPaymentFetch() resolves credentials from env:
   *   CONSENSUS_EVM_KEY | CONSENSUS_SVM_KEY | CONSENSUS_PEM_PATH
   */
  fetchFn?: FetchFn;
  /**
   * Pre-resolved wallet — alternative to `fetchFn`.
   * Passed to createPaymentFetch() internally; ignored if `fetchFn` is set.
   */
  wallet?:  ResolvedWallet;
  /**
   * Preferred payment network family when multiple signers are available.
   * 'eip155' | 'solana' | 'icp' — falls back to server ordering if omitted.
   */
  preferNetwork?: PreferNetwork;
  cache?: {
    /** Local response TTL in milliseconds (default 30 000). Cache hits skip the consensus network entirely. */
    ttl?:     number;
    /** Max locally cached entries (default 1 000). */
    maxSize?: number;
  };
  /** Cache TTL in seconds forwarded to the consensus node on cache misses. */
  cacheTtl?: number;
  /** Max proxy spend in USD before stand-down. */
  budget?:   number;
  hooks?: {
    /** Return `false` to block the request with 403. Mutate ctx to rewrite URL, headers, or reroute to a different upstream. */
    onRequest?:  (ctx: ReverseRequestCtx)  => void | false | Promise<void | false>;
    /** Mutate ctx.headers to inject or strip response headers. Fires on both cache hits and consensus responses. */
    onResponse?: (ctx: ReverseResponseCtx) => void | Promise<void>;
    onError?:    (err: Error, req: http.IncomingMessage, res: http.ServerResponse) => void;
  };
  /** Called after every request with updated stats. */
  onStats?:  (stats: WorkerStats) => void;
};

// ─── Forward proxy option types ───────────────────────────────────────────────

export type ForwardWorkerOptions = {
  type:  'forward';
  /** Proxy listen port. Omit to auto-assign. */
  port?: number;
  /**
   * Payment-capable fetch function.
   * If omitted, createPaymentFetch() resolves credentials from env:
   *   CONSENSUS_EVM_KEY | CONSENSUS_SVM_KEY | CONSENSUS_PEM_PATH
   */
  fetchFn?:     FetchFn;
  /**
   * Pre-resolved wallet — alternative to `fetchFn`.
   * Passed to createPaymentFetch() internally; ignored if `fetchFn` is set.
   */
  wallet?:      ResolvedWallet;
  /** Preferred consensus node region, e.g. "us-east". */
  nodeRegion?:  string;
  /** Force routing through a specific node domain. */
  nodeDomain?:  string;
  /** Max proxy spend in USD before stand-down. */
  budget?:      number;
  /** Cache TTL in seconds forwarded to the consensus node. */
  cacheTtl?:    number;
  /** Route filtering mode — passed to ProxyClient. */
  mode?:           'inclusive' | 'exclusive';
  /** Path rules used with `mode`. */
  routes?:         string[];
  /** Whether to include subroutes when matching `routes`. */
  matchSubroutes?: boolean;
  /** Exclude a specific node/domain from routing. */
  nodeExclude?:    string;
  /** Enable verbose proxy response payload. */
  verbose?:        boolean;
  /**
   * Preferred payment network when multiple signers are available.
   * 'eip155' | 'solana' | 'icp' — falls back to server ordering if omitted.
   */
  preferNetwork?:  PreferNetwork;
  /** Called after every request with updated stats. */
  onStats?:     (stats: WorkerStats) => void;
};

export type DispatchProxyOptions = ReverseWorkerOptions | ForwardWorkerOptions;

// ─── Reverse proxy worker ─────────────────────────────────────────────────────

async function startReverseProxy(opts: ReverseWorkerOptions): Promise<ProxyWorkerHandle> {
  const startedAt = Date.now();
  const counters  = { requests: 0, bytesSent: 0, bytesRecv: 0, spend: 0 };
  const cache     = new ResponseCache(opts.cache?.ttl ?? 30_000, opts.cache?.maxSize ?? 1_000);

  const fetchFn = opts.fetchFn ?? await createPaymentFetch({
    signers:       opts.wallet,
    preferNetwork: opts.preferNetwork,
  });

  const client = ProxyClient(fetchFn as Parameters<typeof ProxyClient>[0], {
    strategy:         'manual',
    cache_ttl:        opts.cacheTtl,
    limit_usd:        opts.budget,
    on_limit_reached: () =>
      opts.onStats?.({ ...counters, uptime: Date.now() - startedAt }),
  });

  function defaultCacheable(req: http.IncomingMessage): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.headers['authorization'])                   return false;
    if (req.headers['cookie'])                          return false;
    return true;
  }

  const server = http.createServer(async (req, res) => {
    counters.requests++;
    const cacheKey = `${req.method}:${req.url}`;
    const tryCache = defaultCacheable(req);

    // ── Local cache HIT — no payment, no network call ───────────────────────
    if (tryCache) {
      const entry = cache.get(cacheKey);
      if (entry) {
        const rctx: ReverseResponseCtx = { statusCode: entry.statusCode, headers: { ...entry.headers }, cached: true };
        try { await opts.hooks?.onResponse?.(rctx); } catch { /* never drop cached responses */ }
        res.writeHead(rctx.statusCode, { ...rctx.headers, 'x-cache': 'HIT', 'x-cache-hits': String(entry.hits) });
        counters.bytesSent += entry.body.length;
        res.end(entry.body);
        opts.onStats?.({ ...counters, cacheHits: cache.hits, uptime: Date.now() - startedAt });
        return;
      }
    }

    // ── onRequest hook — block, rewrite, or reroute before consensus ────────
    const rawHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === 'string') rawHeaders[k] = v;

    const ctx: ReverseRequestCtx = {
      method:  req.method  ?? 'GET',
      url:     req.url     ?? '/',
      headers: rawHeaders,
      target:  { host: opts.upstream.host, port: opts.upstream.port, protocol: opts.upstream.protocol ?? 'http' },
    };

    try {
      const verdict = await opts.hooks?.onRequest?.(ctx);
      if (verdict === false) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    } catch (err) {
      if (opts.hooks?.onError) { opts.hooks.onError(err as Error, req, res); return; }
      res.writeHead(500);
      res.end(`Hook error: ${(err as Error).message}`);
      return;
    }

    // ── Cache MISS — route through consensus network ─────────────────────────
    try {
      const targetUrl = `${ctx.target.protocol}://${ctx.target.host}:${ctx.target.port}${ctx.url}`;

      const result = await client.request({
        target_url: targetUrl,
        method:     ctx.method,
        headers:    ctx.headers,
      });

      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(result.headers ?? {}))
        if (typeof v === 'string') responseHeaders[k] = v;

      const body = typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data);

      // ── onResponse hook ─────────────────────────────────────────────────
      const rctx: ReverseResponseCtx = { statusCode: result.status, headers: responseHeaders, cached: false };
      try { await opts.hooks?.onResponse?.(rctx); } catch { /* ignore hook errors on miss path */ }

      if (tryCache && result.status >= 200 && result.status < 300) {
        cache.set(cacheKey, rctx.statusCode, rctx.headers, body);
      }

      res.writeHead(rctx.statusCode, { ...rctx.headers, 'x-cache': tryCache ? 'MISS' : 'SKIP' });
      counters.bytesSent += body.length;
      counters.spend      = client.getBudget().spent_usd;
      res.end(body);

      opts.onStats?.({ ...counters, cacheHits: cache.hits, uptime: Date.now() - startedAt });
    } catch (err) {
      if (opts.hooks?.onError) { opts.hooks.onError(err as Error, req, res); return; }
      if (!res.headersSent) { res.writeHead(502); res.end(`Bad Gateway: ${(err as Error).message}`); }
    }
  });

  const port = await bindServer(server, opts.port);
  console.log(
    `[ReverseProxy] :${port} → consensus → ${opts.upstream.protocol ?? 'http'}://${opts.upstream.host}:${opts.upstream.port}`,
  );

  return {
    type: 'reverse',
    port,
    stats: () => ({ ...counters, cacheHits: cache.hits, uptime: Date.now() - startedAt }),
    stop:  () => new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

// ─── Forward proxy worker ─────────────────────────────────────────────────────

async function startForwardProxy(opts: ForwardWorkerOptions): Promise<ProxyWorkerHandle> {
  const startedAt = Date.now();
  const counters  = { requests: 0, bytesSent: 0, bytesRecv: 0, spend: 0 };

  // Resolve fetch: explicit > auto-built from env (wallet key consumed, never stored).
  const fetchFn = opts.fetchFn ?? await createPaymentFetch({
    signers:       opts.wallet,
    preferNetwork: opts.preferNetwork,
  });

  const client = ProxyClient(fetchFn as Parameters<typeof ProxyClient>[0], {
    strategy:         'manual',
    cache_ttl:        opts.cacheTtl,
    limit_usd:        opts.budget,
    node_region:      opts.nodeRegion,
    node_domain:      opts.nodeDomain,
    node_exclude:     opts.nodeExclude,
    mode:             opts.mode,
    routes:           opts.routes,
    matchSubroutes:   opts.matchSubroutes,
    verbose:          opts.verbose,
    on_limit_reached: () =>
      opts.onStats?.({ ...counters, uptime: Date.now() - startedAt }),

  });

  const server = http.createServer(async (req, res) => {
    counters.requests++;

    try {
      const rawHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === 'string') rawHeaders[k] = v;

      const result = await client.request({
        target_url: req.url ?? '/',
        method:     req.method ?? 'GET',
        headers:    rawHeaders,
      });

      for (const [k, v] of Object.entries(result.headers ?? {}))
        if (typeof v === 'string') res.setHeader(k, v);

      res.writeHead(result.status);

      const body = typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data);

      counters.bytesSent       += body.length;
      counters.spend            = client.getBudget().spent_usd;
      res.end(body);

      opts.onStats?.({ ...counters, uptime: Date.now() - startedAt });
    } catch (err) {
      res.writeHead(502);
      res.end(err instanceof Error ? err.message : 'Proxy error');
    }
  });

  // HTTPS CONNECT — pure TCP tunnel, no payment, no inspection.
  server.on('connect', (req, clientSocket, head) => {
    counters.requests++;
    const [hostname, portStr] = (req.url ?? '').split(':');
    const targetPort          = parseInt(portStr ?? '443', 10);

    const serverSocket = net.createConnection(targetPort, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });

  const port = await bindServer(server, opts.port);
  console.log(`[ForwardProxy] :${port} → consensus network`);

  return {
    type: 'forward',
    port,
    stats: () => ({ ...counters, uptime: Date.now() - startedAt }),
    stop:  () => new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

// ─── dispatchProxy ────────────────────────────────────────────────────────────

/**
 * Dispatches a proxy worker against an already-running server.
 * No changes to the target server are required.
 *
 * @example Protect an existing server on port 3000:
 * ```ts
 * const worker = await dispatchProxy({
 *   type:     'reverse',
 *   upstream: { host: 'localhost', port: 3000 },
 * });
 * console.log(`Proxy live on :${worker.port}`);
 * ```
 *
 * @example Route outbound traffic through the consensus network:
 * ```ts
 * // Set CONSENSUS_EVM_KEY (or SVM / PEM) in your environment.
 * const worker = await dispatchProxy({ type: 'forward' });
 * // export HTTP_PROXY=http://localhost:<worker.port>
 * ```
 *
 * @example Stop the worker when done:
 * ```ts
 * await worker.stop();
 * ```
 */
export async function dispatchProxy(opts: DispatchProxyOptions): Promise<ProxyWorkerHandle> {
  if (opts.type === 'reverse') return startReverseProxy(opts);
  if (opts.type === 'forward') return startForwardProxy(opts);
  throw new Error(`[dispatchProxy] Unknown type: "${(opts as { type: string }).type}"`);
}
