import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { dirname }        from 'node:path';
import { C }              from '../../../theme';
import { loadConfig }     from '../../../lib/config.ts';
import { loadPrefs, loadBookmarks, saveBookmark, type Bookmark } from '../../../lib/store.ts';
import { writeTraceLog }  from '../../../lib/crash-log';
import { type FieldDef, type FormState, renderField, handleKey } from '../../../lib/form.ts';
import { scanPorts, HTTP_PORTS }  from '../../../lib/ports.ts';
import { makeSpin }               from '../../../lib/spinners.ts';
import { discoverAll, type DiscoveredProcess } from '../../../lib/discover.ts';
import { FilePicker }             from '../../../lib/file-picker.ts';
import type { PreferNetwork }     from '../../../../src/payment-fetch.js';
import { NETWORK_CAIP2S, NETWORK_LABELS } from '../../../lib/networks.ts';
import { isFreeMode }             from '../../../lib/server-config';

export type ForwardSetupResult = {
  appPort?:        number;
  appEntry?:       string;
  appCheckPath?:   string;
  autoLaunch?:     boolean;
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

const FIELD_DESC: Record<string, string> = {
  appPort:        'The port your local server listens on. Used to health-check your app and route traffic through it.',
  appEntry:       'Absolute path to the file Bun runs to start your app. Required for auto-restart. Press [space] to browse files.',
  appCheckPath:   'An HTTP path that returns 2xx when your app is healthy. Leave as / if unsure.',
  autoLaunch:     'After injecting the preload shim, kills the running process by PID and relaunches it with the preload applied.',
  nodeRegion:     'Prefer nodes in a specific region (us-east, eu-west). Leave blank for automatic selection.',
  nodeDomain:     'Pin all traffic to a specific node domain. Useful for testing a particular node.',
  nodeExclude:    'Skip a specific node domain. Useful if a node is misbehaving.',
  routes:         'Comma-separated path prefixes. Only these paths are routed through Consensus.',
  mode:           'Inclusive routes only the listed paths. Exclusive routes everything except them.',
  matchSubroutes: 'When on, /api also matches /api/users, /api/orders and any other sub-paths.',
  cacheTtl:       'How long to cache responses in seconds. 0 disables caching. Cached responses skip payment.',
  verbose:        'Adds Consensus metadata headers to every response. Useful for debugging proxied requests.',
  budget:         'Maximum USD to spend per session. Leave blank for unlimited.',
  network:        'Which blockchain network to use for payments. Defaults to the first available.',
};

export async function showForwardSetup(): Promise<ForwardSetupResult | null> {
  // ── Scan + discover phase ─────────────────────────────────────────────────────
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
  scanTop.add(new TextRenderable(scanRenderer, { content: 'FORWARD PROXY', fg: C.slate, bg: C.panel }));
  scanRoot.add(scanTop);

  const scanContent = new BoxRenderable(scanRenderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 2, backgroundColor: C.dark,
  });
  scanRoot.add(scanContent);

  const spin    = makeSpin('scan');
  const spinRef = new TextRenderable(scanRenderer, {
    content: `${spin()}  Scanning local ports…`, fg: C.slate, bg: C.dark,
  });
  scanContent.add(spinRef);

  const spinTimer = setInterval(() => {
    spinRef.content = `${spin()}  Scanning local ports…`;
  }, 120);

  const openPorts  = await scanPorts(HTTP_PORTS);
  spinRef.content  = `${spin()}  Resolving processes…`;
  const discovered = await discoverAll(openPorts);
  clearInterval(spinTimer);
  scanRenderer.destroy();

  // ── Form phase ────────────────────────────────────────────────────────────────
  const cfg      = loadConfig();
  const prefs    = loadPrefs();
  const evmKey   = process.env.CONSENSUS_EVM_KEY;
  const svmKey   = process.env.CONSENSUS_SVM_KEY;
  const pemPath  = process.env.CONSENSUS_PEM_PATH;
  const freeMode = await isFreeMode();

  // Pre-fill from first discovered process if available
  const firstDisc = discovered[0];

  const fields: FieldDef[] = [
    { id: 'appPort',        label: 'App port',        hint: 'port your server listens on',                     type: 'text',   value: firstDisc ? String(firstDisc.port) : (openPorts[0] ? String(openPorts[0]) : '') },
    { id: 'appEntry',       label: 'Entry file',      hint: 'absolute path — press [space] to browse',         type: 'text',   value: firstDisc?.entryFile ?? '' },
    { id: 'appCheckPath',   label: 'Check path',      hint: 'HTTP path that returns 2xx when healthy',         type: 'text',   value: '/' },
    { id: 'autoLaunch',     label: 'Auto relaunch',   hint: 'restart your app with the Consensus preload applied', type: 'toggle', value: 'off', options: ['off', 'on'] },
    { id: 'nodeRegion',     label: 'Region',          hint: 'us-east / eu-west / blank = auto',               type: 'text',   value: cfg.leased_node?.region ?? prefs.defaultRegion ?? '' },
    { id: 'nodeDomain',     label: 'Domain',          hint: 'pin to a specific node domain',                  type: 'text',   value: cfg.leased_node?.domain ?? '' },
    { id: 'nodeExclude',    label: 'Exclude',         hint: 'skip this node domain',                          type: 'text',   value: prefs.defaultExcludeNode ?? '' },
    { id: 'routes',         label: 'Routes',          hint: '/api, /v2  (comma-sep)',                         type: 'text',   value: '' },
    { id: 'mode',           label: 'Mode',            hint: 'inclusive = only listed  exclusive = all except', type: 'toggle', value: 'inclusive', options: ['inclusive', 'exclusive'] },
    { id: 'matchSubroutes', label: 'Match subroutes', hint: '/route also matches /route/*',                   type: 'toggle', value: 'off', options: ['off', 'on'] },
    { id: 'cacheTtl',       label: 'Cache TTL',       hint: 'seconds, 0 = off',                               type: 'text',   value: String(prefs.defaultCacheTtl) },
    { id: 'verbose',        label: 'Verbose',         hint: 'add Consensus metadata headers to responses',    type: 'toggle', value: prefs.defaultVerbose ? 'on' : 'off', options: ['off', 'on'] },
    ...(!freeMode ? [
      { id: 'budget',  label: 'Spend limit', hint: 'USD per session, blank = unlimited', type: 'text'   as const, value: prefs.defaultBudget != null ? String(prefs.defaultBudget) : '' },
      { id: 'network', label: 'Pay network', hint: '←/→ or ↵ to select',                type: 'toggle' as const,
        value: prefs.defaultNetwork ?? '', options: NETWORK_CAIP2S, optionLabels: NETWORK_LABELS },
    ] : []),
  ];

  const state: FormState = { cursor: 0, editing: false, editBuf: '' };
  let bmList = loadBookmarks().filter(b => b.type === 'proxy-forward');
  let bmMode = false;
  const MAX_BM = 5;

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

  // ── Bottom bar ────────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'column',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const descRef  = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.panel });
  const hintsRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.panel });
  bottomBar.add(descRef);
  bottomBar.add(hintsRef);
  root.add(bottomBar);

  const ln = (text: string, fg = C.slate): TextRenderable => {
    const t = new TextRenderable(renderer, { content: text || ' ', fg, bg: C.dark });
    content.add(t);
    return t;
  };

  // ── DETECTED table ────────────────────────────────────────────────────────────
  ln('DETECTED  ' + '─'.repeat(42), C.dim);
  ln(' ');
  const COL = { pid: 8, port: 6, svc: 10 };
  const detectedHeader = ln(
    '  ' +
    'PID'.padEnd(COL.pid) +
    'PORT'.padEnd(COL.port) +
    'SERVICE'.padEnd(COL.svc) +
    'ENTRY FILE',
    C.dim,
  );
  const detectedSep    = ln('  ' + '─'.repeat(52), C.dim);
  const detectedRefs: TextRenderable[] = [];
  for (let i = 0; i < MAX_SHOWN; i++) detectedRefs.push(ln(' '));
  ln(' ');

  // ── BOOKMARKS section ─────────────────────────────────────────────────────────
  const bmHeaderRef = ln('', C.dim);
  const bmRefs: TextRenderable[] = [];
  for (let i = 0; i < MAX_BM; i++) bmRefs.push(ln(' ', C.dim));
  ln(' ');

  // ── APP section ───────────────────────────────────────────────────────────────
  ln('APP  ' + '─'.repeat(47), C.dim);
  ln(' ');
  ln(`  cwd  ${process.cwd()}`, C.dim);
  ln(' ');
  fields[0]!.ref = ln('');
  fields[1]!.ref = ln('');
  // File picker is inserted dynamically between fields[1] and fields[2]
  fields[2]!.ref = ln('');
  fields[3]!.ref = ln('');
  const validationRef = ln('');
  ln(' ');

  ln('NODE  ' + '─'.repeat(46), C.dim);
  ln(' ');
  fields[4]!.ref = ln('');
  fields[5]!.ref = ln('');
  fields[6]!.ref = ln('');
  ln(' ');

  ln('ROUTING  ' + '─'.repeat(43), C.dim);
  ln(' ');
  fields[7]!.ref  = ln('');
  fields[8]!.ref  = ln('');
  fields[9]!.ref  = ln('');
  ln(' ');

  ln('PERFORMANCE  ' + '─'.repeat(39), C.dim);
  ln(' ');
  fields[10]!.ref = ln('');
  fields[11]!.ref = ln('');
  ln(' ');

  if (!freeMode) {
    ln('BUDGET  ' + '─'.repeat(44), C.dim);
    ln(' ');
    fields[12]!.ref = ln('');
    ln(' ');
    ln('NETWORK  ' + '─'.repeat(43), C.dim);
    ln(' ');
    fields[13]!.ref = ln('');
    ln(' ');
  }

  ln('WALLET  ' + '─'.repeat(44), C.dim);
  ln(' ');
  const walletRef = ln('');

  // ── File picker ───────────────────────────────────────────────────────────────
  const picker        = new FilePicker(renderer);
  let   pickerAdded   = false;

  function openPicker(): void {
    const entryVal  = fields[1]!.value.trim();
    const startDir  = entryVal ? dirname(entryVal) : process.cwd();
    picker.open(startDir);
    if (!pickerAdded) {
      // Insert picker container after Entry file row, before Check path row
      content.insertBefore(picker.container, fields[2]!.ref!);
      pickerAdded = true;
    }
  }

  function closePicker(): void {
    picker.close();
    if (pickerAdded) {
      content.remove('file-picker');
      pickerAdded = false;
    }
  }

  // ── Detected state ────────────────────────────────────────────────────────────
  let detectedPorts = openPorts;
  let detectedProcs = discovered;
  let scanning      = false;
  let live          = true;
  let validationMessage = '';

  function renderDetected(): void {
    if (!live) return;
    if (detectedPorts.length === 0) {
      detectedHeader.content = '  (none detected)';
      detectedHeader.fg      = C.dim;
      detectedSep.content    = ' ';
      for (let i = 0; i < MAX_SHOWN; i++) detectedRefs[i]!.content = ' ';
      return;
    }
    detectedHeader.content =
      '  ' +
      'PID'.padEnd(COL.pid) +
      'PORT'.padEnd(COL.port) +
      'SERVICE'.padEnd(COL.svc) +
      'ENTRY FILE';
    detectedHeader.fg   = C.dim;
    detectedSep.content = '  ' + '─'.repeat(52);
    detectedSep.fg      = C.dim;

    for (let i = 0; i < MAX_SHOWN; i++) {
      const port = detectedPorts[i];
      if (port == null) { detectedRefs[i]!.content = ' '; continue; }
      const proc    = detectedProcs.find(p => p.port === port);
      const pid     = proc ? String(proc.pid)     : '—';
      const svc     = proc ? proc.service         : 'unknown';
      const entry   = proc?.entryFile ?? '—';
      const maxEntry = 36;
      const entryDisplay = entry.length > maxEntry ? '…' + entry.slice(-(maxEntry - 1)) : entry;
      detectedRefs[i]!.content =
        `  ${String(i + 1)} ` +
        pid.padEnd(COL.pid - 2) +
        String(port).padEnd(COL.port) +
        svc.padEnd(COL.svc) +
        entryDisplay;
      detectedRefs[i]!.fg = C.slate;
    }
  }

  async function rescan(): Promise<void> {
    if (scanning) return;
    scanning = true;
    detectedHeader.content = `  scanning…`;
    detectedHeader.fg      = C.slate;
    detectedSep.content    = ' ';
    for (let i = 0; i < MAX_SHOWN; i++) detectedRefs[i]!.content = ' ';
    detectedPorts = await scanPorts(HTTP_PORTS);
    detectedProcs = await discoverAll(detectedPorts);
    scanning = false;
    renderDetected();
    renderAll();
  }

  renderDetected();

  function fmtAge(ts: number): string {
    const d = Date.now() - ts;
    if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
    return `${Math.floor(d / 86_400_000)}d`;
  }

  function renderBookmarks(): void {
    if (bmList.length === 0) {
      bmHeaderRef.content = 'BOOKMARKS  ' + '─'.repeat(38) + '  [M] save first';
      bmHeaderRef.fg      = C.dim;
      bmRefs[0]!.content  = '  (none saved)';
      bmRefs[0]!.fg       = C.dim;
      for (let i = 1; i < MAX_BM; i++) bmRefs[i]!.content = ' ';
      return;
    }
    bmHeaderRef.content = bmMode
      ? 'BOOKMARKS  ' + '─'.repeat(22) + '  ← press number to load   [esc] cancel   [M] save'
      : 'BOOKMARKS  ' + '─'.repeat(35) + '  [M] save   [O] load';
    bmHeaderRef.fg = bmMode ? C.white : C.dim;
    for (let i = 0; i < MAX_BM; i++) {
      const b = bmList[i];
      if (!b) { bmRefs[i]!.content = ' '; continue; }
      const label = b.label.length > 22 ? b.label.slice(0, 21) + '…' : b.label.padEnd(22);
      bmRefs[i]!.content = `  ${i + 1}  ${label}  :${b.target.padEnd(6)}  ${fmtAge(b.createdAt)} ago`;
      bmRefs[i]!.fg      = bmMode ? C.white : C.dim;
    }
  }

  function applyBookmark(b: Bookmark): void {
    const set = (id: string, val: string) => { const f = fields.find(f => f.id === id); if (f) f.value = val; };
    set('appPort',    b.target);
    set('nodeRegion', b.region  ?? '');
    if (b.network)  set('network',  b.network);
    if (b.cacheTtl) set('cacheTtl', String(b.cacheTtl));
    if (b.budget)   set('budget',   String(b.budget));
  }

  // ── Wallet ────────────────────────────────────────────────────────────────────
  function renderWallet(): void {
    const found = [
      evmKey  && 'CONSENSUS_EVM_KEY ✓',
      svmKey  && 'CONSENSUS_SVM_KEY ✓',
      pemPath && 'CONSENSUS_PEM_PATH ✓',
    ].filter(Boolean) as string[];
    if (found.length === 0) {
      walletRef.content = '  ○   Free mode — no wallet required';
      walletRef.fg      = C.dim;
    } else {
      walletRef.content = `  ●   self-managed   ${found.join('   ')}`;
      walletRef.fg      = C.emerald;
    }
  }

  // ── renderAll ─────────────────────────────────────────────────────────────────
  function renderAll(): void {
    fields.forEach((f, i) => renderField(f, i, state));
    renderBookmarks();

    validationRef.content = validationMessage ? `  ✕   ${validationMessage}` : ' ';
    validationRef.fg      = validationMessage ? C.red : C.dark;

    renderWallet();

    // Bottom description — current field's plain-English explanation
    const curField = fields[state.cursor];
    descRef.content = curField ? (FIELD_DESC[curField.id] ?? '') : '';

    if (picker.isOpen) {
      hintsRef.content = '[↑↓  navigate]  [→/↵  open/select]  [←  up]  [esc  cancel]';
    } else if (bmMode) {
      hintsRef.content = '[1-5  load bookmark]  [M  save current]  [esc  cancel]';
    } else if (state.editing) {
      hintsRef.content = '[↵  confirm]  [esc  cancel]';
    } else {
      hintsRef.content = '[R  rescan]  [↑↓  navigate]  [↵/←/→  edit·toggle]  [space  browse]  [1-5  select]  [M  bookmark]  [S  start]  [B  back]';
    }
  }

  renderAll();

  // ── Collect result ────────────────────────────────────────────────────────────
  function collect(): ForwardSetupResult {
    const get    = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    const result: ForwardSetupResult = {};
    const appPort = parseInt(get('appPort'), 10);
    if (!isNaN(appPort) && appPort > 0) result.appPort = appPort;
    if (get('appEntry'))     result.appEntry     = get('appEntry');
    if (get('appCheckPath')) result.appCheckPath = get('appCheckPath');
    if (get('autoLaunch') === 'on') result.autoLaunch = true;
    if (get('nodeRegion'))   result.nodeRegion   = get('nodeRegion');
    if (get('nodeDomain'))   result.nodeDomain   = get('nodeDomain');
    if (get('nodeExclude'))  result.nodeExclude  = get('nodeExclude');
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
    closePicker();
    renderer.destroy();
    return result;
  };

  function validateBeforeStart(): string | null {
    const get = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    if (get('autoLaunch') === 'on' && get('appEntry') === '') {
      return 'Auto restart requires an entry file';
    }
    return null;
  }

  // ── Key input ─────────────────────────────────────────────────────────────────
  return new Promise<ForwardSetupResult | null>((resolve) => {
    renderer.keyInput.on('keypress', (key: any) => {
      if (!live) return;

      // ── File picker mode ──────────────────────────────────────────────────────
      if (picker.isOpen) {
        const result = picker.handleKey(key);
        if (result === 'escape') {
          closePicker();
          renderAll();
        } else if (typeof result === 'string') {
          fields[1]!.value = result;
          closePicker();
          renderAll();
        }
        return;
      }

      // ── Bookmark-mode escape ───────────────────────────────────────────────────
      if (key.name === 'escape' && bmMode) {
        bmMode = false;
        renderAll();
        return;
      }

      // ── Normal form mode ──────────────────────────────────────────────────────
      if (!state.editing) {
        // R — rescan
        if (key.name === 'r' || key.name === 'R') { rescan(); return; }

        // M — save bookmark
        if (key.name === 'm' || key.name === 'M') {
          const get = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
          const port = get('appPort');
          saveBookmark({
            id:        crypto.randomUUID(),
            label:     `port ${port || '?'}`,
            type:      'proxy-forward',
            target:    port,
            region:    get('nodeRegion') || undefined,
            network:   get('network')   || undefined,
            cacheTtl:  parseInt(get('cacheTtl') || '0', 10) || undefined,
            budget:    parseFloat(get('budget'))            || undefined,
            createdAt: Date.now(),
          });
          bmList = loadBookmarks().filter(b => b.type === 'proxy-forward');
          renderAll();
          return;
        }

        // O — toggle bookmark load mode
        if (key.name === 'o' || key.name === 'O') {
          if (bmList.length > 0) { bmMode = !bmMode; renderAll(); }
          return;
        }

        // 1-5 — select detected process OR load bookmark
        const numKey = parseInt(key.name ?? '', 10);
        if (numKey >= 1 && numKey <= MAX_SHOWN) {
          if (bmMode) {
            const b = bmList[numKey - 1];
            if (b) { applyBookmark(b); bmMode = false; renderAll(); }
          } else {
            const port = detectedPorts[numKey - 1];
            if (port != null) {
              const proc = detectedProcs.find(p => p.port === port);
              fields[0]!.value = String(port);
              if (proc?.entryFile) fields[1]!.value = proc.entryFile;
              renderAll();
            }
          }
          return;
        }

        // Space on Entry file field — open picker
        if ((key.name === 'space' || key.sequence === ' ') && state.cursor === 1) {
          openPicker();
          renderAll();
          return;
        }
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
      if (action === 'back') {
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
