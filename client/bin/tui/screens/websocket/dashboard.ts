import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
} from '@opentui/core';
import { C } from '../../../theme';
import { makeKeyBar, makeTopBar } from '../../chrome.ts';
import { makeSpin } from '../../../lib/spinners.ts';
import { loadConfig, getNodeOptions } from '../../../lib/config.ts';
import { saveSession, recordSpend } from '../../../lib/store.ts';
import { isFreeMode } from '../../../lib/server-config';
import { createPaymentFetch } from '../../../../src/payment-fetch.js';
import { SocketClient } from '../../../../src/socket-client.ts';
import { quoteWs } from '../../../lib/websockets.ts';
import { decodePaymentResponseHeader } from '@x402/fetch';
import type { WsSetupResult } from './setup.ts';

const MAX_LOG = 20;
const MAX_LATENCY_SAMPLES = 40;
const DATA_BAR_WIDTH = 10;
const COL = { time: 10, dir: 4, bytes: 8 };

function fmtHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return '00:00';
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024) return `${(b / 1_024).toFixed(1)} KB`;
  return `${b} B`;
}

function nowHms(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function shortNode(domain?: string): string {
  return domain ? (domain.split('.')[0] ?? domain) : 'auto';
}

type MsgEntry = { time: string; dir: '▶' | '◄'; text: string; bytes: number };
type RowRef = { time: TextRenderable; dir: TextRenderable; text: TextRenderable; bytes: TextRenderable };

interface StatusBarRefs {
  box: BoxRenderable;
  state: TextRenderable;
  expires: TextRenderable;
  setState(text: string, color: string): void;
}

function makeStatusBar(renderer: CliRenderer, setup: WsSetupResult, nodeName: string): StatusBarRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingX: 2, paddingY: 0,
    border: true, borderStyle: 'rounded', borderColor: C.line2, backgroundColor: C.dark,
  });
  const state = new TextRenderable(renderer, {
    content: '○ CONNECTING', fg: C.amber, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const session = new BoxRenderable(renderer, {
    flexGrow: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 1, backgroundColor: C.dark,
  });
  const dot = () => new TextRenderable(renderer, { content: '·', fg: C.dim, bg: C.dark });
  session.add(new TextRenderable(renderer, { content: setup.model.toUpperCase(), fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD }));
  session.add(dot());
  session.add(new TextRenderable(renderer, { content: `${setup.minutes} min`, fg: C.slate, bg: C.dark }));
  session.add(dot());
  session.add(new TextRenderable(renderer, { content: `${setup.megabytes} MB`, fg: C.slate, bg: C.dark }));
  session.add(dot());
  session.add(new TextRenderable(renderer, { content: 'node', fg: C.dim, bg: C.dark }));
  session.add(new TextRenderable(renderer, { content: nodeName, fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD }));
  const expires = new TextRenderable(renderer, {
    content: 'expires —', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  box.add(state);
  box.add(session);
  box.add(expires);
  return {
    box, state, expires,
    setState(text: string, color: string) { state.content = text; state.fg = color; },
  };
}

function makeMessagesPanel(renderer: CliRenderer): { box: BoxRenderable; rows: RowRef[]; emptyMessage: TextRenderable } {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.line2,
    title: ' MESSAGES ', titleAlignment: 'left', paddingX: 2, paddingY: 1, backgroundColor: C.dark,
  });
  const header = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2, paddingBottom: 1, backgroundColor: C.dark,
  });
  const mkHead = (text: string, width?: number, grow?: boolean, align: 'left' | 'right' = 'left') => {
    const content = width ? (align === 'right' ? text.padStart(width) : text.padEnd(width)) : text;
    const t = new TextRenderable(renderer, { content, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD });
    if (grow) {
      const cell = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: 'row', backgroundColor: C.dark });
      cell.add(t);
      header.add(cell);
    } else if (width != null) {
      const cell = new BoxRenderable(renderer, {
        width, flexDirection: 'row', backgroundColor: C.dark,
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      });
      cell.add(t);
      header.add(cell);
    } else {
      header.add(t);
    }
  };
  mkHead('TIME', COL.time);
  mkHead('DIR', COL.dir);
  mkHead('MESSAGE', undefined, true);
  mkHead('BYTES', COL.bytes, false, 'right');
  box.add(header);

  const rows: RowRef[] = [];
  for (let i = 0; i < MAX_LOG; i++) {
    const row = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', gap: 2, backgroundColor: C.dark });
    const time = new TextRenderable(renderer, { content: ''.padEnd(COL.time), fg: C.dim, bg: C.dark });
    const dirCell = new BoxRenderable(renderer, { width: COL.dir, flexDirection: 'row', justifyContent: 'center', backgroundColor: C.dark });
    const dir = new TextRenderable(renderer, { content: ' ', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD });
    dirCell.add(dir);
    const textCell = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: 'row', backgroundColor: C.dark });
    const text = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    textCell.add(text);
    const bytesCell = new BoxRenderable(renderer, { width: COL.bytes, flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: C.dark });
    const bytes = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD });
    bytesCell.add(bytes);
    row.add(time);
    row.add(dirCell);
    row.add(textCell);
    row.add(bytesCell);
    box.add(row);
    rows.push({ time, dir, text, bytes });
  }
  const emptyMessage = new TextRenderable(renderer, { content: 'waiting for messages…', fg: C.dim, bg: C.dark });
  box.add(emptyMessage);
  return { box, rows, emptyMessage };
}

