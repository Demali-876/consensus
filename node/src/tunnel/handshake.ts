import crypto from "node:crypto";
import { canonicalJson } from "../crypto/canonical-json";
import {
  deriveSecureSession,
  generateHandshakeKeyPair,
  randomHandshakeNonce,
  type HandshakeKeyPair,
  type SecureSession,
} from "../crypto/secure-channel";
import { signUtf8, verifyUtf8, type NodeIdentity } from "../crypto/identity";
import { TUNNEL_MODE, type TunnelMode, nowSeconds } from "./messages";

export const HANDSHAKE_PROTOCOL = "consensus-node-tunnel";
export const HANDSHAKE_VERSION = 1;

export const HANDSHAKE_TYPE = {
  INIT:   "handshake_init",
  ACCEPT: "handshake_accept",
  REJECT: "handshake_reject",
} as const;

export interface HandshakeInitMessage {
  type: typeof HANDSHAKE_TYPE.INIT;
  protocol: typeof HANDSHAKE_PROTOCOL;
  version: typeof HANDSHAKE_VERSION;
  mode: TunnelMode;
  timestamp: number;
  client_public_key: string;
  client_nonce: string;
  node_public_key_pem: string;
  node_id?: string;
  candidate_id?: string;
  release_version?: string;
  signature: string;
}

export interface HandshakeAcceptMessage {
  type: typeof HANDSHAKE_TYPE.ACCEPT;
  protocol: typeof HANDSHAKE_PROTOCOL;
  version: typeof HANDSHAKE_VERSION;
  timestamp: number;
  server_public_key: string;
  server_nonce: string;
  session_id: string;
  signature?: string;
}

export interface HandshakeRejectMessage {
  type: typeof HANDSHAKE_TYPE.REJECT;
  protocol: typeof HANDSHAKE_PROTOCOL;
  version: typeof HANDSHAKE_VERSION;
  timestamp: number;
  code: string;
  message: string;
}

export type HandshakeMessage =
  | HandshakeInitMessage
  | HandshakeAcceptMessage
  | HandshakeRejectMessage;

export interface ClientHandshake {
  keyPair: HandshakeKeyPair;
  clientNonce: Buffer;
  message: HandshakeInitMessage;
}

export interface ServerHandshake {
  keyPair: HandshakeKeyPair;
  serverNonce: Buffer;
  message: HandshakeAcceptMessage;
  session: SecureSession;
}

export async function createClientHandshake(input: {
  mode: TunnelMode;
  identity: NodeIdentity;
  nodeId?: string;
  candidateId?: string;
  releaseVersion?: string;
}): Promise<ClientHandshake> {
  if (!Object.values(TUNNEL_MODE).includes(input.mode)) {
    throw new RangeError(`Unsupported tunnel mode: ${input.mode}`);
  }

  const keyPair = await generateHandshakeKeyPair();
  const clientNonce = randomHandshakeNonce();
  const unsigned = omitUndefined({
    type: HANDSHAKE_TYPE.INIT,
    protocol: HANDSHAKE_PROTOCOL,
    version: HANDSHAKE_VERSION,
    mode: input.mode,
    timestamp: nowSeconds(),
    client_public_key: keyPair.publicKeyRaw.toString("base64"),
    client_nonce: clientNonce.toString("base64"),
    node_public_key_pem: input.identity.publicKeyPem,
    node_id: input.nodeId,
    candidate_id: input.candidateId,
    release_version: input.releaseVersion,
  } satisfies Omit<HandshakeInitMessage, "signature">);

  const signature = signUtf8(input.identity.privateKeyPem, handshakeSigningPayload(unsigned));
  return {
    keyPair,
    clientNonce,
    message: { ...unsigned, signature } satisfies HandshakeInitMessage,
  };
}

export function verifyClientHandshake(message: HandshakeInitMessage): boolean {
  assertHandshakeInit(message);
  return verifyUtf8(
    message.node_public_key_pem,
    handshakeSigningPayload(withoutSignature(message)),
    message.signature,
  );
}

export async function acceptClientHandshake(input: {
  init: HandshakeInitMessage;
  serverSigningKeyPem?: string;
}): Promise<ServerHandshake> {
  if (!verifyClientHandshake(input.init)) {
    throw new Error("Client handshake signature verification failed");
  }

  const keyPair = await generateHandshakeKeyPair();
  const serverNonce = randomHandshakeNonce();
  const session = await deriveSecureSession({
    role: "server",
    privateKey: keyPair.privateKey,
    peerPublicKeyRaw: decodeBase64(input.init.client_public_key, "client_public_key"),
    clientNonce: decodeBase64(input.init.client_nonce, "client_nonce"),
    serverNonce,
    transcriptHash: handshakeTranscriptHash(input.init),
  });

  const unsigned = {
    type: HANDSHAKE_TYPE.ACCEPT,
    protocol: HANDSHAKE_PROTOCOL,
    version: HANDSHAKE_VERSION,
    timestamp: nowSeconds(),
    server_public_key: keyPair.publicKeyRaw.toString("base64"),
    server_nonce: serverNonce.toString("base64"),
    session_id: session.sessionId,
  } satisfies Omit<HandshakeAcceptMessage, "signature">;

  const signature = input.serverSigningKeyPem
    ? signUtf8(input.serverSigningKeyPem, handshakeSigningPayload(unsigned))
    : undefined;

  return {
    keyPair,
    serverNonce,
    session,
    message: omitUndefined({ ...unsigned, signature }) as HandshakeAcceptMessage,
  };
}

