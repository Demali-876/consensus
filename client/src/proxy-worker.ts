import http from 'node:http';
import net  from 'node:net';
import tls  from 'node:tls';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import { ProxyClient }                          from './proxy-client.js';
import { createPaymentFetch, type PreferNetwork } from './payment-fetch.js';
import type { ResolvedSigners as ResolvedWallet }  from './wallet.js';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const CONSENSUS_SERVER_URL = (process.env.CONSENSUS_SERVER_URL || 'https://consensus.canister.software').replace(/\/+$/, '');
const MAX_REVERSE_REQUEST_BYTES = 10 * 1024 * 1024;

const TUNNEL_FRAME = {
  STREAM_OPEN:  0x01,
  STREAM_DATA:  0x02,
  STREAM_END:   0x03,
  STREAM_RESET: 0x04,
  PING:         0x05,
  PONG:         0x06,
} as const;

type ReverseTarget = { host: string; port: number; protocol: 'http' | 'https' };
type PrivateTunnelRef = {
  kind: 'tunnel';
  tunnel_id: string;
  capability: string;
  path: string;
};

function encodeTunnelFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId, 1);
  return Buffer.concat([header, payload]);
}

function decodeTunnelFrame(data: Buffer): { type: number; streamId: number; payload: Buffer } {
  if (data.length < 5) throw new RangeError('Tunnel frame too short');
  return { type: data.readUInt8(0), streamId: data.readUInt32BE(1), payload: data.subarray(5) };
}

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
  /** Last request latency in milliseconds. */
  currentLatencyMs?: number;
  /** Average latency across recent requests. */
  avgLatencyMs?: number;
  /** 95th percentile latency across recent requests. */
  p95LatencyMs?: number;
  /** Rolling recent latency samples. */
  recentLatencies?: number[];
  /** Rolling recent request outcomes (true = success). */
  recentOutcomes?: boolean[];
  /** Last observed upstream/downstream HTTP status code. */
  lastStatusCode?: number;
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

const MAX_HISTORY = 40;

function pushRecent<T>(items: T[], value: T): void {
  items.push(value);
  if (items.length > MAX_HISTORY) items.shift();
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], pct: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
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

