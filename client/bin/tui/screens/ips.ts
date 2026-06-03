/**
 * ips.ts — Node browser & lease screen.
 *
 * Mirrors the design mock at design-assets/Nodes.html. Routed as `ips` for
 * historical reasons, but presented as the "Nodes" screen.
 *
 *   ┌ Top bar — brand + connected/acct/bal (or `tier free` in free mode)
 *   ├ Header — "▶ Nodes" + subtitle | nodes·regions·refreshed stats
 *   ├ Lease banner — "○ No lease active …" / "● <node> · <region> · leased …"
 *   │                 (right side shows "○ free mode" when free)
 *   ├ Region tabs (all/us/eu/ap)            sort: score ↓
 *   └ AVAILABLE NODES panel (rounded emerald border)
 *       NODE  DOMAIN  REGION  IP  SCORE  LATENCY  LOAD  CAPS
 *       row…    row…
 *       (footer: navigate · lease selected · showing X of N …)
 *
 * Pressing ↵ opens a centered LEASE NODE modal with the node's stats and a
 * confirm/cancel. ↵ again confirms; Esc cancels.
 *
 * Keys:
 *   ↑ / ↓ (k/j) Navigate
 *   ↵            Open lease modal → confirm lease
 *   Esc          Close modal
 *   D            Release current lease
 *   /            Region/text filter (cycles all → us → eu → ap)
 *   R            Refresh from API
 *   B            Back to landing
 */

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type RootRenderable,
} from '@opentui/core';
import { C } from '../../theme';
import { makeSpin } from '../../lib/spinners';
import { isFreeMode } from '../../lib/server-config';
import { loadConfig } from '../../lib/config.ts';
import { loadPrefs } from '../../lib/store.ts';
import { listNodes, leaseNode, releaseNode } from '../../lib/ip.ts';
import type { NodeInfo } from '../../lib/ip.ts';

const VERSION = '2.4.1';
const VISIBLE_ROWS = 8;

type Region = 'all' | 'us' | 'eu' | 'ap';
const REGIONS: Region[] = ['all', 'us', 'eu', 'ap'];

// ─── Formatting ─────────────────────────────────────────────────────────────

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

// ─── Layout helpers ─────────────────────────────────────────────────────────

function terminalCols(): number {
  return Math.max(120, process.stdout.columns || 168);
}

function acctLabel(): string {
  const prefs = loadPrefs();
  const cfg = loadConfig();
  return prefs.displayName
    || cfg.wallet_name
    || (cfg.addresses?.evm ? `${cfg.addresses.evm.slice(0, 6)}…${cfg.addresses.evm.slice(-4)}` : 'guest');
}

function makeBadge(renderer: CliRenderer, text: string, opts: { bg?: string; fg?: string } = {}): BoxRenderable {
  const bg = opts.bg ?? C.line2;
  const box = new BoxRenderable(renderer, { flexDirection: 'row', paddingX: 1, backgroundColor: bg });
  box.add(new TextRenderable(renderer, {
    content: text, fg: opts.fg ?? C.dark, bg, attributes: TextAttributes.BOLD,
  }));
  return box;
}

