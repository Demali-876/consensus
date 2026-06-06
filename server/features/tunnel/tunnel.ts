import crypto                         from 'crypto';
import net                            from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import type { Express, Request }      from 'express';
import type { Server }                from 'http';
import Router                         from '../../router.ts';
import { log }                        from '../../utils/log.ts';
import { isOriginAllowed }            from '../../utils/origin.ts';
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
  nodeId?:  string | null;
  targetHost?: string;
  targetPort?: number;
}

interface TunnelEntry {
  tunnelId: string;
  type:     'http' | 'tcp';
  ws:       WebSocket;
  streams:  Map<number, TunnelStream>;
  nodeId?:  string | null;
  targetHost?: string;
  targetPort?: number;
  ownerRelay?: { streamId: string; close: (reason?: string) => void };
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
const WS_BACKPRESSURE_BYTES = parseInt(process.env.TUNNEL_WS_BACKPRESSURE_BYTES ?? '', 10) || 1 * 1024 * 1024;

const STRIP_HEADERS = new Set(['connection', 'content-length', 'transfer-encoding']);

interface RelayStream {
  streamId?: string;
  send(data: Buffer): void;
  close(reason?: string): void;
}

interface NodeTunnelControl {
  attachTunnelOwnerSession?(
    nodeId: string,
    input: {
      tunnelId: string;
      ownerWs: WebSocket;
    },
  ): { streamId: string; close: (reason?: string) => void };
  attachPublicTunnelStream?(
    nodeId: string,
    input: {
      tunnelId: string;
      initialData?: Buffer;
      onData: (data: Buffer) => void;
      onEnd: () => void;
      onError: (error: Error) => void;
    },
  ): { streamId: string; send: (data: Buffer) => void; close: (reason?: string) => void };
  getNodeSession?(nodeId: string): { mode?: string; ws?: { readyState?: number } } | null;
}

const nodeRelayStreams = new Map<string, RelayStream>();

function openTunnelStream(
  tunnel: TunnelEntry,
  streamId: number,
  initialData: Buffer,
  handlers: Omit<TunnelStream, 'streamId'>,
): void {
  if (
    tunnel.nodeId &&
    tunnel.nodeId !== 'server' &&
    tunnel.targetHost &&
    tunnel.targetPort &&
    activeNodeTunnel?.attachPublicTunnelStream
  ) {
    const key = `${tunnel.tunnelId}:${streamId}`;
    if (!tunnel.ownerRelay) {
      log.warn('public-tunnel', 'node-relay-unavailable', {
        tunnel_id: tunnel.tunnelId,
        stream_id: streamId,
        node_id: tunnel.nodeId,
        reason: 'owner relay not connected',
      });
      handlers.onReset();
      return;
    }

    try {
      log.info('public-tunnel', 'node-relay-open', {
        tunnel_id: tunnel.tunnelId,
        stream_id: streamId,
        node_id: tunnel.nodeId,
        target_host: tunnel.targetHost,
        target_port: tunnel.targetPort,
        owner_stream_id: tunnel.ownerRelay.streamId,
        initial_bytes: initialData.length,
      });
      const relay = activeNodeTunnel.attachPublicTunnelStream(tunnel.nodeId, {
        tunnelId: tunnel.tunnelId,
        initialData,
        onData: handlers.onData,
        onEnd: () => {
          nodeRelayStreams.delete(key);
          log.info('public-tunnel', 'node-relay-ended', {
            tunnel_id: tunnel.tunnelId,
            stream_id: streamId,
            node_id: tunnel.nodeId,
          });
          handlers.onEnd();
        },
        onError: () => {
          nodeRelayStreams.delete(key);
          log.error('public-tunnel', 'node-relay-error', {
            tunnel_id: tunnel.tunnelId,
            stream_id: streamId,
            node_id: tunnel.nodeId,
          });
          handlers.onReset();
        },
      });
      nodeRelayStreams.set(key, relay);
    } catch {
      log.error('public-tunnel', 'node-relay-open-failed', {
        tunnel_id: tunnel.tunnelId,
        stream_id: streamId,
        node_id: tunnel.nodeId,
      });
      handlers.onReset();
    }
    return;
  }

  log.info('public-tunnel', tunnel.nodeId === 'server' ? 'fallback-stream-open' : 'owner-stream-open', {
    tunnel_id: tunnel.tunnelId,
    stream_id: streamId,
    node_id: tunnel.nodeId ?? null,
    initial_bytes: initialData.length,
    fallback_mode: tunnel.nodeId === 'server',
    reason: tunnel.nodeId === 'server' ? 'server fallback' : 'owner websocket relay',
  });
  tunnel.ws.send(encodeFrame(FRAME.STREAM_OPEN, streamId));
  if (initialData.length > 0) tunnel.ws.send(encodeFrame(FRAME.STREAM_DATA, streamId, initialData));
}

function sendTunnelData(tunnel: TunnelEntry, streamId: number, data: Buffer): void {
  const key = `${tunnel.tunnelId}:${streamId}`;
  const relay = nodeRelayStreams.get(key);
  if (relay) {
    relay.send(data);
    return;
  }
  if (tunnel.ws.readyState !== WebSocket.OPEN) return;
  tunnel.ws.send(encodeFrame(FRAME.STREAM_DATA, streamId, data));
}

function closeTunnelStream(tunnel: TunnelEntry, streamId: number, reason: string): void {
  const key = `${tunnel.tunnelId}:${streamId}`;
  const relay = nodeRelayStreams.get(key);
  if (relay) {
    nodeRelayStreams.delete(key);
    relay.close(reason);
    return;
  }
  if (tunnel.ws.readyState === WebSocket.OPEN) tunnel.ws.send(encodeFrame(FRAME.STREAM_END, streamId));
}

let activeNodeTunnel: NodeTunnelControl | undefined;

function parsePreferenceHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['x-node-region', 'x-node-domain', 'x-node-exclude'] as const) {
    const val = req.headers[key];
    if (val) out[key] = Array.isArray(val) ? val[0]! : val;
  }
  return out;
}