function bindServer(server: http.Server, preferred?: number, label = 'proxy'): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestedPort = preferred ?? 0;
    const timeout = setTimeout(() => {
      server.off('error', onError);
      reject(new Error(`[${label}] listen() timed out before binding port ${requestedPort}`));
    }, 5000);

    const cleanup = () => {
      clearTimeout(timeout);
      server.off('error', onError);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    server.once('error', onError);

    try {
      server.listen(requestedPort, () => {
        cleanup();
        const addr = server.address();
        if (!addr || typeof addr !== 'object') {
          reject(new Error(`[${label}] listen() completed without a usable address`));
          return;
        }
        resolve(addr.port);
      });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

interface PrivateTunnelRegistration {
  tunnelId: string;
  connect_url: string;
  proxy_capability: string;
}

class PrivateTunnelConnector {
  private readonly sockets = new Map<number, net.Socket>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly target: ReverseTarget,
    private readonly ws: WebSocket,
    private readonly tunnelId: string,
    private readonly capability: string,
  ) {}

  static async connect(
    target: ReverseTarget,
    onLog: (event: string, fields?: Record<string, unknown>) => void,
  ): Promise<PrivateTunnelConnector> {
    const registrationResponse = await fetch(`${CONSENSUS_SERVER_URL}/tunnel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'http', visibility: 'private' }),
    });
    if (!registrationResponse.ok) {
      throw new Error(`Private tunnel registration failed (${registrationResponse.status})`);
    }
    const registration = await registrationResponse.json() as PrivateTunnelRegistration;
    if (!registration.tunnelId || !registration.connect_url || !registration.proxy_capability) {
      throw new Error('Private tunnel registration returned an invalid response');
    }

    const ws = new WebSocket(registration.connect_url, { perMessageDeflate: false });
    ws.binaryType = 'nodebuffer';
    const connector = new PrivateTunnelConnector(
      target,
      ws,
      registration.tunnelId,
      registration.proxy_capability,
    );
    await connector.waitUntilOpen(onLog);
    return connector;
  }

  ref(path: string): PrivateTunnelRef {
    return {
      kind: 'tunnel',
      tunnel_id: this.tunnelId,
      capability: this.capability,
      path,
    };
  }

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private waitUntilOpen(onLog: (event: string, fields?: Record<string, unknown>) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        this.ws.close();
        reject(new Error('Private tunnel connection timed out'));
      }, 10_000);
      const failBeforeOpen = (error: Error) => {
        if (opened) return;
        clearTimeout(timer);
        reject(error);
      };

      this.ws.on('error', (error) => failBeforeOpen(error));
      this.ws.on('close', () => {
        if (!opened) failBeforeOpen(new Error('Private tunnel closed before connecting'));
        this.destroySockets();
      });
      this.ws.on('message', (raw: Buffer) => {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (!opened && data[0] === 0x7b) {
          try {
            const message = JSON.parse(data.toString()) as { type?: string };
            if (message.type === 'tunnel_open') {
              opened = true;
              clearTimeout(timer);
              this.pingTimer = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) {
                  this.ws.send(encodeTunnelFrame(TUNNEL_FRAME.PING, 0));
                }
              }, 30_000);
              onLog('private-tunnel-connected', {
                tunnel_id: this.tunnelId,
                target_host: this.target.host,
                target_port: this.target.port,
                target_protocol: this.target.protocol,
              });
              resolve();
              return;
            }
          } catch { /* fall through to frame parsing */ }
        }
        if (!opened || data.length < 5) return;
        this.handleFrame(decodeTunnelFrame(data));
      });
    });
  }

  private handleFrame(frame: ReturnType<typeof decodeTunnelFrame>): void {
    if (frame.type === TUNNEL_FRAME.PING) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(encodeTunnelFrame(TUNNEL_FRAME.PONG, 0));
      }
      return;
    }
    if (frame.type === TUNNEL_FRAME.PONG) return;

    if (frame.type === TUNNEL_FRAME.STREAM_OPEN) {
      const socket = this.target.protocol === 'https'
        ? tls.connect({
            host: this.target.host,
            port: this.target.port,
            servername: net.isIP(this.target.host) ? undefined : this.target.host,
          })
        : net.createConnection({ host: this.target.host, port: this.target.port });
      this.sockets.set(frame.streamId, socket);
      if (frame.payload.length) socket.write(frame.payload);
      socket.on('data', (data: Buffer) => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(encodeTunnelFrame(TUNNEL_FRAME.STREAM_DATA, frame.streamId, data));
        }
      });
      socket.on('end', () => {
        this.sockets.delete(frame.streamId);
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(encodeTunnelFrame(TUNNEL_FRAME.STREAM_END, frame.streamId));
        }
      });
      socket.on('error', () => {
        this.sockets.delete(frame.streamId);
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(encodeTunnelFrame(TUNNEL_FRAME.STREAM_RESET, frame.streamId));
        }
      });
      return;
    }

    const socket = this.sockets.get(frame.streamId);
    if (!socket) return;
    if (frame.type === TUNNEL_FRAME.STREAM_DATA) socket.write(frame.payload);
    if (frame.type === TUNNEL_FRAME.STREAM_END) {
      this.sockets.delete(frame.streamId);
      socket.end();
    }
    if (frame.type === TUNNEL_FRAME.STREAM_RESET) {
      this.sockets.delete(frame.streamId);
      socket.destroy();
    }
  }

  private destroySockets(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
  }

  async stop(): Promise<void> {
    this.destroySockets();
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }
}

function readReverseRequestBody(req: http.IncomingMessage): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REVERSE_REQUEST_BYTES) {
        reject(new Error('Reverse proxy request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(bytes > 0 ? Buffer.concat(chunks).toString('utf8') : undefined));
    req.on('error', reject);
  });
}

function setUpstreamHostHeader(headers: Record<string, string>, target: ReverseTarget): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'host') delete headers[key];
  }
  const host = net.isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  headers.host = `${host}:${target.port}`;
}

function reverseTargetUrl(target: ReverseTarget, path: string): string {
  const host = net.isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  return `${target.protocol}://${host}:${target.port}${path.startsWith('/') ? path : `/${path}`}`;
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
  /** Structured lifecycle logging. Defaults to console output when omitted. */
  onLog?:    (event: string, fields: Record<string, unknown>) => void;
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
  const recentLatencies: number[] = [];
  const recentOutcomes: boolean[] = [];
  let lastStatusCode: number | undefined;

  const logEvent = (event: string, fields: Record<string, unknown> = {}) => {
    if (opts.onLog) {
      try { opts.onLog(event, fields); } catch { /* logging must never affect proxy traffic */ }
      return;
    }
    console.log(JSON.stringify({ scope: 'reverse-proxy', event, ...fields }));
  };

  const safePath = (value: string | undefined): string => {
    const raw = value ?? '/';
    const queryAt = raw.indexOf('?');
    return queryAt >= 0 ? `${raw.slice(0, queryAt)}?<redacted>` : raw;
  };

  const errorFields = (err: unknown): Record<string, unknown> => ({
    error_name: err instanceof Error ? err.name : 'Error',
    error_message: err instanceof Error ? err.message : String(err),
  });

  logEvent('startup-requested', {
    listen_port: opts.port ?? 'auto',
    upstream_host: opts.upstream.host,
    upstream_port: opts.upstream.port,
    upstream_protocol: opts.upstream.protocol ?? 'http',
    local_cache_ttl_ms: opts.cache?.ttl ?? 30_000,
    local_cache_max_entries: opts.cache?.maxSize ?? 1_000,
    consensus_cache_ttl_s: opts.cacheTtl ?? null,
  });

  const recordResult = (latencyMs: number, ok: boolean, statusCode?: number) => {
    pushRecent(recentLatencies, latencyMs);
    pushRecent(recentOutcomes, ok);
    if (statusCode !== undefined) lastStatusCode = statusCode;
  };

  const snapshot = (): WorkerStats => ({
    ...counters,
    cacheHits: cache.hits,
    uptime: Date.now() - startedAt,
    currentLatencyMs: recentLatencies.at(-1),
    avgLatencyMs: average(recentLatencies),
    p95LatencyMs: percentile(recentLatencies, 95),
    recentLatencies: [...recentLatencies],
    recentOutcomes: [...recentOutcomes],
    lastStatusCode,
  });

  const fetchFn = opts.fetchFn ?? await createPaymentFetch({
    signers:       opts.wallet,
    preferNetwork: opts.preferNetwork,
  });

  const client = ProxyClient(fetchFn as Parameters<typeof ProxyClient>[0], {
    strategy:         'manual',
    cache_ttl:        opts.cacheTtl,
    limit_usd:        opts.budget,
    verbose:          true,
    on_limit_reached: () => opts.onStats?.(snapshot()),
  });
  const connectors = new Map<string, Promise<PrivateTunnelConnector>>();
  const connectorKey = (target: ReverseTarget) => `${target.protocol}://${target.host}:${target.port}`;
  const getConnector = (target: ReverseTarget): Promise<PrivateTunnelConnector> => {
    const key = connectorKey(target);
    const existing = connectors.get(key);
    if (existing) {
      return existing.then((connector) => {
        if (connector.isOpen()) return connector;
        connectors.delete(key);
        return getConnector(target);
      });
    }
    if (connectors.size >= 32) {
      throw new Error('Reverse proxy private tunnel connector limit reached');
    }
    const created = PrivateTunnelConnector.connect(target, logEvent)
      .catch((error) => {
        connectors.delete(key);
        throw error;
      });
    connectors.set(key, created);
    return created;
  };

  await getConnector({
    host: opts.upstream.host,
    port: opts.upstream.port,
    protocol: opts.upstream.protocol ?? 'http',
  });

  function defaultCacheable(req: http.IncomingMessage): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.headers['authorization'])                   return false;
    if (req.headers['cookie'])                          return false;
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const requestStartedAt = performance.now();
    counters.requests++;
    const requestId = `${startedAt}-${counters.requests}`;
    const cacheKey = `${req.method}:${req.url}`;
    const tryCache = defaultCacheable(req);
    logEvent('request-received', {
      request_id: requestId,
      method: req.method ?? 'GET',
      path: safePath(req.url),
      local_cache_eligible: tryCache,
    });

    // ── Local cache HIT — no payment, no network call ───────────────────────
    if (tryCache) {
      const entry = cache.get(cacheKey);
      if (entry) {
        const rctx: ReverseResponseCtx = { statusCode: entry.statusCode, headers: { ...entry.headers }, cached: true };
        try { await opts.hooks?.onResponse?.(rctx); } catch { /* never drop cached responses */ }
        res.writeHead(rctx.statusCode, { ...rctx.headers, 'x-cache': 'HIT', 'x-cache-hits': String(entry.hits) });
        counters.bytesSent += entry.body.length;
        res.end(entry.body);
        const latencyMs = elapsedMs(requestStartedAt);
        recordResult(latencyMs, true, rctx.statusCode);
        logEvent('local-cache-hit', {
          request_id: requestId,
          status: rctx.statusCode,
          cache_entry_hits: entry.hits,
          body_bytes: Buffer.byteLength(entry.body),
          total_ms: Math.round(latencyMs),
        });
        opts.onStats?.(snapshot());
        return;
      }
      logEvent('local-cache-miss', { request_id: requestId });
    } else {
      logEvent('local-cache-skip', { request_id: requestId });
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
        const latencyMs = elapsedMs(requestStartedAt);
        recordResult(latencyMs, false, 403);
        logEvent('request-blocked', {
          request_id: requestId,
          status: 403,
          total_ms: Math.round(latencyMs),
        });
        opts.onStats?.(snapshot());
        return;
      }
    } catch (err) {
      const latencyMs = elapsedMs(requestStartedAt);
      if (opts.hooks?.onError) {
        opts.hooks.onError(err as Error, req, res);
        recordResult(latencyMs, false);
        logEvent('hook-error', {
          request_id: requestId,
          total_ms: Math.round(latencyMs),
          ...errorFields(err),
        });
        opts.onStats?.(snapshot());
        return;
      }
      res.writeHead(500);
      res.end(`Hook error: ${(err as Error).message}`);
      recordResult(latencyMs, false, 500);
      logEvent('hook-error', {
        request_id: requestId,
        status: 500,
        total_ms: Math.round(latencyMs),
        ...errorFields(err),
      });
      opts.onStats?.(snapshot());
      return;
    }

    // ── Cache MISS — route through consensus network ─────────────────────────
    try {
      const requestBody = await readReverseRequestBody(req);
      setUpstreamHostHeader(ctx.headers, ctx.target);
      const connector = await getConnector(ctx.target);
      const consensusStartedAt = performance.now();
      logEvent('consensus-request-started', {
        request_id: requestId,
        method: ctx.method,
        target_host: ctx.target.host,
        target_port: ctx.target.port,
        target_protocol: ctx.target.protocol,
        path: safePath(ctx.url),
      });

      const result = await client.request({
        target_url: reverseTargetUrl(ctx.target, ctx.url),
        target_ref: connector.ref(ctx.url),
        method:     ctx.method,
        headers:    ctx.headers,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      });

      // Strip headers that are bound to the *original* upstream transport and
      // no longer match what we're about to write. We received a decoded body
      // (string/JSON) from consensus, so Content-Encoding (e.g. zstd/gzip)
      // would tell the client to decode bytes that are already plain; Node
      // sets Content-Length itself from the buffer; Transfer-Encoding: chunked
      // collides with sending a complete buffer in one res.end. Hop-by-hop
      // headers per RFC 7230 are also unsafe to forward across a proxy.
      const STRIP_RESPONSE_HEADERS = new Set([
        'transfer-encoding', 'content-encoding', 'content-length',
        'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
        'proxy-authenticate', 'proxy-authorization',
      ]);
      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(result.headers ?? {})) {
        if (typeof v !== 'string') continue;
        if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        responseHeaders[k] = v;
      }

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
      counters.bytesRecv += Buffer.byteLength(body);
      counters.spend      = client.getBudget().spent_usd;
      res.end(body);

      const latencyMs = elapsedMs(requestStartedAt);
      const meta = result.meta;
      recordResult(latencyMs, true, rctx.statusCode);
      logEvent('consensus-request-completed', {
        request_id: requestId,
        status: rctx.statusCode,
        local_cache: tryCache ? 'MISS' : 'SKIP',
        stored_in_local_cache: tryCache && result.status >= 200 && result.status < 300,
        consensus_cached: meta?.cached ?? null,
        served_by: meta?.served_by ?? null,
        dedupe_key: typeof meta?.dedupe_key === 'string' ? meta.dedupe_key.slice(0, 12) : null,
        server_processing_ms: meta?.processing_ms ?? null,
        consensus_round_trip_ms: Math.round(elapsedMs(consensusStartedAt)),
        total_ms: Math.round(latencyMs),
        body_bytes: Buffer.byteLength(body),
      });
      opts.onStats?.(snapshot());
    } catch (err) {
      const latencyMs = elapsedMs(requestStartedAt);
      if (opts.hooks?.onError) {
        opts.hooks.onError(err as Error, req, res);
        recordResult(latencyMs, false);
        logEvent('consensus-request-failed', {
          request_id: requestId,
          total_ms: Math.round(latencyMs),
          ...errorFields(err),
        });
        opts.onStats?.(snapshot());
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(`Bad Gateway: ${(err as Error).message}`);
      }
      recordResult(latencyMs, false, 502);
      logEvent('consensus-request-failed', {
        request_id: requestId,
        status: 502,
        total_ms: Math.round(latencyMs),
        ...errorFields(err),
      });
      opts.onStats?.(snapshot());
    }
  });

  let port: number;
  try {
    port = await bindServer(server, opts.port, 'reverse proxy');
  } catch (error) {
    await Promise.allSettled(Array.from(connectors.values(), async (connector) => (await connector).stop()));
    throw error;
  }
  logEvent('listening', {
    listen_port: port,
    upstream_host: opts.upstream.host,
    upstream_port: opts.upstream.port,
    upstream_protocol: opts.upstream.protocol ?? 'http',
  });

  return {
    type: 'reverse',
    port,
    stats: snapshot,
    stop:  async () => {
      logEvent('stopping', { listen_port: port, requests: counters.requests, cache_hits: cache.hits });
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
        });
        await Promise.allSettled(Array.from(connectors.values(), async (connector) => (await connector).stop()));
        logEvent('stopped', { listen_port: port });
      } catch (err) {
        logEvent('stop-failed', { listen_port: port, ...errorFields(err) });
        throw err;
      }
    },
  };
}

