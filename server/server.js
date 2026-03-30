import '@dotenvx/dotenvx/config';
import http from 'http';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'crypto';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 8080;
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const EVM_PAY_TO = process.env.EVM_PAY_TO;
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO;
const ICP_PAY_TO = process.env.ICP_PAY_TO;

if (!process.env.FACILITATOR_URL) {
  throw new Error('FACILITATOR_URL is missing from .env');
}
if (!EVM_PAY_TO || !SOLANA_PAY_TO || !ICP_PAY_TO) {
  throw new Error('Missing required env var(s): EVM_PAY_TO, SOLANA_PAY_TO, ICP_PAY_TO');
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const x402Server = new x402ResourceServer(facilitatorClient)
  .register('eip155:84532', new ExactEvmScheme())
  .register('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', new ExactSvmScheme())
  .register('icp:1:xafvr-biaaa-aaaai-aql5q-cai', new ExactIcpScheme());

const router = new Router();
const proxy = new ConsensusProxy({ router: router });

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
registerWhitepaperSignup(app);

const server = http.createServer(app);
const wsStats = registerWebSocket(
  app,
  server,
  x402Server,
  {
    EVM_PAY_TO,
    SOLANA_PAY_TO,
    ICP_PAY_TO,
  },
  router
);

const nodeStats = registerNodes(app, server, x402Server, {
  EVM_PAY_TO,
  SOLANA_PAY_TO,
  ICP_PAY_TO,
});
const tunnelStats = registerTunnel(app, server);

app.get('/', (req, res) => {
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

app.get('/health', (req, res) => {
  const stats = proxy.getStats();
  const ws = wsStats.getStats();
  const nodes = nodeStats.getStats();
  const tunnels = tunnelStats.getStats();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    proxy: {
      cache_size: stats.cache_size,
      total_requests: stats.total_requests,
      cache_hits: stats.cache_hits,
    },
    websocket: ws,
    nodes: nodes,
    tunnels,
  });
});

app.get('/stats', (_req, res) => {
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

app.use(
  paymentMiddleware(
    {
      'POST /proxy': {
        accepts: [
          {
            scheme: 'exact',
            price: '$0.001',
            network: 'eip155:84532',
            payTo: EVM_PAY_TO,
          },
          {
            scheme: 'exact',
            price: '$0.001',
            network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            payTo: SOLANA_PAY_TO,
          },
          {
            scheme: 'exact',
            price: '100000',
            network: 'icp:1:xafvr-biaaa-aaaai-aql5q-cai',
            payTo: ICP_PAY_TO,
          },
        ],
        description: 'API Deduplication Service',
        mimeType: 'application/json',
      },
    },
    x402Server
  )
);

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
server.listen(PORT, '::', () => {
  console.log(`Consensus x402 Proxy Service`);
  console.log(`URL: http://consensus.canister.software:8888`);
});

['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  });
});
