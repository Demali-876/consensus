import inquirer from 'inquirer';
import chalk    from 'chalk';
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
} from '@opentui/core';
import { C } from '../../theme';
import { loadConfig, makeFetchWithPayment, fmtUsd } from '../../lib/config.ts';
import { getWsToken, connectWs, quoteWs } from '../../lib/websockets.ts';
import type { WsModel } from '../../lib/websockets.ts';

const TITLE = 'WEBSOCKETS';

// ─── Menu screen ─────────────────────────────────────────────────────────────

async function showMenu(): Promise<'token' | 'connect' | 'back'> {
  const cfg   = loadConfig();
  const lease = cfg.leased_node;

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
    add(`Leased node: ${lease.domain}`, C.cyan);
    add(' ');
  }

  add('[1]  Get token', C.slate);
  add('     Obtain a WebSocket session token (useful for scripting)', C.dim);
  add(' ');
  add('[2]  Connect session', C.slate);
  add('     Open an interactive WebSocket relay — stdin → ws, ws → stdout', C.dim);
  add(' ');
  add('[B]  Back', C.dim);

  root.add(content);

  const bottomBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  bottomBar.add(new TextRenderable(renderer, { content: '[1  token]  [2  connect]  [B  back]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  return new Promise<'token' | 'connect' | 'back'>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === '1') { renderer.destroy(); resolve('token'); }
      if (key.name === '2') { renderer.destroy(); resolve('connect'); }
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        renderer.destroy();
        resolve('back');
      }
    });
  });
}

// ─── Shared prompt for model/minutes/megabytes ────────────────────────────────

async function promptSessionParams(): Promise<{ model: WsModel; minutes: number; megabytes: number }> {
  return inquirer.prompt<{ model: WsModel; minutes: number; megabytes: number }>([
    {
      type: 'list',
      name: 'model',
      message: 'Billing model:',
      choices: [
        { name: 'hybrid  ($0.0005/min + $0.0001/MB)', value: 'hybrid' },
        { name: 'time    ($0.001/min)',                value: 'time'   },
        { name: 'data    ($0.00012/MB)',               value: 'data'   },
      ],
      default: 'hybrid',
    },
    {
      type: 'number',
      name: 'minutes',
      message: 'Session duration (minutes):',
      default: 5,
    },
    {
      type: 'number',
      name: 'megabytes',
      message: 'Data allowance (MB):',
      default: 50,
    },
  ]);
}

// ─── Get-token flow ───────────────────────────────────────────────────────────

async function runTokenFlow(): Promise<void> {
  const { model, minutes, megabytes } = await promptSessionParams();
  const cfg     = loadConfig();
  const fetchFn = makeFetchWithPayment(cfg.api_key ?? '');
  const lease   = cfg.leased_node;

  console.log(chalk.dim(`\n  model: ${model}  minutes: ${minutes}  MB: ${megabytes}  cost: ${fmtUsd(quoteWs(model, minutes, megabytes))}`));
  if (lease) console.log(chalk.dim(`  node: ${lease.domain} (leased)`));

  try {
    const auth = await getWsToken({ fetchFn, config: cfg, model, minutes, megabytes });
    console.log('\n' + chalk.green('✓ Token obtained'));
    console.log(`  ${chalk.dim('token:      ')} ${auth.token}`);
    console.log(`  ${chalk.dim('connect_url:')} ${auth.connect_url}`);
    console.log(`  ${chalk.dim('expires_in: ')} ${auth.expires_in}s`);
  } catch (err) {
    console.error(chalk.red('\nError:'), (err as Error).message);
  }

  console.log(chalk.dim('\n  Press Enter to continue…'));
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
}

// ─── Connect-session flow ─────────────────────────────────────────────────────

async function runConnectFlow(): Promise<void> {
  const { model, minutes, megabytes } = await promptSessionParams();
  const cfg     = loadConfig();
  const fetchFn = makeFetchWithPayment(cfg.api_key ?? '');
  const lease   = cfg.leased_node;

  console.log(chalk.blue.bold('\nConsensus WebSocket'));
  console.log(chalk.dim(`  model: ${model}  minutes: ${minutes}  MB: ${megabytes}  cost: ${fmtUsd(quoteWs(model, minutes, megabytes))}`));
  if (lease) console.log(chalk.dim(`  node: ${lease.domain} (leased)`));
  console.log(chalk.dim('  Type to send messages. Ctrl+C to close.\n'));

  let ws: Awaited<ReturnType<typeof connectWs>> | null = null;

  try {
    ws = await connectWs({
      fetchFn,
      config:    cfg,
      model,
      minutes,
      megabytes,
      onOpen:    () => console.log(chalk.green('● connected')),
      onMessage: (data) => console.log(chalk.cyan('←'), data),
      onClose:   () => { console.log(chalk.dim('\n● session closed')); process.exit(0); },
      onError:   (e) => console.error(chalk.red('WS error:'), e),
    });
  } catch (err) {
    console.error(chalk.red('Connect error:'), (err as Error).message);
    return;
  }

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => ws?.send(chunk.replace(/\n$/, '')));
  process.on('SIGINT', () => { ws?.close(); process.exit(0); });

  await new Promise<void>(() => { /* runs until server closes or SIGINT */ });
}

// ─── Exported screen entry point ──────────────────────────────────────────────

export async function showWebsockets(): Promise<'back'> {
  while (true) {
    const choice = await showMenu();
    if (choice === 'back')    return 'back';
    if (choice === 'token')   await runTokenFlow();
    if (choice === 'connect') await runConnectFlow();
  }
}
