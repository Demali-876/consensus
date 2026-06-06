import {
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type RootRenderable,
} from '@opentui/core';
import { C } from '../../../theme';
import { makeBadge, termCols } from '../../chrome.ts';
import type { WorkerEntry } from './hub.js';

export const SPARK_WIDTH = 40;
export const APP_PANEL_WIDTH = 72;

export function fmtHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(2)} MB`;
}

export function fmtRate(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(1)} B/s`;
  if (bps < 1_048_576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1_048_576).toFixed(1)} MB/s`;
}

export function fmtLatency(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

export function fmtAgo(at?: number): string {
  if (!at) return 'never';
  const elapsed = Date.now() - at;
  if (elapsed < 60_000) return `${Math.max(1, Math.floor(elapsed / 1000))}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  return `${Math.floor(elapsed / 3_600_000)}h`;
}

export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString();
}

export function pct(n: number): string {
  return `${Math.round(n)}%`;
}

export function statusText(status?: number): string {
  if (status == null) return '—';
  if (status >= 200 && status < 400) return 'success';
  if (status >= 400 && status < 500) return 'client error';
  if (status >= 500) return 'server error';
  return 'status';
}

export function statusFg(status?: number): string {
  if (status == null) return C.slate;
  if (status >= 200 && status < 400) return C.emerald;
  if (status >= 400) return C.red;
  return C.slate;
}

export function successRate(outcomes: boolean[] | undefined): number {
  const items = outcomes ?? [];
  if (items.length === 0) return 100;
  return (items.filter(Boolean).length / items.length) * 100;
}

export function sparkline(values: number[], width = SPARK_WIDTH): string {
  const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
  const window = values.length >= width
    ? values.slice(-width)
    : Array(width - values.length).fill(0).concat(values);
  const max = Math.max(...window, 1);
  return window
    .map((value) => value <= 0
      ? bars[0]
      : bars[Math.min(bars.length - 1, Math.floor((value / max) * (bars.length - 1)))]!)
    .join('');
}

export function budgetBar(spent: number, budget: number, width = 22): string {
  const fill = Math.max(0, Math.min(width, Math.round((spent / Math.max(budget, 0.01)) * width)));
  return '━'.repeat(fill) + '─'.repeat(width - fill);
}

