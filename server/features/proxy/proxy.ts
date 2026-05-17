import NodeCache                          from 'node-cache';
import axios                             from 'axios';
import http                              from 'node:http';
import https                             from 'node:https';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { promisify }                     from 'node:util';
import crypto                            from 'node:crypto';
import Router                            from '../../router.ts';
import { resolveAndCheckTarget, type SafeResolution } from '../../utils/ssrf.ts';

const httpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 64, timeout: 30_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 30_000 });

const gunzipAsync           = promisify(gunzip);
const inflateAsync          = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);

type RequestBody = string | Buffer | Record<string, unknown> | unknown[] | null | undefined;
type Headers     = Record<string, string>;

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

interface DedupeParams {
  target_url: string;
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
const ALLOW_HEADERS = new Set(['accept', 'content-type']);
const MULTI_SPACE   = /\s+/g;

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Rewrites the URL so its host is the pre-resolved IP, eliminating any
// second DNS lookup by the HTTP stack (closes the SSRF TOCTOU window).
function buildSafeUrl(originalUrl: string, resolved: SafeResolution): string {
  if (resolved.isLiteral) return originalUrl;
  const u = new URL(originalUrl);
  u.hostname = resolved.family === 6 ? `[${resolved.ip}]` : resolved.ip;
  return u.toString();
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]): [string, unknown] => [k, deepSort(v)])
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(deepSort(value));
}

function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);  // throws TypeError for invalid URLs — callers must validate first
  u.hash     = '';
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  if (
    (u.protocol === 'https:' && u.port === '443') ||
    (u.protocol === 'http:'  && u.port === '80')
  ) u.port = '';

  const params = [...u.searchParams.entries()].sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return  1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return  1;
    return 0;
  });

  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

function canonicalizeSemanticHeaders(headers: Headers): Headers {
  // Two-phase: collect the two allowed keys, then emit in fixed alphabetical order
  // so the result is deterministic without a sort step ('accept' < 'content-type').
  const result: Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();                          // HTTP names have no surrounding whitespace
    if (ALLOW_HEADERS.has(lower)) result[lower] = v.trim().replace(MULTI_SPACE, ' ');
  }
  const ordered: Headers = {};
  if (result['accept'])       ordered['accept']       = result['accept'];
  if (result['content-type']) ordered['content-type'] = result['content-type'];
  return ordered;
}

function computeBodyHash(body: RequestBody): string {
  if (body === undefined || body === null) return 'no-body';
  if (Buffer.isBuffer(body))              return sha256Hex(body);
  if (typeof body === 'string')           return sha256Hex(body);
  return sha256Hex(stableStringify(body));
}

function encodeRequestBody(body: RequestBody): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function getScope(headers: Headers): string {
  for (const k in headers) {
    if (k.toLowerCase() === 'x-api-key') return sha256Hex(headers[k]!);
  }
  return 'global';
}

function generateDedupeKey({ target_url, method, headers = {}, body }: DedupeParams): string {
  const semanticHeaders = canonicalizeSemanticHeaders(headers);
  const canonical = {
    v:         1,
    scope:     getScope(headers),
    method:    method.toUpperCase(),
    url:       canonicalizeUrl(target_url),
    headers:   semanticHeaders,
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

    const resolved = await resolveAndCheckTarget(target_url);

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
    if (node && typeof node.id === 'string') {
      return this.executeViaNode(node, target_url, method, headers, body, dedupeKey, ttl, resolved);
    }

    console.log('[Self-Fallback] No nodes available, executing directly');
    return this.executeDirect(target_url, method, headers, body, dedupeKey, ttl, resolved);
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

      const forwardHeaders: Headers = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) forwardHeaders[k] = v;
      }

      if (this.nodeTunnel) {
        try {
          const result = await this.executeViaTunnel(node, target_url, method, forwardHeaders, body);
          if (result.status >= 200 && result.status < 300) {
            this.cache.set(dedupeKey, result, ttl);
          }
          return { ...result, cached: false, payment_required: true, dedupe_key: dedupeKey, served_by: node.id };
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
        this.cache.set(dedupeKey, result, ttl);
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
      if (response.status >= 200 && response.status < 300) {
        this.cache.set(dedupeKey, response, ttl);
        console.log(`[Cache STORED] ${dedupeKey.slice(0, 12)}... | TTL: ${ttl}s`);
      }
      return { ...response, cached: false, payment_required: true, dedupe_key: dedupeKey, served_by: 'proxy-direct' };
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