// PASETO v4.public — minimal, dependency-free implementation (Ed25519).
//
// This is the wire format for Consensus routing tickets. It is deliberately
// implemented from the spec (not a library) so the orchestrator (Node) and the
// node runtime (Bun) can carry byte-identical copies and interoperate without a
// shared package or a runtime-compat gamble. Only the v4.public purpose is
// supported: a signed (not encrypted) token whose claims are public-readable.
//
// Token layout:  v4.public.<base64url(message || sig)>[.<base64url(footer)>]
// Signature:     Ed25519_sign(sk, PAE([header, message, footer, implicit]))
//
// Spec: https://github.com/paseto-standard/paseto-spec (PASETO v4, "public").

import crypto, { type KeyObject } from 'node:crypto';

const HEADER = 'v4.public.';
const HEADER_BYTES = Buffer.from(HEADER, 'utf8');
const SIG_LEN = 64; // Ed25519 signature length

// PASETO "PAE" (pre-authentication encoding). LE64 is an unsigned 64-bit
// little-endian length with the high bit cleared (per spec). Using modulo
// arithmetic rather than bitwise ops keeps it correct for lengths > 2^31.
function le64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  let value = n;
  for (let i = 0; i < 8; i++) {
    buf[i] = value % 256;
    value = Math.floor(value / 256);
  }
  buf[7] &= 0x7f;
  return buf;
}

function pae(pieces: Buffer[]): Buffer {
  const out: Buffer[] = [le64(pieces.length)];
  for (const piece of pieces) {
    out.push(le64(piece.length), piece);
  }
  return Buffer.concat(out);
}

function toBuf(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

/** Sign `message` into a `v4.public` token. `footer` and `implicit` are bound
 *  into the signature but only `footer` is carried in the token. */
export function signV4Public(
  message: Buffer | string,
  secretKey: KeyObject,
  footer: Buffer | string = Buffer.alloc(0),
  implicit: Buffer | string = Buffer.alloc(0),
): string {
  const m = toBuf(message);
  const f = toBuf(footer);
  const i = toBuf(implicit);
  const sig = crypto.sign(null, pae([HEADER_BYTES, m, f, i]), secretKey);
  const token = HEADER + Buffer.concat([m, sig]).toString('base64url');
  return f.length ? `${token}.${f.toString('base64url')}` : token;
}

export interface VerifiedToken {
  message: Buffer;
  footer: Buffer;
}

/** Verify a `v4.public` token. Throws on any failure; returns the message and
 *  footer bytes on success. `implicit` must match what was signed. */
export function verifyV4Public(
  token: string,
  publicKey: KeyObject,
  implicit: Buffer | string = Buffer.alloc(0),
): VerifiedToken {
  if (!token.startsWith(HEADER)) throw new Error('paseto: unsupported header');
  const parts = token.split('.');
  if (parts.length !== 3 && parts.length !== 4) throw new Error('paseto: malformed token');

  const body = Buffer.from(parts[2], 'base64url');
  if (body.length < SIG_LEN) throw new Error('paseto: token too short');
  const m = body.subarray(0, body.length - SIG_LEN);
  const sig = body.subarray(body.length - SIG_LEN);
  const f = parts.length === 4 ? Buffer.from(parts[3], 'base64url') : Buffer.alloc(0);

  if (!crypto.verify(null, pae([HEADER_BYTES, m, f, toBuf(implicit)]), publicKey, sig)) {
    throw new Error('paseto: bad signature');
  }
  return { message: m, footer: f };
}
