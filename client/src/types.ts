export type ConsensusSocketModel = 'hybrid' | 'time' | 'data';

export type ConsensusSocketTokenAuth = {
  token: string;
  connect_url: string;
  expires_in: number;
};

export type ConsensusSocketConnectTarget = {
  connect_url: string;
  token?: string;
  expires_in?: number;
};

export type ConsensusSocketCallbacks = {
  onOpen?: () => void;
  onMessage?: (data: unknown) => void;
  onClose?: (event?: unknown) => void;
  onError?: (error: unknown) => void;
};

export type ConsensusSocketSafeResult<T> = {
  ok: boolean;
  data?: T;
  error?: unknown;
};

export type ConsensusSocketSessionState = {
  connected: boolean;
  reconnecting: boolean;
  closedByCaller: boolean;
};

export type ConsensusSocketSession = {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'close' | 'error', handler: (...args: unknown[]) => void): void;
  off(event: 'open' | 'message' | 'close' | 'error', handler: (...args: unknown[]) => void): void;
  getState(): ConsensusSocketSessionState;
};

export type ConsensusSocketClientOptions = {
  /** Custom WebSocket constructor; auto-detected when omitted. */
  webSocketFactory?: new (...args: unknown[]) => unknown;
  /** Max time to wait for socket open before failing. */
  openTimeoutMs?: number;
  /** Fixed delay between reconnect attempts. */
  reconnectIntervalMs?: number;
  /** Default token params merged into every requestToken call. */
  defaults?: ConsensusSocketTokenParams;
  /** Maximum websocket spend in USD (up to 6 decimals) before stand-down. */
  limit_usd?: number;
  /** Callback fired once when websocket budget is exhausted. */
  on_limit_reached?: (budget: ConsensusSocketBudgetSnapshot) => void;
};

export type ConsensusSocketClient = {
  requestToken(
    params?: ConsensusSocketTokenParams,
    options?: { safe?: false }
  ): Promise<ConsensusSocketTokenAuth>;
  requestToken(
    params: ConsensusSocketTokenParams | undefined,
    options: { safe: true }
  ): Promise<ConsensusSocketSafeResult<ConsensusSocketTokenAuth>>;
  connect(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks?: ConsensusSocketCallbacks,
    options?: { safe?: false }
  ): Promise<ConsensusSocketSession>;
  connect(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks: ConsensusSocketCallbacks | undefined,
    options: { safe: true }
  ): Promise<ConsensusSocketSafeResult<ConsensusSocketSession>>;
  getBudget(): ConsensusSocketBudgetSnapshot;
  resetBudget(): void;
  isStandDown(): boolean;
};

export type ConsensusSocketBudgetSnapshot = {
  /** Configured max spend in USD, or null when no limit is configured. */
  limit_usd: number | null;
  /** Total spent so far in USD. */
  spent_usd: number;
  /** Remaining budget in USD, or null when unlimited. */
  remaining_usd: number | null;
  /** True when token purchase is blocked by the budget guard. */
  exhausted: boolean;
  /** Last locally quoted token/session cost in USD. */
  last_quote_usd: number;
};

export type SocketEventName = 'open' | 'message' | 'close' | 'error';

