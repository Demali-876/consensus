import { CdpClient }                         from '@coinbase/cdp-sdk';
import { toAccount, privateKeyToAccount }    from 'viem/accounts';
import { base58 }                            from '@scure/base';
import { createKeyPairSignerFromBytes }      from '@solana/signers';
import fs                                    from 'fs';
import os                                    from 'os';
import crypto                                from 'crypto';
import path                                  from 'path';
import inquirer                              from 'inquirer';
import ora                                   from 'ora';
import chalk                                 from 'chalk';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WalletConfig = {
  wallet_name:    string;
  addresses:      { evm: string; solana: string };
  api_key:        string;
  x402_proxy_url: string;
  setup_date:     string;
  version:        string;
  leased_node?: {
    domain:     string;
    node_id?:   string;
    region?:    string;
    leased_at:  string;
  } | null;
};

type WalletResult = {
  wallet_name:    string;
  evm_address:    string;
  solana_address: string;
};

// ─── Shell profile writer ─────────────────────────────────────────────────────

const PROFILE_MARKER = '# >>> Consensus SDK keys — do not edit this block <<<';
const PROFILE_END    = '# >>> end Consensus SDK keys <<<';

/**
 * Writes CONSENSUS_* export lines to every shell profile found in $HOME.
 * Idempotent — replaces an existing block rather than appending a duplicate.
 * Returns the list of file paths that were written.
 */
export function writeToShellProfile(exports: Record<string, string>): string[] {
  const home     = os.homedir();
  const profiles = ['.zshrc', '.bashrc', '.bash_profile', '.profile']
    .map((f) => path.join(home, f))
    .filter((f) => fs.existsSync(f));

  if (profiles.length === 0) profiles.push(path.join(home, '.bashrc'));

  const block = [
    '',
    PROFILE_MARKER,
    ...Object.entries(exports).map(([k, v]) => `export ${k}="${v}"`),
    PROFILE_END,
    '',
  ].join('\n');

  for (const profilePath of profiles) {
    let content = '';
    try { content = fs.readFileSync(profilePath, 'utf8'); } catch { /* new file */ }

    if (content.includes(PROFILE_MARKER)) {
      const re = new RegExp(`\\n?${PROFILE_MARKER}[\\s\\S]*?${PROFILE_END}\\n?`, 'g');
      content  = content.replace(re, block);
    } else {
      content += block;
    }

    fs.writeFileSync(profilePath, content, 'utf8');
  }

  return profiles;
}

// ─── ConsensusSDK ─────────────────────────────────────────────────────────────

export class ConsensusSDK {
  private configPath:    string;
  private x402ProxyUrl:  string;

  constructor() {
    this.configPath   = path.join(process.cwd(), '.consensus-config.json');
    this.x402ProxyUrl = process.env.X402_PROXY_URL
      ?? 'https://consensus.proxy.canister.software:3001';
  }

  // ── Config I/O ──────────────────────────────────────────────────────────────

  loadConfig(): WalletConfig | null {
    try {
      if (fs.existsSync(this.configPath))
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as WalletConfig;
    } catch (err) {
      console.error(chalk.red('Error reading config:'), (err as Error).message);
    }
    return null;
  }

  saveConfig(config: WalletConfig): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      console.log(chalk.green('✓ Configuration saved'));

