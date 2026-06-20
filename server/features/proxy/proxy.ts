import NodeCache                          from 'node-cache';
import axios                             from 'axios';
import http                              from 'node:http';
import https                             from 'node:https';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { promisify }                     from 'node:util';
import { WebSocket }                     from 'ws';
import Router                            from '../../router.ts';
import { resolveAndCheckTarget, type SafeResolution } from '../../utils/ssrf.ts';
import type { PrivateTunnelTarget, TunnelHttpResponse } from '../tunnel/tunnel.ts';
import {
  generateDedupeKey,
  canonicalizeUrl,
  canonicalizeSemanticHeaders,
  computeBodyHash,
  sha256Hex,
  stableStringify,
  type RequestBody,
  type Headers,
  type DedupeParams,
} from './dedupe.ts';

const httpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 64, timeout: 30_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 30_000 });

const gunzipAsync           = promisify(gunzip);
const inflateAsync          = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);


interface NodeRecord {
  id:     string;
  region: string;
  domain?: string | null;
}

export interface ProxyConfig {
  router?: Router;
  nodeTunnel?: {
    requestProxy(nodeId: string, input: {
      target_url: string;
      method: string;
      headers?: Headers;
      body?: string;
      body_encoding?: 'utf8' | 'base64';
    }): Promise<{
      status: number;
      status_text?: string;
      headers?: Record<string, string>;
      body?: string;
      body_encoding?: 'utf8' | 'base64';
    }>;
    getNodeSession?(nodeId: string): { mode?: string; ws?: { readyState?: number } } | null;
  };
  /**
   * Optional override for the SSRF / DNS-resolution check that runs at the top
   * of every handleRequest. Defaults to `resolveAndCheckTarget` (production:
   * blocks private/loopback ranges and rewrites the URL to the resolved IP).
   * Tests pass a permissive function that returns a synthetic SafeResolution
   * so localhost upstreams aren't blocked.
   */
  ssrfCheck?: (target_url: string) => Promise<SafeResolution>;
  privateTunnel?: {
    authorize(target: PrivateTunnelTarget): void | Promise<void>;
    execute(target: PrivateTunnelTarget, input: {
      method: string;
      headers?: Headers;
      body?: RequestBody;
    }): Promise<TunnelHttpResponse>;
  };
}

export interface ProxyResponse {
  status:            number;
  statusText:        string;
  headers:           Record<string, unknown>;
  data:              unknown;
  timestamp:         number;
  cached?:           boolean;
  payment_required?: boolean;
  dedupe_key?:       string;
  served_by?:        string;
}

export interface ProxyStats {
  cache_size:       number;
  pending_requests: number;
  paid_keys:        number;
  total_requests:   number;
  cache_hits:       number;
  cache_misses:     number;
  hit_rate:         number;
  cache_stats:      ReturnType<NodeCache['getStats']>;
  router_stats:     ReturnType<Router['getStats']>;
}

interface TunnelDedupeParams {
  target_ref: PrivateTunnelTarget;
  method:     string;
  headers?:   Headers;
  body?:      RequestBody;
}


// ── Request/response size caps ─────────────────────────────────────────────────
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;  // 50 MB
const MAX_BODY_BYTES     = 10 * 1024 * 1024;  // 10 MB

// ── Cache TTL bounds ──────────────────────────────────────────────────────────
// Upper bound for any caller-supplied cache TTL (x-cache-ttl header or arg).
// Prevents a misconfigured/malicious caller from locking a poisoned response in
// the shared global-scope cache for an unbounded period.  1 hour is enough for
// typical micro-cache use cases; long-TTL data should come from upstream cache
// headers, not from a caller hint.
const MAX_CACHE_TTL_SEC = 3_600;

const STRIP_REQUEST_HEADERS = new Set([
  'host', 'content-length', 'content-encoding', 'transfer-encoding', 'connection',
  'x-idempotency-key', 'idempotency-key',
  'x-payment', 'x-verbose', 'x-api-key', 'x-cache-ttl',
  'x-node-region', 'x-node-domain', 'x-node-exclude',
  'x-forwarded-for', 'x-real-ip', 'forwarded',
]);

const BODY_METHODS  = new Set(['post', 'put', 'patch']);

