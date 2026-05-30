
import { workerRegistry } from '../tui/screens/proxy/hub';
import { loadConfig, loadSessions, loadSpending, type SessionRecord } from './store';

export interface MetricTunnels {
  value:      number;     // currently active tunnels
  max:        number;     // tier-imposed cap (matches mockup default 4 today)
  peak:       number;     // highest `value` observed this session
  trendDelta: number;     // value delta over the trend window (last hour)
  trendLabel: string;     // "▲ 1 · 6h" / "▼ 2 · 6h" / "· 6h"
  spark:      number[];   // last N raw values
}

export interface MetricProxy {
  value:    number;       // current aggregate req/s across in-process workers
  cachePct: number | null;// cache hit %, null when not reported
  trendPct: number | null;// % vs trailing average ("▲ 12% avg")
  spark:    number[];
}

export interface MetricBandwidth {
  mbps:     number;       // total bytes/s over the last 1s window, in MB
  upMbps:   number;       // best-effort split — workers don't always distinguish
  downMbps: number;
  totalGb:  number;       // cumulative bytes since this TUI process started
  spark:    number[];
}

export interface MetricFreeTier {
  used:       number;     // requests counted today (UTC midnight reset)
  cap:        number;     // quota — 1000/day for the free tier
  resetHours: number;     // hours until midnight UTC
  hasCard:    boolean;    // payment method on file
}

export interface ServiceRow {
  /** Stable key for diffing across refreshes. */
  key:      string;
  type:     'tnl' | 'prx' | 'fwd' | 'ws' | 'idle';
  endpoint: string;
  reqs:     string;
  latency:  string;
  status:   'live' | 'recon' | 'idle';
}

export type ActivityKind =
  | 'tunnel-up' | 'tunnel-down'
  | 'proxy-started' | 'proxy-stopped'
  | 'ws-connect' | 'ws-disconnect'
  | 'lease-acquired'
  | 'charged'
  | 'reconnect'
  | 'http';

export interface ActivityRow {
  /** Epoch ms — used to sort and dedupe. */
  at:   number;
  time: string;           // HH:MM:SS
  kind: ActivityKind;
  glyph: string;
  glyphColor: string;     // semantic colour token (resolved via theme by caller)
  text: string;           // bold leading verb
  tail: string;           // dim detail
}

export interface DashboardSnapshot {
  metrics: {
    tunnels:   MetricTunnels;
    proxyRps:  MetricProxy;
    bandwidth: MetricBandwidth;
    freeTier:  MetricFreeTier;
  };
  services: ServiceRow[];
  activity: ActivityRow[];
}

// ─── Configurable constants ──────────────────────────────────────────────────

const SPARK_SAMPLES        = 8;           // sparkline length
const TREND_WINDOW_MS      = 60 * 60_000; // "▲ X · 1h" trend window
const SERVICE_SLOT_COUNT   = 5;           // pad the table to this many rows w/ `idle`
const ACTIVITY_FEED_LIMIT  = 9;           // matches RECENT ACTIVITY visible rows
const FREE_TIER_DAILY_CAP  = 1000;        // matches mockup 812 / 1k

// ─── Mutable in-memory state ─────────────────────────────────────────────────

interface History {
  tunnels:   number[];
  proxy:     number[];
  bandwidth: number[];
  /** Snapshot of last-read aggregate counters per worker, keyed by port,
   *  so we can compute per-second deltas without a global timestep tracker. */
  lastWorkerStats: Map<number, { requests: number; bytes: number; at: number }>;
  peakTunnels:     number;
  bytesSinceStart: number;
  trendWindow:     Array<{ at: number; tunnels: number; proxyRps: number }>;
}

const history: History = {
  tunnels:         [],
  proxy:           [],
  bandwidth:       [],
  lastWorkerStats: new Map(),
  peakTunnels:     0,
  bytesSinceStart: 0,
  trendWindow:     [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function push(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > SPARK_SAMPLES) arr.shift();
}

function fmtHms(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

function fmtReqs(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000)     return n.toLocaleString();
  return String(n);
}

function fmtLatency(ms: number | undefined): string {
  if (ms == null) return '—';
  if (ms < 1)     return '<1ms';
  if (ms < 1000)  return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function hoursUntilUtcMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0,
  ));
  return Math.max(0, Math.round((tomorrow.getTime() - now.getTime()) / 3_600_000));
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── The core compute ───────────────────────────────────────────────────────

