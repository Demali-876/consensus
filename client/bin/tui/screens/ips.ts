import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type RootRenderable,
} from '@opentui/core';
import { C } from '../../theme';
import { makeBadge, makeKeyBar, makeTopBar } from '../chrome.ts';
import { makeSpin } from '../../lib/spinners';
import { isFreeMode } from '../../lib/server-config';
import { loadConfig } from '../../lib/config.ts';
import { listBrowserNodes, leaseNode, releaseNode } from '../../lib/ip.ts';
import type { NodeInfo } from '../../lib/ip.ts';
const VISIBLE_ROWS = 8;

type Region = 'all' | 'us' | 'eu' | 'ap';
const REGIONS: Region[] = ['all', 'us', 'eu', 'ap'];

function fmtIp(node: NodeInfo): string {
  if (node.ipv4) return node.ipv4;
  if (node.ipv6) return node.ipv6.length > 18 ? `${node.ipv6.slice(0, 17)}…` : node.ipv6;
  return '—';
}

function fmtCaps(caps?: NodeInfo['capabilities']): string {
  if (!caps) return '—';
  const flags = Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace('_proxy', '').replace(/_/g, '-'));
  return flags.length ? flags.join(' · ') : '—';
}

function fmtLeaseAge(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(d) || d < 0) return 'just now';
  if (d < 60_000)        return 'just now';
  if (d < 3_600_000)     return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000)    return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtRefreshedAge(ts: number): string {
  const d = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (d < 60)     return `${d}s ago`;
  if (d < 3_600)  return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3_600)}h ago`;
}

function regionShort(r: string | undefined): string {
  return (r ?? '—').slice(0, 12);
}

function regionFamily(r: string | undefined): Region | null {
  if (!r) return null;
  if (r.startsWith('us')) return 'us';
  if (r.startsWith('eu')) return 'eu';
  if (r.startsWith('ap') || r.startsWith('asia')) return 'ap';
  return null;
}

function scoreColor(score?: number): string {
  if (score == null) return C.dim;
  if (score >= 90) return C.emerald;
  if (score >= 80) return C.amber;
  return C.red;
}

function latencyColor(ms?: number): string {
  if (ms == null) return C.dim;
  if (ms < 60)  return C.emerald;
  if (ms < 120) return C.amber;
  return C.red;
}

function nodeLeaseTarget(node: NodeInfo): string {
  return node.domain || node.node_id || '';
}

function uniqueRegions(nodes: NodeInfo[]): number {
  const set = new Set<string>();
  for (const n of nodes) if (n.region) set.add(n.region);
  return set.size;
}

function terminalCols(): number {
  return Math.max(120, process.stdout.columns || 168);
}

const LOAD_BAR_WIDTH = 10;

function makeLoadBar(renderer: CliRenderer): { box: BoxRenderable; fill: TextRenderable; pct: TextRenderable } {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  const fill = new TextRenderable(renderer, { content: '', fg: C.emerald, bg: C.dark });
  const pct  = new TextRenderable(renderer, { content: '', fg: C.dim,     bg: C.dark });
  box.add(fill);
  box.add(pct);
  return { box, fill, pct };
}

function renderLoadBar(
  refs: { fill: TextRenderable; pct: TextRenderable },
  loadPct?: number,
  focused = false,
  activeTotal?: number,
): void {
  if (loadPct == null) {
    refs.fill.content = '─'.repeat(LOAD_BAR_WIDTH);
    refs.fill.fg = C.line2;
    refs.pct.content = activeTotal == null ? '  —' : `${String(activeTotal).padStart(3)}x`;
    refs.pct.fg = focused ? C.white : C.dim;
    return;
  }
  const clamped = Math.max(0, Math.min(100, loadPct));
  const filled  = Math.round((clamped / 100) * LOAD_BAR_WIDTH);
  refs.fill.content = '█'.repeat(filled) + '░'.repeat(LOAD_BAR_WIDTH - filled);
  refs.fill.fg = focused ? C.accent : C.emerald;
  refs.pct.content = `${String(Math.round(clamped)).padStart(3)}%`;
  refs.pct.fg = focused ? C.white : C.dim;
}

interface RegionPillRefs {
  row: BoxRenderable;
  pills: Record<Region, { box: BoxRenderable; label: TextRenderable }>;
  setActive(r: Region): void;
}

function makeRegionPills(renderer: CliRenderer, initial: Region): RegionPillRefs {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  const pills = {} as RegionPillRefs['pills'];
  for (const r of REGIONS) {
    const active = r === initial;
    const box = new BoxRenderable(renderer, {
      flexDirection: 'row', paddingX: 2,
      backgroundColor: active ? C.accent : C.dark,
      border: true, borderStyle: 'rounded',
      borderColor: active ? C.accent : C.line2,
    });
    const label = new TextRenderable(renderer, {
      content: r, fg: active ? C.dark : C.slate,
      bg: active ? C.accent : C.dark, attributes: TextAttributes.BOLD,
    });
    box.add(label);
    row.add(box);
    pills[r] = { box, label };
  }
  return {
    row, pills,
    setActive(next: Region) {
      for (const r of REGIONS) {
        const on = r === next;
        const { box, label } = pills[r];
        box.backgroundColor = on ? C.accent : C.dark;
        box.borderColor     = on ? C.accent : C.line2;
        label.bg            = on ? C.accent : C.dark;
        label.fg            = on ? C.dark   : C.slate;
      }
    },
  };
}

interface RowRefs {
  row:      BoxRenderable;
  marker:   TextRenderable;
  node:     TextRenderable;
  domain:   TextRenderable;
  region:   TextRenderable;
  ip:       TextRenderable;
  scoreVal: TextRenderable;
  scoreMax: TextRenderable;
  latency:  TextRenderable;
  loadBar:  { fill: TextRenderable; pct: TextRenderable };
  capsBox:  BoxRenderable;
  capsText: TextRenderable;
  leasedChip: BoxRenderable;
  leasedLbl:  TextRenderable;
}

const COL = {
  marker:  2,
  node:    11,
  domain:  30,
  region:  10,
  ip:      14,
  score:   8,
  latency: 9,
  load:    16,
  caps:    24,
};

function makeTableHeader(renderer: CliRenderer): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, paddingLeft: 2, paddingBottom: 1,
    backgroundColor: C.dark,
  });
  const mk = (text: string, w: number, align: 'left' | 'right' = 'left') => {
    const padded = align === 'right' ? text.padStart(w) : text.padEnd(w);
    row.add(new TextRenderable(renderer, {
      content: padded, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
    }));
  };
  mk('',        COL.marker);
  mk('NODE',    COL.node);
  mk('DOMAIN',  COL.domain);
  mk('REGION',  COL.region);
  mk('IP',      COL.ip);
  mk('SCORE',   COL.score, 'right');
  mk('LATENCY', COL.latency, 'right');
  mk('LOAD',    COL.load);
  mk('CAPS',    COL.caps);
  return row;
}

function makeTableRow(renderer: CliRenderer): RowRefs {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, paddingLeft: 0, alignItems: 'center',
    backgroundColor: C.dark,
  });
  const marker = new TextRenderable(renderer, {
    content: ' '.repeat(COL.marker), fg: C.accent, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const node = new TextRenderable(renderer, {
    content: ''.padEnd(COL.node), fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const domain = new TextRenderable(renderer, {
    content: ''.padEnd(COL.domain), fg: C.slate, bg: C.dark,
  });
  const region = new TextRenderable(renderer, {
    content: ''.padEnd(COL.region), fg: C.emerald, bg: C.dark,
  });
  const ip = new TextRenderable(renderer, {
    content: ''.padEnd(COL.ip), fg: C.slate, bg: C.dark,
  });
  const scoreGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', backgroundColor: C.dark, width: COL.score, justifyContent: 'flex-end',
  });
  const scoreVal = new TextRenderable(renderer, {
    content: '—', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const scoreMax = new TextRenderable(renderer, {
    content: '/100', fg: C.dim, bg: C.dark,
  });
  scoreGroup.add(scoreVal);
  scoreGroup.add(scoreMax);

  const latencyGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', backgroundColor: C.dark, width: COL.latency, justifyContent: 'flex-end',
  });
  const latency = new TextRenderable(renderer, {
    content: '—', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  latencyGroup.add(latency);

  const loadGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', backgroundColor: C.dark, width: COL.load, alignItems: 'center', gap: 1,
  });
  const loadBar = makeLoadBar(renderer);
  loadGroup.add(loadBar.box);

  const capsBox = new BoxRenderable(renderer, {
    flexDirection: 'row', backgroundColor: C.dark, width: COL.caps, alignItems: 'center',
  });
  const capsText = new TextRenderable(renderer, {
    content: '—', fg: C.dim, bg: C.dark,
  });
  const leasedChip = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1,
    border: true, borderStyle: 'rounded', borderColor: C.emerald,
    backgroundColor: C.dark,
  });
  const leasedLbl = new TextRenderable(renderer, {
    content: '● LEASED', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  leasedChip.add(leasedLbl);
  capsBox.add(capsText);

  row.add(marker);
  row.add(node);
  row.add(domain);
  row.add(region);
  row.add(ip);
  row.add(scoreGroup);
  row.add(latencyGroup);
  row.add(loadGroup);
  row.add(capsBox);

  return {
    row, marker, node, domain, region, ip,
    scoreVal, scoreMax, latency,
    loadBar: { fill: loadBar.fill, pct: loadBar.pct },
    capsBox, capsText,
    leasedChip, leasedLbl,
  };
}

function fillRow(refs: RowRefs, node: NodeInfo | undefined, focused: boolean, leasedTarget: string): void {
  if (!node) {
    refs.marker.content   = ' '.repeat(COL.marker);
    refs.node.content     = ''.padEnd(COL.node);
    refs.domain.content   = ''.padEnd(COL.domain);
    refs.region.content   = ''.padEnd(COL.region);
    refs.ip.content       = ''.padEnd(COL.ip);
    refs.scoreVal.content = '';
    refs.scoreMax.content = '';
    refs.latency.content  = '';
    renderLoadBar(refs.loadBar, undefined);
    refs.capsText.content = '';
    while (refs.capsBox.getChildrenCount() > 0) {
      const child = refs.capsBox.getChildren()[0];
      if (!child) break;
      refs.capsBox.remove(child.id);
    }
    refs.capsBox.add(refs.capsText);
    return;
  }

  const isLeased = !!leasedTarget && nodeLeaseTarget(node) === leasedTarget;

  refs.marker.content = focused ? '▶ ' : '  ';
  refs.marker.fg      = focused ? C.emerald : C.dark;

  const baseFg = focused ? C.white : isLeased ? C.emerald : C.slate;

  refs.node.content   = (node.node_id || '—').slice(0, COL.node).padEnd(COL.node);
  refs.node.fg        = baseFg;
  refs.domain.content = (node.domain  || '—').slice(0, COL.domain).padEnd(COL.domain);
  refs.domain.fg      = focused ? C.white : C.slate;
  refs.region.content = regionShort(node.region).padEnd(COL.region);
  refs.region.fg      = focused ? C.white : C.emerald;
  refs.ip.content     = fmtIp(node).slice(0, COL.ip).padEnd(COL.ip);
  refs.ip.fg          = focused ? C.white : C.slate;

  const score = node.benchmark_score;
  refs.scoreVal.content = score != null ? String(Math.round(score)) : '—';
  refs.scoreVal.fg      = scoreColor(score);
  refs.scoreMax.content = score != null ? '/100' : '';

  const ms = node.latencyMs;
  refs.latency.content = ms != null ? `${Math.round(ms)} ms` : '—';
  refs.latency.fg      = latencyColor(ms);

  const activeTotal = (node.activeRequests ?? 0) + (node.activeSessions ?? 0);
  renderLoadBar(refs.loadBar, undefined, focused, activeTotal);

  while (refs.capsBox.getChildrenCount() > 0) {
    const child = refs.capsBox.getChildren()[0];
    if (!child) break;
    refs.capsBox.remove(child.id);
  }
  if (isLeased) {
    refs.capsBox.add(refs.leasedChip);
  } else {
    refs.capsText.content = fmtCaps(node.capabilities);
    refs.capsText.fg      = focused ? C.white : C.dim;
    refs.capsBox.add(refs.capsText);
  }
}

interface ModalRefs {
  box:        BoxRenderable;
  domain:     TextRenderable;
  meta:       TextRenderable;
  score:      TextRenderable;
  latency:    TextRenderable;
  load:       TextRenderable;
  sla:        TextRenderable;
  caps:       TextRenderable;
  ip:         TextRenderable;
  show(node: NodeInfo, opts: { freeMode: boolean }): void;
  hide(): void;
}

function makeModal(renderer: CliRenderer, root: RootRenderable): ModalRefs {
  const box = new BoxRenderable(renderer, {
    id: 'lease-modal',
    position: 'absolute',
    top: '25%', left: '25%', width: '50%',
    flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.line2,
    title: ' LEASE NODE ', titleAlignment: 'left',
    paddingX: 2, paddingY: 1,
    backgroundColor: C.dark,
  });

  const domain = new TextRenderable(renderer, {
    content: '—', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const meta = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.dark,
  });
  box.add(domain);
  box.add(meta);

  box.add(new TextRenderable(renderer, {
    content: '─'.repeat(64), fg: C.line2, bg: C.dark,
  }));

  const mkStatRow = () => new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: 1, backgroundColor: C.dark,
  });
  const mkStatCell = (labelText: string) => {
    const cell = new BoxRenderable(renderer, {
      width: 32, flexDirection: 'row', justifyContent: 'space-between',
      backgroundColor: C.dark,
    });
    cell.add(new TextRenderable(renderer, {
      content: labelText, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
    }));
    const value = new TextRenderable(renderer, {
      content: '—', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD,
    });
    cell.add(value);
    return { cell, value };
  };

  const row1 = mkStatRow();
  const scoreCell   = mkStatCell('SCORE');
  const latencyCell = mkStatCell('LATENCY');
  row1.add(scoreCell.cell);
  row1.add(latencyCell.cell);
  box.add(row1);

  const row2 = mkStatRow();
  const loadCell = mkStatCell('LOAD');
  const slaCell  = mkStatCell('AVAILABILITY');
  row2.add(loadCell.cell);
  row2.add(slaCell.cell);
  box.add(row2);

  const row3 = mkStatRow();
  const capsCell = mkStatCell('CAPS');
  const ipCell   = mkStatCell('IP');
  row3.add(capsCell.cell);
  row3.add(ipCell.cell);
  box.add(row3);

  const banner = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 1,
    paddingX: 2, paddingY: 1, marginTop: 1,
    border: true, borderStyle: 'rounded', borderColor: C.amber,
    backgroundColor: C.dark,
  });
  banner.add(new TextRenderable(renderer, {
    content: '◆', fg: C.amber, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  const bannerText = new TextRenderable(renderer, {
    content: '', fg: C.slate, bg: C.dark,
    flexGrow: 1, wrapMode: 'word',
  });
  banner.add(bannerText);
  box.add(banner);

  const buttons = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'flex-end', gap: 2,
    marginTop: 1, backgroundColor: C.dark,
  });
  const cancelBtn = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center',
    paddingX: 2, backgroundColor: C.dark,
  });
  cancelBtn.add(makeBadge(renderer, 'Esc', { bg: C.line2 }).box);
  cancelBtn.add(new TextRenderable(renderer, {
    content: 'Cancel', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  const confirmBtn = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center',
    paddingX: 2, backgroundColor: C.emerald,
  });
  confirmBtn.add(makeBadge(renderer, '↵', { bg: C.emerald, fg: C.dark }).box);
  confirmBtn.add(new TextRenderable(renderer, {
    content: 'Lease this node', fg: C.dark, bg: C.emerald, attributes: TextAttributes.BOLD,
  }));
  buttons.add(cancelBtn);
  buttons.add(confirmBtn);
  box.add(buttons);

  return {
    box,
    domain,
    meta,
    score:   scoreCell.value,
    latency: latencyCell.value,
    load:    loadCell.value,
    sla:     slaCell.value,
    caps:    capsCell.value,
    ip:      ipCell.value,
    show(node, opts) {
      domain.content = node.domain || node.node_id || '—';
      meta.content   = `region ${node.region || '—'} · operator canister.software`;
      const s = node.benchmark_score;
      scoreCell.value.content = s != null ? `${Math.round(s)}/100` : '—';
      scoreCell.value.fg      = scoreColor(s);
      const ms = node.latencyMs;
      latencyCell.value.content = ms != null ? `${Math.round(ms)} ms` : '—';
      latencyCell.value.fg      = latencyColor(ms);
      const activeTotal = (node.activeRequests ?? 0) + (node.activeSessions ?? 0);
      loadCell.value.content = `${activeTotal} active`;
      loadCell.value.fg      = activeTotal > 0 ? C.amber : C.emerald;
      slaCell.value.content  = node.availability ?? 'unknown';
      slaCell.value.fg       = node.availability === 'online' ? C.emerald : C.amber;
      capsCell.value.content = fmtCaps(node.capabilities);
      capsCell.value.fg      = C.slate;
      ipCell.value.content   = fmtIp(node);
      ipCell.value.fg        = C.slate;
      bannerText.content = opts.freeMode
        ? 'Leasing is free in free mode — it pins every tunnel, proxy and socket you open to this node until you release it.'
        : 'Leasing is free — you only pay per-traffic at this node’s rates (USDC). It pins every tunnel, proxy and socket you open to this node until you release it.';
      root.add(box);
    },
    hide() {
      root.remove(box.id);
    },
  };
}

export async function showIps(): Promise<'back'> {
  const freeMode = await isFreeMode();

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

  const headerRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', backgroundColor: C.dark,
  });
  const titleCol = new BoxRenderable(renderer, { flexDirection: 'column', backgroundColor: C.dark });
  const titleRow = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  titleRow.add(new TextRenderable(renderer, {
    content: '▶', fg: C.accent, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  titleRow.add(new TextRenderable(renderer, {
    content: 'Nodes', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  titleCol.add(titleRow);
  titleCol.add(new TextRenderable(renderer, {
    content: 'lease a node to pin all tunnel, proxy & socket traffic to it',
    fg: C.dim, bg: C.dark,
  }));
  const statsText = new TextRenderable(renderer, {
    content: '—', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  headerRow.add(titleCol);
  headerRow.add(statsText);
  shell.add(headerRow);

  const banner = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingY: 0, marginTop: 1,
    border: true, borderStyle: 'rounded', borderColor: C.line2,
    backgroundColor: C.dark,
  });
  const bannerLeft = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  const bannerDot = new TextRenderable(renderer, {
    content: '○', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const bannerText = new TextRenderable(renderer, {
    content: 'No lease active — traffic uses automatic node selection',
    fg: C.slate, bg: C.dark,
  });
  bannerLeft.add(bannerDot);
  bannerLeft.add(bannerText);
  const bannerRight = new TextRenderable(renderer, {
    content: freeMode ? '○ free mode' : '',
    fg: C.amber, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  banner.add(bannerLeft);
  banner.add(bannerRight);
  shell.add(banner);

  const filterRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginTop: 1, backgroundColor: C.dark,
  });
  const pills = makeRegionPills(renderer, 'all');
  filterRow.add(pills.row);
  const sortText = new TextRenderable(renderer, {
    content: 'sort: score ↓', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  filterRow.add(sortText);
  shell.add(filterRow);

  const panel = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.emerald,
    title: ' AVAILABLE NODES ',
    paddingX: 1, paddingY: 1,
    marginTop: 1, backgroundColor: C.dark,
  });
  panel.add(makeTableHeader(renderer));

  const rowRefs: RowRefs[] = [];
  for (let i = 0; i < VISIBLE_ROWS; i++) {
    const r = makeTableRow(renderer);
    panel.add(r.row);
    rowRefs.push(r);
  }

  const innerFooter = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2, alignItems: 'center',
    paddingTop: 1, border: ['top'], borderColor: C.line2, backgroundColor: C.dark,
  });
  const navPair = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  navPair.add(makeBadge(renderer, '↑↓', { bg: C.line2 }).box);
  navPair.add(new TextRenderable(renderer, { content: 'navigate', fg: C.slate, bg: C.dark }));
  const leasePair = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  leasePair.add(makeBadge(renderer, '↵', { bg: C.line2 }).box);
  leasePair.add(new TextRenderable(renderer, { content: 'lease selected', fg: C.slate, bg: C.dark }));
  const innerFooterText = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.dark,
  });
  innerFooter.add(navPair);
  innerFooter.add(leasePair);
  innerFooter.add(new TextRenderable(renderer, { content: '·', fg: C.dim, bg: C.dark }));
  innerFooter.add(innerFooterText);
  panel.add(innerFooter);

  shell.add(panel);

  const footer = makeKeyBar(renderer, [
    { key: '↑↓', label: 'navigate' },
    { key: '↵',  label: 'lease selected' },
    { key: 'D',  label: 'release' },
    { key: '/',  label: 'filter' },
    { key: 'R',  label: 'refresh' },
    { key: 'B',  label: 'back' },
  ], 'NODE BROWSER');
  root.add(footer.box);

  const modal = makeModal(renderer, root);

  let live = true;
  let nodes: NodeInfo[] = [];
  let filtered: NodeInfo[] = [];
  let cursor = 0;
  let offset = 0;
  let activeRegion: Region = 'all';
  let loading = false;
  let lastFetchedAt = Date.now();
  let modalOpen = false;
  let fetchError: string | null = null;

  function applyFilter(): void {
    filtered = activeRegion === 'all'
      ? nodes.slice()
      : nodes.filter((n) => regionFamily(n.region) === activeRegion);
    filtered.sort((a, b) => (b.benchmark_score ?? -1) - (a.benchmark_score ?? -1));
    cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
    offset = Math.max(0, Math.min(offset, filtered.length - VISIBLE_ROWS));
  }

  function renderStats(): void {
    if (fetchError) {
      statsText.content = `error: ${fetchError}`;
      statsText.fg = C.red;
      return;
    }
    const stats = `${nodes.length} nodes · ${uniqueRegions(nodes)} regions · refreshed ${fmtRefreshedAge(lastFetchedAt)}`;
    statsText.content = nodes.length ? stats : (loading ? 'loading…' : 'no nodes');
    statsText.fg = C.dim;
  }

  function renderBanner(): void {
    const cfg = loadConfig();
    if (cfg.leased_node) {
      bannerDot.content = '●';
      bannerDot.fg = C.emerald;
      banner.borderColor = C.emerald;
      bannerText.content = `${cfg.leased_node.domain}${cfg.leased_node.region ? ` · ${cfg.leased_node.region}` : ''} · leased ${fmtLeaseAge(cfg.leased_node.leased_at)}`;
      bannerText.fg = C.emerald;
    } else {
      bannerDot.content = '○';
      bannerDot.fg = C.dim;
      banner.borderColor = C.line2;
      bannerText.content = 'No lease active — traffic uses automatic node selection';
      bannerText.fg = C.slate;
    }
    bannerRight.content = freeMode ? '○ free mode' : '';
  }

  function renderRows(): void {
    const cfg = loadConfig();
    const leasedTarget = cfg.leased_node?.domain ?? '';
    const visible = filtered.slice(offset, offset + VISIBLE_ROWS);
    for (let i = 0; i < VISIBLE_ROWS; i++) {
      const node = visible[i];
      const globalIdx = offset + i;
      const focused = !!node && globalIdx === cursor;
      fillRow(rowRefs[i]!, node, focused, leasedTarget);
    }
    innerFooterText.content = filtered.length
      ? `showing ${Math.min(filtered.length, VISIBLE_ROWS)} of ${filtered.length} · pin all proxy/tunnel/ws traffic to this node`
      : 'no nodes match the current filter';
  }

  function renderReleaseChip(): void {
    const release = footer.chips.get('D');
    if (!release) return;
    const has = !!loadConfig().leased_node;
    release.label.fg = has ? C.slate : C.dim;
    release.badge.box.backgroundColor = has ? C.line2 : C.dark;
    release.badge.label.fg = has ? C.dark : C.dim;
    release.badge.label.bg = has ? C.line2 : C.dark;
  }

  function renderAll(): void {
    if (!live) return;
    renderStats();
    renderBanner();
    renderRows();
    renderReleaseChip();
  }

  const spin = makeSpin('checking');
  let spinTimer: ReturnType<typeof setInterval> | null = null;

  async function fetchNodes(): Promise<void> {
    if (!live || loading) return;
    loading = true;
    statsText.content = `${spin()}  fetching nodes…`;
    spinTimer = setInterval(() => {
      if (!live || !loading) { clearInterval(spinTimer!); return; }
      statsText.content = `${spin()}  fetching nodes…`;
    }, 100);

    try {
      const cfg = loadConfig();
      nodes = await listBrowserNodes({ config: cfg });
      fetchError = null;
      lastFetchedAt = Date.now();
      cursor = 0;
      offset = 0;
      applyFilter();
    } catch (err) {
      nodes = [];
      filtered = [];
      fetchError = err instanceof Error ? err.message : String(err);
    } finally {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      loading = false;
      if (live) {
        renderAll();
      }
    }
  }

  renderAll();
  void fetchNodes();

  return new Promise<'back'>((resolve) => {
    const done = () => {
      live = false;
      if (spinTimer) clearInterval(spinTimer);
      renderer.destroy();
      resolve('back');
    };

    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;

      if (modalOpen) {
        if (key.name === 'escape' || key.name === 'b' || key.name === 'B') {
          modal.hide();
          modalOpen = false;
          renderAll();
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          const node = filtered[cursor];
          if (!node) return;
          const cfg = loadConfig();
          const target = nodeLeaseTarget(node);
          if (target) {
            try { leaseNode({ config: cfg, nodeIdOrDomain: target, nodes }); } catch { /* surfaced via banner */ }
          }
          modal.hide();
          modalOpen = false;
          renderAll();
          return;
        }
        return;
      }

      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        done();
        return;
      }
      if (key.name === 'r' || key.name === 'R') {
        void fetchNodes();
        return;
      }
      if (key.name === '/' || key.sequence === '/') {
        const idx = REGIONS.indexOf(activeRegion);
        activeRegion = REGIONS[(idx + 1) % REGIONS.length]!;
        pills.setActive(activeRegion);
        applyFilter();
        renderAll();
        return;
      }
      if (key.name === 'd' || key.name === 'D') {
        const cfg = loadConfig();
        if (!cfg.leased_node) return;
        releaseNode(cfg);
        renderAll();
        return;
      }

      if (loading || filtered.length === 0) return;

      if (key.name === 'up' || key.name === 'k') {
        cursor = Math.max(0, cursor - 1);
        if (cursor < offset) offset = cursor;
        renderRows();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        cursor = Math.min(filtered.length - 1, cursor + 1);
        if (cursor >= offset + VISIBLE_ROWS) offset = cursor - VISIBLE_ROWS + 1;
        renderRows();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const node = filtered[cursor];
        if (!node) return;
        modal.show(node, { freeMode });
        modalOpen = true;
        return;
      }
    });
  });
}
