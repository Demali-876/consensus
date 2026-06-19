// Generates the shared routing-ticket test vectors. Deterministic: a fixed
// TEST-ONLY key (derived from a constant seed) and fixed clocks, so re-running
// produces byte-identical JSON. The fixture is copied verbatim into
// consensus-node so its verifier is proven byte-compatible with this one.
//
//   npm run gen:ticket-vectors

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOrchestratorSecret, publicJwk } from './keys.ts';
import { issueTicket } from './ticket.ts';

// TEST ONLY — Ed25519 PKCS8 built from a constant 32-byte seed. Never a real key.
const TEST_SEED = Buffer.alloc(32, 7);
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const secretKeyPkcs8B64 = Buffer.concat([ED25519_PKCS8_PREFIX, TEST_SEED]).toString('base64');
const { privateKey, publicKey, kid } = parseOrchestratorSecret(secretKeyPkcs8B64);

const ISSUE_AT = 1_700_000_000;
const NODE = 'node-test';

function tamper(token: string): string {
  const parts = token.split('.');
  const body = Buffer.from(parts[2], 'base64url');
  body[0] ^= 0x01;
  parts[2] = body.toString('base64url');
  return parts.join('.');
}

const validToken = issueTicket(
  { nodeId: NODE, dedupeKey: 'ddk-valid', jti: 'jti-valid', now: ISSUE_AT, ttlSec: 60 },
  privateKey,
  kid,
);

const vectors = [
  {
    name: 'valid',
    token: validToken,
    verify: { expectedNodeId: NODE, expectedScope: 'proxy', now: ISSUE_AT + 10 },
    expect: { ok: true, kid, claims: { aud: NODE, sub: 'ddk-valid', scope: 'proxy', jti: 'jti-valid' } },
  },
  {
    name: 'expired',
    token: validToken,
    verify: { expectedNodeId: NODE, now: ISSUE_AT + 1000 },
    expect: { ok: false, error: 'expired' },
  },
  {
    name: 'wrong-node',
    token: validToken,
    verify: { expectedNodeId: 'node-other', now: ISSUE_AT + 10 },
    expect: { ok: false, error: 'bad signature' },
  },
  {
    name: 'wrong-scope',
    token: issueTicket(
      { nodeId: NODE, dedupeKey: 'ddk-s', jti: 'jti-s', now: ISSUE_AT, scope: 'tunnel' },
      privateKey,
      kid,
    ),
    verify: { expectedNodeId: NODE, expectedScope: 'proxy', now: ISSUE_AT + 10 },
    expect: { ok: false, error: 'scope' },
  },
  {
    name: 'tampered',
    token: tamper(validToken),
    verify: { expectedNodeId: NODE, now: ISSUE_AT + 10 },
    expect: { ok: false, error: 'bad signature' },
  },
  {
    name: 'future',
    token: issueTicket(
      { nodeId: NODE, dedupeKey: 'ddk-f', jti: 'jti-f', now: ISSUE_AT + 5000 },
      privateKey,
      kid,
    ),
    verify: { expectedNodeId: NODE, now: ISSUE_AT },
    expect: { ok: false, error: 'future' },
  },
];

const fixture = {
  _comment:
    'TEST ONLY. Shared verbatim with consensus-node to lock the routing-ticket wire format. Regenerate: npm run gen:ticket-vectors',
  algorithm: 'PASETO v4.public (Ed25519)',
  secretKeyPkcs8B64,
  kid,
  publicJwk: publicJwk(publicKey, kid),
  vectors,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'test-vectors');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'tickets.vectors.json');
fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors → ${path.relative(process.cwd(), outPath)} (kid ${kid})`);