export function compactPath(path: string | undefined, max = 46): string {
  if (!path) return '—';
  const cwd = process.cwd();
  const normalized = path.startsWith(cwd) ? `~${path.slice(cwd.length)}` : path;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export type MetricRefs = {
  box: BoxRenderable;
  title: TextRenderable;
  value: TextRenderable;
  unit: TextRenderable;
  meta: TextRenderable;
  width: number;
  sub?: TextRenderable;
};

function makeMetricCard(renderer: CliRenderer, title: string, valueFg: string, width: number): MetricRefs {
  const box = new BoxRenderable(renderer, {
    width, height: 6, flexDirection: 'column', paddingX: 2, paddingY: 0,
    border: true, borderStyle: 'single', borderColor: C.line2, backgroundColor: C.dark,
  });
  const titleRef = new TextRenderable(renderer, {
    content: title.toUpperCase(), height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const valueRow = new BoxRenderable(renderer, {
    width: '100%', height: 1, flexDirection: 'row', gap: 0, alignItems: 'flex-end', backgroundColor: C.dark,
  });
  const value = new TextRenderable(renderer, { content: '—', fg: valueFg, bg: C.dark, attributes: TextAttributes.BOLD });
  const unit = new TextRenderable(renderer, { content: '', fg: valueFg, bg: C.dark, attributes: TextAttributes.BOLD });
  valueRow.add(value);
  valueRow.add(unit);
  const meta = new TextRenderable(renderer, { content: ' ', height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD });
  box.add(titleRef);
  box.add(valueRow);
  box.add(meta);
  return { box, title: titleRef, value, unit, meta, width };
}

function makeBudgetMetricCard(renderer: CliRenderer, width: number, budgetAmount?: number): MetricRefs {
  const box = new BoxRenderable(renderer, {
    width, height: 6, flexDirection: 'column', paddingX: 2, paddingY: 0,
    border: true, borderStyle: 'single', borderColor: C.line2, backgroundColor: C.dark,
  });
  const titleRef = new TextRenderable(renderer, {
    content: budgetAmount != null && budgetAmount > 0 ? `BUDGET · $${budgetAmount.toFixed(2)}` : 'BUDGET',
    height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const value = new TextRenderable(renderer, { content: '—', height: 1, fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
  const unit = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
  const meta = new TextRenderable(renderer, { content: ' ', height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD });
  box.add(titleRef);
  box.add(value);
  box.add(meta);
  return { box, title: titleRef, value, unit, meta, width };
}

export type LatencyRefs = {
  box: BoxRenderable;
  spark: TextRenderable;
  current: TextRenderable;
  avg: TextRenderable;
  p95: TextRenderable;
  samples: TextRenderable;
};

export function makeLatencyPanel(renderer: CliRenderer): LatencyRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%', height: 9, flexDirection: 'column', paddingX: 2, paddingY: 1,
    border: true, borderStyle: 'single', borderColor: C.emerald, title: ' LATENCY · LAST 40 ', backgroundColor: C.dark,
  });
  const spacer = new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark });
  const spark = new TextRenderable(renderer, { content: ' '.repeat(SPARK_WIDTH), fg: C.emerald, bg: C.dark });
  const stats = new BoxRenderable(renderer, { flexDirection: 'row', gap: 4, backgroundColor: C.dark });
  const mkPair = (label: string): TextRenderable => {
    const group = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
    group.add(new TextRenderable(renderer, { content: label, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    const value = new TextRenderable(renderer, { content: '—', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
    group.add(value);
    stats.add(group);
    return value;
  };
  const current = mkPair('CURRENT');
  const avg = mkPair('AVG');
  const p95 = mkPair('P95');
  const samples = mkPair('SAMPLES');
  box.add(spacer);
  box.add(spark);
  box.add(stats);
  return { box, spark, current, avg, p95, samples };
}

export type ThroughputRefs = {
  box: BoxRenderable;
  sent: TextRenderable;
  received: TextRenderable;
  sentRate: TextRenderable;
  receivedRate: TextRenderable;
};

export function makeThroughputPanel(renderer: CliRenderer): ThroughputRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%', height: 7, flexDirection: 'column', paddingX: 2, paddingY: 1,
    border: true, borderStyle: 'single', borderColor: C.line2, title: ' THROUGHPUT ', backgroundColor: C.dark,
  });
  const columns = new BoxRenderable(renderer, { flexDirection: 'row', gap: 5, backgroundColor: C.dark });
  const mkColumn = (label: string): { value: TextRenderable; rate: TextRenderable } => {
    const col = new BoxRenderable(renderer, { flexDirection: 'column', backgroundColor: C.dark });
    col.add(new TextRenderable(renderer, { content: label, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    const value = new TextRenderable(renderer, { content: '—', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
    const rate = new TextRenderable(renderer, { content: '—', fg: C.emerald, bg: C.dark });
    col.add(value);
    col.add(rate);
    columns.add(col);
    return { value, rate };
  };
  const sent = mkColumn('↑ SENT');
  const received = mkColumn('↓ RECEIVED');
  box.add(columns);
  return { box, sent: sent.value, sentRate: sent.rate, received: received.value, receivedRate: received.rate };
}

export type ChecksRefs = {
  box: BoxRenderable;
  cells: TextRenderable[];
  summary: TextRenderable;
};

export function makeChecksPanel(renderer: CliRenderer): ChecksRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%', height: 6, flexDirection: 'column', paddingX: 2, paddingY: 1,
    border: true, borderStyle: 'single', borderColor: C.line2, title: ' RECENT CHECKS ', backgroundColor: C.dark,
  });
  const strip = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
  const cells: TextRenderable[] = [];
  for (let i = 0; i < SPARK_WIDTH; i++) {
    const cell = new TextRenderable(renderer, { content: '■', fg: C.line2, bg: C.dark });
    strip.add(cell);
    cells.push(cell);
  }
  const summary = new TextRenderable(renderer, {
    content: '0 ok · 0 failed · last 40 health probes', fg: C.dim, bg: C.dark,
  });
  box.add(strip);
  box.add(summary);
  return { box, cells, summary };
}

export type AppRefs = {
  box: BoxRenderable;
  statusChip: TextRenderable;
  statusChipBox: BoxRenderable;
  pid: TextRenderable;
  probe: TextRenderable;
  launch: TextRenderable;
  fetchMode: TextRenderable;
  preload: TextRenderable;
  routing: TextRenderable;
  node: TextRenderable;
};

export function makeAppControlPanel(renderer: CliRenderer, width: number | '100%' = APP_PANEL_WIDTH): AppRefs {
  const box = new BoxRenderable(renderer, {
    width, height: 21, flexDirection: 'column', paddingX: 2, paddingY: 1,
    border: true, borderStyle: 'single', borderColor: C.line2, title: ' APP CONTROL ', backgroundColor: C.dark,
  });

  const mkRow = (label: string): TextRenderable => {
    const row = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
    row.add(new TextRenderable(renderer, { content: label.padEnd(12), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    const value = new TextRenderable(renderer, { content: '—', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
    row.add(value);
    box.add(row);
    return value;
  };

  const statusRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
  statusRow.add(new TextRenderable(renderer, { content: 'APP STATUS'.padEnd(12), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const statusChipBox = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1, border: true, borderStyle: 'single', borderColor: C.emerald, backgroundColor: C.dark,
  });
  const statusChip = new TextRenderable(renderer, { content: '• idle', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD });
  statusChipBox.add(statusChip);
  const pid = new TextRenderable(renderer, { content: 'pid —', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
  statusRow.add(statusChipBox);
  statusRow.add(pid);
  box.add(statusRow);

  const probe = mkRow('LAST PROBE');
  const launch = mkRow('LAUNCH CMD');
  const fetchMode = mkRow('FETCH MODE');
  const preload = mkRow('PRELOAD');
  const routing = mkRow('ROUTING');
  const node = mkRow('NODE');

  const buttons = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, paddingTop: 1, backgroundColor: C.dark });
  const relaunch = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, paddingX: 1, border: true, borderStyle: 'single', borderColor: C.emerald, backgroundColor: C.dark,
  });
  relaunch.add(makeBadge(renderer, 'L', { bg: C.emerald }).box);
  relaunch.add(new TextRenderable(renderer, { content: 'relaunch app', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD }));
  const test = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, paddingX: 1, border: true, borderStyle: 'single', borderColor: C.line2, backgroundColor: C.dark,
  });
  test.add(makeBadge(renderer, 'T', { bg: C.slate }).box);
  test.add(new TextRenderable(renderer, { content: 'test probe', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD }));
  buttons.add(relaunch);
  buttons.add(test);
  box.add(buttons);

  return { box, statusChip, statusChipBox, pid, probe, launch, fetchMode, preload, routing, node };
}

export function addStatusStrip(
  renderer: CliRenderer,
  root: RootRenderable,
  entry: WorkerEntry,
  isForward: boolean,
): { state: TextRenderable; center: TextRenderable; uptime: TextRenderable } {
  const wrapper = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });
  const strip = new BoxRenderable(renderer, {
    flexGrow: 1, height: 3, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingX: 2,
    border: true, borderStyle: 'single', borderColor: C.line2, backgroundColor: C.panel,
  });
  const state = new TextRenderable(renderer, { content: '● RUNNING', fg: C.emerald, bg: C.panel, attributes: TextAttributes.BOLD });
  const center = new TextRenderable(renderer, {
    content: isForward
      ? `app ${entry.appPort ? `:${entry.appPort}` : '—'} → consensus · preload`
      : `upstream ${entry.label || 'localhost:3000'} → proxy :${entry.handle.port} · cached`,
    fg: C.slate, bg: C.panel, attributes: TextAttributes.BOLD,
  });
  const uptime = new TextRenderable(renderer, { content: 'uptime 00:00:00', fg: C.slate, bg: C.panel, attributes: TextAttributes.BOLD });
  strip.add(state);
  strip.add(center);
  strip.add(uptime);
  wrapper.add(strip);
  root.add(wrapper);
  return { state, center, uptime };
}

export type MetricRowRefs = {
  requests: MetricRefs;
  status: MetricRefs;
  cache: MetricRefs;
  success: MetricRefs;
  spend: MetricRefs | null;
  budget: MetricRefs | null;
};

export function addMetricRows(
  renderer: CliRenderer,
  root: RootRenderable,
  isForward: boolean,
  freeMode: boolean,
  budgetAmount?: number,
): MetricRowRefs {
  const cols = termCols();
  const cardCount = freeMode ? 4 : 5;
  const totalGaps = 2 * (cardCount - 1);
  const cardWidth = Math.max(20, Math.min(31, Math.floor((cols - 4 - totalGaps) / cardCount)));
  const row = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2, paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });
  const requests = makeMetricCard(renderer, 'REQUESTS', C.amber, cardWidth);
  const status = makeMetricCard(renderer, 'LAST STATUS', C.emerald, cardWidth);
  const cache = makeMetricCard(renderer, 'CACHE HITS', isForward ? C.slate : C.white, cardWidth);
  const success = makeMetricCard(renderer, 'SUCCESS RATE', C.emerald, cardWidth);
  const spend = freeMode ? null : makeMetricCard(renderer, 'SPEND', C.white, cardWidth);
  const budget = freeMode ? null : makeBudgetMetricCard(renderer, cardWidth, budgetAmount);

  row.add(requests.box);
  row.add(status.box);
  row.add(cache.box);
  if (spend && budget) {
    row.add(spend.box);
    row.add(budget.box);
  } else {
    row.add(success.box);
  }
  root.add(row);

  if (spend && budget) {
    const row2 = new BoxRenderable(renderer, {
      width: '100%', flexDirection: 'row', gap: 2, paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
    });
    row2.add(success.box);
    root.add(row2);
  }

  return { requests, status, cache, success, spend, budget };
}

export function updateMetric(card: MetricRefs, value: string, unit = '', meta = '', valueFg?: string): void {
  card.value.content = value;
  card.unit.content = unit;
  card.meta.content = meta || ' ';
  if (valueFg) {
    card.value.fg = valueFg;
    card.unit.fg = valueFg;
  }
}

export function updateChecks(panel: ChecksRefs, outcomes: boolean[] | undefined): void {
  const items = outcomes ?? [];
  const padded = items.length >= SPARK_WIDTH
    ? items.slice(-SPARK_WIDTH)
    : Array(SPARK_WIDTH - items.length).fill(true).concat(items);
  for (let i = 0; i < SPARK_WIDTH; i++) {
    const ok = padded[i] !== false;
    panel.cells[i]!.fg = ok ? C.emerald : C.amber;
  }
  const checks = items.length === 0 ? 0 : Math.min(items.length, SPARK_WIDTH);
  const actualFailed = (items.slice(-SPARK_WIDTH)).filter((ok) => !ok).length;
  const okCount = Math.max(0, checks - actualFailed);
  panel.summary.content = `${okCount} ok · ${actualFailed} failed · last 40 health probes`;
}
