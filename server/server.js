require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
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
  windowMs: 15 * 60 * 1000, // 15 minutes
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
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      cause: error.cause?.message || 'No cause details',
      stack: error.stack?.split('\n').slice(0, 5).join('\n')
    });
    
    if (error.message.includes('RequestContentLengthMismatchError') ||
        error.message.includes('content-length') ||
        error.message.includes('Request body length does not match') ||
        error.code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' ||
        error.cause?.code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH') {
      
      console.log('Content-length mismatch detected - this suggests an issue with the HTTP request to the facilitator');

      try {
        console.log('Attempting retry with fresh facilitator connection...');
        const retryFacilitator = useFacilitator({
          url: facilitatorUrl,
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Connection': 'close'
          }
        });
        
        const retryResponse = await retryFacilitator.verify(decodedPayment, paymentRequirements);

        if (retryResponse.isValid) {
          console.log('✅ Retry verification successful');
          return { isValid: true, decodedPayment };
        } else {
          console.log('❌ Retry verification failed:', retryResponse.invalidReason);
          return res.status(402).json({
            x402Version,
            error: "Payment verification failed",
            message: retryResponse.invalidReason,
            accepts: [paymentRequirements],
            payer: retryResponse.payer,
          });
        }
      } catch (retryError) {
        console.error('Retry verification also failed:', retryError.message);
        
        return res.status(402).json({
          x402Version,
          error: "Facilitator connection error",
          message: "Unable to verify payment due to persistent facilitator communication issues.",
          accepts: [paymentRequirements],
          debug: {
            issue: "Content-length mismatch with facilitator",
            facilitator_url: facilitatorUrl,
            suggestion: "The facilitator service may be experiencing issues. Please try again."
          }
        });
      }
    }
    if (error.message.includes('fetch failed') || 
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('network')) {
      return res.status(402).json({
        x402Version,
        error: "Payment network error",
        message: "Unable to connect to payment facilitator. Please check your internet connection and try again.",
        accepts: [paymentRequirements],
        debug: {
          facilitator_url: facilitatorUrl,
          error_type: "Network connection failure"
        }
      });
    }

    return res.status(402).json({
      x402Version,
      error: "Payment verification failed",
      message: "Unable to verify payment due to an unexpected error.",
      accepts: [paymentRequirements],
      debug: {
        error_message: error.message,
        error_code: error.code
      }
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
        example: {
          target_url: 'https://api.example.com/data',
          method: 'GET',
          headers: { 'x-idempotency-key': 'unique-key' }
        }
      });
    }

    // Validate URL format
    try {
      new URL(target_url);
    } catch (urlError) {
      return res.status(400).json({
        error: 'Invalid target_url',
        message: 'target_url must be a valid HTTP/HTTPS URL'
      });
    }

    const idempotencyKey = headers['x-idempotency-key'] ||
                          headers['idempotency-key'] ||
                          headers['X-Idempotency-Key'];
    
    if (!idempotencyKey) {
      return res.status(400).json({ 
        error: 'Missing idempotency key',
        message: 'x-idempotency-key is required in headers',
        required: 'Include x-idempotency-key in headers object for deduplication'
      });
    }

    console.log(`Processing: ${method} ${target_url} [${idempotencyKey}]`);

    const requiresPayment = proxy.requiresPayment(idempotencyKey);
    
    if (requiresPayment) {
      console.log(`Payment required for: ${idempotencyKey}`);

      const resource = `${req.protocol}://${req.headers.host}/proxy`;
      const paymentRequirements = createPaymentRequirements(
        resource, 
        `Consensus Deduplication: ${target_url}`
      );

      const paymentResult = await verifyPayment(req, res, paymentRequirements);
      if (!paymentResult || !paymentResult.isValid) {
        return; 
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

    const response = await proxy.handleRequest(target_url, method, headers, body);
    const processingTime = Date.now() - startTime;
    
    return res.json({
      ...response,
      billing: {
        cost: requiresPayment ? '$0.001' : '$0.000',
        reason: response.cached ? 'cache_hit' : requiresPayment ? 'payment_processed' : 'already_paid',
        idempotency_key: idempotencyKey,
        processing_time_ms: processingTime
      },
      meta: {
        timestamp: new Date().toISOString(),
        server_version: '1.0.1'
      }
    });
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Consensus Server running on port ${port}`);
  console.log(`Payment address: ${payTo}`);
  console.log(`Facilitator URL: ${facilitatorUrl}`);
  console.log(`Price: $0.001 per unique API call`);
  console.log(`🌐 Network: Base Sepolia`);
  console.log(`✅ Ready for x402 payment requests`);
});