function makeTopBar(renderer: CliRenderer, root: RootRenderable, freeMode: boolean, balanceUsd: number): void {
  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingY: 0,
    border: ['bottom'], borderColor: C.line2, backgroundColor: C.dark,
  });
  const brand = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.dark });
  brand.add(new TextRenderable(renderer, {
    content: '▲ CONSENSUS', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  brand.add(new TextRenderable(renderer, {
    content: 'your private network, on demand', fg: C.dim, bg: C.dark,
  }));

  const status = new BoxRenderable(renderer, { flexDirection: 'row', gap: 3, backgroundColor: C.dark });
  status.add(new TextRenderable(renderer, {
    content: '● connected', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: `acct ${acctLabel()}`, fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: freeMode ? 'tier free' : `bal $${balanceUsd.toFixed(2)}`,
    fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: `v ${VERSION}`, fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));

  topBar.add(brand);
  topBar.add(status);
  root.add(topBar);
}

// ─── Load bar ───────────────────────────────────────────────────────────────

const LOAD_BAR_WIDTH = 10;

function makeLoadBar(renderer: CliRenderer): { box: BoxRenderable; fill: TextRenderable; pct: TextRenderable } {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  // Track + fill rendered as a single coloured block string so it stays
  // monospace-aligned with the rest of the table.
  const fill = new TextRenderable(renderer, { content: '', fg: C.emerald, bg: C.dark });
  const pct  = new TextRenderable(renderer, { content: '', fg: C.dim,     bg: C.dark });
  box.add(fill);
  box.add(pct);
  return { box, fill, pct };
}

function renderLoadBar(refs: { fill: TextRenderable; pct: TextRenderable }, loadPct?: number, focused = false): void {
  if (loadPct == null) {
    refs.fill.content = '─'.repeat(LOAD_BAR_WIDTH);
    refs.fill.fg = C.line2;
    refs.pct.content = '  —';
    refs.pct.fg = C.dim;
    return;
  }
  const clamped = Math.max(0, Math.min(100, loadPct));
  const filled  = Math.round((clamped / 100) * LOAD_BAR_WIDTH);
  refs.fill.content = '█'.repeat(filled) + '░'.repeat(LOAD_BAR_WIDTH - filled);
  refs.fill.fg = focused ? C.accent : C.emerald;
  refs.pct.content = `${String(Math.round(clamped)).padStart(3)}%`;
  refs.pct.fg = focused ? C.white : C.dim;
}

// ─── Region pills ───────────────────────────────────────────────────────────

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

// ─── Table row ──────────────────────────────────────────────────────────────

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
  capsBox:  BoxRenderable;     // wraps either caps text or LEASED chip
  capsText: TextRenderable;
  leasedChip: BoxRenderable;
  leasedLbl:  TextRenderable;
}

// Column widths picked to add up to the inner panel width at 168 cols.
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
  // Score is "NN/100"; split so we can colour the number and dim the /100.
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

  // Load isn't on the API yet; show "—" + an empty track.
  renderLoadBar(refs.loadBar, undefined, focused);

  // Swap the caps cell content: chip when leased, otherwise plain text.
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

// ─── Footer hint chips ──────────────────────────────────────────────────────

function makeFooter(renderer: CliRenderer): { box: BoxRenderable; releaseChip: BoxRenderable; releaseLbl: TextRenderable } {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0,
    border: ['top'], borderColor: C.line2, backgroundColor: C.panel,
  });
  const chips = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.panel });
  const hints: Array<{ key: string; label: string; fg?: string }> = [
    { key: '↑↓',   label: 'navigate' },
    { key: '↵',    label: 'lease selected' },
    { key: 'D',    label: 'release' },
    { key: '/',    label: 'filter' },
    { key: 'R',    label: 'refresh' },
    { key: 'B',    label: 'back' },
  ];
  let releaseChip!: BoxRenderable;
  let releaseLbl!: TextRenderable;
  for (const h of hints) {
    const pair = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.panel,
    });
    const chip = makeBadge(renderer, h.key, { bg: C.line2 });
    const lbl  = new TextRenderable(renderer, { content: h.label, fg: C.slate, bg: C.panel });
    pair.add(chip);
    pair.add(lbl);
    chips.add(pair);
    if (h.key === 'D') { releaseChip = chip; releaseLbl = lbl; }
  }
  box.add(chips);
  box.add(new TextRenderable(renderer, {
    content: 'NODE BROWSER', fg: C.dim, bg: C.panel, attributes: TextAttributes.BOLD,
  }));
  return { box, releaseChip, releaseLbl };
}

// ─── Lease confirmation modal ───────────────────────────────────────────────

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
  // Modal lifecycle helpers.
  show(node: NodeInfo, opts: { freeMode: boolean }): void;
  hide(): void;
}

