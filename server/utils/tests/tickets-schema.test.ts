import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { issueTicket, verifyTicket } from '../../features/tickets/ticket.ts';

const KID = 'orch-2026-06';
const base = { nodeId: 'node-abc', dedupeKey: 'ddk-123', jti: 'jti-1' };

function kp() {
  return crypto.generateKeyPairSync('ed25519');
}

describe('routing ticket schema', () => {
  it('issues and verifies a valid ticket', () => {
    const { privateKey, publicKey } = kp();
    const token = issueTicket({ ...base, now: 1000, ttlSec: 60 }, privateKey, KID);

    const { claims, kid } = verifyTicket(token, publicKey, { expectedNodeId: 'node-abc', now: 1010 });
    assert.equal(claims.iss, 'consensus-orchestrator');
    assert.equal(claims.aud, 'node-abc');
    assert.equal(claims.sub, 'ddk-123');
    assert.equal(claims.scope, 'proxy');
    assert.equal(claims.jti, 'jti-1');
    assert.equal(kid, KID);
  });

  it('rejects an expired ticket', () => {
    const { privateKey, publicKey } = kp();
    const token = issueTicket({ ...base, now: 1000, ttlSec: 60 }, privateKey, KID);
    assert.throws(() => verifyTicket(token, publicKey, { expectedNodeId: 'node-abc', now: 1100 }), /expired/);
  });

  it('rejects a ticket presented at the wrong node', () => {
    const { privateKey, publicKey } = kp();
    const token = issueTicket({ ...base, now: 1000 }, privateKey, KID);
    // wrong node id → implicit-assertion mismatch → signature failure
    assert.throws(
      () => verifyTicket(token, publicKey, { expectedNodeId: 'node-XYZ', now: 1010 }),
      /bad signature|audience/,
    );
  });

  it('rejects a tampered ticket', () => {
    const { privateKey, publicKey } = kp();
    const token = issueTicket({ ...base, now: 1000 }, privateKey, KID);
    const parts = token.split('.');
    const body = Buffer.from(parts[2], 'base64url');
    body[0] ^= 0x01;
    const tampered = `v4.public.${body.toString('base64url')}.${parts[3]}`;
    assert.throws(() => verifyTicket(tampered, publicKey, { expectedNodeId: 'node-abc', now: 1010 }));
  });

  it('rejects a wrong scope', () => {
    const { privateKey, publicKey } = kp();
    const token = issueTicket({ ...base, now: 1000, scope: 'tunnel' }, privateKey, KID);
    assert.throws(
      () => verifyTicket(token, publicKey, { expectedNodeId: 'node-abc', now: 1010, expectedScope: 'proxy' }),
      /scope/,
    );
  });

  it('rejects a future-issued ticket', () => {
    const { privateKey, publicKey } = kp();
    const token = issueTicket({ ...base, now: 5000 }, privateKey, KID);
    assert.throws(() => verifyTicket(token, publicKey, { expectedNodeId: 'node-abc', now: 1000 }), /future/);
  });
});
