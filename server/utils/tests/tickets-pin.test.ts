import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { generateOrchestratorKey } from '../../features/tickets/keys.ts';
import { orchestratorPinForJoin } from '../../features/tickets/pubkey.ts';
import { issueTicket, verifyTicket } from '../../features/tickets/ticket.ts';

describe('orchestratorPinForJoin (pubkey pinned at node registration)', () => {
  it('returns the public JWK + kid and no private scalar', () => {
    const gen = generateOrchestratorKey();
    const { orchestrator_pubkey } = orchestratorPinForJoin(() => gen);

    assert.ok(orchestrator_pubkey, 'pin includes a key when the signing key is configured');
    assert.equal(orchestrator_pubkey.kty, 'OKP');
    assert.equal(orchestrator_pubkey.crv, 'Ed25519');
    assert.equal(orchestrator_pubkey.kid, gen.kid);
    assert.equal(orchestrator_pubkey.use, 'sig');
    assert.equal(orchestrator_pubkey.alg, 'EdDSA');
    assert.equal(orchestrator_pubkey.d, undefined, 'never leaks the private scalar');
  });

  it('the pinned key verifies a real orchestrator ticket', () => {
    const gen = generateOrchestratorKey();
    const { orchestrator_pubkey } = orchestratorPinForJoin(() => gen);
    assert.ok(orchestrator_pubkey);

    // The node imports exactly what it persisted at registration and checks a ticket.
    const pinnedKey = crypto.createPublicKey({ key: orchestrator_pubkey as crypto.JsonWebKey, format: 'jwk' });
    const token = issueTicket(
      { nodeId: 'node-1', dedupeKey: 'ddk', jti: 'j1', now: 1000 },
      gen.privateKey,
      gen.kid,
    );

    const { claims, kid } = verifyTicket(token, pinnedKey, { expectedNodeId: 'node-1', now: 1010 });
    assert.equal(claims.sub, 'ddk');
    assert.equal(kid, gen.kid, 'footer kid matches the pinned key');
  });

  it('degrades to a null pin when the signing key is unavailable', () => {
    const { orchestrator_pubkey } = orchestratorPinForJoin(() => {
      throw new Error('not set');
    });
    assert.equal(orchestrator_pubkey, null);
  });
});
