import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../theme';
import type {
  DashboardSnapshot,
  ServiceRow,
  ActivityRow,
  MetricTunnels, MetricProxy, MetricBandwidth, MetricFreeTier,
} from '../../lib/dashboard-state';

// ─── Constants ──────────────────────────────────────────────────────────────

const SPARK_BARS = ['▁','▂','▃','▄','▅','▆','▇','█'] as const;
const SPARK_WIDTH = 8;
const PROGRESS_WIDTH = 30;
const SERVICE_SLOT_COUNT = 5;
const ACTIVITY_LIMIT = 9;

const TYPE_COLORS: Record<ServiceRow['type'], string> = {
  tnl:  C.emerald,
  prx:  C.amber,
  fwd:  C.accent,
  ws:   C.red,
  idle: C.dim,
};

const METRIC_COLORS = {
  tunnels:   C.emerald,
  proxy:     C.accent,
  bandwidth: C.amber,
  freeTier:  C.emerald,
} as const;

// ─── Sparkline + progress bar rendering ─────────────────────────────────────

function sparkline(values: number[], width = SPARK_WIDTH): string {
  if (values.length === 0) return ' '.repeat(width);
  // Pad-left so a half-full history still right-aligns.
  const padded = values.length >= width
    ? values.slice(-width)
    : Array(width - values.length).fill(0).concat(values);
  const max = Math.max(...padded, 1);
  return padded
    .map(v => {
      if (v <= 0) return SPARK_BARS[0]!;
      const idx = Math.min(SPARK_BARS.length - 1, Math.floor((v / max) * (SPARK_BARS.length - 1)));
      return SPARK_BARS[idx]!;
    })
    .join('');
}

function progressBar(used: number, cap: number, width = PROGRESS_WIDTH): string {
  const ratio  = Math.max(0, Math.min(1, used / Math.max(1, cap)));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

interface TileRefs {
  value:     TextRenderable;
  unit:      TextRenderable;
  spark:     TextRenderable;
  footLeft:  TextRenderable;
  footRight: TextRenderable;
}

function makeMetricTile(
  renderer: CliRenderer,
  title: string,
  valueColor: string,
  sparkColor: string,
): { box: BoxRenderable; refs: TileRefs } {
  const tile = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.line2,
    padding: 1, backgroundColor: C.dark,
  });

  tile.add(new TextRenderable(renderer, {
    content: title, fg: C.dim, bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  tile.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  const numberRow = new BoxRenderable(renderer, {
    flexDirection: 'row', alignItems: 'flex-end', gap: 1,
    backgroundColor: C.dark,
  });
  const value = new TextRenderable(renderer, {
    content: '0', fg: valueColor, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const unit = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.dark,
  });
  numberRow.add(value);
  numberRow.add(unit);
  tile.add(numberRow);

  const spark = new TextRenderable(renderer, {
    content: '', fg: sparkColor, bg: C.dark,
  });
  tile.add(spark);
  tile.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  const footRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: C.dark,
  });
  const footLeft  = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  const footRight = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  footRow.add(footLeft);
  footRow.add(footRight);
  tile.add(footRow);

  return { box: tile, refs: { value, unit, spark, footLeft, footRight } };
}

// Per-metric updaters bake in the unit formatting and footer layout.
function updateTunnelsTile(refs: TileRefs, m: MetricTunnels): void {
  refs.value.content     = String(m.value);
  refs.unit.content      = `/${m.max}`;
  refs.spark.content     = sparkline(m.spark);
  refs.footLeft.content  = `peak · ${m.peak}`;
  refs.footRight.content = m.trendLabel;
}

function updateProxyTile(refs: TileRefs, m: MetricProxy): void {
  refs.value.content     = String(m.value);
  refs.unit.content      = '/s';
  refs.spark.content     = sparkline(m.spark);
  refs.footLeft.content  = m.cachePct != null ? `cache · ${m.cachePct}%` : 'cache · —';
  refs.footRight.content = m.trendPct == null
    ? '· avg'
    : `${m.trendPct >= 0 ? '▲' : '▼'} ${Math.abs(m.trendPct)}% avg`;
}

function updateBandwidthTile(refs: TileRefs, m: MetricBandwidth): void {
  refs.value.content     = m.mbps >= 10 ? m.mbps.toFixed(1) : m.mbps.toFixed(2);
  refs.unit.content      = 'MB/s';
  refs.spark.content     = sparkline(m.spark);
  refs.footLeft.content  = `↑${m.upMbps.toFixed(1)} ↓${m.downMbps.toFixed(1)}`;
  refs.footRight.content = m.totalGb >= 1
    ? `${m.totalGb.toFixed(1)} GB`
    : `${(m.totalGb * 1024).toFixed(1)} MB`;
}

