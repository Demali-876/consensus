/**
 * ips.ts — Node browser and IP lease screen.
 *
 * Shows the list of available consensus nodes with their IPs, region, and
 * capabilities. The user can select a node to pin all traffic to it (lease),
 * or release an existing lease to return to automatic selection.
 *
 * Keys:
 *   ↑ / ↓   Navigate node list
 *   ↵        Lease selected node
 *   D        Release current lease
 *   R        Refresh node list
 *   B        Back to landing
 */

import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../../theme';
import { makeSpin } from '../../lib/spinners';
import { isFreeMode } from '../../lib/server-config';
import { loadConfig } from '../../lib/config.ts';
import { listNodes, leaseNode, releaseNode, fmtCapabilities } from '../../lib/ip.ts';
import type { NodeInfo } from '../../lib/ip.ts';

// ─── Formatting ────────────────────────────────────────────────────────────────

function fmtIp(node: NodeInfo): string {
  if (node.ipv4) return node.ipv4;
  if (node.ipv6) return node.ipv6.length > 18 ? node.ipv6.slice(0, 17) + '…' : node.ipv6;
  return '—';
}

function fmtRegion(r?: string): string {
  return (r ?? '—').slice(0, 10);
}

function fmtScore(s?: number): string {
  if (s == null) return '  —  ';
  return String(Math.round(s)).padStart(3) + '/100';
}

function fmtLeaseAge(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(d)) return 'unknown';
  if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function nodeLeaseTarget(node: NodeInfo): string {
  return node.domain || node.node_id || '';
}

// ─── Column widths ─────────────────────────────────────────────────────────────

const COL = { idx: 3, region: 10, ip: 18, domain: 34, score: 8, caps: 18 };

function tableHeader(): string {
  return [
    ' # '.padEnd(COL.idx),
    'REGION'.padEnd(COL.region),
    'IP'.padEnd(COL.ip),
    'DOMAIN'.padEnd(COL.domain),
    'SCORE'.padEnd(COL.score),
    'CAPS',
  ].join('  ');
}

function tableRow(node: NodeInfo, idx: number, isLeased: boolean): string {
  const num    = String(idx + 1).padEnd(COL.idx);
  const region = fmtRegion(node.region).padEnd(COL.region);
  const ip     = fmtIp(node).padEnd(COL.ip);
  const domain = (node.domain ?? '—').slice(0, COL.domain - 1).padEnd(COL.domain);
  const score  = fmtScore(node.benchmark_score).padEnd(COL.score);
  const caps   = fmtCapabilities(node.capabilities);
  const mark   = isLeased ? ' ●' : '  ';
  return mark + num + region + '  ' + ip + '  ' + domain + '  ' + score + '  ' + caps;
}

// ─── Screen ────────────────────────────────────────────────────────────────────

const MAX_VISIBLE = 12;

