import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../../../theme';
import { writeTraceLog } from '../../../lib/crash-log';
import { type FieldDef, type FormState, renderField, handleKey } from '../../../lib/form.ts';
import { quoteWs, type WsModel } from '../../../lib/websockets.ts';
import { NETWORK_CAIP2S, NETWORK_LABELS } from '../../../lib/networks.ts';
import { resolveNetworkBalance } from '../../../lib/balance.ts';
import type { PreferNetwork } from '../../../../src/payment-fetch.js';
import { showWsDashboard } from './dashboard.ts';
import { loadPrefs }       from '../../../lib/store.ts';

export type WsSetupResult = {
  model:          WsModel;
  minutes:        number;
  megabytes:      number;
  preferNetwork?: PreferNetwork;
};

const MODEL_INFO: Record<WsModel, { rate: string; detail: string }> = {
  hybrid: { rate: '$0.0005/min + $0.0001/MB', detail: 'Billed for both time and data' },
  time:   { rate: '$0.001/min',               detail: 'Billed for time only'           },
  data:   { rate: '$0.00012/MB',              detail: 'Billed for data only'            },
};

export async function showWsSetup(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  // ── Top bar ───────────────────────────────────────────────────────────────
  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS',        fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'WEBSOCKET SETUP',  fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // ── Main content ──────────────────────────────────────────────────────────
  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 2, paddingTop: 1, paddingBottom: 1,
    backgroundColor: C.dark,
  });
  root.add(content);

  // ── Bottom bar ────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const hintsRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.panel });
  bottomBar.add(hintsRef);
  bottomBar.add(new TextRenderable(renderer, { content: 'WEBSOCKET SETUP', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── Fields ────────────────────────────────────────────────────────────────
  const prefs = loadPrefs();
  const fields: FieldDef[] = [
    { id: 'model',     label: 'Model',       hint: 'billing model',        type: 'toggle', value: prefs.defaultWsModel,                options: ['hybrid', 'time', 'data'] },
    { id: 'minutes',   label: 'Duration',    hint: 'minutes (e.g. 5)',     type: 'text',   value: String(prefs.defaultWsMinutes) },
    { id: 'megabytes', label: 'Data',        hint: 'megabytes (e.g. 50)',  type: 'text',   value: String(prefs.defaultWsMegabytes) },
    { id: 'network',   label: 'Pay network', hint: '←/→ or ↵ to select',  type: 'toggle', value: prefs.defaultNetwork ?? '', options: NETWORK_CAIP2S, optionLabels: NETWORK_LABELS },
  ];
  const state: FormState = { cursor: 0, editing: false, editBuf: '' };

  // ── Two-panel row ─────────────────────────────────────────────────────────
  const panelRow = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2,
    backgroundColor: C.dark,
  });
  content.add(panelRow);

  // Left: form fields
  const formPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.line2,
    title: ' SESSION ', padding: 1,
    backgroundColor: C.panel,
  });
  panelRow.add(formPanel);

  const modelRef     = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
  const minutesRef   = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
  const megabytesRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
  const networkRef   = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
  fields[0]!.ref = modelRef;
  fields[1]!.ref = minutesRef;
  fields[2]!.ref = megabytesRef;
  fields[3]!.ref = networkRef;
  formPanel.add(modelRef);
  formPanel.add(minutesRef);
  formPanel.add(megabytesRef);
  formPanel.add(networkRef);
  formPanel.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: 'transparent' }));
  formPanel.add(new TextRenderable(renderer, { content: '─'.repeat(28), fg: C.dim, bg: 'transparent' }));
  const costRef = new TextRenderable(renderer, { content: '', fg: C.white, bg: 'transparent' });
  formPanel.add(costRef);

  // Right: billing info
  const infoPanel = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.line2,
    title: ' BILLING ', padding: 1,
    backgroundColor: C.panel,
  });
  panelRow.add(infoPanel);

  const modelNameRef   = new TextRenderable(renderer, { content: '', fg: C.white,  bg: 'transparent' });
  const modelRateRef   = new TextRenderable(renderer, { content: '', fg: C.slate,  bg: 'transparent' });
  const modelDetailRef = new TextRenderable(renderer, { content: '', fg: C.dim,    bg: 'transparent' });
  infoPanel.add(modelNameRef);
  infoPanel.add(modelRateRef);
  infoPanel.add(modelDetailRef);
  infoPanel.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: 'transparent' }));
  infoPanel.add(new TextRenderable(renderer, { content: '─'.repeat(36), fg: C.dim, bg: 'transparent' }));
  infoPanel.add(new TextRenderable(renderer, { content: ' hybrid   $0.0005/min + $0.0001/MB', fg: C.dim, bg: 'transparent' }));
  infoPanel.add(new TextRenderable(renderer, { content: ' time     $0.001/min',               fg: C.dim, bg: 'transparent' }));
  infoPanel.add(new TextRenderable(renderer, { content: ' data     $0.00012/MB',              fg: C.dim, bg: 'transparent' }));
  infoPanel.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: 'transparent' }));
  infoPanel.add(new TextRenderable(renderer, { content: '─'.repeat(36), fg: C.dim, bg: 'transparent' }));
  const balanceLabelRef = new TextRenderable(renderer, { content: ' Wallet balance', fg: C.dim,   bg: 'transparent' });
  const balanceRef      = new TextRenderable(renderer, { content: '—',              fg: C.slate, bg: 'transparent' });
  const balanceRow = new BoxRenderable(renderer, { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: 'transparent' });
  balanceRow.add(balanceLabelRef);
  balanceRow.add(balanceRef);
  infoPanel.add(balanceRow);

  // ── Validation ────────────────────────────────────────────────────────────
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  const validationRef = new TextRenderable(renderer, { content: ' ', fg: C.red, bg: C.dark });
  content.add(validationRef);

  // ── State ─────────────────────────────────────────────────────────────────
  let live          = true;
  let validationMsg = '';

  function getModel()      { return (fields[0]!.value as WsModel); }
  function getMinutes()    { return parseInt(fields[1]!.value.trim(), 10); }
  function getMegabytes()  { return parseInt(fields[2]!.value.trim(), 10); }
  function getNetwork()    { return fields[3]!.value as PreferNetwork | ''; }

  // ── Balance fetching ───────────────────────────────────────────────────────
  let lastBalanceNet = '\x00'; // sentinel so first render always triggers
  let balanceFetchSeq = 0;

  function refreshBalance(net: string): void {
    if (net === lastBalanceNet) return;
    lastBalanceNet = net;
    if (!net) { balanceRef.content = '—'; balanceRef.fg = C.slate; return; }
    balanceRef.content = 'querying…';
    balanceRef.fg      = C.dim;
    const seq = ++balanceFetchSeq;
    resolveNetworkBalance(net).then((result) => {
      if (!live || balanceFetchSeq !== seq) return;
      balanceRef.content = result;
      balanceRef.fg      = result.startsWith('no ') || result === 'invalid key' ? C.amber : C.white;
    }).catch(() => {
      if (!live || balanceFetchSeq !== seq) return;
      balanceRef.content = '(error)';
      balanceRef.fg      = C.red;
    });
  }

  function renderAll(): void {
    fields.forEach((f, i) => renderField(f, i, state));

    const model = getModel();
    const mins  = getMinutes();
    const mbs   = getMegabytes();
    const info  = MODEL_INFO[model];

    modelNameRef.content   = ` ${model.toUpperCase()}`;
    modelRateRef.content   = ` ${info.rate}`;
    modelDetailRef.content = ` ${info.detail}`;

    const validMins = !isNaN(mins) && mins > 0;
    const validMbs  = !isNaN(mbs)  && mbs  >= 0;
    if (validMins && validMbs) {
      const cost = quoteWs(model, mins, mbs);
      costRef.content = ` Estimated cost  $${cost.toFixed(4)}`;
      costRef.fg      = C.white;
    } else {
      costRef.content = ' Estimated cost  —';
      costRef.fg      = C.dim;
    }

    validationRef.content = validationMsg ? `  ✕  ${validationMsg}` : ' ';
    validationRef.fg      = validationMsg ? C.red : C.dark;

    hintsRef.content = state.editing
      ? '[↵ confirm]  [esc cancel]'
      : '[↑↓ navigate]  [↵/←/→ edit]  [R balance]  [S start]  [B back]';
  }

  function validate(): string | null {
    const mins = getMinutes();
    const mbs  = getMegabytes();
    if (isNaN(mins) || mins < 1)  return 'Duration must be at least 1 minute';
    if (isNaN(mbs)  || mbs < 0)   return 'Data must be 0 or more MB';
    return null;
  }

  function collect(): WsSetupResult {
    const net = getNetwork();
    return {
      model:          getModel(),
      minutes:        getMinutes(),
      megabytes:      getMegabytes(),
      preferNetwork:  net !== '' ? net as PreferNetwork : undefined,
    };
  }

  renderAll();

  // ── Key input ─────────────────────────────────────────────────────────────
  return new Promise<void>((resolve) => {
    renderer.keyInput.on('keypress', async (key) => {
      if (!live) return;

      if ((key.name === 'r' || key.name === 'R') && !state.editing) {
        lastBalanceNet = '\x00';
        refreshBalance(getNetwork());
        return;
      }

      const action = handleKey(key, fields, state, renderAll);

      if (action === 'start') {
        const err = validate();
        if (err) { validationMsg = err; renderAll(); return; }
        validationMsg = '';
        const result = collect();
        writeTraceLog('wsSetup.start', { result });
        live = false; renderer.destroy();
        await showWsDashboard(result);
        resolve();
        return;
      }
      if (action === 'back') {
        writeTraceLog('wsSetup.back');
        live = false; renderer.destroy();
        resolve();
        return;
      }
      if (action === null && validationMsg) { validationMsg = ''; renderAll(); }
    });
  });
}
