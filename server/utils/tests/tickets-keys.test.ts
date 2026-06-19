import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ORCHESTRATOR_SK_ENV,
  generateOrchestratorKey,
  jwkThumbprint,
  loadOrchestratorKey,
  parseOrchestratorSecret,
  publicJwk,
} from '../../features/tickets/keys.ts';
import { issueTicket, verifyTicket } from '../../features/tickets/ticket.ts';

describe('orchestrator key', () => {
  it('generate → env → load round-trip issues a verifiable ticket', () => {
    const gen = generateOrchestratorKey();
    const loaded = loadOrchestratorKey({ [ORCHESTRATOR_SK_ENV]: gen.secretEnvValue });
    assert.equal(loaded.kid, gen.kid);

    const token = issueTicket(
      { nodeId: 'node-1', dedupeKey: 'ddk', jti: 'j1', now: 1000 },
      loaded.privateKey,
      loaded.kid,
    );
    const { claims, kid } = verifyTicket(token, loaded.publicKey, { expectedNodeId: 'node-1', now: 1010 });
    assert.equal(claims.sub, 'ddk');
    assert.equal(kid, gen.kid);
  });

  it('kid is a stable thumbprint per key', () => {
    const gen = generateOrchestratorKey();
    const a = parseOrchestratorSecret(gen.secretEnvValue);
    const b = parseOrchestratorSecret(gen.secretEnvValue);
    assert.equal(a.kid, b.kid);
    assert.equal(a.kid, jwkThumbprint(a.publicKey));

    assert.notEqual(generateOrchestratorKey().kid, gen.kid);
  });

  it('publicJwk has the expected OKP shape and no private scalar', () => {
    const gen = generateOrchestratorKey();
    const jwk = publicJwk(gen.publicKey, gen.kid);
    assert.equal(jwk.kty, 'OKP');
    assert.equal(jwk.crv, 'Ed25519');
    assert.equal(jwk.alg, 'EdDSA');
    assert.equal(jwk.use, 'sig');
    assert.equal(jwk.kid, gen.kid);
    assert.ok(typeof jwk.x === 'string' && jwk.x.length > 0);
    assert.equal((jwk as Record<string, unknown>).d, undefined);
  });

  it('throws when the env var is missing', () => {
    assert.throws(() => loadOrchestratorKey({}), new RegExp(ORCHESTRATOR_SK_ENV));
  });

  it('throws on a malformed / non-Ed25519 secret', () => {
    assert.throws(() => parseOrchestratorSecret('not-base64-pkcs8'), /valid base64 PKCS8|Ed25519/);
  });
});