// ─── Forward proxy worker ─────────────────────────────────────────────────────

async function startForwardProxy(opts: ForwardWorkerOptions): Promise<ProxyWorkerHandle> {
  const startedAt = Date.now();
  const counters  = { requests: 0, bytesSent: 0, bytesRecv: 0, spend: 0 };
  const recentLatencies: number[] = [];
  const recentOutcomes: boolean[] = [];
  let lastStatusCode: number | undefined;

  console.log(`[ForwardProxy] startup requested on :${opts.port ?? 'auto'}`);

  const recordResult = (latencyMs: number, ok: boolean, statusCode?: number) => {
    pushRecent(recentLatencies, latencyMs);
    pushRecent(recentOutcomes, ok);
    if (statusCode !== undefined) lastStatusCode = statusCode;
  };

  const snapshot = (): WorkerStats => ({
    ...counters,
    uptime: Date.now() - startedAt,
    spend: counters.spend,
    currentLatencyMs: recentLatencies.at(-1),
    avgLatencyMs: average(recentLatencies),
    p95LatencyMs: percentile(recentLatencies, 95),
    recentLatencies: [...recentLatencies],
    recentOutcomes: [...recentOutcomes],
    lastStatusCode,
  });

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
    on_limit_reached: () => opts.onStats?.(snapshot()),

  });

  const server = http.createServer(async (req, res) => {
    // ── Stats side-channel ─────────────────────────────────────────────────
    // The auto-relaunched app's preload posts here after every fetch so the
    // dashboard reflects real traffic even though /proxy requests go direct
    // to the Consensus server. See app-manager.writePreloadFile.
    if (req.method === 'POST' && (req.url === '/_consensus/stats' || req.url?.startsWith('/_consensus/stats?'))) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const payload = JSON.parse(raw) as {
            ok?: boolean; status?: number; latencyMs?: number; bytes?: number;
          };
          counters.requests++;
          if (typeof payload.bytes === 'number' && payload.bytes > 0) {
            counters.bytesRecv += payload.bytes;
          }
          recordResult(
            typeof payload.latencyMs === 'number' ? payload.latencyMs : 0,
            payload.ok === true,
            typeof payload.status === 'number' ? payload.status : undefined,
          );
          opts.onStats?.(snapshot());
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end('bad stats payload');
        }
      });
      req.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(400);
          res.end('bad stats stream');
        }
      });
      return;
    }

    const requestStartedAt = performance.now();
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
      counters.bytesRecv       += body.length;
      counters.spend            = client.getBudget().spent_usd;
      res.end(body);

      recordResult(elapsedMs(requestStartedAt), true, result.status);
      opts.onStats?.(snapshot());
    } catch (err) {
      res.writeHead(502);
      res.end(err instanceof Error ? err.message : 'Proxy error');
      recordResult(elapsedMs(requestStartedAt), false, 502);
      opts.onStats?.(snapshot());
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

  const port = await bindServer(server, opts.port, 'forward proxy');
  console.log(`[ForwardProxy] listening on :${port}`);

  return {
    type: 'forward',
    port,
    stats: snapshot,
    stop:  () => new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

// ─── Preload-mode stats collector ─────────────────────────────────────────────
// The forward proxy in this codebase doesn't run its own HTTP proxy — it
// auto-relaunches the user's app with a preload that wraps `globalThis.fetch`
// and routes calls straight to the Consensus server. To still surface live
// counters in the dashboard, the preload fires-and-forgets a tiny POST per
// fetch to the URL below. This server is the receiver: it owns nothing but
// counters and the stats endpoint.

export interface PreloadCollectorOptions {
  /** Preferred listen port. If taken/unspecified, the OS assigns one. */
  port?: number;
}

export async function startPreloadCollector(opts: PreloadCollectorOptions = {}): Promise<ProxyWorkerHandle> {
  const startedAt = Date.now();
  const counters  = { requests: 0, bytesSent: 0, bytesRecv: 0, spend: 0 };
  const recentLatencies: number[] = [];
  const recentOutcomes: boolean[] = [];
  let lastStatusCode: number | undefined;

  const recordResult = (latencyMs: number, ok: boolean, statusCode?: number) => {
    pushRecent(recentLatencies, latencyMs);
    pushRecent(recentOutcomes, ok);
    if (statusCode !== undefined) lastStatusCode = statusCode;
  };

  const snapshot = (): WorkerStats => ({
    ...counters,
    uptime: Date.now() - startedAt,
    currentLatencyMs: recentLatencies.at(-1),
    avgLatencyMs:     average(recentLatencies),
    p95LatencyMs:     percentile(recentLatencies, 95),
    recentLatencies:  [...recentLatencies],
    recentOutcomes:   [...recentOutcomes],
    lastStatusCode,
  });

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url === '/_consensus/stats' || req.url?.startsWith('/_consensus/stats?'))) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(raw) as {
          ok?: boolean; status?: number; latencyMs?: number; bytes?: number;
        };
        counters.requests++;
        if (typeof payload.bytes === 'number' && payload.bytes > 0) {
          counters.bytesRecv += payload.bytes;
        }
        recordResult(
          typeof payload.latencyMs === 'number' ? payload.latencyMs : 0,
          payload.ok === true,
          typeof payload.status === 'number' ? payload.status : undefined,
        );
        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(400);
        res.end('bad stats payload');
      }
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400);
        res.end('bad stats stream');
      }
    });
  });

  const port = await bindServer(server, opts.port, 'preload stats');
  console.log(`[PreloadCollector] listening on :${port}`);

  return {
    type: 'forward',
    port,
    stats: snapshot,
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