export async function deriveClientSessionFromAccept(input: {
  client: ClientHandshake;
  accept: HandshakeAcceptMessage;
  serverPublicKeyPem?: string;
}): Promise<SecureSession> {
  assertHandshakeAccept(input.accept);
  if (input.serverPublicKeyPem && input.accept.signature) {
    const verified = verifyUtf8(
      input.serverPublicKeyPem,
      handshakeSigningPayload(withoutSignature(input.accept)),
      input.accept.signature,
    );
    if (!verified) throw new Error("Server handshake signature verification failed");
  }

  const session = await deriveSecureSession({
    role: "client",
    privateKey: input.client.keyPair.privateKey,
    peerPublicKeyRaw: decodeBase64(input.accept.server_public_key, "server_public_key"),
    clientNonce: input.client.clientNonce,
    serverNonce: decodeBase64(input.accept.server_nonce, "server_nonce"),
    transcriptHash: handshakeTranscriptHash(input.client.message),
  });

  if (session.sessionId !== input.accept.session_id) {
    throw new Error("Handshake session id mismatch");
  }

  return session;
}

export function encodeHandshakeMessage(message: HandshakeMessage): Buffer {
  return Buffer.from(JSON.stringify(message), "utf8");
}

export function decodeHandshakeMessage(payload: Buffer | string): HandshakeMessage {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
  const parsed = JSON.parse(text) as unknown;
  assertHandshakeMessage(parsed);
  return parsed;
}

export function createHandshakeReject(code: string, message: string): HandshakeRejectMessage {
  return {
    type: HANDSHAKE_TYPE.REJECT,
    protocol: HANDSHAKE_PROTOCOL,
    version: HANDSHAKE_VERSION,
    timestamp: nowSeconds(),
    code,
    message,
  };
}

export function handshakeTranscriptHash(init: HandshakeInitMessage): Buffer {
  assertHandshakeInit(init);
  return crypto.createHash("sha256")
    .update(handshakeSigningPayload(init))
    .digest();
}

function assertHandshakeMessage(value: unknown): asserts value is HandshakeMessage {
  if (!value || typeof value !== "object") {
    throw new TypeError("Handshake message must be an object");
  }

  const type = (value as Record<string, unknown>).type;
  if (type === HANDSHAKE_TYPE.INIT) {
    assertHandshakeInit(value);
    return;
  }
  if (type === HANDSHAKE_TYPE.ACCEPT) {
    assertHandshakeAccept(value);
    return;
  }
  if (type === HANDSHAKE_TYPE.REJECT) {
    assertHandshakeReject(value);
    return;
  }
  throw new TypeError(`Unknown handshake message type: ${String(type)}`);
}

function assertHandshakeInit(value: unknown): asserts value is HandshakeInitMessage {
  const message = assertHandshakeBase(value, HANDSHAKE_TYPE.INIT);
  assertTunnelMode(message.mode);
  assertString(message.client_public_key, "client_public_key");
  assertString(message.client_nonce, "client_nonce");
  assertString(message.node_public_key_pem, "node_public_key_pem");
  assertString(message.signature, "signature");
  decodeBase64(message.client_public_key, "client_public_key");
  decodeBase64(message.client_nonce, "client_nonce");
}

function assertHandshakeAccept(value: unknown): asserts value is HandshakeAcceptMessage {
  const message = assertHandshakeBase(value, HANDSHAKE_TYPE.ACCEPT);
  assertString(message.server_public_key, "server_public_key");
  assertString(message.server_nonce, "server_nonce");
  assertString(message.session_id, "session_id");
  decodeBase64(message.server_public_key, "server_public_key");
  decodeBase64(message.server_nonce, "server_nonce");
  if (message.signature !== undefined) assertString(message.signature, "signature");
}

function assertHandshakeReject(value: unknown): asserts value is HandshakeRejectMessage {
  const message = assertHandshakeBase(value, HANDSHAKE_TYPE.REJECT);
  assertString(message.code, "code");
  assertString(message.message, "message");
}

function assertHandshakeBase(value: unknown, type: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new TypeError("Handshake message must be an object");
  const message = value as Record<string, unknown>;
  if (message.type !== type) throw new TypeError(`Expected handshake type ${type}`);
  if (message.protocol !== HANDSHAKE_PROTOCOL) throw new TypeError(`Unsupported handshake protocol: ${String(message.protocol)}`);
  if (message.version !== HANDSHAKE_VERSION) throw new TypeError(`Unsupported handshake version: ${String(message.version)}`);
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
    throw new TypeError("Handshake timestamp must be a finite number");
  }
  return message;
}

function assertTunnelMode(value: unknown): asserts value is TunnelMode {
  if (typeof value !== "string" || !Object.values(TUNNEL_MODE).includes(value as TunnelMode)) {
    throw new TypeError(`Unsupported tunnel mode: ${String(value)}`);
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Handshake ${field} must be a non-empty string`);
  }
}

function decodeBase64(value: string, field: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) throw new TypeError(`Handshake ${field} is empty`);
  return decoded;
}

function handshakeSigningPayload(value: object): string {
  return canonicalJson(withoutSignature(value));
}

function withoutSignature<T extends object>(value: T): Omit<T, "signature"> {
  const { signature: _signature, ...rest } = value as T & { signature?: string };
  return rest;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output as T;
}
