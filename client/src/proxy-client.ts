import { AsyncLocalStorage } from "async_hooks";

const DEFAULT_SERVER_URL =
  process.env.CONSENSUS_SERVER_URL || "https://consensus.canister.software";

type FetchWithPayment = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ProxyMode = "inclusive" | "exclusive";
type ProxyStrategy = "auto" | "manual";

type ProxyClientOptions = {
  mode?: ProxyMode;
  routes?: string[];
  matchSubroutes?: boolean;
  strategy?: ProxyStrategy;
  cache_ttl?: number;
  verbose?: boolean;
  node_region?: string;
  node_domain?: string;
  node_exclude?: string;
};

type ProxyPayload = {
  target_url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

type ProxyResponseShape = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
  meta: unknown;
};

type ConsensusContext = {
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
};

type MiddlewareReq = {
  path?: string;
  url?: string;
  consensus?: ConsensusContext;
  [key: string]: unknown;
};

type Next = (err?: unknown) => void;

class ProxyClientError extends Error {
  status?: number;
  data?: unknown;
}

const proxyFetchContext = new AsyncLocalStorage<{ proxyFetch: FetchWithPayment | null }>();
let interceptorInstalled = false;
let passthroughFetch: FetchWithPayment | null =
  typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;

function trimTrailingSlash(value: string): string {
  return String(value || "").replace(/\/+$/, "");
}

function normalizePath(value: string): string {
  const path = String(value || "/").split("?")[0] || "/";
  if (path === "/") return "/";
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
}

function normalizeHeaders(headers?: HeadersInit | null): Record<string, string> {
  if (!headers) return {};

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [String(key), String(value)])
    );
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined" || value === null) continue;
    result[key] = String(value);
  }
  return result;
}

function pathMatches(pathname: string, route: string, matchSubroutes = false): boolean {
  const requestPath = normalizePath(pathname);
  const configuredRoute = normalizePath(route);

  if (requestPath === configuredRoute) return true;
  if (!matchSubroutes) return false;
  if (configuredRoute === "/") return true;

  return requestPath.startsWith(`${configuredRoute}/`);
}

function shouldProxyPath(pathname: string, options: ProxyClientOptions): boolean {
  const mode: ProxyMode = options.mode === "exclusive" ? "exclusive" : "inclusive";
  const routes = Array.isArray(options.routes) ? options.routes : [];
  const matchSubroutes = Boolean(options.matchSubroutes);
  const matched = routes.some((route) =>
    pathMatches(pathname, route, matchSubroutes)
  );

  return mode === "exclusive" ? matched : !matched;
}

function controlHeadersFromOptions(options: Partial<ProxyClientOptions>): Record<string, string> {
  const headers: Record<string, string> = {};

  if (typeof options.cache_ttl !== "undefined" && options.cache_ttl !== null) {
    headers["x-cache-ttl"] = String(options.cache_ttl);
  }
  if (options.verbose === true) {
    headers["x-verbose"] = "true";
  }
  if (typeof options.node_region === "string" && options.node_region.trim()) {
    headers["x-node-region"] = options.node_region.trim();
  }
  if (typeof options.node_domain === "string" && options.node_domain.trim()) {
    headers["x-node-domain"] = options.node_domain.trim();
  }
  if (typeof options.node_exclude === "string" && options.node_exclude.trim()) {
    headers["x-node-exclude"] = options.node_exclude.trim();
  }

  return headers;
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeBody(body: BodyInit | object | null | undefined, headers: Record<string, string>): unknown {
  if (typeof body === "undefined" || body === null) return undefined;
  if (typeof body === "string") return body;
  if (typeof body === "number" || typeof body === "boolean") return body;

  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }
    return body.toString();
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("utf8");
    return new TextDecoder().decode(bytes);
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    throw new Error("FormData request bodies are not supported by ProxyClient");
  }

  if (typeof body === "object") {
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    return body;
  }

  throw new Error(`Unsupported request body type: ${typeof body}`);
}

async function buildProxyPayload(
  input: RequestInfo | URL,
  init: RequestInit = {},
  controlHeaders: Record<string, string>
): Promise<ProxyPayload> {
  let targetUrl: string;
  let method = "GET";
  let headers: Record<string, string> = {};
  let body: BodyInit | object | null | undefined;

  if (typeof Request !== "undefined" && input instanceof Request) {
    targetUrl = input.url;
    method = input.method || method;
    headers = normalizeHeaders(input.headers);

    if (!("body" in init) && method !== "GET" && method !== "HEAD") {
      const raw = await input.clone().text();
      if (raw.length > 0) body = raw;
    }
  } else if (typeof input === "string" || input instanceof URL) {
    targetUrl = String(input);
  } else {
    throw new Error("ProxyClient fetch input must be URL string, URL, or Request");
  }

  method = String(init.method || method || "GET").toUpperCase();
  headers = {
    ...controlHeaders,
    ...headers,
    ...normalizeHeaders(init.headers),
  };

  if ("body" in init) {
    body = init.body as BodyInit | null | undefined;
  }

  const normalizedBody = normalizeBody(body, headers);

  return {
    target_url: targetUrl,
    method,
    headers,
    ...(typeof normalizedBody !== "undefined" ? { body: normalizedBody } : {}),
  };
}

