export interface ProxyClientOptions {
  mode?: "inclusive" | "exclusive";
  routes?: string[];
  matchSubroutes?: boolean;
  strategy?: "auto" | "manual";
  cache_ttl?: number;
  verbose?: boolean;
  node_region?: string;
  node_domain?: string;
  node_exclude?: string;
}

export interface ProxyClientRequestContext {
  consensus?: {
    strategy?: "auto" | "manual";
    shouldProxy?: boolean;
    fetch?: (
      input: RequestInfo | URL,
      init?: RequestInit,
      perRequestOptions?: Partial<ProxyClientOptions>
    ) => Promise<Response>;
    request?: (
      payload: {
        target_url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: unknown;
      },
      perRequestOptions?: Partial<ProxyClientOptions>
    ) => Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      data: unknown;
      meta: unknown;
    }>;
    passthroughFetch?: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null;
  };
  [key: string]: unknown;
}

export type ProxyClientMiddleware = (
  req: ProxyClientRequestContext,
  res: unknown,
  next: (err?: unknown) => void
) => void;

export declare function ProxyClient(
  fetchWithPayment: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options?: ProxyClientOptions
): ProxyClientMiddleware;

export type ConsensusSocketModel = "hybrid" | "time" | "data";

export interface ConsensusSocketTokenParams {
  model?: ConsensusSocketModel;
  minutes?: number;
  megabytes?: number;
  nodeRegion?: string;
  nodeDomain?: string;
  nodeExclude?: string;
}

export interface ConsensusSocketTokenAuth {
  token: string;
  connect_url: string;
  expires_in: number;
}

export interface ConsensusSocketConnectTarget {
  connect_url: string;
  token?: string;
  expires_in?: number;
}

export interface ConsensusSocketCallbacks {
  onOpen?: () => void;
  onMessage?: (data: unknown) => void;
  onClose?: (event?: unknown) => void;
  onError?: (error: unknown) => void;
}

export interface ConsensusSocketSafeResult<T> {
  ok: boolean;
  data?: T;
  error?: unknown;
}

export interface ConsensusSocketSessionState {
  connected: boolean;
  reconnecting: boolean;
  closedByCaller: boolean;
}

export interface ConsensusSocketSession {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "message" | "close" | "error", handler: (...args: unknown[]) => void): void;
  off(event: "open" | "message" | "close" | "error", handler: (...args: unknown[]) => void): void;
  getState(): ConsensusSocketSessionState;
}

export interface ConsensusSocketClientOptions {
  webSocketFactory?: new (...args: unknown[]) => unknown;
  openTimeoutMs?: number;
  reconnectIntervalMs?: number;
  defaults?: ConsensusSocketTokenParams;
}

export interface ConsensusSocketClient {
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
}

export declare function SocketClient(
  fetchWithPayment: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options?: ConsensusSocketClientOptions
): ConsensusSocketClient;