function updateFreeTierTile(refs: TileRefs, m: MetricFreeTier): void {
  refs.value.content     = String(m.used);
  refs.unit.content      = `/${m.cap >= 1000 ? `${Math.round(m.cap / 1000)}k` : m.cap}`;
  refs.spark.content     = progressBar(m.used, m.cap);
  refs.footLeft.content  = `resets · ${m.resetHours}h`;
  refs.footRight.content = m.hasCard ? 'card on file' : 'no card';
}

function makeTypeBadge(renderer: CliRenderer): {
  box:      BoxRenderable;
  label:    TextRenderable;
  setType: (type: ServiceRow['type']) => void;
} {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1,
    backgroundColor: C.dark,
    border:      ['top', 'right', 'bottom', 'left'],
    borderColor: TYPE_COLORS.tnl,
    borderStyle: 'rounded',
  });
  const label = new TextRenderable(renderer, {
    content: 'tnl', fg: TYPE_COLORS.tnl, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  box.add(label);

  const setType = (type: ServiceRow['type']): void => {
    const color = TYPE_COLORS[type];
    box.borderColor = color;
    label.content   = type;
    label.fg        = color;
  };

  return { box, label, setType };
}

interface ServiceRowRefs {
  box:      BoxRenderable;
  num:      TextRenderable;
  badge:    { box: BoxRenderable; label: TextRenderable; setType: (t: ServiceRow['type']) => void };
  endpoint: TextRenderable;
  reqs:     TextRenderable;
  latency:  TextRenderable;
  status:   TextRenderable;
  /** Backing snapshot row, used by the caller to identify "open this service". */
  data:     ServiceRow;
}

const SCOLS = { num: 3, type: 6, endpoint: 40, reqs: 8, latency: 8, status: 10 };

function buildServicesPanel(
  renderer: CliRenderer,
  parent: BoxRenderable,
): { rows: ServiceRowRefs[] } {
  const panel = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.line2,
    title: ' ACTIVE SERVICES ', padding: 1,
    gap: 1,
    backgroundColor: C.dark,
  });

  const header = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, paddingLeft: 2,
    backgroundColor: C.dark,
  });
  const mkHead = (text: string, width: number, align: 'left' | 'right' = 'left') => {
    const content = align === 'right' ? text.padStart(width) : text.padEnd(width);
    header.add(new TextRenderable(renderer, {
      content, fg: C.dim, bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
  };
  mkHead('#',        SCOLS.num);
  mkHead('TYPE',     SCOLS.type);
  mkHead('ENDPOINT', SCOLS.endpoint);
  mkHead('REQS',     SCOLS.reqs,    'right');
  mkHead('LATENCY',  SCOLS.latency, 'right');
  mkHead('STATUS',   SCOLS.status);
  panel.add(header);

  // Pre-allocate row refs for the maximum slot count. We mutate their
  // contents in update() rather than rebuilding the tree.
  const rows: ServiceRowRefs[] = [];
  for (let i = 0; i < SERVICE_SLOT_COUNT; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, alignItems: 'center',
      paddingLeft: 1,
      border: ['left'],
      borderColor: C.dark,
      backgroundColor: C.dark,
    });
    const num      = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const badge    = makeTypeBadge(renderer);
    const endpoint = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.dark });
    const reqs     = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const latency  = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const status   = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.dark });
    row.add(num);
    row.add(badge.box);
    row.add(endpoint);
    row.add(reqs);
    row.add(latency);
    row.add(status);
    panel.add(row);

    rows.push({
      box: row, num, badge, endpoint, reqs, latency, status,
      // Placeholder until first update() call.
      data: { key: '', type: 'idle', endpoint: '', reqs: '—', latency: '—', status: 'idle' },
    });
  }

  parent.add(panel);
  return { rows };
}

function updateServicesRows(rows: ServiceRowRefs[], data: ServiceRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const s = data[i] ?? { key: `idle-${i}`, type: 'idle' as const, endpoint: `slot ${i + 1}`, reqs: '—', latency: '—', status: 'idle' as const };
    r.data = s;

    const isIdle = s.type === 'idle';
    r.num.content      = (isIdle ? '—' : String(i + 1)).padEnd(SCOLS.num);
    r.num.fg           = isIdle ? C.dim : C.slate;

    r.badge.setType(s.type);

    r.endpoint.content = s.endpoint.padEnd(SCOLS.endpoint);
    r.endpoint.fg      = isIdle ? C.dim : C.white;

    r.reqs.content     = s.reqs.padStart(SCOLS.reqs);
    r.reqs.fg          = isIdle ? C.dim : C.slate;

    r.latency.content  = s.latency.padStart(SCOLS.latency);
    r.latency.fg       = isIdle ? C.dim : C.slate;

    const glyph = s.status === 'live'  ? '● live'
                : s.status === 'recon' ? '○ recon'
                :                        '—';
    r.status.content   = glyph.padEnd(SCOLS.status);
    r.status.fg        = s.status === 'live'  ? C.emerald
                       : s.status === 'recon' ? C.amber
                       :                        C.dim;
  }
}


