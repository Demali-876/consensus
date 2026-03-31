/**
 * Settings screen — displays current config (wallet, API key, leased node)
 */
import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../theme';
import { loadConfig } from '../lib/config.ts';

const TITLE = 'SETTINGS';

function mask(s: string, show = 6): string {
  if (!s || s.length <= show) return s;
  return s.slice(0, show) + '•'.repeat(Math.min(8, s.length - show));
}

export async function showSettings(): Promise<'back'> {
  const cfg = loadConfig();
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

  const add = (label: string, value: string, valueFg = C.slate) => {
    const row = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
    row.add(new TextRenderable(renderer, { content: label.padEnd(16), fg: C.dim, bg: 'transparent' }));
    row.add(new TextRenderable(renderer, { content: value, fg: valueFg, bg: 'transparent' }));
    content.add(row);
  };

  const addBlank = () => content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  content.add(new TextRenderable(renderer, { content: TITLE, fg: C.white, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: '─'.repeat(40), fg: C.dim, bg: C.dark }));
  addBlank();

  if (!cfg.api_key) {
    content.add(new TextRenderable(renderer, { content: 'Not set up. Run: consensus setup', fg: C.amber, bg: C.dark }));
  } else {
    add('Wallet name', cfg.wallet_name ?? '—');
    add('EVM address', cfg.addresses?.evm ?? '—');
    add('Solana addr', cfg.addresses?.solana ?? '—');
    add('API key', mask(cfg.api_key ?? ''));
    add('Proxy URL', cfg.x402_proxy_url ?? '—');
    add('Setup date', cfg.setup_date ? new Date(cfg.setup_date).toLocaleDateString() : '—');
    add('Version', cfg.version ?? '—');
    addBlank();

    if (lease) {
      content.add(new TextRenderable(renderer, { content: 'Leased node:', fg: C.dim, bg: C.dark }));
      add('  domain', lease.domain, C.cyan);
      if (lease.region)  add('  region', lease.region);
      if (lease.node_id) add('  node_id', mask(lease.node_id, 8));
      add('  leased at', new Date(lease.leased_at).toLocaleString());
    } else {
      content.add(new TextRenderable(renderer, { content: 'Leased node:    none', fg: C.dim, bg: C.dark }));
    }
  }

  root.add(content);

  const bottomBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  bottomBar.add(new TextRenderable(renderer, { content: '[B  back]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  return new Promise<'back'>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        renderer.destroy();
        resolve('back');
      }
    });
  });
}
