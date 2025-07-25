require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const axios = require('axios');
const zlib = require('zlib');
const { exact } = require('x402/schemes');
const { useFacilitator } = require('x402/verify');
const { processPriceToAtomicAmount } = require('x402/shared');
const { settleResponseHeader } = require("x402/types");
const ConsensusProxy = require('./proxy');

const app = express();
const port = process.env.CONSENSUS_SERVER_PORT || 8080;
const proxy = new ConsensusProxy();

app.use(helmet());
app.use(cors());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: { error: 'Too many requests, please try again later' }
});
app.use(limiter);

const facilitatorUrl = process.env.FACILITATOR_URL || "https://facilitator.x402.rs/";
const payTo = process.env.WALLET_ADDRESS || "0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f";

const facilitatorConfig = {
  url: facilitatorUrl,
  timeout: 30000,
  headers: {
    'User-Agent': 'consensus-server/1.0.1',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
};

const { verify, settle } = useFacilitator(facilitatorConfig);
const x402Version = 1;

// Track concurrent requests to prevent double charging
const processingRequests = new Map();

// Function to make actual API requests
async function makeApiRequest(url, method, headers, body) {
  const cleanHeaders = { ...headers };

  // Remove headers that shouldn't be forwarded
  delete cleanHeaders['host'];
  delete cleanHeaders['content-length'];
  delete cleanHeaders['content-encoding'];
  delete cleanHeaders['transfer-encoding'];
  delete cleanHeaders['connection'];
  delete cleanHeaders['x-idempotency-key'];
  delete cleanHeaders['idempotency-key'];
  delete cleanHeaders['X-Idempotency-Key'];
  delete cleanHeaders['x-payment'];
  delete cleanHeaders['X-Payment'];
  delete cleanHeaders['x-verbose'];
  delete cleanHeaders['X-Verbose'];

  const config = {
    method: method.toLowerCase(),
    url,
    headers: cleanHeaders,
    timeout: 30000,
    validateStatus: () => true,
    maxRedirects: 5,
    decompress: false,
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  };

  if (body && ['post', 'put', 'patch'].includes(method.toLowerCase())) {
    config.data = body;
    if (!cleanHeaders['content-type'] && typeof body === 'object') {
      config.headers['content-type'] = 'application/json';
    }
  }

  try {
    console.log(`Making API request: ${method} ${url}`);
    const response = await axios(config);
    let rawData = response.data;
    let contentEncoding = (response.headers['content-encoding'] || '').toLowerCase();

    // Handle compressed responses
    if (contentEncoding === 'gzip') {
      rawData = zlib.gunzipSync(rawData);
    } else if (contentEncoding === 'deflate') {
      rawData = zlib.inflateSync(rawData);
    } else if (contentEncoding === 'br') {
      rawData = zlib.brotliDecompressSync(rawData);
    }

    const textData = Buffer.from(rawData).toString('utf8');

    let parsed;
    try {
      parsed = JSON.parse(textData);
    } catch (e) {
      parsed = textData;
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: parsed,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error(`API request failed for ${url}:`, error.message);
    
    return {
      status: error.response?.status || 500,
      statusText: error.response?.statusText || 'Internal Server Error',
      headers: error.response?.headers || {},
      data: {
        error: 'Request failed',
        message: error.message,
        code: error.code,
        url: url
      },
      timestamp: Date.now()
    };
  }
}

function createPaymentRequirements(resource, description = "Consensus: HTTP Deduplication Service") {
  try {
    const atomicAmountForAsset = processPriceToAtomicAmount("$0.001", "base-sepolia");
    if ("error" in atomicAmountForAsset) {
      throw new Error(atomicAmountForAsset.error);
    }
    const { maxAmountRequired, asset } = atomicAmountForAsset;

    return {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired,
      resource,
      description,
      mimeType: "application/json",
      payTo: payTo,
      maxTimeoutSeconds: 60,
      asset: asset.address,
      outputSchema: undefined,
      extra: {
        name: asset.eip712.name,
        version: asset.eip712.version,
      },
    };
  } catch (error) {
    console.error('Error creating payment requirements:', error);
    throw error;
  }
}

app.use(express.json({ 
  limit: '10mb',
  strict: false,
  type: ['application/json', 'text/plain']
}));

async function verifyPayment(req, res, paymentRequirements) {
  const payment = req.header("X-PAYMENT");
  if (!payment) {
    return res.status(402).json({
      x402Version,
      error: "Payment required",
      message: "X-PAYMENT header is required for new API calls",
      accepts: [paymentRequirements],
    });
  }

  let decodedPayment;
  try {
    decodedPayment = exact.evm.decodePayment(payment);
    decodedPayment.x402Version = x402Version;
  } catch (error) {
    console.error('Payment decoding error:', error);
    return res.status(402).json({
      x402Version,
      error: "Invalid payment format",
      message: error?.message || "Malformed payment header",
      accepts: [paymentRequirements],
    });
  }

  try {
    console.log(`Verifying payment with facilitator: ${facilitatorUrl}`);
    const response = await verify(decodedPayment, paymentRequirements);
    
    if (!response.isValid) {
      console.log('Payment verification failed:', response.invalidReason);
      return res.status(402).json({
        x402Version,
        error: "Payment verification failed",
        message: response.invalidReason,
        accepts: [paymentRequirements],
        payer: response.payer,
      });
    }
    
    return { isValid: true, decodedPayment };
  } catch (error) {
    console.error('Payment verification error:', error);
    
    if (error.message.includes('fetch failed') || 
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('network')) {
      return res.status(402).json({
        x402Version,
        error: "Payment network error",
        message: "Unable to connect to payment facilitator.",
        accepts: [paymentRequirements],
      });
    }

    return res.status(402).json({
      x402Version,
      error: "Payment verification failed",
      message: "Unable to verify payment due to an unexpected error.",
      accepts: [paymentRequirements],
    });
  }
}

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
    x402_version: x402Version,
    currently_processing: processingRequests.size
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
    currently_processing: processingRequests.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.all('/proxy', async (req, res) => {
  const startTime = Date.now();

  try {
    const { target_url, method, headers = {}, body } = req.body;

    // Validate input
    if (!target_url) {
      return res.status(400).json({
        error: 'Missing target_url',
        message: 'target_url is required in request body'
      });
    }

    try {
      const parsedUrl = new URL(target_url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({
          error: 'Invalid protocol',
          message: 'Only http and https URLs are supported'
        });
      }
    } catch (urlError) {
      return res.status(400).json({
        error: 'Invalid target_url',
        message: 'target_url must be a valid HTTP/HTTPS URL'
      });
    }

    const methodUpper = (method || 'GET').toUpperCase();
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
                          headers['X-Idempotency-Key'];

    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'Missing idempotency key',
        message: 'x-idempotency-key is required in headers'
      });
    }

    console.log(`Processing: ${methodUpper} ${target_url} [${idempotencyKey}]`);

    // Check if this request is already being processed
    if (processingRequests.has(idempotencyKey)) {
      console.log(`Request already in progress, waiting: ${idempotencyKey}`);
      
      try {
        const existingResponse = await processingRequests.get(idempotencyKey);
        const processingTime = Date.now() - startTime;
        
        console.log(`Returning result for concurrent request: ${idempotencyKey}`);
        
        return res.status(existingResponse.status).json({
          status: existingResponse.status,
          statusText: existingResponse.statusText || 'OK',
          headers: existingResponse.headers,
          data: existingResponse.data
        });
      } catch (waitError) {
        console.error(`Error waiting for existing request: ${waitError.message}`);
        processingRequests.delete(idempotencyKey);
      }
    }

    // Check cache first
    const cachedResponse = proxy.checkCache(idempotencyKey);
    if (cachedResponse) {
      const processingTime = Date.now() - startTime;
      return res.status(cachedResponse.status).json({
        status: cachedResponse.status,
        statusText: cachedResponse.statusText || 'OK',
        headers: cachedResponse.headers,
        data: cachedResponse.data
      });
    }

    // Create request promise for concurrent handling
    const requestPromise = (async () => {
      let paymentSettled = false;

      // Check if payment is required
      const requiresPayment = proxy.requiresPayment(idempotencyKey);
      
      if (requiresPayment) {
        console.log(`Payment required for: ${idempotencyKey}`);

        const resource = `${req.protocol}://${req.headers.host}/proxy`;
        const paymentRequirements = createPaymentRequirements(resource, `Consensus: ${target_url}`);

        const paymentResult = await verifyPayment(req, res, paymentRequirements);
        if (!paymentResult || !paymentResult.isValid) {
          throw new Error('Payment verification failed');
        }

        // Mark as paid immediately after verification
        proxy.markAsPaid(idempotencyKey);
        console.log(`Payment verified for: ${idempotencyKey}`);

        try {
          const settleResponse = await settle(paymentResult.decodedPayment, paymentRequirements);
          const responseHeader = settleResponseHeader(settleResponse);
          res.setHeader("X-PAYMENT-RESPONSE", responseHeader);
          console.log(`Payment settled for: ${idempotencyKey}`);
          paymentSettled = true;
        } catch (settleError) {
          console.error('Payment settlement failed:', settleError.message);
        }
      }

      // Make the actual API request
      try {
        const response = await makeApiRequest(target_url, methodUpper, headers, body);
        
        // Cache the response
        proxy.cacheResponse(idempotencyKey, response);
        
        return response;
      } catch (error) {
        // If request fails after payment, remove paid status
        if (paymentSettled) {
          console.log(`Request failed after payment, removing paid status: ${idempotencyKey}`);
          proxy.removePaidStatus(idempotencyKey);
        }
        throw error;
      }
    })();

    // Store promise to handle concurrent requests
    processingRequests.set(idempotencyKey, requestPromise);

    // Cleanup function
    const cleanup = () => {
      processingRequests.delete(idempotencyKey);
    };
    
    requestPromise.finally(cleanup);
    setTimeout(cleanup, 5 * 60 * 1000); // 5 minute safety net

    try {
      const response = await requestPromise;
      const processingTime = Date.now() - startTime;

      return res.status(response.status).json({
        status: response.status,
        statusText: response.statusText || 'OK',
        headers: response.headers,
        data: response.data
      });
    } catch (requestError) {
      throw requestError;
    }

  } catch (error) {
    console.error('Proxy request error:', error);

    if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      return res.status(502).json({
        error: 'Target API unreachable',
        message: 'Unable to connect to the target API'
      });
    }

    if (error.message.includes('timeout')) {
      return res.status(504).json({
        error: 'Request timeout',
        message: 'Target API did not respond in time'
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

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Consensus Server running on port ${port}`);
  console.log(`💰 Payment address: ${payTo}`);
  console.log(`🔗 Facilitator URL: ${facilitatorUrl}`);
  console.log(`💵 Price: $0.001 per unique API call`);
  console.log(`🌐 Network: Base Sepolia`);
  console.log(`✅ Ready for x402 payment requests`);
});