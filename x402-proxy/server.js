#!/usr/bin/env node

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { WalletStore } from './data/store.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';
import crypto from 'crypto';

const app = express();
const port = process.env.X402_PROXY_PORT || 3001;
const consensusServerUrl = process.env.CONSENSUS_SERVER_URL || 'http://localhost:8080';
const walletStore = new WalletStore();
const registeredWallets = new Map();
const walletClients = new Map();
const requestTracker = new Map();
const processingRequests = new Map();

app.use(helmet());
app.use(cors());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 1000,
  message: { error: 'Too many requests' }
}));
app.use(express.json({ limit: '10mb' }));

setInterval(() => {
  const fiveMinsAgo = Date.now() - (5 * 60 * 1000);
  let cleaned = 0;
  for (const [key, data] of requestTracker.entries()) {
    if (new Date(data.timestamp).getTime() < fiveMinsAgo) {
      requestTracker.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} old entries`);
}, 5 * 60 * 1000);

function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  const walletData = walletStore.getWalletByApiKey(apiKey);
  if (!walletData) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  req.walletName = walletData.walletName;
  next();
}

// Helper to create wallet client
function createWallet(privateKey, address) {
  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(formattedKey);
  
  if (account.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Address mismatch');
  }
  
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http()
  });
  
  return { account, fetchWithPayment: wrapFetchWithPayment(fetch, walletClient) };
}

// Restore wallets on startup
async function restoreWallets() {
  console.log('Restoring wallets...');
  const wallets = walletStore.getAllWallets();
  let loaded = 0;
  
  for (const wallet of wallets) {
    try {
      const { account, fetchWithPayment } = createWallet(wallet.privateKey, wallet.accountAddress);
      registeredWallets.set(wallet.walletName, wallet.accountAddress);
      walletClients.set(wallet.walletName, fetchWithPayment);
      loaded++;
    } catch (error) {
      console.error(`Failed to load wallet ${wallet.walletName}:`, error.message);
    }
  }
  
  console.log(`Loaded ${loaded} wallets`);
  return loaded;
}

// Register wallet endpoint
app.post('/register-wallet', async (req, res) => {
  try {
    const { wallet_name, account_address, private_key } = req.body;
    
    if (!wallet_name || !account_address || !private_key) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (private_key.length < 64) {
      return res.status(400).json({ error: 'Invalid private key' });
    }

    if (walletStore.walletExists(wallet_name)) {
      return res.status(409).json({ error: 'Wallet already registered' });
    }

    const { account, fetchWithPayment } = createWallet(private_key, account_address);
    const storeResult = walletStore.storeWallet(wallet_name, account_address, private_key);
    
    registeredWallets.set(wallet_name, account_address);
    walletClients.set(wallet_name, fetchWithPayment);
    
    console.log(`✓ Registered wallet: ${account_address}`);
    res.json({
      success: true,
      wallet_name,
      account_address,
      api_key: storeResult.apiKey
    });
    
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Build error response helper
function buildErrorResponse(error, walletName, startTime) {
  const msg = error.message.toLowerCase();
  const address = registeredWallets.get(walletName);
  
  let status = 500;
  let errorType = 'Request failed';
  let details = {};
  
  if (msg.includes('insufficient funds') || msg.includes('insufficient balance')) {
    status = 402;
    errorType = 'Insufficient funds';
    details = { 
      wallet: walletName, 
      address,
      faucet: 'https://faucet.circle.com/' 
    };
  } else if (msg.includes('payment failed') || msg.includes('transaction failed')) {
    status = 402;
    errorType = 'Payment failed';
    details = { wallet: walletName, address };
  } else if (msg.includes('wallet') || msg.includes('account')) {
    status = 400;
    errorType = 'Wallet error';
    details = { wallet: walletName };
  } else if (msg.includes('econnrefused') || msg.includes('network')) {
    status = 503;
    errorType = 'Network error';
    details = { server: consensusServerUrl };
  }
  
  return {
    status,
    error: errorType,
    message: error.message,
    details,
    meta: {
      wallet: walletName,
      address,
      processing_ms: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }
  };
}

// Main proxy endpoint
app.post('/proxy', validateApiKey, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { target_url, method = 'GET', headers = {}, body, idempotency_key } = req.body;
    const walletName = req.walletName;
    const isVerbose = ['true', 'True', 'TRUE'].includes(headers['x-verbose']);
    
    if (!target_url) {
      return res.status(400).json({ error: 'Missing target_url' });
    }

    const idempotencyKey = idempotency_key || 
                          headers['idempotency-key'] || 
                          headers['Idempotency-Key'] ||
                          `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;

    console.log(`${method} request with key: ${idempotencyKey}`);

    // Check if already processing
    if (processingRequests.has(idempotencyKey)) {
      console.log(`Waiting for existing request: ${idempotencyKey}`);
      try {
        const existing = await processingRequests.get(idempotencyKey);
        if (existing.error) {
          return res.status(existing.status).json(isVerbose ? existing : {
            error: existing.error,
            message: existing.message
          });
        }
        return res.json(isVerbose ? existing : {
          status: existing.status,
          statusText: existing.statusText,
          data: existing.data
        });
      } catch (waitError) {
        console.error(`Wait error: ${waitError.message}`);
        processingRequests.delete(idempotencyKey);
      }
    }

    // Check cache
    if (requestTracker.has(idempotencyKey)) {
      const cached = requestTracker.get(idempotencyKey);
      console.log(`Cache hit (${cached.isError ? 'error' : 'success'}): ${idempotencyKey}`);
      
      const response = cached.response;
      if (cached.isError) {
        return res.status(response.status).json(isVerbose ? response : {
          error: response.error,
          message: response.message
        });
      }
      
      return res.json(isVerbose ? response : {
        status: response.status,
        statusText: response.statusText,
        data: response.data
      });
    }

    // Create request promise
    const requestPromise = (async () => {
      const fetchWithPayment = walletClients.get(walletName);
      if (!fetchWithPayment) {
        throw new Error('Wallet not registered');
      }

      const consensusHeaders = { 
        'Content-Type': 'application/json',
        'Connection': 'close'
      };
      if (isVerbose) consensusHeaders['X-Verbose'] = 'true';

      let response, errorResponse;
      
      try {
        response = await fetchWithPayment(consensusServerUrl + '/proxy', {
          method: 'POST',
          headers: consensusHeaders,
          body: JSON.stringify({
            target_url,
            method,
            headers: { 'x-idempotency-key': idempotencyKey, ...headers },
            body
          })
        });
      } catch (fetchError) {
        errorResponse = buildErrorResponse(fetchError, walletName, startTime);
        requestTracker.set(idempotencyKey, {
          response: errorResponse,
          timestamp: new Date().toISOString(),
          isError: true
        });
        return errorResponse;
      }

      // Handle non-ok responses
      if (response && !response.ok && response.status !== 402) {
        let errorDetails;
        try {
          errorDetails = await response.json();
        } catch {
          errorDetails = { message: response.statusText };
        }
        
        errorResponse = {
          status: response.status,
          error: errorDetails.error || 'Server error',
          message: errorDetails.message || response.statusText,
          meta: {
            wallet: walletName,
            address: registeredWallets.get(walletName),
            processing_ms: Date.now() - startTime,
            timestamp: new Date().toISOString()
          }
        };
        
        requestTracker.set(idempotencyKey, {
          response: errorResponse,
          timestamp: new Date().toISOString(),
          isError: true
        });
        
        return errorResponse;
      }

      // Handle success
      const responseData = await response.json();
      const fullResponse = {
        ...responseData,
        meta: {
          ...(responseData.meta || {}),
          wallet: walletName,
          address: registeredWallets.get(walletName),
          idempotency_key: idempotencyKey,
          processing_ms: Date.now() - startTime,
          timestamp: new Date().toISOString()
        }
      };

      requestTracker.set(idempotencyKey, {
        response: fullResponse,
        timestamp: new Date().toISOString()
      });

      return fullResponse;
    })();

    // Store and cleanup promise
    processingRequests.set(idempotencyKey, requestPromise);
    const cleanup = () => processingRequests.delete(idempotencyKey);
    requestPromise.finally(cleanup);
    setTimeout(cleanup, 5 * 60 * 1000);

    // Await and return response
    const finalResponse = await requestPromise;
    
    if (finalResponse.error || finalResponse.status >= 400) {
      return res.status(finalResponse.status).json(isVerbose ? finalResponse : {
        error: finalResponse.error,
        message: finalResponse.message,
        details: finalResponse.details
      });
    }
    
    res.json(isVerbose ? finalResponse : {
      status: finalResponse.status,
      statusText: finalResponse.statusText || 'OK',
      data: finalResponse.data
    });

  } catch (error) {
    console.error('Proxy error:', error.message);
    const errorResp = buildErrorResponse(error, req.walletName, startTime);
    res.status(errorResp.status).json({
      error: errorResp.error,
      message: errorResp.message,
      details: errorResp.details
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  const dbInfo = walletStore.getDatabaseInfo();
  res.json({ 
    status: 'healthy',
    wallets: registeredWallets.size,
    tracked: requestTracker.size,
    processing: processingRequests.size,
    database: dbInfo?.walletCount || 0,
    server: consensusServerUrl
  });
});

// Stats
app.get('/stats', (req, res) => {
  res.json({
    wallets: registeredWallets.size,
    tracked: requestTracker.size,
    processing: processingRequests.size,
    uptime: process.uptime(),
    memory: process.memoryUsage().heapUsed
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('Unhandled:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    walletStore.close();
    process.exit(0);
  });
});

// Boot server
async function boot() {
  try {
    await restoreWallets();
    app.listen(port, () => {
      console.log(`🚀 X402 Proxy on port ${port}`);
      console.log(`🏗️  Consensus: ${consensusServerUrl}`);
    });
  } catch (error) {
    console.error('Boot failed:', error.message);
    process.exit(1);
  }
}

boot();