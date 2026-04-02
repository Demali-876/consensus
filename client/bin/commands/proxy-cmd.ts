/**
 * proxy-cmd.ts — `consensus proxy` command handler.
 * Subcommands: fetch, start
 */

import chalk                                       from 'chalk';
import { loadConfig, makeFetchWithPayment,
         fmtUsd, fmtBytes, fmtUptime }            from '../lib/config.ts';
import { proxyFetch, startProxyDaemon }            from '../lib/proxy.ts';
import { getFlagValue, hasFlag }                   from '../lib/flags.ts';
import { dispatchProxy }                           from '../../src/proxy-worker.js';

export async function runProxyCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const cfg    = loadConfig();
  const fetchFn = makeFetchWithPayment(cfg.api_key ?? '');

  // ── proxy fetch ─────────────────────────────────────────────────────────────
  if (sub === 'fetch') {
    const targetUrl = rest.find((a) => !a.startsWith('-'));
    if (!targetUrl) {
      console.error(chalk.red('Usage: consensus proxy fetch <url> [--method GET] [--region X] [--cache-ttl N] [--verbose] [--json]'));
      process.exit(1);
    }

    const method   = getFlagValue(rest, '--method') ?? 'GET';
    const region   = getFlagValue(rest, '--region');
    const cacheTtl = getFlagValue(rest, '--cache-ttl') ? Number(getFlagValue(rest, '--cache-ttl')) : undefined;
    const verbose  = hasFlag(rest, '--verbose');
    const jsonOnly = hasFlag(rest, '--json');

    const extraHeaders: Record<string, string> = {};
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '--header' || rest[i] === '-H') {
        const [k, ...v] = rest[i + 1].split(':');
        if (k && v.length) extraHeaders[k.trim()] = v.join(':').trim();
      }
    }

    if (!jsonOnly) {
      console.log(chalk.dim(`→ ${method} ${targetUrl}`));
      if (cfg.leased_node) console.log(chalk.dim(`  node: ${cfg.leased_node.domain}`));
      else if (region)     console.log(chalk.dim(`  region: ${region}`));
    }

    try {
      const result = await proxyFetch({ fetchFn, config: cfg, targetUrl, method, headers: extraHeaders, region, cacheTtl, verbose });
      if (jsonOnly) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log((result.status < 400 ? chalk.green : chalk.red)(`${result.status} ${result.statusText}`));
        if (verbose && result.meta) console.log(chalk.dim('meta:'), JSON.stringify(result.meta));
        console.log(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2));
      }
    } catch (err) {
      console.error(chalk.red('Proxy error:'), (err as Error).message);
      process.exit(1);
    }
    return;
  }

  // ── proxy start ─────────────────────────────────────────────────────────────
  if (sub === 'start') {
    const port     = Number(getFlagValue(rest, '--port') ?? 8080);
    const budget   = getFlagValue(rest, '--budget') ? Number(getFlagValue(rest, '--budget')) : undefined;
    const region   = getFlagValue(rest, '--region');
    const cacheTtl = getFlagValue(rest, '--cache-ttl') ? Number(getFlagValue(rest, '--cache-ttl')) : undefined;

    console.log(chalk.blue.bold('Consensus Forward Proxy'));
    console.log(chalk.dim('─'.repeat(40)));
    console.log(`  Port:   ${chalk.white(port)}`);
    if (cfg.leased_node)         console.log(`  Node:   ${chalk.cyan(cfg.leased_node.domain)} ${chalk.dim('(leased)')}`);
    else if (region)             console.log(`  Region: ${chalk.white(region)}`);
    if (budget !== undefined)    console.log(`  Budget: ${chalk.white(fmtUsd(budget))}`);
    console.log(chalk.dim(`\nSet HTTP_PROXY=http://127.0.0.1:${port} in your client.\n`));

    const stats = { requests: 0, spend: 0, bytesSent: 0, bytesRecv: 0, startedAt: Date.now() };

    let daemon: Awaited<ReturnType<typeof startProxyDaemon>>;
    try {
      daemon = await startProxyDaemon({
        fetchFn, config: cfg, port, budget, region, cacheTtl,
        onStats: (s) => Object.assign(stats, s),
      });
    } catch (err) {
      console.error(chalk.red('Failed to start proxy:'), (err as Error).message);
      process.exit(1);
    }

    const tick = setInterval(() => {
      process.stdout.write(
        `\r  ${chalk.dim('req:')} ${chalk.white(stats.requests)}  ` +
        `${chalk.dim('spend:')} ${chalk.white(fmtUsd(stats.spend))}  ` +
        `${chalk.dim('sent:')} ${chalk.white(fmtBytes(stats.bytesSent))}  ` +
        `${chalk.dim('up:')} ${chalk.white(fmtUptime(stats.startedAt))}   `,
      );
    }, 1000);

    process.on('SIGINT', async () => {
      clearInterval(tick);
      console.log(chalk.dim('\n\nStopping proxy…'));
      await daemon.close();
      console.log(chalk.green('✓ Stopped'));
      process.exit(0);
    });

    await new Promise<void>(() => { /* runs until SIGINT */ });
    return;
  }

  // ── proxy reverse ────────────────────────────────────────────────────────────
  if (sub === 'reverse') {
    const upstreamArg = rest.find((a) => !a.startsWith('-'));
    if (!upstreamArg) {
      console.error(chalk.red('Usage: consensus proxy reverse <host:port> [--port N]'));
      console.error(chalk.dim('  Example: consensus proxy reverse localhost:3000 --port 8080'));
      process.exit(1);
    }

    const [upstreamHost, upstreamPortStr] = upstreamArg.split(':');
    const upstreamPort = parseInt(upstreamPortStr ?? '80', 10);
    if (!upstreamHost || isNaN(upstreamPort)) {
      console.error(chalk.red(`Invalid upstream "${upstreamArg}" — expected host:port`));
      process.exit(1);
    }

    const listenPort = getFlagValue(rest, '--port') ? Number(getFlagValue(rest, '--port')) : undefined;

    console.log(chalk.blue.bold('Consensus Reverse Proxy'));
    console.log(chalk.dim('─'.repeat(40)));
    console.log(`  Upstream: ${chalk.white(`${upstreamHost}:${upstreamPort}`)}`);
    if (listenPort) console.log(`  Listen:   ${chalk.white(listenPort)}`);
    console.log(chalk.dim('\n  Press Ctrl+C to stop\n'));

    let worker: Awaited<ReturnType<typeof dispatchProxy>>;
    try {
      worker = await dispatchProxy({
        type:     'reverse',
        upstream: { host: upstreamHost, port: upstreamPort },
        port:     listenPort,
      });
    } catch (err) {
      console.error(chalk.red('Failed to start reverse proxy:'), (err as Error).message);
      process.exit(1);
    }

    console.log(chalk.green(`✓ Listening on :${worker.port} → ${upstreamHost}:${upstreamPort}`));

    const tick = setInterval(() => {
      const s = worker.stats();
      process.stdout.write(
        `\r  ${chalk.dim('req:')} ${chalk.white(s.requests)}  ` +
        `${chalk.dim('hits:')} ${chalk.white(s.cacheHits)}  ` +
        `${chalk.dim('sent:')} ${chalk.white(fmtBytes(s.bytesSent))}  ` +
        `${chalk.dim('up:')} ${chalk.white(fmtUptime(Date.now() - s.uptime))}   `,
      );
    }, 1000);

    process.on('SIGINT', async () => {
      clearInterval(tick);
      console.log(chalk.dim('\n\nStopping…'));
      await worker.stop();
      console.log(chalk.green('✓ Stopped'));
      process.exit(0);
    });

    await new Promise<void>(() => { /* runs until SIGINT */ });
    return;
  }

  console.error(chalk.red(`Unknown proxy subcommand: ${sub ?? '(none)'}`));
  console.error(chalk.dim('  consensus proxy fetch <url>'));
  console.error(chalk.dim('  consensus proxy start   [--port N] [--budget N]'));
  console.error(chalk.dim('  consensus proxy reverse <host:port> [--port N]'));
  process.exit(1);
}