interface ActivityRowRefs {
  box:   BoxRenderable;
  time:  TextRenderable;
  glyph: TextRenderable;
  text:  TextRenderable;
  tail:  TextRenderable;
}

function resolveActivityColor(token: string): string {
  switch (token) {
    case 'emerald': return C.emerald;
    case 'amber':   return C.amber;
    case 'accent':  return C.accent;
    case 'red':     return C.red;
    case 'dim':     return C.dim;
    default:        return C.slate;
  }
}

function buildActivityPanel(
  renderer: CliRenderer,
  parent: BoxRenderable,
): { rows: ActivityRowRefs[] } {
  const panel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.line2,
    title: ' RECENT ACTIVITY ', padding: 1,
    backgroundColor: C.dark,
  });

  const rows: ActivityRowRefs[] = [];
  for (let i = 0; i < ACTIVITY_LIMIT; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, alignItems: 'center',
      backgroundColor: C.dark,
    });
    const time  = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.dark });
    const glyph = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.dark, attributes: TextAttributes.BOLD });
    const text  = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD });
    const tail  = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    row.add(time); row.add(glyph); row.add(text); row.add(tail);
    panel.add(row);
    rows.push({ box: row, time, glyph, text, tail });
  }

  parent.add(panel);
  return { rows };
}

function updateActivityRows(rows: ActivityRowRefs[], data: ActivityRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const a = data[i];
    if (!a) {
      r.time.content  = '';
      r.glyph.content = '';
      r.text.content  = '';
      r.tail.content  = '';
      continue;
    }
    r.time.content  = a.time;
    r.glyph.content = a.glyph;
    r.glyph.fg      = resolveActivityColor(a.glyphColor);
    r.text.content  = a.text;
    r.tail.content  = a.tail;
  }
}


export interface ActiveDashboard {
  /** Count of selectable rows in the services table (incl. the idle row). */
  rowCount: number;
  /** Highlight a specific row by toggling its left selection bar. */
  setSelection(idx: number): void;
  /** Re-paint metric values, services rows, and activity feed. */
  update(snapshot: DashboardSnapshot): void;
  /** Returns the service row at the given index, for "open service" navigation. */
  getServiceAt(idx: number): ServiceRow | null;
}

export function buildActiveBody(
  renderer: CliRenderer,
  body: BoxRenderable,
  initial: DashboardSnapshot,
): ActiveDashboard {
  const metricRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2,
    backgroundColor: C.dark,
  });
  const tunnels   = makeMetricTile(renderer, 'TUNNELS ACTIVE', METRIC_COLORS.tunnels,   METRIC_COLORS.tunnels);
  const proxy     = makeMetricTile(renderer, 'PROXY REQ/SEC',  METRIC_COLORS.proxy,     METRIC_COLORS.proxy);
  const bandwidth = makeMetricTile(renderer, 'BANDWIDTH',      METRIC_COLORS.bandwidth, METRIC_COLORS.bandwidth);
  const freeTier  = makeMetricTile(renderer, 'FREE TIER',      METRIC_COLORS.freeTier,  METRIC_COLORS.freeTier);
  metricRow.add(tunnels.box);
  metricRow.add(proxy.box);
  metricRow.add(bandwidth.box);
  metricRow.add(freeTier.box);
  body.add(metricRow);

  const bottomRow = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2,
    paddingTop: 1, backgroundColor: C.dark,
  });
  const services = buildServicesPanel(renderer, bottomRow);
  const activity = buildActivityPanel(renderer, bottomRow);
  body.add(bottomRow);

  // Selection state
  const setSelection = (idx: number): void => {
    const max     = services.rows.length - 1;
    const clamped = Math.max(0, Math.min(max, idx));
    for (let i = 0; i < services.rows.length; i++) {
      services.rows[i]!.box.borderColor = i === clamped ? C.accent : C.dark;
    }
  };

  const update = (snapshot: DashboardSnapshot): void => {
    updateTunnelsTile  (tunnels.refs,   snapshot.metrics.tunnels);
    updateProxyTile    (proxy.refs,     snapshot.metrics.proxyRps);
    updateBandwidthTile(bandwidth.refs, snapshot.metrics.bandwidth);
    updateFreeTierTile (freeTier.refs,  snapshot.metrics.freeTier);
    updateServicesRows (services.rows,  snapshot.services);
    updateActivityRows (activity.rows,  snapshot.activity);
  };

  // Initial paint + default selection
  update(initial);
  setSelection(0);

  return {
    rowCount: services.rows.length,
    setSelection,
    update,
    getServiceAt: (idx) => services.rows[idx]?.data ?? null,
  };
}
