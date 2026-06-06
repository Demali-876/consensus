import net       from 'net';
import crypto    from 'node:crypto';
import WebSocket from 'ws';
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
import { saveSession } from '../../../lib/store.ts';
import type { TunnelSetupResult } from './setup.ts';

const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';
const IS_PREVIEW = process.env.CONSENSUS_PREVIEW_TUNNEL === '1';

const FRAME = {
  STREAM_OPEN:  0x01,
  STREAM_DATA:  0x02,
  STREAM_END:   0x03,
  STREAM_RESET: 0x04,
  PING:         0x05,
  PONG:         0x06,
} as const;

function encodeFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId, 1);
  return Buffer.concat([header, payload]);
}

function decodeFrame(data: Buffer): { type: number; streamId: number; payload: Buffer } {
  return { type: data.readUInt8(0), streamId: data.readUInt32BE(1), payload: data.subarray(5) };
}

function parseHttpRequestLine(payload: Buffer): { method: string; path: string } | null {
  const text  = payload.toString('utf8', 0, Math.min(payload.length, 512));
  const line  = text.split('\r\n')[0] ?? '';
  const parts = line.split(' ');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { method: parts[0], path: parts[1] };
}

function parseHttpStatusCode(data: Buffer): number | null {
  const text = data.toString('utf8', 0, Math.min(data.length, 64));
  const m    = text.match(/^HTTP\/\d+\.?\d*\s+(\d{3})/);
  return m ? parseInt(m[1]!) : null;
}

function fmtStatus(code: number): string {
  if (code === 0)   return '—';
  if (code < 300)   return `${code} OK`;
  if (code === 304) return `${code} NM`;       // Not Modified (matches the design copy)
  if (code < 400)   return `${code} RDR`;
  if (code === 404) return `${code} NF`;       // Not Found (design uses 'NF')
  if (code < 500)   return `${code} ERR`;
  return `${code} FAIL`;
}

