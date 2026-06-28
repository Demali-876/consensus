import '@dotenvx/dotenvx/config';
import http from 'http';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import ConsensusProxy from './features/proxy/proxy.ts';
import Router from './router.ts';
import NodeStore from './data/node_store.js';
import { fileURLToPath } from 'url';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactIcpScheme } from '@canister-software/x402-icp/server';
import { registerWhitepaperSignup } from './data/whitepaperSignup.js';
import { registerWebSocket } from './features/websocket/wss.ts';
import { registerNodes } from './features/nodes/orchestrator.js';
import { registerNodeBrowser } from './features/nodes/browser.js';
import { registerTunnel } from './features/tunnel/tunnel.ts';
import { registerNodeTunnel } from './features/node-tunnel/node-tunnel.ts';
import { registerNodeGateway } from './features/node-gateway/gateway.ts';
import { startObservationScheduler, upsertServerNode } from './features/ip-pool/observer.ts';
import { registerUpdater } from './updater.ts';
import { registerOrchestratorKey } from './features/tickets/pubkey.ts';
import { assertEmailVerificationEnv } from './utils/email-verification.ts';
import { log } from './utils/log.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const publicLimiter = rateLimit({
  windowMs:          60_000,
  max:               120,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too Many Requests' },
});

const proxyLimiter = rateLimit({
  windowMs:          60_000,
  max:               30,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too Many Requests' },
});

const PORT = 8080;
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const EVM_PAY_TO = process.env.EVM_PAY_TO;
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO;
const ICP_PAY_TO = process.env.ICP_PAY_TO;

const FREE_MODE = process.env.FREE_MODE === 'true';

function proxyTargetForLog(value) {
  try {
    const target = new URL(String(value));
    return {
      target_origin: target.origin,
      target_path: target.pathname,
      target_has_query: Boolean(target.search),
    };
  } catch {
    return { target_origin: 'invalid', target_path: null, target_has_query: false };
  }
}

function proxyRequestTargetForLog(targetUrl, targetRef) {
  if (targetRef?.kind === 'tunnel') {
    return {
      target_kind: 'private-tunnel',
      tunnel_id: String(targetRef.tunnel_id ?? ''),
      target_path: typeof targetRef.path === 'string' ? targetRef.path.split('?')[0] : null,
      target_has_query: typeof targetRef.path === 'string' && targetRef.path.includes('?'),
    };
  }
  return { target_kind: 'url', ...proxyTargetForLog(targetUrl) };
}

if (!FREE_MODE) {
  if (!process.env.FACILITATOR_URL) throw new Error('FACILITATOR_URL is missing from .env');
  if (!EVM_PAY_TO || !SOLANA_PAY_TO || !ICP_PAY_TO) throw new Error('Missing required env var(s): EVM_PAY_TO, SOLANA_PAY_TO, ICP_PAY_TO');
}
assertEmailVerificationEnv();

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const x402Server = new x402ResourceServer(facilitatorClient)
  .register('eip155:84532', new ExactEvmScheme())
  .register('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', new ExactSvmScheme())
  .register('icp:1:xafvr-biaaa-aaaai-aql5q-cai', new ExactIcpScheme());

const router = new Router();

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
registerWhitepaperSignup(app);
registerUpdater(app, { adminKey: process.env.ADMIN_KEY });
registerOrchestratorKey(app);

const server = http.createServer(app);
const nodeTunnelStats = registerNodeTunnel(app, server, { router });
const nodeGatewayStats = registerNodeGateway(server, { nodeStore: NodeStore, nodeTunnel: nodeTunnelStats });
registerNodeBrowser(app, { router, nodeTunnel: nodeTunnelStats });
const tunnelStats = registerTunnel(app, server, { router, nodeTunnel: nodeTunnelStats });
const wsStats = registerWebSocket(
  app,
  server,
  x402Server,
  {
    EVM_PAY_TO,
    SOLANA_PAY_TO,
    ICP_PAY_TO,
  },
  router,
  nodeTunnelStats
);

const nodeStats = registerNodes(app, server, x402Server, {
  EVM_PAY_TO,
  SOLANA_PAY_TO,
  ICP_PAY_TO,
});
const proxy = new ConsensusProxy({
  router,
  nodeTunnel: nodeTunnelStats,
  privateTunnel: {
    authorize: tunnelStats.authorizePrivateTarget,
    execute: tunnelStats.executePrivateHttp,
  },
});

app.get('/', publicLimiter, (req, res) => {
  res.json({
    name: 'Consensus x402 Server',
    version: '2.0.0',
    status: 'running',
    payment_networks: {
      evm: { chain: 'Base Sepolia', address: EVM_PAY_TO },
      solana: { chain: 'Devnet', address: SOLANA_PAY_TO },
      icp: { chain: 'TESTICP', address: ICP_PAY_TO },
    },
    facilitator: 'https://facilitator.canister.software',
  });
});

