#!/usr/bin/env bun

import { CdpClient } from '@coinbase/cdp-sdk';
import { toAccount } from 'viem/accounts';
import fs from 'fs';
import crypto from 'crypto';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { readFile } from 'fs/promises';
import path from 'path';
import { runTunnel } from './tunnel';
import {
  createCliRenderer,
  ASCIIFontRenderable,
  BoxRenderable,
  TextRenderable,
} from '@opentui/core';

type WalletConfig = {
  wallet_name: string;
  addresses: {
    evm: string;
    solana: string;
  };
  api_key: string;
  x402_proxy_url: string;
  setup_date: string;
  version: string;
};

type WalletResult = {
  wallet_name: string;
  evm_account: Awaited<ReturnType<CdpClient['evm']['createAccount']>>;
  evm_address: string;
  solana_account: Awaited<ReturnType<CdpClient['solana']['createAccount']>>;
  solana_address: string;
};

// ─── Design tokens ────────────────────────────────────────────────────────────
const PALETTE = {
  cyan:    '#06b6d4',
  sky:     '#0ea5e9',
  emerald: '#10b981',
  slate:   '#94a3b8',
  dim:     '#475569',
  white:   '#f8fafc',
  dark:    '#0f172a',
  panel:   '#1e293b',
} as const;

// ─── Splash screen (1.2 s opentui render, then destroys itself) ───────────────
async function showBanner(): Promise<void> {
  const pkg     = await readFile(path.join(import.meta.dir, '../package.json'), 'utf8');
  const version = JSON.parse(pkg).version as string;

  const renderer = await createCliRenderer({
    exitOnCtrlC:        false,
    targetFps:          30,
    useMouse:           false,
    useAlternateScreen: false,   // keep in the same scroll-back buffer
  });

  // Root
  const root = renderer.root;
  root.flexDirection   = 'column';
  root.alignItems      = 'center';
  root.justifyContent  = 'center';
  root.padding         = 2;

  // Logo
  const logo = new ASCIIFontRenderable(renderer, {
    text:            'CONSENSUS',
    font:            'slick',
    color:           [PALETTE.sky, PALETTE.cyan, PALETTE.emerald],
    backgroundColor: 'transparent',
  });

  // Tagline
  const tagline = new TextRenderable(renderer, {
    content: '  Stable IPs · HTTP Deduplication · IoT Tunnels · Powered by x402  ',
    fg:      PALETTE.slate,
    bg:      PALETTE.dark,
  });

  // Version pill
  const versionBadge = new TextRenderable(renderer, {
    content: `  v${version}  `,
    fg:      PALETTE.dim,
    bg:      PALETTE.panel,
  });

  root.add(logo);
  root.add(tagline);
  root.add(versionBadge);

  renderer.start();

  // Show for 1.2 s then hand off to normal terminal output
  await new Promise((r) => setTimeout(r, 1200));
  renderer.destroy();
}

class ConsensusSDK {
  private configPath: string;
  private x402ProxyUrl: string;

  constructor() {
    this.configPath = path.join(process.cwd(), '.consensus-config.json');
    this.x402ProxyUrl =
      process.env.X402_PROXY_URL || 'https://consensus.proxy.canister.software:3001';
  }

  private extractPrivateKey(privateKeyData: unknown, keyType: 'EVM' | 'Solana' = 'EVM'): string {
    if (typeof privateKeyData === 'string') {
      if (keyType === 'EVM') {
        return privateKeyData.startsWith('0x') ? privateKeyData : `0x${privateKeyData}`;
      }
      return privateKeyData;
    }

    const data = privateKeyData as { privateKey?: string } | null;
    if (data?.privateKey) {
      if (keyType === 'EVM') {
        return data.privateKey.startsWith('0x') ? data.privateKey : `0x${data.privateKey}`;
      }
      return data.privateKey;
    }

    throw new Error(`Unexpected ${keyType} private key format from CDP`);
  }

