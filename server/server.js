import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import cors from 'express-rate-limit';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import ConsensusProxy from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');


const PORT = 8080;
const FACILITATOR_URL = 'https://facilitator.payai.network';
const EVM_PAY_TO = '0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f';

const MAIN_TLS_KEY = process.env.MAIN_TLS_KEY_PATH || path.join(root, 'scripts/certs', 'main.key');
const MAIN_TLS_CERT = process.env.MAIN_TLS_CERT_PATH || path.join(root, 'scripts/certs', 'main.crt');


const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const x402Server = new x402ResourceServer(facilitatorClient)
  .register('eip155:84532', new ExactEvmScheme());

const proxy = new ConsensusProxy();
const processingRequests = new Map();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({
    name: 'Consensus x402 Server',
    version: '2.0.0',
    status: 'running',
    payment_network: 'Base Sepolia',
    payment_address: EVM_PAY_TO,
    facilitator: FACILITATOR_URL,
    endpoints: {
      proxy: 'POST /proxy - Deduplicated API calls with x402 payments',
      health: 'GET /health - Health check',
      stats: 'GET /stats - Cache statistics',
    },
  });
});

app.get('/health', (req, res) => {
  const stats = proxy.getStats();
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    cache_size: stats.cache_size,
    total_requests: stats.total_requests,
    cache_hits: stats.cache_hits,
  });
});

app.get('/stats', (req, res) => {
  const stats = proxy.getStats();
  res.json({
    ...stats,
    cache_hit_rate: stats.total_requests > 0 ? 
      ((stats.cache_hits / stats.total_requests) * 100).toFixed(2) + '%' : '0%',
    uptime: process.uptime(),
  });
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
        ],
        description: 'API Deduplication Service',
        mimeType: 'application/json',
      },
    },
    x402Server,
  ),
);

app.post('/proxy', async (req, res) => {
  const startTime = Date.now();

  try {
    const { target_url, method = 'GET', headers = {} } = req.body;

    if (!target_url) {
      return res.status(400).json({ error: 'Missing target_url' });
    }

    const methodUpper = String(method).toUpperCase();
    const idempotencyKey = headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return res.status(400).json({ 
        error: 'Missing x-idempotency-key in headers' 
      });
    }

    console.log(`Processing ${methodUpper} with key: [${idempotencyKey}]`);

    const inFlight = processingRequests.get(idempotencyKey);
    if (inFlight) {
      console.log(`Waiting for existing request: ${idempotencyKey}`);
      const existingResponse = await inFlight;
      return res.status(existingResponse.status).json(existingResponse);
    }

    const requestPromise = (async () => {
      try {
        const response = await proxy.handleRequest(target_url, methodUpper, headers, {});

        const processingTime = Date.now() - startTime;

        return {
          status: response.status,
          statusText: response.statusText || 'OK',
          headers: response.headers,
          data: response.data,
          meta: {
            cached: response.cached,
            processing_ms: processingTime,
            timestamp: new Date().toISOString(),
          },
        };
      } finally {
        processingRequests.delete(idempotencyKey);
      }
    })();

    processingRequests.set(idempotencyKey, requestPromise);

    const finalPayload = await requestPromise;
    console.log(`✅ Request completed (${finalPayload.meta.cached ? 'cached' : 'fresh'})`);
    
    return res.status(finalPayload.status).json(finalPayload);

  } catch (error) {
    console.error('Proxy error:', error);
    
    if (res.headersSent) return;

    res.status(500).json({ 
      error: 'Proxy request failed',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

const server = https.createServer(
  {
    key: fs.readFileSync(MAIN_TLS_KEY),
    cert: fs.readFileSync(MAIN_TLS_CERT),
  },
  app
);

server.listen(PORT, '::', () => {
  console.log(`\n🚀 Consensus x402 Deduplication Server`);
  console.log(`   URL: https://consensus.canister.software:${PORT}`);
});

['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  });
});