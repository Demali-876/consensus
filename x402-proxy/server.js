import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
import { createKeyPairSignerFromBytes } from '@solana/signers';

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

app.use(helmet());
app.use(cors());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));
app.use(express.json({ limit: '10mb' }));

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
  console.log(`Loaded ${loaded}/${wallets.length} wallet(s)`);
  return loaded;
}

app.post('/register-wallet', async (req, res) => {
  try {
    const { wallet_name, evm, solana } = req.body;
    
    if (!wallet_name || !evm?.address || !evm?.private_key || 
        !solana?.address || !solana?.private_key) {
      return res.status(400).json({ error: 'Missing required fields' });
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
    
    console.log(`✓ Registered wallet: ${wallet_name}`);
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

// Renamed from /proxy to /fetch
app.post('/fetch', validateApiKey, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { target_url, method = 'GET', headers = {} } = req.body;
    const walletName = req.walletName;
    
    if (!target_url) {
      return res.status(400).json({ error: 'Missing target_url' });
    }

    const idempotencyKey = headers['x-idempotency-key'] || 
                          `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;

    console.log(`${method} request with key: ${idempotencyKey}`);

    const fetchWithPayment = walletClients.get(walletName);
    if (!fetchWithPayment) {
      throw new Error('Wallet not registered');
    }

    // Call main server's /proxy endpoint (which handles payment + deduplication)
    const response = await fetchWithPayment(consensusServerUrl + '/proxy', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_url,
        method,
        headers: { 'x-idempotency-key': idempotencyKey, ...headers },
      }),
    });

    if (!response.ok) {
      const errorDetails = await response.json().catch(() => ({ message: response.statusText }));
      return res.status(response.status).json(errorDetails);
    }

    const responseData = await response.json();
    
    const fullResponse = {
      ...responseData,
      meta: {
        ...(responseData.meta || {}),
        wallet: walletName,
        evm_address: req.walletData.evm_address,
        idempotency_key: idempotencyKey,
        processing_ms: Date.now() - startTime,
      }
    };

    res.json(fullResponse);

  } catch (error) {
    console.error('Fetch error:', error.message);
    res.status(500).json({
      error: 'Request failed',
      message: error.message
    });
  }
});

app.get('/health', (req, res) => {
  const dbInfo = walletStore.getDatabaseInfo();
  res.json({ 
    status: 'healthy',
    wallets: registeredWallets.size,
    database: dbInfo?.walletCount || 0,
    server: consensusServerUrl,
    chains: ['evm', 'solana']
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
    if (!response.ok) return false;

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
      console.log(`\n🔐 x402 Proxy Service`);
      console.log(`   URL: https://consensus.proxy.canister.software:${port}`);
      console.log(`   Endpoint: POST /fetch`);
      console.log(`   Main server: ${consensusServerUrl}\n`);
    });
  } catch (error) {
    console.error('Boot failed:', error.message);
    process.exit(1);
  }
}

boot();