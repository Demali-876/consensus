/**
 * Main menu — two-pane layout.
 * Left sidebar: section list, ↑↓ / 1-6 to navigate.
 * Right panel: static detail per section (filler until each screen is built).
 * Bottom bar: keyboard hints + live server status.
 */

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
} from '@opentui/core';
import { C } from '../theme';

// ─── Sections ────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'tunnels',       label: 'Tunnels',       icon: '⇄' },
  { id: 'proxy',         label: 'Proxy',          icon: '⟳' },
  { id: 'reverse-proxy', label: 'Reverse-Proxy',  icon: '↩' },
  { id: 'websockets',    label: 'WebSockets',     icon: '⚡' },
  { id: 'ips',           label: 'IPs',            icon: '⬡' },
  { id: 'settings',      label: 'Settings',       icon: '⚙' },
] as const;

export type SectionId = typeof SECTIONS[number]['id'];

// ─── Detail text per section (filler) ────────────────────────────────────────

const DETAIL: Record<SectionId, string[]> = {
  'tunnels': [
    'Expose local HTTP servers or TCP devices to the internet.',
    '',
    '  N   new tunnel',
    '  ↵   open tunnel manager',
    '',
    'Subdomains are generated automatically:',
    '  rough-hawk.tunnel.canister.software',
  ],
  'proxy': [
    'Route HTTP requests through the x402 payment proxy.',
    '',
    '  ↵   open proxy dashboard',
    '',
    'Endpoint:',
    '  consensus.proxy.canister.software',
  ],
  'reverse-proxy': [
    'Forward public traffic to private upstream services.',
    '',
    '  N   add upstream',
    '  ↵   open reverse-proxy manager',
    '',
    'No upstreams configured yet.',
  ],
  'websockets': [
    'Manage persistent WebSocket sessions with x402 payment.',
    '',
    '  ↵   open WebSocket dashboard',
    '',
    'No active sessions.',
  ],
  'ips': [
    'Manage registered node IPs and their capabilities.',
    '',
    '  ↵   open IP manager',
    '',
    'No nodes registered yet.',
  ],
  'settings': [
    'Configure your Consensus environment.',
    '',
    '  Server    consensus.canister.software',
    '  Wallet    run "consensus setup" to configure',
    '',
    '  ↵   edit settings',
  ],
};

// ─── Server health ────────────────────────────────────────────────────────────

const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch { return false; }
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

export async function showMainMenu(): Promise<SectionId | 'quit'> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps:   15,
    useMouse:    false,
    useAlternateScreen: true,
  });

  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding       = 0;

  // ── Top bar ────────────────────────────────────────────────────────────────
  const topBar = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'row',
    justifyContent:  'space-between',
    paddingX:        2,
    paddingY:        0,
    backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'Main Menu',  fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // ── Body row ───────────────────────────────────────────────────────────────
  const body = new BoxRenderable(renderer, {
    width:           '100%',
    flexGrow:        1,
    flexDirection:   'row',
    backgroundColor: C.dark,
  });

  // Sidebar
  const sidebar = new BoxRenderable(renderer, {
    width:           24,
    flexDirection:   'column',
    paddingTop:      1,
    paddingLeft:     1,
    backgroundColor: C.dark,
  });

  const rows = SECTIONS.map((sec) =>
    new TextRenderable(renderer, { content: `  ${sec.label}`, fg: C.slate, bg: C.dark })
  );
  for (const row of rows) sidebar.add(row);

  // Vertical divider
  const divider = new BoxRenderable(renderer, {
    width:           1,
    height:          '100%',
    backgroundColor: C.dim,
  });

  // Detail panel
  const detail = new BoxRenderable(renderer, {
    flexGrow:        1,
    flexDirection:   'column',
    paddingX:        3,
    paddingTop:      1,
    backgroundColor: C.dark,
  });

  const detailTitle = new TextRenderable(renderer, {
    content: SECTIONS[0]!.label.toUpperCase(),
    fg:      C.white,
    bg:      C.dark,
  });
  const detailRule = new TextRenderable(renderer, {
    content: '─'.repeat(40),
    fg:      C.dim,
    bg:      C.dark,
  });
  const detailScroll = new ScrollBoxRenderable(renderer, {
    width:           '100%',
    flexGrow:        1,
    scrollY:         true,
    backgroundColor: 'transparent',
  });

  detail.add(detailTitle);
  detail.add(detailRule);
  detail.add(detailScroll);

  body.add(sidebar);
  body.add(divider);
  body.add(detail);
  root.add(body);

  // ── Bottom bar ─────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'row',
    justifyContent:  'space-between',
    paddingX:        2,
    paddingY:        0,
    backgroundColor: C.panel,
  });
  const hints = new TextRenderable(renderer, {
    content: '↑↓ / 1-6  navigate   ↵  open   Q  quit',
    fg:      C.slate,
    bg:      C.panel,
  });
  const serverStatus = new TextRenderable(renderer, {
    content: 'server  ◌  checking…',
    fg:      C.dim,
    bg:      C.panel,
  });
  bottomBar.add(hints);
  bottomBar.add(serverStatus);
  root.add(bottomBar);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function renderDetail(id: SectionId) {
    for (const child of [...detailScroll.getChildren()]) detailScroll.remove(child.id);
    for (const line of DETAIL[id]) {
      detailScroll.add(new TextRenderable(renderer, {
        content: line || ' ',
        fg:      line.startsWith('  ') ? C.slate : C.white,
        bg:      'transparent',
      }));
    }
  }

  let selectedIdx = 0;   // ← was missing — the navigation bug

  function select(idx: number) {
    selectedIdx = idx;
    for (let i = 0; i < rows.length; i++) {
      const sec = SECTIONS[i]!;
      rows[i]!.content = i === idx ? `▶ ${sec.label}` : `  ${sec.label}`;
      rows[i]!.fg      = i === idx ? C.white          : C.slate;
      rows[i]!.bg      = i === idx ? C.panel          : C.dark;
    }
    detailTitle.content = SECTIONS[idx]!.label.toUpperCase();
    renderDetail(SECTIONS[idx]!.id);
  }

  select(0);

  // Background health check
  checkHealth().then((ok) => {
    serverStatus.content = `server  ${ok ? '●' : '○'}  ${ok ? 'connected' : 'unreachable'}`;
    serverStatus.fg      = ok ? C.emerald : C.amber;
  });
  const healthTimer = setInterval(async () => {
    const ok = await checkHealth();
    serverStatus.content = `server  ${ok ? '●' : '○'}  ${ok ? 'connected' : 'unreachable'}`;
    serverStatus.fg      = ok ? C.emerald : C.amber;
  }, 30_000);

  // ── Input ──────────────────────────────────────────────────────────────────

  return new Promise<SectionId | 'quit'>((resolve) => {
    const done = (result: SectionId | 'quit') => {
      clearInterval(healthTimer);
      renderer.destroy();
      resolve(result);
    };

    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'up'   || key.name === 'k') { select((selectedIdx - 1 + SECTIONS.length) % SECTIONS.length); return; }
      if (key.name === 'down' || key.name === 'j') { select((selectedIdx + 1) % SECTIONS.length); return; }
      if (key.name === 'return' || key.name === 'enter') { done(SECTIONS[selectedIdx]!.id); return; }
      if (key.name === 'q' || key.name === 'Q' || (key.ctrl && key.name === 'c')) { done('quit'); return; }

      const num = parseInt(key.name ?? '');
      if (!isNaN(num) && num >= 1 && num <= SECTIONS.length) select(num - 1);
    });
  });
}
