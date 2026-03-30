/**
 * Consensus Tunnel Client — opentui TUI
 *
 *   consensus tunnel http 192.168.1.101
 *   consensus tunnel http 192.168.1.101:3000
 *   consensus tunnel tcp  192.168.1.101:1883
 */

import net     from 'net';
import WebSocket from 'ws';
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ASCIIFontRenderable,
  ScrollBoxRenderable,
} from '@opentui/core';

// ─── Frame protocol (mirrors server/tunnel.ts exactly) ───────────────────────

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
  return {
    type:     data.readUInt8(0),
    streamId: data.readUInt32BE(1),
    payload:  data.subarray(5),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseTarget(raw: string, defaultPort: number): { host: string; port: number } {
  // IPv6 literal: [::1]:8080
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    const host  = raw.slice(1, close);
    const rest  = raw.slice(close + 1);
    const port  = rest.startsWith(':') ? parseInt(rest.slice(1)) : defaultPort;
    return { host, port: isNaN(port) ? defaultPort : port };
  }
  // Plain port number: "3000" → localhost:3000
  const asPort = parseInt(raw, 10);
  if (!isNaN(asPort) && String(asPort) === raw) {
    return { host: 'localhost', port: asPort };
  }
  // host:port or bare host
  const lastColon = raw.lastIndexOf(':');
  if (lastColon === -1) return { host: raw, port: defaultPort };
  const maybePort = parseInt(raw.slice(lastColon + 1));
  if (isNaN(maybePort)) return { host: raw, port: defaultPort };
  return { host: raw.slice(0, lastColon), port: maybePort };
}

