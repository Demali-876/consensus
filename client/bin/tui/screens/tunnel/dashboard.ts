/**
 * Tunnel dashboard — live traffic view.
 *
 * Handles both HTTP and TCP tunnels.
 * Protocol mirrors server/features/tunnel/tunnel.ts exactly.
 */

import net       from 'net';
import WebSocket from 'ws';
import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../../../theme';
import { makeSpin } from '../../../lib/spinners.ts';
import type { TunnelSetupResult } from './setup.ts';

const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

// ─── Frame protocol ───────────────────────────────────────────────────────────

const FRAME = {
  STREAM_OPEN:  0x01,
  STREAM_DATA:  0x02,
  STREAM_END:   0x03,
  STREAM_RESET: 0x04,
  PING:         0x05,
  PONG:         0x06,
} as const;

function encodeFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId, 1);
  return Buffer.concat([header, payload]);
}

function decodeFrame(data: Buffer): { type: number; streamId: number; payload: Buffer } {
  return { type: data.readUInt8(0), streamId: data.readUInt32BE(1), payload: data.subarray(5) };
}

// ─── HTTP parsing helpers ─────────────────────────────────────────────────────

function parseHttpRequestLine(payload: Buffer): { method: string; path: string } | null {
  const text  = payload.toString('utf8', 0, Math.min(payload.length, 512));
  const line  = text.split('\r\n')[0] ?? '';
  const parts = line.split(' ');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { method: parts[0], path: parts[1] };
}