export type SocketLike = {
  readyState: number;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
export type SessionPricing = {
  model: ConsensusSocketModel;
  pricePerMinute: number;
  pricePerMB: number;
};

export type ConsensusSocketTokenParams = {
  /** Billing model used to calculate token/session price. */
  model?: ConsensusSocketModel;
  /** Session duration to purchase (integer minutes, >= 0). */
  minutes?: number;
  /** Session data allowance to purchase (integer MB, >= 0). */
  megabytes?: number;
  /** Optional preferred node region during token request (for example "us-east"). */
  nodeRegion?: string;
  /** Optional hard route to a specific node domain during token request. */
  nodeDomain?: string;
  /** Optional node/domain to exclude from routing during token request. */
  nodeExclude?: string;
};

export class SocketClientError extends Error {
  /** HTTP status from token endpoint when available. */
  status?: number;
  /** Parsed server error payload when available. */
  data?: unknown;
}

/** Thrown when requested token cost exceeds remaining websocket budget. */
export class SocketBudgetLimitError extends SocketClientError {}

export const PRICING_PRESETS: Record<'TIME' | 'DATA' | 'HYBRID', SessionPricing> = {
  TIME: {
    model: 'time',
    pricePerMinute: 0.001,
    pricePerMB: 0,
  },
  DATA: {
    model: 'data',
    pricePerMinute: 0,
    pricePerMB: 0.00012,
  },
  HYBRID: {
    model: 'hybrid',
    pricePerMinute: 0.0005,
    pricePerMB: 0.0001,
  },
};


/*------proxy types----*/

export type ProxyMode = 'inclusive' | 'exclusive';
export type ProxyStrategy = 'auto' | 'manual';

export type ProxyBudgetSnapshot = {
  /** Configured max spend in USD, or null when no limit is configured. */
  limit_usd: number | null;
  /** Fixed proxy charge applied per paid /proxy request. */
  request_cost_usd: number;
  /** Total spent so far in USD. */
  spent_usd: number;
  /** Remaining budget in USD, or null when unlimited. */
  remaining_usd: number | null;
  /** True when proxying is in stand-down mode due to budget limits. */
  exhausted: boolean;
};

export type ProxyClientOptions = {
  /**
   * Route filtering behavior for inbound server paths.
   * - "inclusive": proxy everything except `routes`
   * - "exclusive": proxy only `routes`
   */
  mode?: ProxyMode;
  /**
   * Path rules used with `mode`, for example `["/health", "/metrics"]`.
   * Query params are ignored; matching is based on path only.
   */
  routes?: string[];
  /**
   * Path matcher behavior for `routes`.
   * - false (default): exact path only (`/route` does not match `/route/subroute`)
   * - true: include subroutes (`/route` matches `/route/*`)
   */
  matchSubroutes?: boolean;
  /**
   * Interception strategy.
   * - "auto": globally intercepts `fetch` for route-matched request scope
   * - "manual": does not intercept global `fetch`; use `req.consensus.fetch` / `request`
   */
  strategy?: ProxyStrategy;
  /**
   * Cache time-to-live in seconds for proxy responses.
   * Sent as `x-cache-ttl`; controls how long deduped responses can be reused.
   */
  cache_ttl?: number;
  /**
   * Enables verbose proxy response payload.
   * When true, proxy responses include `meta` with fields like:
   * `cached`, `dedupe_key`, `processing_ms`, and `timestamp`.
   */
  verbose?: boolean;
  /** Preferred proxy region, for example "us-east". Sent as `x-node-region`. */
  node_region?: string;
  /**
   * Force routing through a specific node domain, for example:
   * `nodexyz.consensus.canister.software`.
   * Sent as `x-node-domain`.
   */
  node_domain?: string;
  /** Exclude a specific node/domain from routing. Sent as `x-node-exclude`. */
  node_exclude?: string;
  /**
   * Max proxy spend in USD (up to 6 decimals).
   * Once exhausted, ProxyClient stands down and uses direct fetch.
   */
  limit_usd?: number;
  /** Callback fired once when budget is exhausted and stand-down is activated. */
  on_limit_reached?: (budget: ProxyBudgetSnapshot) => void;
};

export type ProxyPayload = {
  target_url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type ProxyResponseShape = {
  /** HTTP status code returned by proxy response. */
  status: number;
  /** HTTP reason phrase from proxy response. */
  statusText: string;
  /** Response headers returned by proxy. */
  headers: Record<string, string>;
  /** Parsed response payload from proxy target response. */
  data: unknown;
  /**
   * Optional verbose proxy metadata. Common keys:
   * cached, dedupe_key, processing_ms, timestamp.
   */
  meta: {
    cached?: boolean;
    dedupe_key?: string;
    processing_ms?: number;
    timestamp?: string;
    [key: string]: unknown;
  } | null;
};
type FetchWithPayment = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ConsensusContext = {
  strategy: ProxyStrategy;
  shouldProxy: boolean;
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<Response>;
  request: (
    payload: Partial<ProxyPayload>,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<ProxyResponseShape>;
  passthroughFetch: FetchWithPayment | null;
  createFetch: (pathname?: string) => FetchWithPayment;
  getBudget: () => ProxyBudgetSnapshot;
  isStandDown: () => boolean;
};

export type MiddlewareReq = {
  path?: string;
  url?: string;
  consensus?: ConsensusContext;
  [key: string]: unknown;
};

export type Next = (err?: unknown) => void;

export class ProxyClientError extends Error {
  /** HTTP status from proxy response when available. */
  status?: number;
  /** Parsed proxy error payload when available. */
  data?: unknown;
}

export type ProxyClientRuntime = {
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<Response>;
  request: (
    payload: Partial<ProxyPayload>,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<ProxyResponseShape>;
  runWithPath: <T>(pathname: string, run: () => T | Promise<T>) => Promise<T>;
  createFetch: (pathname?: string) => FetchWithPayment;
  getBudget: () => ProxyBudgetSnapshot;
  resetBudget: () => void;
  isStandDown: () => boolean;
};

export type ProxyClientMiddleware = ((req: MiddlewareReq, res: unknown, next: Next) => void) &
  ProxyClientRuntime;