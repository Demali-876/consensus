/**
 * ws-cmd.ts — `consensus ws` command handler.
 * Subcommands: token, connect
 */

import chalk                                    from 'chalk';
import { loadConfig, makeFetchWithPayment,
         fmtUsd }                               from '../lib/config.ts';
import { getWsToken, connectWs, quoteWs }       from '../lib/websockets.ts';
import { getFlagValue }                         from '../lib/flags.ts';

export async function runWsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const cfg     = loadConfig();
  const fetchFn = makeFetchWithPayment(cfg.api_key ?? '');

  const model     = (getFlagValue(rest, '--model') ?? 'hybrid') as 'hybrid' | 'time' | 'data';
  const minutes   = Number(getFlagValue(rest, '--minutes')   ?? 5);
  const megabytes = Number(getFlagValue(rest, '--megabytes') ?? 50);
  const region    = getFlagValue(rest, '--region');

  // ── ws token ──────────────────────────────────────────────────────────────
  if (sub === 'token') {
    console.log(chalk.blue.bold('WebSocket Token'));
    console.log(chalk.dim(`  model: ${model}  minutes: ${minutes}  MB: ${megabytes}`));
    if (cfg.leased_node) console.log(chalk.dim(`  node: ${cfg.leased_node.domain} (leased)`));
    else if (region)     console.log(chalk.dim(`  region: ${region}`));
    console.log(chalk.dim(`  estimated cost: ${fmtUsd(quoteWs(model, minutes, megabytes))}\n`));

    try {
      const auth = await getWsToken({ fetchFn, config: cfg, model, minutes, megabytes, region });
      console.log(chalk.green('✓ Token obtained'));
      console.log(`  ${chalk.dim('token:      ')} ${auth.token}`);
      console.log(`  ${chalk.dim('connect_url:')} ${auth.connect_url}`);
      console.log(`  ${chalk.dim('expires_in: ')} ${auth.expires_in}s`);
    } catch (err) {
      console.error(chalk.red('Token error:'), (err as Error).message);
      process.exit(1);
    }
    return;
  }

  // ── ws connect ────────────────────────────────────────────────────────────
  if (sub === 'connect') {
    console.log(chalk.blue.bold('Consensus WebSocket'));
    console.log(chalk.dim(`  model: ${model}  minutes: ${minutes}  MB: ${megabytes}  cost: ${fmtUsd(quoteWs(model, minutes, megabytes))}`));
    if (cfg.leased_node) console.log(chalk.dim(`  node: ${cfg.leased_node.domain}`));
    console.log(chalk.dim('  Type to send messages, Ctrl+C to close.\n'));

    let session: Awaited<ReturnType<typeof connectWs>>;
    try {
      session = await connectWs({
        fetchFn, config: cfg, model, minutes, megabytes, region,
        onOpen:    () => console.log(chalk.green('● connected')),
        onMessage: (d) => console.log(chalk.cyan('←'), d),
        onClose:   () => console.log(chalk.dim('\n● session closed')),
        onError:   (e) => console.error(chalk.red('WS error:'), e),
      });
    } catch (err) {
      console.error(chalk.red('Connect error:'), (err as Error).message);
      process.exit(1);
    }

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => session.send(chunk.replace(/\n$/, '')));
    process.on('SIGINT', () => { session.close(); process.exit(0); });
    await new Promise<void>(() => { /* runs until SIGINT or server closes */ });
    return;
  }

  console.error(chalk.red(`Unknown ws subcommand: ${sub ?? '(none)'}`));
  console.error(chalk.dim('  consensus ws token   [--model hybrid|time|data] [--minutes 5] [--megabytes 50]'));
  console.error(chalk.dim('  consensus ws connect [--model hybrid|time|data] [--minutes 5] [--megabytes 50]'));
  process.exit(1);
}
