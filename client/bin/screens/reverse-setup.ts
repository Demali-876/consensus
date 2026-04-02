import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../theme';
import { type FieldDef, type FormState, renderField, handleKey } from '../lib/form.ts';
import { scanPorts, HTTP_PORTS, SPINNER } from '../lib/ports.ts';

export type ReverseSetupResult = {
  upstream:     { host: string; port: number; protocol: 'http' | 'https' };
  listenPort:   number;
  cacheTtl:     number;   // ms
  cacheMaxSize: number;
};

const MAX_SHOWN = 5;

export async function showReverseSetup(): Promise<ReverseSetupResult | null> {
  // ── Port scan phase ──────────────────────────────────────────────────────────
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
  scanTop.add(new TextRenderable(scanRenderer, { content: 'CONSENSUS',     fg: C.white, bg: C.panel }));
  scanTop.add(new TextRenderable(scanRenderer, { content: 'REVERSE PROXY', fg: C.slate, bg: C.panel }));
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
  }, 200);

  const openPorts = await scanPorts(HTTP_PORTS);
  clearInterval(spinTimer);
  scanRenderer.destroy();

  // ── Form phase ────────────────────────────────────────────────────────────────
  const firstPort = openPorts[0];

  const fields: FieldDef[] = [
    { id: 'host',       label: 'Host',        hint: 'upstream host',         type: 'text',   value: firstPort ? 'localhost' : '' },
    { id: 'port',       label: 'Port',        hint: 'upstream port',         type: 'text',   value: firstPort ? String(firstPort) : '' },
    { id: 'protocol',   label: 'Protocol',    hint: 'http / https',          type: 'toggle', value: 'http', options: ['http', 'https'] },
    { id: 'listenPort', label: 'Listen port', hint: '0 = auto-assign',       type: 'text',   value: '0' },
    { id: 'cacheTtl',   label: 'Cache TTL',   hint: 'seconds, 0 = off',      type: 'text',   value: '30' },
    { id: 'maxSize',    label: 'Max entries', hint: 'max cached responses',   type: 'text',   value: '1000' },
  ];

  const state: FormState = { cursor: 0, editing: false, editBuf: '' };

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
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS',     fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'REVERSE PROXY SETUP', fg: C.slate, bg: C.panel }));
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
  bottomBar.add(new TextRenderable(renderer, { content: 'REVERSE PROXY SETUP', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  const ln = (text: string, fg = C.slate): TextRenderable => {
    const t = new TextRenderable(renderer, { content: text || ' ', fg, bg: C.dark });
    content.add(t);
    return t;
  };

  // DETECTED section
  ln('DETECTED  ' + '─'.repeat(42), C.dim);
  ln(' ');
  const detectedRefs: TextRenderable[] = [];
  for (let i = 0; i < MAX_SHOWN; i++) {
    detectedRefs.push(ln(' '));
  }
  ln(' ');

  // UPSTREAM section
  ln('UPSTREAM  ' + '─'.repeat(42), C.dim);
  ln(' ');
  fields[0]!.ref = ln('');   // Host
  fields[1]!.ref = ln('');   // Port
  fields[2]!.ref = ln('');   // Protocol
  ln(' ');

  // PROXY section
  ln('PROXY  ' + '─'.repeat(45), C.dim);
  ln(' ');
  fields[3]!.ref = ln('');   // Listen port
  ln(' ');

  // CACHE section
  ln('CACHE  ' + '─'.repeat(45), C.dim);
  ln(' ');
  fields[4]!.ref = ln('');   // Cache TTL
  fields[5]!.ref = ln('');   // Max entries

  // DETECTED state
  let detectedPorts = openPorts;
  let scanning      = false;

  function renderDetected(): void {
    const shown = detectedPorts.slice(0, MAX_SHOWN);
    for (let i = 0; i < MAX_SHOWN; i++) {
      if (shown[i] != null) {
        detectedRefs[i]!.content = `  ${i + 1}  localhost:${shown[i]}`;
        detectedRefs[i]!.fg      = C.slate;
      } else {
        detectedRefs[i]!.content = i === 0 && detectedPorts.length === 0 ? '  (none detected)' : ' ';
        detectedRefs[i]!.fg      = C.dim;
      }
    }
  }

  async function rescan(): Promise<void> {
    if (scanning) return;
    scanning = true;
    for (let i = 0; i < MAX_SHOWN; i++) detectedRefs[i]!.content = ' ';
    detectedRefs[0]!.content = `  ${SPINNER[0]}  scanning…`;
    detectedRefs[0]!.fg      = C.slate;
    let si = 0;
    const t = setInterval(() => {
      si = (si + 1) % SPINNER.length;
      detectedRefs[0]!.content = `  ${SPINNER[si]}  scanning…`;
    }, 150);
    detectedPorts = await scanPorts(HTTP_PORTS);
    clearInterval(t);
    scanning = false;
    renderDetected();
    renderAll();
  }

  renderDetected();

  function renderAll(): void {
    fields.forEach((f, i) => renderField(f, i, state));
    const shown    = detectedPorts.slice(0, MAX_SHOWN);
    const shortcut = shown.length > 0 ? `[1-${shown.length}  select]  ` : '';
    hintsRef.content = state.editing
      ? '[↵  confirm]  [esc  cancel]'
      : `${shortcut}[R  rescan]  [↑↓  navigate]  [↵  edit]  [S  start]  [B  back]`;
  }

  renderAll();

  function collect(): ReverseSetupResult {
    const get = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    const ttlSec = parseInt(get('cacheTtl') || '0', 10);
    return {
      upstream: {
        host:     get('host')     || 'localhost',
        port:     parseInt(get('port') || '3000', 10),
        protocol: get('protocol') as 'http' | 'https',
      },
      listenPort:   parseInt(get('listenPort') || '0', 10),
      cacheTtl:     (isNaN(ttlSec) ? 30 : ttlSec) * 1000,
      cacheMaxSize: parseInt(get('maxSize') || '1000', 10),
    };
  }

  return new Promise<ReverseSetupResult | null>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (!state.editing) {
        if (key.name === 'r' || key.name === 'R') { rescan(); return; }

        const shown = detectedPorts.slice(0, MAX_SHOWN);
        const num   = parseInt(key.name ?? '');
        if (!isNaN(num) && num >= 1 && num <= shown.length) {
          fields.find(f => f.id === 'host')!.value = 'localhost';
          fields.find(f => f.id === 'port')!.value = String(shown[num - 1]!);
          renderAll();
          return;
        }
      }

      const action = handleKey(key, fields, state, renderAll);
      if (action === 'start') { renderer.destroy(); resolve(collect()); }
      if (action === 'back')  { renderer.destroy(); resolve(null); }
    });
  });
}
