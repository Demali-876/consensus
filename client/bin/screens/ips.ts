/**
 * IPs / Node Leasing screen — browse nodes, lease/release a node
 *
 * Keys:
 *   1  Browse & lease a node
 *   2  Release current lease (only when active)
 *   B  Back to landing
 *
 * Leasing a node pins all proxy, tunnel, and ws traffic to that exact node
 * by injecting node_domain into every request.
 */
import inquirer from 'inquirer';
import chalk    from 'chalk';
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
} from '@opentui/core';
import { C } from '../theme';
import { loadConfig, saveConfig } from '../lib/config.ts';
import { listNodes, leaseNode, releaseNode, fmtCapabilities } from '../lib/ip.ts';
import type { NodeInfo } from '../lib/ip.ts';

const TITLE = 'IPS / NODES';

// ─── Menu screen ─────────────────────────────────────────────────────────────

async function showMenu(lease: { domain: string; region?: string; leased_at: string } | null | undefined): Promise<'browse' | 'release' | 'back'> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, { width: '100%', flexGrow: 1, flexDirection: 'column', paddingX: 3, paddingTop: 2, backgroundColor: C.dark });
  const add = (text: string, fg = C.slate) =>
    content.add(new TextRenderable(renderer, { content: text, fg, bg: C.dark }));

  add(TITLE, C.white);
  add('─'.repeat(40), C.dim);
  add(' ');

  if (lease) {
    add('Current lease:', C.dim);
    add(`  ${lease.domain}`, C.cyan);
    if (lease.region) add(`  region: ${lease.region}`, C.dim);
    add(`  since: ${new Date(lease.leased_at).toLocaleString()}`, C.dim);
    add('  All traffic is pinned to this node.', C.emerald);
  } else {
    add('No node leased — traffic uses automatic node selection.', C.dim);
  }

  add(' ');
  add('[1]  Browse nodes  (select one to lease)', C.slate);
  if (lease) add('[2]  Release current lease', C.slate);
  add('[B]  Back', C.dim);

  root.add(content);

  const hints = lease
    ? '[1  browse]  [2  release]  [B  back]'
    : '[1  browse]  [B  back]';

  const bottomBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  bottomBar.add(new TextRenderable(renderer, { content: hints, fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  return new Promise<'browse' | 'release' | 'back'>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === '1') { renderer.destroy(); resolve('browse'); }
      if (key.name === '2' && lease) { renderer.destroy(); resolve('release'); }
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        renderer.destroy();
        resolve('back');
      }
    });
  });
}

// ─── Browse & lease flow ──────────────────────────────────────────────────────

async function runBrowseFlow(): Promise<void> {
  const { region } = await inquirer.prompt<{ region: string }>([
    {
      type: 'input',
      name: 'region',
      message: 'Filter by region (leave blank for all):',
      default: '',
    },
  ]);

  const cfg = loadConfig();

  console.log(chalk.dim('\nFetching nodes…'));

  let nodes: NodeInfo[] = [];
  try {
    nodes = await listNodes({ config: cfg, region: region.trim() || undefined });
  } catch (err) {
    console.error(chalk.red('Error:'), (err as Error).message);
    console.log(chalk.dim('Press Enter to continue…'));
    await new Promise<void>((r) => process.stdin.once('data', () => r()));
    return;
  }

  if (!nodes.length) {
    console.log(chalk.dim('No nodes found.'));
    console.log(chalk.dim('Press Enter to continue…'));
    await new Promise<void>((r) => process.stdin.once('data', () => r()));
    return;
  }

  // Show table
  console.log('\n' + chalk.dim('  ' + 'NODE ID'.padEnd(16) + 'DOMAIN'.padEnd(40) + 'REGION'.padEnd(12) + 'CAPS'));
  console.log(chalk.dim('  ' + '─'.repeat(80)));
  for (const n of nodes) {
    const isLeased = cfg.leased_node?.domain === n.domain;
    const row = '  ' +
      (n.node_id ?? '—').slice(0, 15).padEnd(16) +
      (n.domain ?? '—').slice(0, 39).padEnd(40) +
      (n.region ?? '—').padEnd(12) +
      fmtCapabilities(n.capabilities);
    console.log(isLeased ? chalk.cyan(row) + chalk.dim(' ← current') : row);
  }

  const { chosen } = await inquirer.prompt<{ chosen: string }>([
    {
      type: 'list',
      name: 'chosen',
      message: 'Select a node to lease (traffic will be pinned to it):',
      choices: [
        ...nodes.map((n) => ({
          name: `${n.domain}  ${chalk.dim(`[${n.region ?? '?'}]`)}`,
          value: n.domain,
        })),
        { name: chalk.dim('(cancel)'), value: '__cancel__' },
      ],
    },
  ]);

  if (chosen === '__cancel__') return;

  leaseNode({ config: cfg, nodeIdOrDomain: chosen, nodes });
  console.log(chalk.green(`\n✓ Leased: ${chosen}`));
  console.log(chalk.dim('  All proxy, tunnel, and ws traffic is now pinned to this node.'));
  console.log(chalk.dim('  Press Enter to continue…'));
  await new Promise<void>((r) => process.stdin.once('data', () => r()));
}

// ─── Release flow ─────────────────────────────────────────────────────────────

async function runReleaseFlow(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.leased_node) {
    console.log(chalk.dim('\nNo node is currently leased.'));
  } else {
    const prev = cfg.leased_node.domain;
    releaseNode(cfg);
    console.log(chalk.green(`\n✓ Released lease for ${prev}`));
    console.log(chalk.dim('  Traffic will return to automatic node selection.'));
  }
  console.log(chalk.dim('  Press Enter to continue…'));
  await new Promise<void>((r) => process.stdin.once('data', () => r()));
}

// ─── Exported screen entry point ──────────────────────────────────────────────

export async function showIps(): Promise<'back'> {
  while (true) {
    const cfg    = loadConfig();
    const lease  = cfg.leased_node ?? null;
    const choice = await showMenu(lease);
    if (choice === 'back')    return 'back';
    if (choice === 'browse')  await runBrowseFlow();
    if (choice === 'release') await runReleaseFlow();
  }
}
