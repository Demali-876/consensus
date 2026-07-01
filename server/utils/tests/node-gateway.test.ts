import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import {
  hostnameFromHostHeader,
  nodeGatewayConnectUrl,
  nodeIdFromGatewayHost,
  publicNodeDomain,
} from '../../features/node-gateway/domain.ts';
import { registerNodeGateway } from '../../features/node-gateway/gateway.ts';

const nodeId = 'b6fd9c16d9d9';
const nodeDomain = `${nodeId}.consensus.canister.software`;

let servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => resolve(raw.toString()));
    ws.once('error', reject);
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.on('error', () => undefined);
    ws.once('close', () => resolve());
  });
}

function expectUpgradeReject(ws: WebSocket, status: number): Promise<void> {
  return new Promise((resolve) => {
    ws.once('error', (error) => {
      assert.match(error.message, new RegExp(`Unexpected server response: ${status}`));
      resolve();
    });
  });
}

afterEach(async () => {
  const current = servers;
  servers = [];
  await Promise.all(current.map((server) => closeServer(server)));
});

describe('node gateway host routing', () => {
  it('builds and parses permanent node URLs', () => {
    assert.equal(publicNodeDomain(nodeId), nodeDomain);
    assert.equal(nodeGatewayConnectUrl(nodeId), `wss://${nodeDomain}/connect`);
    assert.equal(hostnameFromHostHeader(`${nodeDomain}:443`), nodeDomain);
    assert.equal(nodeIdFromGatewayHost(`${nodeDomain}:443`), nodeId);
    assert.equal(nodeIdFromGatewayHost(`${nodeDomain}.evil.test`), null);
    assert.equal(hostnameFromHostHeader(`user@${nodeDomain}`), null);
  });

  it('bridges /connect for a registered active node with a control tunnel', async () => {
    const server = http.createServer();
    const attached: string[] = [];
    registerNodeGateway(server, {
      nodeStore: {
        getNode: (id) => id === nodeId ? { id, status: 'active', domain: nodeDomain } : null,
      },
      nodeTunnel: {
        getNodeSession: () => ({ mode: 'control', ws: { readyState: WebSocket.OPEN } }),
        attachDataPlaneSession: (id, ws) => {
          attached.push(id);
          ws.on('message', (raw) => ws.send(`node:${raw.toString()}`));
          return { streamId: 'stream-1', close() {} };
        },
      },
    });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`, {
      headers: { host: nodeDomain },
    });

    await waitOpen(ws);
    ws.send('ping');
    assert.equal(await nextMessage(ws), 'node:ping');
    assert.deepEqual(attached, [nodeId]);

    ws.close();
    await waitClose(ws);
  });

  it('rejects /connect when the control tunnel is disconnected', async () => {
    const server = http.createServer();
    registerNodeGateway(server, {
      nodeStore: {
        getNode: (id) => id === nodeId ? { id, status: 'active', domain: nodeDomain } : null,
      },
      nodeTunnel: {
        getNodeSession: () => null,
        attachDataPlaneSession: () => {
          throw new Error('must not attach without control tunnel');
        },
      },
    });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`, {
      headers: { host: nodeDomain },
    });

    await expectUpgradeReject(ws, 503);
  });
});
