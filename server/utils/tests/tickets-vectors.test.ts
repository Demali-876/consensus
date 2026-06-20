import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { verifyTicket, type TicketClaims } from '../../features/tickets/ticket.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, '../../features/tickets/test-vectors/tickets.vectors.json');

interface Vector {
  name: string;
  token: string;
  verify: { expectedNodeId: string; expectedScope?: string; now: number };
  expect: { ok: boolean; error?: string; kid?: string; claims?: Partial<TicketClaims> };
}
interface Fixture {
  kid: string;
  publicJwk: Record<string, string>;
  vectors: Vector[];
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture;

describe('routing ticket — shared test vectors', () => {
  const publicKey = crypto.createPublicKey({ key: fixture.publicJwk as crypto.JsonWebKey, format: 'jwk' });

  it('fixture publishes a usable Ed25519 public key + matching kid', () => {
    assert.equal(publicKey.asymmetricKeyType, 'ed25519');
    assert.equal(fixture.publicJwk.kid, fixture.kid);
    assert.ok(fixture.vectors.length >= 6);
  });

  for (const v of fixture.vectors) {
    it(`vector: ${v.name}`, () => {
      if (v.expect.ok) {
        const { claims, kid } = verifyTicket(v.token, publicKey, v.verify);
        for (const [key, value] of Object.entries(v.expect.claims ?? {})) {
          assert.equal((claims as Record<string, unknown>)[key], value, `claim ${key}`);
        }
        if (v.expect.kid) assert.equal(kid, v.expect.kid);
      } else {
        assert.throws(() => verifyTicket(v.token, publicKey, v.verify), new RegExp(v.expect.error ?? '.'));
      }
    });
  }
});
