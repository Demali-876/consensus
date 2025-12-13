import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import crypto from 'crypto';
import { settleResponseHeader } from 'x402/types';
import ConsensusProxy from './proxy.js';
import { createPaymentRequirements, verifyPayment, settle, x402Version, facilitatorUrl, payTo } from './utils/helper.js';
import { benchmarkNode } from './utils/benchmark.js';
import { provisionNodeDNS, updateNodeDNS } from './utils/dns.js';
import NodeStore from '../data/node_store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const MAIN_TLS_KEY  = process.env.MAIN_TLS_KEY_PATH  || path.join(root, 'scripts/certs', 'main.key');
const MAIN_TLS_CERT = process.env.MAIN_TLS_CERT_PATH || path.join(root, 'scripts/certs', 'main.crt');

// mTLS certs
const MTLS_SERVER_KEY  = path.join(root, 'scripts/mtls-certs', 'server.key');
const MTLS_SERVER_CERT = path.join(root, 'scripts/mtls-certs', 'server.crt');
const MTLS_CA_CERT     = path.join(root, 'scripts/mtls-certs', 'ca.crt');

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
    description: 'HTTPS API Deduplication Service with x402 Payments',
    pricing: '$0.001 per unique API call (cached responses are free)',
    payment_network: 'Base Sepolia',
    payment_address: payTo,
    facilitator_url: facilitatorUrl,
    endpoints: {
      proxy: 'POST /proxy - Make deduplicated API calls',
      health: 'GET /health - Service health check',
      stats: 'GET /stats - Service statistics',
      node_join: 'POST /node/join - Request to join network',
      node_verify: 'POST /node/verify/:join_id - Verify and register node',
      nodes: 'GET /nodes - List all nodes'
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
        error: 'Unsupported HTTPS method',
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

// NODE NETWORK ENDPOINTS

// Step 1: Request to join network
app.post('/node/join', async (req, res) => {
  try {
    const { pubkey_pem, alg, region, capabilities, contact } = req.body;
    
    // Validate inputs
    if (!pubkey_pem || !alg) {
      return res.status(400).json({ error: 'Missing pubkey or alg' });
    }
    
    console.log(`\n📝 Join request received`);
    console.log(`   Region: ${region || 'unspecified'}`);
    console.log(`   Algorithm: ${alg}`);
    
    // Convert PEM to buffer
    const pubkey = crypto.createPublicKey(pubkey_pem).export({ 
      format: 'der', 
      type: 'spki' 
    });
    
    // Create join request with challenge nonce
    const joinReq = NodeStore.createJoinRequest({
      pubkey,
      alg,
      ttlSeconds: 300 // 5 minutes to complete
    });
    
    console.log(`   ✓ Challenge nonce generated`);
    console.log(`   Join ID: ${joinReq.id}`);
    console.log(`   Expires: ${new Date(joinReq.expires_at * 1000).toISOString()}\n`);
    
    res.json({
      join_id: joinReq.id,
      challenge_nonce: joinReq.nonce, // base64url encoded
      expires_at: joinReq.expires_at,
      next_step: `Sign the nonce and POST to /node/verify/${joinReq.id} with signature, ipv6, port, and test_endpoint`
    });
    
  } catch (error) {
    console.error('Join error:', error);
    res.status(500).json({ error: 'Failed to create join request' });
  }
});

// Step 2: Verify signature and register node
app.post('/node/verify/:join_id', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { join_id } = req.params;
    const { 
      signature, 
      ipv6, 
      ipv4, 
      port, 
      region, 
      capabilities, 
      contact,
      test_endpoint 
    } = req.body;
    
    console.log(`\n🔐 Verifying join request: ${join_id}`);
    
    // Get join request
    const joinReq = NodeStore.getJoin(join_id);
    if (!joinReq) {
      return res.status(404).json({ error: 'Join request not found' });
    }
    
    // Check expiration
    if (Date.now() / 1000 > joinReq.expires_at) {
      console.log(`   ❌ Join request expired\n`);
      return res.status(410).json({ error: 'Join request expired' });
    }
    
    // Check if already consumed
    if (joinReq.consumed_at) {
      console.log(`   ❌ Join request already used\n`);
      return res.status(409).json({ error: 'Join request already used' });
    }
    
    // Validate required fields
    if (!signature || !ipv6 || !port || !test_endpoint) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['signature', 'ipv6', 'port', 'test_endpoint']
      });
    }
    
    // Validate IPv6 format
    if (!ipv6.includes(':')) {
      return res.status(400).json({
        error: 'Invalid IPv6 address format'
      });
    }
    
    console.log(`   IPv6: ${ipv6}:${port}`);
    console.log(`   Test endpoint: ${test_endpoint}`);
    
    // Verify signature
    console.log(`\n🔑 Verifying cryptographic signature...`);
    const publicKey = crypto.createPublicKey({
      key: joinReq.node_pubkey,
      format: 'der',
      type: 'spki'
    });
    
    const isValid = crypto.verify(
      joinReq.alg,
      joinReq.nonce,
      publicKey,
      Buffer.from(signature, 'base64')
    );
    
    if (!isValid) {
      console.log(`   ❌ Invalid signature\n`);
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    console.log(`   ✅ Signature verified`);
    
    // Run benchmark test
    console.log(`\n🧪 Running benchmark tests...`);
    const benchmarkResult = await benchmarkNode(test_endpoint);
    
    if (!benchmarkResult.passed) {
      console.log(`   ❌ Benchmark failed with score: ${benchmarkResult.score}/100\n`);
      
      return res.status(400).json({
        error: 'Node performance below minimum requirements',
        score: benchmarkResult.score,
        required_score: 60,
        details: benchmarkResult.details,
        message: 'Please ensure your node meets minimum hardware requirements'
      });
    }
    
    console.log(`   ✅ Benchmark passed with score: ${benchmarkResult.score}/100`);
    
    // Generate unique node ID
    const nodeId = crypto.randomBytes(6).toString('hex');
    const subdomain = `${nodeId}.consensus.canister.software`;
    
    console.log(`\n🆔 Generated node ID: ${nodeId}`);
    console.log(`   Subdomain: ${subdomain}`);
    
    // Provision DNS via Namecheap
    console.log(`\n🌍 Provisioning DNS...`);
    try {
      await provisionNodeDNS(subdomain, ipv6, ipv4);
    } catch (dnsError) {
      console.error(`   ❌ DNS provisioning failed: ${dnsError.message}\n`);
      return res.status(500).json({
        error: 'DNS provisioning failed',
        message: dnsError.message
      });
    }
    
    // Save node to database
    console.log(`\n💾 Storing node in database...`);
    const node = NodeStore.upsertNode({
      id: nodeId,
      pubkey: joinReq.node_pubkey,
      alg: joinReq.alg,
      region: region || null,
      capabilities: {
        ...capabilities,
        benchmark_score: benchmarkResult.score,
        fetch_latency: benchmarkResult.details.fetch.avg_latency_ms,
        cpu_performance: benchmarkResult.details.cpu.hashes_per_second,
        ipv6,
        ipv4: ipv4 || null,
        port
      },
      contact: contact || null,
      status: 'active'
    });
    
    NodeStore.setDomain(nodeId, subdomain, 'ipv6');
    NodeStore.consumeJoin(join_id);
    
    console.log(`   ✅ Node stored successfully`);
    
    const processingTime = Date.now() - startTime;
    
    console.log(`\n✅ Node registration complete in ${processingTime}ms\n`);
    console.log('='.repeat(60));
    console.log('\n');
    
    res.json({
      success: true,
      node_id: nodeId,
      domain: subdomain,
      ipv6,
      ipv4: ipv4 || null,
      port,
      status: 'active',
      benchmark_score: benchmarkResult.score,
      benchmark_details: benchmarkResult.details,
      gateway_url: 'https://consensus.canister.software:8080',
      processing_time_ms: processingTime,
      message: 'Node registered successfully',
      next_steps: [
        'DNS propagation may take up to 5 minutes',
        'Your node is now part of the Consensus network',
        'Start sending heartbeats to maintain active status',
        'Monitor your node at /node/status/' + nodeId
      ]
    });
    
  } catch (error) {
    console.error('❌ Verification error:', error);
    res.status(500).json({
      error: 'Verification failed',
      message: error.message
    });
  }
});