  private generateWalletName(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  loadConfig(): WalletConfig | null {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as WalletConfig;
      }
    } catch (error) {
      console.error(chalk.red('Error reading config:'), (error as Error).message);
    }
    return null;
  }

  saveConfig(config: WalletConfig): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      console.log(chalk.green('✓ Configuration saved'));

      const rootDir = path.resolve(import.meta.dir, '../../');
      const gitignorePath = path.join(rootDir, '.gitignore');
      const ignoreEntry = path.basename(this.configPath);

      let gitignoreContents = '';
      if (fs.existsSync(gitignorePath)) {
        gitignoreContents = fs.readFileSync(gitignorePath, 'utf8');
      }

      if (!gitignoreContents.split('\n').includes(ignoreEntry)) {
        fs.appendFileSync(gitignorePath, `\n# Ignore consensus config\n${ignoreEntry}\n`);
        console.log(chalk.yellow('⚠️  .config hidden from git'));
      }
    } catch (error) {
      throw new Error(`Failed to save config: ${(error as Error).message}`);
    }
  }

  validateEnvironment(): boolean {
    const requiredVars = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'];
    const missing = requiredVars.filter((varName) => !process.env[varName]);

    if (missing.length > 0) {
      console.error(chalk.red('Missing required environment variables:'));
      missing.forEach((varName) => console.error(chalk.red(`  ${varName}`)));
      console.log(chalk.yellow('\nCreate a .env file with:'));
      console.log('CDP_API_KEY_ID=your-api-key-id');
      console.log('CDP_API_KEY_SECRET=your-api-key-secret');
      console.log('CDP_WALLET_SECRET=your-wallet-secret');
      console.log('X402_PROXY_URL=https://consensus.proxy.canister.software:3001  # (optional)');
      console.log(chalk.blue('\nGet CDP credentials: https://portal.cdp.coinbase.com/'));
      return false;
    }
    return true;
  }

  async checkExistingSetup(forceFlag: boolean): Promise<boolean> {
    const config = this.loadConfig();

    if (config) {
      console.log(chalk.yellow('⚠️  Existing Consensus setup found!'));
      console.log(chalk.cyan('Wallet Name:'), config.wallet_name);

      if (config.addresses?.evm) {
        console.log(chalk.cyan('EVM Address:'), config.addresses.evm);
      }
      if (config.addresses?.solana) {
        console.log(chalk.cyan('Solana Address:'), config.addresses.solana);
      }

      console.log(chalk.cyan('Setup Date:'), config.setup_date);

      if (!forceFlag) {
        const { action } = await inquirer.prompt<{ action: string }>([
          {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
              { name: 'Keep existing setup', value: 'keep' },
              { name: 'Create new setup (reset)', value: 'reset' },
              { name: 'Exit', value: 'exit' },
            ],
          },
        ]);

        if (action === 'keep') {
          console.log(chalk.green('Using existing setup'));
          return true;
        }
        if (action === 'exit') {
          process.exit(0);
        }
        if (action === 'reset') {
          return this.confirmReset();
        }
      } else {
        return this.confirmReset();
      }
    }

    return false;
  }

  async confirmReset(): Promise<boolean> {
    console.log(chalk.red('\n⚠️  WARNING: This will reset your account and create a new wallet.'));
    console.log(chalk.red('⚠️  Make sure to backup any funds from your current wallet!'));

    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Are you sure you want to continue?',
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log(chalk.yellow('Setup cancelled'));
      process.exit(0);
    }

    return false;
  }

  async createWallets(): Promise<WalletResult> {
    const spinner = ora('Creating multi-chain CDP wallets...').start();

    try {
      const cdp = new CdpClient();
      const walletName = this.generateWalletName();

      const [evmAccount, solanaAccount] = await Promise.all([
        cdp.evm.createAccount({ name: `${walletName}-evm` }),
        cdp.solana.createAccount({ name: `${walletName}-solana` }),
      ]);

      const evmViemAccount = toAccount(evmAccount);
      spinner.succeed('Multi-chain wallets created');

      return {
        wallet_name: walletName,
        evm_account: evmAccount,
        evm_address: evmViemAccount.address,
        solana_account: solanaAccount,
        solana_address: solanaAccount.address,
      };
    } catch (error) {
      spinner.fail('Failed to create wallets');
      throw new Error(`Wallet creation failed: ${(error as Error).message}`);
    }
  }

  async registerWithProxy(
    walletName: string,
    evmAddress: string,
    solanaAddress: string
  ): Promise<string> {
    const spinner = ora('Registering with x402 proxy...').start();

    try {
      const cdp = new CdpClient();

      const [evmPrivateKeyData, solanaPrivateKeyData] = await Promise.all([
        cdp.evm.exportAccount({ name: `${walletName}-evm` }),
        cdp.solana.exportAccount({ name: `${walletName}-solana` }),
      ]);

      const evmPrivateKey = this.extractPrivateKey(evmPrivateKeyData, 'EVM');
      const solanaPrivateKey = this.extractPrivateKey(solanaPrivateKeyData, 'Solana');

      const response = await fetch(`${this.x402ProxyUrl}/register-wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_name: walletName,
          evm: { address: evmAddress, private_key: evmPrivateKey },
          solana: { address: solanaAddress, private_key: solanaPrivateKey },
        }),
      });

      if (!response.ok) {
        const raw = await response.text();
        let message = raw;
        try {
          const parsed = JSON.parse(raw) as { error?: string; message?: string };
          message = parsed.error || parsed.message || raw;
        } catch {}
        throw new Error(`HTTP ${response.status}: ${message}`);
      }

      const data = (await response.json()) as { api_key: string };
      spinner.succeed('Registered with x402 proxy');
      return data.api_key;
    } catch (error) {
      spinner.fail('Failed to register with x402 proxy');
      if ((error as Error).message.includes('ECONNREFUSED')) {
        throw new Error(
          'Cannot connect to x402 proxy. Is it running on ' + this.x402ProxyUrl + '?'
        );
      }
      throw error;
    }
  }

  async setup(): Promise<void> {
    try {
      console.log(chalk.blue.bold('Consensus SDK Setup\n'));

      if (!this.validateEnvironment()) {
        process.exit(1);
      }

      const forceFlag = process.argv.includes('--force');
      const shouldSkip = await this.checkExistingSetup(forceFlag);

      if (shouldSkip) return;

      const { wallet_name, evm_address, solana_address } = await this.createWallets();
      const api_key = await this.registerWithProxy(wallet_name, evm_address, solana_address);

      const config: WalletConfig = {
        wallet_name,
        addresses: { evm: evm_address, solana: solana_address },
        api_key,
        x402_proxy_url: this.x402ProxyUrl,
        setup_date: new Date().toISOString(),
        version: '2.0.0',
      };

      this.saveConfig(config);

      console.log(chalk.green.bold('\n✅ Setup Complete!\n'));
      console.log(chalk.cyan('Wallet Name:'), wallet_name);
      console.log(chalk.cyan('EVM Address:'), evm_address);
      console.log(chalk.cyan('Solana Address:'), solana_address);
      console.log(chalk.cyan('API Key:'), api_key);
      console.log(chalk.cyan('x402 Proxy:'), this.x402ProxyUrl);

      console.log(chalk.yellow('\n📋 Next Steps:'));
      console.log('1. Fund your wallets:');
      console.log(chalk.dim('   EVM (Base Sepolia):'), evm_address);
      console.log(chalk.dim('      Get USDC: https://faucet.circle.com/'));
      console.log(chalk.dim('   Solana (Devnet):'), solana_address);
      console.log(chalk.dim('      Get SOL: https://faucet.solana.com/'));
      console.log('2. Make API calls using your API key');

      console.log(chalk.blue('\n🔧 Usage Example:'));
      console.log(`curl -X POST ${this.x402ProxyUrl}/proxy \\`);
      console.log(`  -H "X-API-Key: ${api_key}" \\`);
      console.log('  -H "Content-Type: application/json" \\');
      console.log(`  -d '{"target_url": "https://api.example.com", "chain": "base"}'`);
    } catch (error) {
      console.error(chalk.red('\n❌ Setup failed:'), (error as Error).message);
      process.exit(1);
    }
  }

  showHelp(): void {
    console.log(chalk.blue.bold('Consensus SDK\n'));
    console.log('Commands:');
    console.log('  setup                             Create new account and register with proxy');
    console.log('  setup --force                     Force create new account (reset existing)');
    console.log('  tunnel http <host[:port]>         Expose a local HTTP server to the internet');
    console.log('  tunnel tcp  <host:port>           Expose a local TCP device to the internet');
    console.log('  help                              Show this help message');
    console.log('\nTunnel examples:');
    console.log(chalk.dim('  consensus tunnel http 192.168.1.101         # LAN device on port 80'));
    console.log(chalk.dim('  consensus tunnel http 192.168.1.101:3000    # LAN device on port 3000'));
    console.log(chalk.dim('  consensus tunnel tcp  192.168.1.101:1883    # MQTT broker'));
    console.log('\nEnvironment variables required for setup:');
    console.log('  CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET');
    console.log(
      '  X402_PROXY_URL (optional, defaults to https://consensus.proxy.canister.software:3001/)'
    );
  }
}

async function main(): Promise<void> {
  await showBanner();
  const sdk = new ConsensusSDK();
  const command = process.argv[2];

  switch (command) {
    case 'setup':
      await sdk.setup();
      break;
    case 'tunnel': {
      // consensus tunnel http 192.168.1.101
      // consensus tunnel http 192.168.1.101:3000
      // consensus tunnel tcp  192.168.1.101:1883
      const tunnelType = process.argv[3] as 'http' | 'tcp' | undefined;
      const tunnelTarget = process.argv[4];

      if (!tunnelType || !['http', 'tcp'].includes(tunnelType)) {
        console.error(chalk.red('Usage: consensus tunnel <http|tcp> <host[:port]>'));
        console.error(chalk.dim('  Examples:'));
        console.error(chalk.dim('    consensus tunnel http 192.168.1.101'));
        console.error(chalk.dim('    consensus tunnel http 192.168.1.101:3000'));
        console.error(chalk.dim('    consensus tunnel tcp  192.168.1.101:1883'));
        process.exit(1);
      }

      if (!tunnelTarget) {
        console.error(chalk.red(`Usage: consensus tunnel ${tunnelType} <host[:port]>`));
        process.exit(1);
      }

      await runTunnel(tunnelType, tunnelTarget);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      sdk.showHelp();
      break;
    default:
      if (!command) {
        sdk.showHelp();
      } else {
        console.error(chalk.red(`Unknown command: ${command}`));
        sdk.showHelp();
        process.exit(1);
      }
  }
}

main().catch((error: Error) => {
  console.error(chalk.red('Error:'), error.message);
  process.exit(1);
});
