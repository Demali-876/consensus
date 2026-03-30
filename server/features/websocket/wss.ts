import crypto                         from 'crypto';
import Router                          from '../../router.js';
import { WebSocketServer, WebSocket }  from 'ws';
import { paymentMiddleware }           from '@x402/express';
import type { Express, Request }       from 'express';
import type { Server as HttpsServer }  from 'https';
import {
  PRICING_PRESETS,
  calculateSessionLimits,
  calculateSessionCost,
  bytesToMB,
  msToMinutes,
} from '../../utils/types.js';

export interface Purchase {
  model:     string;
  minutes:   number;
  megabytes: number;
  expires:   number;
}

interface SessionUsage {
  bytesReceived:    number;
  bytesSent:        number;
  totalBytes:       number;
  connectedAt:      number;
  durationMs?:      number;
  disconnectedAt?:  number;
}

interface Session {
  sessionId:  string;
  nodeId:     string;
  pricing:    (typeof PRICING_PRESETS)[keyof typeof PRICING_PRESETS];
  limits:     { timeLimit: number; dataLimit: number };
  usage:      SessionUsage;
  active:     boolean;
  timer?:     ReturnType<typeof setTimeout>;
}

interface WssConfig {
  EVM_PAY_TO:    string;
  SOLANA_PAY_TO: string;
  ICP_PAY_TO:    string;
}

const sessions        = new Map<string, Session>();
const pendingSessions = new Map<string, Purchase>();
const TOKEN_TTL_MS    = 60_000;

function pricingKey(model: string): keyof typeof PRICING_PRESETS {
  return model === 'time' ? 'TIME' : model === 'data' ? 'DATA' : 'HYBRID';
}

function parsePreferenceHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['x-node-region', 'x-node-domain', 'x-node-exclude'] as const) {
    const val = req.headers[key];
    if (val) out[key] = Array.isArray(val) ? val[0]! : val;
  }
  return out;
}

function sessionPrice(context: any): string {
  const model     = context.adapter.getQueryParam?.('model')     ?? 'hybrid';
  const minutes   = parseInt(context.adapter.getQueryParam?.('minutes')   ?? '5');
  const megabytes = parseInt(context.adapter.getQueryParam?.('megabytes') ?? '50');
  const pricing   = PRICING_PRESETS[pricingKey(model)];
  return `$${calculateSessionCost(pricing, minutes, megabytes).toFixed(4)}`;
}

function sessionPriceIcp(context: any): string {
  const model     = context.adapter.getQueryParam?.('model')     ?? 'hybrid';
  const minutes   = parseInt(context.adapter.getQueryParam?.('minutes')   ?? '5');
  const megabytes = parseInt(context.adapter.getQueryParam?.('megabytes') ?? '50');
  const pricing   = PRICING_PRESETS[pricingKey(model)];
  return String(Math.round(calculateSessionCost(pricing, minutes, megabytes) * 1e8));
}

interface ProxyRequest {
  id?:      string;
  url?:     string;
  method?:  string;
  headers?: Record<string, string>;
  body?:    string;
}

interface ProxyResponse {
  id?:     string;
  status:  number;
  headers: Record<string, string>;
  body:    string;
  meta:    { duration_ms: number; served_by: string };
}

interface ProxyError {
  id?:     string;
  error:   'invalid_request' | 'fetch_failed';
  message: string;
}

const FETCH_TIMEOUT_MS = 30_000;

