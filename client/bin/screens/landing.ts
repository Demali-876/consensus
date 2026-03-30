/**
 * Landing screen
 *
 * Layout:
 *   Top bar      — CONSENSUS left, version right
 *   Centre       — block logo + tagline
 *   Main row     — left col (Recent + Network) | right col (Command Palette)
 *   Status line  — live server health
 *   Bottom bar   — hints left, canister.software right
 */

import { readFile } from 'fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createCliRenderer,
  ASCIIFontRenderable,
  BoxRenderable,
  TextRenderable,
} from '@opentui/core';
import { C } from '../theme';

const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

// ─── Session store ────────────────────────────────────────────────────────────

type Session = {
  id:        string;
  type:      'http' | 'tcp';
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

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

// ─── Command palette commands ─────────────────────────────────────────────────

export type LandingAction = 'menu' | 'tunnels' | 'proxy' | 'reverse-proxy' | 'websockets' | 'ips' | 'quit';

type Command = { label: string; hint: string; action: LandingAction };

const COMMANDS: Command[] = [
  { label: 'new tunnel',    hint: 'HTTP/TCP → public URL',    action: 'tunnels'       },
  { label: 'proxy',         hint: 'open proxy dashboard',     action: 'proxy'         },
  { label: 'reverse proxy', hint: 'expose a remote service',  action: 'reverse-proxy' },
  { label: 'websocket',     hint: 'WS tunnel',                action: 'websockets'    },
  { label: 'join node',     hint: 'join node / IP allowlist', action: 'ips'           },
  { label: 'view stats',    hint: 'network statistics',       action: 'menu'          },
];

const MAX_PALETTE_ROWS = 6;

// ─── Landing ──────────────────────────────────────────────────────────────────

export async function showLanding(): Promise<LandingAction> {
  const pkg     = await readFile(path.join(import.meta.dir, '../../package.json'), 'utf8');
  const version = JSON.parse(pkg).version as string;
  const recent  = loadSessions();

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
    width:           '100%',
    flexDirection:   'row',
    justifyContent:  'space-between',
    paddingX:        2,
    paddingY:        0,
    backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white,  bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: `v${version}`, fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // ── Centre — logo + tagline ───────────────────────────────────────────────
  const centre = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'column',
    alignItems:      'center',
    paddingTop:      2,
    paddingBottom:   1,
    backgroundColor: C.dark,
  });

  centre.add(new ASCIIFontRenderable(renderer, {
    text:            'CONSENSUS',
    font:            'block',
    color:           C.white,
    backgroundColor: C.dark,
  }));

  const tagRow = new BoxRenderable(renderer, {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    paddingTop:     1,
    backgroundColor: C.dark,
  });
  const segments: [string, string][] = [
    ['I am',      C.dim],
    [' · ',       C.dim],
    ['you are',   C.slate],
    [' · ',       C.dim],
    ['we are',    C.slate],
    [' · ',       C.dim],
    ['consensus', C.white],
  ];
  for (const [text, fg] of segments) {
    tagRow.add(new TextRenderable(renderer, { content: text, fg, bg: C.dark }));
  }
  centre.add(tagRow);
  root.add(centre);

  // ── Main content row ──────────────────────────────────────────────────────
  const mainRow = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'row',
    gap:             2,
    paddingX:        4,
    paddingTop:      2,
    paddingBottom:   1,
    backgroundColor: C.dark,
  });

  // Left column — Recent + Network stacked
  const leftCol = new BoxRenderable(renderer, {
    flexGrow:        1,
    flexShrink:      1,
    flexDirection:   'column',
    gap:             1,
    backgroundColor: C.dark,
  });

  // ── Recent sessions ───────────────────────────────────────────────────────
  const recentBox = new BoxRenderable(renderer, {
    width:           '100%',
    borderStyle:     'single',
    borderColor:     C.dim,
    title:           ' Recent ',
    padding:         1,
    backgroundColor: C.panel,
  });

  if (recent.length === 0) {
    recentBox.add(new TextRenderable(renderer, { content: '  No recent sessions', fg: C.dim, bg: C.panel }));
  } else {
    for (const s of recent.slice(0, 5)) {
      const row = new BoxRenderable(renderer, {
        flexDirection:   'row',
        justifyContent:  'space-between',
        backgroundColor: 'transparent',
      });
      const icon = s.type === 'http' ? '⇄' : '⟳';
      row.add(new TextRenderable(renderer, { content: `  ${icon}  ${s.id}`, fg: C.slate, bg: 'transparent' }));
      row.add(new TextRenderable(renderer, { content: timeAgo(s.startedAt),  fg: C.dim,   bg: 'transparent' }));
      recentBox.add(row);
    }
  }
  leftCol.add(recentBox);

  // ── Network panel ─────────────────────────────────────────────────────────
  const networkBox = new BoxRenderable(renderer, {
    width:           '100%',
    borderStyle:     'single',
    borderColor:     C.dim,
    title:           ' Network ',
    padding:         1,
    backgroundColor: C.panel,
  });

  const mkStat = (label: string, init = '—') => {
    const row = new BoxRenderable(renderer, {
      flexDirection:   'row',
      justifyContent:  'space-between',
      backgroundColor: 'transparent',
    });
    const labelText = new TextRenderable(renderer, { content: `  ${label}`, fg: C.dim,   bg: 'transparent' });
    const valueText = new TextRenderable(renderer, { content: init,          fg: C.slate, bg: 'transparent' });
    row.add(labelText);
    row.add(valueText);
    networkBox.add(row);
    return valueText;
  };

  const netNodes    = mkStat('Nodes');
  const netHealthy  = mkStat('Healthy');
  const netLatency  = mkStat('Latency avg');
  const netCache    = mkStat('Cache hit');
  leftCol.add(networkBox);

  mainRow.add(leftCol);

  // ── Command palette (right column) ────────────────────────────────────────
  const paletteBox = new BoxRenderable(renderer, {
    flexGrow:        1,
    flexShrink:      1,
    flexDirection:   'column',
    borderStyle:     'single',
    borderColor:     C.dim,
    title:           ' Commands ',
    padding:         1,
    backgroundColor: C.panel,
  });

  // Input row
  const inputText = new TextRenderable(renderer, {
    content: '> _',
    fg:      C.white,
    bg:      C.panel,
  });
  paletteBox.add(inputText);

  // Separator
  paletteBox.add(new TextRenderable(renderer, {
    content: '  ──────────────────────',
    fg:      C.dim,
    bg:      C.panel,
  }));

  // Pre-allocated command slots
  type Slot = { label: TextRenderable; hint: TextRenderable; row: BoxRenderable };
  const slots: Slot[] = [];
  for (let i = 0; i < MAX_PALETTE_ROWS; i++) {
    const slotRow = new BoxRenderable(renderer, {
      flexDirection:   'row',
      justifyContent:  'space-between',
      backgroundColor: 'transparent',
    });
    const labelT = new TextRenderable(renderer, { content: '', fg: C.slate, bg: 'transparent' });
    const hintT  = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: 'transparent' });
    slotRow.add(labelT);
    slotRow.add(hintT);
    paletteBox.add(slotRow);
    slots.push({ label: labelT, hint: hintT, row: slotRow });
  }

  mainRow.add(paletteBox);
  root.add(mainRow);

  // ── Status line ───────────────────────────────────────────────────────────
  const statusLine = new BoxRenderable(renderer, {
    width:           '100%',
    alignItems:      'center',
    justifyContent:  'center',
    paddingBottom:   1,
    backgroundColor: C.dark,
  });
  const statusText = new TextRenderable(renderer, { content: '●  STATUS: CHECKING', fg: C.dim, bg: C.dark });
  statusLine.add(statusText);
  root.add(statusLine);

  // ── Bottom bar ────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'row',
    justifyContent:  'space-between',
    paddingX:        2,
    paddingY:        0,
    backgroundColor: C.panel,
  });
  bottomBar.add(new TextRenderable(renderer, {
    content: '[↵ select]  [↑↓ navigate]  [esc clear]  [ctrl+c quit]',
    fg:      C.slate,
    bg:      C.panel,
  }));
  bottomBar.add(new TextRenderable(renderer, { content: 'canister.software', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── Palette state + render ────────────────────────────────────────────────
  let filter      = '';
  let selectedIdx = 0;

  const getFiltered = (): Command[] =>
    filter.trim() === ''
      ? COMMANDS
      : COMMANDS.filter((c) =>
          c.label.includes(filter.toLowerCase()) || c.hint.includes(filter.toLowerCase())
        );

  const renderPalette = () => {
    inputText.content = filter ? `> ${filter}_` : '> _';

    const filtered = getFiltered();
    if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);

    for (let i = 0; i < MAX_PALETTE_ROWS; i++) {
      const cmd = filtered[i];
      const s   = slots[i];
      if (!cmd) {
        s.label.content = '';
        s.hint.content  = '';
        continue;
      }
      const sel        = i === selectedIdx;
      s.label.content  = sel ? `  ▶  ${cmd.label}` : `     ${cmd.label}`;
      s.label.fg       = sel ? C.white              : C.slate;
      s.hint.content   = sel ? cmd.hint             : '';
      s.hint.fg        = C.dim;
    }
  };

  renderPalette();

  // ── Background: server health ─────────────────────────────────────────────
  fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(4000) })
    .then((r) => {
      statusText.content = r.ok ? '●  STATUS: CONNECTED' : '●  STATUS: DEGRADED';
      statusText.fg      = r.ok ? C.emerald               : C.amber;
    })
    .catch(() => {
      statusText.content = '●  STATUS: DISCONNECTED';
      statusText.fg      = C.red;
    });

  // ── Background: network stats (poll every 5s) ─────────────────────────────
  const fetchStats = () => {
    fetch(`${SERVER}/stats`, { signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!r.ok) return;
        const d = await r.json() as Record<string, unknown>;
        if (typeof d.nodes    === 'number') netNodes.content   = String(d.nodes);
        if (typeof d.healthy  === 'number') netHealthy.content = String(d.healthy);
        if (typeof d.latency  === 'number') netLatency.content = `${d.latency}ms`;
        if (typeof d.cacheHit === 'number') netCache.content   = `${d.cacheHit}%`;
        netNodes.fg = netHealthy.fg = netLatency.fg = netCache.fg = C.white;
      })
      .catch(() => { /* non-fatal — keep dashes */ });
  };

  fetchStats();
  const statsTimer = setInterval(fetchStats, 5000);

  // ── Key input ─────────────────────────────────────────────────────────────
  return new Promise<LandingAction>((resolve) => {
    const done = (action: LandingAction) => {
      clearInterval(statsTimer);
      renderer.destroy();
      resolve(action);
    };

    renderer.keyInput.on('keypress', (key) => {
      // Always-on exits
      if (key.ctrl && key.name === 'c') { done('quit'); return; }

      // Navigation
      if (key.name === 'up') {
        const len = getFiltered().length;
        selectedIdx = (selectedIdx - 1 + len) % len;
        renderPalette();
        return;
      }
      if (key.name === 'down') {
        const len = getFiltered().length;
        selectedIdx = (selectedIdx + 1) % len;
        renderPalette();
        return;
      }

      // Execute selected
      if (key.name === 'return' || key.name === 'enter') {
        const filtered = getFiltered();
        const cmd = filtered[selectedIdx];
        if (cmd) done(cmd.action);
        return;
      }

      // Clear filter
      if (key.name === 'escape') {
        filter      = '';
        selectedIdx = 0;
        renderPalette();
        return;
      }

      // Backspace
      if (key.name === 'backspace') {
        filter      = filter.slice(0, -1);
        selectedIdx = 0;
        renderPalette();
        return;
      }

      // Printable character → type into filter
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= ' ') {
        filter     += key.sequence;
        selectedIdx = 0;
        renderPalette();
        return;
      }
    });
  });
}
