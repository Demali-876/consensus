import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const app = express();
const port = process.env.NODE_PORT || 9090;
const gatewayUrl = process.env.GATEWAY_URL || 'https://consensus.canister.software:8888';

// Idle detection counters
let inFlightRequests = 0;

function isIdle() {
  return inFlightRequests === 0;
}

// Load node configuration if exists
let nodeConfig = null;
let nodeKeys = null;

async function loadConfig() {
  try {
    const configPath = path.join(root, '.consensus-node-config.json');
    const configData = await fs.readFile(configPath, 'utf8');
    nodeConfig = JSON.parse(configData);
    console.log(`✓ Loaded node config: ${nodeConfig.node_id}`);
  } catch {
    console.log('⚠️  No node config found - run registration first');
  }
}

async function loadKeys() {
  try {
    const privateKeyPath = path.join(root, '.consensus-node.key');
    const publicKeyPath = path.join(root, '.consensus-node.pub');
    
    const privateKey = await fs.readFile(privateKeyPath, 'utf8');
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    
    nodeKeys = { privateKey, publicKey };
    console.log('✓ Loaded node keypair');
  } catch {
    console.log('⚠️  No keypair found - run registration first');
  }
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

console.log('🌐 Consensus Node Server\n');

// Benchmark endpoints (required for network joining)

app.post('/benchmark/fetch', async (req, res) => {
  try {
    const { target_url } = req.body;
    
    if (!target_url) {
      return res.status(400).json({ error: 'Missing target_url' });
    }
    
    console.log(`📡 Fetch benchmark: ${target_url}`);
    
    const start = Date.now();
    const response = await fetch(target_url, {
      signal: AbortSignal.timeout(5000)
    });
    
    await response.text();
    const duration = Date.now() - start;
    
    console.log(`   ✓ Completed in ${duration}ms`);
    
    res.json({
      success: true,
      status: response.status,
      duration_ms: duration
    });
    
  } catch (error) {
    console.log(`   ✗ Error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/benchmark/cpu', (req, res) => {
  try {
    const { iterations, data } = req.body;
    
    if (!iterations || !data) {
      return res.status(400).json({ error: 'Missing iterations or data' });
    }
    
    console.log(`⚙️  CPU benchmark: ${iterations} iterations`);
    
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
      crypto.createHash('sha256').update(data).digest('hex');
    }
    
    const duration = Date.now() - start;
    const hashesPerSecond = (iterations / duration) * 1000;
    
    console.log(`   ✓ ${Math.round(hashesPerSecond)} hashes/second`);
    
    res.json({
      success: true,
      iterations,
      duration_ms: duration,
      hashes_per_second: Math.round(hashesPerSecond)
    });
    
  } catch (error) {
    console.log(`   ✗ Error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/benchmark/system', (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    
    console.log(`💾 System info: ${Math.round(freeMem / 1024 / 1024)}MB free`);
    
    res.json({
      success: true,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      total_memory_bytes: totalMem,
      free_memory_bytes: freeMem,
      uptime_seconds: os.uptime(),
      node_version: process.version
    });
    
  } catch (error) {
    console.log(`   ✗ Error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/benchmark/memory-test', (req, res) => {
  try {
    const { test_size_mb } = req.body;

    if (!test_size_mb) {
      return res.status(400).json({ error: 'Missing test_size_mb' });
    }

    console.log(`💾 Memory allocation test: ${test_size_mb}MB`);

    const start = Date.now();

    try {
      const bytes = test_size_mb * 1024 * 1024;
      const buffer = Buffer.alloc(bytes);

      for (let i = 0; i < buffer.length; i += 1024) {
        buffer[i] = 1;
      }

      const duration = Date.now() - start;

      buffer.fill(0);
      console.log(`   ✓ Allocated ${test_size_mb}MB in ${duration}ms`);

      res.json({
        success: true,
        allocated_mb: test_size_mb,
        duration_ms: duration
      });
    } catch (allocError) {
      console.log(`   ✗ Failed to allocate: ${allocError.message}`);
      res.json({
        success: false,
        error: allocError.message,
        allocated_mb: 0
      });
    }
    
  } catch (error) {
    console.log(`   ✗ Error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    node_id: nodeConfig?.node_id || null,
    domain: nodeConfig?.domain || null,
    registered: !!nodeConfig
  });
});

// Node info
app.get('/info', (req, res) => {
  res.json({
    node_id: nodeConfig?.node_id || null,
    domain: nodeConfig?.domain || null,
    region: nodeConfig?.region || null,
    ipv6: nodeConfig?.ipv6 || null,
    ipv4: nodeConfig?.ipv4 || null,
    port: port,
    status: nodeConfig ? 'registered' : 'unregistered',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Proxy endpoint (will forward to target APIs)
app.post('/proxy', async (req, res) => {
  inFlightRequests++;
  try {
    const { target_url, method = 'GET', headers = {}, body } = req.body;

    if (!target_url) {
      return res.status(400).json({ error: 'Missing target_url' });
    }

    console.log(`🔄 Proxying ${method} request to ${target_url}`);

    const start = Date.now();

    // Make the request
    const fetchOptions = {
      method,
      headers: {
        ...headers,
        'User-Agent': `Consensus-Node/${nodeConfig?.node_id || 'unregistered'}`
      },
      signal: AbortSignal.timeout(30000)
    };

    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(target_url, fetchOptions);
    const responseBody = await response.text();
    const duration = Date.now() - start;

    console.log(`   ✓ Completed in ${duration}ms (${response.status})`);

    // Return response
    res.status(response.status).json({
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: responseBody,
      meta: {
        node_id: nodeConfig?.node_id || null,
        processing_time_ms: duration,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error(`   ✗ Proxy error: ${error.message}`);
    res.status(500).json({
      error: 'Proxy request failed',
      message: error.message
    });
  } finally {
    inFlightRequests--;
  }
});


// Start server
async function startServer() {
  await loadConfig();
  await loadKeys();
  
  // Check if we have mTLS certificates
  let server;
  const certsExist = await checkCertsExist();
  
  if (certsExist && nodeConfig) {
    // Use HTTPS with mTLS
    const key = await fs.readFile(path.join(root, 'certs/node.key'));
    const cert = await fs.readFile(path.join(root, 'certs/node.crt'));
    const ca = await fs.readFile(path.join(root, 'certs/ca.crt'));
    
    server = https.createServer({ key, cert, ca }, app);
    console.log(`🔐 Starting with mTLS enabled`);
  } else {
    // Use HTTP for testing/registration
    const http = await import('http');
    server = http.createServer(app);
    console.log(`⚠️  Starting without TLS (registration mode)`);
  }
  
  server.listen(port, '0.0.0.0', async () => {
    console.log(`\n✅ Consensus Node running on ${certsExist ? 'https' : 'http'}://localhost:${port}`);

    if (nodeConfig) {
      console.log(`   Node ID: ${nodeConfig.node_id}`);
      console.log(`   Domain: ${nodeConfig.domain}`);
      console.log(`   Status: Registered`);
    } else {
      console.log(`   Status: Not registered`);
      console.log(`   Run: node src/register.js to join the network`);
    }

    console.log('\n📋 Endpoints:');
    console.log(`   GET  /health - Health check`);
    console.log(`   GET  /info - Node information`);
    console.log(`   POST /proxy - Proxy requests`);
    console.log(`   POST /benchmark/* - Benchmark endpoints`);
    console.log('\n');

    // Start update loop if registered
    if (nodeConfig) {
      try {
        const { NodeUpdater } = await import('./updater.js');
        const updater = new NodeUpdater({
          gatewayUrl,
          nodeId: nodeConfig.node_id,
          instanceRoot: root,
          privateKeyPath: path.join(root, '.consensus-node.key'),
        });

        // Report integrity on startup
        await updater.loadBuildDigest();
        try {
          const result = await updater.reportIntegrity();
          console.log(`🔒 Integrity check: ${result.verified ? 'verified' : 'unverified'}`);
        } catch (e) {
          console.error('⚠️  Integrity report failed:', e.message);
        }

        // Check for updates every 5 minutes
        setInterval(async () => {
          try {
            const manifest = await updater.checkForUpdate();
            if (!manifest) return;

            console.log(`📦 Update available: v${manifest.version}`);

            // Wait for idle before applying
            await new Promise((resolve) => {
              const check = () => {
                if (isIdle()) return resolve(undefined);
                setTimeout(check, 1000);
              };
              check();
            });

            console.log('⏳ Node is idle, applying update...');
            await updater.downloadAndApply(manifest);
            updater.restart();
          } catch (e) {
            console.error('⚠️  Update check failed:', e.message);
          }
        }, 5 * 60 * 1000);
      } catch (e) {
        console.error('⚠️  Updater initialization failed:', e.message);
      }
    }
  });
}

async function checkCertsExist() {
  try {
    await fs.access(path.join(root, 'certs/node.key'));
    await fs.access(path.join(root, 'certs/node.crt'));
    await fs.access(path.join(root, 'certs/ca.crt'));
    return true;
  } catch {
    return false;
  }
}

startServer();