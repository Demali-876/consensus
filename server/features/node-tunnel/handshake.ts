import crypto from 'crypto';
import { TUNNEL_MODE, type TunnelMode, nowSeconds } from './messages.ts';
import {
  deriveSecureSession,
  generateHandshakeKeyPair,
  randomHandshakeNonce,
  type HandshakeKeyPair,
  type SecureSession,
} from './secure-channel.ts';

export const HANDSHAKE_PROTOCOL = 'consensus-node-tunnel';
export const HANDSHAKE_VERSION = 1;

export const HANDSHAKE_TYPE = {
  INIT:   'handshake_init',
  ACCEPT: 'handshake_accept',
  REJECT: 'handshake_reject',
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
}

export interface HandshakeRejectMessage {
  type: typeof HANDSHAKE_TYPE.REJECT;
  protocol: typeof HANDSHAKE_PROTOCOL;
  version: typeof HANDSHAKE_VERSION;
  timestamp: number;
  code: string;
  message: string;
}

export type HandshakeMessage = HandshakeInitMessage | HandshakeAcceptMessage | HandshakeRejectMessage;

export interface AcceptedHandshake {
  keyPair: HandshakeKeyPair;
  serverNonce: Buffer;
  message: HandshakeAcceptMessage;
  session: SecureSession;
}

export async function acceptClientHandshake(init: HandshakeInitMessage): Promise<AcceptedHandshake> {
  if (!verifyClientHandshake(init)) throw new Error('Client handshake signature verification failed');

  const keyPair = await generateHandshakeKeyPair();
  const serverNonce = randomHandshakeNonce();
  const session = await deriveSecureSession({
    role: 'server',
    privateKey: keyPair.privateKey,
    peerPublicKeyRaw: decodeBase64(init.client_public_key, 'client_public_key'),
    clientNonce: decodeBase64(init.client_nonce, 'client_nonce'),
    serverNonce,
    transcriptHash: handshakeTranscriptHash(init),
  });

  return {
    keyPair,
    serverNonce,
    session,
    message: {
      type: HANDSHAKE_TYPE.ACCEPT,
      protocol: HANDSHAKE_PROTOCOL,
      version: HANDSHAKE_VERSION,
      timestamp: nowSeconds(),
      server_public_key: keyPair.publicKeyRaw.toString('base64'),
      server_nonce: serverNonce.toString('base64'),
      session_id: session.sessionId,
    },
  };
}

export function verifyClientHandshake(message: HandshakeInitMessage): boolean {
  assertHandshakeInit(message);
  return crypto.verify(
    null,
    Buffer.from(handshakeSigningPayload(message), 'utf8'),
    message.node_public_key_pem,
    Buffer.from(message.signature, 'base64'),
  );
}

export function encodeHandshakeMessage(message: HandshakeMessage): Buffer {
  return Buffer.from(JSON.stringify(message), 'utf8');
}

export function decodeHandshakeMessage(payload: Buffer): HandshakeMessage {
  const parsed = JSON.parse(payload.toString('utf8')) as unknown;
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

function handshakeTranscriptHash(init: HandshakeInitMessage): Buffer {
  assertHandshakeInit(init);
  return crypto.createHash('sha256')
    .update(handshakeSigningPayload(init))
    .digest();
}

function assertHandshakeMessage(value: unknown): asserts value is HandshakeMessage {
  if (!value || typeof value !== 'object') throw new TypeError('Handshake message must be an object');

  const type = (value as Record<string, unknown>).type;
  if (type === HANDSHAKE_TYPE.INIT) return assertHandshakeInit(value);
  if (type === HANDSHAKE_TYPE.ACCEPT) return assertHandshakeAccept(value);
  if (type === HANDSHAKE_TYPE.REJECT) return assertHandshakeReject(value);
  throw new TypeError(`Unknown handshake message type: ${String(type)}`);
}

function assertHandshakeInit(value: unknown): asserts value is HandshakeInitMessage {
  const message = assertHandshakeBase(value, HANDSHAKE_TYPE.INIT);
  assertTunnelMode(message.mode);
  assertString(message.client_public_key, 'client_public_key');
  assertString(message.client_nonce, 'client_nonce');
  assertString(message.node_public_key_pem, 'node_public_key_pem');
  assertString(message.signature, 'signature');
  decodeBase64(message.client_public_key, 'client_public_key');
  decodeBase64(message.client_nonce, 'client_nonce');
}

function assertHandshakeAccept(value: unknown): asserts value is HandshakeAcceptMessage {
  const message = assertHandshakeBase(value, HANDSHAKE_TYPE.ACCEPT);
  assertString(message.server_public_key, 'server_public_key');
  assertString(message.server_nonce, 'server_nonce');
  assertString(message.session_id, 'session_id');
}

function assertHandshakeReject(value: unknown): asserts value is HandshakeRejectMessage {
  const message = assertHandshakeBase(value, HANDSHAKE_TYPE.REJECT);
  assertString(message.code, 'code');
  assertString(message.message, 'message');
}

function assertHandshakeBase(value: unknown, type: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new TypeError('Handshake message must be an object');
  const message = value as Record<string, unknown>;
  if (message.type !== type) throw new TypeError(`Expected handshake type ${type}`);
  if (message.protocol !== HANDSHAKE_PROTOCOL) throw new TypeError(`Unsupported handshake protocol: ${String(message.protocol)}`);
  if (message.version !== HANDSHAKE_VERSION) throw new TypeError(`Unsupported handshake version: ${String(message.version)}`);
  if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
    throw new TypeError('Handshake timestamp must be a finite number');
  }
  return message;
}

function assertTunnelMode(value: unknown): asserts value is TunnelMode {
  if (typeof value !== 'string' || !Object.values(TUNNEL_MODE).includes(value as TunnelMode)) {
    throw new TypeError(`Unsupported tunnel mode: ${String(value)}`);
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Handshake ${field} must be a non-empty string`);
  }
}

function decodeBase64(value: string, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) throw new TypeError(`Handshake ${field} is empty`);
  return decoded;
}

function handshakeSigningPayload(value: HandshakeInitMessage): string {
  const { signature: _signature, ...rest } = value;
  return canonicalJson(rest);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) output[key] = sortValue(input[key]);
  return output;
}
