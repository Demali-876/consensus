/**
 * tunnel-runtime.ts — process-singleton manager for an active tunnel.
 *
 * Owns the WebSocket back to the Consensus edge, the per-stream sockets to the
 * local target, the request/response counters and rolling log. The dashboard
 * screen is a *view* over this state; closing the screen does not stop the
 * tunnel. Only `stopTunnel()` (called from the dashboard's stop key, or from
 * the navigator on TUI exit) tears it down.
 *
 * Constraints:
 *  - one active tunnel at a time
 *  - in-process only (no IPC, no daemon; dies with the TUI)
 *  - full rolling log (capped at MAX_LOG entries) preserved across re-attaches
 */

import net       from 'net';
import WebSocket from 'ws';
import { saveSession } from './store.ts';
import type { TunnelSetupResult } from '../tui/screens/tunnel/setup.ts';

const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

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

function fmtClock(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}

export type TunnelStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'closed';

export interface TunnelLogEntry {
  time:       string;
  method:     string;
  path:       string;
  statusCode: number;
  latencyMs?: number;
  size?:      number;
}

export interface TunnelSnapshot {
  setup:           TunnelSetupResult;
  tunnelId:        string;
  publicUrl:       string;
  region:          string;
  status:          TunnelStatus;
  statusReason:    string | null;
  startedAt:       number;
  bytesSent:       number;
  bytesRecv:       number;
  requestCount:    number;
  totalStreams:    number;
  activeStreams:   number;
  log:             TunnelLogEntry[];
  recentLatencies: number[];
  recentStatuses:  number[];
}

const MAX_LOG = 20;
const MAX_LATENCY_SAMPLES = 40;
const MAX_STATUS_SAMPLES  = 100;

interface PendingStream {
  method:        string;
  path:          string;
  startedAt:     number;
  gotStatus:     boolean;
  respBuf:       Buffer;
  headersDone:   boolean;
  contentLength: number;
  bodyReceived:  number;
}

interface ActiveTunnelState {
  setup:        TunnelSetupResult;
  sessionId:    string;
  tunnelId:     string;
  publicUrl:    string;
  region:       string;
  startedAt:    number;
  status:       TunnelStatus;
  statusReason: string | null;

  ws:           WebSocket | null;
  pingTimer:    ReturnType<typeof setInterval> | null;
  firstMsg:     boolean;

  sockets:      Map<number, net.Socket>;
  pending:      Map<number, PendingStream>;

  bytesSent:    number;
  bytesRecv:    number;
  requestCount: number;
  totalStreams: number;

  log:             TunnelLogEntry[];
  recentLatencies: number[];
  recentStatuses:  number[];
}

let state: ActiveTunnelState | null = null;
const subscribers = new Set<(snap: TunnelSnapshot | null) => void>();

function snapshot(): TunnelSnapshot | null {
  if (!state) return null;
  return {
    setup:           state.setup,
    tunnelId:        state.tunnelId,
    publicUrl:       state.publicUrl,
    region:          state.region,
    status:          state.status,
    statusReason:    state.statusReason,
    startedAt:       state.startedAt,
    bytesSent:       state.bytesSent,
    bytesRecv:       state.bytesRecv,
    requestCount:    state.requestCount,
    totalStreams:    state.totalStreams,
    activeStreams:   state.sockets.size,
    log:             state.log.slice(),
    recentLatencies: state.recentLatencies.slice(),
    recentStatuses:  state.recentStatuses.slice(),
  };
}

function notify(): void {
  const snap = snapshot();
  for (const fn of subscribers) {
    try { fn(snap); } catch { /* subscriber errors must not break the loop */ }
  }
}

function pushEntry(entry: TunnelLogEntry): void {
  if (!state) return;
  state.requestCount++;
  state.log.unshift(entry);
  if (state.log.length > MAX_LOG) state.log.pop();
  if (entry.latencyMs != null) {
    state.recentLatencies.push(entry.latencyMs);
    if (state.recentLatencies.length > MAX_LATENCY_SAMPLES) state.recentLatencies.shift();
  }
  if (entry.statusCode > 0) {
    state.recentStatuses.push(entry.statusCode);
    if (state.recentStatuses.length > MAX_STATUS_SAMPLES) state.recentStatuses.shift();
  }
  notify();
}

