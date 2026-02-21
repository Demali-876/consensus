const DEFAULT_SERVER_URL =
  process.env.CONSENSUS_SERVER_URL || "https://consensus.canister.software";

type FetchWithPayment = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ConsensusSocketModel = "hybrid" | "time" | "data";

type ConsensusSocketTokenParams = {
  model?: ConsensusSocketModel;
  minutes?: number;
  megabytes?: number;
  nodeRegion?: string;
  nodeDomain?: string;
  nodeExclude?: string;
};

type ConsensusSocketTokenAuth = {
  token: string;
  connect_url: string;
  expires_in: number;
};

type ConsensusSocketConnectTarget = {
  connect_url: string;
  token?: string;
  expires_in?: number;
};

type ConsensusSocketCallbacks = {
  onOpen?: () => void;
  onMessage?: (data: unknown) => void;
  onClose?: (event?: unknown) => void;
  onError?: (error: unknown) => void;
};

type ConsensusSocketSafeResult<T> = {
  ok: boolean;
  data?: T;
  error?: unknown;
};

type ConsensusSocketSessionState = {
  connected: boolean;
  reconnecting: boolean;
  closedByCaller: boolean;
};

type ConsensusSocketSession = {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "message" | "close" | "error", handler: (...args: unknown[]) => void): void;
  off(event: "open" | "message" | "close" | "error", handler: (...args: unknown[]) => void): void;
  getState(): ConsensusSocketSessionState;
};

type ConsensusSocketClientOptions = {
  webSocketFactory?: new (...args: unknown[]) => unknown;
  openTimeoutMs?: number;
  reconnectIntervalMs?: number;
  defaults?: ConsensusSocketTokenParams;
};

type ConsensusSocketClient = {
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
};

type SocketEventName = "open" | "message" | "close" | "error";

type SocketLike = {
  readyState: number;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

class SocketClientError extends Error {
  status?: number;
  data?: unknown;
}

function trimTrailingSlash(value: string): string {
  return String(value || "").replace(/\/+$/, "");
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeTokenParams(
  defaults: ConsensusSocketTokenParams | undefined,
  params: ConsensusSocketTokenParams | undefined
): Required<Omit<ConsensusSocketTokenParams, "nodeRegion" | "nodeDomain" | "nodeExclude">> &
  Pick<ConsensusSocketTokenParams, "nodeRegion" | "nodeDomain" | "nodeExclude"> {
  const merged = {
    model: params?.model ?? defaults?.model ?? "hybrid",
    minutes: params?.minutes ?? defaults?.minutes ?? 5,
    megabytes: params?.megabytes ?? defaults?.megabytes ?? 50,
    nodeRegion: params?.nodeRegion ?? defaults?.nodeRegion,
    nodeDomain: params?.nodeDomain ?? defaults?.nodeDomain,
    nodeExclude: params?.nodeExclude ?? defaults?.nodeExclude,
  };

  if (!["hybrid", "time", "data"].includes(merged.model)) {
    throw new SocketClientError(`Invalid model '${String(merged.model)}'`);
  }
  if (!Number.isInteger(merged.minutes) || merged.minutes < 0) {
    throw new SocketClientError("minutes must be a non-negative integer");
  }
  if (!Number.isInteger(merged.megabytes) || merged.megabytes < 0) {
    throw new SocketClientError("megabytes must be a non-negative integer");
  }

  return merged;
}

function toTokenHeaders(params: ConsensusSocketTokenParams | undefined): Record<string, string> {
  const headers: Record<string, string> = {};

  if (params?.nodeRegion) headers["x-node-region"] = params.nodeRegion;
  if (params?.nodeDomain) headers["x-node-domain"] = params.nodeDomain;
  if (params?.nodeExclude) headers["x-node-exclude"] = params.nodeExclude;

  return headers;
}

async function resolveWebSocketFactory(
  factory?: new (...args: unknown[]) => unknown
): Promise<new (...args: unknown[]) => unknown> {
  if (factory) return factory;
  if (typeof WebSocket !== "undefined") return WebSocket as unknown as new (...args: unknown[]) => unknown;

  const wsModule = await import("ws");
  const maybeCtor =
    wsModule.default ||
    (wsModule as unknown as { WebSocket?: unknown }).WebSocket;
  if (typeof maybeCtor !== "function") {
    throw new SocketClientError("Unable to resolve a WebSocket constructor");
  }
  return maybeCtor as new (...args: unknown[]) => unknown;
}

function addListener(
  socket: SocketLike,
  event: SocketEventName,
  handler: (...args: unknown[]) => void
): void {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, handler);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(event, handler);
  }
}

