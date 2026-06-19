// Orchestrator signing identity. Loads the Ed25519 key the orchestrator uses to
// sign routing tickets, and derives the public JWK + a stable `kid`.
//
// Secret format: ORCHESTRATOR_SIGNING_SK = base64(PKCS8 DER) — single line, set
// in server/.env on the Pi (see `npm run gen:orchestrator-key`). The loader is
// lazy and cached: nothing reads the key at boot, so a missing/unset value
// cannot crash the running server until a code path actually needs to sign.

import crypto, { type KeyObject } from 'node:crypto';

export const ORCHESTRATOR_SK_ENV = 'ORCHESTRATOR_SIGNING_SK';

export interface OrchestratorKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
}

/** RFC 7638 JWK thumbprint of an OKP (Ed25519) public key — members in
 *  lexicographic order, no whitespace, SHA-256, base64url. Used as the `kid`. */
export function jwkThumbprint(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string };
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/** Public JWK for publishing at /orchestrator/pubkey. Never includes `d`. */
export function publicJwk(publicKey: KeyObject, kid: string): Record<string, string> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { ...jwk, use: 'sig', alg: 'EdDSA', kid };
}

/** Parse a base64 PKCS8 DER Ed25519 secret into the orchestrator key triple. */
export function parseOrchestratorSecret(b64Pkcs8: string): OrchestratorKey {
  let privateKey: KeyObject;
  try {
    privateKey = crypto.createPrivateKey({
      key: Buffer.from(b64Pkcs8, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    throw new Error(`${ORCHESTRATOR_SK_ENV}: not a valid base64 PKCS8 Ed25519 key`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${ORCHESTRATOR_SK_ENV}: expected an Ed25519 key`);
  }
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, kid: jwkThumbprint(publicKey) };
}

/** Load the key from an env map (defaults to process.env). Throws if unset. */
export function loadOrchestratorKey(env: NodeJS.ProcessEnv = process.env): OrchestratorKey {
  const raw = env[ORCHESTRATOR_SK_ENV];
  if (!raw) throw new Error(`${ORCHESTRATOR_SK_ENV} is not set`);
  return parseOrchestratorSecret(raw.trim());
}

let cached: OrchestratorKey | null = null;
/** Lazy, cached accessor for app code. First call reads process.env. */
export function getOrchestratorKey(): OrchestratorKey {
  if (!cached) cached = loadOrchestratorKey();
  return cached;
}

/** For tests/rotation: generate a fresh key and the exact env value to install. */
export function generateOrchestratorKey(): OrchestratorKey & { secretEnvValue: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const secretEnvValue = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
  return { privateKey, publicKey, kid: jwkThumbprint(publicKey), secretEnvValue };
}
