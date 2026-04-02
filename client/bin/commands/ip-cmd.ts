/**
 * ip-cmd.ts — `consensus ip` command handler.
 * Subcommands: list, lease, active, release
 */

import chalk                                           from 'chalk';
import { loadConfig }                                 from '../lib/config.ts';
import { listNodes, leaseNode, releaseNode,
         fmtCapabilities }                            from '../lib/ip.ts';
import { getFlagValue }                               from '../lib/flags.ts';

export async function runIpCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const cfg = loadConfig();

  // ── ip list ───────────────────────────────────────────────────────────────
  if (sub === 'list') {
    const region = getFlagValue(rest, '--region');
    console.log(chalk.blue.bold('Consensus Nodes') + (region ? chalk.dim(`  (region: ${region})`) : ''));

    let nodes: Awaited<ReturnType<typeof listNodes>>;
    try {
      nodes = await listNodes({ config: cfg, region });
    } catch (err) {
      console.error(chalk.red('Error:'), (err as Error).message);
      process.exit(1);
    }

    if (!nodes.length) { console.log(chalk.dim('  No nodes found.')); return; }

    const cols = [14, 38, 10, 7, 24];
    const hdr  = ['NODE ID', 'DOMAIN', 'REGION', 'SCORE', 'CAPABILITIES']
      .map((h, i) => h.padEnd(cols[i])).join('  ');
    console.log(chalk.dim(hdr));
    console.log(chalk.dim('─'.repeat(hdr.length)));

    for (const n of nodes) {
      const row = [
        (n.node_id ?? '—').slice(0, cols[0] - 1).padEnd(cols[0]),
        (n.domain  ?? '—').slice(0, cols[1] - 1).padEnd(cols[1]),
        (n.region  ?? '—').padEnd(cols[2]),
        String(n.benchmark_score?.toFixed(0) ?? '—').padEnd(cols[3]),
        fmtCapabilities(n.capabilities),
      ].join('  ');
      const leased = cfg.leased_node?.domain === n.domain;
      console.log(leased ? chalk.cyan(row) + chalk.dim(' ← leased') : row);
    }
    return;
  }

  // ── ip lease ──────────────────────────────────────────────────────────────
  if (sub === 'lease') {
    const nodeArg = rest.find((a) => !a.startsWith('-'));
    if (!nodeArg) {
      console.error(chalk.red('Usage: consensus ip lease <node-id-or-domain>'));
      process.exit(1);
    }

    let nodes: Awaited<ReturnType<typeof listNodes>> = [];
    try { nodes = await listNodes({ config: cfg }); } catch { /* non-fatal */ }

    leaseNode({ config: cfg, nodeIdOrDomain: nodeArg, nodes });

    const saved = loadConfig();
    console.log(chalk.green(`✓ Leased: ${saved.leased_node?.domain}`));
    console.log(chalk.dim('  All proxy, tunnel, and ws traffic pinned to this node.'));
    console.log(chalk.dim('  Run `consensus ip release` to remove.'));
    return;
  }

  // ── ip active ─────────────────────────────────────────────────────────────
  if (sub === 'active') {
    const lease = cfg.leased_node;
    if (!lease) {
      console.log(chalk.dim('No node leased. Run `consensus ip lease <node>` to pin traffic.'));
    } else {
      console.log(chalk.green('Leased node:'));
      console.log(`  ${chalk.dim('domain:   ')} ${chalk.cyan(lease.domain)}`);
      if (lease.node_id) console.log(`  ${chalk.dim('node_id:  ')} ${lease.node_id}`);
      if (lease.region)  console.log(`  ${chalk.dim('region:   ')} ${lease.region}`);
      console.log(`  ${chalk.dim('leased at:')} ${new Date(lease.leased_at).toLocaleString()}`);
    }
    return;
  }

  // ── ip release ────────────────────────────────────────────────────────────
  if (sub === 'release') {
    const cfg2 = loadConfig();
    if (!cfg2.leased_node) {
      console.log(chalk.dim('No node is currently leased.'));
    } else {
      const prev = cfg2.leased_node.domain;
      releaseNode(cfg2);
      console.log(chalk.green(`✓ Released ${prev}`));
      console.log(chalk.dim('  Traffic returns to automatic node selection.'));
    }
    return;
  }

  console.error(chalk.red(`Unknown ip subcommand: ${sub ?? '(none)'}`));
  console.error(chalk.dim('  consensus ip list [--region X]'));
  console.error(chalk.dim('  consensus ip lease <node-id-or-domain>'));
  console.error(chalk.dim('  consensus ip active'));
  console.error(chalk.dim('  consensus ip release'));
  process.exit(1);
}
