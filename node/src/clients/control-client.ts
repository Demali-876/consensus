import { loadOrCreateIdentity } from "../crypto/identity";
import { releaseManifest } from "../node/manifest";
import { loadConfig } from "../node/state";
import { capabilitiesRecord } from "../runtime/capabilities";
import { executeProxyCommand } from "../runtime/proxy-command";
import { executeProxySessionMessage } from "../runtime/proxy-session";
import { connectEncryptedTunnel } from "../tunnel/connect";
import { MESSAGE_TYPE, TUNNEL_MODE, createErrorMessage, nowSeconds } from "../tunnel/messages";

export interface ControlClientOptions {
  gatewayUrl: string;
  nodeId?: string;
  heartbeatIntervalMs?: number;
}

export async function startControlClient(options: ControlClientOptions) {
  const config = await loadConfig();
  const identity = await loadOrCreateIdentity();
  const nodeId = options.nodeId ?? config.node_id;
  if (!nodeId) {
    throw new Error("Missing node id. Register the node before starting control mode.");
  }

  const connected = await connectEncryptedTunnel({
    url: options.gatewayUrl,
    mode: TUNNEL_MODE.CONTROL,
    nodeId,
    identity,
    releaseVersion: releaseManifest().version,
  });

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const sendHeartbeat = async () => {
    await connected.client.send({
      type: MESSAGE_TYPE.HEARTBEAT,
      timestamp: nowSeconds(),
      node_id: nodeId,
      uptime_seconds: Math.floor(process.uptime()),
      capabilities: capabilitiesRecord(),
    });
  };

  await sendHeartbeat();
  let stopped = false;
  let resolveClosed!: (event: { code?: number; reason?: string; error: Error }) => void;
  const closed = new Promise<{ code?: number; reason?: string; error: Error }>((resolve) => {
    resolveClosed = resolve;
  });
  connected.client.onClose((event) => {
    clearInterval(timer);
    resolveClosed(event);
  });

  connected.client.onMessage(async (message, client) => {
    if (message.type === MESSAGE_TYPE.PROXY_REQUEST) {
      try {
        await client.send(await executeProxyCommand(message));
      } catch (error) {
        await client.send(createErrorMessage({
          reply_to: message.id,
          code: "proxy_failed",
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }

    if (message.type === MESSAGE_TYPE.STREAM_OPEN) {
      if (message.target !== "proxy-session") {
        await client.send(createErrorMessage({
          code: "unsupported_stream_target",
          message: `Unsupported stream target: ${message.target ?? ""}`,
        }));
      }
      return;
    }

    if (message.type === MESSAGE_TYPE.STREAM_DATA) {
      const output = await executeProxySessionMessage(Buffer.from(message.data, "base64"));
      await client.send({
        type: MESSAGE_TYPE.STREAM_DATA,
        timestamp: nowSeconds(),
        stream_id: message.stream_id,
        data: output.toString("base64"),
        encoding: "base64",
      });
    }
  });

  const timer = setInterval(() => {
    void sendHeartbeat().catch((error) => {
      console.error("Control heartbeat failed:", error);
      if (!stopped) connected.client.close(1011, "heartbeat failed");
    });
  }, heartbeatIntervalMs);

  return {
    ...connected,
    nodeId,
    closed,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      connected.client.close(1000, "control stopped");
    },
  };
}