async function executeProxyRequest(ws: WebSocket, session: Session, data: Buffer): Promise<void> {
  let req: ProxyRequest;

  try {
    req = JSON.parse(data.toString()) as ProxyRequest;
  } catch {
    return sendProxyResult(ws, session, {
      error:   'invalid_request',
      message: 'Message must be valid JSON',
    } satisfies ProxyError);
  }

  if (!req.url) {
    return sendProxyResult(ws, session, {
      id:      req.id,
      error:   'invalid_request',
      message: 'Missing required field: url',
    } satisfies ProxyError);
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const start  = Date.now();

  try {
    const init: RequestInit = {
      method,
      headers: {
        ...(req.headers ?? {}),
        'user-agent': `Consensus-Local/${session.sessionId.slice(0, 8)}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };

    if (req.body && method !== 'GET' && method !== 'HEAD') {
      init.body = req.body;
    }

    const upstream = await fetch(req.url, init);
    const body     = await upstream.text();

    return sendProxyResult(ws, session, {
      id:      req.id,
      status:  upstream.status,
      headers: Object.fromEntries(upstream.headers.entries()),
      body,
      meta:    { duration_ms: Date.now() - start, served_by: 'local' },
    } satisfies ProxyResponse);
  } catch (err: any) {
    return sendProxyResult(ws, session, {
      id:      req.id,
      error:   'fetch_failed',
      message: err?.message ?? 'Unknown fetch error',
    } satisfies ProxyError);
  }
}

function sendProxyResult(ws: WebSocket, session: Session, payload: ProxyResponse | ProxyError): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const msg  = JSON.stringify(payload);
  const size = Buffer.byteLength(msg);
  session.usage.bytesSent  += size;
  session.usage.totalBytes  = session.usage.bytesReceived + session.usage.bytesSent;
  ws.send(msg);
}

export function handleLocalSession(
  ws:        WebSocket,
  sessionId: string,
  model:     string,
  minutes:   number,
  megabytes: number,
): void {
  const pricing   = PRICING_PRESETS[pricingKey(model)];
  const totalCost = calculateSessionCost(pricing, minutes, megabytes);
  const limits    = calculateSessionLimits(pricing, minutes, megabytes);

  const session: Session = {
    sessionId,
    nodeId:  'local',
    pricing,
    limits,
    usage:   { bytesReceived: 0, bytesSent: 0, totalBytes: 0, connectedAt: Date.now() },
    active:  true,
  };

  sessions.set(sessionId, session);

  ws.send(JSON.stringify({
    type:      'session_start',
    sessionId,
    model,
    served_by: 'local',
    limits: {
      timeSeconds: limits.timeLimit / 1000,
      dataMB:      bytesToMB(limits.dataLimit),
    },
    pricing: {
      totalCost,
      pricePerMinute: pricing.pricePerMinute,
      pricePerMB:     pricing.pricePerMB,
    },
  }));

  session.timer = setTimeout(() => {
    if (!session.active) return;
    const duration = Date.now() - session.usage.connectedAt;
    ws.send(JSON.stringify({
      type:       'session_expired',
      reason:     'time_limit_reached',
      finalUsage: {
        durationMinutes: msToMinutes(duration),
        dataMB:          bytesToMB(session.usage.totalBytes),
      },
    }));
    ws.close(1000, 'Time limit reached');
  }, limits.timeLimit);

  ws.on('message', (data: Buffer) => {
    if (!session.active) return;

    const size = Buffer.byteLength(data);
    session.usage.bytesReceived += size;
    session.usage.totalBytes     = session.usage.bytesReceived + session.usage.bytesSent;

    if (session.usage.totalBytes >= limits.dataLimit) {
      clearTimeout(session.timer);
      session.active = false;
      ws.send(JSON.stringify({
        type:       'session_expired',
        reason:     'data_limit_reached',
        finalUsage: {
          durationMinutes: msToMinutes(Date.now() - session.usage.connectedAt),
          dataMB:          bytesToMB(session.usage.totalBytes),
        },
      }));
      ws.close(1008, 'Data limit reached');
      return;
    }
    void executeProxyRequest(ws, session, data);
  });

  ws.on('close', () => {
    clearTimeout(session.timer);
    session.active = false;
    const now = Date.now();
    session.usage.durationMs     = now - session.usage.connectedAt;
    session.usage.disconnectedAt = now;
    sessions.delete(sessionId);
  });
}

export function handleNodeProxiedSession(
  clientWs:  WebSocket,
  nodeWs:    WebSocket,
  sessionId: string,
  model:     string,
  minutes:   number,
  megabytes: number,
  router:    Router,
  nodeId:    string,
): void {
  const pricing = PRICING_PRESETS[pricingKey(model)];
  const limits  = calculateSessionLimits(pricing, minutes, megabytes);

  const session: Session = {
    sessionId,
    nodeId,
    pricing,
    limits,
    usage:  { bytesReceived: 0, bytesSent: 0, totalBytes: 0, connectedAt: Date.now() },
    active: true,
  };

  sessions.set(sessionId, session);

  let released   = false;
  let fallenBack = false;

  const release = () => {
    if (!released) {
      released = true;
      router.decrementSession(nodeId);
      sessions.delete(sessionId);
    }
  };

  nodeWs.on('open', () => {
    clientWs.send(JSON.stringify({
      type:      'session_start',
      sessionId,
      model,
      served_by: nodeId,
      limits: {
        timeSeconds: limits.timeLimit / 1000,
        dataMB:      bytesToMB(limits.dataLimit),
      },
      pricing: {
        totalCost:      calculateSessionCost(pricing, minutes, megabytes),
        pricePerMinute: pricing.pricePerMinute,
        pricePerMB:     pricing.pricePerMB,
      },
    }));
  });

  nodeWs.on('error', () => {
    session.active = false;
    fallenBack     = true;
    release();
    nodeWs.close();
    // Remove stale handler before handing off to avoid double message processing
    clientWs.removeAllListeners('message');
    handleLocalSession(clientWs, sessionId, model, minutes, megabytes);
  });

  clientWs.on('message', (data: Buffer) => {
    if (!session.active) return;
    const size = Buffer.byteLength(data);
    session.usage.bytesReceived += size;
    session.usage.totalBytes     = session.usage.bytesReceived + session.usage.bytesSent;
    if (nodeWs.readyState === WebSocket.OPEN) nodeWs.send(data);
  });

  nodeWs.on('message', (data: Buffer) => {
    if (!session.active) return;
    const size = Buffer.byteLength(data);
    session.usage.bytesSent  += size;
    session.usage.totalBytes  = session.usage.bytesReceived + session.usage.bytesSent;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  clientWs.on('close', () => {
    session.active = false;
    release();
    nodeWs.close();
  });

  nodeWs.on('close', () => {
    session.active = false;
    release();
    // Don't close the client if we already handed off to a local fallback session
    if (!fallenBack) clientWs.close();
  });
}

export function registerWebSocket(
  app:         Express,
  httpsServer: HttpsServer,
  x402Server:  any,
  config:      WssConfig,
  router:      Router,
) {
  const { EVM_PAY_TO, SOLANA_PAY_TO, ICP_PAY_TO } = config;

  app.get(
    '/ws',
    paymentMiddleware(
      {
        'GET /ws': {
          accepts: [
            {
              scheme:  'exact',
              price:   sessionPrice,
              network: 'eip155:84532',
              payTo:   EVM_PAY_TO,
            },
            {
              scheme:  'exact',
              price:   sessionPrice,
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              payTo:   SOLANA_PAY_TO,
            },
            {
              scheme:  'exact',
              price:   sessionPriceIcp,
              network: 'icp:1:xafvr-biaaa-aaaai-aql5q-cai',
              payTo:   ICP_PAY_TO,
            },
          ],
          description: 'Pay-per-use WebSockets on demand',
          mimeType:    'application/json',
        },
      },
      x402Server,
    ),
    (req, res) => {
      const model     = (req.query.model     ?? 'hybrid').toString();
      const minutes   = parseInt((req.query.minutes   ?? '5').toString(),  10);
      const megabytes = parseInt((req.query.megabytes ?? '50').toString(), 10);

      const token   = crypto.randomBytes(32).toString('hex');
      const expires = Date.now() + TOKEN_TTL_MS;

      pendingSessions.set(token, { model, minutes, megabytes, expires });

      res.json({
        token,
        connect_url: `wss://${req.headers.host}/ws-connect?token=${token}`,
        expires_in:  Math.floor(TOKEN_TTL_MS / 1000),
      });
    },
  );

  const wss = new WebSocketServer({ noServer: true });

  httpsServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, `https://${req.headers.host}`);

    if (url.pathname !== '/ws-connect') return;

    const token   = url.searchParams.get('token');
    const pending = token ? pendingSessions.get(token) : null;

    if (!pending) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pending.expires < Date.now()) {
      pendingSessions.delete(token!);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    pendingSessions.delete(token!);

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).purchase = pending;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: Request) => {
    const { model, minutes, megabytes } = (ws as any).purchase as Purchase;
    const sessionId = crypto.randomUUID();

    const node = router.selectNode(sessionId, parsePreferenceHeaders(req));

    if (node) {
      console.log(`[WebSocket Route] ${sessionId} → ${node.id} (${node.region})`);
      router.incrementSession(node.id);

      const nodeWs = new WebSocket(`wss://${node.domain}/ws-node`, {
        headers: {
          'x-session-id': sessionId,
          'x-model':      model,
          'x-minutes':    minutes.toString(),
          'x-megabytes':  megabytes.toString(),
        },
      });

      handleNodeProxiedSession(ws, nodeWs, sessionId, model, minutes, megabytes, router, node.id);
    } else {
      console.log(`[WebSocket Self-Fallback] No nodes available, handling locally`);
      handleLocalSession(ws, sessionId, model, minutes, megabytes);
    }
  });

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, p] of pendingSessions) {
      if (p.expires < now) pendingSessions.delete(token);
    }
  }, 10_000);

  return {
    getStats: () => ({
      active_sessions: sessions.size,
      pending_tokens:  pendingSessions.size,
      router_stats:    router.getStats(),
    }),
    close: () => clearInterval(cleanupInterval),
  };
}