// Rewrites the URL so its host is the pre-resolved IP, eliminating any
// second DNS lookup by the HTTP stack (closes the SSRF TOCTOU window).
function buildSafeUrl(originalUrl: string, resolved: SafeResolution): string {
  if (resolved.isLiteral) return originalUrl;
  const u = new URL(originalUrl);
  u.hostname = resolved.family === 6 ? `[${resolved.ip}]` : resolved.ip;
  return u.toString();
}

function encodeRequestBody(body: RequestBody): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function getPrivateTunnelScope(headers: Headers): string {
  const sensitive: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'x-api-key') {
      sensitive[lower] = sha256Hex(value);
    }
  }
  return Object.keys(sensitive).length > 0 ? sha256Hex(stableStringify(sensitive)) : 'global';
}

function canonicalizeTunnelPath(raw: string): string {
  if (!raw.startsWith('/')) throw new TypeError(`Invalid tunnel path: ${raw}`);
  const canonical = new URL(canonicalizeUrl(new URL(raw, 'http://private-tunnel.invalid').toString()));
  return `${canonical.pathname}${canonical.search}`;
}

function generateTunnelDedupeKey({ target_ref, method, headers = {}, body }: TunnelDedupeParams): string {
  if (target_ref?.kind !== 'tunnel' || !target_ref.tunnel_id) {
    throw new TypeError('Invalid private tunnel target');
  }
  const canonical = {
    v:         1,
    scope:     getPrivateTunnelScope(headers),
    method:    method.toUpperCase(),
    tunnel_id: target_ref.tunnel_id,
    path:      canonicalizeTunnelPath(target_ref.path),
    headers:   canonicalizeSemanticHeaders(headers),
    body_hash: computeBodyHash(body),
  };
  return sha256Hex(stableStringify(canonical));
}

export default class ConsensusProxy {
  private cache:           NodeCache;
  private pendingRequests: Map<string, Promise<ProxyResponse>>;
  private paidKeys:        Map<string, number>;
  private stats:           { total_requests: number; cache_hits: number; cache_misses: number };
  private router:          Router;
  private nodeTunnel?:     ProxyConfig['nodeTunnel'];
  private privateTunnel?:  ProxyConfig['privateTunnel'];
  private ssrfCheck:       (target_url: string) => Promise<SafeResolution>;
  private cleanupTimer:    ReturnType<typeof setInterval>;

  constructor(config: ProxyConfig = {}) {
    this.cache = new NodeCache({
      stdTTL:      300,
      checkperiod: 60,
      useClones:   false,
      maxKeys:     10_000,
    });

    this.pendingRequests = new Map();
    this.paidKeys        = new Map();
    this.stats           = { total_requests: 0, cache_hits: 0, cache_misses: 0 };
    this.router          = config.router ?? new Router();
    this.nodeTunnel      = config.nodeTunnel;
    this.privateTunnel   = config.privateTunnel;
    this.ssrfCheck       = config.ssrfCheck ?? resolveAndCheckTarget;
    this.cleanupTimer    = setInterval(() => this.cleanupExpiredKeys(), 60_000);
    this.cleanupTimer.unref();
  }

  requiresPayment(dedupeKey: string): boolean {
    return !(this.cache.has(dedupeKey) || this.paidKeys.has(dedupeKey));
  }

  markAsPaid(dedupeKey: string): void {
    this.paidKeys.set(dedupeKey, Date.now());
  }

  removePaidStatus(dedupeKey: string): void {
    this.paidKeys.delete(dedupeKey);
  }

  async handleRequest(
    target_url: string,
    method:     string,
    headers:    Headers = {},
    body?:      RequestBody,
    cacheTTL?:  number,
  ): Promise<ProxyResponse> {
    try { new URL(target_url); } catch {
      throw new TypeError(`Invalid target_url: ${target_url}`);
    }

    const resolved = await this.ssrfCheck(target_url);

    const dedupeKey = generateDedupeKey({ target_url, method, headers, body });
    console.log(`[Dedupe] ${dedupeKey.slice(0, 12)}... | ${method} ${target_url}`);

    const ttlRaw      = headers['x-cache-ttl']
      ?? Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-cache-ttl')?.[1];
    const ttlFromHdr  = ttlRaw !== undefined ? Number(ttlRaw) : NaN;
    const resolvedTTL = cacheTTL !== undefined ? cacheTTL
                      : Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0 ? ttlFromHdr
                      : 300;
    // Clamp to [1, MAX_CACHE_TTL_SEC] — prevents cache-poisoning via huge TTL hints
    const ttl = Math.min(MAX_CACHE_TTL_SEC, resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL));

