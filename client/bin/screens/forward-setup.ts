import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../theme';
import { loadConfig } from '../lib/config.ts';
import { writeTraceLog } from '../lib/crash-log';
import { type FieldDef, type FormState, renderField, handleKey } from '../lib/form.ts';
import { chooseDefaultPort, PROXY_PORT_CANDIDATES, scanPorts, HTTP_PORTS, SPINNER } from '../lib/ports.ts';
import type { PreferNetwork } from '../../src/payment-fetch.js';
import { NETWORK_CAIP2S, NETWORK_LABELS } from '../lib/networks.ts';

export type ForwardSetupResult = {
  appPort?:        number;
  appCommand?:     string;
  appCheckPath?:   string;
  autoLaunch?:     boolean;
  proxyPort?:      number;
  nodeRegion?:     string;
  nodeDomain?:     string;
  nodeExclude?:    string;
  routes?:         string[];
  mode?:           'inclusive' | 'exclusive';
  matchSubroutes?: boolean;
  cacheTtl?:       number;
  verbose?:        boolean;
  budget?:         number;
  preferNetwork?:  PreferNetwork;
};

const MAX_SHOWN = 5;

export async function showForwardSetup(): Promise<ForwardSetupResult | null> {
  // ── Scan phase ────────────────────────────────────────────────────────────────
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
  scanTop.add(new TextRenderable(scanRenderer, { content: 'CONSENSUS',      fg: C.white, bg: C.panel }));
  scanTop.add(new TextRenderable(scanRenderer, { content: 'FORWARD PROXY',  fg: C.slate, bg: C.panel }));
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

  const openPorts = await scanPorts(HTTP_PORTS);
  clearInterval(spinTimer);
  scanRenderer.destroy();

  // ── Form phase ────────────────────────────────────────────────────────────────
  const cfg     = loadConfig();
  const evmKey  = process.env.CONSENSUS_EVM_KEY;
  const svmKey  = process.env.CONSENSUS_SVM_KEY;
  const pemPath = process.env.CONSENSUS_PEM_PATH;
  const defaultProxyPort = chooseDefaultPort(openPorts, PROXY_PORT_CANDIDATES, 8080);

  const fields: FieldDef[] = [
    { id: 'appPort',        label: 'App port',        hint: 'service to protect with HTTP_PROXY', type: 'text',   value: openPorts[0] ? String(openPorts[0]) : '' },
    { id: 'appCommand',     label: 'App command',     hint: 'optional, e.g. bun run startproxyserver', type: 'text', value: '' },
    { id: 'appCheckPath',   label: 'Check path',      hint: '/health, /dataplease, /', type: 'text', value: '/' },
    { id: 'autoLaunch',     label: 'Auto restart',    hint: 'launch app and probe it after proxy starts', type: 'toggle', value: 'off', options: ['off', 'on'] },
    { id: 'proxyPort',      label: 'Proxy port',      hint: 'local proxy bind port',             type: 'text',   value: String(defaultProxyPort) },
    { id: 'nodeRegion',     label: 'Region',          hint: 'us-east / eu-west / auto',           type: 'text',   value: cfg.leased_node?.region ?? '' },
    { id: 'nodeDomain',     label: 'Domain',          hint: 'force specific node',                type: 'text',   value: cfg.leased_node?.domain ?? '' },
    { id: 'nodeExclude',    label: 'Exclude',         hint: 'skip this node',                     type: 'text',   value: '' },
    { id: 'routes',         label: 'Routes',          hint: '/api, /v2  (comma-sep)',             type: 'text',   value: '' },
    { id: 'mode',           label: 'Mode',            hint: 'only applies when routes set',       type: 'toggle', value: 'inclusive', options: ['inclusive', 'exclusive'] },
    { id: 'matchSubroutes', label: 'Match subroutes', hint: '/route also matches /route/*',       type: 'toggle', value: 'off',       options: ['off', 'on'] },
    { id: 'cacheTtl',       label: 'Cache TTL',       hint: 'seconds, 0 = off',                   type: 'text',   value: '0' },
    { id: 'verbose',        label: 'Verbose',         hint: 'include meta in responses',          type: 'toggle', value: 'off',       options: ['off', 'on'] },
    { id: 'budget',         label: 'Spend limit',     hint: 'USD, blank = unlimited',             type: 'text',   value: '' },
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
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS',           fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'FORWARD PROXY SETUP', fg: C.slate, bg: C.panel }));
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
  bottomBar.add(new TextRenderable(renderer, { content: 'FORWARD PROXY SETUP', fg: C.dim, bg: C.panel }));
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
  for (let i = 0; i < MAX_SHOWN; i++) detectedRefs.push(ln(' '));
  ln(' ');

  // APP section
  ln('APP  ' + '─'.repeat(47), C.dim);
  ln(' ');
  fields[0]!.ref = ln('');
  fields[1]!.ref = ln('');
  fields[2]!.ref = ln('');
  fields[3]!.ref = ln('');
  const appHintRef = ln('');
  const validationRef = ln('');
  ln(' ');

  // PROXY section
  ln('PROXY  ' + '─'.repeat(45), C.dim);
  ln(' ');
  fields[4]!.ref = ln('');
  ln(' ');

  ln('NODE  ' + '─'.repeat(46), C.dim);
  ln(' ');
  fields[5]!.ref = ln('');
  fields[6]!.ref = ln('');
  fields[7]!.ref = ln('');
  ln(' ');

  ln('ROUTING  ' + '─'.repeat(43), C.dim);
  ln(' ');
  fields[8]!.ref = ln('');
  fields[9]!.ref = ln('');
  fields[10]!.ref = ln('');
  ln(' ');

  ln('PERFORMANCE  ' + '─'.repeat(39), C.dim);
  ln(' ');
  fields[11]!.ref = ln('');
  fields[12]!.ref = ln('');
  ln(' ');

  ln('BUDGET  ' + '─'.repeat(44), C.dim);
  ln(' ');
  fields[13]!.ref = ln('');
  ln(' ');

  ln('NETWORK  ' + '─'.repeat(43), C.dim);
  ln(' ');
  fields[14]!.ref = ln('');
  ln(' ');

  ln('WALLET  ' + '─'.repeat(44), C.dim);
  ln(' ');
  const walletRef = ln('');

  // DETECTED state
  let detectedPorts = openPorts;
  let scanning      = false;
  let live          = true;
  let validationMessage = '';

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

  function renderWallet(): void {
    const found = [
      evmKey  && 'CONSENSUS_EVM_KEY ✓',
      svmKey  && 'CONSENSUS_SVM_KEY ✓',
      pemPath && 'CONSENSUS_PEM_PATH ✓',
    ].filter(Boolean) as string[];
    if (found.length === 0) {
      walletRef.content = '  ⚠   No wallet credentials detected — run: consensus setup';
      walletRef.fg = C.amber;
    } else {
      walletRef.content = `  ●   self-managed   ${found.join('   ')}`;
      walletRef.fg = C.emerald;
    }
  }

  function renderAll(): void {
    fields.forEach((f, i) => renderField(f, i, state));
    const appPort = fields.find(f => f.id === 'appPort')?.value.trim() ?? '';
    const appCommand = fields.find(f => f.id === 'appCommand')?.value.trim() ?? '';
    const autoLaunch = fields.find(f => f.id === 'autoLaunch')?.value === 'on';
    if (autoLaunch && !appCommand) {
      appHintRef.content = '  Auto restart needs an app command so the CLI knows what to relaunch';
      appHintRef.fg = C.amber;
    } else {
      appHintRef.content = appPort
        ? `  App on :${appPort}${appCommand ? (autoLaunch ? ' will relaunch automatically after startup' : ' can be relaunched from the dashboard') : ' should use the proxy env vars shown after startup'}`
        : '  Pick the app port you want to restart behind this proxy';
      appHintRef.fg = appPort ? C.dim : C.slate;
    }
    validationRef.content = validationMessage ? `  ✕   ${validationMessage}` : ' ';
    validationRef.fg = validationMessage ? C.red : C.dark;
    renderWallet();
    hintsRef.content = state.editing
      ? '[↵  confirm]  [esc  cancel]'
      : '[R  rescan]  [↑↓  navigate]  [↵/←/→  edit·toggle]  [S  start]  [B  back]';
  }

  renderAll();

  function collect(): ForwardSetupResult {
    const get = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    const result: ForwardSetupResult = {};
    const appPort = parseInt(get('appPort'), 10);
    if (!isNaN(appPort) && appPort > 0) result.appPort = appPort;
    if (get('appCommand')) result.appCommand = get('appCommand');
    if (get('appCheckPath')) result.appCheckPath = get('appCheckPath');
    if (get('autoLaunch') === 'on') result.autoLaunch = true;
    const proxyPort = parseInt(get('proxyPort'), 10);
    result.proxyPort = !isNaN(proxyPort) && proxyPort > 0 ? proxyPort : defaultProxyPort;
    if (get('nodeRegion'))  result.nodeRegion  = get('nodeRegion');
    if (get('nodeDomain'))  result.nodeDomain  = get('nodeDomain');
    if (get('nodeExclude')) result.nodeExclude = get('nodeExclude');
    if (get('routes')) {
      result.routes         = get('routes').split(',').map(r => r.trim()).filter(Boolean);
      result.mode           = get('mode') as 'inclusive' | 'exclusive';
      result.matchSubroutes = get('matchSubroutes') === 'on';
    }
    const ttl = parseInt(get('cacheTtl') || '0', 10);
    if (!isNaN(ttl) && ttl > 0) result.cacheTtl = ttl;
    if (get('verbose') === 'on') result.verbose = true;
    const b = parseFloat(get('budget'));
    if (!isNaN(b) && b > 0) result.budget = b;
    const net = get('network');
    if (net !== '') result.preferNetwork = net as PreferNetwork;
    return result;
  }

  const done = (result: ForwardSetupResult | null) => {
    writeTraceLog('forwardSetup.done', { result });
    live = false;
    renderer.destroy();
    return result;
  };

  function validateBeforeStart(): string | null {
    const get = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    if (get('autoLaunch') === 'on' && get('appCommand') === '') {
      return 'Auto restart requires an app command';
    }
    return null;
  }

  return new Promise<ForwardSetupResult | null>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;
      if (!state.editing) {
        if (key.name === 'r' || key.name === 'R') { rescan(); return; }
      }
      const action = handleKey(key, fields, state, renderAll);
      if (action === 'start') {
        const error = validateBeforeStart();
        if (error) {
          validationMessage = error;
          writeTraceLog('forwardSetup.validationError', { error });
          renderAll();
          return;
        }
        validationMessage = '';
        writeTraceLog('forwardSetup.action', { action, key: key.name });
        resolve(done(collect()));
      }
      if (action === 'back')  {
        validationMessage = '';
        writeTraceLog('forwardSetup.action', { action, key: key.name });
        resolve(done(null));
      }
      if (action === null && validationMessage) {
        validationMessage = '';
        renderAll();
      }
    });
  });
}
