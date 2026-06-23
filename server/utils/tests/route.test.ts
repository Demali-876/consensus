import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import ConsensusProxy from '../../features/proxy/proxy.ts';
import { buildNodeRoute, nodePublicKeyPem } from '../../features/proxy/route.ts';
import { generateOrchestratorKey } from '../../features/tickets/keys.ts';
import { verifyTicket } from '../../features/tickets/ticket.ts';
import { generateDedupeKey } from '../../features/proxy/dedupe.ts';

const orchestrator = generateOrchestratorKey();
const nodeKeyPair = crypto.generateKeyPairSync('ed25519');
const nodeDer = nodeKeyPair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

// Build a ConsensusProxy whose node selection + lookups are fully stubbed.
function makeProxy(opts: {
  node?: any;
  key?: () => ReturnType<typeof generateOrchestratorKey>;
  lookup?: (id: string) => Buffer | null;
} = {}) {
  return new ConsensusProxy({
    router: { selectNode: () => opts.node ?? null, incrementRequest() {}, decrementRequest() {} } as any,
    orchestratorKey: opts.key ?? (() => orchestrator),
    nodePubkeyLookup: opts.lookup ?? (() => Buffer.from(nodeDer)),
  });
}

describe('route — node pubkey + signed routing ticket', () => {
  it('nodePublicKeyPem converts DER SPKI to PEM and rejects non-Ed25519 keys', () => {
    assert.equal(nodePublicKeyPem(nodeDer), nodeKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(() => nodePublicKeyPem(rsa.publicKey.export({ type: 'spki', format: 'der' }) as Buffer), /not Ed25519/);
  });

  it('buildNodeRoute signs a ticket bound to {node, dedupe} and returns the node key', () => {
    const route = buildNodeRoute({
      node: { id: 'n1', domain: 'n1.consensus.test' },
      nodePubkeyDer: nodeDer,
      dedupeKey: 'ddk-1',
      key: orchestrator,
      jti: 'j1',
      now: 1000,
      ttlSec: 120,
    });
    assert.equal(route.node_id, 'n1');
    assert.equal(route.domain, 'n1.consensus.test');
    assert.equal(route.dedupe_key, 'ddk-1');
    assert.equal(route.ticket_exp, 1120);

    // The ticket verifies against the orchestrator pubkey, bound to n1 + ddk-1.
    const { claims } = verifyTicket(route.ticket, orchestrator.publicKey, { expectedNodeId: 'n1', now: 1010 });
    assert.equal(claims.sub, 'ddk-1');

    // The returned PEM round-trips to the same Ed25519 key.
    const imported = crypto.createPublicKey(route.node_pubkey_pem);
    assert.equal(imported.asymmetricKeyType, 'ed25519');
    assert.deepEqual(imported.export({ type: 'spki', format: 'der' }), Buffer.from(nodeDer));
  });

  it('throws when the selected node has no domain', () => {
    assert.throws(
      () => buildNodeRoute({ node: { id: 'n1' }, nodePubkeyDer: nodeDer, dedupeKey: 'd', key: orchestrator }),
      /no domain/,
    );
  });
});

describe('ConsensusProxy.routeRequest', () => {
  it('returns a node route with a ticket bound to the computed dedupe key', () => {
    const proxy = makeProxy({ node: { id: 'n1', region: 'us-east', domain: 'n1.consensus.test' } });
    const result = proxy.routeRequest('https://api.example.com/v1?b=2&a=1', 'GET', { 'content-type': 'application/json' });

    assert.equal(result.mode, 'node');
    if (result.mode !== 'node') return;
    const expectedKey = generateDedupeKey({
      target_url: 'https://api.example.com/v1?b=2&a=1',
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(result.dedupe_key, expectedKey);
    const { claims } = verifyTicket(result.ticket, orchestrator.publicKey, { expectedNodeId: 'n1' });
    assert.equal(claims.sub, expectedKey, 'ticket sub == dedupe key the node will recompute');
  });

  it('falls back to self when no node is available', () => {
    assert.equal(makeProxy({ node: null }).routeRequest('https://a.test/', 'GET').mode, 'self');
  });

  it('falls back to self when the orchestrator itself is selected', () => {
    const proxy = makeProxy({ node: { id: 'server', region: 'us', domain: 'consensus.test' } });
    assert.equal(proxy.routeRequest('https://a.test/', 'GET').mode, 'self');
  });

  it('falls back to self when the node has no domain or no identity key', () => {
    assert.equal(makeProxy({ node: { id: 'n1', region: 'us' } }).routeRequest('https://a.test/', 'GET').mode, 'self');
    const noKey = makeProxy({ node: { id: 'n1', region: 'us', domain: 'n1.test' }, lookup: () => null });
    assert.equal(noKey.routeRequest('https://a.test/', 'GET').mode, 'self');
  });

  it('falls back to self when the node identity key is present but malformed', () => {
    // A stored pubkey_ed25519 that exists but is not a valid Ed25519 SPKI must
    // not 500 a paid request — buildNodeRoute throws and we degrade to self.
    const proxy = makeProxy({
      node: { id: 'n1', region: 'us', domain: 'n1.test' },
      lookup: () => Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(proxy.routeRequest('https://a.test/', 'GET').mode, 'self');
  });

  it('falls back to self when no signing key is configured', () => {
    const proxy = makeProxy({
      node: { id: 'n1', region: 'us', domain: 'n1.test' },
      key: () => { throw new Error('ORCHESTRATOR_SIGNING_SK is not set'); },
    });
    assert.equal(proxy.routeRequest('https://a.test/', 'GET').mode, 'self');
  });

  it('rejects an invalid target_url', () => {
    assert.throws(() => makeProxy({ node: null }).routeRequest('not a url', 'GET'), /Invalid target_url/);
  });
});
