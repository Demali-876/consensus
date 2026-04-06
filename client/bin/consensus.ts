#!/usr/bin/env bun

import { showLanding }        from './screens/landing';
import { showTunnels }        from './screens/tunnels';
import { showProxy }          from './screens/proxy';
import { showWebsockets }     from './screens/websockets';
import { showIps }            from './screens/ips';
import { showSettings }       from './screens/settings';
import { ConsensusSDK }       from './lib/setup';
import { runTunnelCommand }   from './commands/tunnel-cmd';
import { runProxyCommand }    from './commands/proxy-cmd';
import { runWsCommand }       from './commands/ws-cmd';
import { runIpCommand }       from './commands/ip-cmd';
import { installProcessLogCapture, writeCrashLog, writeTraceLog } from './lib/crash-log';
import chalk                  from 'chalk';

const processLogPath = installProcessLogCapture();

// ─── TUI navigation ───────────────────────────────────────────────────────────

async function runTui(): Promise<void> {
  writeTraceLog('runTui.enter');
  const goTo = async (section: string) => {
    writeTraceLog('runTui.goTo', { section });
    if      (section === 'tunnels')       await showTunnels();
    else if (section === 'proxy')         await showProxy();
    else if (section === 'proxy-forward') await showProxy('forward');
    else if (section === 'proxy-reverse') await showProxy('reverse');
    else if (section === 'proxy-manage')  await showProxy();
    else if (section === 'websockets')    await showWebsockets();
    else if (section === 'ips')           await showIps();
    else if (section === 'settings')      await showSettings();
  };

  let next = await showLanding();
  writeTraceLog('runTui.afterLanding', { next });
  while (next !== 'quit') {
    await goTo(next);
    next = await showLanding();
    writeTraceLog('runTui.afterLanding', { next });
  }
  writeTraceLog('runTui.exit', { next });
}

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

process.on('uncaughtException', (err) => {
  reportFatal('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  reportFatal('unhandledRejection', err);
  process.exit(1);
});

main().catch((err: Error) => {
  reportFatal('main.catch', err);
  process.exit(1);
});
