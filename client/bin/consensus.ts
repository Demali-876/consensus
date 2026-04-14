#!/usr/bin/env bun

import { runTui }            from './tui/navigator';
import { ConsensusSDK }      from './lib/setup';
import { runTunnelCommand }  from './commands/tunnel';
import { runProxyCommand }   from './commands/proxy';
import { runWsCommand }      from './commands/ws';
import { runIpCommand }      from './commands/ip';
import { installProcessLogCapture, writeCrashLog } from './lib/crash-log';
import chalk from 'chalk';

const processLogPath = installProcessLogCapture();

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) return runTui();

  const sdk = new ConsensusSDK();

  switch (command) {
    case 'setup':
      await sdk.setup();
      break;

    case 'tunnel':
      await runTunnelCommand(process.argv.slice(3));
      break;

    case 'proxy':
      await runProxyCommand(process.argv.slice(3));
      break;

    case 'reverse-proxy':
      // Alias: `consensus reverse-proxy <upstream>` → `consensus proxy reverse <upstream>`
      await runProxyCommand(['reverse', ...process.argv.slice(3)]);
      break;

    case 'ws':
      await runWsCommand(process.argv.slice(3));
      break;

    case 'ip':
      await runIpCommand(process.argv.slice(3));
      break;

    case 'help':
    case '--help':
    case '-h':
      sdk.showHelp();
      break;

    default:
      console.error(chalk.red(`Unknown command: ${command}`));
      sdk.showHelp();
      process.exit(1);
  }
}

function reportFatal(context: string, err: unknown): void {
  const logPath = writeCrashLog(context, err);
  console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
  console.error(chalk.dim(`Crash log: ${logPath}`));
  console.error(chalk.dim(`Process log: ${processLogPath}`));
}

process.on('uncaughtException',  (err) => { reportFatal('uncaughtException',  err); process.exit(1); });
process.on('unhandledRejection', (err) => { reportFatal('unhandledRejection', err); process.exit(1); });

main().catch((err: Error) => { reportFatal('main.catch', err); process.exit(1); });