interface StatsRefs {
  dataBar: TextRenderable;
  dataValue: TextRenderable;
  rtt: TextRenderable;
  avg: TextRenderable;
  p95: TextRenderable;
  msgs: TextRenderable;
  uptime: TextRenderable;
  box: BoxRenderable;
}

function makeStatsBar(renderer: CliRenderer, megabytes: number): StatsRefs {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingY: 0,
    border: ['top'], borderColor: C.line2, backgroundColor: C.dark,
  });
  const leftCluster = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark });
  leftCluster.add(new TextRenderable(renderer, { content: 'DATA', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const dataBar = new TextRenderable(renderer, { content: '░'.repeat(DATA_BAR_WIDTH), fg: C.line2, bg: C.dark });
  leftCluster.add(dataBar);
  const dataValue = new TextRenderable(renderer, { content: `— / ${megabytes} MB`, fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
  leftCluster.add(dataValue);

  const midCluster = new BoxRenderable(renderer, { flexDirection: 'row', gap: 3, alignItems: 'center', backgroundColor: C.dark });
  const mkPair = (label: string, valueFg: string) => {
    const pair = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark });
    pair.add(new TextRenderable(renderer, { content: label, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    const value = new TextRenderable(renderer, { content: '—', fg: valueFg, bg: C.dark, attributes: TextAttributes.BOLD });
    pair.add(value);
    midCluster.add(pair);
    return value;
  };
  const rtt = mkPair('RTT', C.emerald);
  const avg = mkPair('AVG', C.slate);
  const p95 = mkPair('P95', C.slate);
  const msgs = mkPair('MSGS', C.slate);

  const uptimeCluster = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark });
  uptimeCluster.add(new TextRenderable(renderer, { content: 'UPTIME', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const uptime = new TextRenderable(renderer, { content: '00:00:00', fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD });
  uptimeCluster.add(uptime);

  box.add(leftCluster);
  box.add(midCluster);
  box.add(uptimeCluster);
  return { box, dataBar, dataValue, rtt, avg, p95, msgs, uptime };
}

function renderDataBar(refs: { dataBar: TextRenderable; dataValue: TextRenderable }, used: number, megabytes: number): void {
  const totalBytes = megabytes * 1_048_576;
  const frac = totalBytes > 0 ? Math.min(1, used / totalBytes) : 0;
  const filled = Math.round(frac * DATA_BAR_WIDTH);
  refs.dataBar.content = '█'.repeat(filled) + '░'.repeat(DATA_BAR_WIDTH - filled);
  refs.dataBar.fg = frac > 0.9 ? C.amber : C.emerald;
  refs.dataValue.content = `${fmtBytes(used)} / ${megabytes} MB`;
}

function makeComposer(renderer: CliRenderer): { box: BoxRenderable; input: TextRenderable } {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 1, alignItems: 'center',
    paddingX: 2, paddingY: 0, border: ['top'], borderColor: C.line2, backgroundColor: C.panel,
  });
  box.add(new TextRenderable(renderer, { content: '▶', fg: C.emerald, bg: C.panel, attributes: TextAttributes.BOLD }));
  const input = new TextRenderable(renderer, { content: '█', fg: C.white, bg: C.panel });
  box.add(input);
  box.add(new TextRenderable(renderer, { content: '↵ send · esc cancel', fg: C.dim, bg: C.panel }));
  return { box, input };
}

export async function showWsDashboard(setup: WsSetupResult): Promise<void> {
  const freeMode = await isFreeMode();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const initialNode = shortNode(loadConfig().leased_node?.domain);
  const topBar = makeTopBar(renderer, root, { freeMode, status: '○ connecting', statusColor: C.amber });

  const shell = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column', gap: 1,
    paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });
  root.add(shell);

  const status = makeStatusBar(renderer, setup, initialNode);
  shell.add(status.box);

  const messages = makeMessagesPanel(renderer);
  shell.add(messages.box);

  const stats = makeStatsBar(renderer, setup.megabytes);
  root.add(stats.box);

  const composer = makeComposer(renderer);

  root.add(makeKeyBar(renderer, [
    { key: 'S', label: 'send' },
    { key: 'C', label: 'clear' },
    { key: 'Q', label: 'close session' },
  ], 'WEBSOCKET · LIVE').box);

  let live = true;
  let connected = false;
  let sending = false;
  let sendBuf = '';
  let bytesSent = 0;
  let bytesRecv = 0;
  const startedAt = Date.now();
  const expiresMs = setup.minutes * 60 * 1000;
  const log: MsgEntry[] = [];
  let session: { send: (data: string) => void; close: () => void } | null = null;
  const sessionId = crypto.randomUUID();
  let lastTxHash: string | undefined;

  const recentLatencies: number[] = [];
  let lastSentAt: number | null = null;

  function recordRtt(): void {
    if (lastSentAt == null) return;
    recentLatencies.push(Date.now() - lastSentAt);
    lastSentAt = null;
    if (recentLatencies.length > MAX_LATENCY_SAMPLES) recentLatencies.shift();
  }

  function renderLatency(): void {
    if (recentLatencies.length === 0) {
      stats.rtt.content = '—'; stats.avg.content = '—'; stats.p95.content = '—';
      return;
    }
    const cur = recentLatencies[recentLatencies.length - 1]!;
    const avgMs = recentLatencies.reduce((s, v) => s + v, 0) / recentLatencies.length;
    const sorted = [...recentLatencies].sort((a, b) => a - b);
    const p95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    stats.rtt.content = `${Math.round(cur)}ms`;
    stats.avg.content = `${Math.round(avgMs)}ms`;
    stats.p95.content = `${Math.round(p95Ms)}ms`;
    stats.rtt.fg = cur > 1000 ? C.amber : C.emerald;
  }

  function renderLog(): void {
    messages.emptyMessage.content = log.length === 0 ? 'waiting for messages…' : '';
    messages.emptyMessage.fg = C.dim;
    for (let i = 0; i < MAX_LOG; i++) {
      const e = log[i];
      const row = messages.rows[i]!;
      if (!e) {
        row.time.content = '';
        row.dir.content = '';
        row.text.content = '';
        row.bytes.content = '';
        continue;
      }
      row.time.content = e.time;
      row.dir.content = e.dir;
      row.dir.fg = e.dir === '◄' ? C.emerald : C.accent;
      row.text.content = e.text;
      row.text.fg = e.dir === '◄' ? C.slate : C.white;
      row.bytes.content = `${e.bytes} B`;
    }
    stats.msgs.content = String(log.length);
  }

  function pushMsg(dir: '▶' | '◄', text: string, bytes: number): void {
    if (!live) return;
    log.unshift({ time: nowHms(), dir, text, bytes });
    if (log.length > MAX_LOG) log.pop();
    renderLog();
  }

  function enterSend(): void {
    sending = true; sendBuf = '';
    composer.input.content = '█';
    root.add(composer.box);
  }
  function exitSend(): void {
    sending = false; sendBuf = '';
    try { root.remove(composer.box.id); } catch { /* not attached */ }
  }
  function handleSendKey(key: { name?: string; sequence?: string; ctrl?: boolean }): void {
    if (key.name === 'escape') { exitSend(); return; }
    if (key.name === 'return' || key.name === 'enter') {
      if (sendBuf && session) {
        try {
          session.send(sendBuf);
          const b = byteLength(sendBuf);
          bytesSent += b;
          lastSentAt = Date.now();
          pushMsg('▶', sendBuf, b);
        } catch { /* socket closed */ }
      }
      exitSend();
      return;
    }
    if (key.name === 'backspace' || key.name === 'delete') sendBuf = sendBuf.slice(0, -1);
    else if (key.sequence && !key.ctrl && key.sequence.length === 1) sendBuf += key.sequence;
    composer.input.content = `${sendBuf}█`;
  }

  const spin = makeSpin('checking');
  const spinTimer = setInterval(() => {
    if (!live || connected) return;
    status.setState(`${spin()} CONNECTING`, C.amber);
  }, 100);

  const clockTimer = setInterval(() => {
    if (!live) return;
    stats.uptime.content = fmtHms(Date.now() - startedAt);
    renderDataBar(stats, bytesRecv + bytesSent, setup.megabytes);
    if (connected) {
      const remaining = expiresMs - (Date.now() - startedAt);
      if (remaining > 0) {
        status.expires.content = `expires ${fmtCountdown(remaining)} remaining`;
        status.expires.fg = remaining < 60_000 ? C.amber : C.dim;
      } else {
        status.expires.content = 'expired';
        status.expires.fg = C.red;
      }
    }
  }, 1000);

  renderLog();
  renderLatency();
  renderDataBar(stats, 0, setup.megabytes);

  const shutdown = (): void => {
    if (!live) return;
    live = false;
    clearInterval(spinTimer);
    clearInterval(clockTimer);
    try { session?.close(); } catch { /* ignore */ }
    const endedAt = Date.now();
    const spendUsd = quoteWs(setup.model, setup.minutes, setup.megabytes);
    saveSession({
      id: sessionId,
      type: 'websocket',
      url: '',
      target: `ws ${setup.model} ${setup.minutes}min ${setup.megabytes}MB`,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      outcome: 'user-quit',
      spendUsd,
      bytesIn: bytesRecv,
      bytesOut: bytesSent,
      network: setup.preferNetwork,
    });
    if (spendUsd > 0) {
      recordSpend({
        sessionId,
        date: new Date().toISOString().slice(0, 10),
        type: 'websocket',
        amountUsd: spendUsd,
        network: setup.preferNetwork,
        txHash: lastTxHash,
      });
    }
    renderer.destroy();
  };

  const inputDone = new Promise<void>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;
      if (sending) { handleSendKey(key); return; }
      if (key.ctrl && key.name === 'c') { shutdown(); resolve(); return; }
      if (key.name === 'q' || key.name === 'Q' || key.name === 'b' || key.name === 'B') { shutdown(); resolve(); return; }
      if (key.name === 'c' || key.name === 'C') { log.splice(0); renderLog(); return; }
      if (key.name === 's' || key.name === 'S') { if (connected) enterSend(); return; }
    });
  });

  const connectDone = (async () => {
    try {
      const cfg = loadConfig();
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
      const fetchFn = await createPaymentFetch({ preferNetwork: setup.preferNetwork, fetch: trackingFetch as typeof fetch });
      const nodeOpts = getNodeOptions(cfg);
      const client = SocketClient(fetchFn as Parameters<typeof SocketClient>[0], {
        defaults: { nodeRegion: nodeOpts.node_region, nodeDomain: nodeOpts.node_domain },
      });
      const auth = await client.requestToken({ model: setup.model, minutes: setup.minutes, megabytes: setup.megabytes });
      session = await client.connect(auth, {
        onOpen: () => {
          if (!live) return;
          connected = true;
          status.setState('● CONNECTED', C.emerald);
          status.box.borderColor = C.emerald;
          topBar.setStatus('● live', C.emerald);
          status.expires.content = `expires ${fmtCountdown(expiresMs)} remaining`;
          status.expires.fg = C.dim;
          const welcome = `welcome — socket open, model=${setup.model}`;
          pushMsg('◄', welcome, byteLength(welcome));
        },
        onMessage: (data: unknown) => {
          if (!live) return;
          const text = typeof data === 'string' ? data : JSON.stringify(data);
          const b = byteLength(text);
          bytesRecv += b;
          recordRtt();
          renderLatency();
          pushMsg('◄', text, b);
        },
        onClose: () => {
          if (!live) return;
          connected = false;
          status.setState('○ CLOSED', C.amber);
          status.box.borderColor = C.line2;
          topBar.setStatus('○ connecting', C.amber);
          status.expires.content = '—';
        },
        onError: (err: unknown) => {
          if (!live) return;
          status.setState(`✗ ${err instanceof Error ? err.message : String(err)}`, C.red);
          status.box.borderColor = C.red;
        },
      });
    } catch (err) {
      if (!live) return;
      status.setState(`✗ ${err instanceof Error ? err.message : String(err)}`, C.red);
      status.box.borderColor = C.red;
    }
  })();

  await inputDone;
  await connectDone.catch(() => {});
}
