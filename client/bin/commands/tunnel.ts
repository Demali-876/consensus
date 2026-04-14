/**
 * tunnel-cmd.ts — `consensus tunnel` command handler.
 * Subcommands: http, tcp
 */

import chalk           from 'chalk';
import { runTunnel }   from '../tui/screens/tunnel/live';

export async function runTunnelCommand(args: string[]): Promise<void> {
  const [tunnelType, tunnelTarget] = args as [string | undefined, string | undefined];
  const isInternal = args.includes('--internal');

  if (!tunnelType || !['http', 'tcp'].includes(tunnelType)) {
    console.error(chalk.red('Usage: consensus tunnel <http|tcp> <host[:port]>'));
    console.error(chalk.dim('  consensus tunnel http 192.168.1.101'));
    console.error(chalk.dim('  consensus tunnel http 192.168.1.101:3000'));
    console.error(chalk.dim('  consensus tunnel tcp  192.168.1.101:1883'));
    process.exit(1);
  }

  if (!tunnelTarget) {
    console.error(chalk.red(`Usage: consensus tunnel ${tunnelType} <host[:port]>`));
    process.exit(1);
  }

  // On macOS, open a new Terminal window so the tunnel has a visible session.
  if (!isInternal && process.platform === 'darwin') {
    const bunBin    = Bun.which('bun') ?? `${process.env.HOME}/.bun/bin/bun`;
    const self      = import.meta.path;
    const tmpScript = `/tmp/consensus-tunnel-${Date.now()}.sh`;

    await Bun.write(tmpScript, [
      '#!/bin/bash',
      `export PATH="$HOME/.bun/bin:$PATH"`,
      `cd '${process.cwd()}'`,
      `exec '${bunBin}' '${self.replace('commands/tunnel-cmd.ts', 'consensus.ts')}' tunnel ${tunnelType} ${tunnelTarget} --internal`,
    ].join('\n'));

    Bun.spawnSync(['chmod', '+x', tmpScript]);
    Bun.spawnSync(['osascript', '-e', `tell application "Terminal"\n  do script "bash '${tmpScript}'"\n  activate\nend tell`]);
    console.log(chalk.green('✓') + chalk.dim(` Tunnel opening — ${tunnelType.toUpperCase()} → ${tunnelTarget}`));
    return;
  }

  await runTunnel(tunnelType as 'http' | 'tcp', tunnelTarget);
}