function makeModal(renderer: CliRenderer, root: RootRenderable): ModalRefs {
  // The modal sits as an absolutely-positioned overlay on the root, mirroring
  // the pattern in screens/palette.ts. The table behind remains in the layout
  // tree but is non-interactive while the modal is open.
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

  // Separator
  box.add(new TextRenderable(renderer, {
    content: '─'.repeat(64), fg: C.line2, bg: C.dark,
  }));

  // 2-column stats grid
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
  const slaCell  = mkStatCell('SLA');
  row2.add(loadCell.cell);
  row2.add(slaCell.cell);
  box.add(row2);

  const row3 = mkStatRow();
  const capsCell = mkStatCell('CAPS');
  const ipCell   = mkStatCell('IP');
  row3.add(capsCell.cell);
  row3.add(ipCell.cell);
  box.add(row3);

  // Info banner
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

  // Buttons row
  const buttons = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'flex-end', gap: 2,
    marginTop: 1, backgroundColor: C.dark,
  });
  const cancelBtn = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center',
    paddingX: 2, backgroundColor: C.dark,
  });
  cancelBtn.add(makeBadge(renderer, 'Esc', { bg: C.line2 }));
  cancelBtn.add(new TextRenderable(renderer, {
    content: 'Cancel', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  const confirmBtn = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center',
    paddingX: 2, backgroundColor: C.emerald,
  });
  confirmBtn.add(makeBadge(renderer, '↵', { bg: C.emerald, fg: C.dark }));
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
      loadCell.value.content = '—';
      loadCell.value.fg      = C.dim;
      slaCell.value.content  = '—';
      slaCell.value.fg       = C.dim;
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

// ─── Main screen ────────────────────────────────────────────────────────────

export async function showIps(): Promise<'back'> {
  const freeMode = await isFreeMode();
  const balance  = Number(process.env.CONSENSUS_BALANCE_USD ?? 24.18);

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  makeTopBar(renderer, root, freeMode, balance);

  // Shell — everything between top and bottom bars.
  const shell = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });
  root.add(shell);

  // Header
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

  // Lease/status banner
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

  // Filter row
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

  // Available nodes panel
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

  // Inner footer: navigate · lease selected · showing X of N · pin all proxy/tunnel/ws…
  const innerFooter = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2, alignItems: 'center',
    paddingTop: 1, border: ['top'], borderColor: C.line2, backgroundColor: C.dark,
  });
  const navPair = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  navPair.add(makeBadge(renderer, '↑↓', { bg: C.line2 }));
  navPair.add(new TextRenderable(renderer, { content: 'navigate', fg: C.slate, bg: C.dark }));
  const leasePair = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  leasePair.add(makeBadge(renderer, '↵', { bg: C.line2 }));
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

  // Bottom footer
  const footer = makeFooter(renderer);
  root.add(footer.box);

  // Modal — built but not added until needed.
  const modal = makeModal(renderer, root);

  // ── State ─────────────────────────────────────────────────────────────────
  let live = true;
  let nodes: NodeInfo[] = [];
  let filtered: NodeInfo[] = [];
  let cursor = 0;
  let offset = 0;
  let activeRegion: Region = 'all';
  let loading = false;
  let lastFetchedAt = Date.now();
  let modalOpen = false;

  function applyFilter(): void {
    filtered = activeRegion === 'all'
      ? nodes.slice()
      : nodes.filter((n) => regionFamily(n.region) === activeRegion);
    // Sort by score descending; nodes without scores sink to the bottom.
    filtered.sort((a, b) => (b.benchmark_score ?? -1) - (a.benchmark_score ?? -1));
    cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
    offset = Math.max(0, Math.min(offset, filtered.length - VISIBLE_ROWS));
  }

  function renderStats(): void {
    const stats = `${nodes.length} nodes · ${uniqueRegions(nodes)} regions · refreshed ${fmtRefreshedAge(lastFetchedAt)}`;
    statsText.content = nodes.length ? stats : (loading ? 'loading…' : 'no nodes');
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
    const cfg = loadConfig();
    const has = !!cfg.leased_node;
    footer.releaseLbl.fg = has ? C.slate : C.dim;
    footer.releaseChip.backgroundColor = has ? C.line2 : C.dark;
    const child = footer.releaseChip.getChildren()[0] as TextRenderable | undefined;
    if (child) {
      child.fg = has ? C.dark : C.dim;
      child.bg = has ? C.line2 : C.dark;
    }
  }

  function renderAll(): void {
    if (!live) return;
    renderStats();
    renderBanner();
    renderRows();
    renderReleaseChip();
  }

  // ── Fetching ──────────────────────────────────────────────────────────────
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
      nodes = await listNodes({ config: cfg, noCache: true });
      lastFetchedAt = Date.now();
      cursor = 0;
      offset = 0;
      applyFilter();
    } catch (err) {
      nodes = [];
      filtered = [];
      statsText.content = `error: ${err instanceof Error ? err.message : String(err)}`;
      statsText.fg = C.red;
    } finally {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      loading = false;
      if (live) {
        statsText.fg = C.dim;
        renderAll();
      }
    }
  }

  renderAll();
  void fetchNodes();

  // ── Input ─────────────────────────────────────────────────────────────────
  return new Promise<'back'>((resolve) => {
    const done = () => {
      live = false;
      if (spinTimer) clearInterval(spinTimer);
      renderer.destroy();
      resolve('back');
    };

    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;

      // ── Modal capture ─────────────────────────────────────────────────────
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

      // ── Global shortcuts ──────────────────────────────────────────────────
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
