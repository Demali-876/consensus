import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { log } from '../../utils/log.ts';
import {
  CONSENSUS_DOMAIN,
  canonicalDomain,
  hostnameFromHostHeader,
  nodeIdFromGatewayHost,
  publicNodeDomain,
} from './domain.ts';

interface NodeRecord {
  id: string;
  status?: string;
  domain?: string | null;
}

interface NodeStoreLike {
  getNode(nodeId: string): NodeRecord | null;
}

interface NodeTunnelGateway {
  attachDataPlaneSession(nodeId: string, clientWs: WebSocket): { streamId: string; close: (reason?: string) => void };
  getNodeSession?(nodeId: string): { mode?: string; ws?: { readyState?: number } } | null;
}

function writeUpgradeError(socket: { write(data: string): void; destroy(): void }, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function hasConnectedControlSession(nodeTunnel: NodeTunnelGateway, nodeId: string): boolean {
  const session = nodeTunnel.getNodeSession?.(nodeId);
  return session?.mode === 'control' && session.ws?.readyState === WebSocket.OPEN;
}

function nodeMatchesHost(node: NodeRecord, host: string): boolean {
  const expected = node.domain ? canonicalDomain(node.domain) : publicNodeDomain(node.id);
  return expected === host;
}

export function registerNodeGateway(
  server: Server,
  options: {
    nodeStore: NodeStoreLike;
    nodeTunnel: NodeTunnelGateway;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  let activeConnections = 0;

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://node-gateway.local');
    if (url.pathname !== '/connect') return;

    const host = hostnameFromHostHeader(req.headers.host);
    const nodeId = nodeIdFromGatewayHost(req.headers.host);
    if (!host || !nodeId) {
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }

    const node = options.nodeStore.getNode(nodeId);
    if (!node || node.status !== 'active' || !nodeMatchesHost(node, host)) {
      log.warn('node-gateway', 'connect-rejected', {
        host,
        node_id: nodeId,
        reason: node ? 'node host mismatch or inactive' : 'node not found',
      });
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }

    if (!hasConnectedControlSession(options.nodeTunnel, nodeId)) {
      log.warn('node-gateway', 'connect-rejected', {
        host,
        node_id: nodeId,
        reason: 'control tunnel not connected',
      });
      writeUpgradeError(socket, 503, 'Service Unavailable');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as WebSocket & { nodeId?: string }).nodeId = nodeId;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const nodeId = (ws as WebSocket & { nodeId?: string }).nodeId;
    if (!nodeId) {
      ws.close(1011, 'missing node id');
      return;
    }

    let stream: { streamId: string; close: (reason?: string) => void } | null = null;
    activeConnections++;

    try {
      stream = options.nodeTunnel.attachDataPlaneSession(nodeId, ws);
      log.info('node-gateway', 'data-plane-connected', {
        node_id: nodeId,
        stream_id: stream.streamId,
        active_connections: activeConnections,
      });
    } catch (error) {
      activeConnections = Math.max(0, activeConnections - 1);
      log.error('node-gateway', 'data-plane-open-failed', {
        node_id: nodeId,
        message: error instanceof Error ? error.message : String(error),
      });
      ws.close(1011, error instanceof Error ? error.message : String(error));
      return;
    }

    const release = (reason: string) => {
      if (!stream) return;
      const current = stream;
      stream = null;
      activeConnections = Math.max(0, activeConnections - 1);
      current.close(reason);
      log.info('node-gateway', 'data-plane-disconnected', {
        node_id: nodeId,
        stream_id: current.streamId,
        active_connections: activeConnections,
        reason,
      });
    };

    ws.on('close', () => release('client websocket closed'));
    ws.on('error', () => release('client websocket error'));
  });

  return {
    getStats: () => ({
      domain: CONSENSUS_DOMAIN,
      active_connections: activeConnections,
    }),
  };
}
