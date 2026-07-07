import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyIntegrityPayload,
  canonicalJson,
  type IntegrityPayload,
  type NodeReleaseManifest,
} from '../integrity.ts';

function makeManifest(overrides: Partial<NodeReleaseManifest> = {}): NodeReleaseManifest {
  return {
    product: 'consensus-node',
    version: '1.2.3',
    platform: 'linux-arm64',
    commit: 'abc123',
    routes_hash: 'sha256:deadbeef',
    tarball_sha256: 'sha256:cafe',
    ...overrides,
  };
}

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  return { publicKey, privateKey, publicKeyPem };
}

// Build an integrity payload signed with `signWith`, declaring `claimedKeyPem`.
// Honest payloads pass the same key for both; attacks separate them.
function signedPayload(
  signWith: crypto.KeyObject,
  claimedKeyPem: string,
  overrides: Partial<Omit<IntegrityPayload, 'signature'>> = {}
): IntegrityPayload {
  const unsigned = {
    product: 'consensus-node' as const,
    version: '1.2.3',
    runtime: 'bun' as const,
    platform: 'linux-arm64',
    node_public_key_pem: claimedKeyPem,
    manifest: makeManifest(),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'nonce-1',
    ...overrides,
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), signWith).toString('base64');
  return { ...unsigned, signature };
}

test('accepts a well-formed, correctly-signed payload (bootstrap: no required manifest)', () => {
  const node = identity();
  const result = verifyIntegrityPayload(signedPayload(node.privateKey, node.publicKeyPem), node.publicKey, null);
  assert.equal(result.ok, true);
});

test('rejects a payload whose declared key is not the trusted identity', () => {
  const node = identity();
  const attacker = identity();
  const result = verifyIntegrityPayload(signedPayload(attacker.privateKey, attacker.publicKeyPem), node.publicKey, null);
  if (result.ok) return assert.fail('expected rejection');
  assert.equal(result.kind, 'unauthenticated');
});

test('rejects claiming the trusted key while signing with another (binding is real)', () => {
  const node = identity();
  const attacker = identity();
  // Declares the node's key (so the key-binding check passes) but signs with the
  // attacker's key — the signature must still verify against the node's key.
  const result = verifyIntegrityPayload(signedPayload(attacker.privateKey, node.publicKeyPem), node.publicKey, null);
  if (result.ok) return assert.fail('expected rejection');
  assert.equal(result.kind, 'unauthenticated');
});

test('rejects a tampered payload (manifest changed after signing)', () => {
  const node = identity();
  const payload = signedPayload(node.privateKey, node.publicKeyPem);
  const tampered = { ...payload, manifest: { ...payload.manifest, version: '9.9.9' } };
  const result = verifyIntegrityPayload(tampered, node.publicKey, null);
  if (result.ok) return assert.fail('expected rejection');
  assert.equal(result.kind, 'unauthenticated');
});

test('rejects a stale timestamp', () => {
  const node = identity();
  const payload = signedPayload(node.privateKey, node.publicKeyPem, {
    timestamp: Math.floor(Date.now() / 1000) - 10_000,
  });
  const result = verifyIntegrityPayload(payload, node.publicKey, null);
  if (result.ok) return assert.fail('expected rejection');
  assert.equal(result.kind, 'stale');
});

test('rejects a malformed payload (missing fields)', () => {
  const node = identity();
  const result = verifyIntegrityPayload(
    { product: 'consensus-node' } as unknown as IntegrityPayload,
    node.publicKey,
    null
  );
  if (result.ok) return assert.fail('expected rejection');
  assert.equal(result.kind, 'malformed');
});

test('release gate: accepts when the observed manifest matches the required release', () => {
  const node = identity();
  const result = verifyIntegrityPayload(signedPayload(node.privateKey, node.publicKeyPem), node.publicKey, makeManifest());
  assert.equal(result.ok, true);
});

test('release gate: rejects when the observed manifest differs from the required release', () => {
  const node = identity();
  const required = makeManifest({ commit: 'different-commit' });
  const result = verifyIntegrityPayload(signedPayload(node.privateKey, node.publicKeyPem), node.publicKey, required);
  if (result.ok) return assert.fail('expected rejection');
  assert.equal(result.kind, 'manifest_mismatch');
});