function excludePreference(current: string | undefined, nodeId: string): string {
  const values = new Set(
    (current ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add(nodeId);
  return Array.from(values).join(',');
}

function hasConnectedControlSession(nodeTunnel: NodeTunnelControl | undefined, nodeId: string): boolean {
  const session = nodeTunnel?.getNodeSession?.(nodeId);
  return session?.mode === 'control' && session.ws?.readyState === WebSocket.OPEN;
}

function selectTunnelNode(
  router: Router | undefined,
  nodeTunnel: NodeTunnelControl | undefined,
  dedupeKey: string,
  basePreferences: Record<string, string>,
): any | null {
  if (!router) return null;

  const preferences = { ...basePreferences };
  let serverCandidate: any | null = null;

  for (let attempt = 0; attempt < 16; attempt++) {
    const node = router.selectNode(`${dedupeKey}:${attempt}`, preferences);
    if (!node) break;
    if (node.id === 'server') {
      serverCandidate ??= node;
      preferences['x-node-exclude'] = excludePreference(preferences['x-node-exclude'], node.id);
      continue;
    }
    if (
      nodeTunnel?.attachTunnelOwnerSession &&
      nodeTunnel?.attachPublicTunnelStream &&
      hasConnectedControlSession(nodeTunnel, node.id)
    ) return node;
    preferences['x-node-exclude'] = excludePreference(preferences['x-node-exclude'], node.id);
  }

  return serverCandidate;
}

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
  lines.push('connection: close');

  const methodCanHaveBody = req.method !== 'GET' && req.method !== 'HEAD';
  let body: Buffer = methodCanHaveBody ? ((req as any).rawBody ?? Buffer.alloc(0)) : Buffer.alloc(0);
  if (!body.length && methodCanHaveBody && req.body && Object.keys(req.body).length > 0) {
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

  let body = buf.subarray(headerEnd + 4);
  if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
    body = decodeChunkedBody(body);
    delete headers['transfer-encoding'];
  }

  return { status, headers, body };
}

function decodeChunkedBody(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) return buf;

    const sizeLine = buf.subarray(offset, lineEnd).toString('ascii').split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) return buf;
    offset = lineEnd + 2;

    if (size === 0) return Buffer.concat(chunks);
    if (offset + size > buf.length) return buf;

    chunks.push(buf.subarray(offset, offset + size));
    offset += size;

    if (buf.subarray(offset, offset + 2).toString('ascii') !== '\r\n') return buf;
    offset += 2;
  }

  return Buffer.concat(chunks);
}