export async function showIps(): Promise<'back'> {
  const freeMode = await isFreeMode();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding       = 0;

  // ── Top bar ─────────────────────────────────────────────────────────────────
  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'IP LEASE',  fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // ── Content ─────────────────────────────────────────────────────────────────
  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 2, paddingTop: 1, paddingBottom: 1,
    backgroundColor: C.dark,
  });
  root.add(content);

  // ── Bottom bar ───────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const hintsRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.panel });
  bottomBar.add(hintsRef);
  bottomBar.add(new TextRenderable(renderer, { content: 'IP LEASE', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── Lease status row ─────────────────────────────────────────────────────────
  const leaseRef = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
  content.add(leaseRef);
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  // ── Free-mode badge ──────────────────────────────────────────────────────────
  if (freeMode) {
    content.add(new TextRenderable(renderer, {
      content: '  ○  Free mode — traffic on the selected node costs nothing',
      fg: C.emerald, bg: C.dark,
    }));
    content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  }

  // ── Table header ─────────────────────────────────────────────────────────────
  content.add(new TextRenderable(renderer, { content: '  ' + tableHeader(), fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: '  ' + '─'.repeat(95), fg: C.dim, bg: C.dark }));

  // ── Node rows (pre-allocated) ─────────────────────────────────────────────────
  const rowRefs: TextRenderable[] = [];
  for (let i = 0; i < MAX_VISIBLE; i++) {
    const t = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    content.add(t);
    rowRefs.push(t);
  }

  // ── Status / spinner area ─────────────────────────────────────────────────────
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  const statusRef = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  content.add(statusRef);

  // ── State ─────────────────────────────────────────────────────────────────────
  let live      = true;
  let nodes:    NodeInfo[] = [];
  let cursor    = 0;
  let offset    = 0;   // scroll offset
  let loading   = false;

  // ── Render ────────────────────────────────────────────────────────────────────
  function renderLease(): void {
    if (!live) return;
    const cfg = loadConfig();
    if (cfg.leased_node) {
      const ln = cfg.leased_node;
      leaseRef.content = `  ● LEASED  ${ln.domain}${ln.region ? '  · ' + ln.region : ''}  · since ${fmtLeaseAge(ln.leased_at)}`;
      leaseRef.fg      = C.emerald;
    } else {
      leaseRef.content = '  ○ No lease active — traffic uses automatic node selection';
      leaseRef.fg      = C.dim;
    }
  }

  function renderRows(): void {
    if (!live) return;
    const cfg = loadConfig();
    const leasedDomain = cfg.leased_node?.domain;
    const visible = nodes.slice(offset, offset + MAX_VISIBLE);

    for (let i = 0; i < MAX_VISIBLE; i++) {
      const node = visible[i];
      if (!node) { rowRefs[i]!.content = ''; continue; }

      const globalIdx  = offset + i;
      const isSelected = globalIdx === cursor;
      const isLeased   = !!leasedDomain && nodeLeaseTarget(node) === leasedDomain;
      const row        = tableRow(node, globalIdx, isLeased);

      rowRefs[i]!.content = isSelected ? `▶ ${row.slice(2)}` : row;
      rowRefs[i]!.fg      = isSelected
        ? C.white
        : isLeased
          ? C.emerald
          : C.slate;
    }
  }

  function renderHints(): void {
    if (!live) return;
    const cfg = loadConfig();
    const hasLease = !!cfg.leased_node;
    hintsRef.content = loading
      ? '[R  cancel / retry]  [B  back]'
      : nodes.length === 0
        ? '[R  refresh]  [B  back]'
        : `[↑↓  navigate]  [↵  lease selected]${hasLease ? '  [D  release]' : ''}  [R  refresh]  [B  back]`;
  }

  function renderAll(): void {
    if (!live) return;
    renderLease();
    renderRows();
    renderHints();
  }

  // ── Node fetching ─────────────────────────────────────────────────────────────
  const spin      = makeSpin('checking');
  let spinTimer: ReturnType<typeof setInterval> | null = null;

  async function fetchNodes(): Promise<void> {
    if (!live || loading) return;
    loading   = true;
    cursor    = 0;
    offset    = 0;
    nodes     = [];
    renderAll();

    if (!live) return;
    statusRef.content = `${spin()}  Fetching nodes…`;
    statusRef.fg      = C.dim;
    spinTimer = setInterval(() => {
      if (!live || !loading) { clearInterval(spinTimer!); return; }
      statusRef.content = `${spin()}  Fetching nodes…`;
    }, 100);

    try {
      const cfg = loadConfig();
      nodes = await listNodes({ config: cfg, noCache: true });
      if (!live) return;
      statusRef.content = nodes.length > 0
        ? `  ${nodes.length} node${nodes.length === 1 ? '' : 's'} available`
        : '  No nodes found — check your connection';
      statusRef.fg = nodes.length > 0 ? C.slate : C.amber;
    } catch (err) {
      if (!live) return;
      nodes = [];
      statusRef.content = `  Error: ${err instanceof Error ? err.message : String(err)}`;
      statusRef.fg      = C.red;
    } finally {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      loading = false;
      if (live) renderAll();
    }
  }

  // ── Initial render + fetch ────────────────────────────────────────────────────
  renderAll();
  fetchNodes();

  // ── Key input ─────────────────────────────────────────────────────────────────
  return new Promise<'back'>((resolve) => {
    const done = () => {
      live = false;
      if (spinTimer) clearInterval(spinTimer);
      renderer.destroy();
      resolve('back');
    };

    renderer.keyInput.on('keypress', async (key) => {
      if (!live) return;

      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        done();
        return;
      }

      if (key.name === 'r' || key.name === 'R') {
        fetchNodes();
        return;
      }

      if (loading || nodes.length === 0) return;

      // ── Navigation ────────────────────────────────────────────────────────────
      if (key.name === 'up' || key.name === 'k') {
        cursor = Math.max(0, cursor - 1);
        if (cursor < offset) offset = cursor;
        renderAll();
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        cursor = Math.min(nodes.length - 1, cursor + 1);
        if (cursor >= offset + MAX_VISIBLE) offset = cursor - MAX_VISIBLE + 1;
        renderAll();
        return;
      }

      // ── Lease selected ────────────────────────────────────────────────────────
      if (key.name === 'return' || key.name === 'enter') {
        const node = nodes[cursor];
        if (!node) return;
        const cfg = loadConfig();
        const target = nodeLeaseTarget(node);
        if (!target) {
          statusRef.content = '  Error: selected node cannot be leased';
          statusRef.fg      = C.red;
          renderAll();
          return;
        }
        try {
          leaseNode({ config: cfg, nodeIdOrDomain: target, nodes });
          statusRef.content = `  ✓  Leased  ${target}${node.region ? '  · ' + node.region : ''}`;
          statusRef.fg      = C.emerald;
        } catch (err) {
          statusRef.content = `  Error: ${err instanceof Error ? err.message : String(err)}`;
          statusRef.fg      = C.red;
        }
        renderAll();
        return;
      }

      // ── Release ───────────────────────────────────────────────────────────────
      if (key.name === 'd' || key.name === 'D') {
        const cfg = loadConfig();
        if (!cfg.leased_node) return;
        const prev = cfg.leased_node.domain;
        releaseNode(cfg);
        statusRef.content = `  ✓  Released lease for ${prev}`;
        statusRef.fg      = C.slate;
        renderAll();
        return;
      }
    });
  });
}
