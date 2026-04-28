import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../../../theme';
import { makeSpin } from '../../../lib/spinners.ts';
import { loadConfig, getNodeOptions } from '../../../lib/config.ts';
import { createPaymentFetch } from '../../../../src/payment-fetch.js';
import { SocketClient } from '../../../../src/socket-client.ts';
import { saveSession, recordSpend } from '../../../lib/store.ts';
import { quoteWs } from '../../../lib/websockets.ts';
import { decodePaymentResponseHeader } from '@x402/fetch';
import type { WsSetupResult } from './setup.ts';

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return '00:00';
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024)     return `${(b / 1_024).toFixed(1)} KB`;
  return `${b} B`;
}

function nowHms(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type MsgEntry = {
  time: string;
  dir:  '▶' | '◀';
  text: string;
};

type RowRef = {
  time: TextRenderable;
  dir:  TextRenderable;
  text: TextRenderable;
};

const MAX_LOG = 20;

// ─── Dashboard ────────────────────────────────────────────────────────────────

export async function showWsDashboard(setup: WsSetupResult): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  // ── Top bar ───────────────────────────────────────────────────────────────
  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS',  fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'WEBSOCKET',  fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // ── Status bar ────────────────────────────────────────────────────────────
  const statusBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.dark,
  });
  const statusRef    = new TextRenderable(renderer, { content: '○ CONNECTING', fg: C.dim,   bg: C.dark });
  const sessionRef   = new TextRenderable(renderer, { content: '—',            fg: C.slate, bg: C.dark });
  const countdownRef = new TextRenderable(renderer, { content: '—',            fg: C.dim,   bg: C.dark });
  statusBar.add(statusRef);
  statusBar.add(sessionRef);
  statusBar.add(countdownRef);
  root.add(statusBar);

  // ── Content ───────────────────────────────────────────────────────────────
  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 2, paddingTop: 1, paddingBottom: 1,
    backgroundColor: C.dark,
  });
  root.add(content);

  content.add(new TextRenderable(renderer, {
    content: `  ${setup.model.toUpperCase()}  ${setup.minutes}min  ${setup.megabytes}MB`,
    fg: C.dim, bg: C.dark,
  }));
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: 'MESSAGES  ' + '─'.repeat(60), fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  // Table header
  const hdr = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
  const addH = (t: string, w: number) =>
    hdr.add(new TextRenderable(renderer, { content: t.padEnd(w), fg: C.dim, bg: 'transparent' }));
  addH('TIME', 10); addH('', 3); addH('MESSAGE', 60);
  content.add(hdr);
  content.add(new TextRenderable(renderer, { content: '─'.repeat(73), fg: C.dim, bg: C.dark }));

  // Pre-allocated log rows
  const rows: RowRef[] = [];
  for (let i = 0; i < MAX_LOG; i++) {
    const row = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
    const mk  = (w: number) => {
      const t = new TextRenderable(renderer, { content: ''.padEnd(w), fg: C.dim, bg: 'transparent' });
      row.add(t); return t;
    };
    rows.push({ time: mk(10), dir: mk(3), text: mk(60) });
    content.add(row);
  }

  const emptyRef = new TextRenderable(renderer, { content: '  waiting for messages…', fg: C.dim, bg: C.dark });
  content.add(emptyRef);

  // ── Stats bar ─────────────────────────────────────────────────────────────
  const statsBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.dark,
  });
  const dataRef    = new TextRenderable(renderer, { content: 'Data: — / —',        fg: C.dim, bg: C.dark });
  const latencyRef = new TextRenderable(renderer, { content: 'Latency: —',          fg: C.dim, bg: C.dark });
  const uptimeRef  = new TextRenderable(renderer, { content: '00:00:00',            fg: C.dim, bg: C.dark });
  statsBar.add(dataRef);
  statsBar.add(latencyRef);
  statsBar.add(uptimeRef);
  root.add(statsBar);

  // ── Bottom bar ────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const hintsRef = new TextRenderable(renderer, {
    content: '[S  send]  [C  clear]  [Q  close]', fg: C.slate, bg: C.panel,
  });
  bottomBar.add(hintsRef);
  bottomBar.add(new TextRenderable(renderer, { content: 'WEBSOCKET', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── Send input (shown when composing) ────────────────────────────────────
  const sendBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const sendPromptRef = new TextRenderable(renderer, { content: '▶  ', fg: C.emerald, bg: C.panel });
  const sendInputRef  = new TextRenderable(renderer, { content: '',    fg: C.white,   bg: C.panel });
  sendBar.add(sendPromptRef);
  sendBar.add(sendInputRef);

  // ── State ─────────────────────────────────────────────────────────────────
  let live      = true;
  let connected = false;
  let sending   = false;
  let sendBuf   = '';
  let bytesSent = 0;
  let bytesRecv = 0;
  const startedAt  = Date.now();
  const expiresMs  = setup.minutes * 60 * 1000;
  const log: MsgEntry[] = [];
  let session: { send: (data: string) => void; close: () => void } | null = null;
  const sessionId = crypto.randomUUID();
  let lastTxHash: string | undefined;

  // ── Latency (send → first received message RTT) ───────────────────────────
  const MAX_LATENCY_SAMPLES = 40;
  const recentLatencies: number[] = [];
  let lastSentAt: number | null = null;

  function recordRtt(): void {
    if (lastSentAt == null) return;
    const rtt = Date.now() - lastSentAt;
    lastSentAt = null;
    recentLatencies.push(rtt);
    if (recentLatencies.length > MAX_LATENCY_SAMPLES) recentLatencies.shift();
  }

  function renderLatency(): void {
    if (recentLatencies.length === 0) {
      latencyRef.content = 'Latency: —';
      return;
    }
    const cur = recentLatencies.at(-1)!;
    const avg = recentLatencies.reduce((s, v) => s + v, 0) / recentLatencies.length;
    const sorted = [...recentLatencies].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    latencyRef.content = `RTT: ${Math.round(cur)}ms  avg ${Math.round(avg)}ms  p95 ${Math.round(p95)}ms`;
    latencyRef.fg = avg > 1000 ? C.amber : C.dim;
  }

  // ── Log rendering ─────────────────────────────────────────────────────────
  function renderLog(): void {
    emptyRef.content = log.length === 0 ? '  waiting for messages…' : '';
    for (let i = 0; i < MAX_LOG; i++) {
      const e = log[i];
      if (!e) {
        rows[i]!.time.content = ''.padEnd(10);
        rows[i]!.dir.content  = ''.padEnd(3);
        rows[i]!.text.content = ''.padEnd(60);
        continue;
      }
      const truncated = e.text.length > 59 ? e.text.slice(0, 58) + '…' : e.text;
      rows[i]!.time.content = e.time.padEnd(10);
      rows[i]!.time.fg      = C.dim;
      rows[i]!.dir.content  = e.dir.padEnd(3);
      rows[i]!.dir.fg       = e.dir === '▶' ? C.emerald : C.cyan;
      rows[i]!.text.content = truncated.padEnd(60);
      rows[i]!.text.fg      = e.dir === '▶' ? C.slate : C.white;
    }
  }

  function pushMsg(dir: '▶' | '◀', text: string): void {
    if (!live) return;
    log.unshift({ time: nowHms(), dir, text });
    if (log.length > MAX_LOG) log.pop();
    renderLog();
  }

  // ── Send mode ─────────────────────────────────────────────────────────────
  function enterSend(): void {
    sending  = true;
    sendBuf  = '';
    sendInputRef.content = '█';
    hintsRef.content     = '[↵ send]  [esc cancel]';
    root.add(sendBar);
  }

  function exitSend(): void {
    sending = false;
    sendBuf = '';
    root.remove(sendBar.id);
    hintsRef.content = '[S  send]  [C  clear]  [Q  close]';
  }

  function handleSendKey(key: { name?: string; sequence?: string; ctrl?: boolean }): void {
    if (key.name === 'escape') { exitSend(); return; }

    if (key.name === 'return' || key.name === 'enter') {
      if (sendBuf && session) {
        try {
          session.send(sendBuf);
          bytesSent += new TextEncoder().encode(sendBuf).length;
          lastSentAt = Date.now();
          pushMsg('▶', sendBuf);
        } catch { /* session may have closed */ }
      }
      exitSend();
      return;
    }

    if (key.name === 'backspace' || key.name === 'delete') {
      sendBuf = sendBuf.slice(0, -1);
    } else if (key.sequence && !key.ctrl && key.sequence.length === 1) {
      sendBuf += key.sequence;
    }
    sendInputRef.content = sendBuf + '█';
  }

  // ── Timers ────────────────────────────────────────────────────────────────
  const spin      = makeSpin('checking');
  const spinTimer = setInterval(() => {
    if (!live || connected) return;
    statusRef.content = `${spin()} CONNECTING`;
  }, 100);

  const clockTimer = setInterval(() => {
    if (!live) return;
    uptimeRef.content = fmtHms(Date.now() - startedAt);
    dataRef.content   = `Data: ${fmtBytes(bytesRecv + bytesSent)} / ${setup.megabytes} MB`;

    if (connected) {
      const remaining = expiresMs - (Date.now() - startedAt);
      countdownRef.content = remaining > 0 ? `${fmtCountdown(remaining)} remaining` : 'expired';
      countdownRef.fg      = remaining < 60_000 ? C.amber : C.dim;
    }
  }, 1000);

  renderLog();

  // ── Shutdown ──────────────────────────────────────────────────────────────
  const shutdown = () => {
    if (!live) return;
    live = false;
    clearInterval(spinTimer);
    clearInterval(clockTimer);
    try { session?.close(); } catch { /* ignore */ }
    const endedAt   = Date.now();
    const durationMs = endedAt - startedAt;
    const spendUsd  = quoteWs(setup.model, setup.minutes, setup.megabytes);
    saveSession({
      id:         sessionId,
      type:       'websocket',
      url:        '',
      target:     `ws ${setup.model} ${setup.minutes}min ${setup.megabytes}MB`,
      startedAt,
      endedAt,
      durationMs,
      outcome:    'user-quit',
      spendUsd,
      bytesIn:    bytesRecv,
      bytesOut:   bytesSent,
      network:    setup.preferNetwork,
    });
    if (spendUsd > 0) {
      recordSpend({
        sessionId,
        date:      new Date().toISOString().slice(0, 10),
        type:      'websocket',
        amountUsd: spendUsd,
        network:   setup.preferNetwork,
        txHash:    lastTxHash,
      });
    }
    renderer.destroy();
  };

  // ── Key input ─────────────────────────────────────────────────────────────
  const inputDone = new Promise<void>(resolve => {
    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;

      if (sending) { handleSendKey(key); return; }

      if (key.ctrl && key.name === 'c') { shutdown(); resolve(); return; }
      if (key.name === 'q' || key.name === 'Q' || key.name === 'b' || key.name === 'B') {
        shutdown(); resolve(); return;
      }
      if (key.name === 'c' || key.name === 'C') { log.splice(0); renderLog(); return; }
      if (key.name === 's' || key.name === 'S') {
        if (connected) enterSend();
        return;
      }
    });
  });

  // ── Connect ───────────────────────────────────────────────────────────────
  const connectDone = (async () => {
    try {
      const cfg      = loadConfig();

      // Wrap the base fetch to capture the settlement txHash from X-PAYMENT-RESPONSE
      const trackingFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await globalThis.fetch(input, init as RequestInit);
        const header = response.headers.get('X-PAYMENT-RESPONSE') ?? response.headers.get('PAYMENT-RESPONSE');
        if (header) {
          try {
            const decoded = decodePaymentResponseHeader(header) as { transaction?: string };
            if (decoded?.transaction) lastTxHash = decoded.transaction;
          } catch { /* non-fatal */ }
        }
        return response;
      };

      const fetchFn  = await createPaymentFetch({ preferNetwork: setup.preferNetwork, fetch: trackingFetch as typeof fetch });
      const nodeOpts = getNodeOptions(cfg);

      const client = SocketClient(fetchFn as Parameters<typeof SocketClient>[0], {
        defaults: {
          nodeRegion: nodeOpts.node_region,
          nodeDomain: nodeOpts.node_domain,
        },
      });

      const auth = await client.requestToken({
        model:     setup.model,
        minutes:   setup.minutes,
        megabytes: setup.megabytes,
      });

      session = await client.connect(auth, {
        onOpen: () => {
          if (!live) return;
          connected            = true;
          statusRef.content    = '● CONNECTED';
          statusRef.fg         = C.emerald;
          sessionRef.content   = `${setup.model}  ${setup.minutes}min  ${setup.megabytes}MB`;
          sessionRef.fg        = C.slate;
          countdownRef.content = `${fmtCountdown(expiresMs)} remaining`;
        },
        onMessage: (data: unknown) => {
          if (!live) return;
          const text = typeof data === 'string' ? data : JSON.stringify(data);
          bytesRecv += new TextEncoder().encode(text).length;
          recordRtt();
          renderLatency();
          pushMsg('◀', text);
        },
        onClose: () => {
          if (!live) return;
          connected            = false;
          statusRef.content    = '○ CLOSED';
          statusRef.fg         = C.amber;
          countdownRef.content = '—';
        },
        onError: (err: unknown) => {
          if (!live) return;
          statusRef.content = `✗ ${err instanceof Error ? err.message : String(err)}`;
          statusRef.fg      = C.red;
        },
      });
    } catch (err) {
      if (!live) return;
      statusRef.content = `✗ ${err instanceof Error ? err.message : String(err)}`;
      statusRef.fg      = C.red;
    }
  })();

  await inputDone;
  await connectDone.catch(() => {});
}
