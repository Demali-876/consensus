import crypto                         from 'crypto';
import net                            from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import type { Express, Request }      from 'express';
import type { Server }                from 'http';
import { generateSlug }               from './slug.ts';

export const FRAME = {
  STREAM_OPEN:  0x01,
  STREAM_DATA:  0x02,
  STREAM_END:   0x03,
  STREAM_RESET: 0x04,
  PING:         0x05,
  PONG:         0x06,
} as const;

export type FrameType = typeof FRAME[keyof typeof FRAME];

export function encodeFrame(type: FrameType, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId, 1);
  return Buffer.concat([header, payload]);
}

export function decodeFrame(data: Buffer): { type: FrameType; streamId: number; payload: Buffer } {
  if (data.length < 5) throw new RangeError(`Frame too short: ${data.length} bytes`);
  return {
    type:     data.readUInt8(0) as FrameType,
    streamId: data.readUInt32BE(1),
    payload:  data.subarray(5),
  };
}

interface PendingToken {
  tunnelId: string;
  expires:  number;
  type:     'http' | 'tcp';
}

interface TunnelEntry {
  tunnelId: string;
  ws:       WebSocket;
  streams:  Map<number, TunnelStream>;
}

interface TunnelStream {
  streamId: number;
  onData:   (payload: Buffer) => void;
  onEnd:    () => void;
  onReset:  () => void;
}

const activeTunnels = new Map<string, TunnelEntry>();
const pendingTokens = new Map<string, PendingToken>();
let   streamCounter = 0;

const TCP_PORT = 20_000;

const STRIP_HEADERS = new Set([
  'x-forwarded-host', 'forwarded', 'via',
]);

function buildRawRequest(req: Request): Buffer {
  const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];

  for (const [key, value] of Object.entries(req.headers)) {
    if (STRIP_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach(v => lines.push(`${key}: ${v}`));
    else if (value)           lines.push(`${key}: ${value}`);
  }

  const clientIp = req.ip ?? req.socket.remoteAddress ?? '';
  if (clientIp) {
    lines.push(`x-real-ip: ${clientIp}`);
    const existingXff = req.headers['x-forwarded-for'];
    lines.push(`x-forwarded-for: ${existingXff ? `${existingXff}, ${clientIp}` : clientIp}`);
  }
  lines.push(`x-forwarded-proto: ${req.protocol}`);

  let body: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
  if (!body.length && req.body) {
    const ct = req.headers['content-type'] ?? '';
    body = ct.includes('application/json')
      ? Buffer.from(JSON.stringify(req.body))
      : Buffer.from(String(req.body));
  }

  if (body.length) lines.push(`content-length: ${body.length}`);

  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n');
  return body.length > 0 ? Buffer.concat([head, body]) : head;
}

function parseRawResponse(buf: Buffer): { status: number; headers: Record<string, string>; body: Buffer } {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) return { status: 502, headers: {}, body: Buffer.alloc(0) };

  const lines  = buf.subarray(0, headerEnd).toString().split('\r\n');
  const status = parseInt(lines[0].split(' ')[1]);
  const headers: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon > 0) {
      headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
    }
  }

  return { status, headers, body: buf.subarray(headerEnd + 4) };
}

function startTcpGateway(): void {
  const server = net.createServer((socket) => {
    let headerBuf = Buffer.alloc(0);
    let routed    = false;

    socket.setTimeout(10_000);
    socket.on('timeout', () => { if (!routed) socket.destroy(); });
    socket.on('error', (err: Error) => {
      if (!routed) {
        socket.destroy();
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ECONNRESET') console.error('[TCP Gateway] pre-route error:', err.message);
      }
    });

    socket.on('data', (chunk: Buffer) => {
      if (routed) return;

      headerBuf = Buffer.concat([headerBuf, chunk]);

      if (headerBuf.length > 256) { socket.destroy(); return; }

      const newline = headerBuf.indexOf('\n');
      if (newline === -1) return;

      const tunnelId = headerBuf.subarray(0, newline).toString().replace(/\r$/, '').trim();
      const rest     = headerBuf.subarray(newline + 1);
      routed = true;
      socket.setTimeout(0);

      const tunnel = activeTunnels.get(tunnelId);
      if (!tunnel || tunnel.ws.readyState !== WebSocket.OPEN) {
        socket.write('ERR tunnel-not-found\n');
        socket.destroy();
        return;
      }

      socket.write('OK\n');

      const streamId = (++streamCounter) >>> 0;

      tunnel.streams.set(streamId, {
        streamId,
        onData:  (payload) => { if (!socket.destroyed) socket.write(payload); },
        onEnd:   () => { tunnel.streams.delete(streamId); socket.end(); },
        onReset: () => { tunnel.streams.delete(streamId); socket.destroy(); },
      });

      tunnel.ws.send(encodeFrame(FRAME.STREAM_OPEN, streamId));
      if (rest.length > 0) tunnel.ws.send(encodeFrame(FRAME.STREAM_DATA, streamId, rest));

      socket.removeAllListeners('data');

      socket.on('data', (data: Buffer) => {
        if (tunnel.ws.readyState === WebSocket.OPEN) tunnel.ws.send(encodeFrame(FRAME.STREAM_DATA, streamId, data));
      });

      socket.on('end', () => {
        tunnel.streams.delete(streamId);
        if (tunnel.ws.readyState === WebSocket.OPEN) tunnel.ws.send(encodeFrame(FRAME.STREAM_END, streamId));
      });

      socket.on('close', () => { tunnel.streams.delete(streamId); });

      socket.on('error', (err: Error) => {
        console.error(`[TCP] ${tunnelId}:${streamId}:`, err.message);
        tunnel.streams.delete(streamId);
        if (tunnel.ws.readyState === WebSocket.OPEN) tunnel.ws.send(encodeFrame(FRAME.STREAM_RESET, streamId));
      });
    });
  });

  server.listen(TCP_PORT, () => console.log(`[TCP Gateway] listening on :${TCP_PORT}`));
  server.on('error', (err: Error) => console.error('[TCP Gateway] error:', err.message));
}