function parseTarget(value: unknown): { host?: string; port?: number } {
  if (typeof value !== 'string' || value.trim() === '') return {};
  const raw = value.trim();
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return { host: url.hostname, port: url.port ? Number(url.port) : undefined };
  } catch {
    const [host, port] = raw.split(':');
    return { host, port: port ? Number(port) : undefined };
  }
}

function parsePort(value: unknown, fallback?: number): number | null {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (typeof parsed !== 'number') return null;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

function startTcpGateway(): void {
  const server = net.createServer((socket) => {
    const headerChunks: Buffer[] = [];
    let   headerLen = 0;
    let   routed    = false;

    socket.setTimeout(10_000);
    socket.on('timeout', () => { if (!routed) socket.destroy(); });
    socket.on('error', (err: Error) => {
      if (!routed) {
        socket.destroy();
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ECONNRESET') log.error('public-tunnel', 'tcp-pre-route-error', { message: err.message, code });
      }
    });

    socket.on('data', (chunk: Buffer) => {
      if (routed) return;

      headerLen += chunk.length;
      if (headerLen > 256) { socket.destroy(); return; }
      headerChunks.push(chunk);
      const headerBuf = Buffer.concat(headerChunks);
      const newline   = headerBuf.indexOf('\n');
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

      const handlers: Omit<TunnelStream, 'streamId'> = {
        onData:  (payload: Buffer) => { if (!socket.destroyed) socket.write(payload); },
        onEnd:   () => { tunnel.streams.delete(streamId); socket.end(); },
        onReset: () => { tunnel.streams.delete(streamId); socket.destroy(); },
      };
      tunnel.streams.set(streamId, { streamId, ...handlers });
      openTunnelStream(tunnel, streamId, rest, handlers);

      socket.removeAllListeners('data');

      socket.on('data', (data: Buffer) => {
        sendTunnelData(tunnel, streamId, data);
      });

      socket.on('end', () => {
        tunnel.streams.delete(streamId);
        closeTunnelStream(tunnel, streamId, 'tcp client ended');
      });

      socket.on('close', () => { tunnel.streams.delete(streamId); });

      socket.on('error', (err: Error) => {
        log.error('public-tunnel', 'tcp-stream-error', {
          tunnel_id: tunnelId,
          stream_id: streamId,
          message: err.message,
        });
        tunnel.streams.delete(streamId);
        closeTunnelStream(tunnel, streamId, 'tcp client error');
      });
    });
  });

  server.listen(TCP_PORT, () => log.info('public-tunnel', 'tcp-gateway-listening', { port: TCP_PORT }));
  server.on('error', (err: Error) => log.error('public-tunnel', 'tcp-gateway-error', { message: err.message }));
}

export function registerTunnel(app: Express, server: Server, options: { router?: Router; nodeTunnel?: NodeTunnelControl } = {}) {
  activeNodeTunnel = options.nodeTunnel;
  log.info('public-tunnel', 'registered', {
    tcp_port: TCP_PORT,
    node_relay: Boolean(options.nodeTunnel?.attachTunnelOwnerSession && options.nodeTunnel?.attachPublicTunnelStream),
  });
  startTcpGateway();

  app.post('/tunnel', (req, res) => {
    const type = (req.body?.type === 'tcp') ? 'tcp' : 'http';
    const target = parseTarget(req.body?.target ?? req.body?.target_url ?? req.body?.target_host ?? req.body?.host);
    const targetHost = target.host;
    const targetPort = targetHost
      ? parsePort(req.body?.port ?? target.port, type === 'http' ? 80 : undefined)
      : null;
    if (targetHost && !targetPort) {
      return res.status(400).json({ error: 'Tunnel target port is invalid or missing' });
    }

    let tunnelId = generateSlug();
    while (activeTunnels.has(tunnelId)) tunnelId = generateSlug();

    const node = targetHost && targetPort
      ? selectTunnelNode(options.router, options.nodeTunnel, `tunnel:${tunnelId}`, parsePreferenceHeaders(req))
      : null;
    if (targetHost && targetPort && !node) {
      return res.status(503).json({ error: 'No route available for target-backed tunnel' });
    }
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 60_000;

    log.info('public-tunnel', 'created', {
      tunnel_id: tunnelId,
      type,
      node_id: node?.id ?? null,
      target_host: targetHost ?? null,
      target_port: targetPort ?? null,
      fallback_mode: !targetHost,
      expires_in_ms: expires - Date.now(),
    });
    pendingTokens.set(token, {
      tunnelId,
      expires,
      type,
      nodeId: node?.id ?? null,
      targetHost,
      targetPort: targetPort ?? undefined,
    });

    res.json({
      tunnelId,
      type,
      token,
      connect_url: `wss://consensus.canister.software/tunnel-connect?token=${token}`,
      expires_in:  60,
      node_id: node?.id ?? null,
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
        log.warn('public-tunnel', 'http-request-unavailable', {
          tunnel_id: subdomain,
          host,
          method: req.method,
          url: req.url,
        });
        res.status(503).json({ error: 'Tunnel not connected' });
        return;
      }

      const streamId = (++streamCounter) >>> 0;
      const rawReq   = buildRawRequest(req);
      const chunks:  Buffer[] = [];

      log.info('public-tunnel', 'http-stream-open', {
        tunnel_id: subdomain,
        stream_id: streamId,
        method: req.method,
        url: req.url,
        node_id: tunnel.nodeId ?? null,
        target_host: tunnel.targetHost ?? null,
        target_port: tunnel.targetPort ?? null,
      });
      const timer = setTimeout(() => {
        tunnel.streams.delete(streamId);
        closeTunnelStream(tunnel, streamId, 'http tunnel timeout');
        if (!res.headersSent) res.status(504).json({ error: 'Tunnel timeout' });
      }, 30_000);

      const handlers: Omit<TunnelStream, 'streamId'> = {
        onData: (payload: Buffer) => chunks.push(payload),
        onEnd: () => {
          clearTimeout(timer);
          tunnel.streams.delete(streamId);
          const { status, headers, body } = parseRawResponse(Buffer.concat(chunks));
          log.info('public-tunnel', 'http-stream-complete', {
            tunnel_id: subdomain,
            stream_id: streamId,
            status,
            response_bytes: body.length,
          });
          const skip = new Set(['content-length', 'transfer-encoding', 'connection']);
          for (const [k, v] of Object.entries(headers)) {
            if (!skip.has(k)) res.setHeader(k, v);
          }
          res.status(status).send(body);
        },
        onReset: () => {
          clearTimeout(timer);
          tunnel.streams.delete(streamId);
          log.warn('public-tunnel', 'http-stream-reset', {
            tunnel_id: subdomain,
            stream_id: streamId,
          });
          if (!res.headersSent) res.status(502).json({ error: 'Tunnel reset stream' });
        },
      };
      tunnel.streams.set(streamId, { streamId, ...handlers });
      openTunnelStream(tunnel, streamId, rawReq, handlers);
    }
  });

  const tunnelWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (url.pathname !== '/tunnel-connect') return;

    if (!isOriginAllowed(req.headers.origin)) {
      log.warn('public-tunnel', 'connect-rejected', { reason: 'origin not allowed', origin: req.headers.origin ?? null });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const token   = url.searchParams.get('token');
    const pending = token ? pendingTokens.get(token) : null;

    if (!pending) {
      log.warn('public-tunnel', 'connect-rejected', { reason: 'missing or unknown token' });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pending.expires < Date.now()) {
      pendingTokens.delete(token!);
      log.warn('public-tunnel', 'connect-rejected', {
        tunnel_id: pending.tunnelId,
        reason: 'token expired',
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const { tunnelId, type, nodeId, targetHost, targetPort } = pending;
    pendingTokens.delete(token!);

    tunnelWss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).tunnelId = tunnelId;
      (ws as any).type = type;
      (ws as any).nodeId = nodeId;
      (ws as any).targetHost = targetHost;
      (ws as any).targetPort = targetPort;
      tunnelWss.emit('connection', ws);
    });
  });

  tunnelWss.on('connection', (ws: WebSocket) => {
    const tunnelId = (ws as any).tunnelId as string;
    const tunnel: TunnelEntry = {
      tunnelId,
      ws,
      streams: new Map(),
      type: (ws as any).type,
      nodeId: (ws as any).nodeId,
      targetHost: (ws as any).targetHost,
      targetPort: (ws as any).targetPort,
    };
    activeTunnels.set(tunnelId, tunnel);
    log.info('public-tunnel', 'owner-connected', {
      tunnel_id: tunnelId,
      type: tunnel.type,
      node_id: tunnel.nodeId ?? null,
      target_host: tunnel.targetHost ?? null,
      target_port: tunnel.targetPort ?? null,
    });

    ws.send(JSON.stringify({ type: 'tunnel_open', tunnelId }));

    if (tunnel.nodeId && tunnel.nodeId !== 'server' && activeNodeTunnel?.attachTunnelOwnerSession) {
      try {
        tunnel.ownerRelay = activeNodeTunnel.attachTunnelOwnerSession(tunnel.nodeId, {
          tunnelId,
          ownerWs: ws,
        });
        log.info('public-tunnel', 'node-owner-relay-open', {
          tunnel_id: tunnelId,
          node_id: tunnel.nodeId,
          owner_stream_id: tunnel.ownerRelay.streamId,
        });
      } catch (error) {
        log.error('public-tunnel', 'node-owner-relay-open-failed', {
          tunnel_id: tunnelId,
          node_id: tunnel.nodeId,
          message: error instanceof Error ? error.message : String(error),
        });
        ws.close(1011, error instanceof Error ? error.message : String(error));
        return;
      }
    }

    ws.on('message', (data: Buffer) => {
      if (tunnel.ownerRelay) return;

      let frame: ReturnType<typeof decodeFrame>;
      try { frame = decodeFrame(data); } catch { return; }

      if (frame.type === FRAME.PING) {
        ws.send(encodeFrame(FRAME.PONG, 0));
        return;
      }

      const stream = tunnel.streams.get(frame.streamId);
      if (!stream) return;

      if (frame.type === FRAME.STREAM_DATA)  stream.onData(frame.payload);
      if (frame.type === FRAME.STREAM_END)   stream.onEnd();
      if (frame.type === FRAME.STREAM_RESET) stream.onReset();
    });

    ws.on('close', (code, reason) => {
      tunnel.ownerRelay?.close('owner disconnected');
      for (const streamId of tunnel.streams.keys()) {
        closeTunnelStream(tunnel, streamId, 'tunnel owner disconnected');
      }
      activeTunnels.delete(tunnelId);
      log.warn('public-tunnel', 'owner-disconnected', {
        tunnel_id: tunnelId,
        code,
        reason: reason.toString() || null,
        streams_closed: tunnel.streams.size,
      });
    });

    ws.on('error', (err: Error) => log.error('public-tunnel', 'owner-error', {
      tunnel_id: tunnelId,
      message: err.message,
    }));
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