function handleFrame(s: ActiveTunnelState, frame: ReturnType<typeof decodeFrame>): void {
  if (frame.type === FRAME.PONG) return;
  if (frame.type === FRAME.PING) {
    s.ws?.send(encodeFrame(FRAME.PONG, 0));
    return;
  }

  switch (frame.type) {
    case FRAME.STREAM_OPEN: {
      const host = s.setup.target;
      const port = s.setup.port ?? (s.setup.protocol === 'http' ? 80 : 0);

      if (s.setup.protocol !== 'http') {
        pushEntry({
          time:       fmtClock(Date.now()),
          method:     'TCP',
          path:       `stream #${frame.streamId}  →  ${host}:${port}`,
          statusCode: 0,
        });
      }

      const sock = net.createConnection({ host, port });

      // Register immediately so STREAM_DATA frames arriving before the TCP
      // connect handler fires still find the socket; Node buffers pre-connect
      // writes and flushes on connect.
      s.sockets.set(frame.streamId, sock);
      s.totalStreams++;
      if (frame.payload.length > 0) sock.write(frame.payload);
      notify();

      sock.on('data', (data: Buffer) => {
        if (s.ws?.readyState === WebSocket.OPEN)
          s.ws.send(encodeFrame(FRAME.STREAM_DATA, frame.streamId, data));
        s.bytesSent += data.length;

        if (s.setup.protocol === 'http') {
          const p = s.pending.get(frame.streamId);
          if (p) {
            if (!p.gotStatus) {
              const code = parseHttpStatusCode(data);
              if (code) {
                p.gotStatus = true;
                pushEntry({
                  time:      fmtClock(Date.now()),
                  method:    p.method,
                  path:      p.path,
                  statusCode: code,
                  latencyMs: Date.now() - p.startedAt,
                  size:      0,
                });
              }
            }

            p.respBuf = Buffer.concat([p.respBuf, data]);
            if (!p.headersDone) {
              const sep = p.respBuf.indexOf('\r\n\r\n');
              if (sep !== -1) {
                p.headersDone = true;
                const headerText = p.respBuf.subarray(0, sep).toString();
                const clMatch    = headerText.match(/content-length:\s*(\d+)/i);
                p.contentLength  = clMatch ? parseInt(clMatch[1]!, 10) : -1;
                p.bodyReceived   = p.respBuf.length - sep - 4;
              }
            } else if (p.contentLength >= 0) {
              p.bodyReceived += data.length;
            }

            if (p.headersDone && p.contentLength >= 0 && p.bodyReceived >= p.contentLength) {
              const fresh = s.log[0];
              if (fresh && fresh.path === p.path) fresh.size = p.contentLength;
              s.pending.delete(frame.streamId);
              s.sockets.delete(frame.streamId);
              sock.destroy();
              if (s.ws?.readyState === WebSocket.OPEN)
                s.ws.send(encodeFrame(FRAME.STREAM_END, frame.streamId));
            }
          }
        }
        notify();
      });

      sock.on('end', () => {
        if (!s.sockets.has(frame.streamId)) return;
        s.pending.delete(frame.streamId);
        s.sockets.delete(frame.streamId);
        if (s.ws?.readyState === WebSocket.OPEN)
          s.ws.send(encodeFrame(FRAME.STREAM_END, frame.streamId));
        notify();
      });

      sock.on('close', () => {
        s.pending.delete(frame.streamId);
        s.sockets.delete(frame.streamId);
        notify();
      });

      sock.on('error', () => {
        const p = s.pending.get(frame.streamId);
        if (p) {
          pushEntry({
            time:       fmtClock(Date.now()),
            method:     p.method,
            path:       p.path,
            statusCode: 502,
            latencyMs:  Date.now() - p.startedAt,
          });
        }
        s.pending.delete(frame.streamId);
        s.sockets.delete(frame.streamId);
        if (s.ws?.readyState === WebSocket.OPEN)
          s.ws.send(encodeFrame(FRAME.STREAM_RESET, frame.streamId));
        notify();
      });

      break;
    }

    case FRAME.STREAM_DATA: {
      const sock = s.sockets.get(frame.streamId);
      if (sock && !sock.destroyed) sock.write(frame.payload);

      // STREAM_OPEN arrives with an empty payload; the request bytes ride on
      // the first STREAM_DATA. Parse the request line here so the log entry
      // can attach the eventual response status/latency.
      if (s.setup.protocol === 'http' && !s.pending.has(frame.streamId)) {
        const parsed = parseHttpRequestLine(frame.payload);
        if (parsed) {
          s.pending.set(frame.streamId, {
            method: parsed.method, path: parsed.path,
            startedAt: Date.now(), gotStatus: false,
            respBuf: Buffer.alloc(0), headersDone: false,
            contentLength: -1, bodyReceived: 0,
          });
        }
      }
      break;
    }

    case FRAME.STREAM_END: {
      const sock = s.sockets.get(frame.streamId);
      if (sock) {
        s.sockets.delete(frame.streamId);
        sock.end();
        notify();
      }
      s.pending.delete(frame.streamId);
      break;
    }

    case FRAME.STREAM_RESET: {
      const sock = s.sockets.get(frame.streamId);
      if (sock) {
        s.sockets.delete(frame.streamId);
        sock.destroy();
        notify();
      }
      s.pending.delete(frame.streamId);
      break;
    }
  }
}

interface TunnelRegistration {
  tunnelId:    string;
  type:        'http' | 'tcp';
  token:       string;
  connect_url: string;
  public_url?: string;
  tcp_addr?:   string;
}

