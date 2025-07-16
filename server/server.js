require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { exact } = require('x402/schemes');
const { useFacilitator } = require('x402/verify');
const { processPriceToAtomicAmount, settleResponseHeader } = require('x402/shared');
const ConsensusProxy = require('./proxy');

const app = express();
const port = 8080;
const proxy = new ConsensusProxy();

// x402 Configuration
const facilitatorUrl = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const payTo = process.env.WALLET_ADDRESS || "0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f";
const { verify, settle } = useFacilitator({ url: facilitatorUrl });
const x402Version = 1;

const apiKeyToAccount = new Map();

function createPaymentRequirements(resource, description = "Consensus: ICP HTTP Deduplication Proxy") {
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
}

app.use(express.json());

async function verifyPayment(req, res, paymentRequirements) {
  const payment = req.header("X-PAYMENT");
  if (!payment) {
    return res.status(402).json({
      x402Version,
      error: "X-PAYMENT header is required",
      accepts: [paymentRequirements],
    });
  }

  let decodedPayment;
  try {
    decodedPayment = exact.evm.decodePayment(payment);
    decodedPayment.x402Version = x402Version;
  } catch (error) {
    return res.status(402).json({
      x402Version,
      error: error?.message || "Invalid or malformed payment header",
      accepts: [paymentRequirements],
    });
  }

  try {
    const response = await verify(decodedPayment, paymentRequirements);
    if (!response.isValid) {
      return res.status(402).json({
        x402Version,
        error: response.invalidReason,
        accepts: [paymentRequirements],
        payer: response.payer,
      });
    }
    
    return { isValid: true, decodedPayment };
  } catch (error) {
    return res.status(402).json({
      x402Version,
      error: error?.message || "Payment verification failed",
      accepts: [paymentRequirements],
    });
  }
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

function getAccountFromApiKey(apiKey) {
  return apiKeyToAccount.get(apiKey);
}

// Basic info endpoint
app.get('/', (req, res) => {
  res.json({ 
    name: 'Consensus', 
    status: 'running',
    message: 'ICP HTTP Deduplication Proxy with x402 Automation',
    pricing: '$0.001 per unique API call (cached responses are free)',
    flow: 'Run client script → Get API key → Use from any language',
    supported_languages: ['Motoko', 'Rust', 'JavaScript', 'Python', 'Any HTTP client'],
    endpoints: {
      create_client: 'POST /create-client - Register CDP account and get API key',
      proxy: 'POST /proxy - Make API calls with X-API-Key header'
    },
    usage: {
      headers: { 'X-API-Key': 'consensus_abc123...' },
      body: {
        target_url: 'https://api.example.com/data',
        headers: { 'x-idempotency-key': 'unique-key-123' }
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    cache_size: proxy.cache.keys().length,
    paid_keys: proxy.paidKeys.size,
    registered_accounts: apiKeyToAccount.size,
    x402_automation: true
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const stats = proxy.getStats();
  res.json({
    ...stats,
    pricing: '$0.001 per unique API call',
    payment_method: 'x402-fetch automation',
    wallet: payTo,
    network: 'base-sepolia',
    registered_accounts: apiKeyToAccount.size
  });
});

// Create client endpoint - simplified
app.post('/create-client', async (req, res) => {
  try {
    const { account_address } = req.body; // Only need address now
    
    if (!account_address) {
      return res.status(400).json({ 
        error: 'Missing account_address',
        required: {
          account_address: 'account address string'
        }
      });
    }

    console.log(`Registering account: ${account_address}`);

    // Generate API key
    const apiKey = generateApiKey();
    
    // Store only account address - no wallet client needed
    apiKeyToAccount.set(apiKey, {
      accountAddress: account_address,
      createdAt: new Date().toISOString()
    });

    console.log(`API key created: ${apiKey}`);

    res.json({
      success: true,
      api_key: apiKey,
      account_address: account_address,
      network: 'base-sepolia',
      message: 'Account registered successfully',
      instructions: 'Use X-API-Key header for all proxy requests'
    });

  } catch (error) {
    console.error('Account registration failed:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Main proxy endpoint - return 402 instead of trying to pay
app.all('/proxy', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({
        error: 'Missing API key',
        instructions: 'Include X-API-Key header',
        get_api_key: 'Run client setup script to get API key'
      });
    }

    const accountData = getAccountFromApiKey(apiKey);
    if (!accountData) {
      return res.status(401).json({
        error: 'Invalid API key',
        instructions: 'Register account first with client script'
      });
    }

    const { target_url, method = 'GET', headers = {}, body } = req.body;
    
    if (!target_url) {
      return res.status(400).json({ 
        error: 'Missing target_url',
        example: {
          target_url: 'https://api.example.com/data',
          headers: { 'x-idempotency-key': 'unique-key' },
          method: 'GET'
        }
      });
    }

    const idempotencyKey = headers['x-idempotency-key'] ||
                          headers['idempotency-key'] ||
                          headers['X-Idempotency-Key'];
    
    if (!idempotencyKey) {
      return res.status(400).json({ 
        error: 'Missing idempotency key in headers',
        required: 'Include x-idempotency-key in headers object'
      });
    }

    // Check if payment required (cache miss = payment needed)
    const requiresPayment = proxy.requiresPayment(idempotencyKey);
    
    if (requiresPayment) {
      console.log(`Payment required for: ${idempotencyKey}`);
      
      // Create payment requirements and return 402
      const resource = `${req.protocol}://${req.headers.host}/proxy`;
      const paymentRequirements = createPaymentRequirements(
        resource, 
        `Consensus Proxy: ${target_url}`
      );

      return res.status(402).json({
        x402Version,
        error: "Payment required for new API call",
        accepts: [paymentRequirements],
        idempotency_key: idempotencyKey,
        account_address: accountData.accountAddress
      });

    } else {
      console.log(`No payment required for: ${idempotencyKey} (cached or already paid)`);
      
      // Process directly - no payment needed
      const response = await proxy.handleRequest(target_url, method, headers, body);
      
      return res.json({
        ...response,
        billing: {
          cost: '$0.000',
          payment_automated: false,
          reason: response.cached ? 'cache_hit' : 'already_paid',
          idempotency_key: idempotencyKey
        }
      });
    }
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Payment endpoint for x402-fetch
app.post('/payment-endpoint', async (req, res) => {
  try {
    const { idempotency_key, payment_requirements } = req.body;
    
    if (!idempotency_key) {
      return res.status(400).json({ error: 'Missing idempotency_key' });
    }

    // Verify payment
    const paymentResult = await verifyPayment(req, res, payment_requirements);
    if (!paymentResult || !paymentResult.isValid) {
      return; // 402 response already sent
    }

    console.log(`Payment verified for: ${idempotency_key}`);

    // Mark as paid in proxy
    proxy.markAsPaid(idempotency_key);

    // Settle payment
    try {
      const settleResponse = await settle(paymentResult.decodedPayment, payment_requirements);
      const responseHeader = settleResponseHeader(settleResponse);
      res.setHeader("X-PAYMENT-RESPONSE", responseHeader);
      console.log(`Payment settled for: ${idempotency_key}`);
    } catch (settleError) {
      console.error('Payment settlement failed:', settleError);
    }

    res.json({
      success: true,
      idempotency_key: idempotency_key,
      payment_verified: true,
      amount: '$0.001'
    });

  } catch (error) {
    console.error('Payment endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Payment status check endpoint
app.post('/payment-status', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key' });
    }

    const accountData = getAccountFromApiKey(apiKey);
    if (!accountData) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const { idempotency_key } = req.body;
    
    if (!idempotency_key) {
      return res.status(400).json({ error: 'Missing idempotency_key' });
    }

    const status = proxy.getPaymentStatus(idempotency_key);
    
    res.json({
      idempotency_key,
      ...status,
      estimated_cost: status.requires_payment ? '$0.001' : '$0.000',
      account_address: accountData.accountAddress
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message,
    timestamp: new Date().toISOString()
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Consensus Server running on port ${port}`);
  console.log('Flow: Run client script → Get API key → Use from any language');
  console.log('Price: $0.001 per unique API call');
  console.log('Cached responses are FREE');
  console.log('Network: Base Sepolia testnet');
  console.log(`Payments to: ${payTo}`);
  console.log('Multi-language support via API key authentication');
  console.log('x402-fetch handles payments automatically on client side');
});