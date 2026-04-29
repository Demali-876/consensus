import { loadOrCreateIdentity, type NodeIdentity } from "../crypto/identity";
import {
  HANDSHAKE_TYPE,
  createClientHandshake,
  decodeHandshakeMessage,
  deriveClientSessionFromAccept,
  encodeHandshakeMessage,
  type HandshakeAcceptMessage,
} from "./handshake";
import { TUNNEL_MODE, type TunnelMode } from "./messages";
import { TunnelClient } from "./tunnel-client";

export interface ConnectEncryptedTunnelOptions {
  url: string;
  mode: TunnelMode;
  identity?: NodeIdentity;
  nodeId?: string;
  candidateId?: string;
  releaseVersion?: string;
  serverPublicKeyPem?: string;
  requestTimeoutMs?: number;
}

export interface ConnectedEncryptedTunnel {
  client: TunnelClient;
  sessionId: string;
  socket: WebSocket;
}

export async function connectEncryptedTunnel(options: ConnectEncryptedTunnelOptions): Promise<ConnectedEncryptedTunnel> {
  if (!Object.values(TUNNEL_MODE).includes(options.mode)) {
    throw new RangeError(`Unsupported tunnel mode: ${options.mode}`);
  }

  const identity = options.identity ?? await loadOrCreateIdentity();
  const handshake = await createClientHandshake({
    mode: options.mode,
    identity,
    nodeId: options.nodeId,
    candidateId: options.candidateId,
    releaseVersion: options.releaseVersion,
  });

  const socket = await openSocket(options.url);
  const acceptMessage = await exchangeHandshake(socket, encodeHandshakeMessage(handshake.message));
  const session = await deriveClientSessionFromAccept({
    client: handshake,
    accept: acceptMessage,
    serverPublicKeyPem: options.serverPublicKeyPem,
  });

  const client = new TunnelClient({
    url: options.url,
    socket,
    session,
    mode: options.mode,
    nodeId: options.nodeId,
    candidateId: options.candidateId,
    version: options.releaseVersion,
    publicKeyPem: identity.publicKeyPem,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  await client.connect();

  return {
    client,
    sessionId: session.sessionId,
    socket,
  };
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  if (socket.readyState === WebSocket.OPEN) return socket;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Tunnel connection failed: ${url}`));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });

  return socket;
}

async function exchangeHandshake(socket: WebSocket, payload: Buffer) {
  const response = new Promise<HandshakeAcceptMessage>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      void decodeAccept(event.data)
        .then((message) => {
          cleanup();
          resolve(message);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Tunnel closed during handshake"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Tunnel errored during handshake"));
    };
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });

  socket.send(payload);
  return response;
}

async function decodeAccept(data: unknown) {
  const message = decodeHandshakeMessage(await toBuffer(data));
  if (message.type === HANDSHAKE_TYPE.REJECT) {
    throw new Error(`Tunnel handshake rejected: ${message.code}: ${message.message}`);
  }
  if (message.type !== HANDSHAKE_TYPE.ACCEPT) {
    throw new Error(`Unexpected tunnel handshake response: ${message.type}`);
  }
  return message;
}

async function toBuffer(data: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (typeof data === "string") return Buffer.from(data, "utf8");
  throw new TypeError(`Unsupported WebSocket message payload: ${typeof data}`);
}