    this.stats.total_requests++;
    const cached = this.cache.get<ProxyResponse>(dedupeKey);
    if (cached) {
      this.stats.cache_hits++;
      console.log(`[Cache HIT] ${dedupeKey.slice(0, 12)}...`);
      return { ...cached, cached: true, payment_required: false, dedupe_key: dedupeKey };
    }

    const pending = this.pendingRequests.get(dedupeKey);
    if (pending) {
      this.stats.cache_hits++;
      console.log(`[Cache HIT - Pending] ${dedupeKey.slice(0, 12)}...`);
      const response = await pending;
      return { ...response, cached: true, payment_required: false, dedupe_key: dedupeKey };
    }

    this.stats.cache_misses++;
    console.log(`[Cache MISS] ${dedupeKey.slice(0, 12)}... | TTL: ${ttl}s`);

    const node = this.router.selectNode(dedupeKey, headers) as NodeRecord | null;

    // In-flight coalescing: register the promise BEFORE awaiting so any
    // concurrent caller for the same dedupe key joins this work instead of
    // duplicating the upstream call. Without this, a burst of N concurrent
    // requests fan out into N upstream fetches and N "Cache MISS" log lines.
    const promise: Promise<ProxyResponse> = (node && typeof node.id === 'string')
      ? this.executeViaNode(node, target_url, method, headers, body, dedupeKey, ttl, resolved)
      : (console.log('[Self-Fallback] No nodes available, executing directly'),
         this.executeDirect(target_url, method, headers, body, dedupeKey, ttl, resolved));

