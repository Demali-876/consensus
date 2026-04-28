import { readFile } from 'fs/promises';
import * as path from 'node:path';
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
} from '@opentui/core';
import { C } from '../../theme';
import { makeSpin } from '../../lib/spinners';
import { isFreeMode } from '../../lib/server-config';
import { workerRegistry } from '../screens/proxy/hub';
import { saveSession, loadSpending, type SessionRecord, type SessionType } from '../../lib/store';

const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

// ─── Session store ────────────────────────────────────────────────────────────

export function recordSession(session: {
  id: string; type: SessionType; url: string; target: string; startedAt: number;
}): void {
  try {
    saveSession(session as SessionRecord);
  } catch { /* non-fatal */ }
}

// ─── Nav items ────────────────────────────────────────────────────────────────

export type LandingAction =
  | 'tunnels' | 'proxy' | 'proxy-forward' | 'proxy-reverse'
  | 'websockets' | 'ips' | 'settings' | 'quit';

type NavItem = { icon: string; label: string; action: LandingAction };

const NAV: NavItem[] = [
  { icon: '⇄',  label: 'TUNNEL',    action: 'tunnels'    },
  { icon: '⟳',  label: 'PROXY',     action: 'proxy'      },
  { icon: '⚡',  label: 'WEBSOCKET', action: 'websockets' },
  { icon: '⬡',  label: 'IP LEASE',  action: 'ips'        },
  { icon: '⚙',  label: 'SETTINGS',  action: 'settings'   },
];

// ─── Landing ──────────────────────────────────────────────────────────────────

