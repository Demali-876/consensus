import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../../../theme';
import { writeTraceLog } from '../../../lib/crash-log';
import { type FieldDef, type FormState, renderField, handleKey } from '../../../lib/form.ts';
import { scanAll, scanLan, LAN_HTTP_PORTS, LAN_TCP_PORTS, type ScannedPort, type LanDevice } from '../../../lib/ports.ts';
import { showTunnelDashboard } from './dashboard.ts';
import { makeSpin } from '../../../lib/spinners.ts';

export type TunnelSetupResult = {
  protocol: 'http' | 'tcp';
  target:   string;
  port?:    number;         // optional — tunnel will use the server's default if omitted
};

const MAX_LOCAL   = 8;
const MAX_LAN     = 8;
const MIN_SPIN_MS = 600;

export async function showTunnelSetup(): Promise<TunnelSetupResult | null> {
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
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS',    fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'TUNNEL SETUP', fg: C.slate, bg: C.panel }));
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
  bottomBar.add(new TextRenderable(renderer, { content: 'TUNNEL SETUP', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── Fields ────────────────────────────────────────────────────────────────
  const fields: FieldDef[] = [
    { id: 'protocol', label: 'Protocol', hint: 'http / tcp',              type: 'toggle', value: 'http', options: ['http', 'tcp'] },
    { id: 'target',   label: 'Target',   hint: 'IP address or hostname',  type: 'text',   value: '' },
    { id: 'port',     label: 'Port',     hint: 'optional — leave blank to use default', type: 'text', value: '' },
  ];
  const state: FormState = { cursor: 0, editing: false, editBuf: '' };

  // ── Protocol row ──────────────────────────────────────────────────────────
  const protoBox = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    paddingY: 0, backgroundColor: C.dark,
  });
  const protoRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
  fields[0]!.ref = protoRef;
  protoBox.add(protoRef);
  content.add(protoBox);

  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  // ── Two-panel row: LOCAL | LAN ─────────────────────────────────────────────
  const panelRow = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2,
    backgroundColor: C.dark,
  });
  content.add(panelRow);

  const localPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.dim,
    title: ' LOCAL PROCESSES ', padding: 1,
    backgroundColor: C.panel,
  });
  panelRow.add(localPanel);

  localPanel.add(new TextRenderable(renderer, {
    content: ' #   PORT     PROCESS',
    fg: C.dim, bg: 'transparent',
  }));
  localPanel.add(new TextRenderable(renderer, { content: '─'.repeat(28), fg: C.dim, bg: 'transparent' }));

  const localRefs: TextRenderable[] = [];
  for (let i = 0; i < MAX_LOCAL; i++) {
    const t = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
    localPanel.add(t);
    localRefs.push(t);
  }

  const lanPanel = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.dim,
    title: ' LAN DEVICES ', padding: 1,
    backgroundColor: C.panel,
  });
  panelRow.add(lanPanel);

  lanPanel.add(new TextRenderable(renderer, {
    content: ' #   IP                HOST                  PORTS',
    fg: C.dim, bg: 'transparent',
  }));
  lanPanel.add(new TextRenderable(renderer, { content: '─'.repeat(52), fg: C.dim, bg: 'transparent' }));

  const lanStatusRef = new TextRenderable(renderer, { content: '', fg: C.dim, bg: 'transparent' });
  lanPanel.add(lanStatusRef);

  const lanRefs: TextRenderable[] = [];
  for (let i = 0; i < MAX_LAN; i++) {
    const t = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
    lanPanel.add(t);
    lanRefs.push(t);
  }

  // ── TARGET section ────────────────────────────────────────────────────────
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: '─'.repeat(52), fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  const targetRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
  const portRef   = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
  fields[1]!.ref  = targetRef;
  fields[2]!.ref  = portRef;
  content.add(targetRef);
  content.add(portRef);

  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  const validationRef = new TextRenderable(renderer, { content: ' ', fg: C.red, bg: C.dark });
  content.add(validationRef);

  // ── Runtime state ─────────────────────────────────────────────────────────
  let live           = true;
  let showAllLan     = false;
  let scanningLocal  = false;
  let scanningLan    = false;
  let lanEverScanned = false;
  let validationMsg  = '';
  let localPorts: ScannedPort[] = [];
  let lanDevices: LanDevice[]   = [];

  // ── Pick list ─────────────────────────────────────────────────────────────
  type PickEntry = { target: string; port?: number };

  function buildPickList(): PickEntry[] {
    const protocol = fields[0]!.value as 'http' | 'tcp';
    const list: PickEntry[] = [];
    for (const p of localPorts.filter(p => p.kind === protocol).slice(0, MAX_LOCAL)) {
      list.push({ target: 'localhost', port: p.port });
    }
    const lanVisible = (showAllLan ? lanDevices : lanDevices.filter(d => !d.isFiltered))
      .filter(d => d.ports.length > 0)
      .slice(0, MAX_LAN);
    for (const d of lanVisible) {
      list.push({ target: d.ip, port: d.ports[0] });
    }
    return list;
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  function renderLocal(): void {
    if (scanningLocal) return;
    const protocol = fields[0]!.value as 'http' | 'tcp';
    const shown    = localPorts.filter(p => p.kind === protocol).slice(0, MAX_LOCAL);
    if (shown.length === 0) {
      localRefs[0]!.content = '  (none detected)';
      localRefs[0]!.fg      = C.dim;
      for (let i = 1; i < MAX_LOCAL; i++) localRefs[i]!.content = '';
      return;
    }
    const pick = buildPickList();
    for (let i = 0; i < MAX_LOCAL; i++) {
      const p = shown[i];
      if (!p) { localRefs[i]!.content = ''; continue; }
      const idx  = pick.findIndex(e => e.target === 'localhost' && e.port === p.port) + 1;
      const port = `:${p.port}`.padEnd(8);
      localRefs[i]!.content = ` ${idx}   ${port}  ${p.label}`;
      localRefs[i]!.fg      = p.isSystem ? C.dim : C.slate;
    }
  }

  function renderLan(): void {
    if (scanningLan) return;

    if (!lanEverScanned) {
      lanStatusRef.content = '';
      lanRefs[0]!.content  = '  (not scanned)  press L to scan';
      lanRefs[0]!.fg       = C.dim;
      for (let i = 1; i < MAX_LAN; i++) lanRefs[i]!.content = '';
      return;
    }

    const hidden    = lanDevices.filter(d => d.isFiltered).length;
    const displayed = (showAllLan ? lanDevices : lanDevices.filter(d => !d.isFiltered));
    const withPorts    = displayed.filter(d => d.ports.length > 0);
    const withoutPorts = showAllLan ? displayed.filter(d => d.ports.length === 0) : [];
    const sorted       = [...withPorts, ...withoutPorts];

    lanStatusRef.content = (!showAllLan && hidden > 0)
      ? `  ${hidden} device${hidden === 1 ? '' : 's'} hidden  [A show all]`
      : '';
    lanStatusRef.fg = C.dim;

    const pick = buildPickList();
    for (let i = 0; i < MAX_LAN; i++) {
      const d = sorted[i];
      if (!d) {
        lanRefs[i]!.content = (i === 0 && sorted.length === 0) ? '  (no servers found)' : '';
        lanRefs[i]!.fg      = C.dim;
        continue;
      }
      const pickIdx = pick.findIndex(e => e.target === d.ip);
      const num     = pickIdx >= 0 ? String(pickIdx + 1) : ' ';
      const ip      = d.ip.padEnd(18);
      const host    = d.hostname.padEnd(22);
      const ports   = d.ports.length > 0
        ? d.ports.slice(0, 4).map(p => `:${p}`).join(', ')
        : '(no open port found)';
      lanRefs[i]!.content = ` ${num}   ${ip}  ${host}  ${ports}`;
      lanRefs[i]!.fg      = d.ports.length === 0 ? C.dim : C.slate;
    }
  }

  function renderAll(): void {
    // Keep port hint in sync with selected protocol
    const proto = fields[0]!.value as 'http' | 'tcp';
    fields[2]!.hint = proto === 'tcp'
      ? 'required for TCP'
      : 'optional — leave blank to use default';
    fields.forEach((f, i) => renderField(f, i, state));
    renderLocal();
    renderLan();
    validationRef.content = validationMsg ? `  ✕  ${validationMsg}` : ' ';
    validationRef.fg      = validationMsg ? C.red : C.dark;
    const pick    = buildPickList();
    const numHint = pick.length > 0 ? `[1-${pick.length} select]  ` : '';
    const lanHint = lanEverScanned ? '[L rescan LAN]' : '[L scan LAN]';
    hintsRef.content = state.editing
      ? '[↵ confirm]  [esc cancel]'
      : `${numHint}[R rescan local]  ${lanHint}  [A show all]  [↑↓ navigate]  [↵/←/→ edit]  [S start]  [B back]`;
  }

  // ── Spinner ───────────────────────────────────────────────────────────────
  const spin = makeSpin('scan');

  function runSpinner(refs: TextRenderable[], msg: string, active: () => boolean): () => void {
    refs[0]!.content = `  ${spin()}  ${msg}`;
    refs[0]!.fg      = C.dim;
    for (let i = 1; i < refs.length; i++) refs[i]!.content = '';
    const t = setInterval(() => {
      if (!live || !active()) { clearInterval(t); return; }
      refs[0]!.content = `  ${spin()}  ${msg}`;
    }, 120);
    return () => clearInterval(t);
  }

  // ── Scan runners ──────────────────────────────────────────────────────────
  async function runLocalScan(): Promise<void> {
    if (scanningLocal) return;
    scanningLocal = true;
    const stop = runSpinner(localRefs, 'scanning local ports…', () => scanningLocal);
    const [result] = await Promise.all([scanAll(), new Promise(r => setTimeout(r, MIN_SPIN_MS))]);
    stop();
    scanningLocal = false;
    localPorts    = result as ScannedPort[];
    if (live) renderAll();
  }

  async function runLanScan(): Promise<void> {
    if (scanningLan) return;
    scanningLan    = true;
    lanEverScanned = true;
    lanStatusRef.content = '';
    const stop  = runSpinner(lanRefs, 'scanning LAN…', () => scanningLan);
    const proto = fields[0]!.value as 'http' | 'tcp';
    const [result] = await Promise.all([
      scanLan(proto === 'http' ? LAN_HTTP_PORTS : LAN_TCP_PORTS),
      new Promise(r => setTimeout(r, MIN_SPIN_MS)),
    ]);
    stop();
    scanningLan = false;
    lanDevices  = result as LanDevice[];
    if (live) renderAll();
  }

  // ── Initial render + local scan ───────────────────────────────────────────
  renderAll();
  runLocalScan();

  // ── Collect / validate ────────────────────────────────────────────────────
  function prefill(target: string, port?: number): void {
    fields.find(f => f.id === 'target')!.value = target;
    fields.find(f => f.id === 'port')!.value   = port != null ? String(port) : '';
  }

  function collect(): TunnelSetupResult {
    const get  = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    const port = parseInt(get('port'), 10);
    return {
      protocol: get('protocol') as 'http' | 'tcp',
      target:   get('target') || 'localhost',
      ...(isNaN(port) || port < 1 ? {} : { port }),
    };
  }

  function validate(): string | null {
    const get      = (id: string) => fields.find(f => f.id === id)?.value.trim() ?? '';
    const protocol = get('protocol') as 'http' | 'tcp';
    if (!get('target')) return 'Target is required';
    const raw = get('port');
    if (protocol === 'tcp') {
      if (raw === '') return 'Port is required for TCP tunnels';
      const p = parseInt(raw, 10);
      if (isNaN(p) || p < 1 || p > 65535) return 'Port must be 1–65535';
    } else if (raw !== '') {
      const p = parseInt(raw, 10);
      if (isNaN(p) || p < 1 || p > 65535) return 'Port must be 1–65535 or leave blank';
    }
    return null;
  }

  const done = (result: TunnelSetupResult | null) => {
    writeTraceLog('tunnelSetup.done', { result });
    live = false;
    renderer.destroy();
    return result;
  };

  // ── Key input ─────────────────────────────────────────────────────────────
  return new Promise<TunnelSetupResult | null>((resolve) => {
    renderer.keyInput.on('keypress', async (key) => {
      if (!live) return;

      if (!state.editing) {
        if (key.name === 'r' || key.name === 'R') { runLocalScan(); return; }
        if (key.name === 'l' || key.name === 'L') { runLanScan();   return; }
        if (key.name === 'a' || key.name === 'A') { showAllLan = !showAllLan; renderAll(); return; }

        const num  = parseInt(key.name ?? '');
        const pick = buildPickList();
        if (!isNaN(num) && num >= 1 && num <= pick.length) {
          const e = pick[num - 1]!;
          prefill(e.target, e.port);
          renderAll();
          return;
        }
      }

      const action = handleKey(key, fields, state, renderAll);
      if (action === 'start') {
        const err = validate();
        if (err) { validationMsg = err; renderAll(); return; }
        validationMsg = '';
        const result = collect();
        writeTraceLog('tunnelSetup.action', { action, result });
        live = false;
        renderer.destroy();
        await showTunnelDashboard(result);
        resolve(null); // return to landing after tunnel closes
        return;
      }
      if (action === 'back') {
        writeTraceLog('tunnelSetup.action', { action });
        resolve(done(null));
      }
      if (action === null && validationMsg) { validationMsg = ''; renderAll(); }
    });
  });
}
