#!/usr/bin/env node

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';
import crypto from 'crypto';

const app = express();
const port = process.env.X402_PROXY_PORT || 3001;
const consensusServerUrl = process.env.CONSENSUS_SERVER_URL || 'http://localhost:8080';

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: { error: 'Too many requests, please try again later' }
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));

// Wallet storage and client cache
const registeredWallets = new Map(); // wallet_name -> account_address
const walletClients = new Map(); // wallet_name -> fetchWithPayment
const apiKeys = new Map(); // api_key -> wallet_name

// Request tracking for idempotency
const requestTracker = new Map(); // idempotency_key -> { status, response, timestamp }

function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing API key',
      message: 'X-API-Key header required'
    });
  }
  
  const walletName = apiKeys.get(apiKey);
  if (!walletName) {
    return res.status(401).json({
      error: 'Invalid API key',
      message: 'API key not registered'
    });
  }
  
  req.walletName = walletName;
  next();
}

// Register wallet endpoint - Client provides private key
app.post('/register-wallet', async (req, res) => {
  try {
    const { wallet_name, account_address, private_key } = req.body;
    
    if (!wallet_name || !account_address || !private_key) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['wallet_name', 'account_address', 'private_key']
      });
    }

    // Validate wallet name format (16 hex characters)
    if (!/^[a-f0-9]{16}$/.test(wallet_name)) {
      return res.status(400).json({
        error: 'Invalid wallet name format',
        message: 'Wallet name must be 16 hexadecimal characters'
      });
    }

    // Validate private key format (more flexible)
    if (!private_key || private_key.length < 64) {
      return res.status(400).json({
        error: 'Invalid private key format',
        message: 'Private key appears to be invalid or too short',
        received_format: typeof private_key,
        received_length: private_key ? private_key.length : 0
      });
    }

    // Check if already registered
    if (registeredWallets.has(wallet_name)) {
      return res.status(409).json({
        error: 'Wallet already registered',
        wallet_name,
        account_address: registeredWallets.get(wallet_name)
      });
    }

    // Create account directly from private key using viem
    try {
      // Ensure private key has 0x prefix
      const formattedPrivateKey = private_key.startsWith('0x') ? private_key : `0x${private_key}`;
      
      const account = privateKeyToAccount(formattedPrivateKey);
      
      console.log(`Debug - Account created from private key: ${account.address}`);
      console.log(`Debug - Expected address: ${account_address}`);
      
      // Verify the account address matches what client provided
      if (account.address.toLowerCase() !== account_address.toLowerCase()) {
        return res.status(400).json({
          error: 'Address mismatch',
          message: 'Private key does not correspond to provided address',
          derived_address: account.address,
          provided_address: account_address
        });
      }
      
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http()
      });
      
      const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient);
      
      // Store everything
      registeredWallets.set(wallet_name, account_address);
      walletClients.set(wallet_name, fetchWithPayment);
      
      console.log(`✓ Registered wallet: ${wallet_name} (${account_address})`);
      
    } catch (importError) {
      console.error('Failed to create wallet client:', importError);
      return res.status(400).json({
        error: 'Failed to create wallet client',
        message: 'Invalid private key provided'
      });
    }

    // Generate API key
    const apiKey = crypto.randomBytes(32).toString('hex');
    apiKeys.set(apiKey, wallet_name);
    
    res.json({
      success: true,
      wallet_name,
      account_address,
      api_key: apiKey,
      message: 'Wallet registered successfully'
    });

  } catch (error) {
    console.error('Wallet registration error:', error.message);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to register wallet'
    });
  }
});

// Main proxy endpoint
app.post('/proxy', validateApiKey, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { target_url, method = 'GET', headers = {}, body, idempotency_key } = req.body;
    const walletName = req.walletName;
    
    if (!target_url) {
      return res.status(400).json({ 
        error: 'Missing target_url',
        message: 'target_url is required in request body'
      });
    }

    // Generate or validate idempotency key
    const idempotencyKey = idempotency_key || 
                          headers['x-idempotency-key'] ||
                          `auto-${walletName}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Check for duplicate request (idempotency protection)
    if (requestTracker.has(idempotencyKey)) {
      const tracked = requestTracker.get(idempotencyKey);
      console.log(`Duplicate request detected: ${idempotencyKey}`);
      
      return res.status(200).json({
        ...tracked.response,
        meta: {
          ...tracked.response.meta,
          duplicate_request: true,
          original_timestamp: tracked.timestamp
        }
      });
    }

    // Get wallet client (should already exist from registration)
    let fetchWithPayment = walletClients.get(walletName);
    if (!fetchWithPayment) {
      return res.status(400).json({
        error: 'Wallet client not found',
        message: 'Wallet may not be properly registered'
      });
    }

    console.log(`Processing request: ${method} ${target_url} [${idempotencyKey}]`);

    // Make x402-wrapped request to consensus server
    const response = await fetchWithPayment(consensusServerUrl + '/proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target_url,
        method,
        headers: {
          'x-idempotency-key': idempotencyKey,
          ...headers
        },
        body
      })
    });

    const responseData = await response.json();
    const processingTime = Date.now() - startTime;

    const finalResponse = {
      ...responseData,
      meta: {
        wallet_name: walletName,
        account_address: registeredWallets.get(walletName),
        idempotency_key: idempotencyKey,
        processing_time_ms: processingTime,
        x402_proxy_handled: true,
        timestamp: new Date().toISOString()
      }
    };

    // Store for idempotency protection (with TTL)
    requestTracker.set(idempotencyKey, {
      response: finalResponse,
      timestamp: new Date().toISOString()
    });

    // Clean up old requests (simple TTL)
    setTimeout(() => {
      requestTracker.delete(idempotencyKey);
    }, 24 * 60 * 60 * 1000); // 24 hours

    res.status(response.status).json(finalResponse);

  } catch (error) {
    console.error('Proxy request error:', error.message);
    
    // Enhanced error responses
    if (error.message.includes('insufficient funds')) {
      return res.status(402).json({
        error: 'Insufficient funds',
        message: 'Account needs USDC funding for x402 payments',
        account_address: registeredWallets.get(req.walletName),
        faucet_url: 'https://faucet.circle.com/'
      });
    }
    
    if (error.message.includes('network')) {
      return res.status(503).json({
        error: 'Network error',
        message: 'Unable to connect to consensus server',
        retry_after: 30
      });
    }

    res.status(500).json({
      error: 'Proxy request failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Status endpoints
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'x402-payment-proxy',
    registered_wallets: registeredWallets.size,
    active_clients: walletClients.size,
    consensus_server: consensusServerUrl,
    timestamp: new Date().toISOString()
  });
});

app.get('/stats', (req, res) => {
  res.json({
    registered_wallets: registeredWallets.size,
    active_clients: walletClients.size,
    tracked_requests: requestTracker.size,
    consensus_server: consensusServerUrl,
    uptime: process.uptime(),
    memory_usage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

app.listen(port, () => {
  console.log(`🚀 x402 Payment Proxy running on port ${port}`);
  console.log(`🏗️  Consensus server: ${consensusServerUrl}`);
  console.log('✅ Ready for wallet registrations and proxy requests');
});