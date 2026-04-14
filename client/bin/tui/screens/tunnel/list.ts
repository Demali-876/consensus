import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../../../theme';
import { scanAll, SPINNER, type ScannedPort } from '../../../lib/ports.ts';

const MAX_SHOWN = 8;

export async function showTunnels(): Promise<'back'> {
  // ── Initial scan phase ────────────────────────────────────────────────────────
  const scanRenderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  scanRenderer.start();

  const scanRoot = scanRenderer.root;
  scanRoot.flexDirection = 'column';
  scanRoot.padding = 0;

  const scanTop = new BoxRenderable(scanRenderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  scanTop.add(new TextRenderable(scanRenderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  scanTop.add(new TextRenderable(scanRenderer, { content: 'TUNNELS',   fg: C.slate, bg: C.panel }));
  scanRoot.add(scanTop);

  const scanContent = new BoxRenderable(scanRenderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 2, backgroundColor: C.dark,
  });
  scanRoot.add(scanContent);

  const spinRef = new TextRenderable(scanRenderer, {
    content: `${SPINNER[0]}  Scanning local ports…`, fg: C.slate, bg: C.dark,
  });
  scanContent.add(spinRef);

  let spinIdx = 0;
  const spinTimer = setInterval(() => {
    spinIdx = (spinIdx + 1) % SPINNER.length;
    spinRef.content = `${SPINNER[spinIdx]}  Scanning local ports…`;
  }, 150);

  let allResults = await scanAll();
  clearInterval(spinTimer);
  scanRenderer.destroy();

  // ── Main screen ───────────────────────────────────────────────────────────────
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'TUNNELS',   fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 2, backgroundColor: C.dark,
  });
  root.add(content);

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const hintsRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.panel });
  bottomBar.add(hintsRef);
  bottomBar.add(new TextRenderable(renderer, { content: 'TUNNELS', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  const ln = (text: string, fg = C.slate): TextRenderable => {
    const t = new TextRenderable(renderer, { content: text || ' ', fg, bg: C.dark });
    content.add(t);
    return t;
  };

  // ACTIVE TUNNELS section
  ln('ACTIVE  ' + '─'.repeat(44), C.dim);
  ln(' ');
  ln('  (no active tunnels)', C.dim);
  ln(' ');

  // DETECTED section — pre-allocated rows updated in-place
  const detectedHeader = ln('DETECTED  ' + '─'.repeat(42), C.dim);
  ln(' ');
  const scanStatusRef = ln('', C.dim);
  ln(' ');
  const portRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_SHOWN; i++) portRows.push(ln(''));
  ln(' ');

  ln('NEW TUNNEL  ' + '─'.repeat(40), C.dim);
  ln(' ');
  ln('  N   HTTP tunnel    expose an HTTP server to a public URL',  C.dim);
  ln('  T   TCP tunnel     expose any TCP server to a public port', C.dim);

  // ── State ─────────────────────────────────────────────────────────────────────
  let showAll  = false;
  let scanning = false;

  function renderHints(): void {
    const visible = visibleResults();
    const numShortcut = visible.length > 0 ? `[1-${visible.length}  tunnel]  ` : '';
    const allToggle   = showAll ? '[A  dev only]' : '[A  show all]';
    hintsRef.content  = `${numShortcut}[R  rescan]  ${allToggle}  [N  new]  [B  back]`;
  }

  function visibleResults(): ScannedPort[] {
    const filtered = showAll ? allResults : allResults.filter(s => !s.isSystem);
    return filtered.slice(0, MAX_SHOWN);
  }

  function renderDetected(): void {
    const visible  = visibleResults();
    const devCount = allResults.filter(s => !s.isSystem).length;
    const sysCount = allResults.length - devCount;

    detectedHeader.content = 'DETECTED  ' + '─'.repeat(42);

    if (allResults.length === 0) {
      scanStatusRef.content = '  (none detected)';
      scanStatusRef.fg      = C.dim;
    } else if (showAll && sysCount > 0) {
      scanStatusRef.content = `  showing all — ${sysCount} system service${sysCount === 1 ? '' : 's'} included`;
      scanStatusRef.fg      = C.dim;
    } else if (!showAll && sysCount > 0) {
      scanStatusRef.content = `  ${sysCount} system service${sysCount === 1 ? '' : 's'} hidden  [A show all]`;
      scanStatusRef.fg      = C.dim;
    } else {
      scanStatusRef.content = '';
    }

    for (let i = 0; i < MAX_SHOWN; i++) {
      const s = visible[i];
      if (!s) { portRows[i]!.content = ''; continue; }
      const port    = `localhost:${s.port}`.padEnd(20);
      const label   = s.label.padEnd(14);
      const sysTag  = s.isSystem ? '  (system)' : '';
      portRows[i]!.content = `  ${i + 1}  ${port}  ${label}${sysTag}`;
      portRows[i]!.fg      = s.isSystem ? C.dim : (s.kind === 'http' ? C.slate : C.amber);
    }

    renderHints();
  }

  async function rescan(): Promise<void> {
    if (scanning) return;
    scanning = true;

    // Show spinner in the status row, clear port rows.
    for (let i = 0; i < MAX_SHOWN; i++) portRows[i]!.content = '';
    scanStatusRef.content = `  ${SPINNER[0]}  scanning…`;
    scanStatusRef.fg      = C.slate;

    let si = 0;
    const t = setInterval(() => {
      si = (si + 1) % SPINNER.length;
      scanStatusRef.content = `  ${SPINNER[si]}  scanning…`;
    }, 150);

    allResults = await scanAll();
    clearInterval(t);
    scanning = false;
    renderDetected();
  }

  renderDetected();

  // ── Input ─────────────────────────────────────────────────────────────────────
  return new Promise<'back'>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.ctrl && key.name === 'c')              { renderer.destroy(); resolve('back'); return; }
      if (key.name === 'b' || key.name === 'B')      { renderer.destroy(); resolve('back'); return; }
      if (key.name === 'r' || key.name === 'R')      { rescan(); return; }
      if (key.name === 'a' || key.name === 'A')      { showAll = !showAll; renderDetected(); return; }

      // Number shortcut — quick-select a detected server.
      const num = parseInt(key.name ?? '');
      if (!isNaN(num) && num >= 1 && num <= visibleResults().length) {
        // TODO: open tunnel-setup form pre-filled with visibleResults()[num-1]
        return;
      }

      if (key.name === 'n' || key.name === 'N') { /* TODO: HTTP tunnel setup */ }
      if (key.name === 't' || key.name === 'T') { /* TODO: TCP tunnel setup  */ }
    });
  });
}