function parseHttpStatusCode(data: Buffer): number | null {
  const text = data.toString('utf8', 0, Math.min(data.length, 64));
  const m    = text.match(/^HTTP\/\d+\.?\d*\s+(\d{3})/);
  return m ? parseInt(m[1]!) : null;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtStatus(code: number): string {
  if (code < 300) return `${code} OK`;
  if (code < 400) return `${code} RDR`;
  if (code < 500) return `${code} ERR`;
  return `${code} FAIL`;
}

function statusFg(code: number): string {
  if (code < 300) return C.emerald;
  if (code < 400) return C.cyan;
  if (code < 500) return C.amber;
  return C.red;
}

function fmtLat(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

const METHOD_FG: Record<string, string> = {
  GET: C.slate, POST: C.emerald, PUT: C.amber, PATCH: C.amber,
  DELETE: C.red, HEAD: C.dim, OPTIONS: C.dim,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type LogEntry = {
  time:       string;
  method:     string;
  path:       string;
  statusCode: number;
  latencyMs?: number;
};

type PendingStream = {
  method:        string;
  path:          string;
  startedAt:     number;
  gotStatus:     boolean;
  // HTTP response tracking — lets us send STREAM_END without waiting for socket close
  respBuf:       Buffer;
  headersDone:   boolean;
  contentLength: number;   // -1 = unknown (chunked / no Content-Length)
  bodyReceived:  number;
};

type RowRef = {
  time: TextRenderable; method: TextRenderable; path: TextRenderable;
  status: TextRenderable; latency: TextRenderable;
};

// ─── Dashboard screen ─────────────────────────────────────────────────────────

const MAX_LOG = 20;

export async function showTunnelDashboard(setup: TunnelSetupResult): Promise<void> {
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
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'TUNNEL',    fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // ── Connection bar ────────────────────────────────────────────────────────
  const connBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.dark,
  });
  const connStatus = new TextRenderable(renderer, { content: '○ CONNECTING', fg: C.dim,   bg: C.dark });
  const connUrl    = new TextRenderable(renderer, { content: '—',            fg: C.slate, bg: C.dark });
  const connClock  = new TextRenderable(renderer, { content: '00:00:00',     fg: C.dim,   bg: C.dark });
  connBar.add(connStatus);
  connBar.add(connUrl);
  connBar.add(connClock);
  root.add(connBar);

  // ── Content ───────────────────────────────────────────────────────────────
  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 2, paddingTop: 1, paddingBottom: 1,
    backgroundColor: C.dark,
  });
  root.add(content);

  const target = [setup.target, setup.port].filter(Boolean).join(':');
  content.add(new TextRenderable(renderer, {
    content: `  ${setup.protocol.toUpperCase()}  ${target}`,
    fg: C.dim, bg: C.dark,
  }));
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: 'TRAFFIC  ' + '─'.repeat(63), fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

  // Table header
  const hdr = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
  const addH = (t: string, w: number) =>
    hdr.add(new TextRenderable(renderer, { content: t.padEnd(w), fg: C.dim, bg: 'transparent' }));
  addH('TIME', 10); addH('METHOD', 9); addH('PATH', 50); addH('STATUS', 10); addH('LATENCY', 8);
  content.add(hdr);
  content.add(new TextRenderable(renderer, { content: '─'.repeat(87), fg: C.dim, bg: C.dark }));

  // Pre-allocated log rows
  const rows: RowRef[] = [];
  for (let i = 0; i < MAX_LOG; i++) {
    const row = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
    const mk  = (w: number) => {
      const t = new TextRenderable(renderer, { content: ''.padEnd(w), fg: C.dim, bg: 'transparent' });
      row.add(t); return t;
    };
    rows.push({ time: mk(10), method: mk(9), path: mk(50), status: mk(10), latency: mk(8) });
    content.add(row);
  }

  const emptyRef = new TextRenderable(renderer, { content: '  waiting for traffic…', fg: C.dim, bg: C.dark });
  content.add(emptyRef);

  // ── Bottom bar ────────────────────────────────────────────────────────────
  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const statusRef = new TextRenderable(renderer, {
    content: '[C  clear]  [Q  stop tunnel]', fg: C.slate, bg: C.panel,
  });
  bottomBar.add(statusRef);
  bottomBar.add(new TextRenderable(renderer, { content: 'TUNNEL', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  // ── State ─────────────────────────────────────────────────────────────────
  let live      = true;
  let connected = false;
  const startedAt = Date.now();
  const log: LogEntry[] = [];

  // ── Log rendering ─────────────────────────────────────────────────────────
  function renderLog(): void {
    emptyRef.content = log.length === 0 ? '  waiting for traffic…' : '';
    for (let i = 0; i < MAX_LOG; i++) {
      const e = log[i];
      if (!e) {
        rows[i]!.time.content = ''.padEnd(10); rows[i]!.method.content = ''.padEnd(9);
        rows[i]!.path.content = ''.padEnd(50); rows[i]!.status.content = ''.padEnd(10);
        rows[i]!.latency.content = ''.padEnd(8);
        continue;
      }
      const rawPath = e.path.length > 49 ? e.path.slice(0, 48) + '…' : e.path;
      rows[i]!.time.content    = e.time.padEnd(10);    rows[i]!.time.fg    = C.dim;
      rows[i]!.method.content  = e.method.padEnd(9);   rows[i]!.method.fg  = METHOD_FG[e.method] ?? C.slate;
      rows[i]!.path.content    = rawPath.padEnd(50);   rows[i]!.path.fg    = C.slate;
      rows[i]!.status.content  = fmtStatus(e.statusCode).padEnd(10); rows[i]!.status.fg = statusFg(e.statusCode);
      rows[i]!.latency.content = fmtLat(e.latencyMs).padEnd(8);
      rows[i]!.latency.fg      = e.latencyMs != null && e.latencyMs > 1000 ? C.amber : C.dim;
    }
  }

  function pushEntry(entry: LogEntry): void {
    if (!live) return;
    log.unshift(entry);
    if (log.length > MAX_LOG) log.pop();
    renderLog();
  }

  // ── Timers ────────────────────────────────────────────────────────────────
  const spin      = makeSpin('checking');
  const spinTimer = setInterval(() => {
    if (!live || connected) return;
    connStatus.content = `${spin()} CONNECTING`;
  }, 100);

  const clockTimer = setInterval(() => {
    if (!live) return;
    connClock.content = fmtHms(Date.now() - startedAt);
  }, 1000);

  renderLog();

  // ── Cleanup / shutdown ────────────────────────────────────────────────────
  let ws: WebSocket | null = null;
  const sockets = new Map<number, net.Socket>();

  const shutdown = () => {
    if (!live) return;
    live = false;
    clearInterval(spinTimer);
    clearInterval(clockTimer);
    for (const s of sockets.values()) s.destroy();
    sockets.clear();
    try { ws?.close(); } catch { /* ignore */ }
    renderer.destroy();
  };

  // ── Key input ─────────────────────────────────────────────────────────────
  const inputDone = new Promise<void>(resolve => {
    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;
      if (key.name === 'c' || key.name === 'C') { log.splice(0); renderLog(); return; }
      if (key.ctrl && key.name === 'c') { shutdown(); resolve(); return; }
      if (key.name === 'q' || key.name === 'Q' || key.name === 'b' || key.name === 'B') {
        shutdown(); resolve();
      }
    });
  });

  // ── Tunnel connection (runs concurrently with UI) ─────────────────────────
  const tunnelDone = (async () => {
    let registration: {
      tunnelId: string; type: 'http' | 'tcp'; token: string;
      connect_url: string; public_url?: string; tcp_addr?: string;
    };

    try {
      const res = await fetch(`${SERVER}/tunnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: setup.protocol }),
      });
      if (!res.ok) {
        if (!live) return;
        connStatus.content = `✗ ${res.status} ${res.statusText}`;
        connStatus.fg      = C.red;
        return;
      }
      registration = await res.json() as typeof registration;
    } catch (err) {
      if (!live) return;
      connStatus.content = `✗ ${(err as Error).message}`;
      connStatus.fg      = C.red;
      return;
    }

    if (!live) return;

    const publicUrl = registration.public_url ?? registration.tcp_addr ?? '';

    ws = new WebSocket(registration.connect_url, { perMessageDeflate: false });
    ws.binaryType = 'nodebuffer';

    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.on('open', () => {
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(encodeFrame(FRAME.PING, 0));
      }, 30_000);
    });

    ws.on('error', (err) => {
      if (!live) return;
      connStatus.content = `✗ ${err.message}`;
      connStatus.fg      = C.red;
    });

    ws.on('close', () => {
      if (pingTimer) clearInterval(pingTimer);
      if (!live) return;
      connected          = false;
      connStatus.content = '○ DISCONNECTED';
      connStatus.fg      = C.amber;
      for (const s of sockets.values()) s.destroy();
      sockets.clear();
    });

    const pending = new Map<number, PendingStream>();

    let firstMsg = true;

    ws.on('message', (raw: Buffer) => {
      if (!live) return;

      // First message: JSON tunnel_open handshake
      if (firstMsg) {
        firstMsg = false;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'tunnel_open') {
            connected          = true;
            connStatus.content = '● CONNECTED';
            connStatus.fg      = C.emerald;
            connUrl.content    = publicUrl;
            connUrl.fg         = C.white;
          }
        } catch { /* not JSON */ }
        return;
      }

      if (raw.length < 5 || raw[0] === 0x7b) return; // too short or stray JSON
      const frame = decodeFrame(raw);

      if (frame.type === FRAME.PONG) return;
      if (frame.type === FRAME.PING) { ws?.send(encodeFrame(FRAME.PONG, 0)); return; }

      switch (frame.type) {

        case FRAME.STREAM_OPEN: {
          const host = setup.target;
          const port = setup.port ?? (setup.protocol === 'http' ? 80 : 0);

          // For HTTP: parse request line from payload to show in traffic table
          if (setup.protocol === 'http') {
            const parsed = parseHttpRequestLine(frame.payload);
            if (parsed) {
              pending.set(frame.streamId, {
                method: parsed.method, path: parsed.path,
                startedAt: Date.now(), gotStatus: false,
                respBuf: Buffer.alloc(0), headersDone: false,
                contentLength: -1, bodyReceived: 0,
              });
            }
          } else {
            // TCP: log stream open immediately
            const now = new Date();
            pushEntry({
              time:       `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`,
              method:     'TCP',
              path:       `stream #${frame.streamId}  →  ${host}:${port}`,
              statusCode: 0,
            });
          }

          const sock = net.createConnection({ host, port });

          sock.on('connect', () => {
            sockets.set(frame.streamId, sock);
            if (frame.payload.length > 0) sock.write(frame.payload);
          });

          sock.on('data', (data: Buffer) => {
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(encodeFrame(FRAME.STREAM_DATA, frame.streamId, data));

            if (setup.protocol !== 'http') return;
            const p = pending.get(frame.streamId);
            if (!p) return;

            // Parse status code from first response chunk
            if (!p.gotStatus) {
              const code = parseHttpStatusCode(data);
              if (code) {
                p.gotStatus = true;
                const now = new Date();
                pushEntry({
                  time:      `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`,
                  method:    p.method,
                  path:      p.path,
                  statusCode: code,
                  latencyMs: Date.now() - p.startedAt,
                });
              }
            }

            // Accumulate response bytes to detect completion via Content-Length.
            // This lets us send STREAM_END immediately without waiting for the
            // local server's keep-alive timeout to close the socket.
            p.respBuf = Buffer.concat([p.respBuf, data]);

            if (!p.headersDone) {
              const sep = p.respBuf.indexOf('\r\n\r\n');
              if (sep !== -1) {
                p.headersDone = true;
                const headerText = p.respBuf.subarray(0, sep).toString();
                const clMatch   = headerText.match(/content-length:\s*(\d+)/i);
                p.contentLength = clMatch ? parseInt(clMatch[1]!, 10) : -1;
                p.bodyReceived  = p.respBuf.length - sep - 4;
              }
            } else if (p.contentLength >= 0) {
              p.bodyReceived += data.length;
            }

            // If Content-Length is known and fully received, close proactively.
            if (p.headersDone && p.contentLength >= 0 && p.bodyReceived >= p.contentLength) {
              pending.delete(frame.streamId);
              sockets.delete(frame.streamId);
              sock.destroy();
              if (ws?.readyState === WebSocket.OPEN)
                ws.send(encodeFrame(FRAME.STREAM_END, frame.streamId));
            }
          });

          sock.on('end', () => {
            // May already be sent proactively via Content-Length detection.
            if (!sockets.has(frame.streamId)) return;
            pending.delete(frame.streamId);
            sockets.delete(frame.streamId);
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(encodeFrame(FRAME.STREAM_END, frame.streamId));
          });

          sock.on('close',  () => { pending.delete(frame.streamId); sockets.delete(frame.streamId); });

          sock.on('error', (err: Error) => {
            const p = pending.get(frame.streamId);
            if (p) {
              const now = new Date();
              pushEntry({
                time:       `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`,
                method:     p.method,
                path:       p.path,
                statusCode: 502,
                latencyMs:  Date.now() - p.startedAt,
              });
            }
            pending.delete(frame.streamId);
            sockets.delete(frame.streamId);
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(encodeFrame(FRAME.STREAM_RESET, frame.streamId));
          });

          break;
        }

        case FRAME.STREAM_DATA: {
          const sock = sockets.get(frame.streamId);
          if (sock && !sock.destroyed) sock.write(frame.payload);
          break;
        }

        case FRAME.STREAM_END: {
          const sock = sockets.get(frame.streamId);
          if (sock) { sockets.delete(frame.streamId); sock.end(); }
          pending.delete(frame.streamId);
          break;
        }

        case FRAME.STREAM_RESET: {
          const sock = sockets.get(frame.streamId);
          if (sock) { sockets.delete(frame.streamId); sock.destroy(); }
          pending.delete(frame.streamId);
          break;
        }
      }
    });
  })();

  await inputDone;
  await tunnelDone.catch(() => {});
}
