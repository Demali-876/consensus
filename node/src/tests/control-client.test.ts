import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  acceptClientHandshake,
  decodeHandshakeMessage,
  encodeHandshakeMessage,
} from "../tunnel/handshake";
import { MESSAGE_TYPE, decodeMessage } from "../tunnel/messages";
import { openFrame, type SecureSession } from "../crypto/secure-channel";
import { saveConfig } from "../node/state";
import { startControlClient } from "../clients/control-client";

const nodeId = "node-control-test";
process.env.CONSENSUS_STATE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "consensus-control-test-"));
await saveConfig({ node_id: nodeId, port: 9090 });

const state: { serverSession?: SecureSession; heartbeatSeen?: boolean } = {};
let heartbeatSeenResolve: (() => void) | null = null;
const heartbeatSeen = new Promise<void>((resolve) => {
  heartbeatSeenResolve = resolve;
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: await getFreePort(),
  fetch(request, server) {
    if (server.upgrade(request)) return undefined;
    return new Response("websocket required", { status: 426 });
  },
  websocket: {
    async message(ws, data) {
      const raw = await toBuffer(data);
      if (!state.serverSession) {
        const init = decodeHandshakeMessage(raw);
        assert.equal(init.type, "handshake_init");
        assert.equal(init.mode, "control");
        assert.equal(init.node_id, nodeId);
        const accepted = await acceptClientHandshake({ init });
        state.serverSession = accepted.session;
        ws.send(encodeHandshakeMessage(accepted.message));
        return;
      }

      const opened = openFrame(state.serverSession.receiveKey, raw);
      const message = decodeMessage(opened.plaintext);
      if (message.type === MESSAGE_TYPE.HEARTBEAT) {
        assert.equal(message.node_id, nodeId);
        state.heartbeatSeen = true;
        heartbeatSeenResolve?.();
      }
    },
  },
});

const connected = await startControlClient({
  gatewayUrl: `ws://127.0.0.1:${server.port}`,
  heartbeatIntervalMs: 60_000,
});

await heartbeatSeen;
assert.equal(connected.nodeId, nodeId);
assert.equal(state.heartbeatSeen, true);

connected.stop();
const closed = await connected.closed;
assert.equal(closed.code, 1000);
server.stop(true);

console.log("control-client ok");

async function toBuffer(data: string | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data, "utf8");
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("Failed to allocate free port"));
      });
    });
  });
}
