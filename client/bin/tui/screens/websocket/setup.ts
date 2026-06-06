import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
} from '@opentui/core';
import { C } from '../../../theme';
import { makeBadge, makeKeyBar, makeTopBar } from '../../chrome.ts';
import { writeTraceLog } from '../../../lib/crash-log';
import { quoteWs, type WsModel } from '../../../lib/websockets.ts';
import { isFreeMode } from '../../../lib/server-config';
import { resolveNetworkBalance } from '../../../lib/balance.ts';
import type { PreferNetwork } from '../../../../src/payment-fetch.js';
import { showWsDashboard } from './dashboard.ts';
import { loadPrefs } from '../../../lib/store.ts';

interface ModelMeta {
  key: WsModel;
  label: string;
  title: string;
  rate: string;
  detail: string;
}

const MODELS: ModelMeta[] = [
  { key: 'hybrid', label: 'hybrid', title: 'HYBRID', rate: '$0.0005/min + $0.0001/MB', detail: 'Billed for both time and data' },
  { key: 'time',   label: 'time',   title: 'TIME',   rate: '$0.001/min',               detail: 'Billed for time only' },
  { key: 'data',   label: 'data',   title: 'DATA',   rate: '$0.00012/MB',              detail: 'Billed for data only' },
];

type NetKey = 'base' | 'solana';
interface NetMeta {
  key: NetKey;
  label: string;
  caip2: string;
  short: string;
}
const NETS: NetMeta[] = [
  { key: 'base',   label: 'Base',   caip2: 'eip155:8453',                              short: 'base'   },
  { key: 'solana', label: 'Solana', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', short: 'solana' },
];

function caip2ToNetKey(caip2?: string): NetKey {
  return caip2?.startsWith('solana:') ? 'solana' : 'base';
}

type FieldId = 'model' | 'duration' | 'data' | 'network';
const FIELD_ORDER: FieldId[] = ['model', 'duration', 'data', 'network'];

export type WsSetupResult = {
  model: WsModel;
  minutes: number;
  megabytes: number;
  preferNetwork?: PreferNetwork;
};

interface FieldRowRefs {
  row: BoxRenderable;
  cursorBar: BoxRenderable;
  label: TextRenderable;
}

function makeFieldRow(renderer: CliRenderer, parent: BoxRenderable, label: string): FieldRowRefs & { body: BoxRenderable } {
  const row = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: 1,
    paddingY: 0, backgroundColor: C.dark,
  });
  const cursorBar = new BoxRenderable(renderer, { width: 1, height: 3, backgroundColor: C.dark });
  const labelRef = new TextRenderable(renderer, {
    content: label.padEnd(13), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const body = new BoxRenderable(renderer, {
    flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 1, backgroundColor: C.dark,
  });
  row.add(cursorBar);
  row.add(labelRef);
  row.add(body);
  parent.add(row);
  return { row, cursorBar, label: labelRef, body };
}

function setFieldFocused(refs: FieldRowRefs, focused: boolean): void {
  refs.cursorBar.backgroundColor = focused ? C.accent : C.dark;
  refs.label.fg = focused ? C.white : C.dim;
}

interface PillRefs<K extends string> {
  box: BoxRenderable;
  pills: Record<K, { box: BoxRenderable; label: TextRenderable }>;
  setActive(active: K, opts: { focused: boolean; activeBg: string }): void;
}

function makePills<K extends string>(
  renderer: CliRenderer,
  parent: BoxRenderable,
  items: Array<{ key: K; label: string }>,
  initial: K,
  activeBg: string,
): PillRefs<K> {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row', alignItems: 'center', gap: 0,
    border: true, borderStyle: 'rounded', borderColor: C.line2, backgroundColor: C.panel,
  });
  const pills = {} as PillRefs<K>['pills'];
  for (const it of items) {
    const active = it.key === initial;
    const pill = new BoxRenderable(renderer, {
      flexDirection: 'row', paddingX: 2, backgroundColor: active ? activeBg : C.panel,
    });
    const lbl = new TextRenderable(renderer, {
      content: it.label, fg: active ? C.dark : C.slate,
      bg: active ? activeBg : C.panel, attributes: TextAttributes.BOLD,
    });
    pill.add(lbl);
    box.add(pill);
    pills[it.key] = { box: pill, label: lbl };
  }
  parent.add(box);
  return {
    box, pills,
    setActive(active, opts) {
      for (const it of items) {
        const on = it.key === active;
        const { box: pillBox, label } = pills[it.key];
        pillBox.backgroundColor = on ? opts.activeBg : C.panel;
        label.bg = on ? opts.activeBg : C.panel;
        label.fg = on ? C.dark : C.slate;
      }
      box.borderColor = opts.focused ? C.accent : C.line2;
    },
  };
}

