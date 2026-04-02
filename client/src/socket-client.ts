import { ConsensusSocketModel,
  SessionPricing, ConsensusSocketTokenParams, SocketEventName, SocketLike,
  ConsensusSocketBudgetSnapshot, ConsensusSocketClient,ConsensusSocketClientOptions,
  ConsensusSocketSession, ConsensusSocketCallbacks ,ConsensusSocketSafeResult, ConsensusSocketConnectTarget,
  ConsensusSocketSessionState,
  ConsensusSocketTokenAuth, SocketClientError,SocketBudgetLimitError,
  PRICING_PRESETS } from './types';
type FetchWithPayment = typeof globalThis.fetch;
const DEFAULT_SERVER_URL = process.env.CONSENSUS_SERVER_URL || 'https://consensus.canister.software';
const USD_SCALE = 1_000_000;

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseUsdToMicros(value: number | undefined, fieldName: string): number | null {
  if (typeof value === 'undefined' || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative number`);
  }

  const micros = Math.round(value * USD_SCALE);
  const normalized = micros / USD_SCALE;
  if (Math.abs(normalized - value) > 1e-9) {
    throw new TypeError(`${fieldName} supports at most 6 decimal places`);
  }

  return micros;
}

function microsToUsd(micros: number): number {
  return Number((micros / USD_SCALE).toFixed(6));
}

function calculateSessionCost(pricing: SessionPricing, minutes: number, megabytes: number): number {
  let cost = 0;

  if (pricing.model === 'time' || pricing.model === 'hybrid') {
    cost += (minutes || 0) * pricing.pricePerMinute;
  }
  if (pricing.model === 'data' || pricing.model === 'hybrid') {
    cost += (megabytes || 0) * pricing.pricePerMB;
  }

  return cost;
}

function normalizeTokenParams(
  defaults: ConsensusSocketTokenParams | undefined,
  params: ConsensusSocketTokenParams | undefined
): Required<Omit<ConsensusSocketTokenParams, 'nodeRegion' | 'nodeDomain' | 'nodeExclude'>> &
  Pick<ConsensusSocketTokenParams, 'nodeRegion' | 'nodeDomain' | 'nodeExclude'> {
  const merged = {
    model: params?.model ?? defaults?.model ?? 'hybrid',
    minutes: params?.minutes ?? defaults?.minutes ?? 5,
    megabytes: params?.megabytes ?? defaults?.megabytes ?? 50,
    nodeRegion: params?.nodeRegion ?? defaults?.nodeRegion,
    nodeDomain: params?.nodeDomain ?? defaults?.nodeDomain,
    nodeExclude: params?.nodeExclude ?? defaults?.nodeExclude,
  };

  if (!['hybrid', 'time', 'data'].includes(merged.model)) {
    throw new SocketClientError(`Invalid model '${String(merged.model)}'`);
  }
  if (!Number.isInteger(merged.minutes) || merged.minutes < 0) {
    throw new SocketClientError('minutes must be a non-negative integer');
  }
  if (!Number.isInteger(merged.megabytes) || merged.megabytes < 0) {
    throw new SocketClientError('megabytes must be a non-negative integer');
  }

  return merged;
}

function toTokenHeaders(params: ConsensusSocketTokenParams | undefined): Record<string, string> {
  const headers: Record<string, string> = {};

  if (params?.nodeRegion) headers['x-node-region'] = params.nodeRegion;
  if (params?.nodeDomain) headers['x-node-domain'] = params.nodeDomain;
  if (params?.nodeExclude) headers['x-node-exclude'] = params.nodeExclude;

  return headers;
}

async function resolveWebSocketFactory(
  factory?: new (...args: unknown[]) => unknown
): Promise<new (...args: unknown[]) => unknown> {
  if (factory) return factory;
  if (typeof WebSocket !== 'undefined')
    return WebSocket as unknown as new (...args: unknown[]) => unknown;

  const wsModule = await import('ws');
  const maybeCtor = wsModule.default || (wsModule as unknown as { WebSocket?: unknown }).WebSocket;
  if (typeof maybeCtor !== 'function') {
    throw new SocketClientError('Unable to resolve a WebSocket constructor');
  }
  return maybeCtor as new (...args: unknown[]) => unknown;
}

function addListener(
  socket: SocketLike,
  event: SocketEventName,
  handler: (...args: unknown[]) => void
): void {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(event, handler);
    return;
  }
  if (typeof socket.on === 'function') {
    socket.on(event, handler);
  }
}

function removeListener(
  socket: SocketLike,
  event: SocketEventName,
  handler: (...args: unknown[]) => void
): void {
  if (typeof socket.removeEventListener === 'function') {
    socket.removeEventListener(event, handler);
    return;
  }
  if (typeof socket.off === 'function') {
    socket.off(event, handler);
    return;
  }
  if (typeof socket.removeListener === 'function') {
    socket.removeListener(event, handler);
  }
}

function getOpenStateValue(socket: SocketLike): number {
  const maybeCtor = socket as unknown as { constructor?: { OPEN?: number } };
  const open = maybeCtor.constructor?.OPEN;
  return typeof open === 'number' ? open : 1;
}

function getMessagePayload(value: unknown): unknown {
  if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
    return (value as { data: unknown }).data;
  }
  return value;
}

function toSafeResult<T>(promise: Promise<T>): Promise<ConsensusSocketSafeResult<T>> {
  return promise.then((data) => ({ ok: true, data })).catch((error) => ({ ok: false, error }));
}

export function SocketClient(
  fetchWithPayment: FetchWithPayment,
  options: ConsensusSocketClientOptions = {}
): ConsensusSocketClient {
  if (typeof fetchWithPayment !== 'function') {
    throw new TypeError('SocketClient requires fetchWithPayment as the first argument');
  }

  const baseUrl = trimTrailingSlash(DEFAULT_SERVER_URL);
  const openTimeoutMs = options.openTimeoutMs ?? 12_000;
  const reconnectIntervalMs = options.reconnectIntervalMs ?? 2_000;
  const limitMicros = parseUsdToMicros(options.limit_usd, 'limit_usd');
  let lastTokenParams: ConsensusSocketTokenParams | undefined;
  let spentMicros = 0;
  let limitCallbackFired = false;
  let lastQuoteMicros = 0;

  function computeStandDownState(nextCostMicros = 0): boolean {
    if (limitMicros === null) return false;
    if (spentMicros >= limitMicros) return true;
    return spentMicros + nextCostMicros > limitMicros;
  }

  function getBudget(): ConsensusSocketBudgetSnapshot {
    const remainingMicros = limitMicros === null ? null : Math.max(0, limitMicros - spentMicros);
    return {
      limit_usd: limitMicros === null ? null : microsToUsd(limitMicros),
      spent_usd: microsToUsd(spentMicros),
      remaining_usd: remainingMicros === null ? null : microsToUsd(remainingMicros),
      exhausted: computeStandDownState(),
      last_quote_usd: microsToUsd(lastQuoteMicros),
    };
  }

  function isStandDown(): boolean {
    const exhausted = computeStandDownState();
    if (exhausted && !limitCallbackFired && typeof options.on_limit_reached === 'function') {
      limitCallbackFired = true;
      options.on_limit_reached(getBudget());
    }
    return exhausted;
  }

  function ensureBudgetFor(quotedCostMicros: number): void {
    if (!computeStandDownState(quotedCostMicros)) return;
    isStandDown();
    throw new SocketBudgetLimitError('WebSocket budget limit reached; token request blocked');
  }

  function incrementSpend(quotedCostMicros: number): void {
    if (quotedCostMicros <= 0) return;
    spentMicros += quotedCostMicros;
    if (limitMicros !== null && spentMicros > limitMicros) spentMicros = limitMicros;
    isStandDown();
  }

  function resetBudget(): void {
    spentMicros = 0;
    limitCallbackFired = false;
    lastQuoteMicros = 0;
  }

  function quoteTokenCostMicros(params: {
    model: ConsensusSocketModel;
    minutes: number;
    megabytes: number;
  }): number {
    const pricingKey =
      params.model === 'time' ? 'TIME' : params.model === 'data' ? 'DATA' : 'HYBRID';
    const pricing = PRICING_PRESETS[pricingKey];
    const usd = calculateSessionCost(pricing, params.minutes, params.megabytes);
    return parseUsdToMicros(usd, 'session_cost_usd') ?? 0;
  }

  async function requestTokenInternal(
    params?: ConsensusSocketTokenParams
  ): Promise<ConsensusSocketTokenAuth> {
    const normalized = normalizeTokenParams(options.defaults, params);
    lastTokenParams = normalized;
    const quotedCostMicros = quoteTokenCostMicros({
      model: normalized.model,
      minutes: normalized.minutes,
      megabytes: normalized.megabytes,
    });
    lastQuoteMicros = quotedCostMicros;
    ensureBudgetFor(quotedCostMicros);

    const query = new URLSearchParams({
      model: normalized.model,
      minutes: String(normalized.minutes),
      megabytes: String(normalized.megabytes),
    });

    const response = await fetchWithPayment(`${baseUrl}/ws?${query.toString()}`, {
      method: 'GET',
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
      throw new SocketClientError('Invalid token response: missing token/connect_url');
    }

    incrementSpend(quotedCostMicros);

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
      typeof connectUrlOrAuth === 'string' ? connectUrlOrAuth : connectUrlOrAuth?.connect_url;

    if (!initialConnectUrl) {
      throw new SocketClientError('connect requires connect_url');
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
          removeListener(socket, 'open', onOpen);
          removeListener(socket, 'error', onError);
          removeListener(socket, 'close', onClose);
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
          reject(new SocketClientError('Socket closed before opening'));
        };

        addListener(socket, 'open', onOpen);
        addListener(socket, 'error', onError);
        addListener(socket, 'close', onClose);

        timeout = setTimeout(() => {
          cleanup();
          reject(new SocketClientError('Socket open timeout'));
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
        socketInstance = new (socketFactory as new (url: string) => SocketLike)(currentConnectUrl);
      }

      addListener(socketInstance, 'open', () => {
        state.connected = true;
        state.reconnecting = false;
        callbacks?.onOpen?.();
        emit('open');
      });

      addListener(socketInstance, 'message', (event: unknown) => {
        const payload = getMessagePayload(event);
        callbacks?.onMessage?.(payload);
        emit('message', payload);
      });

      addListener(socketInstance, 'error', (error: unknown) => {
        callbacks?.onError?.(error);
        emit('error', error);
      });

      addListener(socketInstance, 'close', (event: unknown) => {
        state.connected = false;
        callbacks?.onClose?.(event);
        emit('close', event);

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
            emit('error', error);

            if (error instanceof SocketBudgetLimitError) {
              state.reconnecting = false;
              return;
            }

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
                    emit('error', retryError);
                    if (retryError instanceof SocketBudgetLimitError) {
                      state.reconnecting = false;
                    }
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
          throw new SocketClientError('No active socket session');
        }
        const openState = getOpenStateValue(activeSocket);
        if (activeSocket.readyState !== openState) {
          throw new SocketClientError('Socket is not open');
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
    getBudget,
    resetBudget,
    isStandDown,
  };
}