export function computeSnapshot(): DashboardSnapshot {
  const now = Date.now();
  const sessions = loadSessions();
  const spending = loadSpending();
  const config   = loadConfig();

  // Active sessions = present in sessions.json without endedAt (or ended < 5s ago,
  // to absorb cleanup races). 5min cap to avoid showing stale crashed processes.
  const activeSessions = sessions.filter(s => {
    if (!s.endedAt && now - s.startedAt < 30 * 60_000) return true;
    if (s.endedAt && now - s.endedAt < 5_000)         return true;
    return false;
  });

  // ── Worker stats: aggregate req/s + bytes/s deltas ──────────────────────
  let totalReqs   = 0;
  let totalBytes  = 0;
  let totalReqsPerSec  = 0;
  let totalBytesPerSec = 0;
  const seenPorts = new Set<number>();

  for (const w of workerRegistry) {
    const s    = w.handle.stats();
    const port = w.handle.port;
    seenPorts.add(port);
    const reqs  = s.requests;
    const bytes = (s.bytesSent ?? 0) + (s.bytesRecv ?? 0);

    const last = history.lastWorkerStats.get(port);
    if (last) {
      const dtSec = Math.max(0.001, (now - last.at) / 1000);
      totalReqsPerSec  += Math.max(0, (reqs  - last.requests)) / dtSec;
      totalBytesPerSec += Math.max(0, (bytes - last.bytes))    / dtSec;
    }
    history.lastWorkerStats.set(port, { requests: reqs, bytes, at: now });
    totalReqs  += reqs;
    totalBytes += bytes;
  }
  // GC entries for workers that have disappeared
  for (const port of [...history.lastWorkerStats.keys()]) {
    if (!seenPorts.has(port)) history.lastWorkerStats.delete(port);
  }
  history.bytesSinceStart = Math.max(history.bytesSinceStart, totalBytes);

  // ── Tunnels metric ──────────────────────────────────────────────────────
  const tunnelsActive = activeSessions.filter(
    s => s.type === 'tunnel-http' || s.type === 'tunnel-tcp',
  ).length;
  history.peakTunnels = Math.max(history.peakTunnels, tunnelsActive);
  push(history.tunnels, tunnelsActive);

  // Trend over the last hour: compare current value to the earliest sample in
  // the trend window. Sample falls off after TREND_WINDOW_MS.
  history.trendWindow = history.trendWindow.filter(s => now - s.at <= TREND_WINDOW_MS);
  history.trendWindow.push({ at: now, tunnels: tunnelsActive, proxyRps: totalReqsPerSec });
  const oldest = history.trendWindow[0]!;
  const trendTunnels = tunnelsActive - oldest.tunnels;
  const trendHrs     = Math.max(1, Math.round((now - oldest.at) / 3_600_000));

  // ── Proxy metric ────────────────────────────────────────────────────────
  push(history.proxy, totalReqsPerSec);
  const avgProxy = history.proxy.length > 0
    ? history.proxy.reduce((a, b) => a + b, 0) / history.proxy.length
    : 0;
  const trendPct = avgProxy > 0
    ? Math.round(((totalReqsPerSec - avgProxy) / avgProxy) * 100)
    : null;

  // ── Bandwidth metric ────────────────────────────────────────────────────
  const mbps = totalBytesPerSec / (1024 * 1024);
  push(history.bandwidth, mbps);
  // We don't separately track in/out per worker today — split 50/50 as
  // best-effort. TODO: extend ProxyWorkerHandle stats to report direction.
  const upMbps   = mbps / 2;
  const downMbps = mbps / 2;
  const totalGb  = history.bytesSinceStart / (1024 ** 3);

  // ── Free tier ───────────────────────────────────────────────────────────
  const today = todayUtc();
  const usedToday = spending.entries.filter(e => e.date === today).length;

  // ── Services table ──────────────────────────────────────────────────────
  const rows: ServiceRow[] = [];

  // 1. In-process proxy workers — accurate live stats.
  for (const w of workerRegistry) {
    const s = w.handle.stats();
    rows.push({
      key:      `worker-${w.handle.port}`,
      type:     w.handle.type === 'forward' ? 'prx' : 'fwd',
      endpoint: w.label,
      reqs:     fmtReqs(s.requests),
      latency:  fmtLatency(s.avgLatencyMs),
      status:   'live',
    });
  }

  // 2. Cross-process sessions (tunnels, ws, etc.) from sessions.json.
  for (const s of activeSessions) {
    // Skip what we already have via workerRegistry to avoid double-listing.
    if (s.type === 'http-proxy' || s.type === 'reverse-proxy') continue;
    const type: ServiceRow['type'] =
      s.type === 'tunnel-http' || s.type === 'tunnel-tcp' ? 'tnl' :
      s.type === 'websocket'                              ? 'ws'  :
                                                            'tnl';
    rows.push({
      key:      `session-${s.id}`,
      type,
      endpoint: s.url || s.target,
      reqs:     s.requests != null ? fmtReqs(s.requests) : '—',
      latency:  '—',                       // sessions don't carry live latency yet
      status:   'live',
    });
  }

  // 3. Pad with idle slots so the table always shows SERVICE_SLOT_COUNT rows.
  while (rows.length < SERVICE_SLOT_COUNT) {
    rows.push({
      key:      `idle-${rows.length}`,
      type:     'idle',
      endpoint: `slot ${rows.length + 1}`,
      reqs:     '—',
      latency:  '—',
      status:   'idle',
    });
  }

  // ── Activity feed ───────────────────────────────────────────────────────
  // Derive from sessions (start/end) + spending (charges) + lease.
  // No real-time event stream yet — this is a periodic recomputation.
  const events: ActivityRow[] = [];

  const verb = (s: SessionRecord, when: 'start' | 'end'): string => {
    switch (s.type) {
      case 'tunnel-http': case 'tunnel-tcp':       return when === 'start' ? 'tunnel up'    : 'tunnel down';
      case 'http-proxy':                            return when === 'start' ? 'proxy started': 'proxy stopped';
      case 'reverse-proxy':                         return when === 'start' ? 'reverse proxy up' : 'reverse proxy down';
      case 'websocket':                             return when === 'start' ? 'ws connect'   : 'ws disconnect';
      default:                                      return when === 'start' ? 'service started' : 'service ended';
    }
  };
  const kindOf = (s: SessionRecord, when: 'start' | 'end'): ActivityKind => {
    if (s.type === 'tunnel-http' || s.type === 'tunnel-tcp')
      return when === 'start' ? 'tunnel-up' : 'tunnel-down';
    if (s.type === 'http-proxy' || s.type === 'reverse-proxy')
      return when === 'start' ? 'proxy-started' : 'proxy-stopped';
    if (s.type === 'websocket')
      return when === 'start' ? 'ws-connect' : 'ws-disconnect';
    return when === 'start' ? 'proxy-started' : 'proxy-stopped';
  };

  for (const s of sessions) {
    events.push({
      at:    s.startedAt,
      time:  fmtHms(s.startedAt),
      kind:  kindOf(s, 'start'),
      glyph: '●',
      glyphColor: 'emerald',
      text:  verb(s, 'start'),
      tail:  s.url || s.target,
    });
    if (s.endedAt) {
      events.push({
        at:    s.endedAt,
        time:  fmtHms(s.endedAt),
        kind:  kindOf(s, 'end'),
        glyph: '○',
        glyphColor: 'dim',
        text:  verb(s, 'end'),
        tail:  s.url || s.target,
      });
    }
  }

  for (const e of spending.entries) {
    // Spending entries have a date string but not a precise timestamp.
    // Use midday of that date as a stable sortable proxy.
    const at = new Date(`${e.date}T12:00:00Z`).getTime();
    events.push({
      at,
      time:  fmtHms(at),
      kind:  'charged',
      glyph: '$',
      glyphColor: 'emerald',
      text:  'charged',
      tail:  `$${e.amountUsd.toFixed(4)} · ${e.type}`,
    });
  }

  if (config.leased_node) {
    const at = new Date(config.leased_node.leased_at).getTime();
    events.push({
      at,
      time:  fmtHms(at),
      kind:  'lease-acquired',
      glyph: '⇄',
      glyphColor: 'accent',
      text:  'lease acquired',
      tail:  `${config.leased_node.domain}${config.leased_node.region ? ' · ' + config.leased_node.region : ''}`,
    });
  }

  events.sort((a, b) => b.at - a.at);
  const activity = events.slice(0, ACTIVITY_FEED_LIMIT);

  return {
    metrics: {
      tunnels: {
        value:      tunnelsActive,
        max:        4,
        peak:       history.peakTunnels,
        trendDelta: trendTunnels,
        trendLabel: trendTunnels === 0
          ? `· ${trendHrs}h`
          : `${trendTunnels > 0 ? '▲' : '▼'} ${Math.abs(trendTunnels)} · ${trendHrs}h`,
        spark:      [...history.tunnels],
      },
      proxyRps: {
        value:    Math.round(totalReqsPerSec),
        cachePct: null,                      // TODO: expose hit-rate from worker stats
        trendPct,
        spark:    [...history.proxy],
      },
      bandwidth: {
        mbps,
        upMbps,
        downMbps,
        totalGb,
        spark: [...history.bandwidth],
      },
      freeTier: {
        used:       usedToday,
        cap:        FREE_TIER_DAILY_CAP,
        resetHours: hoursUntilUtcMidnight(),
        hasCard:    false,                   // TODO: track payment method in config
      },
    },
    services: rows,
    activity,
  };
}

export function resetHistory(): void {
  history.tunnels         = [];
  history.proxy           = [];
  history.bandwidth       = [];
  history.lastWorkerStats.clear();
  history.peakTunnels     = 0;
  history.bytesSinceStart = 0;
  history.trendWindow     = [];
}

export { fmtReqs, fmtLatency, fmtHms };
