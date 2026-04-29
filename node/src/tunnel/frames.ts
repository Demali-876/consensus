export const FRAME_VERSION = 0x01;

export const FRAME_TYPE = {
  HANDSHAKE: 0x01,
  DATA:      0x10,
  PING:      0x20,
  PONG:      0x21,
  CLOSE:     0x30,
  ERROR:     0x31,
} as const;

export type FrameType = typeof FRAME_TYPE[keyof typeof FRAME_TYPE];

export interface FrameParts {
  version: typeof FRAME_VERSION;
  type: FrameType;
  sequence: bigint;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

const HEADER_SIZE = 26;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;
const MAX_U64 = (1n << 64n) - 1n;
const VALID_TYPES = new Set<number>(Object.values(FRAME_TYPE));

export function encodeFrame(parts: FrameParts): Buffer {
  validateParts(parts);

  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt8(parts.version, 0);
  header.writeUInt8(parts.type, 1);
  header.writeBigUInt64BE(parts.sequence, 2);
  parts.nonce.copy(header, 10);
  header.writeUInt32BE(parts.ciphertext.length, 22);

  return Buffer.concat([header, parts.ciphertext, parts.tag]);
}

export function decodeFrame(raw: Buffer): FrameParts {
  if (raw.length < HEADER_SIZE + TAG_SIZE) {
    throw new RangeError(`Frame too short: ${raw.length} bytes`);
  }

  const version = raw.readUInt8(0);
  if (version !== FRAME_VERSION) {
    throw new RangeError(`Unsupported frame version: ${version}`);
  }

  const type = raw.readUInt8(1);
  if (!VALID_TYPES.has(type)) {
    throw new RangeError(`Unknown frame type: 0x${type.toString(16).padStart(2, "0")}`);
  }

  const sequence = raw.readBigUInt64BE(2);
  const nonce = raw.subarray(10, 22);
  const ciphertextLength = raw.readUInt32BE(22);
  const expectedLength = HEADER_SIZE + ciphertextLength + TAG_SIZE;
  if (raw.length !== expectedLength) {
    throw new RangeError(`Invalid frame length: expected ${expectedLength}, got ${raw.length}`);
  }

  const ciphertextStart = HEADER_SIZE;
  const ciphertextEnd = ciphertextStart + ciphertextLength;
  const ciphertext = raw.subarray(ciphertextStart, ciphertextEnd);
  const tag = raw.subarray(ciphertextEnd, ciphertextEnd + TAG_SIZE);

  return {
    version: FRAME_VERSION,
    type: type as FrameType,
    sequence,
    nonce,
    ciphertext,
    tag,
  };
}

export function frameAad(parts: Pick<FrameParts, "version" | "type" | "sequence"> & {
  ciphertextLength: number;
}): Buffer {
  if (parts.sequence < 0n || parts.sequence > MAX_U64) {
    throw new RangeError("Frame sequence must fit in u64");
  }
  if (!VALID_TYPES.has(parts.type)) {
    throw new RangeError(`Unknown frame type: 0x${parts.type.toString(16).padStart(2, "0")}`);
  }
  if (!Number.isInteger(parts.ciphertextLength) || parts.ciphertextLength < 0 || parts.ciphertextLength > 0xffffffff) {
    throw new RangeError("Ciphertext length must fit in u32");
  }

  const aad = Buffer.allocUnsafe(14);
  aad.writeUInt8(parts.version, 0);
  aad.writeUInt8(parts.type, 1);
  aad.writeBigUInt64BE(parts.sequence, 2);
  aad.writeUInt32BE(parts.ciphertextLength, 10);
  return aad;
}

function validateParts(parts: FrameParts): void {
  if (parts.version !== FRAME_VERSION) {
    throw new RangeError(`Unsupported frame version: ${parts.version}`);
  }
  if (!VALID_TYPES.has(parts.type)) {
    throw new RangeError(`Unknown frame type: 0x${parts.type.toString(16).padStart(2, "0")}`);
  }
  if (parts.sequence < 0n || parts.sequence > MAX_U64) {
    throw new RangeError("Frame sequence must fit in u64");
  }
  if (parts.nonce.length !== NONCE_SIZE) {
    throw new RangeError(`Frame nonce must be ${NONCE_SIZE} bytes`);
  }
  if (parts.tag.length !== TAG_SIZE) {
    throw new RangeError(`Frame auth tag must be ${TAG_SIZE} bytes`);
  }
  if (parts.ciphertext.length > 0xffffffff) {
    throw new RangeError("Frame ciphertext too large");
  }
}