app.get('/config', publicLimiter, (_req, res) => {
  res.json({ free_mode: FREE_MODE });
});

app.get('/health', publicLimiter, (_req, res) => {
  const proxyStats  = proxy.getStats();
  const ws          = wsStats.getStats();
  const tunnels     = tunnelStats.getStats();
  const routerStats = ws.router_stats;

  res.json({
    status:    'healthy',
    timestamp: new Date().toISOString(),
    proxy: {
      cache_size:     proxyStats.cache_size,
      total_requests: proxyStats.total_requests,
      cache_hits:     proxyStats.cache_hits,
    },
    websocket: ws,
    tunnels,
    node_gateway: nodeGatewayStats.getStats(),
    node_tunnel: nodeTunnelStats.getStats(),
    network: {
      avg_http_latency_ms: routerStats.avg_http_latency_ms,
      avg_ws_latency_ms:   routerStats.avg_ws_latency_ms,
    },
  });
});

app.get('/stats', publicLimiter, (_req, res) => {
  const stats = proxy.getStats();
  res.json({
    ...stats,
    cache_hit_rate:
      stats.total_requests > 0
        ? ((stats.cache_hits / stats.total_requests) * 100).toFixed(2) + '%'
        : '0%',
    uptime: process.uptime(),
  });
});

app.post('/proxy', proxyLimiter, async (req, res, next) => {
  const { target_url, target_ref, method = 'GET', headers = {}, body } = req.body;
  if (!target_url && target_ref?.kind !== 'tunnel') return next();

  const requestId = crypto.randomUUID();
  const requestStartedAt = Date.now();
  res.locals.proxyRequestId = requestId;
  res.locals.proxyRequestStartedAt = requestStartedAt;
  log.info('proxy-http', 'request-received', {
    request_id: requestId,
    method: String(method).toUpperCase(),
    ...proxyRequestTargetForLog(target_url, target_ref),
  });

  let dedupeKey;
  try {
    if (target_ref?.kind === 'tunnel') {
      await proxy.authorizeTunnelTarget(target_ref);
      dedupeKey = proxy.computeTunnelDedupeKey({ target_ref, method, headers, body });
    } else {
      dedupeKey = proxy.computeDedupeKey({ target_url, method, headers, body });
    }
  } catch (error) {
    const status = Number(error?.statusCode) || 400;
    log.warn('proxy-http', 'request-rejected', {
      request_id: requestId,
      method: String(method).toUpperCase(),
      status,
      message: error instanceof Error ? error.message : String(error),
      ...proxyRequestTargetForLog(target_url, target_ref),
    });
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Invalid proxy target' });
  }
  const cached = proxy.getCached(dedupeKey);

  if (cached) {
    log.info('proxy-http', 'request-completed', {
      request_id: requestId,
      method: String(method).toUpperCase(),
      status: cached.status,
      cache_layer: 'pre-payment',
      cached: true,
      served_by: cached.served_by ?? null,
      dedupe_key: dedupeKey.substring(0, 12),
      total_ms: Date.now() - requestStartedAt,
      ...proxyRequestTargetForLog(target_url, target_ref),
    });
    return res.json({
      status: cached.status,
      statusText: cached.statusText,
      headers: cached.headers,
      data: cached.data,
      meta: {
        cached: true,
        dedupe_key: dedupeKey,
        served_by: cached.served_by ?? null,
        timestamp: new Date().toISOString(),
      },
    });
  }

  log.info('proxy-http', 'cache-miss', {
    request_id: requestId,
    method: String(method).toUpperCase(),
    dedupe_key: dedupeKey.substring(0, 12),
    ...proxyRequestTargetForLog(target_url, target_ref),
  });
  next();
});