export async function showLanding(): Promise<LandingAction> {
  const pkg      = await readFile(path.join(import.meta.dir, '../../../package.json'), 'utf8');
  const version  = JSON.parse(pkg).version as string;
  const freeMode = await isFreeMode();

  const renderer = await createCliRenderer({
    exitOnCtrlC:        false,
    targetFps:          15,
    useMouse:           false,
    useAlternateScreen: true,
  });

  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding       = 0;

  // ── Top bar ───────────────────────────────────────────────────────────────
  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS',                        fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'Your private network, on demand.', fg: C.dim,   bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: `v${version}`,                      fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // ── Main row ──────────────────────────────────────────────────────────────
  const mainRow = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row',
    backgroundColor: C.dark,
  });

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const sidebar = new BoxRenderable(renderer, {
    width: 20, flexShrink: 0, flexDirection: 'column',
    paddingX: 1, paddingTop: 1,
    backgroundColor: C.panel,
  });

  sidebar.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.panel }));
  const navRefs: TextRenderable[] = [];
  const proxySubRefs: TextRenderable[] = [];
  for (let ni = 0; ni < NAV.length; ni++) {
    const item = NAV[ni]!;
    const t = new TextRenderable(renderer, {
      content: ` ${item.icon}  ${item.label}`,
      fg: C.slate, bg: C.panel,
    });
    sidebar.add(t);
    navRefs.push(t);
    if (item.action === 'proxy') {
      // Created but NOT added yet — inserted/removed dynamically on expand/collapse
      const fwd = new TextRenderable(renderer, { id: 'proxy-fwd', content: '', fg: C.slate, bg: C.panel });
      const rev = new TextRenderable(renderer, { id: 'proxy-rev', content: '', fg: C.slate, bg: C.panel });
      proxySubRefs.push(fwd, rev);
    }
  }

  // Network section
  sidebar.add(new TextRenderable(renderer, { content: ' ',           fg: C.dim, bg: C.panel }));
  sidebar.add(new TextRenderable(renderer, { content: '─'.repeat(17), fg: C.dim, bg: C.panel }));
  sidebar.add(new TextRenderable(renderer, { content: ' NETWORK',    fg: C.dim, bg: C.panel }));

  const mkSideNetRow = (label: string): TextRenderable => {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', justifyContent: 'space-between',
      backgroundColor: 'transparent',
    });
    row.add(new TextRenderable(renderer, { content: ` ${label}`, fg: C.dim,   bg: 'transparent' }));
    const val = new TextRenderable(renderer,  { content: '—',    fg: C.slate, bg: 'transparent' });
    row.add(val);
    sidebar.add(row);
    return val;
  };

  const netNodes   = mkSideNetRow('Nodes');
  const netHttp    = mkSideNetRow('HTTP bench');
  const netWs      = mkSideNetRow('WS avg p95');
  const netTunnels = mkSideNetRow('Tunnels');

  sidebar.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.panel }));
  const netStatus = new TextRenderable(renderer, { content: '○ CHECKING', fg: C.dim, bg: C.panel });
  sidebar.add(netStatus);

  // Wallet
  sidebar.add(new TextRenderable(renderer, { content: ' ',          fg: C.dim, bg: C.panel }));
  sidebar.add(new TextRenderable(renderer, { content: '─'.repeat(17), fg: C.dim, bg: C.panel }));
  sidebar.add(new TextRenderable(renderer, { content: ' Wallet',    fg: C.dim, bg: C.panel }));
  const walletRef = new TextRenderable(renderer, { content: ' ✓ Loaded', fg: C.emerald, bg: C.panel });
  sidebar.add(walletRef);

  mainRow.add(sidebar);

  // ── Content area ──────────────────────────────────────────────────────────
  const content = new BoxRenderable(renderer, {
    flexGrow: 1, flexDirection: 'column',
    gap: 1, paddingX: 2, paddingTop: 1, paddingBottom: 1,
    backgroundColor: C.dark,
  });

  const topRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2,
    backgroundColor: C.dark,
  });

  const bottomRow = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2,
    backgroundColor: C.dark,
  });

  // ── WORKERS panel ─────────────────────────────────────────────────────────
  const workersPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.line2,
    title: ' WORKERS ', padding: 1,
    backgroundColor: C.panel,
  });

  const W_COLS = { id: 2, type: 3, port: 5, reqs: 5, avg: 6, p95: 6, status: 6 };
  const workerHeader = new TextRenderable(renderer, {
    content: [
      '#'.padEnd(W_COLS.id),
      'TYP'.padEnd(W_COLS.type),
      'PORT'.padEnd(W_COLS.port),
      'REQS'.padStart(W_COLS.reqs),
      'AVG'.padStart(W_COLS.avg),
      'P95'.padStart(W_COLS.p95),
      'STATUS',
    ].join('  '),
    fg: C.dim, bg: 'transparent',
  });
  workersPanel.add(workerHeader);
  workersPanel.add(new TextRenderable(renderer, { content: '─'.repeat(42), fg: C.dim, bg: 'transparent' }));

  const MAX_WORKERS = 4;
  const workerLines: TextRenderable[] = [];
  for (let i = 0; i < MAX_WORKERS; i++) {
    const t = new TextRenderable(renderer, { content: '', fg: C.dim, bg: 'transparent' });
    workersPanel.add(t);
    workerLines.push(t);
  }

  topRow.add(workersPanel);

  // ── ACTIVE CONNECTIONS panel ──────────────────────────────────────────────
  const connPanel = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.line2,
    title: ' ACTIVE CONNECTIONS ', padding: 1,
    backgroundColor: C.panel,
  });

  const C_COLS = { type: 4, url: 22, reqs: 6, din: 8, dout: 8, status: 6 };
  connPanel.add(new TextRenderable(renderer, {
    content: [
      'TYPE'.padEnd(C_COLS.type),
      'URL'.padEnd(C_COLS.url),
      'REQS'.padStart(C_COLS.reqs),
      'DOWNLOAD'.padStart(C_COLS.din),
      'UPLOAD'.padStart(C_COLS.dout),
      'STATUS',
    ].join('  '),
    fg: C.dim, bg: 'transparent',
  }));
  connPanel.add(new TextRenderable(renderer, { content: '─'.repeat(52), fg: C.dim, bg: 'transparent' }));

  const MAX_CONN = 5;
  const connRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_CONN; i++) {
    const t = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
    connPanel.add(t);
    connRows.push(t);
  }
  // populated by refreshDashboard()

  topRow.add(connPanel);

  // ── SPENDING panel ────────────────────────────────────────────────────────
  const spendPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.line2,
    title: ' SPENDING ', padding: 1,
    backgroundColor: C.panel,
  });

  const spendGraph  = new TextRenderable(renderer, { content: 'No spending data', fg: C.dim,   bg: 'transparent' });
  const spendBudget = new TextRenderable(renderer, { content: '',                  fg: C.slate, bg: 'transparent' });
  const spendSpent  = new TextRenderable(renderer, { content: '',                  fg: C.slate, bg: 'transparent' });
  spendPanel.add(spendGraph);
  spendPanel.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: 'transparent' }));
  spendPanel.add(spendBudget);
  spendPanel.add(spendSpent);

  if (!freeMode) bottomRow.add(spendPanel);

  // ── LOGS panel ────────────────────────────────────────────────────────────
  const logsPanel = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.line2,
    title: ' LOGS ', padding: 1,
    backgroundColor: C.panel,
  });

  const MAX_LOGS = 6;
  const logLines: TextRenderable[] = [];
  for (let i = 0; i < MAX_LOGS; i++) {
    const t = new TextRenderable(renderer, { content: '', fg: C.dim, bg: 'transparent' });
    logsPanel.add(t);
    logLines.push(t);
  }
  logLines[0]!.content = 'No activity yet';

  bottomRow.add(logsPanel);

  content.add(topRow);
  content.add(bottomRow);
  mainRow.add(content);
  root.add(mainRow);

  // ── Bottom bar ────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const hintsRef = new TextRenderable(renderer, {
    content: '[↑↓] navigate   [↵] open   [R] refresh   [q] quit',
    fg: C.slate, bg: C.panel,
  });
  bottomBar.add(hintsRef);
  bottomBar.add(new TextRenderable(renderer, { content: 'canister.software', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── Sidebar state ─────────────────────────────────────────────────────────
  // Two modes:
  //   'main'      — navigating the top-level NAV list; PROXY is a normal item
  //   'proxy-sub' — inside the proxy dropdown; B or Esc collapses back
  const PROXY_NAV_IDX = NAV.findIndex(n => n.action === 'proxy'); // 1
  const PROXY_SUB = [
    { label: 'Forward Proxy', action: 'proxy-forward' as LandingAction, desc: 'route outbound traffic through the consensus network' },
    { label: 'Reverse Proxy', action: 'proxy-reverse' as LandingAction, desc: 'protect a local server with a caching proxy' },
  ];

  type SidebarMode = { kind: 'main'; idx: number } | { kind: 'proxy-sub'; sub: number };
  let navMode: SidebarMode  = { kind: 'main', idx: 0 };
  let proxySubAdded         = false;

  const renderSidebar = () => {
    const proxyOpen = navMode.kind === 'proxy-sub';

    // Dynamically insert sub-items into sidebar after PROXY row when expanding,
    // and remove them when collapsing — prevents them from occupying layout space.
    if (proxyOpen && !proxySubAdded) {
      const anchor = navRefs[PROXY_NAV_IDX + 1]; // node after PROXY (WEBSOCKET)
      if (anchor) {
        sidebar.insertBefore(proxySubRefs[0]!, anchor);
        sidebar.insertBefore(proxySubRefs[1]!, anchor);
      } else {
        sidebar.add(proxySubRefs[0]!);
        sidebar.add(proxySubRefs[1]!);
      }
      proxySubAdded = true;
    } else if (!proxyOpen && proxySubAdded) {
      sidebar.remove('proxy-fwd');
      sidebar.remove('proxy-rev');
      proxySubAdded = false;
    }

    for (let i = 0; i < NAV.length; i++) {
      const sel = navMode.kind === 'main' && navMode.idx === i + 1;
      const fg  = sel ? C.accent : (proxyOpen && i === PROXY_NAV_IDX ? C.white : C.slate);
      navRefs[i]!.fg      = fg;
      navRefs[i]!.content = sel
        ? `▶${NAV[i]!.icon}  ${NAV[i]!.label}`
        : ` ${NAV[i]!.icon}  ${NAV[i]!.label}`;
    }

    if (proxyOpen) {
      const sub = (navMode as { kind: 'proxy-sub'; sub: number }).sub;
      for (let i = 0; i < PROXY_SUB.length; i++) {
        const sel = sub === i;
        proxySubRefs[i]!.content = `  ${sel ? '▶' : ' '} ${PROXY_SUB[i]!.label}`;
        proxySubRefs[i]!.fg      = sel ? C.accent : C.slate;
      }
      hintsRef.content = PROXY_SUB[sub]!.desc;
      hintsRef.fg      = C.dim;
    } else {
      hintsRef.content = '[↑↓] navigate   [↵] open   [R] refresh   [q] quit';
      hintsRef.fg      = C.slate;
    }
  };

  renderSidebar();

  // ── Dashboard refresh ─────────────────────────────────────────────────────
  const fmtHms = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map(n => String(n).padStart(2, '0')).join(':');
  };

  const fmtLat   = (ms?: number): string  => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  const fmtReqs  = (n: number): string    => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
  const fmtBytes = (b: number): string    => b >= 1_073_741_824 ? `${(b / 1_073_741_824).toFixed(1)} GB` : b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : b >= 1_024 ? `${(b / 1_024).toFixed(1)} KB` : `${b} B`;

  const refreshDashboard = (): void => {
    // WORKERS
    const fmtStatus = (code?: number): string => {
      if (code == null) return '—';
      if (code < 300) return `${code} OK`;
      if (code < 400) return `${code} RDR`;
      if (code < 500) return `${code} ERR`;
      return `${code} FAIL`;
    };

    const workers = workerRegistry.slice(0, MAX_WORKERS);
    if (workers.length === 0) {
      workerLines[0]!.content = 'No active workers';
      workerLines[0]!.fg      = C.dim;
      for (let i = 1; i < MAX_WORKERS; i++) workerLines[i]!.content = '';
    } else {
      for (let i = 0; i < MAX_WORKERS; i++) {
        const w = workers[i];
        if (!w) { workerLines[i]!.content = ''; workerLines[i]!.fg = C.dim; continue; }
        const s      = w.handle.stats();
        const id     = String(i + 1).padEnd(W_COLS.id);
        const type   = (w.handle.type === 'forward' ? 'fwd' : 'rev').padEnd(W_COLS.type);
        const port   = `:${w.handle.port}`.padEnd(W_COLS.port);
        const reqs   = fmtReqs(s.requests).padStart(W_COLS.reqs);
        const avg    = fmtLat(s.avgLatencyMs).padStart(W_COLS.avg);
        const p95    = fmtLat(s.p95LatencyMs).padStart(W_COLS.p95);
        const status = fmtStatus(s.lastStatusCode).padEnd(W_COLS.status);
        workerLines[i]!.content = [id, type, port, reqs, avg, p95, status].join('  ');
        const isErr = s.lastStatusCode != null && s.lastStatusCode >= 400;
        workerLines[i]!.fg = isErr ? C.red : C.emerald;
      }
    }

    // ACTIVE CONNECTIONS — proxy workers as HTTP/TCP/WS rows
    const conns = workerRegistry.slice(0, MAX_CONN);
    if (conns.length === 0) {
      connRows[0]!.content = 'No active connections';
      connRows[0]!.fg      = C.dim;
      connRows[2]!.content = '[T] new tunnel    [W] new websocket';
      connRows[2]!.fg      = C.dim;
      for (let i = 1; i < MAX_CONN; i++) if (i !== 2) connRows[i]!.content = '';
    } else {
      connRows[2]!.content = '';
      for (let i = 0; i < MAX_CONN; i++) {
        const w = conns[i];
        if (!w) { connRows[i]!.content = ''; connRows[i]!.fg = C.dim; continue; }
        const s      = w.handle.stats();
        // forward proxy = HTTP (outbound), reverse proxy = HTTP (inbound)
        const type     = 'http'.padEnd(C_COLS.type);
        const rawUrl   = `localhost:${w.handle.port}`;
        const url      = (rawUrl.length > C_COLS.url ? rawUrl.slice(0, C_COLS.url - 1) + '…' : rawUrl).padEnd(C_COLS.url);
        const reqs     = fmtReqs(s.requests).padStart(C_COLS.reqs);
        const download = fmtBytes(s.bytesRecv).padStart(C_COLS.din);
        const upload   = fmtBytes(s.bytesSent).padStart(C_COLS.dout);
        const status   = fmtStatus(s.lastStatusCode).padEnd(C_COLS.status);
        connRows[i]!.content = [type, url, reqs, download, upload, status].join('  ');
        const isErr = s.lastStatusCode != null && s.lastStatusCode >= 400;
        connRows[i]!.fg = isErr ? C.red : C.slate;
      }
    }
  };

  // ── Live state ────────────────────────────────────────────────────────────
  let live       = true;
  let isChecking = false;

  const spin      = makeSpin('checking');
  const spinTimer = setInterval(() => {
    if (!live || !isChecking) return;
    netStatus.content = `${spin()} CHECKING`;
  }, 100);

  function doRefresh(): void {
    if (isChecking) return;
    isChecking        = true;
    netStatus.content = `${spin()} CHECKING`;
    netStatus.fg      = C.dim;

    fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!live) return;
        isChecking        = false;
        netStatus.content = r.ok ? '● CONNECTED' : '● DEGRADED';
        netStatus.fg      = r.ok ? C.emerald      : C.amber;
        if (!r.ok) return;
        const d = await r.json() as {
          websocket?: { router_stats?: { active_nodes?: number } };
          tunnels?:   { active_tunnels?: number };
          network?:   { avg_http_latency_ms?: number | null; avg_ws_latency_ms?: number | null };
        };
        if (!live) return;
        const nodes   = d.websocket?.router_stats?.active_nodes;
        const httpLat = d.network?.avg_http_latency_ms;
        const wsLat   = d.network?.avg_ws_latency_ms;
        const tunnels = d.tunnels?.active_tunnels;
        if (typeof nodes   === 'number') { netNodes.content   = String(nodes);   netNodes.fg   = C.white; }
        if (typeof httpLat === 'number') { netHttp.content    = `${httpLat}ms`;  netHttp.fg    = C.white; }
        if (typeof wsLat   === 'number') { netWs.content      = `${wsLat}ms`;    netWs.fg      = C.white; }
        if (typeof tunnels === 'number') { netTunnels.content = String(tunnels); netTunnels.fg = C.white; }
      })
      .catch(() => {
        if (!live) return;
        isChecking        = false;
        netStatus.content = '● OFFLINE';
        netStatus.fg      = C.red;
      });
  }

  const refreshSpend = (): void => {
    if (freeMode) return;
    try {
      const ledger  = loadSpending();
      const today   = new Date().toISOString().slice(0, 10);
      const todayUsd = ledger.entries
        .filter(e => e.date === today)
        .reduce((s, e) => s + e.amountUsd, 0);
      if (ledger.allTimeUsd === 0) {
        spendGraph.content  = ' No spending data';
        spendGraph.fg       = C.dim;
        spendBudget.content = '';
        spendSpent.content  = '';
      } else {
        spendGraph.content  = ` Today     $${todayUsd.toFixed(4)}`;
        spendGraph.fg       = todayUsd > 0 ? C.white : C.slate;
        spendBudget.content = ` All-time  $${ledger.allTimeUsd.toFixed(4)}`;
        spendBudget.fg      = C.slate;
        spendSpent.content  = ` Sessions  ${ledger.entries.length}`;
        spendSpent.fg       = C.dim;
      }
    } catch { /* non-fatal */ }
  };

  refreshDashboard();
  refreshSpend();
  const dashTimer = setInterval(() => { if (live) { refreshDashboard(); refreshSpend(); } }, 1000);

  // ── Key input ─────────────────────────────────────────────────────────────
  return new Promise<LandingAction>((resolve) => {
    let confirming = false;

    const done = (action: LandingAction) => {
      live = false;
      clearInterval(spinTimer);
      clearInterval(dashTimer);
      renderer.destroy();
      resolve(action);
    };

    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;

      // Quit confirmation
      if (confirming) {
        if (key.name === 'y' || key.name === 'Y') { done('quit'); return; }
        confirming        = false;
        hintsRef.content  = '[↑↓] navigate   [↵] open   [R] refresh   [q] quit';
        hintsRef.fg       = C.slate;
        return;
      }

      if (key.name === 'r' || key.name === 'R') { doRefresh(); return; }

      if (key.ctrl && key.name === 'c') { done('quit'); return; }
      if (key.name === 'q' || key.name === 'Q') {
        confirming       = true;
        hintsRef.content = 'Quit consensus?   [Y] yes   [any] cancel';
        hintsRef.fg      = C.amber;
        return;
      }

      if (key.name === 'b' || key.name === 'B' || key.name === 'escape') {
        if (navMode.kind === 'proxy-sub') {
          navMode = { kind: 'main', idx: PROXY_NAV_IDX + 1 };
          renderSidebar();
        }
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        if (navMode.kind === 'proxy-sub') {
          navMode = navMode.sub > 0
            ? { kind: 'proxy-sub', sub: navMode.sub - 1 }
            : { kind: 'main', idx: PROXY_NAV_IDX + 1 }; // back to PROXY item
        } else {
          const idx = navMode.idx <= 1 ? NAV.length : navMode.idx - 1;
          navMode = { kind: 'main', idx };
        }
        renderSidebar();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        if (navMode.kind === 'proxy-sub') {
          navMode = navMode.sub < PROXY_SUB.length - 1
            ? { kind: 'proxy-sub', sub: navMode.sub + 1 }
            : { kind: 'main', idx: PROXY_NAV_IDX + 2 }; // to item after PROXY
        } else {
          const idx = navMode.idx >= NAV.length ? 1 : navMode.idx + 1;
          navMode = { kind: 'main', idx };
        }
        renderSidebar();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (navMode.kind === 'proxy-sub') {
          done(PROXY_SUB[navMode.sub]!.action);
        } else if (navMode.idx > 0) {
          const item = NAV[navMode.idx - 1]!;
          if (item.action === 'proxy') {
            // Expand the dropdown
            navMode = { kind: 'proxy-sub', sub: 0 };
            renderSidebar();
          } else {
            done(item.action);
          }
        }
        return;
      }
    });
  });
}