function formatBytes(n: number): string {
  if (n < 1024)           return `${n} B`;
  if (n < 1024 * 1024)    return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─── Palette (dark / light mode aware) ───────────────────────────────────────
import { C } from './theme';

// ─── Build the TUI layout ────────────────────────────────────────────────────

export async function buildTUI(
  tunnelId: string,
  type: 'http' | 'tcp',
  publicUrl: string,
  targetRaw: string
) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,       // we handle Ctrl+C manually
    targetFps: 10,
    useMouse: false,
  });

  renderer.start(); // continuous rendering for the live clock

  // ── Root layout ────────────────────────────────────────────────────────────
  //   col: header | body(row) | logs | footer

  const root = renderer.root;
  root.flexDirection    = 'column';
  root.padding          = 0;

  // ── Header: ASCII logo ─────────────────────────────────────────────────────
  const header = new BoxRenderable(renderer, {
    width:           '100%',
    flexDirection:   'column',
    alignItems:      'center',
    padding:         1,
    paddingBottom:   0,
    backgroundColor: C.dark,
  });

  const logo = new ASCIIFontRenderable(renderer, {
    text:            'CONSENSUS',
    font:            'block',
    color:           C.white,
    backgroundColor: 'transparent',
  });

  const subtitle = new TextRenderable(renderer, {
    content: `  IoT Tunnel  ·  ${type.toUpperCase()}  ·  ${targetRaw}  `,
    fg:      C.slate,
    bg:      C.dark,
  });

  header.add(logo);
  header.add(subtitle);
  root.add(header);

  // ── Body row: info panel + stats panel ─────────────────────────────────────
  const body = new BoxRenderable(renderer, {
    width:          '100%',
    flexDirection:  'row',
    gap:            1,
    paddingX:       1,
    paddingTop:     1,
    backgroundColor: C.dark,
  });

  // Left: Tunnel Info
  const infoBox = new BoxRenderable(renderer, {
    flexGrow:        1,
    flexShrink:      1,
    borderStyle:     'rounded',
    borderColor:     C.sky,
    title:           ' Tunnel ',
    padding:         1,
    backgroundColor: C.panel,
  });

  const mkRow = (renderer_: typeof renderer, label: string, value: string, valueColor: string = C.white) => {
    const row = new BoxRenderable(renderer_, {
      flexDirection:   'row',
      backgroundColor: 'transparent',
      marginBottom:    0,
    });
    row.add(new TextRenderable(renderer_, { content: `${label.padEnd(11)}`, fg: C.dim, bg: 'transparent' }));
    row.add(new TextRenderable(renderer_, { content: value, fg: valueColor, bg: 'transparent' }));
    return row;
  };

  infoBox.add(mkRow(renderer, 'ID',      tunnelId,  C.cyan));
  infoBox.add(mkRow(renderer, 'URL',     publicUrl, C.emerald));
  infoBox.add(mkRow(renderer, 'Target',  targetRaw, C.white));
  infoBox.add(mkRow(renderer, 'Type',    type.toUpperCase(), type === 'http' ? C.sky : C.amber));

  // Uptime row — we keep a ref to update it
  const uptimeValueText = new TextRenderable(renderer, {
    content: '0s',
    fg:      C.white,
    bg:      'transparent',
  });
  const uptimeRow = new BoxRenderable(renderer, {
    flexDirection:   'row',
    backgroundColor: 'transparent',
  });
  uptimeRow.add(new TextRenderable(renderer, { content: 'Uptime'.padEnd(11), fg: C.dim, bg: 'transparent' }));
  uptimeRow.add(uptimeValueText);
  infoBox.add(uptimeRow);

  // Right: Traffic Stats
  const statsBox = new BoxRenderable(renderer, {
    flexGrow:       1,
    flexShrink:     1,
    borderStyle:    'rounded',
    borderColor:    C.cyan,
    title:          ' Traffic ',
    padding:        1,
    backgroundColor: C.panel,
  });

  const requestsText  = new TextRenderable(renderer, { content: '0',     fg: C.amber,   bg: 'transparent' });
  const streamsText   = new TextRenderable(renderer, { content: '0',     fg: C.sky,     bg: 'transparent' });
  const sentText      = new TextRenderable(renderer, { content: '0 B',   fg: C.white,   bg: 'transparent' });
  const receivedText  = new TextRenderable(renderer, { content: '0 B',   fg: C.white,   bg: 'transparent' });
  const statusText    = new TextRenderable(renderer, { content: '● Connecting…', fg: C.amber, bg: 'transparent' });

  const mkStatRow = (renderer_: typeof renderer, label: string, valueNode: TextRenderable) => {
    const row = new BoxRenderable(renderer_, {
      flexDirection:   'row',
      backgroundColor: 'transparent',
      marginBottom:    0,
    });
    row.add(new TextRenderable(renderer_, { content: `${label.padEnd(13)}`, fg: C.dim, bg: 'transparent' }));
    row.add(valueNode);
    return row;
  };

  statsBox.add(mkStatRow(renderer, 'Status',     statusText));
  statsBox.add(mkStatRow(renderer, 'Requests',   requestsText));
  statsBox.add(mkStatRow(renderer, 'Active',     streamsText));
  statsBox.add(mkStatRow(renderer, '↑ Sent',     sentText));
  statsBox.add(mkStatRow(renderer, '↓ Received', receivedText));

  body.add(infoBox);
  body.add(statsBox);
  root.add(body);

  // ── Request log (sticky-scroll to bottom) ──────────────────────────────────
  const logBox = new BoxRenderable(renderer, {
    width:          '100%',
    flexGrow:       1,
    borderStyle:    'rounded',
    borderColor:    C.dim,
    title:          ' Activity ',
    marginX:        1,
    marginTop:      1,
    backgroundColor: C.panel,
  });

  const logScroll = new ScrollBoxRenderable(renderer, {
    width:        '100%',
    height:       '100%',
    scrollY:      true,
    stickyScroll: true,
    stickyStart:  'bottom',
    backgroundColor: 'transparent',
  });

  logBox.add(logScroll);
  root.add(logBox);

  // ── Footer ────────────────────────────────────────────────────────────────
  const FOOTER_IDLE    = '  Ctrl+C  close tunnel    ↑↓  scroll log  ';
  const FOOTER_CONFIRM = '  Close tunnel?  Y  confirm    any key  cancel  ';

  const footer = new TextRenderable(renderer, {
    content: FOOTER_IDLE,
    fg:      C.dim,
    bg:      C.dark,
  });
  root.add(footer);

  // ── Log helper ────────────────────────────────────────────────────────────
  let logCount = 0;

  function addLog(icon: string, message: string, color: string): void {
    logCount++;
    const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
    const line = new TextRenderable(renderer, {
      content: `  ${icon}  ${ts}  ${message}`,
      fg:      color,
      bg:      'transparent',
    });
    logScroll.add(line);
    // Keep at most 200 log lines
    const children = logScroll.getChildren();
    if (children.length > 200) {
      logScroll.remove(children[0]!.id);
    }
  }

  return {
    renderer,
    addLog,
    footer,
    FOOTER_IDLE,
    FOOTER_CONFIRM,
    setStatus(online: boolean) {
      statusText.content = online ? '● Connected' : '● Disconnected';
      statusText.fg      = online ? C.emerald     : C.red;
    },
    updateStats(stats: {
      requests: number;
      streams: number;
      bytesSent: number;
      bytesRecv: number;
      connectedAt: number;
    }) {
      requestsText.content = String(stats.requests);
      streamsText.content  = `${stats.streams} stream${stats.streams !== 1 ? 's' : ''}`;
      sentText.content     = formatBytes(stats.bytesSent);
      receivedText.content = formatBytes(stats.bytesRecv);
      uptimeValueText.content = formatUptime(Date.now() - stats.connectedAt);
    },
  };
}

