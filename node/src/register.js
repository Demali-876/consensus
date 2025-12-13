import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://consensus.canister.software:8080';

async function getPublicIPv6() {
  try {
    const services = [
      'https://api64.ipify.org',
      'https://v6.ident.me',
      'https://ipv6.icanhazip.com'
    ];
    
    for (const service of services) {
      try {
        const response = await fetch(service, { 
          signal: AbortSignal.timeout(5000)
        });
        const ip = (await response.text()).trim();
        
        if (ip.includes(':')) {
          return ip;
        }
      } catch {
        continue;
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

async function getPublicIPv4() {
  try {
    const response = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(5000)
    });
    return (await response.text()).trim();
  } catch {
    return null;
  }
}

async function generateKeypair() {
  console.log('🔐 Generating RSA keypair...');
  
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  
  // Save keys
  await fs.writeFile(path.join(root, '.consensus-node.key'), privateKey);
  await fs.writeFile(path.join(root, '.consensus-node.pub'), publicKey);
  
  console.log('   ✓ Keypair generated and saved\n');
  
  return { publicKey, privateKey };
}

async function requestJoin(publicKey, region, capabilities, contact) {
  console.log('📡 Requesting to join network...');
  
  const response = await fetch(`${GATEWAY_URL}/node/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pubkey_pem: publicKey,
      alg: 'sha256',
      region,
      capabilities,
      contact
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Join request failed');
  }
  
  const data = await response.json();
  console.log('   ✓ Join request accepted');
  console.log(`   Join ID: ${data.join_id}`);
  console.log(`   Expires: ${new Date(data.expires_at * 1000).toISOString()}\n`);
  
  return data;
}

async function signChallenge(nonce, privateKey) {
  console.log('✍️  Signing challenge nonce...');
  
  // Decode base64url nonce
  const nonceBuffer = Buffer.from(
    nonce.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );
  
  // Sign the nonce
  const sign = crypto.createSign('SHA256');
  sign.update(nonceBuffer);
  const signature = sign.sign(privateKey, 'base64');
  
  console.log('   ✓ Challenge signed\n');
  
  return signature;
}

async function verifyAndRegister(joinId, signature, ipv6, ipv4, port, region, capabilities, contact, testEndpoint) {
  console.log('🔐 Submitting verification...');
  
  const response = await fetch(`${GATEWAY_URL}/node/verify/${joinId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signature,
      ipv6,
      ipv4,
      port,
      region,
      capabilities,
      contact,
      test_endpoint: testEndpoint
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || error.message || 'Verification failed');
  }
  
  const data = await response.json();
  console.log('   ✓ Verification successful\n');
  
  return data;
}

async function saveConfig(nodeData, ipv6, ipv4, port, region) {
  const config = {
    node_id: nodeData.node_id,
    domain: nodeData.domain,
    ipv6,
    ipv4: ipv4 || null,
    port,
    region,
    registered_at: new Date().toISOString(),
    benchmark_score: nodeData.benchmark_score
  };
  
  await fs.writeFile(
    path.join(root, '.consensus-node-config.json'),
    JSON.stringify(config, null, 2)
  );
  
  console.log('💾 Configuration saved\n');
}
async function saveCertificates(nodeData) {
  const certsDir = path.join(root, 'certs');
  await fs.mkdir(certsDir, { recursive: true });
  
  await fs.writeFile(
    path.join(certsDir, 'node.crt'),
    nodeData.certificates.cert
  );
  
  await fs.writeFile(
    path.join(certsDir, 'node.key'),
    nodeData.certificates.key
  );
  
  await fs.writeFile(
    path.join(certsDir, 'ca.crt'),
    nodeData.certificates.ca
  );
  
  console.log('🔐 mTLS certificates saved\n');
}

async function register() {
  console.log('🌐 Consensus Node Registration\n');
  console.log('='.repeat(60));
  console.log('\n');
  
  try {
    // Step 1: Check for existing config
    try {
      await fs.access(path.join(root, '.consensus-node-config.json'));
      console.log('⚠️  Node is already registered!');
      console.log('   Delete .consensus-node-config.json to re-register\n');
      process.exit(0);
    } catch {
      // No existing config, proceed
    }
    
    // Step 2: Detect IPs
    console.log('1️⃣  Detecting network configuration...\n');
    
    const ipv6 = await getPublicIPv6();
    if (!ipv6) {
      console.error('❌ IPv6 not available');
      console.error('   IPv6 is required for Consensus nodes.');
      console.error('   Please enable IPv6 with your ISP or network.\n');
      process.exit(1);
    }
    console.log(`   IPv6: ${ipv6}`);
    
    const ipv4 = await getPublicIPv4();
    if (ipv4) {
      console.log(`   IPv4: ${ipv4}`);
    }
    console.log('\n');
    
    // Step 3: Get user input
    console.log('2️⃣  Node configuration\n');
    
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'port',
        message: 'Port to run on:',
        default: '9090',
        validate: (input) => {
          const port = parseInt(input);
          return (port > 0 && port < 65536) || 'Invalid port number';
        }
      },
      {
        type: 'input',
        name: 'region',
        message: 'Your region (e.g., us-east, eu-west, ap-south):',
        default: 'us-east'
      },
      {
        type: 'input',
        name: 'contact',
        message: 'Contact email (optional):',
        default: ''
      }
    ]);
    
    const port = parseInt(answers.port);
    const testEndpoint = `http://localhost:${port}`;
    
    console.log('\n');
    
    // Step 4: Check if node server is running
    console.log('3️⃣  Checking if node server is running...\n');
    
    try {
      const healthCheck = await fetch(`${testEndpoint}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      
      if (!healthCheck.ok) {
        throw new Error('Health check failed');
      }
      
      console.log(`   ✓ Node server is running on port ${port}\n`);
    } catch {
      console.error(`❌ Node server is not running on port ${port}`);
      console.error(`   Please start the node server first:`);
      console.error(`   node src/node-server.js\n`);
      process.exit(1);
    }
    
    // Step 5: Generate or load keypair
    console.log('4️⃣  Cryptographic setup\n');
    
    let publicKey, privateKey;
    
    try {
      privateKey = await fs.readFile(path.join(root, '.consensus-node.key'), 'utf8');
      publicKey = await fs.readFile(path.join(root, '.consensus-node.pub'), 'utf8');
      console.log('   ✓ Using existing keypair\n');
    } catch {
      const keys = await generateKeypair();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
    }
    
    // Step 6: Request to join
    console.log('5️⃣  Network registration\n');
    
    const capabilities = {
      http_proxy: true,
      caching: true,
      ipv6: true,
      ipv4: !!ipv4
    };
    
    const joinData = await requestJoin(
      publicKey,
      answers.region,
      capabilities,
      answers.contact
    );
    
    // Step 7: Sign challenge
    console.log('6️⃣  Cryptographic verification\n');
    
    const signature = await signChallenge(joinData.challenge_nonce, privateKey);
    
    // Step 8: Submit verification
    console.log('7️⃣  Submitting to network\n');
    
    const nodeData = await verifyAndRegister(
      joinData.join_id,
      signature,
      ipv6,
      ipv4,
      port,
      answers.region,
      capabilities,
      answers.contact,
      testEndpoint
    );
    
    // Step 9: Save configuration
    console.log('8️⃣  Finalizing registration\n');
    
    await saveConfig(nodeData, ipv6, ipv4, port, answers.region);
    await saveCertificates(nodeData);
    // Success!
    console.log('='.repeat(60));
    console.log('\n✅ NODE REGISTRATION SUCCESSFUL!\n');
    console.log('='.repeat(60));
    console.log('\n');
    console.log(`Node ID:          ${nodeData.node_id}`);
    console.log(`Domain:           ${nodeData.domain}`);
    console.log(`IPv6:             ${ipv6}`);
    if (ipv4) console.log(`IPv4:             ${ipv4}`);
    console.log(`Port:             ${port}`);
    console.log(`Region:           ${answers.region}`);
    console.log(`Benchmark Score:  ${nodeData.benchmark_score}/100`);
    console.log('\n');
    console.log('Next Steps:');
    console.log('  1. DNS propagation may take up to 5 minutes');
    console.log('  2. Your node is now part of the Consensus network');
    console.log('  3. Keep your node server running to serve requests');
    console.log('  4. Monitor your node: ' + GATEWAY_URL + '/node/status/' + nodeData.node_id);
    console.log('\n');
    console.log('Your node will now receive proxy requests from the network!');
    console.log('\n');
    
  } catch (error) {
    console.error('\n❌ Registration failed:', error.message);
    console.error('\n');
    process.exit(1);
  }
}

register();