export function registerTunnel(app: Express, server: Server) {
  startTcpGateway();

  app.post('/tunnel', (req, res) => {
    const type = (req.body?.type === 'tcp') ? 'tcp' : 'http';

    let tunnelId = generateSlug();
    while (activeTunnels.has(tunnelId)) tunnelId = generateSlug();

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 60_000;

    pendingTokens.set(token, { tunnelId, expires, type });

    res.json({
      tunnelId,
      type,
      token,
      connect_url: `wss://consensus.canister.software/tunnel-connect?token=${token}`,
      expires_in:  60,
      ...(type === 'http'
        ? { public_url: `https://${tunnelId}.tunnel.canister.software` }
        : { tcp_addr:   `tcp.tunnel.canister.software:${TCP_PORT}` }
      ),
    });
  });

  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (!host.endsWith('.tunnel.canister.software')) return next();

    const subdomain = host.split('.')[0];
    const ct        = req.headers['content-type'] ?? '';

    if (!ct.includes('application/json') && req.body === undefined) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end',  () => { (req as any).rawBody = Buffer.concat(chunks); handleTunnelRequest(); });
      return;
    }

    handleTunnelRequest();

    function handleTunnelRequest() {
      const tunnel = activeTunnels.get(subdomain);
      if (!tunnel || tunnel.ws.readyState !== WebSocket.OPEN) {
        res.status(503).json({ error: 'Tunnel not connected' });
        return;
      }

      const streamId = (++streamCounter) >>> 0;
      const rawReq   = buildRawRequest(req);
      const chunks:  Buffer[] = [];

      const timer = setTimeout(() => {
        tunnel.streams.delete(streamId);
        tunnel.ws.send(encodeFrame(FRAME.STREAM_RESET, streamId));
        if (!res.headersSent) res.status(504).json({ error: 'Tunnel timeout' });
      }, 30_000);

      tunnel.streams.set(streamId, {
        streamId,
        onData:  (payload) => chunks.push(payload),
        onEnd:   () => {
          clearTimeout(timer);
          tunnel.streams.delete(streamId);
          const { status, headers, body } = parseRawResponse(Buffer.concat(chunks));
          const skip = new Set(['content-length', 'transfer-encoding', 'connection']);
          for (const [k, v] of Object.entries(headers)) {
            if (!skip.has(k)) res.setHeader(k, v);
          }
          res.status(status).send(body);
        },
        onReset: () => {
          clearTimeout(timer);
          tunnel.streams.delete(streamId);
          if (!res.headersSent) res.status(502).json({ error: 'Tunnel reset stream' });
        },
      });

      tunnel.ws.send(encodeFrame(FRAME.STREAM_OPEN, streamId, rawReq));
    }
  });

  const tunnelWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (url.pathname !== '/tunnel-connect') {
      if (url.pathname !== '/ws-connect') socket.destroy();
      return;
    }

    const token   = url.searchParams.get('token');
    const pending = token ? pendingTokens.get(token) : null;

    if (!pending) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pending.expires < Date.now()) {
      pendingTokens.delete(token!);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const { tunnelId } = pending;
    pendingTokens.delete(token!);

    tunnelWss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).tunnelId = tunnelId;
      tunnelWss.emit('connection', ws);
    });
  });

  tunnelWss.on('connection', (ws: WebSocket) => {
    const tunnelId = (ws as any).tunnelId as string;
    const tunnel: TunnelEntry = { tunnelId, ws, streams: new Map() };
    activeTunnels.set(tunnelId, tunnel);
    console.log(`[Tunnel Connected] ${tunnelId}`);

    ws.send(JSON.stringify({ type: 'tunnel_open', tunnelId }));

    ws.on('message', (data: Buffer) => {
      let frame: ReturnType<typeof decodeFrame>;
      try { frame = decodeFrame(data); } catch { return; }

      const stream = tunnel.streams.get(frame.streamId);
      if (!stream) return;

      if (frame.type === FRAME.STREAM_DATA)  stream.onData(frame.payload);
      if (frame.type === FRAME.STREAM_END)   stream.onEnd();
      if (frame.type === FRAME.STREAM_RESET) stream.onReset();
      if (frame.type === FRAME.PING)         ws.send(encodeFrame(FRAME.PONG, 0));
    });

    ws.on('close', () => {
      activeTunnels.delete(tunnelId);
      console.log(`[Tunnel Disconnected] ${tunnelId}`);
    });

    ws.on('error', (err: Error) => console.error(`[Tunnel Error] ${tunnelId}:`, err.message));
  });

  setInterval(() => {
    const now = Date.now();
    for (const [token, p] of pendingTokens) {
      if (p.expires < now) pendingTokens.delete(token);
    }
  }, 10_000);

  return {
    getStats: () => ({
      active_tunnels: activeTunnels.size,
      pending_tokens: pendingTokens.size,
    }),
  };
}