function removeListener(
  socket: SocketLike,
  event: SocketEventName,
  handler: (...args: unknown[]) => void
): void {
  if (typeof socket.removeEventListener === "function") {
    socket.removeEventListener(event, handler);
    return;
  }
  if (typeof socket.off === "function") {
    socket.off(event, handler);
    return;
  }
  if (typeof socket.removeListener === "function") {
    socket.removeListener(event, handler);
  }
}

function getOpenStateValue(socket: SocketLike): number {
  const maybeCtor = socket as unknown as { constructor?: { OPEN?: number } };
  const open = maybeCtor.constructor?.OPEN;
  return typeof open === "number" ? open : 1;
}

function getMessagePayload(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in (value as Record<string, unknown>)) {
    return (value as { data: unknown }).data;
  }
  return value;
}

function toSafeResult<T>(promise: Promise<T>): Promise<ConsensusSocketSafeResult<T>> {
  return promise
    .then((data) => ({ ok: true, data }))
    .catch((error) => ({ ok: false, error }));
}

export function SocketClient(
  fetchWithPayment: FetchWithPayment,
  options: ConsensusSocketClientOptions = {}
): ConsensusSocketClient {
  if (typeof fetchWithPayment !== "function") {
    throw new TypeError("SocketClient requires fetchWithPayment as the first argument");
  }

  const baseUrl = trimTrailingSlash(DEFAULT_SERVER_URL);
  const openTimeoutMs = options.openTimeoutMs ?? 12_000;
  const reconnectIntervalMs = options.reconnectIntervalMs ?? 2_000;
  let lastTokenParams: ConsensusSocketTokenParams | undefined;

  async function requestTokenInternal(
    params?: ConsensusSocketTokenParams
  ): Promise<ConsensusSocketTokenAuth> {
    const normalized = normalizeTokenParams(options.defaults, params);
    lastTokenParams = normalized;

    const query = new URLSearchParams({
      model: normalized.model,
      minutes: String(normalized.minutes),
      megabytes: String(normalized.megabytes),
    });

    const response = await fetchWithPayment(`${baseUrl}/ws?${query.toString()}`, {
      method: "GET",
      headers: toTokenHeaders(normalized),
    });

    const raw = await response.text();
    const parsed = parseMaybeJson(raw);

    if (!response.ok) {
      const message =
        (parsed as { message?: string; error?: string } | null)?.message ||
        (parsed as { message?: string; error?: string } | null)?.error ||
        `WebSocket token request failed (${response.status})`;
      const error = new SocketClientError(message);
      error.status = response.status;
      error.data = parsed;
      throw error;
    }

    const auth = parsed as Partial<ConsensusSocketTokenAuth>;
    if (!auth?.connect_url || !auth?.token) {
      throw new SocketClientError("Invalid token response: missing token/connect_url");
    }

    return {
      token: String(auth.token),
      connect_url: String(auth.connect_url),
      expires_in: Number(auth.expires_in ?? 0),
    };
  }

  async function requestToken(
    params?: ConsensusSocketTokenParams,
    safeOptions?: { safe?: false }
  ): Promise<ConsensusSocketTokenAuth>;
  async function requestToken(
    params: ConsensusSocketTokenParams | undefined,
    safeOptions: { safe: true }
  ): Promise<ConsensusSocketSafeResult<ConsensusSocketTokenAuth>>;
  async function requestToken(
    params?: ConsensusSocketTokenParams,
    safeOptions?: { safe?: boolean }
  ): Promise<ConsensusSocketTokenAuth | ConsensusSocketSafeResult<ConsensusSocketTokenAuth>> {
    const task = requestTokenInternal(params);
    if (safeOptions?.safe) return toSafeResult(task);
    return task;
  }

  async function connectInternal(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks?: ConsensusSocketCallbacks
  ): Promise<ConsensusSocketSession> {
    const initialConnectUrl =
      typeof connectUrlOrAuth === "string"
        ? connectUrlOrAuth
        : connectUrlOrAuth?.connect_url;

    if (!initialConnectUrl) {
      throw new SocketClientError("connect requires connect_url");
    }

    const listeners: Record<SocketEventName, Set<(...args: unknown[]) => void>> = {
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };

    const state: ConsensusSocketSessionState = {
      connected: false,
      reconnecting: false,
      closedByCaller: false,
    };

    let currentConnectUrl = initialConnectUrl;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let activeSocket: SocketLike | null = null;
    const socketFactory = await resolveWebSocketFactory(options.webSocketFactory);
    const connectHeaders = toTokenHeaders(lastTokenParams ?? options.defaults);

    const emit = (event: SocketEventName, ...args: unknown[]) => {
      for (const handler of listeners[event]) {
        handler(...args);
      }
    };

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const waitForOpen = (socket: SocketLike) =>
      new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (timeout) clearTimeout(timeout);
          removeListener(socket, "open", onOpen);
          removeListener(socket, "error", onError);
          removeListener(socket, "close", onClose);
        };

        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new SocketClientError("Socket closed before opening"));
        };

        addListener(socket, "open", onOpen);
        addListener(socket, "error", onError);
        addListener(socket, "close", onClose);

        timeout = setTimeout(() => {
          cleanup();
          reject(new SocketClientError("Socket open timeout"));
        }, openTimeoutMs);
      });

    const openSocket = async () => {
      let socketInstance: SocketLike;
      try {
        socketInstance = new (socketFactory as new (
          url: string,
          options?: { headers?: Record<string, string> }
        ) => SocketLike)(currentConnectUrl, { headers: connectHeaders });
      } catch {
        socketInstance = new (socketFactory as new (url: string) => SocketLike)(
          currentConnectUrl
        );
      }

      addListener(socketInstance, "open", () => {
        state.connected = true;
        state.reconnecting = false;
        callbacks?.onOpen?.();
        emit("open");
      });

      addListener(socketInstance, "message", (event: unknown) => {
        const payload = getMessagePayload(event);
        callbacks?.onMessage?.(payload);
        emit("message", payload);
      });

      addListener(socketInstance, "error", (error: unknown) => {
        callbacks?.onError?.(error);
        emit("error", error);
      });

      addListener(socketInstance, "close", (event: unknown) => {
        state.connected = false;
        callbacks?.onClose?.(event);
        emit("close", event);

        if (state.closedByCaller) return;

        clearReconnectTimer();
        reconnectTimer = setTimeout(async () => {
          if (state.closedByCaller) return;
          state.reconnecting = true;

          try {
            if (lastTokenParams) {
              const auth = await requestTokenInternal(lastTokenParams);
              currentConnectUrl = auth.connect_url;
            }
            await openSocket();
          } catch (error) {
            callbacks?.onError?.(error);
            emit("error", error);

            if (!state.closedByCaller) {
              reconnectTimer = setTimeout(async () => {
                if (!state.closedByCaller) {
                  state.reconnecting = true;
                  try {
                    if (lastTokenParams) {
                      const auth = await requestTokenInternal(lastTokenParams);
                      currentConnectUrl = auth.connect_url;
                    }
                    await openSocket();
                  } catch (retryError) {
                    callbacks?.onError?.(retryError);
                    emit("error", retryError);
                  }
                }
              }, reconnectIntervalMs);
            }
          }
        }, reconnectIntervalMs);
      });

      activeSocket = socketInstance;
      await waitForOpen(socketInstance);
    };

    await openSocket();

    return {
      send(data) {
        if (!activeSocket) {
          throw new SocketClientError("No active socket session");
        }
        const openState = getOpenStateValue(activeSocket);
        if (activeSocket.readyState !== openState) {
          throw new SocketClientError("Socket is not open");
        }
        activeSocket.send(data);
      },
      close(code?: number, reason?: string) {
        state.closedByCaller = true;
        state.reconnecting = false;
        clearReconnectTimer();
        activeSocket?.close(code, reason);
      },
      on(event, handler) {
        listeners[event].add(handler);
      },
      off(event, handler) {
        listeners[event].delete(handler);
      },
      getState() {
        return { ...state };
      },
    };
  }

  async function connect(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks?: ConsensusSocketCallbacks,
    safeOptions?: { safe?: false }
  ): Promise<ConsensusSocketSession>;
  async function connect(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks: ConsensusSocketCallbacks | undefined,
    safeOptions: { safe: true }
  ): Promise<ConsensusSocketSafeResult<ConsensusSocketSession>>;
  async function connect(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks?: ConsensusSocketCallbacks,
    safeOptions?: { safe?: boolean }
  ): Promise<ConsensusSocketSession | ConsensusSocketSafeResult<ConsensusSocketSession>> {
    const task = connectInternal(connectUrlOrAuth, callbacks);
    if (safeOptions?.safe) return toSafeResult(task);
    return task;
  }

  return {
    requestToken,
    connect,
  };
}
