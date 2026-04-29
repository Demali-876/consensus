import { loadOrCreateIdentity, signBytes } from "../crypto/identity";
import { releaseManifest } from "../node/manifest";
import { saveJoinAuthorization } from "../node/state";
import { runEvalAction } from "../runtime/eval";
import { connectEncryptedTunnel } from "../tunnel/connect";
import { MESSAGE_TYPE, TUNNEL_MODE, nowSeconds, type EvalRequestMessage, type JoinReadyMessage } from "../tunnel/messages";
import type { TunnelClient } from "../tunnel/tunnel-client";

export interface EvalClientOptions {
  gatewayUrl: string;
  candidateId?: string;
  requestTimeoutMs?: number;
}

export async function startEvalClient(options: EvalClientOptions) {
  const connected = await connectEncryptedTunnel({
    url: options.gatewayUrl,
    mode: TUNNEL_MODE.EVAL,
    candidateId: options.candidateId,
    releaseVersion: releaseManifest().version,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  connected.client.onMessage(async (message, client) => {
    if (message.type === MESSAGE_TYPE.EVAL_REQUEST) {
      await handleEvalRequest(message, client);
      return;
    }
    if (message.type === MESSAGE_TYPE.JOIN_READY) {
      await handleJoinReady(message);
    }
  });

  return connected;
}

async function handleJoinReady(message: JoinReadyMessage): Promise<void> {
  const identity = await loadOrCreateIdentity();
  const nonce = decodeBase64Url(message.nonce);
  const signature = signBytes(identity.privateKeyPem, nonce);

  await saveJoinAuthorization({
    join_id: message.join_id,
    alg: message.alg,
    nonce: message.nonce,
    signature,
    expires_at: message.expires_at,
    saved_at: new Date().toISOString(),
  });
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return Buffer.from(padded, "base64");
}

async function handleEvalRequest(message: EvalRequestMessage, client: TunnelClient): Promise<void> {
  try {
    const result = await runEvalAction(message.action, message.params ?? {});
    await client.send({
      type: MESSAGE_TYPE.EVAL_RESPONSE,
      timestamp: nowSeconds(),
      reply_to: message.id ?? "",
      action: message.action,
      ok: true,
      result,
    });
  } catch (error) {
    await client.send({
      type: MESSAGE_TYPE.EVAL_RESPONSE,
      timestamp: nowSeconds(),
      reply_to: message.id ?? "",
      action: message.action,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