function toProxyResult(response: Response, data: unknown): ProxyResponseShape {
  if (data && typeof data === "object" && "status" in data && "data" in data) {
    const maybe = data as Partial<ProxyResponseShape> & { status: number; data: unknown };
    return {
      status: Number(maybe.status) || response.status || 200,
      statusText: maybe.statusText || response.statusText || "",
      headers: (maybe.headers as Record<string, string>) || {},
      data: maybe.data,
      meta: maybe.meta ?? null,
    };
  }

  return {
    status: response.status || 500,
    statusText: response.statusText || "",
    headers: {},
    data,
    meta: null,
  };
}

function toFetchResponse(proxyResult: ProxyResponseShape, requestUrl: string): Response {
  const headers = new Headers(proxyResult.headers || {});
  const payload = proxyResult.data;
  const body =
    payload === null || typeof payload === "undefined"
      ? null
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload);

  if (
    payload !== null &&
    typeof payload === "object" &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }

  const response = new Response(body, {
    status: proxyResult.status,
    statusText: proxyResult.statusText || "",
    headers,
  });

  Object.defineProperty(response as Response & { consensus?: unknown }, "consensus", {
    value: {
      request_url: requestUrl,
      meta: proxyResult.meta || null,
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return response;
}

function ensureInterceptorInstalled(): void {
  if (interceptorInstalled) return;

  if (typeof globalThis.fetch === "function") {
    passthroughFetch = globalThis.fetch.bind(globalThis);
  }
  if (!passthroughFetch) {
    throw new Error(
      "Global fetch is unavailable; use strategy: 'manual' or polyfill fetch."
    );
  }

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const state = proxyFetchContext.getStore();
    if (state?.proxyFetch) return state.proxyFetch(input, init);
    return passthroughFetch!(input, init);
  }) as typeof fetch;

  interceptorInstalled = true;
}

function currentPassthroughFetch(): FetchWithPayment | null {
  if (passthroughFetch) return passthroughFetch;
  if (typeof globalThis.fetch === "function") {
    passthroughFetch = globalThis.fetch.bind(globalThis);
  }
  return passthroughFetch;
}

export function ProxyClient(
  fetchWithPayment: FetchWithPayment,
  options: ProxyClientOptions = {}
): (req: MiddlewareReq, res: unknown, next: Next) => void {
  if (typeof fetchWithPayment !== "function") {
    throw new TypeError(
      "ProxyClient requires fetchWithPayment as the first argument"
    );
  }

  const strategy: ProxyStrategy = options.strategy === "manual" ? "manual" : "auto";
  const serverUrl = trimTrailingSlash(DEFAULT_SERVER_URL);
  const proxyEndpoint = `${serverUrl}/proxy`;
  const baseControlHeaders = controlHeadersFromOptions(options);

  async function requestProxy(payload: ProxyPayload): Promise<ProxyResponseShape> {
    const response = await fetchWithPayment(proxyEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();
    const parsed = parseMaybeJson(raw);

    if (!response.ok && !(parsed && typeof parsed === "object" && "status" in parsed)) {
      const message =
        (parsed as { message?: string; error?: string } | null)?.message ||
        (parsed as { message?: string; error?: string } | null)?.error ||
        `Proxy request failed (${response.status})`;
      const error = new ProxyClientError(message);
      error.status = response.status;
      error.data = parsed;
      throw error;
    }

    return toProxyResult(response, parsed);
  }

  async function proxiedFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    perRequestOptions: Partial<ProxyClientOptions> = {}
  ): Promise<Response> {
    const controlHeaders = {
      ...baseControlHeaders,
      ...controlHeadersFromOptions(perRequestOptions),
    };
    const payload = await buildProxyPayload(input, init, controlHeaders);
    const proxyResult = await requestProxy(payload);
    const requestUrl =
      typeof Request !== "undefined" && input instanceof Request ? input.url : String(input);
    return toFetchResponse(proxyResult, requestUrl);
  }

  async function proxiedRequest(
    payload: Partial<ProxyPayload> = {},
    perRequestOptions: Partial<ProxyClientOptions> = {}
  ): Promise<ProxyResponseShape> {
    const controlHeaders = {
      ...baseControlHeaders,
      ...controlHeadersFromOptions(perRequestOptions),
      ...normalizeHeaders(payload.headers),
    };
    return requestProxy({
      target_url: String(payload.target_url || ""),
      method: String(payload.method || "GET").toUpperCase(),
      headers: controlHeaders,
      ...(typeof payload.body !== "undefined" ? { body: payload.body } : {}),
    });
  }

  return (req: MiddlewareReq, _res: unknown, next: Next) => {
    const routePath = req?.path || req?.url || "/";
    const shouldProxy = shouldProxyPath(routePath, options);

    req.consensus = {
      strategy,
      shouldProxy,
      fetch: proxiedFetch,
      request: proxiedRequest,
      passthroughFetch: currentPassthroughFetch(),
    };

    if (strategy !== "auto") {
      next();
      return;
    }

    ensureInterceptorInstalled();

    proxyFetchContext.run({ proxyFetch: shouldProxy ? proxiedFetch : null }, () => next());
  };
}
