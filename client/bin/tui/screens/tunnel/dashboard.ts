import crypto    from 'node:crypto';
import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../../theme';
import { makeBadge } from '../../chrome.ts';
import { makeSpin } from '../../../lib/spinners.ts';
import {
  getActiveTunnel,
  startTunnel,
  stopTunnel,
  subscribe as subscribeTunnel,
  type TunnelSnapshot,
  type TunnelLogEntry,
} from '../../../lib/tunnel-runtime.ts';
import type { TunnelSetupResult } from './setup.ts';

const IS_PREVIEW = process.env.CONSENSUS_PREVIEW_TUNNEL === '1';

function fmtStatus(code: number): string {
  if (code === 0)   return '—';
  if (code < 300)   return `${code} OK`;
  if (code === 304) return `${code} NM`;
  if (code < 400)   return `${code} RDR`;
  if (code === 404) return `${code} NF`;
  if (code < 500)   return `${code} ERR`;
  return `${code} FAIL`;
}

function statusFg(code: number): string {
  if (code === 0)     return C.dim;
  if (code < 300)     return C.emerald;
  if (code < 400)     return C.accent;
  if (code < 500)     return C.amber;
  return C.red;
}

function fmtLat(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function fmtClock(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(2)} MB`;
  if (n >= 1024)          return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtBytesCompact(n: number): string {
  if (n <= 0)              return '—';
  if (n >= 1_048_576)      return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024)           return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtCount(n: number): string {
  return n.toLocaleString();
}

const SPARK_BARS = ['▁','▂','▃','▄','▅','▆','▇','█'] as const;
const SPARK_WIDTH = 40;

function sparkline(values: number[], width = SPARK_WIDTH): string {
  if (values.length === 0) return ' '.repeat(width);
  const padded = values.length >= width
    ? values.slice(-width)
    : Array(width - values.length).fill(0).concat(values);
  const max = Math.max(...padded, 1);
  return padded
    .map(v => v <= 0 ? SPARK_BARS[0]! : SPARK_BARS[Math.min(SPARK_BARS.length - 1, Math.floor((v / max) * (SPARK_BARS.length - 1)))]!)
    .join('');
}

const METHOD_FG: Record<string, string> = {
  GET:     C.slate,
  HEAD:    C.dim,
  OPTIONS: C.dim,
  POST:    C.emerald,
  PUT:     C.amber,
  PATCH:   C.amber,
  DELETE:  C.red,
  TCP:     C.cyan,
};

type LogRowRef = {
  box:     BoxRenderable;
  time:    TextRenderable;
  method:  TextRenderable;
  path:    TextRenderable;
  status:  TextRenderable;
  latency: TextRenderable;
  size:    TextRenderable;
};

const MAX_LOG = 20;
const MAX_LATENCY_SAMPLES = SPARK_WIDTH;

interface MetricTileRefs {
  box:      BoxRenderable;
  title:    TextRenderable;
  value:    TextRenderable;
  unit:     TextRenderable;
  meta:     TextRenderable;
}

function makeMetricTile(
  renderer: CliRenderer,
  title: string,
  valueColor: string,
): MetricTileRefs {
  const box = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.line2,
    padding: 1, backgroundColor: C.dark,
  });
  const titleRef = new TextRenderable(renderer, {
    content: title, fg: C.dim, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  box.add(titleRef);
  box.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  const valueRow = new BoxRenderable(renderer, {
    flexDirection: 'row', alignItems: 'flex-end', gap: 1,
    backgroundColor: C.dark,
  });
  const valueRef = new TextRenderable(renderer, {
    content: '', fg: valueColor, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const unitRef  = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.dark,
  });
  valueRow.add(valueRef);
  valueRow.add(unitRef);
  box.add(valueRow);
  box.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  const metaRef = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.dark,
  });
  box.add(metaRef);

  return { box, title: titleRef, value: valueRef, unit: unitRef, meta: metaRef };
}

const FAKE_PATHS = [
  '/api/metrics?range=1h', '/api/devices', '/api/sessions/expired',
  '/api/devices/unknown',  '/api/ingest',  '/static/dashboard.js',
  '/api/devices/3f2a/command', '/api/devices/3f2a/firmware', '/api/devices/3f2a/status',
  '/api/devices/9c01/logs',    '/api/devices/9c01/config',
  '/api/devices/7b/stream',    '/api/sensors/temp',
];
const FAKE_METHODS = ['GET','GET','GET','GET','GET','GET','POST','POST','POST','DELETE','PUT','PATCH'];
const FAKE_STATUSES = [200,200,200,200,200,200,200,202,204,304,404,502];

function fakeEntry(): TunnelLogEntry {
  const method = FAKE_METHODS[Math.floor(Math.random() * FAKE_METHODS.length)]!;
  const path   = FAKE_PATHS  [Math.floor(Math.random() * FAKE_PATHS.length)]!;
  const code   = FAKE_STATUSES[Math.floor(Math.random() * FAKE_STATUSES.length)]!;
  const isSlow = code === 502;
  const isCached = code === 304;
  const lat = isSlow ? 600 + Math.random() * 800
            : isCached ? 5 + Math.random() * 20
            : 20 + Math.random() * 200;
  return {
    time:       fmtClock(Date.now()),
    method,
    path,
    statusCode: code,
    latencyMs:  Math.round(lat),
    size:       Math.floor(200 + Math.random() * 8000),
  };
}

export async function showTunnelDashboard(setup: TunnelSetupResult): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingY: 0,
    backgroundColor: C.panel,
  });
  const connStatusRef = new TextRenderable(renderer, {
    content: '○ CONNECTING', fg: C.dim, bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  topBar.add(connStatusRef);

  const urlGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.panel,
  });
  const urlRef = new TextRenderable(renderer, {
    content: '—', fg: C.emerald, bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  urlGroup.add(urlRef);
  urlGroup.add(makeBadge(renderer, '⧉ copy', { bg: C.line2, fg: C.slate }).box);
  topBar.add(urlGroup);

  const uptimeGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, backgroundColor: C.panel,
  });
  uptimeGroup.add(new TextRenderable(renderer, { content: 'uptime', fg: C.dim, bg: C.panel }));
  const uptimeRef = new TextRenderable(renderer, {
    content: '00:00:00', fg: C.slate, bg: C.panel,
  });
  uptimeGroup.add(uptimeRef);
  topBar.add(uptimeGroup);
  root.add(topBar);

  const tilesRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2,
    paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });

  const fwdTile = makeMetricTile(renderer, 'FORWARDING TO', C.white);
  const reqTile = makeMetricTile(renderer, 'REQUESTS',      C.amber);
  const actTile = makeMetricTile(renderer, 'ACTIVE',        C.cyan);
  const sntTile = makeMetricTile(renderer, '↑ SENT',         C.cyan);
  const errTile = makeMetricTile(renderer, 'ERROR RATE',    C.red);

  tilesRow.add(fwdTile.box);
  tilesRow.add(reqTile.box);
  tilesRow.add(actTile.box);
  tilesRow.add(sntTile.box);
  tilesRow.add(errTile.box);
  root.add(tilesRow);

  const activityPanel = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.emerald,
    title: ' ACTIVITY ', padding: 1,
    backgroundColor: C.dark,
  });

  const activityHeader = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', backgroundColor: C.dark,
  });
  const streamingRow = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  const streamDot = new TextRenderable(renderer, {
    content: '●', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const streamLbl = new TextRenderable(renderer, {
    content: 'streaming', fg: C.slate, bg: C.dark,
  });
  streamingRow.add(streamDot);
  streamingRow.add(streamLbl);
  activityHeader.add(streamingRow);
  activityHeader.add(new TextRenderable(renderer, {
    content: `${MAX_LOG} most recent · newest on top`, fg: C.dim, bg: C.dark,
  }));
  activityPanel.add(activityHeader);
  activityPanel.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  const COLS = { time: 10, method: 8, path: 60, status: 12, latency: 8, size: 10 };

  const tableHeader = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, backgroundColor: C.dark,
  });
  const mkHead = (text: string, w: number, align: 'left' | 'right' = 'left') => {
    const content = align === 'right' ? text.padStart(w) : text.padEnd(w);
    tableHeader.add(new TextRenderable(renderer, {
      content, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
    }));
  };
  mkHead('TIME',    COLS.time);
  mkHead('METHOD',  COLS.method);
  mkHead('PATH',    COLS.path);
  mkHead('STATUS',  COLS.status);
  mkHead('LATENCY', COLS.latency, 'right');
  mkHead('SIZE',    COLS.size,    'right');
  activityPanel.add(tableHeader);

  const logRows: LogRowRef[] = [];
  for (let i = 0; i < MAX_LOG; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, backgroundColor: C.dark,
    });
    const time    = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.dark });
    const method  = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
    const path    = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const status  = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.dark, attributes: TextAttributes.BOLD });
    const latency = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.dark });
    const size    = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.dark });
    row.add(time); row.add(method); row.add(path); row.add(status); row.add(latency); row.add(size);
    activityPanel.add(row);
    logRows.push({ box: row, time, method, path, status, latency, size });
  }
  root.add(activityPanel);

  const statsBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingY: 0,
    backgroundColor: C.dark,
  });

  const latStats = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark,
  });
  const mkStat = (label: string): { lbl: TextRenderable; val: TextRenderable } => {
    const lbl = new TextRenderable(renderer, { content: label, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD });
    const val = new TextRenderable(renderer, { content: '—',    fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
    const pair = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
    pair.add(lbl); pair.add(val);
    latStats.add(pair);
    return { lbl, val };
  };
  const latCur = mkStat('LATENCY');
  const latAvg = mkStat('AVG');
  const latP95 = mkStat('P95');
  const latLast = mkStat(`LAST ${SPARK_WIDTH}`);
  const sparkRef = new TextRenderable(renderer, {
    content: ' '.repeat(SPARK_WIDTH), fg: C.emerald, bg: C.dark,
  });
  latStats.add(sparkRef);
  statsBar.add(latStats);

  const regionGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, backgroundColor: C.dark,
  });
  regionGroup.add(new TextRenderable(renderer, { content: 'REGION', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const regionRef = new TextRenderable(renderer, {
    content: '— · auto', fg: C.slate, bg: C.dark,
  });
  regionGroup.add(regionRef);
  statsBar.add(regionGroup);
  root.add(statsBar);

  const footer = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const footerChips = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.panel,
  });
  type Hint = { key: string; label: string; stub?: boolean; danger?: boolean };
  const HINTS: Hint[] = [
    { key: 'C',   label: 'clear log'    },
    { key: 'F',   label: 'filter',         stub: true },
    { key: 'P',   label: 'pause stream',   stub: true },
    { key: '↑↓',  label: 'scroll',         stub: true },
    { key: '↵',   label: 'inspect',        stub: true },
    { key: 'Q',   label: 'back · tunnel keeps running' },
    { key: 'X',   label: 'stop tunnel', danger: true },
  ];
  for (const h of HINTS) {
    const pair = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.panel });
    const badgeBg = h.danger ? C.red : C.slate;
    const badgeFg = h.danger ? C.dark : C.white;
    pair.add(makeBadge(renderer, h.key, { bg: badgeBg, fg: badgeFg }).box);
    pair.add(new TextRenderable(renderer, {
      content: h.label,
      fg: h.stub ? C.dim : (h.danger ? C.red : C.slate),
      bg: C.panel,
    }));
    footerChips.add(pair);
  }
  footer.add(footerChips);
  footer.add(new TextRenderable(renderer, { content: 'ACTIVE TUNNEL', fg: C.dim, bg: C.panel }));
  root.add(footer);

  let live    = true;
  let cleared = 0;          // number of leading entries to hide for the "clear log" affordance
  let paused  = false;      // reserved — stub key, not wired into runtime yet

  const targetStr = [setup.target, setup.port].filter(Boolean).join(':');
  const fwdMeta   = IS_PREVIEW
    ? `${setup.protocol} · node · my-api`
    : `${setup.protocol} · ${setup.target}`;
  fwdTile.value.content = targetStr || setup.target || '—';
  fwdTile.unit.content  = '';
  fwdTile.meta.content  = fwdMeta;

  // Preview-mode local snapshot — drives the same render functions as live mode.
  let previewSnap: TunnelSnapshot | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewActiveJitter: ReturnType<typeof setInterval> | null = null;

  // Visible portion of the log: snapshot.log minus any entries the user "cleared".
  function visibleLog(snap: TunnelSnapshot | null): TunnelLogEntry[] {
    if (!snap) return [];
    return cleared > 0 ? snap.log.slice(0, Math.max(0, snap.log.length - cleared)) : snap.log;
  }

  function renderLog(snap: TunnelSnapshot | null): void {
    const log = visibleLog(snap);
    for (let i = 0; i < MAX_LOG; i++) {
      const e = log[i];
      const r = logRows[i]!;
      if (!e) {
        r.time.content    = ''.padEnd(COLS.time);
        r.method.content  = ''.padEnd(COLS.method);
        r.path.content    = ''.padEnd(COLS.path);
        r.status.content  = ''.padEnd(COLS.status);
        r.latency.content = ''.padStart(COLS.latency);
        r.size.content    = ''.padStart(COLS.size);
        continue;
      }
      const rawPath = e.path.length > COLS.path - 1 ? e.path.slice(0, COLS.path - 2) + '…' : e.path;
      r.time.content    = e.time.padEnd(COLS.time);
      r.method.content  = e.method.padEnd(COLS.method);
      r.method.fg       = METHOD_FG[e.method] ?? C.slate;
      r.path.content    = rawPath.padEnd(COLS.path);
      r.status.content  = fmtStatus(e.statusCode).padEnd(COLS.status);
      r.status.fg       = statusFg(e.statusCode);
      r.latency.content = fmtLat(e.latencyMs).padStart(COLS.latency);
      r.latency.fg      = e.latencyMs != null && e.latencyMs > 1000 ? C.amber : C.dim;
      r.size.content    = (e.size != null ? fmtBytesCompact(e.size) : '—').padStart(COLS.size);
    }
  }

  function renderLatency(snap: TunnelSnapshot | null): void {
    const samples = snap?.recentLatencies ?? [];
    if (samples.length === 0) {
      latCur.val.content = '—';
      latAvg.val.content = '—';
      latP95.val.content = '—';
      latLast.val.content = '';
      sparkRef.content    = ' '.repeat(SPARK_WIDTH);
      return;
    }
    const cur = samples.at(-1)!;
    const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
    const sorted = [...samples].sort((a, b) => a - b);
    const p95idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    const p95 = sorted[p95idx]!;
    latCur.val.content = `${Math.round(cur)}ms`;
    latAvg.val.content = `${Math.round(avg)}ms`;
    latP95.val.content = `${Math.round(p95)}ms`;
    latLast.val.content = '';
    sparkRef.content    = sparkline(samples.slice(-MAX_LATENCY_SAMPLES), SPARK_WIDTH);
  }

  function renderTiles(snap: TunnelSnapshot | null): void {
    const requestCount = snap?.requestCount ?? 0;
    const startedAt    = snap?.startedAt ?? Date.now();
    const uptimeMin    = Math.max(1, (Date.now() - startedAt) / 60_000);
    const rpm          = Math.round(requestCount / uptimeMin);
    reqTile.value.content = fmtCount(requestCount);
    reqTile.meta.content  = `~${rpm} / min`;

    const activeStreams = snap?.activeStreams ?? 0;
    const totalStreams  = snap?.totalStreams ?? 0;
    actTile.value.content = String(activeStreams);
    actTile.unit.content  = activeStreams === 1 ? 'stream' : 'streams';
    actTile.meta.content  = totalStreams > 0
      ? `${fmtCount(totalStreams)} total · live connections`
      : 'live connections';

    const bytesSent = snap?.bytesSent ?? 0;
    const bytesRecv = snap?.bytesRecv ?? 0;
    const sentParts = fmtBytes(bytesSent).split(' ');
    sntTile.value.content = sentParts[0] ?? '0';
    sntTile.unit.content  = sentParts[1] ?? 'B';
    sntTile.meta.content  = `↓ ${fmtBytes(bytesRecv)} recv`;

    const recentStatuses = snap?.recentStatuses ?? [];
    if (recentStatuses.length === 0) {
      errTile.value.content = '0.0';
      errTile.unit.content  = '%';
    } else {
      const errors = recentStatuses.filter(s => s >= 400).length;
      const pct = (errors / recentStatuses.length) * 100;
      errTile.value.content = pct.toFixed(1);
      errTile.unit.content  = '%';
    }
    errTile.meta.content    = `last ${Math.min(100, recentStatuses.length || 0)} reqs`;
  }

  function renderChrome(snap: TunnelSnapshot | null): void {
    if (!snap) {
      connStatusRef.content = '○ NO TUNNEL';
      connStatusRef.fg      = C.dim;
      urlRef.content        = '—';
      regionRef.content     = '— · auto';
      streamDot.fg          = C.dim;
      streamLbl.content     = 'idle';
      return;
    }
    switch (snap.status) {
      case 'connecting':
        connStatusRef.content = '○ CONNECTING';
        connStatusRef.fg      = C.amber;
        streamDot.fg          = C.amber;
        streamLbl.content     = 'connecting';
        break;
      case 'connected':
        connStatusRef.content = '● CONNECTED';
        connStatusRef.fg      = C.emerald;
        streamDot.fg          = C.emerald;
        streamLbl.content     = 'streaming';
        break;
      case 'disconnected':
        connStatusRef.content = `○ ${snap.statusReason ?? 'DISCONNECTED'}`;
        connStatusRef.fg      = C.red;
        streamDot.fg          = C.red;
        streamLbl.content     = 'idle';
        break;
      case 'closed':
        connStatusRef.content = '○ CLOSED';
        connStatusRef.fg      = C.dim;
        streamDot.fg          = C.dim;
        streamLbl.content     = 'idle';
        break;
    }
    urlRef.content    = snap.publicUrl || '—';
    regionRef.content = `${snap.region} · auto`;
  }

  function renderAll(snap: TunnelSnapshot | null): void {
    renderChrome(snap);
    renderTiles(snap);
    renderLog(snap);
    renderLatency(snap);
  }

  // Initial render. Will be overwritten as soon as the runtime emits its first event.
  renderAll(getActiveTunnel());

  const spin      = makeSpin('checking');
  const spinTimer = setInterval(() => {
    if (!live) return;
    const snap = previewSnap ?? getActiveTunnel();
    if (snap?.status === 'connecting') {
      connStatusRef.content = `${spin()} CONNECTING`;
    }
  }, 100);

  const clockTimer = setInterval(() => {
    if (!live) return;
    const snap = previewSnap ?? getActiveTunnel();
    const startedAt = snap?.startedAt ?? Date.now();
    uptimeRef.content = fmtHms(Date.now() - startedAt);
    // The clock tick is also a periodic re-render so rpm and recv counters stay fresh
    // even between runtime events.
    renderTiles(snap);
  }, 1000);

  let unsubscribe: () => void = () => {};

  // Tear down the *view* only — keep the runtime tunnel alive.
  const closeView = (): void => {
    if (!live) return;
    live = false;
    clearInterval(spinTimer);
    clearInterval(clockTimer);
    if (previewTimer) clearTimeout(previewTimer);
    if (previewActiveJitter) clearInterval(previewActiveJitter);
    unsubscribe();
    renderer.destroy();
  };

  // Tear down the runtime tunnel as well as the view.
  const stopAndClose = async (): Promise<void> => {
    try { await stopTunnel(); } catch { /* best-effort */ }
    closeView();
  };

  // ── Preview mode ──────────────────────────────────────────────────────────
  // Synthetic data path used by the design preview. Doesn't touch the runtime;
  // builds a local snapshot that the render functions consume.
  if (IS_PREVIEW) {
    const slug = crypto.createHash('sha1').update(`${setup.protocol}:${targetStr}`).digest('hex').slice(0, 4);
    const url  = setup.protocol === 'http'
      ? `https://t-${slug}.consensus.canister.software`
      : `tcp://t-${slug}.consensus.canister.software:${5000 + (parseInt(slug, 16) % 50_000)}`;

    previewSnap = {
      setup,
      tunnelId:        slug,
      publicUrl:       url,
      region:          'sfo',
      status:          'connecting',
      statusReason:    null,
      startedAt:       Date.now(),
      bytesSent:       0,
      bytesRecv:       0,
      requestCount:    0,
      totalStreams:    0,
      activeStreams:   0,
      log:             [],
      recentLatencies: [],
      recentStatuses:  [],
    };

    const refresh = () => renderAll(previewSnap);

    setTimeout(() => {
      if (!live || !previewSnap) return;
      previewSnap = { ...previewSnap, status: 'connected' };
      for (let i = 0; i < 8; i++) {
        const e = fakeEntry();
        previewSnap.log.unshift(e);
        if (previewSnap.log.length > MAX_LOG) previewSnap.log.pop();
        previewSnap.requestCount++;
        previewSnap.totalStreams++;
        if (e.latencyMs != null) previewSnap.recentLatencies.push(e.latencyMs);
        if (e.statusCode) previewSnap.recentStatuses.push(e.statusCode);
        if (e.size) previewSnap.bytesSent += e.size;
      }
      refresh();
    }, 350);

    const schedule = (): void => {
      const wait = 400 + Math.random() * 1000;
      previewTimer = setTimeout(() => {
        if (!live || !previewSnap) return;
        const e = fakeEntry();
        previewSnap.log.unshift(e);
        if (previewSnap.log.length > MAX_LOG) previewSnap.log.pop();
        previewSnap.requestCount++;
        previewSnap.totalStreams++;
        if (e.latencyMs != null) {
          previewSnap.recentLatencies.push(e.latencyMs);
          if (previewSnap.recentLatencies.length > MAX_LATENCY_SAMPLES) previewSnap.recentLatencies.shift();
        }
        if (e.statusCode) {
          previewSnap.recentStatuses.push(e.statusCode);
          if (previewSnap.recentStatuses.length > 100) previewSnap.recentStatuses.shift();
        }
        if (e.size) previewSnap.bytesSent += e.size;
        previewSnap.bytesRecv += Math.floor(20_000 + Math.random() * 80_000);
        refresh();
        schedule();
      }, wait);
    };
    schedule();

    previewActiveJitter = setInterval(() => {
      if (!live || !previewSnap) return;
      previewSnap.activeStreams = 1 + Math.floor(Math.random() * 4);
      refresh();
    }, 1800);

    await new Promise<void>(resolve => {
      renderer.keyInput.on('keypress', (key) => {
        if (!live) return;
        if (key.name === 'c' || key.name === 'C') {
          if (previewSnap) previewSnap.log.splice(0);
          renderLog(previewSnap);
          return;
        }
        if (key.ctrl && key.name === 'c') { closeView(); resolve(); return; }
        if (key.name === 'q' || key.name === 'Q' || key.name === 'b' || key.name === 'B') {
          closeView(); resolve(); return;
        }
        if (key.name === 'x' || key.name === 'X') {
          closeView(); resolve(); return;
        }
        if (key.name === 'p' || key.name === 'P') {
          paused = !paused;
          return;
        }
      });
    });
    return;
  }

  // ── Live mode ─────────────────────────────────────────────────────────────
  // Either re-attach to the existing tunnel or start a new one.
  let current = getActiveTunnel();
  if (!current) {
    try {
      current = await startTunnel(setup);
    } catch (err) {
      connStatusRef.content = `○ ${(err as Error).message}`;
      connStatusRef.fg      = C.red;
      streamDot.fg          = C.red;
      streamLbl.content     = 'idle';
    }
  }
  renderAll(current);

  unsubscribe = subscribeTunnel((snap) => {
    if (!live) return;
    renderAll(snap);
  });

  await new Promise<void>(resolve => {
    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;
      if (key.name === 'c' || key.name === 'C') {
        // "Clear log" in the view: hide all current entries until new ones arrive.
        const snap = getActiveTunnel();
        cleared = snap?.log.length ?? 0;
        renderLog(snap);
        return;
      }
      if (key.name === 'p' || key.name === 'P') {
        paused = !paused;
        return;
      }
      if (key.ctrl && key.name === 'c') { closeView(); resolve(); return; }
      if (key.name === 'q' || key.name === 'Q' || key.name === 'b' || key.name === 'B') {
        closeView(); resolve(); return;
      }
      if (key.name === 'x' || key.name === 'X') {
        void stopAndClose().then(resolve);
        return;
      }
    });
  });
}