// Node status endpoint
app.get('/node/status/:node_id', (req, res) => {
  const { node_id } = req.params;
  
  const node = NodeStore.getNode(node_id);
  
  if (!node) {
    return res.status(404).json({
      error: 'Node not found'
    });
  }
  
  res.json({
    node_id: node.id,
    domain: node.domain,
    status: node.status,
    region: node.region,
    capabilities: node.capabilities,
    created_at: node.created_at,
    updated_at: node.updated_at,
    heartbeat: node.heartbeat
  });
});

// List all nodes
app.get('/nodes', (req, res) => {
  const nodes = NodeStore.listNodes();
  
  res.json({
    total: nodes.length,
    nodes: nodes.map(node => ({
      node_id: node.id,
      domain: node.domain,
      status: node.status,
      region: node.region,
      benchmark_score: node.capabilities?.benchmark_score,
      ipv6: node.capabilities?.ipv6,
      ipv4: node.capabilities?.ipv4,
      port: node.capabilities?.port,
      created_at: node.created_at,
      heartbeat: node.heartbeat
    }))
  });
});

// IP update endpoint (for nodes to update their IP)
app.post('/node/update-ip/:node_id', async (req, res) => {
  try {
    const { node_id } = req.params;
    const { ipv6, ipv4 } = req.body;
    
    const node = NodeStore.getNode(node_id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    
    console.log(`\n🔄 Updating IP for node ${node_id}`);
    console.log(`   New IPv6: ${ipv6}`);
    if (ipv4) console.log(`   New IPv4: ${ipv4}`);
    
    // Update DNS
    await updateNodeDNS(node.domain, ipv6, ipv4);
    
    // Update capabilities in database
    const updatedCapabilities = {
      ...node.capabilities,
      ipv6,
      ipv4: ipv4 || null
    };
    
    NodeStore.upsertNode({
      id: node_id,
      pubkey: node.pubkey,
      alg: node.alg,
      region: node.region,
      capabilities: updatedCapabilities,
      contact: node.contact,
      status: node.status
    });
    
    console.log(`   ✅ IP updated successfully\n`);
    
    res.json({
      success: true,
      message: 'IP updated successfully',
      node_id,
      ipv6,
      ipv4: ipv4 || null
    });
    
  } catch (error) {
    console.error('IP update error:', error);
    res.status(500).json({
      error: 'IP update failed',
      message: error.message
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

['SIGTERM', 'SIGINT'].forEach(signal => process.on(signal, () => { 
  console.log(`\n${signal} received, shutting down gracefully...`);
  process.exit(0); 
}));

const server = https.createServer(
  {
    key:  fs.readFileSync(MTLS_SERVER_KEY),
    cert: fs.readFileSync(MTLS_SERVER_CERT),
    ca:   fs.readFileSync(MTLS_CA_CERT),
    requestCert: true,
    rejectUnauthorized: true,
    handshakeTimeout: 30000,
    requestTimeout: 30000,
    headersTimeout: 30000,
    keepAliveTimeout: 5000
  },
  app
);

server.listen(port, '0.0.0.0', () => {
  console.log(`Consensus Server (mTLS) on https://consensus.canister.software:${port}`);
  console.log(`Node network endpoints ready`);
});