    this.pendingRequests.set(dedupeKey, promise);
    try {
      return await promise;
    } finally {
      this.pendingRequests.delete(dedupeKey);
    }
  }

  async authorizeTunnelTarget(target: PrivateTunnelTarget): Promise<void> {
    if (!this.privateTunnel) throw new TypeError('Private tunnel proxying is unavailable');
    await this.privateTunnel.authorize(target);
  }

  async handleTunnelRequest(
    target_ref: PrivateTunnelTarget,
    method:     string,
    headers:    Headers = {},
    body?:      RequestBody,
    cacheTTL?:  number,
  ): Promise<ProxyResponse> {
    await this.authorizeTunnelTarget(target_ref);
    const dedupeKey = generateTunnelDedupeKey({ target_ref, method, headers, body });
    const ttlRaw = headers['x-cache-ttl']
      ?? Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-cache-ttl')?.[1];
    const ttlFromHdr = ttlRaw !== undefined ? Number(ttlRaw) : NaN;
    const resolvedTTL = cacheTTL !== undefined ? cacheTTL
      : Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0 ? ttlFromHdr
      : 300;
    const ttl = Math.min(MAX_CACHE_TTL_SEC, resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL));

    this.stats.total_requests++;
    const cached = this.cache.get<ProxyResponse>(dedupeKey);
    if (cached) {
      this.stats.cache_hits++;
      return { ...cached, cached: true, payment_required: false, dedupe_key: dedupeKey };
    }

    const pending = this.pendingRequests.get(dedupeKey);
    if (pending) {
      this.stats.cache_hits++;
      const response = await pending;
      return { ...response, cached: true, payment_required: false, dedupe_key: dedupeKey };
    }

    this.stats.cache_misses++;
    const promise = this.privateTunnel!.execute(target_ref, { method, headers, body })
      .then((response): ProxyResponse => {
        const finalResponse: ProxyResponse = {
          ...response,
          cached: false,
          payment_required: true,
          dedupe_key: dedupeKey,
          served_by: 'private-tunnel',
        };
        if (response.status >= 200 && response.status < 300) {
          this.cache.set(dedupeKey, finalResponse, ttl);
        }
        return finalResponse;
      })
      .catch((error) => {
        this.removePaidStatus(dedupeKey);
        throw error;
      });

    this.pendingRequests.set(dedupeKey, promise);
    try {
      return await promise;
    } finally {
      this.pendingRequests.delete(dedupeKey);
    }
  }

  private async executeViaNode(
    node:       NodeRecord,
    target_url: string,
    method:     string,
    headers:    Headers,
    body:       RequestBody,
    dedupeKey:  string,
    ttl:        number,
    resolved:   SafeResolution,
  ): Promise<ProxyResponse> {
    this.router.incrementRequest(node.id);

    try {
      console.log(`[Route to Node] ${node.id} (${node.region})`);

      // The orchestrator registers itself for routing, but it never opens a
      // control tunnel or needs to proxy through its own public domain.
      if (node.id === 'server') {
        console.log('[Route to Self] Selected orchestrator node');
        return this.executeDirect(target_url, method, headers, body, dedupeKey, ttl, resolved);
      }

      const forwardHeaders: Headers = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) forwardHeaders[k] = v;
      }

      // Avoid entering a tunnel implementation that cannot currently deliver
      // to the selected node. requestProxy checks again to cover disconnects.
      const session = this.nodeTunnel?.getNodeSession?.(node.id);
      if (session?.mode === 'control' && session.ws?.readyState === WebSocket.OPEN) {
        try {
          const result = await this.executeViaTunnel(node, target_url, method, forwardHeaders, body);
          const finalResult = { ...result, cached: false, payment_required: true, dedupe_key: dedupeKey, served_by: node.id };
          if (result.status >= 200 && result.status < 300) {
            this.cache.set(dedupeKey, finalResult, ttl);
          }
          return finalResult;
        } catch (error) {
          console.error(`[Node Tunnel Error] ${node.id}:`, (error as Error).message);
        }
      }

      if (!node.domain) {
        console.log('[Fallback to Self] Selected node has no domain/control tunnel');
        return this.executeDirect(target_url, method, headers, body, dedupeKey, ttl, resolved);
      }

      const response = await axios({
        method:     'POST',
        url:        `https://${node.domain}/proxy`,
        headers:    { 'Content-Type': 'application/json' },
        data:       { target_url, method, headers: forwardHeaders, body },
        timeout:    35_000,
        httpsAgent,
      });

      const result = response.data as ProxyResponse;

      if (
        result && typeof result.status === 'number' &&
        result.status >= 200 && result.status < 300
      ) {
        this.cache.set(dedupeKey, { ...result, cached: false, payment_required: true, dedupe_key: dedupeKey, served_by: node.id }, ttl);
      }

      return { ...result, cached: false, payment_required: true, dedupe_key: dedupeKey, served_by: node.id };
    } catch (error) {
      console.error(`[Node Error] ${node.id}:`, (error as Error).message);
      console.log('[Fallback to Self] Executing directly');
      return this.executeDirect(target_url, method, headers, body, dedupeKey, ttl, resolved);
    } finally {
      this.router.decrementRequest(node.id);
    }
  }

  private async executeViaTunnel(
    node:       NodeRecord,
    target_url: string,
    method:     string,
    headers:    Headers,
    body:       RequestBody,
  ): Promise<ProxyResponse> {
    const result = await this.nodeTunnel!.requestProxy(node.id, {
      target_url,
      method,
      headers,
      body: encodeRequestBody(body),
      body_encoding: 'utf8',
    });

    const text = result.body_encoding === 'base64'
      ? Buffer.from(result.body ?? '', 'base64').toString('utf8')
      : result.body ?? '';

    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    return {
      status:     result.status,
      statusText: result.status_text ?? '',
      headers:    result.headers ?? {},
      data,
      timestamp:  Date.now(),
    };
  }

  private async executeDirect(
    target_url: string,
    method:     string,
    headers:    Headers,
    body:       RequestBody,
    dedupeKey:  string,
    ttl:        number,
    resolved:   SafeResolution,
  ): Promise<ProxyResponse> {
    // Pending-request registration and leak-guard are owned by handleRequest so
    // they cover both this path and executeViaNode uniformly.
    try {
      const response = await this.makeRequest(target_url, method, headers, body, resolved);
      const finalResponse = { ...response, cached: false, payment_required: true, dedupe_key: dedupeKey, served_by: 'proxy-direct' };
      if (response.status >= 200 && response.status < 300) {
        this.cache.set(dedupeKey, finalResponse, ttl);
        console.log(`[Cache STORED] ${dedupeKey.slice(0, 12)}... | TTL: ${ttl}s`);
      }
      return finalResponse;
    } catch (error) {
      this.removePaidStatus(dedupeKey);
      throw error;
    }
  }

  private async makeRequest(
    url:      string,
    method:   string,
    headers:  Headers,
    body?:    RequestBody,
    resolved?: SafeResolution,
  ): Promise<ProxyResponse> {
    const cleanHeaders: Headers = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (!STRIP_REQUEST_HEADERS.has(lower)) cleanHeaders[lower] = String(v);
    }
    cleanHeaders['user-agent'] = 'Consensus-Proxy/2.0';

    const lowerMethod = method.toLowerCase();
    const withBody    = BODY_METHODS.has(lowerMethod);

    if (withBody && body && !cleanHeaders['content-type'] && typeof body === 'object') {
      cleanHeaders['content-type'] = 'application/json';
    }

    // Rewrite the URL to the pre-resolved IP so the HTTP stack never performs a
    // second DNS lookup.  The original hostname goes into the Host header (required
    // for virtual-host routing) and, for HTTPS, into the agent's servername option
    // so TLS SNI and certificate validation still target the correct hostname.
    let requestUrl        = url;
    let requestHttpsAgent = httpsAgent;
    if (resolved && !resolved.isLiteral) {
      requestUrl = buildSafeUrl(url, resolved);
      cleanHeaders['host'] = resolved.hostname;
      if (url.startsWith('https:')) {
        // Per-request agent: keepAlive disabled because each proxied target is
        // a different server so there is nothing to pool across requests.
        requestHttpsAgent = new https.Agent({
          keepAlive: false,
          timeout:   30_000,
          servername: resolved.hostname,
        });
      }
    }

    try {
      const response = await axios({
        method:           lowerMethod,
        url:              requestUrl,
        headers:          cleanHeaders,
        data:             withBody ? body : undefined,
        timeout:          30_000,
        validateStatus:   () => true,
        maxRedirects:     5,
        decompress:       false,
        responseType:     'arraybuffer',
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength:    MAX_BODY_BYTES,
        httpAgent,
        httpsAgent:       requestHttpsAgent,
      });

      let raw: Buffer = Buffer.isBuffer(response.data)
        ? response.data
        : Buffer.from(response.data as ArrayBuffer);
      const enc = String(response.headers['content-encoding'] ?? '').toLowerCase();
      if      (enc === 'gzip')    raw = await gunzipAsync(raw);
      else if (enc === 'deflate') raw = await inflateAsync(raw);
      else if (enc === 'br')      raw = await brotliDecompressAsync(raw);

      const text = raw.toString('utf8');
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }

      return {
        status:     response.status,
        statusText: response.statusText,
        headers:    response.headers as Record<string, unknown>,
        data,
        timestamp:  Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const axiosErr = error as { response?: { status: number }; code?: string };
      throw Object.assign(new Error(message), {
        upstreamStatus: axiosErr.response?.status,
        code:           axiosErr.code,
        url,
      });
    }
  }

  computeDedupeKey(params: DedupeParams): string {
    return generateDedupeKey(params);
  }

  computeTunnelDedupeKey(params: TunnelDedupeParams): string {
    return generateTunnelDedupeKey(params);
  }

  getCached(dedupeKey: string): ProxyResponse | null {
    return this.cache.get<ProxyResponse>(dedupeKey) ?? null;
  }

  getPaymentStatus(dedupeKey: string): { is_cached: boolean; is_paid: boolean; requires_payment: boolean } {
    const is_cached = this.cache.has(dedupeKey);
    const is_paid   = this.paidKeys.has(dedupeKey);
    return {
      is_cached,
      is_paid,
      requires_payment: !(is_cached || is_paid),
    };
  }

  getStats(): ProxyStats {
    const { total_requests, cache_hits, cache_misses } = this.stats;
    const cacheStats = this.cache.getStats();
    return {
      cache_size:       cacheStats.keys,
      pending_requests: this.pendingRequests.size,
      paid_keys:        this.paidKeys.size,
      total_requests,
      cache_hits,
      cache_misses,
      hit_rate:         total_requests > 0 ? cache_hits / total_requests : 0,
      cache_stats:      cacheStats,
      router_stats:     this.router.getStats(),
    };
  }

  clearKey(dedupeKey: string): void {
    this.cache.del(dedupeKey);
    this.paidKeys.delete(dedupeKey);

    this.pendingRequests.delete(dedupeKey);
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.cache.close();
  }

  private cleanupExpiredKeys(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, ts] of this.paidKeys) {
      if (ts < cutoff) this.paidKeys.delete(key);
    }
  }
}
