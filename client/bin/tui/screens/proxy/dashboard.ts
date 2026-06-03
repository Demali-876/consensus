// proxy-dashboard.ts - Live stats dashboard for a running proxy worker.

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type RootRenderable,
} from '@opentui/core';
import {
  launchManagedApp,
  probeManagedApp,
  probeManagedAppUntilReady,
  stopManagedApp,
} from '../../../lib/app-manager.js';
import { writeTraceLog } from '../../../lib/crash-log';
import { isFreeMode } from '../../../lib/server-config';
import { loadConfig, loadPrefs, saveSession, recordSpend } from '../../../lib/store.ts';
import { C } from '../../../theme';
import type { WorkerEntry } from './hub.js';
import type { WorkerStats } from '../../../../src/proxy-worker.js';

const VERSION = '2.4.1';
const SPARK_WIDTH = 40;
const APP_PANEL_WIDTH = 72;

function terminalColumns(): number {
  return Math.max(96, process.stdout.columns || 168);
}

function fmtHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(2)} MB`;
}

function fmtRate(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(1)} B/s`;
  if (bps < 1_048_576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1_048_576).toFixed(1)} MB/s`;
}

function fmtLatency(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

function fmtAgo(at?: number): string {
  if (!at) return 'never';
  const elapsed = Date.now() - at;
  if (elapsed < 60_000) return `${Math.max(1, Math.floor(elapsed / 1000))}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  return `${Math.floor(elapsed / 3_600_000)}h`;
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString();
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function shortAcct(): string {
  const prefs = loadPrefs();
  const config = loadConfig();
  const evm = config.addresses?.evm;
  return prefs.displayName
    || config.wallet_name
    || (evm ? `${evm.slice(0, 6)}…${evm.slice(-4)}` : 'guest');
}

function statusText(status?: number): string {
  if (status == null) return '—';
  if (status >= 200 && status < 400) return 'success';
  if (status >= 400 && status < 500) return 'client error';
  if (status >= 500) return 'server error';
  return 'status';
}

function statusFg(status?: number): string {
  if (status == null) return C.slate;
  if (status >= 200 && status < 400) return C.emerald;
  if (status >= 400) return C.red;
  return C.slate;
}

function successRate(outcomes: boolean[] | undefined): number {
  const items = outcomes ?? [];
  if (items.length === 0) return 100;
  return (items.filter(Boolean).length / items.length) * 100;
}

function sparkline(values: number[], width = SPARK_WIDTH): string {
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

function budgetBar(spent: number, budget: number, width = 22): string {
  const fill = Math.max(0, Math.min(width, Math.round((spent / Math.max(budget, 0.01)) * width)));
  return '━'.repeat(fill) + '─'.repeat(width - fill);
}

function compactPath(path: string | undefined, max = 46): string {
  if (!path) return '—';
  const cwd = process.cwd();
  const normalized = path.startsWith(cwd) ? `~${path.slice(cwd.length)}` : path;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function makeBadge(
  renderer: CliRenderer,
  text: string,
  opts: { bg: string; fg?: string } = { bg: C.slate },
): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row',
    paddingX: 1,
    backgroundColor: opts.bg,
  });
  box.add(new TextRenderable(renderer, {
    content: text,
    fg: opts.fg ?? C.dark,
    bg: opts.bg,
    attributes: TextAttributes.BOLD,
  }));
  return box;
}

