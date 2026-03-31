/**
 * Proxy screen — interactive forward-proxy manager
 *
 * Keys:
 *   1  Start proxy daemon (prompts for port / budget)
 *   2  One-shot fetch (prompts for URL)
 *   B  Back to landing
 */
import inquirer from 'inquirer';
import chalk    from 'chalk';
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
} from '@opentui/core';
import { C } from '../theme';
import { loadConfig, makeFetchWithPayment, fmtUsd, fmtBytes, fmtUptime } from '../lib/config.ts';
import { proxyFetch, startProxyDaemon } from '../lib/proxy.ts';

const TITLE = 'PROXY';

// ─── Shared TUI chrome ────────────────────────────────────────────────────────

async function buildShell(subtitle: string) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 15,
    useMouse: false,
    useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: subtitle, fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 2, backgroundColor: C.dark,
  });
  root.add(content);

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  bottomBar.add(new TextRenderable(renderer, { content: '[1  daemon]  [2  fetch]  [B  back]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  return { renderer, content };
}

// ─── Menu screen ─────────────────────────────────────────────────────────────

async function showMenu(): Promise<'daemon' | 'fetch' | 'back'> {
  const cfg   = loadConfig();
  const lease = cfg.leased_node;
  const { renderer, content } = await buildShell(TITLE);

  const addLine = (text: string, fg = C.slate) =>
    content.add(new TextRenderable(renderer, { content: text, fg, bg: C.dark }));

  addLine(TITLE, C.white);
  addLine('─'.repeat(40), C.dim);
  addLine(' ');

  if (lease) {
    addLine(`Leased node: ${lease.domain}`, C.cyan);
    addLine(`  region: ${lease.region ?? '—'}  pinned at: ${new Date(lease.leased_at).toLocaleString()}`, C.dim);
    addLine(' ');
  }

  addLine('[1]  Start proxy daemon', C.slate);
  addLine('     Route all outbound HTTP traffic through the consensus network', C.dim);
  addLine(' ');
  addLine('[2]  One-shot fetch', C.slate);
  addLine('     Proxy a single HTTP request and display the result', C.dim);
  addLine(' ');
  addLine('[B]  Back', C.dim);

  return new Promise<'daemon' | 'fetch' | 'back'>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === '1') { renderer.destroy(); resolve('daemon'); }
      if (key.name === '2') { renderer.destroy(); resolve('fetch'); }
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        renderer.destroy();
        resolve('back');
      }
    });
  });
}

// ─── Daemon flow ──────────────────────────────────────────────────────────────

async function runDaemonFlow(): Promise<void> {
  const { port, budget } = await inquirer.prompt<{ port: number; budget: string }>([
    {
      type: 'number',
      name: 'port',
      message: 'Local port:',
      default: 8080,
    },
    {
      type: 'input',
      name: 'budget',
      message: 'Spend budget in USD (leave blank for unlimited):',
      default: '',
    },
  ]);

  const cfg     = loadConfig();
  const fetchFn = makeFetchWithPayment(cfg.api_key ?? '');
  const budgetNum = budget.trim() ? Number(budget) : undefined;
  const lease   = cfg.leased_node;

  console.log('\n' + chalk.blue.bold('Consensus Forward Proxy'));
  console.log(chalk.dim('─'.repeat(40)));
  console.log(`  Port:   ${chalk.white(port)}`);
  if (lease) console.log(`  Node:   ${chalk.cyan(lease.domain)} ${chalk.dim('(leased)')}`);
  if (budgetNum !== undefined) console.log(`  Budget: ${chalk.white(fmtUsd(budgetNum))}`);
  console.log(chalk.dim(`\n  Configure your client: http://127.0.0.1:${port}`));
  console.log(chalk.dim('  Press Ctrl+C to stop\n'));

  const stats = { requests: 0, spend: 0, bytesSent: 0, bytesRecv: 0, startedAt: Date.now() };

  let daemon: Awaited<ReturnType<typeof startProxyDaemon>>;
  try {
    daemon = await startProxyDaemon({
      fetchFn,
      config: cfg,
      port,
      budget: budgetNum,
      onStats: (s) => Object.assign(stats, s),
    });
  } catch (err) {
    console.error(chalk.red('Failed to start proxy:'), (err as Error).message);
    return;
  }

  const ticker = setInterval(() => {
    process.stdout.write(
      `\r  ${chalk.dim('requests:')} ${chalk.white(stats.requests)}  ` +
      `${chalk.dim('spend:')} ${chalk.white(fmtUsd(stats.spend))}  ` +
      `${chalk.dim('sent:')} ${chalk.white(fmtBytes(stats.bytesSent))}  ` +
      `${chalk.dim('uptime:')} ${chalk.white(fmtUptime(stats.startedAt))}   `
    );
  }, 1000);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', async () => {
      clearInterval(ticker);
      process.stdout.write('\n');
      console.log(chalk.dim('Stopping proxy…'));
      await daemon.close();
      console.log(chalk.green('✓ Stopped'));
      resolve();
    });
  });
}

// ─── One-shot fetch flow ──────────────────────────────────────────────────────

async function runFetchFlow(): Promise<void> {
  const { targetUrl, method } = await inquirer.prompt<{ targetUrl: string; method: string }>([
    {
      type: 'input',
      name: 'targetUrl',
      message: 'Target URL:',
      validate: (v: string) => v.startsWith('http') || 'Must be a valid http(s) URL',
    },
    {
      type: 'list',
      name: 'method',
      message: 'Method:',
      choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      default: 'GET',
    },
  ]);

  const cfg     = loadConfig();
  const fetchFn = makeFetchWithPayment(cfg.api_key ?? '');
  const lease   = cfg.leased_node;

  console.log(chalk.dim(`\n→ ${method} ${targetUrl}`));
  if (lease) console.log(chalk.dim(`  node: ${lease.domain} (leased)`));

  try {
    const result = await proxyFetch({ fetchFn, config: cfg, targetUrl, method });
    const statusColor = result.status < 400 ? chalk.green : chalk.red;
    console.log('\n' + statusColor(`${result.status} ${result.statusText}`));
    console.log(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2));
    if (result.meta) console.log(chalk.dim('\nmeta: ' + JSON.stringify(result.meta)));
  } catch (err) {
    console.error(chalk.red('Error:'), (err as Error).message);
  }

  console.log(chalk.dim('\n  Press Enter to continue…'));
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
}

// ─── Exported screen entry point ──────────────────────────────────────────────

export async function showProxy(): Promise<'back'> {
  while (true) {
    const choice = await showMenu();
    if (choice === 'back') return 'back';
    if (choice === 'daemon') await runDaemonFlow();
    if (choice === 'fetch')  await runFetchFlow();
  }
}
