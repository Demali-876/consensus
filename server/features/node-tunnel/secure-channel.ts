import crypto from 'crypto';
import { decodeFrame, encodeFrame, frameAad, FRAME_VERSION, type FrameParts, type FrameType } from './frames.ts';

export type TunnelRole = 'client' | 'server';

export interface HandshakeKeyPair {
  privateKey: CryptoKey;
  publicKeyRaw: Buffer;
}

export interface SecureSession {
  sessionId: string;
  sendKey: Buffer;
  receiveKey: Buffer;
}

const CHANNEL_INFO = 'consensus-node-tunnel-v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function sealFrame(key: Buffer, type: FrameType, sequence: bigint, plaintext: Buffer): Buffer {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const aad = frameAad({ version: FRAME_VERSION, type, sequence, ciphertextLength: plaintext.length });
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return encodeFrame({
    version: FRAME_VERSION,
    type,
    sequence,
    nonce,
    ciphertext,
    tag: cipher.getAuthTag(),
  });
}

export function openFrame(key: Buffer, raw: Buffer): { frame: FrameParts; plaintext: Buffer } {
  const frame = decodeFrame(raw);
  const aad = frameAad({
    version: frame.version,
    type: frame.type,
    sequence: frame.sequence,
    ciphertextLength: frame.ciphertext.length,
  });

  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, frame.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad, { plaintextLength: frame.ciphertext.length });
  decipher.setAuthTag(frame.tag);
  const plaintext = Buffer.concat([decipher.update(frame.ciphertext), decipher.final()]);
  return { frame, plaintext };
}

export async function generateHandshakeKeyPair(): Promise<HandshakeKeyPair> {
  const keyPair = await crypto.webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKeyRaw = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  return { privateKey: keyPair.privateKey, publicKeyRaw };
}

export async function deriveSecureSession(input: {
  role: TunnelRole;
  privateKey: CryptoKey;
  peerPublicKeyRaw: Buffer;
  clientNonce: Buffer;
  serverNonce: Buffer;
  transcriptHash?: Buffer;
}): Promise<SecureSession> {
  if (input.clientNonce.length < 16) throw new RangeError('clientNonce must be at least 16 bytes');
  if (input.serverNonce.length < 16) throw new RangeError('serverNonce must be at least 16 bytes');

  const peerPublicKey = await crypto.webcrypto.subtle.importKey(
    'raw',
    toArrayBuffer(input.peerPublicKeyRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedBits = await crypto.webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    input.privateKey,
    256,
  );

  const sharedSecret = Buffer.from(sharedBits);
  const salt = crypto.createHash('sha256')
    .update(input.clientNonce)
    .update(input.serverNonce)
    .update(input.transcriptHash ?? Buffer.alloc(0))
    .digest();

  const clientToServer = hkdf(sharedSecret, salt, `${CHANNEL_INFO}:client-to-server`, KEY_BYTES);
  const serverToClient = hkdf(sharedSecret, salt, `${CHANNEL_INFO}:server-to-client`, KEY_BYTES);
  const sessionId = hkdf(sharedSecret, salt, `${CHANNEL_INFO}:session-id`, 16).toString('hex');

  return input.role === 'client'
    ? { sessionId, sendKey: clientToServer, receiveKey: serverToClient }
    : { sessionId, sendKey: serverToClient, receiveKey: clientToServer };
}

export function randomHandshakeNonce(): Buffer {
  return crypto.randomBytes(32);
}

function hkdf(secret: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(info, 'utf8'), length));
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