type MetricRefs = {
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
    width,
    height: 6,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 0,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    backgroundColor: C.dark,
  });
  const titleRef = new TextRenderable(renderer, {
    content: title.toUpperCase(),
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const valueRow = new BoxRenderable(renderer, {
    width: '100%',
    height: 1,
    flexDirection: 'row',
    gap: 0,
    alignItems: 'flex-end',
    backgroundColor: C.dark,
  });
  const value = new TextRenderable(renderer, {
    content: '—',
    fg: valueFg,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const unit = new TextRenderable(renderer, {
    content: '',
    fg: valueFg,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  valueRow.add(value);
  valueRow.add(unit);
  const meta = new TextRenderable(renderer, {
    content: ' ',
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  box.add(titleRef);
  box.add(valueRow);
  box.add(meta);
  return { box, title: titleRef, value, unit, meta, width };
}

function makeBudgetMetricCard(renderer: CliRenderer, width: number, budgetAmount?: number): MetricRefs {
  const box = new BoxRenderable(renderer, {
    width,
    height: 6,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 0,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    backgroundColor: C.dark,
  });
  const titleRef = new TextRenderable(renderer, {
    content: budgetAmount != null && budgetAmount > 0 ? `BUDGET · $${budgetAmount.toFixed(2)}` : 'BUDGET',
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const value = new TextRenderable(renderer, {
    content: '—',
    height: 1,
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const unit = new TextRenderable(renderer, {
    content: '',
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const meta = new TextRenderable(renderer, {
    content: ' ',
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  box.add(titleRef);
  box.add(value);
  box.add(meta);
  return { box, title: titleRef, value, unit, meta, width };
}

type LatencyRefs = {
  box: BoxRenderable;
  spark: TextRenderable;
  current: TextRenderable;
  avg: TextRenderable;
  p95: TextRenderable;
  samples: TextRenderable;
};

function makeLatencyPanel(renderer: CliRenderer): LatencyRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%',
    height: 9,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.emerald,
    title: ' LATENCY · LAST 40 ',
    backgroundColor: C.dark,
  });
  const spacer = new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark });
  const spark = new TextRenderable(renderer, {
    content: ' '.repeat(SPARK_WIDTH),
    fg: C.emerald,
    bg: C.dark,
  });
  const stats = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: C.dark,
  });
  const mkPair = (label: string): TextRenderable => {
    const group = new BoxRenderable(renderer, {
      flexDirection: 'row',
      gap: 1,
      backgroundColor: C.dark,
    });
    group.add(new TextRenderable(renderer, {
      content: label,
      fg: C.dim,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
    const value = new TextRenderable(renderer, {
      content: '—',
      fg: C.slate,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
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

type ThroughputRefs = {
  box: BoxRenderable;
  sent: TextRenderable;
  received: TextRenderable;
  sentRate: TextRenderable;
  receivedRate: TextRenderable;
};

function makeThroughputPanel(renderer: CliRenderer): ThroughputRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%',
    height: 7,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    title: ' THROUGHPUT ',
    backgroundColor: C.dark,
  });
  const columns = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 5,
    backgroundColor: C.dark,
  });
  const mkColumn = (label: string): { value: TextRenderable; rate: TextRenderable } => {
    const col = new BoxRenderable(renderer, {
      flexDirection: 'column',
      backgroundColor: C.dark,
    });
    col.add(new TextRenderable(renderer, {
      content: label,
      fg: C.dim,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
    const value = new TextRenderable(renderer, {
      content: '—',
      fg: C.slate,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
    const rate = new TextRenderable(renderer, {
      content: '—',
      fg: C.emerald,
      bg: C.dark,
    });
    col.add(value);
    col.add(rate);
    columns.add(col);
    return { value, rate };
  };
  const sent = mkColumn('↑ SENT');
  const received = mkColumn('↓ RECEIVED');
  box.add(columns);
  return {
    box,
    sent: sent.value,
    sentRate: sent.rate,
    received: received.value,
    receivedRate: received.rate,
  };
}

type ChecksRefs = {
  box: BoxRenderable;
  cells: TextRenderable[];
  summary: TextRenderable;
};

function makeChecksPanel(renderer: CliRenderer): ChecksRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%',
    height: 6,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    title: ' RECENT CHECKS ',
    backgroundColor: C.dark,
  });
  const strip = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 1,
    backgroundColor: C.dark,
  });
  const cells: TextRenderable[] = [];
  for (let i = 0; i < SPARK_WIDTH; i++) {
    const cell = new TextRenderable(renderer, {
      content: '■',
      fg: C.line2,
      bg: C.dark,
    });
    strip.add(cell);
    cells.push(cell);
  }
  const summary = new TextRenderable(renderer, {
    content: '0 ok · 0 failed · last 40 health probes',
    fg: C.dim,
    bg: C.dark,
  });
  box.add(strip);
  box.add(summary);
  return { box, cells, summary };
}

type AppRefs = {
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

function makeAppControlPanel(renderer: CliRenderer, width: number | '100%' = APP_PANEL_WIDTH): AppRefs {
  const box = new BoxRenderable(renderer, {
    width,
    height: 21,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    title: ' APP CONTROL ',
    backgroundColor: C.dark,
  });

  const mkRow = (label: string): TextRenderable => {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row',
      gap: 1,
      backgroundColor: C.dark,
    });
    row.add(new TextRenderable(renderer, {
      content: label.padEnd(12),
      fg: C.dim,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
    const value = new TextRenderable(renderer, {
      content: '—',
      fg: C.slate,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
    row.add(value);
    box.add(row);
    return value;
  };

  const statusRow = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 1,
    backgroundColor: C.dark,
  });
  statusRow.add(new TextRenderable(renderer, {
    content: 'APP STATUS'.padEnd(12),
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  const statusChipBox = new BoxRenderable(renderer, {
    flexDirection: 'row',
    paddingX: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.emerald,
    backgroundColor: C.dark,
  });
  const statusChip = new TextRenderable(renderer, {
    content: '• idle',
    fg: C.emerald,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  statusChipBox.add(statusChip);
  const pid = new TextRenderable(renderer, {
    content: 'pid —',
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  statusRow.add(statusChipBox);
  statusRow.add(pid);
  box.add(statusRow);

  const probe = mkRow('LAST PROBE');
  const launch = mkRow('LAUNCH CMD');
  const fetchMode = mkRow('FETCH MODE');
  const preload = mkRow('PRELOAD');
  const routing = mkRow('ROUTING');
  const node = mkRow('NODE');

  const buttons = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });
  const relaunch = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 1,
    paddingX: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.emerald,
    backgroundColor: C.dark,
  });
  relaunch.add(makeBadge(renderer, 'L', { bg: C.emerald }));
  relaunch.add(new TextRenderable(renderer, {
    content: 'relaunch app',
    fg: C.emerald,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  const test = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 1,
    paddingX: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    backgroundColor: C.dark,
  });
  test.add(makeBadge(renderer, 'T', { bg: C.slate }));
  test.add(new TextRenderable(renderer, {
    content: 'test probe',
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  buttons.add(relaunch);
  buttons.add(test);
  box.add(buttons);

  return {
    box,
    statusChip,
    statusChipBox,
    pid,
    probe,
    launch,
    fetchMode,
    preload,
    routing,
    node,
  };
}

function makeFooter(renderer: CliRenderer, title: string, isForward: boolean): BoxRenderable {
  const footer = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingX: 2,
    paddingY: 0,
    border: ['top'],
    borderColor: C.line2,
    backgroundColor: C.panel,
  });
  const footerChips = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
    backgroundColor: C.panel,
  });
  const hints = isForward
    ? [
        { key: 'L', label: 'launch' },
        { key: 'T', label: 'test' },
        { key: '↑↓', label: 'scroll' },
        { key: 'S', label: 'stop proxy', danger: true },
        { key: 'B', label: 'back' },
      ]
    : [
        { key: '↑↓', label: 'scroll' },
        { key: 'S', label: 'stop proxy', danger: true },
        { key: 'B', label: 'back' },
      ];
  for (const hint of hints) {
    const pair = new BoxRenderable(renderer, {
      flexDirection: 'row',
      gap: 1,
      alignItems: 'center',
      backgroundColor: C.panel,
    });
    pair.add(makeBadge(renderer, hint.key, { bg: hint.danger ? C.red : C.slate }));
    pair.add(new TextRenderable(renderer, {
      content: hint.label,
      fg: C.slate,
      bg: C.panel,
    }));
    footerChips.add(pair);
  }
  footer.add(footerChips);
  footer.add(new TextRenderable(renderer, {
    content: `${title} · LIVE`,
    fg: C.dim,
    bg: C.panel,
    attributes: TextAttributes.BOLD,
  }));
  return footer;
}

function addTopBar(renderer: CliRenderer, root: RootRenderable, freeMode: boolean): void {
  const topBar = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingX: 2,
    paddingY: 0,
    border: ['bottom'],
    borderColor: C.line2,
    backgroundColor: C.dark,
  });
  const brand = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 2,
    backgroundColor: C.dark,
  });
  brand.add(new TextRenderable(renderer, {
    content: '▲ CONSENSUS',
    fg: C.white,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  brand.add(new TextRenderable(renderer, {
    content: 'your private network, on demand',
    fg: C.dim,
    bg: C.dark,
  }));

  const status = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 3,
    backgroundColor: C.dark,
  });
  status.add(new TextRenderable(renderer, {
    content: '● live',
    fg: C.emerald,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: `acct ${shortAcct()}`,
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: freeMode ? 'tier free' : `bal $${Number(process.env.CONSENSUS_BALANCE_USD ?? 0).toFixed(2)}`,
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: `v ${VERSION}`,
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  topBar.add(brand);
  topBar.add(status);
  root.add(topBar);
}

function addStatusStrip(
  renderer: CliRenderer,
  root: RootRenderable,
  entry: WorkerEntry,
  isForward: boolean,
): { state: TextRenderable; center: TextRenderable; uptime: TextRenderable } {
  const wrapper = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });
  const strip = new BoxRenderable(renderer, {
    flexGrow: 1,
    height: 3,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingX: 2,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    backgroundColor: C.panel,
  });
  const state = new TextRenderable(renderer, {
    content: '● RUNNING',
    fg: C.emerald,
    bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  const center = new TextRenderable(renderer, {
    content: isForward
      ? `app ${entry.appPort ? `:${entry.appPort}` : '—'} → consensus · preload`
      : `upstream ${entry.label || 'localhost:3000'} → proxy :${entry.handle.port} · cached`,
    fg: C.slate,
    bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  const uptime = new TextRenderable(renderer, {
    content: 'uptime 00:00:00',
    fg: C.slate,
    bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  strip.add(state);
  strip.add(center);
  strip.add(uptime);
  wrapper.add(strip);
  root.add(wrapper);
  return { state, center, uptime };
}

function addMetricRows(
  renderer: CliRenderer,
  root: RootRenderable,
  isForward: boolean,
  freeMode: boolean,
  budgetAmount?: number,
): {
  requests: MetricRefs;
  status: MetricRefs;
  cache: MetricRefs;
  success: MetricRefs;
  spend: MetricRefs | null;
  budget: MetricRefs | null;
} {
  const cols = terminalColumns();
  const cardCount = freeMode ? 4 : 5;
  const totalGaps = 2 * (cardCount - 1);
  const cardWidth = Math.max(20, Math.min(31, Math.floor((cols - 4 - totalGaps) / cardCount)));
  const row = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    gap: 2,
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
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
      width: '100%',
      flexDirection: 'row',
      gap: 2,
      paddingX: 2,
      paddingTop: 1,
      backgroundColor: C.dark,
    });
    row2.add(success.box);
    root.add(row2);
  }

  return { requests, status, cache, success, spend, budget };
}

function updateMetric(card: MetricRefs, value: string, unit = '', meta = '', valueFg?: string): void {
  card.value.content = value;
  card.unit.content = unit;
  card.meta.content = meta || ' ';
  if (valueFg) {
    card.value.fg = valueFg;
    card.unit.fg = valueFg;
  }
}

function updateChecks(panel: ChecksRefs, outcomes: boolean[] | undefined): void {
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

function makeRateTracker(initial: WorkerStats): {
  update(stats: WorkerStats): { reqRate: number; sentRate: number; recvRate: number };
} {
  let prevStats = initial;
  let prevTime = Date.now();
  return {
    update(stats: WorkerStats) {
      const now = Date.now();
      const dt = Math.max((now - prevTime) / 1000, 1);
      const reqRate = ((stats.requests - prevStats.requests) / dt) * 60;
      const sentRate = (stats.bytesSent - prevStats.bytesSent) / dt;
      const recvRate = (stats.bytesRecv - prevStats.bytesRecv) / dt;
      prevStats = stats;
      prevTime = now;
      return { reqRate, sentRate, recvRate };
    },
  };
}

export async function showProxyDashboard(
  entry: WorkerEntry,
  onStop?: () => void,
  opts: { freeMode?: boolean; preview?: boolean } = {},
): Promise<'back'> {
  const isForward = entry.handle.type === 'forward';
  const freeMode = opts.freeMode ?? await isFreeMode();
  const previewMode = opts.preview === true;
  const title = isForward ? 'FORWARD PROXY' : 'REVERSE PROXY';
  writeTraceLog('proxyDashboard.enter', { type: entry.handle.type, port: entry.handle.port, label: entry.label });

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 15,
    useMouse: false,
    useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  addTopBar(renderer, root, freeMode);
  const statusStrip = addStatusStrip(renderer, root, entry, isForward);
  const metrics = addMetricRows(renderer, root, isForward, freeMode, entry.budget);
  const cols = terminalColumns();
  const stacked = isForward && cols < 112;
  const appPanelWidth = Math.max(54, Math.min(APP_PANEL_WIDTH, Math.floor(cols * 0.42)));

  const lower = new BoxRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    flexDirection: stacked ? 'column' : isForward ? 'row' : 'column',
    gap: 2,
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });
  root.add(lower);

  const left = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'column',
    gap: 1,
    backgroundColor: C.dark,
  });
  lower.add(left);

  const latency = makeLatencyPanel(renderer);
  const throughput = makeThroughputPanel(renderer);
  const checks = makeChecksPanel(renderer);
  left.add(latency.box);
  left.add(throughput.box);
  left.add(checks.box);

  const appPanel = isForward ? makeAppControlPanel(renderer, stacked ? '100%' : appPanelWidth) : null;
  if (appPanel) lower.add(appPanel.box);

  root.add(makeFooter(renderer, title, isForward));

  let actionBusy = false;
  const sessionId = crypto.randomUUID();
  const rates = makeRateTracker(entry.handle.stats());

  const ensureManagedAppRunning = async (): Promise<void> => {
    if (!entry.managedApp) return;
    await Bun.sleep(250);
    if (entry.managedApp.status === 'exited' || entry.managedApp.status === 'error') {
      throw new Error(entry.managedApp.lastMessage ?? 'managed app exited before it became ready');
    }
  };

  const autoManageApp = async (): Promise<void> => {
    if (previewMode) return;
    if (!isForward || !entry.managedApp || !entry.appEntry || !entry.autoLaunch) return;
    actionBusy = true;
    try {
      writeTraceLog('proxyDashboard.autoLaunch.start', { port: entry.handle.port, appPort: entry.appPort });
      await launchManagedApp(entry.managedApp, {
        proxyPort: entry.handle.port,
        appPort: entry.appPort,
        label: `app-${entry.appPort ?? entry.handle.port}`,
        cacheTtl: entry.cacheTtl,
        verbose: entry.verbose,
        nodeRegion: entry.nodeRegion,
        nodeDomain: entry.nodeDomain,
        nodeExclude: entry.nodeExclude,
        budget: entry.budget,
        preferNetwork: entry.preferNetwork,
        mode: entry.mode,
        routes: entry.routes,
        matchSubroutes: entry.matchSubroutes,
      });
      render();
      await ensureManagedAppRunning();
      await probeManagedAppUntilReady(entry.managedApp, {
        appPort: entry.appPort,
        checkPath: entry.appCheckPath,
        attempts: 8,
        intervalMs: 1000,
      });
      writeTraceLog('proxyDashboard.autoLaunch.done', {
        port: entry.handle.port,
        ok: entry.managedApp.lastProbe?.ok === true,
        message: entry.managedApp.lastProbe?.message,
      });
    } catch (err) {
      entry.managedApp.status = 'error';
      entry.managedApp.lastMessage = err instanceof Error ? err.message : String(err);
      writeTraceLog('proxyDashboard.autoLaunch.error', {
        port: entry.handle.port,
        message: entry.managedApp.lastMessage,
      });
    } finally {
      actionBusy = false;
      render();
    }
  };

  function renderAppPanel(stats: WorkerStats): void {
    if (!isForward || !entry.managedApp || !appPanel) return;
    const managed = entry.managedApp;
    const state = actionBusy ? 'working' : managed.status;
    const ok = managed.status === 'running';
    const warn = managed.status === 'error' || managed.status === 'exited';
    appPanel.statusChip.content = `• ${state}`;
    appPanel.statusChip.fg = warn ? C.red : ok ? C.emerald : C.slate;
    appPanel.statusChipBox.borderColor = warn ? C.red : ok ? C.emerald : C.line2;
    appPanel.pid.content = managed.pid ? `pid ${managed.pid}` : 'pid —';

    const probe = managed.lastProbe;
    appPanel.probe.content = probe
      ? `${probe.ok ? 'reachable' : 'failed'} · ${probe.statusCode ?? probe.message} ${entry.appCheckPath ?? '/'} · ${fmtLatency(probe.latencyMs)} · ${fmtAgo(probe.at)} ago`
      : `${entry.appPort ? 'waiting' : 'no app port'} · ${entry.appCheckPath ?? '/'} · ${managed.lastMessage ?? 'not probed yet'}`;
    appPanel.probe.fg = probe ? (probe.ok ? C.emerald : C.amber) : C.slate;

    const preloadName = managed.preloadPath ? compactPath(managed.preloadPath, 24) : '.consensus-preload.ts';
    appPanel.launch.content = entry.appEntry
      ? `bun --preload ${preloadName} ${compactPath(entry.appEntry, 22)}`
      : 'set an entry file in forward setup to enable auto-launch';
    appPanel.fetchMode.content = 'preload → globalThis.fetch → consensus';
    appPanel.preload.content = `${preloadName} · auto restart ${entry.autoLaunch ? 'enabled' : 'disabled'}`;
    appPanel.routing.content = `${entry.mode ?? 'inclusive'} · ${(entry.routes?.length ? entry.routes.join(', ') : 'all routes')} · subroutes ${entry.matchSubroutes ? 'on' : 'off'}`;
    appPanel.node.content = `${entry.nodeDomain ?? entry.nodeRegion ?? 'auto'} · auto · ${fmtLatency(stats.avgLatencyMs)}`;
  }

  function render(): void {
    const stats = entry.handle.stats();
    const rate = rates.update(stats);
    const spend = stats.spend ?? 0;
    const outcomes = stats.recentOutcomes ?? [];
    const success = successRate(outcomes);
    const exhausted = isForward && entry.budget != null && spend >= entry.budget * 0.99;

    statusStrip.state.content = `● ${exhausted ? 'EXHAUSTED' : 'RUNNING'} :${entry.handle.port}`;
    statusStrip.state.fg = exhausted ? C.red : C.emerald;
    statusStrip.uptime.content = `uptime ${fmtHms(stats.uptime)}`;
    if (!isForward) {
      statusStrip.center.content = `upstream ${entry.label || 'localhost:3000'} → proxy :${entry.handle.port} · cached`;
    }

    updateMetric(metrics.requests, fmtCount(stats.requests), '', `~${Math.max(0, Math.round(rate.reqRate))} / min`, C.amber);
    updateMetric(metrics.status, stats.lastStatusCode == null ? '—' : String(stats.lastStatusCode), '', statusText(stats.lastStatusCode), statusFg(stats.lastStatusCode));

    const cacheHits = stats.cacheHits ?? 0;
    const hitRate = stats.requests > 0 ? (cacheHits / stats.requests) * 100 : 0;
    updateMetric(
      metrics.cache,
      isForward ? 'n/a' : fmtCount(cacheHits),
      '',
      isForward ? 'reverse only' : `${Math.round(hitRate)}% hit rate`,
      isForward ? C.slate : C.white,
    );
    updateMetric(metrics.success, String(Math.round(success)), '%', 'last 40 checks', C.emerald);

    if (metrics.spend) {
      updateMetric(metrics.spend, `$${spend.toFixed(6)}`, '', 'session total', C.white);
    }
    if (metrics.budget) {
      const budget = entry.budget ?? 0;
      if (budget > 0) {
        const budgetPct = Math.min(spend / budget, 1);
        const budgetLabel = pct(budgetPct * 100);
        const barWidth = Math.max(4, Math.min(22, metrics.budget.width - 7 - budgetLabel.length));
        updateMetric(
          metrics.budget,
          `${budgetBar(spend, budget, barWidth)} ${budgetLabel}`,
          '',
          `$${Math.max(budget - spend, 0).toFixed(2)} left`,
          budgetPct > 0.8 ? C.red : C.slate,
        );
      } else {
        updateMetric(metrics.budget, 'unlimited', '', 'no session cap', C.slate);
      }
    }

    latency.spark.content = sparkline(stats.recentLatencies ?? []);
    latency.current.content = fmtLatency(stats.currentLatencyMs);
    latency.avg.content = fmtLatency(stats.avgLatencyMs);
    latency.p95.content = fmtLatency(stats.p95LatencyMs);
    latency.samples.content = String((stats.recentLatencies ?? []).length);

    throughput.sent.content = fmtBytes(stats.bytesSent);
    throughput.received.content = fmtBytes(stats.bytesRecv);
    throughput.sentRate.content = fmtRate(Math.max(0, rate.sentRate));
    throughput.receivedRate.content = fmtRate(Math.max(0, rate.recvRate));

    updateChecks(checks, outcomes);
    renderAppPanel(stats);
  }

  render();
  const ticker = setInterval(render, 1000);
  const inputReadyAt = Date.now() + 300;
  void autoManageApp();

  return new Promise<'back'>((resolve) => {
    const finishBack = (): void => {
      clearInterval(ticker);
      renderer.destroy();
      resolve('back');
    };

    renderer.keyInput.on('keypress', async (key) => {
      if (Date.now() < inputReadyAt || actionBusy) return;

      if (isForward && (key.name === 'l' || key.name === 'L') && entry.managedApp) {
        if (previewMode) {
          render();
          return;
        }
        if (!entry.appEntry) return;
        actionBusy = true;
        try {
          writeTraceLog('proxyDashboard.key', { key: key.name, action: 'launch', port: entry.handle.port });
          await launchManagedApp(entry.managedApp, {
            proxyPort: entry.handle.port,
            appPort: entry.appPort,
            label: `app-${entry.appPort ?? entry.handle.port}`,
            cacheTtl: entry.cacheTtl,
            verbose: entry.verbose,
            nodeRegion: entry.nodeRegion,
            nodeDomain: entry.nodeDomain,
            nodeExclude: entry.nodeExclude,
            budget: entry.budget,
            preferNetwork: entry.preferNetwork,
            mode: entry.mode,
            routes: entry.routes,
            matchSubroutes: entry.matchSubroutes,
          });
          await ensureManagedAppRunning();
        } catch (err) {
          entry.managedApp.status = 'error';
          entry.managedApp.lastMessage = err instanceof Error ? err.message : String(err);
        } finally {
          actionBusy = false;
          render();
        }
        return;
      }

      if (isForward && (key.name === 't' || key.name === 'T')) {
        if (previewMode) {
          render();
          return;
        }
        actionBusy = true;
        try {
          writeTraceLog('proxyDashboard.key', { key: key.name, action: 'test', port: entry.handle.port });
          if (entry.managedApp) {
            await probeManagedApp(entry.managedApp, {
              appPort: entry.appPort,
              checkPath: entry.appCheckPath,
            });
          }
        } catch (err) {
          if (entry.managedApp) {
            entry.managedApp.lastMessage = err instanceof Error ? err.message : String(err);
          }
        } finally {
          actionBusy = false;
          render();
        }
        return;
      }

      if (key.name === 's' || key.name === 'S') {
        writeTraceLog('proxyDashboard.key', { key: key.name, action: 'stop', port: entry.handle.port });
        if (previewMode) {
          clearInterval(ticker);
          renderer.destroy();
          onStop?.();
          resolve('back');
          return;
        }
        clearInterval(ticker);
        const finalStats = entry.handle.stats();
        const endedAt = Date.now();
        const spendUsd = finalStats.spend ?? 0;
        const exhausted = isForward && entry.budget != null && spendUsd >= entry.budget * 0.99;
        saveSession({
          id: sessionId,
          type: isForward ? 'http-proxy' : 'reverse-proxy',
          label: entry.label,
          url: `http://localhost:${entry.handle.port}`,
          target: entry.appPort ? `localhost:${entry.appPort}` : entry.label,
          startedAt: endedAt - finalStats.uptime,
          endedAt,
          durationMs: finalStats.uptime,
          outcome: exhausted ? 'budget-exhausted' : 'user-quit',
          spendUsd,
          requests: finalStats.requests,
          bytesIn: finalStats.bytesRecv,
          bytesOut: finalStats.bytesSent,
          region: entry.nodeRegion,
          nodeDomain: entry.nodeDomain,
          network: entry.preferNetwork,
        });
        if (spendUsd > 0) {
          recordSpend({
            sessionId,
            date: new Date().toISOString().slice(0, 10),
            type: 'proxy',
            amountUsd: spendUsd,
            network: entry.preferNetwork,
          });
        }
        renderer.destroy();
        if (entry.managedApp?.process) await stopManagedApp(entry.managedApp);
        await entry.handle.stop();
        onStop?.();
        resolve('back');
        return;
      }

      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        writeTraceLog('proxyDashboard.key', { key: key.name, ctrl: key.ctrl === true, action: 'back', port: entry.handle.port });
        finishBack();
      }
    });
  });
}
