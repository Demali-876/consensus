// Single source of truth for node integrity verification. Both the eval tunnel
// (pre-registration, anchored to the handshake-verified identity) and the
// post-registration HTTP endpoint (updater.ts, anchored to the registered node
// key) verify integrity payloads through THIS module — a security check must not
// have two implementations that can drift.
//
// The node self-signs an IntegrityPayload with its Ed25519 identity key: it binds
// the running release manifest (version/commit/routes_hash) to that identity and
// a fresh timestamp. Verification proves three things:
//   1. authenticity  — the payload was produced by the holder of the trusted key
//                      (the same key proven in the tunnel handshake / registration),
//   2. freshness     — the timestamp is within tolerance (anti-replay),
//   3. approved build — the manifest matches the release the orchestrator marked
//                      required (skipped while none is marked — bootstrap).
//
// It does NOT prove the node is actually EXECUTING that code (a modified node can
// sign a manifest claiming any version) — that bar is raised further by
// post-join re-eval and ongoing monitoring. What it does give is a cryptographic
// binding of the claimed build to a specific, proven identity.

import crypto from 'crypto';

export interface NodeReleaseManifest {
  product: 'consensus-node';
  version: string;
  platform: string;
  commit: string;
  routes_hash: string;
  tarball_sha256?: string;
  download_url?: string;
  signature?: string;
  signing_key_id?: string;
}

export interface IntegrityPayload {
  product: 'consensus-node';
  version: string;
  runtime: 'bun';
  platform: string;
  node_public_key_pem: string;
  manifest: NodeReleaseManifest;
  timestamp: number;
  nonce: string;
  signature: string;
}

// A structurally-valid-then-cryptographically-checked outcome. `status` is the
// HTTP status the updater endpoint should return; the eval path treats anything
// other than `ok` as an admission blocker.
export type IntegrityVerification =
  | { ok: true }
  | { ok: false; kind: 'malformed'; status: 400; reason: string; required?: string[]; missing?: string[] }
  | { ok: false; kind: 'unauthenticated'; status: 403; reason: string }
  | { ok: false; kind: 'stale'; status: 400; reason: string }
  | {
      ok: false;
      kind: 'manifest_mismatch';
      status: 200;
      reason: string;
      required: NodeReleaseManifest;
      observed: NodeReleaseManifest;
    };

// The node signs the payload within ±this of the server clock. 5 minutes
// tolerates clock skew while bounding replay of a captured payload.
const TIMESTAMP_TOLERANCE_SEC = 300;

/** Structural validation only — no crypto. Returns null when well-formed. Kept
 *  separate so the updater endpoint can 400 a malformed body before it looks up
 *  the node (preserving its original 400-before-404 ordering). */
export function validateIntegrityPayload(
  payload: Partial<IntegrityPayload> | null | undefined
): { error: string; required?: string[]; missing?: string[] } | null {
  const required = [
    'product',
    'version',
    'runtime',
    'platform',
    'node_public_key_pem',
    'manifest',
    'timestamp',
    'nonce',
    'signature',
  ];
  if (!payload || typeof payload !== 'object') return { error: 'Integrity payload must be an object' };
  const missing = required.filter((key) => (payload as Record<string, unknown>)[key] == null);
  if (missing.length > 0) return { error: 'Missing required fields', required, missing };
  if (payload.product !== 'consensus-node') return { error: 'Invalid product' };
  if (payload.runtime !== 'bun') return { error: 'Invalid runtime' };
  if (payload.manifest?.product !== 'consensus-node') return { error: 'Invalid manifest product' };
  return null;
}

/** Does the observed manifest match the release the orchestrator requires? The
 *  release surface (routes_hash) plus its provenance (version/platform/commit)
 *  must line up; tarball_sha256 is checked only when the required manifest pins
 *  it. */
export function manifestMatchesRequired(
  observed: NodeReleaseManifest,
  required: NodeReleaseManifest
): boolean {
  return (
    observed.version === required.version &&
    observed.platform === required.platform &&
    observed.commit === required.commit &&
    observed.routes_hash === required.routes_hash &&
    (required.tarball_sha256 == null || observed.tarball_sha256 === required.tarball_sha256)
  );
}

/** Full verification against a TRUSTED key. `trustedKey` is the caller's proven
 *  anchor: the handshake-verified identity in eval, or the registered node's
 *  Ed25519 key post-registration. `requiredManifest` is null in bootstrap (no
 *  release marked required) — then the release gate is skipped. Pure: no I/O. */
export function verifyIntegrityPayload(
  payload: IntegrityPayload | null | undefined,
  trustedKey: crypto.KeyObject,
  requiredManifest: NodeReleaseManifest | null,
  now: number = Math.floor(Date.now() / 1000)
): IntegrityVerification {
  const malformed = validateIntegrityPayload(payload);
  if (malformed) {
    return { ok: false, kind: 'malformed', status: 400, reason: malformed.error, required: malformed.required, missing: malformed.missing };
  }
  const p = payload as IntegrityPayload;

  // Key binding: the payload's declared identity must equal the trusted key.
  let presentedDer: Buffer;
  try {
    presentedDer = crypto.createPublicKey(p.node_public_key_pem).export({ format: 'der', type: 'spki' });
  } catch {
    return { ok: false, kind: 'malformed', status: 400, reason: 'node_public_key_pem is not a valid public key' };
  }
  const trustedDer = trustedKey.export({ format: 'der', type: 'spki' });
  if (presentedDer.length !== trustedDer.length || !crypto.timingSafeEqual(presentedDer, trustedDer)) {
    return {
      ok: false,
      kind: 'unauthenticated',
      status: 403,
      reason: 'integrity public key does not match the verified node identity',
    };
  }

  // Freshness: bounds replay of a captured payload.
  if (!Number.isFinite(p.timestamp) || Math.abs(now - p.timestamp) > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, kind: 'stale', status: 400, reason: 'timestamp too old or in the future' };
  }

  // Signature over the canonical unsigned payload, by the trusted key.
  const signed = canonicalJson({
    product: p.product,
    version: p.version,
    runtime: p.runtime,
    platform: p.platform,
    node_public_key_pem: p.node_public_key_pem,
    manifest: p.manifest,
    timestamp: p.timestamp,
    nonce: p.nonce,
  });
  let validSig = false;
  try {
    validSig = crypto.verify(null, Buffer.from(signed, 'utf8'), trustedKey, Buffer.from(p.signature, 'base64'));
  } catch {
    validSig = false;
  }
  if (!validSig) {
    return { ok: false, kind: 'unauthenticated', status: 403, reason: 'invalid integrity signature' };
  }

  // Approved-build gate — only when a release is marked required (bootstrap skips).
  if (requiredManifest && !manifestMatchesRequired(p.manifest, requiredManifest)) {
    return {
      ok: false,
      kind: 'manifest_mismatch',
      status: 200,
      reason: 'node manifest does not match the required release',
      required: requiredManifest,
      observed: p.manifest,
    };
  }

  return { ok: true };
}

// Canonical JSON (stable key order) — MUST match consensus-node's
// crypto/canonical-json.ts so the node's signature verifies here.
export function canonicalJson(value: unknown): string {
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