function statusFg(code: number): string {
  if (code === 0)     return C.dim;
  if (code < 300)     return C.emerald;
  if (code < 400)     return C.accent;          // 3xx → purple per design
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
const SPARK_WIDTH = 40;          // matches design "LAST 40" footer

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

type LogEntry = {
  time:       string;
  method:     string;
  path:       string;
  statusCode: number;
  latencyMs?: number;
  size?:      number;       // response body bytes (for SIZE column)
};

type PendingStream = {
  method:        string;
  path:          string;
  startedAt:     number;
  gotStatus:     boolean;
  respBuf:       Buffer;
  headersDone:   boolean;
  contentLength: number;     // -1 = unknown
  bodyReceived:  number;
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
const MAX_LATENCY_SAMPLES = SPARK_WIDTH;       // 40 — drives both stats and the bottom sparkline

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

function fakeEntry(): LogEntry {
  const method = FAKE_METHODS[Math.floor(Math.random() * FAKE_METHODS.length)]!;
  const path   = FAKE_PATHS  [Math.floor(Math.random() * FAKE_PATHS.length)]!;
  const code   = FAKE_STATUSES[Math.floor(Math.random() * FAKE_STATUSES.length)]!;
  const isSlow = code === 502;
  const isCached = code === 304;
  const lat = isSlow ? 600 + Math.random() * 800
            : isCached ? 5 + Math.random() * 20
            : 20 + Math.random() * 280;
  const size = code === 304 ? 0
            : Math.floor(500 + Math.random() * 55_000);
  return {
    time: fmtClock(Date.now()),
    method, path,
    statusCode: code,
    latencyMs:  Math.round(lat),
    size,
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
  type Hint = { key: string; label: string; stub?: boolean };
  const HINTS: Hint[] = [
    { key: 'C',   label: 'clear log'    },
    { key: 'F',   label: 'filter',         stub: true },
    { key: 'P',   label: 'pause stream',   stub: true },
    { key: '↑↓',  label: 'scroll',         stub: true },
    { key: '↵',   label: 'inspect',        stub: true },
    { key: 'Q',   label: 'stop tunnel' },
  ];
  for (const h of HINTS) {
    const pair = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.panel });
    pair.add(makeBadge(renderer, h.key, { bg: C.slate, fg: C.white }).box);
    pair.add(new TextRenderable(renderer, {
      content: h.label, fg: h.stub ? C.dim : C.slate, bg: C.panel,
    }));
    footerChips.add(pair);
  }
  footer.add(footerChips);
  footer.add(new TextRenderable(renderer, { content: 'ACTIVE TUNNEL', fg: C.dim, bg: C.panel }));
  root.add(footer);

  let live       = true;
  let connected  = false;
  let paused     = false;
  const startedAt = Date.now();
  const log: LogEntry[] = [];
  const sessionId = crypto.randomUUID();
  let requestCount = 0;
  let bytesSent    = 0;
  let bytesRecv    = 0;
  let totalStreams = 0;
  let tunnelPublicUrl = '';
  let activeStreams   = 0;
  const recentLatencies: number[] = [];
  const recentStatuses:  number[] = [];   // capped at 100, used for error-rate tile

  const targetStr = [setup.target, setup.port].filter(Boolean).join(':');
  const fwdMeta   = IS_PREVIEW
    ? `${setup.protocol} · node · my-api`
    : `${setup.protocol} · ${setup.target}`;
  fwdTile.value.content = targetStr || setup.target || '—';
  fwdTile.unit.content  = '';
  fwdTile.meta.content  = fwdMeta;

  function renderLog(): void {
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

  function renderLatency(): void {
    if (recentLatencies.length === 0) {
      latCur.val.content = '—';
      latAvg.val.content = '—';
      latP95.val.content = '—';
      latLast.val.content = '';
      sparkRef.content    = ' '.repeat(SPARK_WIDTH);
      return;
    }
    const cur = recentLatencies.at(-1)!;
    const avg = recentLatencies.reduce((s, v) => s + v, 0) / recentLatencies.length;
    const sorted = [...recentLatencies].sort((a, b) => a - b);
    const p95idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    const p95 = sorted[p95idx]!;
    latCur.val.content = `${Math.round(cur)}ms`;
    latAvg.val.content = `${Math.round(avg)}ms`;
    latP95.val.content = `${Math.round(p95)}ms`;
    latLast.val.content = '';
    sparkRef.content    = sparkline(recentLatencies, SPARK_WIDTH);
  }

  function renderTiles(): void {
    reqTile.value.content = fmtCount(requestCount);
    const uptimeMin = Math.max(1, (Date.now() - startedAt) / 60_000);
    const rpm = Math.round(requestCount / uptimeMin);
    reqTile.meta.content  = `~${rpm} / min`;

    actTile.value.content = String(activeStreams);
    actTile.unit.content  = activeStreams === 1 ? 'stream' : 'streams';
    actTile.meta.content  = totalStreams > 0
      ? `${fmtCount(totalStreams)} total · live connections`
      : 'live connections';

    const sentParts = fmtBytes(bytesSent).split(' ');
    sntTile.value.content = sentParts[0] ?? '0';
    sntTile.unit.content  = sentParts[1] ?? 'B';
    sntTile.meta.content  = `↓ ${fmtBytes(bytesRecv)} recv`;

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

  function pushEntry(entry: LogEntry): void {
    if (!live || paused) return;
    requestCount++;
    if (entry.size) bytesSent += entry.size;
    log.unshift(entry);
    if (log.length > MAX_LOG) log.pop();
    if (entry.latencyMs != null) {
      recentLatencies.push(entry.latencyMs);
      if (recentLatencies.length > MAX_LATENCY_SAMPLES) recentLatencies.shift();
    }
    if (entry.statusCode > 0) {
      recentStatuses.push(entry.statusCode);
      if (recentStatuses.length > 100) recentStatuses.shift();
    }
    renderLog();
    renderLatency();
    renderTiles();
  }

  function setConnected(url: string, region = 'sfo'): void {
    connected = true;
    connStatusRef.content = '● CONNECTED';
    connStatusRef.fg      = C.emerald;
    tunnelPublicUrl = url;
    urlRef.content = url;
    regionRef.content = `${region} · auto`;
  }

  function setDisconnected(reason: string, color: string = C.amber): void {
    connected = false;
    connStatusRef.content = `○ ${reason}`;
    connStatusRef.fg      = color;
    streamDot.fg          = color;
    streamLbl.content     = 'idle';
  }

  renderLog();
  renderLatency();
  renderTiles();

  const spin      = makeSpin('checking');
  const spinTimer = setInterval(() => {
    if (!live || connected) return;
    connStatusRef.content = `${spin()} CONNECTING`;
  }, 100);

  const clockTimer = setInterval(() => {
    if (!live) return;
    uptimeRef.content = fmtHms(Date.now() - startedAt);
    renderTiles();
  }, 1000);

  let ws: WebSocket | null = null;
  const sockets = new Map<number, net.Socket>();
  let previewTimer: ReturnType<typeof setInterval> | null = null;
  let previewActiveJitter: ReturnType<typeof setInterval> | null = null;

  const shutdown = (): void => {
    if (!live) return;
    live = false;
    clearInterval(spinTimer);
    clearInterval(clockTimer);
    if (previewTimer) clearInterval(previewTimer);
    if (previewActiveJitter) clearInterval(previewActiveJitter);
    for (const s of sockets.values()) s.destroy();
    sockets.clear();
    try { ws?.close(); } catch { /* ignore */ }
    const endedAt = Date.now();
    saveSession({
      id:         sessionId,
      type:       setup.protocol === 'http' ? 'tunnel-http' : 'tunnel-tcp',
      url:        tunnelPublicUrl,
      target:     targetStr,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      outcome:    'user-quit',
      spendUsd:   0,
      requests:   requestCount,
      bytesIn:    bytesRecv,
      bytesOut:   bytesSent,
    });
    renderer.destroy();
  };

  const inputDone = new Promise<void>(resolve => {
    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;
      if (key.name === 'c' || key.name === 'C') {
        log.splice(0);
        renderLog();
        return;
      }
      if (key.ctrl && key.name === 'c') { shutdown(); resolve(); return; }
      if (key.name === 'q' || key.name === 'Q' || key.name === 'b' || key.name === 'B') {
        shutdown(); resolve();
      }
    });
  });

  if (IS_PREVIEW) {
    const slug = crypto.createHash('sha1').update(`${setup.protocol}:${targetStr}`).digest('hex').slice(0, 4);
    const url  = setup.protocol === 'http'
      ? `https://t-${slug}.consensus.canister.software`
      : `tcp://t-${slug}.consensus.canister.software:${5000 + (parseInt(slug, 16) % 50_000)}`;

    setTimeout(() => {
      if (!live) return;
      setConnected(url, 'sfo');
      for (let i = 0; i < 8; i++) pushEntry(fakeEntry());
    }, 350);

    const schedule = (): void => {
      const wait = 400 + Math.random() * 1000;
      previewTimer = setTimeout(() => {
        if (!live) return;
        pushEntry(fakeEntry());
        bytesRecv += Math.floor(20_000 + Math.random() * 80_000);
        schedule();
      }, wait) as unknown as ReturnType<typeof setInterval>;
    };
    schedule();

    previewActiveJitter = setInterval(() => {
      if (!live) return;
      activeStreams = 1 + Math.floor(Math.random() * 4);
      renderTiles();
    }, 1800);

    await inputDone;
    return;
  }

  const tunnelDone = (async () => {
    let registration: {
      tunnelId: string; type: 'http' | 'tcp'; token: string;
      connect_url: string; public_url?: string; tcp_addr?: string;
    };

    try {
      const res = await fetch(`${SERVER}/tunnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: setup.protocol }),
      });
      if (!res.ok) {
        if (!live) return;
        setDisconnected(`${res.status} ${res.statusText}`, C.red);
        return;
      }
      registration = await res.json() as typeof registration;
    } catch (err) {
      if (!live) return;
      setDisconnected((err as Error).message, C.red);
      return;
    }

    if (!live) return;

    const publicUrl = registration.public_url ?? registration.tcp_addr ?? '';

    ws = new WebSocket(registration.connect_url, { perMessageDeflate: false });
    ws.binaryType = 'nodebuffer';

    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.on('open', () => {
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(encodeFrame(FRAME.PING, 0));
      }, 30_000);
    });

    ws.on('error', (err) => {
      if (!live) return;
      setDisconnected(err.message, C.red);
    });

    ws.on('close', () => {
      if (pingTimer) clearInterval(pingTimer);
      if (!live) return;
      setDisconnected('DISCONNECTED');
      for (const s of sockets.values()) s.destroy();
      sockets.clear();
      activeStreams = 0;
      renderTiles();
    });

    const pending = new Map<number, PendingStream>();
    let firstMsg = true;

    ws.on('message', (raw: Buffer) => {
      if (!live) return;
      bytesRecv += raw.length;

      if (firstMsg) {
        firstMsg = false;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'tunnel_open') setConnected(publicUrl);
        } catch { /* not JSON */ }
        return;
      }

      if (raw.length < 5 || raw[0] === 0x7b) return;
      const frame = decodeFrame(raw);

      if (frame.type === FRAME.PONG) return;
      if (frame.type === FRAME.PING) { ws?.send(encodeFrame(FRAME.PONG, 0)); return; }

      switch (frame.type) {

        case FRAME.STREAM_OPEN: {
          const host = setup.target;
          const port = setup.port ?? (setup.protocol === 'http' ? 80 : 0);

          if (setup.protocol === 'http') {
            const parsed = parseHttpRequestLine(frame.payload);
            if (parsed) {
              pending.set(frame.streamId, {
                method: parsed.method, path: parsed.path,
                startedAt: Date.now(), gotStatus: false,
                respBuf: Buffer.alloc(0), headersDone: false,
                contentLength: -1, bodyReceived: 0,
              });
            }
          } else {
            pushEntry({
              time:       fmtClock(Date.now()),
              method:     'TCP',
              path:       `stream #${frame.streamId}  →  ${host}:${port}`,
              statusCode: 0,
            });
          }

          const sock = net.createConnection({ host, port });


          sockets.set(frame.streamId, sock);
          activeStreams = sockets.size;
          totalStreams++;
          renderTiles();
          if (frame.payload.length > 0) sock.write(frame.payload);

          sock.on('data', (data: Buffer) => {
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(encodeFrame(FRAME.STREAM_DATA, frame.streamId, data));
            bytesSent += data.length;
            renderTiles();

            if (setup.protocol !== 'http') return;
            const p = pending.get(frame.streamId);
            if (!p) return;

            if (!p.gotStatus) {
              const code = parseHttpStatusCode(data);
              if (code) {
                p.gotStatus = true;
                pushEntry({
                  time:      fmtClock(Date.now()),
                  method:    p.method,
                  path:      p.path,
                  statusCode: code,
                  latencyMs: Date.now() - p.startedAt,
                  size:      0,        // updated when stream ends below
                });
              }
            }

            p.respBuf = Buffer.concat([p.respBuf, data]);
            if (!p.headersDone) {
              const sep = p.respBuf.indexOf('\r\n\r\n');
              if (sep !== -1) {
                p.headersDone = true;
                const headerText = p.respBuf.subarray(0, sep).toString();
                const clMatch    = headerText.match(/content-length:\s*(\d+)/i);
                p.contentLength  = clMatch ? parseInt(clMatch[1]!, 10) : -1;
                p.bodyReceived   = p.respBuf.length - sep - 4;
              }
            } else if (p.contentLength >= 0) {
              p.bodyReceived += data.length;
            }

            if (p.headersDone && p.contentLength >= 0 && p.bodyReceived >= p.contentLength) {
              const fresh = log[0];
              if (fresh && fresh.path === p.path) fresh.size = p.contentLength;
              renderLog();

              pending.delete(frame.streamId);
              sockets.delete(frame.streamId);
              activeStreams = sockets.size;
              renderTiles();
              sock.destroy();
              if (ws?.readyState === WebSocket.OPEN)
                ws.send(encodeFrame(FRAME.STREAM_END, frame.streamId));
            }
          });

          sock.on('end', () => {
            if (!sockets.has(frame.streamId)) return;
            pending.delete(frame.streamId);
            sockets.delete(frame.streamId);
            activeStreams = sockets.size;
            renderTiles();
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(encodeFrame(FRAME.STREAM_END, frame.streamId));
          });

          sock.on('close', () => {
            pending.delete(frame.streamId);
            sockets.delete(frame.streamId);
            activeStreams = sockets.size;
            renderTiles();
          });

          sock.on('error', () => {
            const p = pending.get(frame.streamId);
            if (p) {
              pushEntry({
                time:       fmtClock(Date.now()),
                method:     p.method,
                path:       p.path,
                statusCode: 502,
                latencyMs:  Date.now() - p.startedAt,
              });
            }
            pending.delete(frame.streamId);
            sockets.delete(frame.streamId);
            activeStreams = sockets.size;
            renderTiles();
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(encodeFrame(FRAME.STREAM_RESET, frame.streamId));
          });

          break;
        }

        case FRAME.STREAM_DATA: {
          const sock = sockets.get(frame.streamId);
          if (sock && !sock.destroyed) sock.write(frame.payload);

          // The server sends STREAM_OPEN with an empty payload and ships the
          // request bytes in the first STREAM_DATA frame. Parse the request
          // line out of that frame so the activity log / latency tracking
          // has a `pending` entry to attach the response to.
          if (setup.protocol === 'http' && !pending.has(frame.streamId)) {
            const parsed = parseHttpRequestLine(frame.payload);
            if (parsed) {
              pending.set(frame.streamId, {
                method: parsed.method, path: parsed.path,
                startedAt: Date.now(), gotStatus: false,
                respBuf: Buffer.alloc(0), headersDone: false,
                contentLength: -1, bodyReceived: 0,
              });
            }
          }
          break;
        }

        case FRAME.STREAM_END: {
          const sock = sockets.get(frame.streamId);
          if (sock) { sockets.delete(frame.streamId); sock.end(); activeStreams = sockets.size; renderTiles(); }
          pending.delete(frame.streamId);
          break;
        }

        case FRAME.STREAM_RESET: {
          const sock = sockets.get(frame.streamId);
          if (sock) { sockets.delete(frame.streamId); sock.destroy(); activeStreams = sockets.size; renderTiles(); }
          pending.delete(frame.streamId);
          break;
        }
      }
    });
  })();

  await inputDone;
  await tunnelDone.catch(() => {});
}
