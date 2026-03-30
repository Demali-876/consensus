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
import { runTunnel }    from './tunnel';
import { showLanding }  from './screens/landing';
import { showMainMenu } from './screens/menu';
import { showTunnels }  from './screens/tunnels';
import { showProxy }    from './screens/proxy';
import { showReverseProxy } from './screens/reverse-proxy';
import { showWebsockets }   from './screens/websockets';
import { showIps }          from './screens/ips';
import { showSettings }     from './screens/settings';

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

// ─── Design tokens ───────────────────────────────────────────────────────────
import { C as PALETTE } from './theme';

// ─── (landing screen moved to screens/landing.ts) ─────────────────────────────
async function showBanner(): Promise<void> {
  const pkg     = await readFile(path.join(import.meta.dir, '../package.json'), 'utf8');
  const version = JSON.parse(pkg).version as string;

  const SERVER  = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

  const renderer = await createCliRenderer({
    exitOnCtrlC:        false,
    targetFps:          15,
    useMouse:           false,
    useAlternateScreen: true,
  });

  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding       = 0;

  // ── Top bar ─────────────────────────────────────────────────────────────────
  const topBar = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'row',
    justifyContent:  'space-between',
    alignItems:      'center',
    paddingX:        2,
    paddingY:        0,
    backgroundColor: PALETTE.panel,
  });
  topBar.add(new TextRenderable(renderer, {
    content: 'CONSENSUS',
    fg:      PALETTE.white,
    bg:      PALETTE.panel,
  }));
  topBar.add(new TextRenderable(renderer, {
    content: `v${version}`,
    fg:      PALETTE.slate,
    bg:      PALETTE.panel,
  }));
  root.add(topBar);

  // ── Centre content ──────────────────────────────────────────────────────────
  const centre = new BoxRenderable(renderer, {
    width:           '100%',
    flexGrow:        1,
    flexDirection:   'column',
    alignItems:      'center',
    justifyContent:  'center',
    paddingY:        1,
    backgroundColor: PALETTE.dark,
  });

  // Big logo
  const logo = new ASCIIFontRenderable(renderer, {
    text:            'CONSENSUS',
    font:            'block',
    color:           PALETTE.white,
    backgroundColor: PALETTE.dark,
  });

  // Tagline
  const tagline = new TextRenderable(renderer, {
    content: 'The IoT Protocol Layer  ·  canister.software',
    fg:      PALETTE.slate,
    bg:      PALETTE.dark,
  });

  centre.add(logo);
  centre.add(tagline);

  // ── Two info panels ─────────────────────────────────────────────────────────
  const panelRow = new BoxRenderable(renderer, {
    width:          '100%',
    flexDirection:  'row',
    justifyContent: 'center',
    gap:            2,
    paddingX:       4,
    paddingTop:     2,
    backgroundColor: PALETTE.dark,
  });

  // Left: Features
  const featuresBox = new BoxRenderable(renderer, {
    flexGrow:        1,
    borderStyle:     'single',
    borderColor:     PALETTE.dim,
    title:           ' Features ',
    padding:         1,
    backgroundColor: PALETTE.panel,
  });
  for (const f of ['Tunnels', 'Proxy', 'Reverse-Proxy', 'WebSockets', 'IPs']) {
    featuresBox.add(new TextRenderable(renderer, {
      content: `  ·  ${f}`,
      fg:      PALETTE.slate,
      bg:      PALETTE.panel,
    }));
  }

  // Right: Status — server, protocol, network
  const statusBox = new BoxRenderable(renderer, {
    flexGrow:        1,
    borderStyle:     'single',
    borderColor:     PALETTE.dim,
    title:           ' Status ',
    padding:         1,
    backgroundColor: PALETTE.panel,
  });

  const mk = (label: string, value: string) => {
    const row = new BoxRenderable(renderer, {
      flexDirection:   'row',
      backgroundColor: 'transparent',
    });
    row.add(new TextRenderable(renderer, { content: label.padEnd(12), fg: PALETTE.dim,   bg: 'transparent' }));
    row.add(new TextRenderable(renderer, { content: value,            fg: PALETTE.slate, bg: 'transparent' }));
    return row;
  };

  const serverStatusVal = new TextRenderable(renderer, { content: '◌  checking…', fg: PALETTE.dim, bg: 'transparent' });
  const serverRow = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
  serverRow.add(new TextRenderable(renderer, { content: 'Server'.padEnd(12), fg: PALETTE.dim, bg: 'transparent' }));
  serverRow.add(serverStatusVal);

  statusBox.add(serverRow);
  statusBox.add(mk('Protocol',  'x402  v2.1'));
  statusBox.add(mk('Network',   'Base  ·  Solana'));
  statusBox.add(mk('Runtime',   `Bun  ${Bun.version}`));

  panelRow.add(featuresBox);
  panelRow.add(statusBox);
  centre.add(panelRow);
  root.add(centre);

  // ── Bottom shortcut bar ──────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'row',
    justifyContent:  'space-between',
    paddingX:        2,
    paddingY:        0,
    backgroundColor: PALETTE.panel,
  });
  bottomBar.add(new TextRenderable(renderer, {
    content: '[↵  continue]  [Q  quit]',
    fg:      PALETTE.slate,
    bg:      PALETTE.panel,
  }));
  bottomBar.add(new TextRenderable(renderer, {
    content: 'canister.software',
    fg:      PALETTE.dim,
    bg:      PALETTE.panel,
  }));
  root.add(bottomBar);

  // ── Background server health check ───────────────────────────────────────────
  fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(4000) })
    .then((r) => {
      serverStatusVal.content = r.ok ? '●  connected' : '○  degraded';
      serverStatusVal.fg      = r.ok ? '#10b981'      : '#f59e0b';
    })
    .catch(() => {
      serverStatusVal.content = '○  unreachable';
      serverStatusVal.fg      = '#ef4444';
    });

  // ── Key input ────────────────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'q' || key.name === 'Q') { process.exit(0); }
      resolve();
    });
  });

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
  const sdk = new ConsensusSDK();
  const command = process.argv[2];

  // No subcommand → landing → section (direct shortcut or menu) → back to landing
  if (!command) {
    const goTo = async (section: string) => {
      if      (section === 'tunnels')       await showTunnels();
      else if (section === 'proxy')         await showProxy();
      else if (section === 'reverse-proxy') await showReverseProxy();
      else if (section === 'websockets')    await showWebsockets();
      else if (section === 'ips')           await showIps();
      else if (section === 'settings')      await showSettings();
    };

    let next = await showLanding();
    while (next !== 'quit') {
      if (next === 'menu') {
        // Full menu → picks a section → returns to landing
        const section = await showMainMenu();
        if (section !== 'quit') await goTo(section);
      } else {
        await goTo(next);
      }
      next = await showLanding();
    }
    return;
  }

  switch (command) {
    case 'setup':
      await sdk.setup();
      break;
    case 'tunnel': {
      // consensus tunnel http 192.168.1.101
      // consensus tunnel http 192.168.1.101:3000
      // consensus tunnel tcp  192.168.1.101:1883
      const tunnelType   = process.argv[3] as 'http' | 'tcp' | undefined;
      const tunnelTarget = process.argv[4];
      const isInternal   = process.argv.includes('--internal');

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

      if (!isInternal && process.platform === 'darwin') {
        // Write a temp shell script to avoid all osascript escaping issues
        const bunBin    = Bun.which('bun') ?? `${process.env.HOME}/.bun/bin/bun`;
        const self      = import.meta.path;
        const tmpScript = `/tmp/consensus-tunnel-${Date.now()}.sh`;

        await Bun.write(tmpScript, [
          '#!/bin/bash',
          `export PATH="$HOME/.bun/bin:$PATH"`,
          `cd '${process.cwd()}'`,
          `exec '${bunBin}' '${self}' tunnel ${tunnelType} ${tunnelTarget} --internal`,
        ].join('\n'));

        Bun.spawnSync(['chmod', '+x', tmpScript]);

        const appleScript = `tell application "Terminal"
  do script "bash '${tmpScript}'"
  activate
end tell`;
        Bun.spawnSync(['osascript', '-e', appleScript]);
        console.log(chalk.green(`✓`) + chalk.dim(` Tunnel opening in new window — ${tunnelType.toUpperCase()} → ${tunnelTarget}`));
        break;
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