export function getActiveTunnel(): TunnelSnapshot | null {
  return snapshot();
}

export function subscribe(fn: (snap: TunnelSnapshot | null) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export async function startTunnel(setup: TunnelSetupResult): Promise<TunnelSnapshot> {
  if (state) {
    throw new Error('A tunnel is already running. Stop it first.');
  }

  const sessionId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? (crypto as Crypto).randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  state = {
    setup,
    sessionId,
    tunnelId:        '',
    publicUrl:       '',
    region:          'sfo',
    startedAt:       Date.now(),
    status:          'connecting',
    statusReason:    null,
    ws:              null,
    pingTimer:       null,
    firstMsg:        true,
    sockets:         new Map(),
    pending:         new Map(),
    bytesSent:       0,
    bytesRecv:       0,
    requestCount:    0,
    totalStreams:    0,
    log:             [],
    recentLatencies: [],
    recentStatuses:  [],
  };
  notify();

  let registration: TunnelRegistration;
  try {
    const res = await fetch(`${SERVER}/tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: setup.protocol }),
    });
    if (!res.ok) {
      const reason = `${res.status} ${res.statusText}`;
      state.status = 'disconnected';
      state.statusReason = reason;
      notify();
      throw new Error(reason);
    }
    registration = await res.json() as TunnelRegistration;
  } catch (err) {
    state.status = 'disconnected';
    state.statusReason = (err as Error).message;
    notify();
    const s = state;
    state = null;
    notify();
    throw err instanceof Error ? err : new Error(String(s.statusReason));
  }

  state.tunnelId  = registration.tunnelId;
  state.publicUrl = registration.public_url ?? registration.tcp_addr ?? '';
  notify();

  const ws = new WebSocket(registration.connect_url, { perMessageDeflate: false });
  ws.binaryType = 'nodebuffer';
  state.ws = ws;

  // Capture a stable reference to the state this WS belongs to. If a new
  // tunnel is started before this WS's events finish firing, we must NOT
  // touch the new state — only the one this WS was opened for.
  const owned = state;

  ws.on('open', () => {
    if (state !== owned) return;
    owned.pingTimer = setInterval(() => {
      if (state === owned && owned.ws?.readyState === WebSocket.OPEN) {
        owned.ws.send(encodeFrame(FRAME.PING, 0));
      }
    }, 30_000);
  });

  ws.on('error', (err) => {
    if (state !== owned) return;
    owned.status = 'disconnected';
    owned.statusReason = err.message;
    notify();
  });

  ws.on('close', () => {
    if (owned.pingTimer) clearInterval(owned.pingTimer);
    owned.pingTimer = null;
    if (state !== owned) return;
    for (const s of owned.sockets.values()) s.destroy();
    owned.sockets.clear();
    owned.pending.clear();
    if (owned.status !== 'closed') {
      owned.status = 'disconnected';
      owned.statusReason = owned.statusReason ?? 'DISCONNECTED';
    }
    notify();
  });

  ws.on('message', (raw: Buffer) => {
    if (state !== owned) return;
    owned.bytesRecv += raw.length;

    if (owned.firstMsg) {
      owned.firstMsg = false;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'tunnel_open') {
          owned.status = 'connected';
          owned.statusReason = null;
          notify();
        }
      } catch { /* not JSON — fall through and treat as a frame */ }
      // First message is always the JSON greeting; nothing else to do.
      if (raw[0] === 0x7b) return;
    }

    if (raw.length < 5 || raw[0] === 0x7b) {
      notify();
      return;
    }
    const frame = decodeFrame(raw);
    handleFrame(owned, frame);
    notify();
  });

  return snapshot()!;
}

export async function stopTunnel(): Promise<void> {
  if (!state) return;
  const s = state;
  s.status = 'closed';
  s.statusReason = null;

  if (s.pingTimer) clearInterval(s.pingTimer);
  s.pingTimer = null;

  for (const sock of s.sockets.values()) {
    try { sock.destroy(); } catch { /* ignore */ }
  }
  s.sockets.clear();
  s.pending.clear();

  try { s.ws?.close(); } catch { /* ignore */ }
  s.ws = null;

  const endedAt = Date.now();
  try {
    saveSession({
      id:         s.sessionId,
      type:       s.setup.protocol === 'http' ? 'tunnel-http' : 'tunnel-tcp',
      url:        s.publicUrl,
      target:     [s.setup.target, s.setup.port].filter(Boolean).join(':'),
      startedAt:  s.startedAt,
      endedAt,
      durationMs: endedAt - s.startedAt,
      outcome:    'user-quit',
      spendUsd:   0,
      requests:   s.requestCount,
      bytesIn:    s.bytesRecv,
      bytesOut:   s.bytesSent,
    });
  } catch { /* non-fatal */ }

  state = null;
  notify();
}
