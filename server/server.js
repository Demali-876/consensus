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
import { fileURLToPath } from 'url';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactIcpScheme } from '@canister-software/x402-icp/server';
import { registerWhitepaperSignup } from './data/whitepaperSignup.js';
import { registerWebSocket } from './features/websocket/wss.ts';
import { registerNodes } from './features/nodes/orchestrator.js';
import { registerTunnel } from './features/tunnel/tunnel.ts';
import { registerNodeTunnel } from './features/node-tunnel/node-tunnel.ts';
import { startObservationScheduler, upsertServerNode } from './features/ip-pool/observer.ts';
import { registerUpdater } from './updater.ts';
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

const PORT = 8080;
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const EVM_PAY_TO = process.env.EVM_PAY_TO;
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO;
const ICP_PAY_TO = process.env.ICP_PAY_TO;

const FREE_MODE = process.env.FREE_MODE === 'true';

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

const server = http.createServer(app);
const nodeTunnelStats = registerNodeTunnel(app, server, { router });
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
const proxy = new ConsensusProxy({ router: router, nodeTunnel: nodeTunnelStats });

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

app.post('/proxy', async (req, res, next) => {
  const { target_url, method = 'GET', headers = {}, body } = req.body;
  if (!target_url) return next();

  const dedupeKey = proxy.computeDedupeKey({ target_url, method, headers, body });
  const cached = proxy.getCached(dedupeKey);

  if (cached) {
    console.log(`[Cache HIT - Pre-Payment] ${dedupeKey.substring(0, 12)}...`);
    return res.json({
      status: cached.status,
      statusText: cached.statusText,
      data: cached.data,
      meta: {
        cached: true,
        dedupe_key: dedupeKey,
        timestamp: new Date().toISOString(),
      },
    });
  }

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

  try {
    const { target_url, method = 'GET', headers = {}, body } = req.body;

    if (!target_url) {
      return res.status(400).json({ error: 'Missing target_url' });
    }

    const methodUpper = String(method).toUpperCase();
    const isVerbose = Boolean(headers['x-verbose'] || headers['X-Verbose']);

    if (
      !headers['x-idempotency-key'] &&
      !headers['idempotency-key'] &&
      !headers['X-Idempotency-Key']
    ) {
      headers['x-idempotency-key'] = crypto.randomBytes(16).toString('hex');
    }

    const response = await proxy.handleRequest(target_url, methodUpper, headers, body);

    const processingTime = Date.now() - startTime;

    const fullResponse = {
      status: response.status,
      statusText: response.statusText || 'OK',
      headers: response.headers,
      data: response.data,
      meta: {
        cached: response.cached,
        dedupe_key: response.dedupe_key,
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
    res.status(500).json({
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
