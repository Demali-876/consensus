import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { settleResponseHeader } from 'x402/types';
import ConsensusProxy from './proxy.js';
import { createPaymentRequirements, verifyPayment, settle, x402Version, facilitatorUrl, payTo } from './utils/helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const MAIN_TLS_KEY  = process.env.MAIN_TLS_KEY_PATH  || path.join(root, 'certs', 'main.key');
const MAIN_TLS_CERT = process.env.MAIN_TLS_CERT_PATH || path.join(root, 'certs', 'main.crt');
const CA_CERT       = process.env.CA_CERT_PATH       || path.join(root, 'certs', 'ca.crt');


const app = express();
const port = process.env.CONSENSUS_SERVER_PORT || 8080;
const proxy = new ConsensusProxy();
const processingRequests = new Map();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: { error: 'Too many requests, please try again later' }
});

app.use(limiter);
app.use(helmet());
app.use(cors());

app.use(express.json({ 
  limit: '10mb',
  strict: false,
  type: ['application/json', 'text/plain']
}));

// Basic info endpoint
app.get('/', (req, res) => {
  res.json({ 
    name: 'Consensus', 
    status: 'running',
    version: '1.0.1',
    description: 'HTTP API Deduplication Service with x402 Payments',
    pricing: '$0.001 per unique API call (cached responses are free)',
    payment_network: 'Base Sepolia',
    payment_address: payTo,
    facilitator_url: facilitatorUrl,
    endpoints: {
      proxy: 'POST /proxy - Make deduplicated API calls',
      health: 'GET /health - Service health check',
      stats: 'GET /stats - Service statistics'
    },
    usage: {
      note: 'Use x402-enabled client for automatic payments',
      x402_proxy: 'Required for payment handling'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const stats = proxy.getStats();
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    cache_size: stats.cache_size,
    total_requests: stats.total_requests,
    cache_hits: stats.cache_hits,
    payment_address: payTo,
    facilitator_url: facilitatorUrl,
    x402_version: x402Version
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const stats = proxy.getStats();
  res.json({
    ...stats,
    pricing: '$0.001 per unique API call',
    payment_method: 'x402 automatic payments',
    payment_address: payTo,
    facilitator_url: facilitatorUrl,
    network: 'base-sepolia',
    cache_hit_rate: stats.total_requests > 0 ? 
      ((stats.cache_hits / stats.total_requests) * 100).toFixed(2) + '%' : '0%',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.all('/proxy', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { target_url, method = 'GET', headers = {}, body } = req.body;
    
    if (!target_url) {
      return res.status(400).json({ 
        error: 'Missing target_url',
        message: 'target_url is required in request body',
      });
    }

    try {
      new URL(target_url);
    } catch (urlError) {
      return res.status(400).json({
        error: 'Invalid target_url'
      });
    }

    const methodUpper = method.toUpperCase();
    const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    if (!allowedMethods.includes(methodUpper)) {
      return res.status(400).json({
        error: 'Unsupported HTTP method',
        message: `Method "${method}" is not supported`,
        allowed_methods: allowedMethods
      });
    }

    const idempotencyKey = headers['x-idempotency-key'] ||
                          headers['idempotency-key'] ||
                          headers['Idempotency-key'] ||
                          headers['Idempotency-Key'] ||
                          headers['X-Idempotency-Key'];
    
    if (!idempotencyKey) {
      return res.status(400).json({ 
        error: 'Missing idempotency key',
        message: 'x-idempotency-key is required in headers',
        required: 'Include x-idempotency-key in headers object for deduplication'
      });
    }

    console.log(`Processing ${method} With key: [${idempotencyKey}]`);

    if (processingRequests.has(idempotencyKey)) {
      console.log(`Request already in progress, waiting: ${idempotencyKey}`);
      try {
        const existingResponse = await processingRequests.get(idempotencyKey);
        return res.status(existingResponse.status).json({
          status: existingResponse.status,
          statusText: existingResponse.statusText || 'OK',
          headers: existingResponse.headers,
          data: existingResponse.data,
          meta: {
            cached_concurrent_request: true,
            timestamp: new Date().toISOString()
          }
        });
      } catch (waitError) {
        console.error(`Error waiting for existing request: ${waitError.message}`);
        processingRequests.delete(idempotencyKey);
      }
    }

    const requiresPayment = proxy.requiresPayment(idempotencyKey);
    
    if (requiresPayment) {
      console.log(`Payment required for: ${idempotencyKey}`);

      const resource = `${req.protocol}://${req.headers.host}/proxy`;
      const paymentRequirements = createPaymentRequirements("$0.001", resource, `Consensus Deduplication: ${target_url}`);

      const paymentResult = await verifyPayment(req, res, paymentRequirements);
      if (!paymentResult || !paymentResult.isValid) {
        return;
      }
      if (processingRequests.has(idempotencyKey)) {
        console.log(`Another request started processing during payment verification: ${idempotencyKey}`);
        try {
          const existingResponse = await processingRequests.get(idempotencyKey);
          return res.status(existingResponse.status).json({
            status: existingResponse.status,
            statusText: existingResponse.statusText || 'OK',
            headers: existingResponse.headers,
            data: existingResponse.data,
            meta: {
              cached_concurrent_request: true,
              timestamp: new Date().toISOString()
            }
          });
        } catch (waitError) {
          console.error(`Error waiting for existing request: ${waitError.message}`);
          processingRequests.delete(idempotencyKey);
        }
      }

      proxy.markAsPaid(idempotencyKey);
      console.log(`Payment verified for: ${idempotencyKey}`);

      try {
        const settleResponse = await settle(paymentResult.decodedPayment, paymentRequirements);
        const responseHeader = settleResponseHeader(settleResponse);
        res.setHeader("X-PAYMENT-RESPONSE", responseHeader);
        console.log(`Payment settled for: ${idempotencyKey}`);
      } catch (settleError) {
        console.error('Payment settlement failed:', settleError.message);
      }
    }
    const requestPromise = (async () => {
      try {
        const response = await proxy.handleRequest(target_url, method, headers, body);
        return response;
      } catch (error) {
        processingRequests.delete(idempotencyKey);
        throw error;
      }
    })();
    processingRequests.set(idempotencyKey, requestPromise);

    try {
      const response = await requestPromise;
      const processingTime = Date.now() - startTime;

      const verboseHeader = req.headers['x-verbose'];
      const isVerbose = typeof verboseHeader === 'string' && verboseHeader.toLowerCase() === 'true';

      processingRequests.delete(idempotencyKey);

      if (isVerbose) {
        return res.status(response.status).json({
          status: response.status,
          statusText: response.statusText || 'OK',
          headers: response.headers,
          data: response.data,
          billing: {
            cost: requiresPayment ? '$0.001' : '$0.000',
            reason: response.cached ? 'cache_hit' : 'payment_processed',
            idempotency_key: idempotencyKey,
            processing_time_ms: processingTime
          },
          meta: {
            timestamp: new Date().toISOString(),
            server_version: '1.0.1'
          }
        });
      }

      return res.status(response.status).json({
        status: response.status,
        statusText: response.statusText || 'OK',
        headers: response.headers,
        data: response.data
      });
    } catch (error) {
      processingRequests.delete(idempotencyKey);
      throw error;
    }
  } catch (error) {
    console.error('Proxy request error:', error);

    if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      return res.status(502).json({
        error: 'Target API unreachable',
        message: 'Unable to connect to the target API',
        target_url: req.body?.target_url
      });
    }
    if (error.message.includes('timeout')) {
      return res.status(504).json({
        error: 'Request timeout',
        message: 'Target API did not respond in time',
        target_url: req.body?.target_url
      });
    }

    res.status(500).json({ 
      error: 'Internal server error',
      message: 'An unexpected error occurred processing your request',
      timestamp: new Date().toISOString()
    });
  }
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

const server = https.createServer(
  {
    key:  fs.readFileSync(MAIN_TLS_KEY),
    cert: fs.readFileSync(MAIN_TLS_CERT),
    ca:   fs.readFileSync(CA_CERT),
    requestCert: true,
    rejectUnauthorized: true
  },
  app
);

server.listen(port, '0.0.0.0', () => {
  console.log(` Server (mTLS) on https://0.0.0.0:${port}`);
});