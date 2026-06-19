import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { generateOrchestratorKey } from '../../features/tickets/keys.ts';
import { orchestratorPubkeyResponse } from '../../features/tickets/pubkey.ts';
import { issueTicket, verifyTicket } from '../../features/tickets/ticket.ts';

interface Jwks {
  keys: Array<Record<string, string>>;
}

describe('GET /orchestrator/pubkey', () => {
  it('returns a JWKS with the public JWK + kid and no private scalar', () => {
    const gen = generateOrchestratorKey();
    const { status, body } = orchestratorPubkeyResponse(() => gen);

    assert.equal(status, 200);
    const jwks = body as Jwks;
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].kty, 'OKP');
    assert.equal(jwks.keys[0].crv, 'Ed25519');
    assert.equal(jwks.keys[0].kid, gen.kid);
    assert.equal(jwks.keys[0].d, undefined);
  });

  it('the published key verifies a real orchestrator ticket', () => {
    const gen = generateOrchestratorKey();
    const jwk = (orchestratorPubkeyResponse(() => gen).body as Jwks).keys[0];

    // A verifier (the node) imports the published JWK and checks a ticket.
    const importedPublicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
    const token = issueTicket(
      { nodeId: 'node-1', dedupeKey: 'ddk', jti: 'j1', now: 1000 },
      gen.privateKey,
      gen.kid,
    );

    const { claims } = verifyTicket(token, importedPublicKey, { expectedNodeId: 'node-1', now: 1010 });
    assert.equal(claims.sub, 'ddk');
  });

  it('returns 503 when the signing key is unavailable', () => {
    const { status, body } = orchestratorPubkeyResponse(() => {
      throw new Error('not set');
    });
    assert.equal(status, 503);
    assert.equal((body as { error: string }).error, 'orchestrator signing key unavailable');
  });
});