if (!FREE_MODE) {
  app.use(
    paymentMiddleware(
      {
        'POST /proxy': {
          accepts: [
            { scheme: 'exact', price: '$0.001', network: 'eip155:84532', payTo: EVM_PAY_TO },
            { scheme: 'exact', price: '$0.001', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', payTo: SOLANA_PAY_TO },
            { scheme: 'exact', price: '100000', network: 'icp:1:xafvr-biaaa-aaaai-aql5q-cai', payTo: ICP_PAY_TO },
          ],
          description: 'API Deduplication Service',
          mimeType: 'application/json',
        },
      },
      x402Server
    )
  );
}

app.post('/proxy', async (req, res) => {
  const startTime = Date.now();
  const requestId = res.locals.proxyRequestId ?? crypto.randomUUID();
  const requestStartedAt = res.locals.proxyRequestStartedAt ?? startTime;

  try {
    const { target_url, target_ref, method = 'GET', headers = {}, body } = req.body;

    if (!target_url && target_ref?.kind !== 'tunnel') {
      return res.status(400).json({ error: 'Missing target_url or target_ref' });
    }

    const methodUpper = String(method).toUpperCase();
    const isVerbose = Boolean(headers['x-verbose'] || headers['X-Verbose']);
    log.info('proxy-http', 'execution-started', {
      request_id: requestId,
      method: methodUpper,
      verbose: isVerbose,
      ...proxyRequestTargetForLog(target_url, target_ref),
    });

    if (
      !headers['x-idempotency-key'] &&
      !headers['idempotency-key'] &&
      !headers['X-Idempotency-Key']
    ) {
      headers['x-idempotency-key'] = crypto.randomBytes(16).toString('hex');
    }

    // Direct data plane (opt-in via x-direct): select a node and return a signed
    // routing ticket + the node's connection info so the client connects to the
    // node directly. Falls through to inline serving when the orchestrator is the
    // chosen node (server-as-node fallback).
    const wantsDirect = Boolean(headers['x-direct'] || headers['X-Direct']);
    if (wantsDirect && target_ref?.kind !== 'tunnel' && target_url) {
      const route = proxy.routeRequest(target_url, methodUpper, headers, body);
      if (route.mode === 'node') {
        log.info('proxy-http', 'request-routed', {
          request_id: requestId,
          method: methodUpper,
          node_id: route.node_id,
          dedupe_key: route.dedupe_key.substring(0, 12),
          total_ms: Date.now() - requestStartedAt,
          ...proxyRequestTargetForLog(target_url, target_ref),
        });
        return res.json({
          route: {
            node_id:         route.node_id,
            domain:          route.domain,
            node_pubkey_pem: route.node_pubkey_pem,
            ticket:          route.ticket,
            ticket_exp:      route.ticket_exp,
            dedupe_key:      route.dedupe_key,
          },
          meta: {
            direct: true,
            served_by: route.node_id,
            dedupe_key: route.dedupe_key,
            timestamp: new Date().toISOString(),
          },
        });
      }
      // route.mode === 'self' → fall through to serve inline below.
    }

    const response = target_ref?.kind === 'tunnel'
      ? await proxy.handleTunnelRequest(target_ref, methodUpper, headers, body)
      : await proxy.handleRequest(target_url, methodUpper, headers, body);

    const processingTime = Date.now() - startTime;
    log.info('proxy-http', 'request-completed', {
      request_id: requestId,
      method: methodUpper,
      status: response.status,
      cached: response.cached ?? false,
      served_by: response.served_by ?? null,
      dedupe_key: response.dedupe_key?.substring(0, 12) ?? null,
      processing_ms: processingTime,
      total_ms: Date.now() - requestStartedAt,
      ...proxyRequestTargetForLog(target_url, target_ref),
    });

    const fullResponse = {
      status: response.status,
      statusText: response.statusText || 'OK',
      headers: response.headers,
      data: response.data,
      meta: {
        cached: response.cached,
        dedupe_key: response.dedupe_key,
        served_by: response.served_by ?? null,
        processing_ms: processingTime,
        timestamp: new Date().toISOString(),
      },
    };

    const payload = isVerbose
      ? fullResponse
      : {
          status: fullResponse.status,
          statusText: fullResponse.statusText,
          data: fullResponse.data,
        };

    return res.status(fullResponse.status).json(payload);
  } catch (error) {
    if (res.headersSent) return;
    log.error('proxy-http', 'request-failed', {
      request_id: requestId,
      method: String(req.body?.method ?? 'GET').toUpperCase(),
      total_ms: Date.now() - requestStartedAt,
      message: error instanceof Error ? error.message : String(error),
      ...proxyRequestTargetForLog(req.body?.target_url, req.body?.target_ref),
    });
    const status = Number(error?.statusCode) || 500;
    res.status(status).json({
      error: 'Proxy request failed',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});
let observerInterval;

server.listen(PORT, '::', () => {
  log.info('server', 'listening', {
    port: PORT,
    bind: '::',
    free_mode: FREE_MODE,
    auto_updates: process.env.CONSENSUS_NODE_AUTO_UPDATES === 'true',
  });
  observerInterval = startObservationScheduler();
  upsertServerNode();
});

['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => {
    log.warn('server', 'shutdown-signal', { signal });
    clearInterval(observerInterval);
    server.close(() => {
      log.warn('server', 'shutdown-complete', { signal });
      process.exit(0);
    });
  });
});
