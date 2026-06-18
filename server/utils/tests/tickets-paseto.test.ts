import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { signV4Public, verifyV4Public } from '../../features/tickets/paseto.ts';

function keypair() {
  return crypto.generateKeyPairSync('ed25519');
}

describe('PASETO v4.public core', () => {
  it('round-trips a message and footer', () => {
    const { privateKey, publicKey } = keypair();
    const msg = JSON.stringify({ hello: 'world', n: 1 });
    const token = signV4Public(msg, privateKey, JSON.stringify({ kid: 'orch-1' }));

    assert.ok(token.startsWith('v4.public.'));
    const { message, footer } = verifyV4Public(token, publicKey);
    assert.equal(message.toString('utf8'), msg);
    assert.deepEqual(JSON.parse(footer.toString('utf8')), { kid: 'orch-1' });
  });

  it('rejects a tampered payload', () => {
    const { privateKey, publicKey } = keypair();
    const token = signV4Public('payload', privateKey);

    const body = Buffer.from(token.split('.')[2], 'base64url');
    body[0] ^= 0x01; // flip a bit in the message
    const tampered = `v4.public.${body.toString('base64url')}`;

    assert.throws(() => verifyV4Public(tampered, publicKey), /bad signature/);
  });

  it('rejects verification under the wrong key', () => {
    const a = keypair();
    const b = keypair();
    const token = signV4Public('payload', a.privateKey);

    assert.throws(() => verifyV4Public(token, b.publicKey), /bad signature/);
  });

  it('binds the footer — swapping it invalidates the token', () => {
    const { privateKey, publicKey } = keypair();
    const token = signV4Public('payload', privateKey, 'footer-A');

    const head = token.split('.').slice(0, 3).join('.');
    const swapped = `${head}.${Buffer.from('footer-B').toString('base64url')}`;

    assert.throws(() => verifyV4Public(swapped, publicKey), /bad signature/);
  });

  it('binds the implicit assertion (e.g. node_id)', () => {
    const { privateKey, publicKey } = keypair();
    const token = signV4Public('payload', privateKey, '', 'node-123');

    assert.equal(verifyV4Public(token, publicKey, 'node-123').message.toString('utf8'), 'payload');
    assert.throws(() => verifyV4Public(token, publicKey, 'node-999'), /bad signature/);
  });
});
