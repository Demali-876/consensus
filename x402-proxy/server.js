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

app.use(helmet());
app.use(cors());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 1000,
  message: { error: 'Too many requests, please try again later' }
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));

const registeredWallets = new Map();
const walletClients = new Map();
const apiKeys = new Map();
const requestTracker = new Map();
const processingRequests = new Map();

setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 5 * 1000);
  let cleanedCount = 0;
  
  for (const [key, data] of requestTracker.entries()) {
    if (new Date(data.timestamp).getTime() < oneHourAgo) {
      requestTracker.delete(key);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} old request tracking entries`);
  }
}, 60 * 5 * 1000);

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

app.post('/register-wallet', async (req, res) => {
  try {
    const { wallet_name, account_address, private_key } = req.body;
    
    if (!wallet_name || !account_address || !private_key) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['wallet_name', 'account_address', 'private_key']
      });
    }

    if (!private_key || private_key.length < 64) {
      return res.status(400).json({
        error: 'Invalid private key format',
        message: 'Private key appears to be invalid or too short'
      });
    }

    if (registeredWallets.has(wallet_name)) {
      return res.status(409).json({
        error: 'Wallet already registered',
        wallet_name,
        account_address: registeredWallets.get(wallet_name)
      });
    }

    try {
      const formattedPrivateKey = private_key.startsWith('0x') ? private_key : `0x${private_key}`;
      const account = privateKeyToAccount(formattedPrivateKey);

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

    const idempotencyKey = idempotency_key || 
                          headers['x-idempotency-key'] ||
                          `auto-${walletName}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    console.log(`Forwarding request: ${method} ${target_url} [${idempotencyKey}]`);

    if (processingRequests.has(idempotencyKey)) {
      console.log(`Request already in progress at X402 proxy level, waiting: ${idempotencyKey}`);
      
      try {
        const existingResponse = await processingRequests.get(idempotencyKey);
        
        return res.status(200).json({
          ...existingResponse,
          meta: {
            ...existingResponse.meta,
            concurrent_request_at_x402_proxy: true,
            original_timestamp: existingResponse.meta?.timestamp || new Date().toISOString()
          }
        });
      } catch (waitError) {
        console.error(`Error waiting for existing X402 proxy request: ${waitError.message}`);
        processingRequests.delete(idempotencyKey);
      }
    }

    // Check for duplicate requests (x402 proxy level deduplication from cache)
    if (requestTracker.has(idempotencyKey)) {
      const tracked = requestTracker.get(idempotencyKey);
      console.log(`Duplicate request detected at proxy level cache: ${idempotencyKey}`);
      
      return res.status(200).json({
        ...tracked.response,
        meta: {
          ...tracked.response.meta,
          duplicate_request_at_proxy: true,
          original_timestamp: tracked.timestamp
        }
      });
    }

    const requestPromise = (async () => {
      const fetchWithPayment = walletClients.get(walletName);
      if (!fetchWithPayment) {
        throw new Error('Wallet client not found - may not be properly registered');
      }

      const response = await fetchWithPayment(consensusServerUrl + '/proxy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'close'
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

      if (!response.ok && response.status !== 402) {
        throw new Error(`Consensus server responded with ${response.status}: ${response.statusText}`);
      }

      const responseData = await response.json();
      const processingTime = Date.now() - startTime;

      const finalResponse = {
        ...responseData,
        meta: {
          ...(responseData.meta || {}),
          wallet_name: walletName,
          account_address: registeredWallets.get(walletName),
          idempotency_key: idempotencyKey,
          proxy_processing_time_ms: processingTime,
          x402_proxy_handled: true,
          timestamp: new Date().toISOString()
        }
      };

      requestTracker.set(idempotencyKey, {
        response: finalResponse,
        timestamp: new Date().toISOString()
      });

      return finalResponse;
    })();

    processingRequests.set(idempotencyKey, requestPromise);

    const cleanup = () => {
      processingRequests.delete(idempotencyKey);
    };
    
    requestPromise.finally(cleanup);
    setTimeout(cleanup, 5 * 60 * 1000);

    const finalResponse = await requestPromise;
    res.status(200).json(finalResponse);

  } catch (error) {
    console.error('Proxy request error:', error.message);

    if (error.message.includes('insufficient funds')) {
      return res.status(402).json({
        error: 'Insufficient funds',
        message: 'Account needs USDC funding for x402 payments',
        account_address: registeredWallets.get(req.walletName),
        faucet_url: 'https://faucet.circle.com/'
      });
    }
    
    if (error.message.includes('network') || error.message.includes('ECONNREFUSED')) {
      return res.status(503).json({
        error: 'Network error',
        message: 'Unable to connect to consensus server',
        consensus_server: consensusServerUrl,
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
    tracked_requests: requestTracker.size,
    currently_processing: processingRequests.size,
    consensus_server: consensusServerUrl,
    timestamp: new Date().toISOString()
  });
});

app.get('/stats', (req, res) => {
  res.json({
    registered_wallets: registeredWallets.size,
    active_clients: walletClients.size,
    tracked_requests: requestTracker.size,
    currently_processing: processingRequests.size,
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
  console.log(`💳 Ready for wallet registrations and proxy requests`);
  console.log(`✅ Clean request forwarding with automatic x402 payments`);
});