import crypto from "node:crypto";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { decodeFrame, encodeFrame, frameAad, FRAME_VERSION, type FrameParts, type FrameType } from "../tunnel/frames";

export type TunnelRole = "client" | "server";

export interface HandshakeKeyPair {
  privateKey: CryptoKey;
  publicKeyRaw: Buffer;
}

export interface SecureSession {
  sessionId: string;
  sendKey: Buffer;
  receiveKey: Buffer;
}

export interface EncryptedFrame {
  version: 1;
  type: number;
  sequence: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const CHANNEL_INFO = "consensus-node-tunnel-v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function encryptFrame(key: Buffer, type: number, sequence: number, plaintext: Buffer, aad: Buffer): EncryptedFrame {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const sealed = encryptDetached(key, nonce, plaintext, aad);
  return {
    version: 1,
    type,
    sequence,
    nonce: nonce.toString("base64"),
    ciphertext: sealed.ciphertext.toString("base64"),
    tag: sealed.tag.toString("base64")
  };
}

export function decryptFrame(key: Buffer, frame: EncryptedFrame, aad: Buffer): Buffer {
  return decryptDetached(
    key,
    Buffer.from(frame.nonce, "base64"),
    Buffer.from(frame.ciphertext, "base64"),
    Buffer.from(frame.tag, "base64"),
    aad,
  );
}

export function sealFrame(key: Buffer, type: FrameType, sequence: bigint, plaintext: Buffer): Buffer {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const ciphertextLength = plaintext.length;
  const aad = frameAad({ version: FRAME_VERSION, type, sequence, ciphertextLength });
  const sealed = encryptDetached(key, nonce, plaintext, aad);

  return encodeFrame({
    version: FRAME_VERSION,
    type,
    sequence,
    nonce,
    ciphertext: sealed.ciphertext,
    tag: sealed.tag,
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
  const plaintext = decryptDetached(key, frame.nonce, frame.ciphertext, frame.tag, aad);
  return { frame, plaintext };
}

export async function generateHandshakeKeyPair(): Promise<HandshakeKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey));
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
  if (input.clientNonce.length < 16) throw new RangeError("clientNonce must be at least 16 bytes");
  if (input.serverNonce.length < 16) throw new RangeError("serverNonce must be at least 16 bytes");

  const peerPublicKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(input.peerPublicKeyRaw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    input.privateKey,
    256,
  );

  const sharedSecret = Buffer.from(sharedBits);
  const salt = crypto.createHash("sha256")
    .update(input.clientNonce)
    .update(input.serverNonce)
    .update(input.transcriptHash ?? Buffer.alloc(0))
    .digest();

  const clientToServer = hkdf(sharedSecret, salt, `${CHANNEL_INFO}:client-to-server`, KEY_BYTES);
  const serverToClient = hkdf(sharedSecret, salt, `${CHANNEL_INFO}:server-to-client`, KEY_BYTES);
  const sessionId = hkdf(sharedSecret, salt, `${CHANNEL_INFO}:session-id`, 16).toString("hex");

  return input.role === "client"
    ? { sessionId, sendKey: clientToServer, receiveKey: serverToClient }
    : { sessionId, sendKey: serverToClient, receiveKey: clientToServer };
}

export function randomHandshakeNonce(): Buffer {
  return crypto.randomBytes(32);
}

function hkdf(secret: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, Buffer.from(info, "utf8"), length));
}

function encryptDetached(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): { ciphertext: Buffer; tag: Buffer } {
  if (key.length !== KEY_BYTES) throw new RangeError(`ChaCha20-Poly1305 key must be ${KEY_BYTES} bytes`);
  if (nonce.length !== NONCE_BYTES) throw new RangeError(`ChaCha20-Poly1305 nonce must be ${NONCE_BYTES} bytes`);

  const cipher = chacha20poly1305(key, nonce, aad);
  const sealed = Buffer.from(cipher.encrypt(plaintext));
  if (sealed.length < TAG_BYTES) throw new Error("ChaCha20-Poly1305 output is shorter than the authentication tag");
  return {
    ciphertext: sealed.subarray(0, sealed.length - TAG_BYTES),
    tag: sealed.subarray(sealed.length - TAG_BYTES),
  };
}

function decryptDetached(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer, aad: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new RangeError(`ChaCha20-Poly1305 key must be ${KEY_BYTES} bytes`);
  if (nonce.length !== NONCE_BYTES) throw new RangeError(`ChaCha20-Poly1305 nonce must be ${NONCE_BYTES} bytes`);
  if (tag.length !== TAG_BYTES) throw new RangeError(`ChaCha20-Poly1305 tag must be ${TAG_BYTES} bytes`);

  const cipher = chacha20poly1305(key, nonce, aad);
  return Buffer.from(cipher.decrypt(Buffer.concat([ciphertext, tag])));
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
