import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';
import crypto from 'crypto';
import { Agent as UndiciAgent } from 'undici';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { WalletStore } from './data/store.js';
import { privateKeyToAccount } from 'viem/accounts';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PROXY_TLS_KEY = process.env.PROXY_TLS_KEY_PATH || path.join(root, 'scripts/certs', 'proxy.key');
const PROXY_TLS_CERT = process.env.PROXY_TLS_CERT_PATH || path.join(root, 'scripts/certs', 'proxy.crt');

const undiciAgent = new UndiciAgent({ 
  keepAliveTimeout: 10000, 
  connections: 10, 
  pipelining: 1 
});

const enhancedFetch = (url, options = {}) => {
  return fetch(url, { ...options, dispatcher: undiciAgent });
};

const app = express();
const port = process.env.X402_PROXY_PORT || 3001;
const consensusServerUrl = process.env.CONSENSUS_SERVER_URL || 'https://consensus.canister.software:8888';
const walletStore = new WalletStore();
const registeredWallets = new Map();
const walletClients = new Map();
const requestTracker = new Map();
const processingRequests = new Map();

app.use(helmet());
app.use(cors());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, message: { error: 'Too many requests' } }));
app.use(express.json({ limit: '10mb' }));

setInterval(() => {
  const cutoff = Date.now() - (5 * 60 * 1000);
  const toDelete = [];
  
  for (const [key, data] of requestTracker.entries()) {
    if (new Date(data.timestamp).getTime() < cutoff) {
      toDelete.push(key);
    }
  }
  
  toDelete.forEach(key => requestTracker.delete(key));
  
  if (toDelete.length > 0) {
    console.log(`Cleaned ${toDelete.length} old entries`);
  }
}, 5 * 60 * 1000);

function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });
  
  const walletData = walletStore.getWalletByApiKey(apiKey);
  if (!walletData) return res.status(401).json({ error: 'Invalid API key' });
  
  req.walletName = walletData.walletName;
  req.walletData = {
    evm_address: walletData.evmAddress,
    solana_address: walletData.solanaAddress
  };
  
  next();
}

function buildErrorResponse(error, walletName, walletData, startTime) {
  const msg = error.message.toLowerCase();
  
  let status = 500;
  let errorType = 'Request failed';
  let details = {};
  
  if (msg.includes('insufficient funds') || msg.includes('insufficient balance')) {
    status = 402;
    errorType = 'Insufficient funds';
    details = { 
      wallet: walletName,
      evm_address: walletData?.evm_address,
      solana_address: walletData?.solana_address,
      faucets: {
        evm: 'https://faucet.circle.com/',
        solana: 'https://faucet.solana.com/'
      }
    };
  } else if (msg.includes('payment failed') || msg.includes('transaction failed')) {
    status = 402;
    errorType = 'Payment failed';
    details = { 
      wallet: walletName,
      evm_address: walletData?.evm_address,
      solana_address: walletData?.solana_address
    };
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
      evm_address: walletData?.evm_address,
      solana_address: walletData?.solana_address,
      processing_ms: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }
  };
}

async function createWallet(evmPrivateKey, evmAddress, solanaPrivateKey, solanaAddress) {
  const formattedEvmKey = evmPrivateKey.startsWith('0x') ? evmPrivateKey : `0x${evmPrivateKey}`;
  const evmSigner = privateKeyToAccount(formattedEvmKey);
  
  if (evmSigner.address.toLowerCase() !== evmAddress.toLowerCase()) {
    throw new Error('EVM address mismatch');
  }

  const solanaKeypair = base58.decode(solanaPrivateKey);
  const svmSigner = await createKeyPairSignerFromBytes(solanaKeypair);
  
  if (svmSigner.address !== solanaAddress) {
    throw new Error('Solana address mismatch');
  }

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: evmSigner });
  registerExactSvmScheme(client, { signer: svmSigner });

  return wrapFetchWithPayment(enhancedFetch, client);
}

async function restoreWallets() {
  console.log('Restoring wallets...');
  const wallets = walletStore.getAllWallets();

  const results = await Promise.allSettled(
    wallets.map(async (wallet) => {
      const fetchWithPayment = await createWallet(
        wallet.evmPrivateKey,
        wallet.evmAddress,
        wallet.solanaPrivateKey,
        wallet.solanaAddress
      );
      
      registeredWallets.set(wallet.walletName, {
        evm_address: wallet.evmAddress,
        solana_address: wallet.solanaAddress
      });
      
      walletClients.set(wallet.walletName, fetchWithPayment);
      
      return wallet.walletName;
    })
  );
  
  const loaded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected');
  
  failed.forEach(f => {
    console.error(`Failed to load wallet:`, f.reason?.message);
  });
  
  console.log(`Loaded ${loaded}/${wallets.length} wallet(s)`);
  return loaded;
}

