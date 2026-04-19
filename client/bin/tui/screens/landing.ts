import { readFile } from 'fs/promises';
import fs   from 'fs';
import path  from 'path';
import os    from 'os';
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
} from '@opentui/core';
import { C } from '../../theme';
import { makeSpin } from '../../lib/spinners';
import { workerRegistry } from '../screens/proxy/hub';

const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

// ─── Session store ────────────────────────────────────────────────────────────

type Session = {
  id:        string;
  type:      'http' | 'tcp' | 'ws';
  url:       string;
  target:    string;
  startedAt: number;
};

export function recordSession(session: Session): void {
  try {
    const dir = path.join(os.homedir(), '.consensus');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = loadSessions();
    const merged   = [session, ...existing.filter((s) => s.id !== session.id)].slice(0, 10);
    fs.writeFileSync(sessionsPath(), JSON.stringify(merged, null, 2));
  } catch { /* non-fatal */ }
}

function sessionsPath() { return path.join(os.homedir(), '.consensus', 'sessions.json'); }

function loadSessions(): Session[] {
  try {
    if (!fs.existsSync(sessionsPath())) return [];
    return JSON.parse(fs.readFileSync(sessionsPath(), 'utf8')) as Session[];
  } catch { return []; }
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
  const pkg     = await readFile(path.join(import.meta.dir, '../../../package.json'), 'utf8');
  const version = JSON.parse(pkg).version as string;

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
  for (const item of NAV) {
    const t = new TextRenderable(renderer, {
      content: ` ${item.icon}  ${item.label}`,
      fg: C.slate, bg: C.panel,
    });
    sidebar.add(t);
    navRefs.push(t);
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
  const netHttp    = mkSideNetRow('Avg HTTP');
  const netWs      = mkSideNetRow('Avg WS');
  const netTunnels = mkSideNetRow('Tunnels');
  const netLoad    = mkSideNetRow('Net load');

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
    borderStyle: 'single', borderColor: C.dim,
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
    borderStyle: 'single', borderColor: C.dim,
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
    borderStyle: 'single', borderColor: C.dim,
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

  bottomRow.add(spendPanel);

  // ── LOGS panel ────────────────────────────────────────────────────────────
  const logsPanel = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.dim,
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
  bottomBar.add(new TextRenderable(renderer, {
    content: '[↑↓] navigate   [↵] open   [q] quit',
    fg: C.slate, bg: C.panel,
  }));
  bottomBar.add(new TextRenderable(renderer, { content: 'canister.software', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── Sidebar state ─────────────────────────────────────────────────────────
  const ALL_ACTIONS = NAV.map(n => n.action);
  let navIdx = 0;

  const renderSidebar = () => {
    for (let i = 0; i < navRefs.length; i++) {
      const sel = i + 1 === navIdx;
      navRefs[i]!.fg      = sel ? C.accent : C.slate;
      navRefs[i]!.content = sel
        ? `▶${NAV[i]!.icon}  ${NAV[i]!.label}`
        : ` ${NAV[i]!.icon}  ${NAV[i]!.label}`;
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
  let isChecking = true;

  const spin      = makeSpin('checking');
  const spinTimer = setInterval(() => {
    if (!live || !isChecking) return;
    netStatus.content = `${spin()} CHECKING`;
  }, 100);

  fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(4000) })
    .then((r) => {
      if (!live) return;
      isChecking        = false;
      netStatus.content = r.ok ? '● CONNECTED' : '● DEGRADED';
      netStatus.fg      = r.ok ? C.emerald      : C.amber;
    })
    .catch(() => {
      if (!live) return;
      isChecking        = false;
      netStatus.content = '● OFFLINE';
      netStatus.fg      = C.red;
    });

  const fetchStats = () => {
    fetch(`${SERVER}/stats`, { signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!live || !r.ok) return;
        const d = await r.json() as Record<string, unknown>;
        if (!live) return;
        if (typeof d.nodes     === 'number') { netNodes.content   = String(d.nodes);        netNodes.fg   = C.white; }
        if (typeof d.latency   === 'number') { netHttp.content    = `${d.latency}ms`;      netHttp.fg    = C.white; }
        if (typeof d.wsLatency === 'number') { netWs.content      = `${d.wsLatency}ms`;    netWs.fg      = C.white; }
        if (typeof d.tunnels   === 'number') { netTunnels.content = String(d.tunnels);      netTunnels.fg = C.white; }
        if (typeof d.load      === 'number') { netLoad.content    = `${d.load}%`;           netLoad.fg    = d.load > 80 ? C.red : d.load > 50 ? C.amber : C.white; }
      })
      .catch(() => { /* non-fatal */ });
  };

  fetchStats();
  const statsTimer   = setInterval(fetchStats, 5000);
  refreshDashboard();
  const dashTimer    = setInterval(() => { if (live) refreshDashboard(); }, 1000);

  // ── Key input ─────────────────────────────────────────────────────────────
  return new Promise<LandingAction>((resolve) => {
    const done = (action: LandingAction) => {
      live = false;
      clearInterval(spinTimer);
      clearInterval(statsTimer);
      clearInterval(dashTimer);
      renderer.destroy();
      resolve(action);
    };

    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;
      if (key.ctrl && key.name === 'c') { done('quit'); return; }
      if (key.name === 'q' || key.name === 'Q') { done('quit'); return; }

      if (key.name === 'up' || key.name === 'k') {
        navIdx = navIdx <= 1 ? NAV.length : navIdx - 1;
        renderSidebar();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        navIdx = navIdx >= NAV.length ? 1 : navIdx + 1;
        renderSidebar();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (navIdx === 0) return;
        done(ALL_ACTIONS[navIdx - 1]!);
        return;
      }
    });
  });
}