interface InputRefs {
  box: BoxRenderable;
  value: TextRenderable;
}

function makeInput(renderer: CliRenderer, parent: BoxRenderable, width: number): InputRefs {
  const box = new BoxRenderable(renderer, {
    width, flexDirection: 'row', paddingX: 1,
    border: true, borderStyle: 'rounded', borderColor: C.line2, backgroundColor: C.panel,
  });
  const value = new TextRenderable(renderer, {
    content: ' ', fg: C.slate, bg: C.panel, attributes: TextAttributes.BOLD,
  });
  box.add(value);
  parent.add(box);
  return { box, value };
}

function setInputState(refs: InputRefs, raw: string, focused: boolean, editing: boolean): void {
  refs.value.content = editing && focused ? `${raw}█` : (raw || ' ');
  refs.value.fg = raw ? (focused ? C.white : C.slate) : C.dim;
  refs.box.borderColor = focused ? C.accent : C.line2;
}

interface RateRowRefs {
  row: BoxRenderable;
  bar: BoxRenderable;
  label: TextRenderable;
  rate: TextRenderable;
}

function makeRateRow(renderer: CliRenderer, parent: BoxRenderable, label: string, rate: string): RateRowRefs {
  const row = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: 1,
    paddingY: 0, backgroundColor: C.dark,
  });
  const bar = new BoxRenderable(renderer, { width: 1, height: 1, backgroundColor: C.dark });
  const labelRef = new TextRenderable(renderer, {
    content: label.padEnd(8), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const rateRef = new TextRenderable(renderer, {
    content: rate, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  row.add(bar);
  row.add(labelRef);
  row.add(rateRef);
  parent.add(row);
  return { row, bar, label: labelRef, rate: rateRef };
}

function setRateRowActive(refs: RateRowRefs, active: boolean): void {
  refs.bar.backgroundColor = active ? C.emerald : C.dark;
  refs.row.backgroundColor = active ? C.panel : C.dark;
  refs.label.bg = active ? C.panel : C.dark;
  refs.rate.bg = active ? C.panel : C.dark;
  refs.label.fg = active ? C.slate : C.dim;
  refs.rate.fg = active ? C.slate : C.dim;
}

function makeSeparator(renderer: CliRenderer, parent: BoxRenderable): void {
  parent.add(new BoxRenderable(renderer, {
    width: '100%', height: 1, marginTop: 1, marginBottom: 1,
    border: ['top'], borderColor: C.line2, backgroundColor: C.dark,
  }));
}

export async function showWsSetup(): Promise<void> {
  const freeMode = await isFreeMode();
  const prefs = loadPrefs();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  makeTopBar(renderer, root, { freeMode });

  const shell = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });
  root.add(shell);

  const headerCol = new BoxRenderable(renderer, { flexDirection: 'column', backgroundColor: C.dark });
  const titleRow = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  titleRow.add(new TextRenderable(renderer, { content: '■', fg: C.accent, bg: C.dark, attributes: TextAttributes.BOLD }));
  titleRow.add(new TextRenderable(renderer, { content: 'WebSocket', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD }));
  titleRow.add(new TextRenderable(renderer, { content: '/', fg: C.dim, bg: C.dark }));
  titleRow.add(new TextRenderable(renderer, { content: 'New session', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD }));
  headerCol.add(titleRow);
  headerCol.add(new TextRenderable(renderer, {
    content: 'buy a metered socket — pre-pay for time and/or data, then stream',
    fg: C.dim, bg: C.dark,
  }));
  shell.add(headerCol);

  const grid = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2, marginTop: 1, backgroundColor: C.dark,
  });
  shell.add(grid);

  const sessionPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.line2,
    title: ' SESSION ', titleAlignment: 'left', paddingX: 2, paddingY: 1, backgroundColor: C.dark,
  });
  grid.add(sessionPanel);

  const modelField = makeFieldRow(renderer, sessionPanel, 'Model');
  const modelPills = makePills(
    renderer, modelField.body,
    MODELS.map((m) => ({ key: m.key, label: m.label })),
    (prefs.defaultWsModel as WsModel | undefined) ?? 'hybrid',
    C.accent,
  );

  const durationField = makeFieldRow(renderer, sessionPanel, 'Duration');
  const durationInput = makeInput(renderer, durationField.body, 8);
  durationField.body.add(new TextRenderable(renderer, { content: 'minutes', fg: C.dim, bg: C.dark }));

  const dataField = makeFieldRow(renderer, sessionPanel, 'Data');
  const dataInput = makeInput(renderer, dataField.body, 8);
  dataField.body.add(new TextRenderable(renderer, { content: 'megabytes', fg: C.dim, bg: C.dark }));

  const netField = makeFieldRow(renderer, sessionPanel, 'Pay network');
  const netPills = makePills(
    renderer, netField.body,
    NETS.map((n) => ({ key: n.key, label: n.label })),
    caip2ToNetKey(prefs.defaultNetwork),
    C.emerald,
  );
  netField.body.add(new TextRenderable(renderer, { content: 'USDC', fg: C.dim, bg: C.dark }));

  makeSeparator(renderer, sessionPanel);

  const costRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-end', backgroundColor: C.dark,
  });
  costRow.add(new TextRenderable(renderer, { content: 'ESTIMATED COST', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const costValue = new TextRenderable(renderer, {
    content: '$0.0000', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  costRow.add(costValue);
  sessionPanel.add(costRow);

  const costBreakdown = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  const breakdownRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: C.dark,
  });
  breakdownRow.add(costBreakdown);
  sessionPanel.add(breakdownRow);

  const billingPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.emerald,
    title: ' BILLING ', titleAlignment: 'left', paddingX: 2, paddingY: 1, backgroundColor: C.dark,
  });
  grid.add(billingPanel);

  const billingTitle = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD });
  const billingRate = new TextRenderable(renderer, { content: '', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD });
  const billingDetail = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  billingPanel.add(billingTitle);
  billingPanel.add(billingRate);
  billingPanel.add(billingDetail);

  makeSeparator(renderer, billingPanel);

  const rateRows: Record<WsModel, RateRowRefs> = {
    hybrid: makeRateRow(renderer, billingPanel, 'HYBRID', '$0.0005/min + $0.0001/MB'),
    time:   makeRateRow(renderer, billingPanel, 'TIME',   '$0.001/min'),
    data:   makeRateRow(renderer, billingPanel, 'DATA',   '$0.00012/MB'),
  };

  makeSeparator(renderer, billingPanel);

  const balanceRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', backgroundColor: C.dark,
  });
  balanceRow.add(new TextRenderable(renderer, { content: 'WALLET BALANCE', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const balanceGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  const balanceVal = new TextRenderable(renderer, { content: '—', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
  const balanceSep = new TextRenderable(renderer, { content: '·', fg: C.dim, bg: C.dark });
  const balanceSuf = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  balanceGroup.add(balanceVal);
  balanceGroup.add(balanceSep);
  balanceGroup.add(balanceSuf);
  balanceRow.add(balanceGroup);
  billingPanel.add(balanceRow);

  const actionRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 1, backgroundColor: C.dark,
  });
  const startBtn = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', paddingX: 2, paddingY: 0, backgroundColor: C.emerald,
  });
  startBtn.add(makeBadge(renderer, 'S', { bg: C.dark, fg: C.emerald }).box);
  startBtn.add(new TextRenderable(renderer, { content: 'START SESSION', fg: C.dark, bg: C.emerald, attributes: TextAttributes.BOLD }));
  const hintGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  hintGroup.add(new TextRenderable(renderer, { content: 'or press', fg: C.dim, bg: C.dark }));
  hintGroup.add(makeBadge(renderer, '↵', { bg: C.line2 }).box);
  hintGroup.add(new TextRenderable(renderer, { content: '·', fg: C.dim, bg: C.dark }));
  hintGroup.add(makeBadge(renderer, 'R', { bg: C.line2 }).box);
  hintGroup.add(new TextRenderable(renderer, { content: 'refresh balance', fg: C.slate, bg: C.dark }));
  actionRow.add(startBtn);
  actionRow.add(hintGroup);
  billingPanel.add(actionRow);

  root.add(makeKeyBar(renderer, [
    { key: '↑↓',  label: 'navigate' },
    { key: '↵←→', label: 'edit · toggle' },
    { key: 'R',   label: 'balance' },
    { key: 'S',   label: 'start session' },
    { key: 'B',   label: 'back' },
  ], 'WEBSOCKET SETUP').box);

  let live = true;
  let cursor: FieldId = 'model';
  let editing = false;
  let editBuf = '';
  let model: WsModel = (prefs.defaultWsModel as WsModel | undefined) ?? 'hybrid';
  let minutes = prefs.defaultWsMinutes || 60;
  let megabytes = prefs.defaultWsMegabytes || 500;
  let net: NetKey = caip2ToNetKey(prefs.defaultNetwork);

  const cursorIdx = (): number => FIELD_ORDER.indexOf(cursor);
  const modelMeta = (): ModelMeta => MODELS.find((m) => m.key === model)!;
  const netMeta = (): NetMeta => NETS.find((n) => n.key === net)!;

  function computeCost(): { value: number; breakdown: string } {
    const value = quoteWs(model, minutes, megabytes);
    switch (model) {
      case 'time': return { value, breakdown: `${minutes} min × $0.001` };
      case 'data': return { value, breakdown: `${megabytes} MB × $0.00012` };
      case 'hybrid': return { value, breakdown: `${minutes} min × $0.0005 + ${megabytes} MB × $0.0001` };
    }
  }

  function renderFocus(): void {
    setFieldFocused(modelField, cursor === 'model');
    setFieldFocused(durationField, cursor === 'duration');
    setFieldFocused(dataField, cursor === 'data');
    setFieldFocused(netField, cursor === 'network');
    modelPills.setActive(model, { focused: cursor === 'model', activeBg: C.accent });
    netPills.setActive(net, { focused: cursor === 'network', activeBg: C.emerald });
    setInputState(durationInput, editing && cursor === 'duration' ? editBuf : String(minutes),
      cursor === 'duration', editing && cursor === 'duration');
    setInputState(dataInput, editing && cursor === 'data' ? editBuf : String(megabytes),
      cursor === 'data', editing && cursor === 'data');
  }

  function renderBilling(): void {
    const m = modelMeta();
    billingTitle.content = m.title;
    billingRate.content = m.rate;
    billingDetail.content = m.detail;
    for (const k of Object.keys(rateRows) as WsModel[]) setRateRowActive(rateRows[k], k === model);
  }

  function renderCost(): void {
    const { value, breakdown } = computeCost();
    costValue.content = `$${value.toFixed(4)}`;
    costBreakdown.content = breakdown;
  }

  function renderAll(): void {
    if (!live) return;
    renderFocus();
    renderBilling();
    renderCost();
  }

  let lastFetchedNet: NetKey | null = null;
  let balanceSeq = 0;

  function refreshBalance(force = false): void {
    if (freeMode) {
      balanceVal.content = 'free tier';
      balanceVal.fg = C.slate;
      balanceSep.content = '·';
      balanceSuf.content = 'no charge';
      return;
    }
    if (!force && lastFetchedNet === net) return;
    lastFetchedNet = net;
    balanceVal.content = 'querying…';
    balanceVal.fg = C.dim;
    balanceSep.content = '';
    balanceSuf.content = '';
    const seq = ++balanceSeq;
    resolveNetworkBalance(netMeta().caip2).then((result) => {
      if (!live || seq !== balanceSeq) return;
      balanceVal.content = result;
      balanceVal.fg = result.startsWith('no ') || result === 'invalid key' ? C.amber : C.slate;
      balanceSep.content = '·';
      balanceSuf.content = netMeta().short;
    }).catch(() => {
      if (!live || seq !== balanceSeq) return;
      balanceVal.content = '(error)';
      balanceVal.fg = C.red;
      balanceSep.content = '';
      balanceSuf.content = '';
    });
  }

  renderAll();
  refreshBalance(true);

  function cycleModel(dir: 1 | -1): void {
    const idx = MODELS.findIndex((m) => m.key === model);
    model = MODELS[(idx + dir + MODELS.length) % MODELS.length]!.key;
  }
  function cycleNet(dir: 1 | -1): void {
    const idx = NETS.findIndex((n) => n.key === net);
    net = NETS[(idx + dir + NETS.length) % NETS.length]!.key;
    refreshBalance(true);
  }
  function commitEdit(): void {
    const n = Number.parseInt(editBuf.trim(), 10);
    if (cursor === 'duration' && Number.isFinite(n) && n > 0) minutes = n;
    if (cursor === 'data' && Number.isFinite(n) && n >= 0) megabytes = n;
    editing = false;
    editBuf = '';
  }

  return new Promise<void>((resolve) => {
    const done = (action: 'back' | 'start') => {
      live = false;
      renderer.destroy();
      if (action === 'start') {
        const result: WsSetupResult = { model, minutes, megabytes, preferNetwork: netMeta().caip2 as PreferNetwork };
        writeTraceLog('wsSetup.start', { result });
        void showWsDashboard(result).then(resolve);
      } else {
        writeTraceLog('wsSetup.back');
        resolve();
      }
    };

    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;

      if (editing) {
        if (key.name === 'escape') { editing = false; editBuf = ''; renderAll(); return; }
        if (key.name === 'return' || key.name === 'enter') { commitEdit(); renderAll(); return; }
        if (key.name === 'backspace') { editBuf = editBuf.slice(0, -1); renderAll(); return; }
        if (key.sequence && key.sequence.length === 1 && /[0-9]/.test(key.sequence) && !key.ctrl && !key.meta) {
          editBuf += key.sequence;
          renderAll();
        }
        return;
      }

      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) { done('back'); return; }
      if (key.name === 'r' || key.name === 'R') { refreshBalance(true); return; }
      if (key.name === 's' || key.name === 'S') { if (minutes >= 1 && megabytes >= 0) done('start'); return; }

      if (key.name === 'up' || key.name === 'k') {
        cursor = FIELD_ORDER[(cursorIdx() - 1 + FIELD_ORDER.length) % FIELD_ORDER.length]!;
        renderAll();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        cursor = FIELD_ORDER[(cursorIdx() + 1) % FIELD_ORDER.length]!;
        renderAll();
        return;
      }

      if (cursor === 'model') {
        if (key.name === 'left') cycleModel(-1);
        else if (key.name === 'right' || key.name === 'return' || key.name === 'enter') cycleModel(1);
        renderAll();
        return;
      }
      if (cursor === 'network') {
        if (key.name === 'left') cycleNet(-1);
        else if (key.name === 'right' || key.name === 'return' || key.name === 'enter') cycleNet(1);
        renderAll();
        return;
      }
      if (cursor === 'duration' || cursor === 'data') {
        if (key.name === 'return' || key.name === 'enter') {
          editing = true;
          editBuf = cursor === 'duration' ? String(minutes) : String(megabytes);
          renderAll();
        }
      }
    });
  });
}