app.post('/register-wallet', async (req, res) => {
  try {
    const { wallet_name, evm, solana } = req.body;
    
    if (!wallet_name) {
      return res.status(400).json({ error: 'Missing wallet_name' });
    }

    if (!evm || !solana) {
      return res.status(400).json({ error: 'Missing evm or solana wallet details' });
    }

    if (!evm.address || !evm.private_key || !solana.address || !solana.private_key) {
      return res.status(400).json({ error: 'Missing required wallet fields' });
    }

    if (walletStore.walletExists(wallet_name)) {
      return res.status(409).json({ error: 'Wallet already registered' });
    }

    const fetchWithPayment = await createWallet(
      evm.private_key,
      evm.address,
      solana.private_key,
      solana.address
    );
    
    const storeResult = walletStore.storeMultiChainWallet(
      wallet_name,
      evm.address,
      evm.private_key,
      solana.address,
      solana.private_key
    );
    
    registeredWallets.set(wallet_name, {
      evm_address: evm.address,
      solana_address: solana.address
    });
    walletClients.set(wallet_name, fetchWithPayment);
    
    console.log(`✓ Registered multi-chain wallet: ${wallet_name}`);
    res.json({
      success: true,
      wallet_name,
      evm_address: evm.address,
      solana_address: solana.address,
      api_key: storeResult.apiKey
    });
    
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/proxy', validateApiKey, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { target_url, method = 'GET', headers = {}, body, idempotency_key } = req.body;
    const walletName = req.walletName;
    const walletData = req.walletData;
    const isVerbose = ['true', 'True', 'TRUE'].includes(headers['x-verbose']);
    
    if (!target_url) {
      return res.status(400).json({ error: 'Missing target_url' });
    }

    const idempotencyKey = idempotency_key || 
                          headers['idempotency-key'] || 
                          headers['Idempotency-Key'] ||
                          `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;

    console.log(`${method} request with key: ${idempotencyKey}`);

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

    const requestPromise = (async () => {
      const fetchWithPayment = walletClients.get(walletName);
      if (!fetchWithPayment) {
        throw new Error('Wallet not registered');
      }

      const consensusHeaders = { 
        'Content-Type': 'application/json',
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
          }),
        });
      } catch (fetchError) {
        errorResponse = buildErrorResponse(fetchError, walletName, walletData, startTime);
        requestTracker.set(idempotencyKey, {
          response: errorResponse,
          timestamp: new Date().toISOString(),
          isError: true
        });
        return errorResponse;
      }

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
            ...walletData,
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

      const responseData = await response.json();
      const fullResponse = {
        ...responseData,
        meta: {
          ...(responseData.meta || {}),
          wallet: walletName,
          ...walletData,
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

    processingRequests.set(idempotencyKey, requestPromise);
    let timeoutId;
    const cleanup = () => {
      processingRequests.delete(idempotencyKey);
      if (timeoutId) clearTimeout(timeoutId);
    };
    requestPromise.finally(cleanup);
    timeoutId = setTimeout(cleanup, 5 * 60 * 1000);
    
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
    const errorResp = buildErrorResponse(error, req.walletName, req.walletData, startTime);
    res.status(errorResp.status).json({
      error: errorResp.error,
      message: errorResp.message,
      details: errorResp.details
    });
  }
});

app.get('/health', (req, res) => {
  const dbInfo = walletStore.getDatabaseInfo();
  res.json({ 
    status: 'healthy',
    wallets: registeredWallets.size,
    tracked: requestTracker.size,
    processing: processingRequests.size,
    database: dbInfo?.walletCount || 0,
    server: consensusServerUrl,
    chains: ['evm', 'solana']
  });
});

app.get('/stats', (req, res) => {
  res.json({
    wallets: registeredWallets.size,
    tracked: requestTracker.size,
    processing: processingRequests.size,
    uptime: process.uptime(),
    memory: process.memoryUsage().heapUsed
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled:', error);
  res.status(500).json({ error: 'Internal server error' });
});

['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    walletStore.close();
    process.exit(0);
  });
});

async function testConsensusConnection() {
  try {
    const response = await enhancedFetch(consensusServerUrl + "/");
    if (!response.ok) {
      console.error(`Status: ${response.status}`);
      return false;
    }

    const data = await response.json();
    console.log(`✅ Connected: ${data.name} v${data.version}`);
    return true;
  } catch (error) {
    console.error(`Connection failed: ${error.message}`);
    return false;
  }
}

async function boot() {
  try {
    await restoreWallets();
    await testConsensusConnection();
    
    const server = https.createServer({
      key: fs.readFileSync(PROXY_TLS_KEY),
      cert: fs.readFileSync(PROXY_TLS_CERT),
    }, app);
    
    server.listen(port, '0.0.0.0', () => {
      console.log(`x402 Proxy (EVM + Solana) on https://consensus.proxy.canister.software:${port}`);
      console.log(`Main server: ${consensusServerUrl}`);
    });
  } catch (error) {
    console.error('Boot failed:', error.message);
    process.exit(1);
  }
}

boot();