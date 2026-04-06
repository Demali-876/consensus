import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../theme';
import { writeTraceLog } from '../lib/crash-log';
import { type FieldDef, type FormState, renderField, handleKey } from '../lib/form.ts';
import { chooseDefaultPort, REVERSE_PROXY_PORT_CANDIDATES, scanPorts, HTTP_PORTS, SPINNER } from '../lib/ports.ts';
import type { PreferNetwork } from '../../src/payment-fetch.js';
import { NETWORK_CAIP2S, NETWORK_LABELS } from '../lib/networks.ts';

export type ReverseSetupResult = {
  upstream:       { host: string; port: number; protocol: 'http' | 'https' };
  listenPort:     number;
  cacheTtl:       number;   // ms
  cacheMaxSize:   number;
  preferNetwork?: PreferNetwork;
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
  const defaultListenPort = chooseDefaultPort(openPorts, REVERSE_PROXY_PORT_CANDIDATES, 8081);

  const fields: FieldDef[] = [
    { id: 'host',       label: 'Host',        hint: 'upstream host',         type: 'text',   value: firstPort ? 'localhost' : '' },
    { id: 'port',       label: 'Port',        hint: 'upstream port',         type: 'text',   value: firstPort ? String(firstPort) : '' },
    { id: 'protocol',   label: 'Protocol',    hint: 'http / https',          type: 'toggle', value: 'http', options: ['http', 'https'] },
    { id: 'listenPort', label: 'Listen port', hint: 'local proxy bind port', type: 'text',   value: String(defaultListenPort) },
    { id: 'cacheTtl',   label: 'Cache TTL',   hint: 'seconds, 0 = off',      type: 'text',   value: '30' },
    { id: 'maxSize',    label: 'Max entries', hint: 'max cached responses',   type: 'text',   value: '1000' },
    { id: 'network', label: 'Pay network', hint: '←/→ or ↵ to select', type: 'toggle',
      value: '', options: NETWORK_CAIP2S, optionLabels: NETWORK_LABELS },
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
  ln(' ');

  // NETWORK section
  ln('NETWORK  ' + '─'.repeat(43), C.dim);
  ln(' ');
  fields[6]!.ref = ln('');   // Pay network

  // DETECTED state
  let detectedPorts = openPorts;
  let scanning      = false;
  let live          = true;

  function renderDetected(): void {
    if (!live) return;
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
      if (!live) { clearInterval(t); return; }
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
      : `${shortcut}[R  rescan]  [↑↓  navigate]  [↵/←/→  edit·toggle]  [S  start]  [B  back]`;
  }

  renderAll();

  function collect(): ReverseSetupResult {
    const get = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    const ttlSec = parseInt(get('cacheTtl') || '0', 10);
    const net    = get('network');
    return {
      upstream: {
        host:     get('host')     || 'localhost',
        port:     parseInt(get('port') || '3000', 10),
        protocol: get('protocol') as 'http' | 'https',
      },
      listenPort:     (() => {
        const listenPort = parseInt(get('listenPort'), 10);
        return !isNaN(listenPort) && listenPort > 0 ? listenPort : defaultListenPort;
      })(),
      cacheTtl:       (isNaN(ttlSec) ? 30 : ttlSec) * 1000,
      cacheMaxSize:   parseInt(get('maxSize') || '1000', 10),
      preferNetwork:  net !== '' ? net as PreferNetwork : undefined,
    };
  }

  const done = (result: ReverseSetupResult | null) => {
    writeTraceLog('reverseSetup.done', { result });
    live = false;
    renderer.destroy();
    return result;
  };

  return new Promise<ReverseSetupResult | null>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;
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
      if (action === 'start') {
        writeTraceLog('reverseSetup.action', { action, key: key.name });
        resolve(done(collect()));
      }
      if (action === 'back')  {
        writeTraceLog('reverseSetup.action', { action, key: key.name });
        resolve(done(null));
      }
    });
  });
}