// ─── Main exported command ────────────────────────────────────────────────────

export async function runTunnel(type: 'http' | 'tcp', targetRaw: string): Promise<void> {
  // Validate input
  if (!targetRaw.includes(':') && type === 'tcp') {
    console.error('TCP tunnels require an explicit port, e.g.  consensus tunnel tcp 192.168.1.101:1883');
    process.exit(1);
  }

  const { host: targetHost, port: targetPort } = parseTarget(
    targetRaw,
    type === 'http' ? 80 : 0
  );

  const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';

  // ── 1. Register tunnel (before launching TUI so we can show errors cleanly) ──

  let registration: {
    tunnelId:    string;
    type:        'http' | 'tcp';
    token:       string;
    connect_url: string;
    public_url?: string;
    tcp_addr?:   string;
  };

  process.stderr.write(`Registering ${type} tunnel → ${SERVER}/tunnel\n`);

  try {
    const res = await fetch(`${SERVER}/tunnel`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type }),
    });
    if (!res.ok) {
      const body = await res.text();
      process.stderr.write(`\nServer error ${res.status}: ${body}\n`);
      process.exit(1);
    }
    registration = await res.json() as typeof registration;
  } catch (err) {
    process.stderr.write(`\nFailed to reach server: ${(err as Error).message}\n`);
    process.stderr.write(`Is the server running? Try: curl ${SERVER}/health\n`);
    process.exit(1);
  }

  const publicUrl = registration.public_url ?? registration.tcp_addr ?? '';

  // ── 2. Build TUI ─────────────────────────────────────────────────────────────

  const tui = await buildTUI(registration.tunnelId, type, publicUrl, targetRaw);

  tui.addLog('◌', `Tunnel registered  →  ${publicUrl}`, C.slate);
  tui.addLog('◌', `Connecting WebSocket…`, C.slate);

  // ── 3. Live state ─────────────────────────────────────────────────────────────

  const stats = {
    requests:    0,
    streams:     0,
    bytesSent:   0,
    bytesRecv:   0,
    connectedAt: Date.now(),
  };

  // Tick clock every second
  const clockTimer = setInterval(() => tui.updateStats(stats), 1000);

  // ── 4. WebSocket control channel ──────────────────────────────────────────────

  const ws = new WebSocket(registration.connect_url, { perMessageDeflate: false });
  ws.binaryType = 'nodebuffer';

  const sockets = new Map<number, net.Socket>();

  // Keepalive ping every 30 s
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  ws.on('open', () => {
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(FRAME.PING, 0));
    }, 30_000);
  });

  ws.on('error', (err) => {
    tui.addLog('✗', `WebSocket error: ${err.message}`, C.red);
    tui.setStatus(false);
  });

  ws.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    tui.setStatus(false);
    tui.addLog('○', 'Tunnel disconnected', C.amber);
    for (const [, sock] of sockets) sock.destroy();
    sockets.clear();
  });

  let firstMessage = true;

  ws.on('message', (rawData: Buffer) => {
    // First message is the JSON tunnel_open handshake
    if (firstMessage) {
      firstMessage = false;
      try {
        const msg = JSON.parse(rawData.toString());
        if (msg.type === 'tunnel_open') {
          tui.setStatus(true);
          tui.addLog('●', `Tunnel open  ·  ${publicUrl}`, C.emerald);
          stats.connectedAt = Date.now();
          tui.updateStats(stats);
        }
      } catch { /* not JSON */ }
      return;
    }

    if (rawData.length < 5) return;
    if (rawData[0] === 0x7b) return; // stray JSON

    const frame = decodeFrame(rawData);

    if (frame.type === FRAME.PONG) return;
    if (frame.type === FRAME.PING) { ws.send(encodeFrame(FRAME.PONG, 0)); return; }

    switch (frame.type) {

      case FRAME.STREAM_OPEN: {
        stats.requests++;
        stats.streams++;
        tui.updateStats(stats);
        tui.addLog('→', `Stream #${frame.streamId} opened  (${targetHost}:${targetPort})`, C.sky);

        const sock = net.createConnection({ host: targetHost, port: targetPort });

        sock.on('connect', () => {
          sockets.set(frame.streamId, sock);
          if (frame.payload.length > 0) {
            sock.write(frame.payload);
            stats.bytesSent += frame.payload.length;
          }
        });

        sock.on('data', (data: Buffer) => {
          stats.bytesRecv += data.length;
          tui.updateStats(stats);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(encodeFrame(FRAME.STREAM_DATA, frame.streamId, data));
        });

        sock.on('end', () => {
          stats.streams = Math.max(0, stats.streams - 1);
          tui.updateStats(stats);
          sockets.delete(frame.streamId);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(encodeFrame(FRAME.STREAM_END, frame.streamId));
          tui.addLog('←', `Stream #${frame.streamId} closed`, C.dim);
        });

        sock.on('close', () => sockets.delete(frame.streamId));

        sock.on('error', (err: Error) => {
          stats.streams = Math.max(0, stats.streams - 1);
          tui.updateStats(stats);
          sockets.delete(frame.streamId);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(encodeFrame(FRAME.STREAM_RESET, frame.streamId));
          const code = (err as NodeJS.ErrnoException).code ?? '';
          if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code))
            tui.addLog('✗', `Stream #${frame.streamId} error: ${err.message}`, C.red);
          else
            tui.addLog('✗', `Stream #${frame.streamId} ${code} — target unreachable`, C.amber);
        });

        break;
      }

      case FRAME.STREAM_DATA: {
        const sock = sockets.get(frame.streamId);
        if (sock && !sock.destroyed) {
          sock.write(frame.payload);
          stats.bytesSent += frame.payload.length;
          tui.updateStats(stats);
        }
        break;
      }

      case FRAME.STREAM_END: {
        const sock = sockets.get(frame.streamId);
        if (sock) {
          stats.streams = Math.max(0, stats.streams - 1);
          sockets.delete(frame.streamId);
          sock.end();
          tui.updateStats(stats);
        }
        break;
      }

      case FRAME.STREAM_RESET: {
        const sock = sockets.get(frame.streamId);
        if (sock) {
          stats.streams = Math.max(0, stats.streams - 1);
          sockets.delete(frame.streamId);
          sock.destroy();
          tui.updateStats(stats);
        }
        break;
      }
    }
  });

  // ── 5. Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = () => {
    clearInterval(clockTimer);
    if (pingTimer) clearInterval(pingTimer);
    for (const [, sock] of sockets) sock.destroy();
    ws.close();
    tui.renderer.destroy();
    process.exit(0);
  };

  let pendingClose = false;

  tui.renderer.keyInput.on('keypress', (key) => {
    if (pendingClose) {
      if (key.name === 'y' || key.name === 'Y') {
        shutdown();
      } else {
        pendingClose = false;
        tui.footer.content = tui.FOOTER_IDLE;
        tui.footer.fg      = C.dim;
      }
      return;
    }
    if (key.ctrl && key.name === 'c') {
      pendingClose            = true;
      tui.footer.content      = tui.FOOTER_CONFIRM;
      tui.footer.fg           = C.amber;
    }
  });

  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    tui.renderer.destroy();
    console.error('Uncaught exception:', err.message);
    process.exit(1);
  });
}

