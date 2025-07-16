#!/usr/bin/env node

import 'dotenv/config';
import { CdpClient } from '@coinbase/cdp-sdk';
import { toAccount } from 'viem/accounts';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class ConsensusClient {
  constructor() {
    this.serverUrl = process.env.CONSENSUS_SERVER_URL || 'http://localhost:8080';
  }

  async setup() {
    console.log('Consensus Client Setup Starting...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Check required environment variables
    const requiredVars = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.error('Missing required environment variables:');
      missingVars.forEach(varName => {
        console.error(`   ${varName}`);
      });
      console.log('\n Create a .env file with:');
      console.log('CDP_API_KEY_ID=your-api-key-id');
      console.log('CDP_API_KEY_SECRET=your-api-key-secret');
      console.log('CDP_WALLET_SECRET=your-wallet-secret');
      console.log('CONSENSUS_SERVER_URL=http://localhost:8080');
      console.log('\n Get CDP credentials from: https://portal.cdp.coinbase.com/');
      process.exit(1);
    }

    try {
      console.log('Environment variables found');
      console.log('Creating CDP client...');

      const cdp = new CdpClient();

      console.log(' Creating payment account...');
      const cdpAccount = await cdp.evm.createAccount();
      const account = toAccount(cdpAccount);

      console.log(`Account created: ${account.address}`);
      console.log(`Registering with Consensus server: ${this.serverUrl}`);

      // Register account with server
      const response = await axios.post(`${this.serverUrl}/create-client`, {
        account: account,
        account_address: account.address
      });

      if (!response.data.success) {
        throw new Error(response.data.error || 'Registration failed');
      }

      const { api_key, account_address } = response.data;
      
      console.log('\n Setup Complete!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Account Address: ${account_address}`);
      console.log(`API Key: ${api_key}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      console.log('\n📋 Next Steps:');
      console.log('1. Fund your account with USDC on Base Sepolia');
      console.log(`   Address: ${account_address}`);
      console.log('2. Get USDC from: https://faucet.circle.com/');
      console.log('3. Use API key in your applications');
      
      console.log('\n🛠️  Usage from any language:');
      console.log('POST http://localhost:8080/proxy');
      console.log(`Headers: { "X-API-Key": "${api_key}" }`);
      console.log('Body: {');
      console.log('  "target_url": "https://api.example.com/data",');
      console.log('  "headers": { "x-idempotency-key": "unique-key-123" }');
      console.log('}');
      
      console.log('\n Your Consensus proxy is ready!');

    } catch (error) {
      console.error('\n❌ Setup Failed:');
      console.error(`   Error: ${error.message}`);
      
      if (error.response) {
        console.error('   Server Response:');
        console.error(`   Status: ${error.response.status}`);
        if (error.response.data) {
          console.error(`   Details: ${JSON.stringify(error.response.data, null, 2)}`);
        }
      }
      
      if (error.code === 'ECONNREFUSED') {
        console.error('\n💡 Is the Consensus server running?');
        console.error(`   Server URL: ${this.serverUrl}`);
        console.error('   Start server with: cd server && node server.js');
      }
      
      process.exit(1);
    }
  }
}

// CLI handling
async function main() {
  const client = new ConsensusClient();
  const command = process.argv[2];

  if (command === 'setup' || !command) {
    await client.setup();
  } else {
    console.log('🏗️  Consensus Client CLI');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Commands:');
    console.log('  setup (default) - Create CDP account and get API key');
    console.log('\nUsage:');
    console.log('  node setup.js');
    console.log('  node setup.js setup');
    console.log('\n🔗 After setup, use API key from any programming language');
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
}

export default ConsensusClient;