      // Keep config out of version control
      const gitignorePath = path.join(path.resolve(import.meta.dir, '../../'), '.gitignore');
      const ignoreEntry   = path.basename(this.configPath);
      let gitignore = '';
      if (fs.existsSync(gitignorePath)) gitignore = fs.readFileSync(gitignorePath, 'utf8');
      if (!gitignore.split('\n').includes(ignoreEntry)) {
        fs.appendFileSync(gitignorePath, `\n# Ignore consensus config\n${ignoreEntry}\n`);
        console.log(chalk.yellow('⚠️  .config hidden from git'));
      }
    } catch (err) {
      throw new Error(`Failed to save config: ${(err as Error).message}`);
    }
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  validateEnvironment(): boolean {
    const required = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'];
    const missing  = required.filter((v) => !process.env[v]);
    if (missing.length === 0) return true;

    console.error(chalk.red('Missing required environment variables:'));
    missing.forEach((v) => console.error(chalk.red(`  ${v}`)));
    console.log(chalk.yellow('\nAdd them to a .env file:'));
    console.log('CDP_API_KEY_ID=your-api-key-id');
    console.log('CDP_API_KEY_SECRET=your-api-key-secret');
    console.log('CDP_WALLET_SECRET=your-wallet-secret');
    console.log(chalk.blue('\nGet CDP credentials: https://portal.cdp.coinbase.com/'));
    return false;
  }

  async checkExistingSetup(force: boolean): Promise<boolean> {
    const config = this.loadConfig();
    if (!config) return false;

    console.log(chalk.yellow('⚠️  Existing Consensus setup found!'));
    console.log(chalk.cyan('Wallet:'), config.wallet_name);
    if (config.addresses?.evm)    console.log(chalk.cyan('EVM:   '), config.addresses.evm);
    if (config.addresses?.solana) console.log(chalk.cyan('Solana:'), config.addresses.solana);
    console.log(chalk.cyan('Date:  '), config.setup_date);

    if (force) return this.confirmReset();

    const { action } = await inquirer.prompt<{ action: string }>([{
      type:    'list',
      name:    'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'Keep existing setup', value: 'keep'  },
        { name: 'Reset and create new', value: 'reset' },
        { name: 'Exit',                 value: 'exit'  },
      ],
    }]);

    if (action === 'keep') { console.log(chalk.green('Using existing setup')); return true; }
    if (action === 'exit') process.exit(0);
    return this.confirmReset();
  }

  async confirmReset(): Promise<boolean> {
    console.log(chalk.red('\n⚠️  This will reset your account. Backup any funds first!'));
    const { ok } = await inquirer.prompt<{ ok: boolean }>([{
      type: 'confirm', name: 'ok', message: 'Continue?', default: false,
    }]);
    if (!ok) { console.log(chalk.yellow('Cancelled')); process.exit(0); }
    return false;
  }

  // ── CDP wallet creation ─────────────────────────────────────────────────────

  private extractKey(data: unknown, type: 'EVM' | 'Solana'): string {
    const raw = typeof data === 'string' ? data : (data as { privateKey?: string })?.privateKey;
    if (!raw) throw new Error(`Unexpected ${type} private key format from CDP`);
    return type === 'EVM' ? (raw.startsWith('0x') ? raw : `0x${raw}`) : raw;
  }

  async createWallets(): Promise<WalletResult> {
    const spinner = ora('Creating multi-chain CDP wallets…').start();
    try {
      const cdp  = new CdpClient();
      const name = crypto.randomBytes(8).toString('hex');
      const [evm, sol] = await Promise.all([
        cdp.evm.createAccount({ name: `${name}-evm` }),
        cdp.solana.createAccount({ name: `${name}-solana` }),
      ]);
      spinner.succeed('Multi-chain wallets created');
      return { wallet_name: name, evm_address: toAccount(evm).address, solana_address: sol.address };
    } catch (err) {
      spinner.fail('Failed to create wallets');
      throw new Error(`Wallet creation failed: ${(err as Error).message}`);
    }
  }

  async registerWithProxy(walletName: string, evmAddress: string, solanaAddress: string): Promise<string> {
    const spinner = ora('Registering with x402 proxy…').start();
    try {
      const cdp = new CdpClient();
      const [evmData, solData] = await Promise.all([
        cdp.evm.exportAccount({ name: `${walletName}-evm` }),
        cdp.solana.exportAccount({ name: `${walletName}-solana` }),
      ]);

      const res = await fetch(`${this.x402ProxyUrl}/register-wallet`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          wallet_name: walletName,
          evm:    { address: evmAddress,    private_key: this.extractKey(evmData, 'EVM') },
          solana: { address: solanaAddress, private_key: this.extractKey(solData, 'Solana') },
        }),
      });

      if (!res.ok) {
        const msg = await res.text().then((t) => {
          try { return (JSON.parse(t) as { error?: string }).error ?? t; } catch { return t; }
        });
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }

      spinner.succeed('Registered with x402 proxy');
      return ((await res.json()) as { api_key: string }).api_key;
    } catch (err) {
      spinner.fail('Failed to register');
      throw err;
    }
  }

  // ── Setup paths ─────────────────────────────────────────────────────────────

  async setupSelfManaged(): Promise<void> {
    console.log(chalk.green.bold('\n🔐 Self-Managed Setup (Recommended)\n'));
    console.log(chalk.dim(
      'Your private keys are written to your shell profile.\n' +
      'Payments are signed locally — keys never leave this machine.\n',
    ));

    const { evmKey } = await inquirer.prompt<{ evmKey: string }>([{
      type:     'password',
      name:     'evmKey',
      message:  'EVM private key (hex, 0x optional):',
      mask:     '*',
      validate: (v: string) => {
        const clean = v.startsWith('0x') ? v.slice(2) : v;
        return /^[0-9a-fA-F]{64}$/.test(clean) || 'Must be 32 bytes (64 hex chars)';
      },
    }]);
    const evmAccount = privateKeyToAccount(
      (evmKey.startsWith('0x') ? evmKey : `0x${evmKey}`) as `0x${string}`,
    );
    console.log(chalk.dim(`  ✓ EVM address: ${evmAccount.address}`));

    const { svmKey } = await inquirer.prompt<{ svmKey: string }>([{
      type:     'password',
      name:     'svmKey',
      message:  'Solana private key (base58):',
      mask:     '*',
      validate: (v: string) => {
        try   { return base58.decode(v).length === 64 || 'Expected a 64-byte keypair'; }
        catch { return 'Invalid base58 encoding'; }
      },
    }]);
    const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmKey));
    console.log(chalk.dim(`  ✓ Solana address: ${svmSigner.address}`));

    const writtenTo = writeToShellProfile({
      CONSENSUS_EVM_KEY: evmKey.startsWith('0x') ? evmKey : `0x${evmKey}`,
      CONSENSUS_SVM_KEY: svmKey,
    });

    this.saveConfig({
      wallet_name:    'self-managed',
      addresses:      { evm: evmAccount.address, solana: svmSigner.address },
      api_key:        '',
      x402_proxy_url: '',
      setup_date:     new Date().toISOString(),
      version:        '2.0.0',
    });

    console.log(chalk.green.bold('\n✅ Self-managed setup complete!\n'));
    console.log(chalk.cyan('EVM address:   '), evmAccount.address);
    console.log(chalk.cyan('Solana address:'), svmSigner.address);
    console.log(chalk.cyan('Keys written to:'));
    writtenTo.forEach((p) => console.log(chalk.dim(`  ${p}`)));
    console.log(chalk.yellow('\n⚠️  Activate in current session:'));
    console.log(chalk.bold(`  source ${writtenTo[0]}`));
    console.log(chalk.dim('\nFuture sessions load keys automatically.'));
    console.log(chalk.yellow('\n📋 Fund your wallets:'));
    console.log(chalk.dim('  EVM  (Base):'), evmAccount.address, chalk.dim('→ https://faucet.circle.com/'));
    console.log(chalk.dim('  Solana:     '), svmSigner.address,  chalk.dim('→ https://faucet.solana.com/'));
  }

  async setup(): Promise<void> {
    try {
      console.log(chalk.blue.bold('Consensus SDK Setup\n'));

      const shouldSkip = await this.checkExistingSetup(process.argv.includes('--force'));
      if (shouldSkip) return;

      const { mode } = await inquirer.prompt<{ mode: string }>([{
        type:    'list',
        name:    'mode',
        message: 'How would you like to set up?',
        choices: [
          { name: '🔐 Self-managed keys  (Recommended — keys never leave this machine)', value: 'self'    },
          { name: '☁️  Managed wallet     (Convenience — keys held by proxy service)',   value: 'managed' },
        ],
      }]);

      if (mode === 'self') return this.setupSelfManaged();

      console.log(chalk.yellow(
        '\n⚠️  Managed wallet: private keys will be stored on the proxy server.\n',
      ));

      if (!this.validateEnvironment()) process.exit(1);

      const { wallet_name, evm_address, solana_address } = await this.createWallets();
      const api_key = await this.registerWithProxy(wallet_name, evm_address, solana_address);

      this.saveConfig({
        wallet_name,
        addresses: { evm: evm_address, solana: solana_address },
        api_key,
        x402_proxy_url: this.x402ProxyUrl,
        setup_date:     new Date().toISOString(),
        version:        '2.0.0',
      });

      console.log(chalk.green.bold('\n✅ Setup complete!\n'));
      console.log(chalk.cyan('Wallet:'), wallet_name);
      console.log(chalk.cyan('EVM:   '), evm_address);
      console.log(chalk.cyan('Solana:'), solana_address);
      console.log(chalk.cyan('Proxy: '), this.x402ProxyUrl);
      console.log(chalk.yellow('\n📋 Fund your wallets:'));
      console.log(chalk.dim('  EVM  (Base Sepolia):'), evm_address,    chalk.dim('→ https://faucet.circle.com/'));
      console.log(chalk.dim('  Solana (Devnet):    '), solana_address, chalk.dim('→ https://faucet.solana.com/'));
    } catch (err) {
      console.error(chalk.red('\n❌ Setup failed:'), (err as Error).message);
      process.exit(1);
    }
  }

  // ── Help ────────────────────────────────────────────────────────────────────

  showHelp(): void {
    console.log(chalk.blue.bold('Consensus SDK\n'));
    console.log('Commands:');
    const cmds: [string, string][] = [
      ['setup',                            'Set up signing credentials (self-managed recommended)'],
      ['setup --force',                    'Reset existing setup'],
      ['tunnel http <host[:port]>',        'Expose a local HTTP server'],
      ['tunnel tcp  <host:port>',          'Expose a local TCP device'],
      ['proxy fetch <url> [opts]',         'One-shot proxied HTTP request'],
      ['proxy start [--port N]',           'Start local HTTP forward proxy daemon'],
      ['ws token [opts]',                  'Get a WebSocket session token'],
      ['ws connect [opts]',                'Open an interactive WebSocket session'],
      ['ip list [--region X]',             'List available nodes'],
      ['ip lease <domain-or-id>',          'Pin traffic to a specific node'],
      ['ip active',                        'Show currently leased node'],
      ['ip release',                       'Release leased node'],
    ];
    const pad = Math.max(...cmds.map(([c]) => c.length)) + 4;
    for (const [cmd, desc] of cmds)
      console.log(`  ${cmd.padEnd(pad)}${chalk.dim(desc)}`);
    console.log('\nOptions:');
    console.log(chalk.dim('  --method GET  --region us-east  --cache-ttl 60  --verbose  --json'));
    console.log(chalk.dim('  --model hybrid|time|data  --minutes 5  --megabytes 50'));
  }
}
