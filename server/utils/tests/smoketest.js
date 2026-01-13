// utils/tests/smoketest.js
// Run with: node utils/tests/smoketest.js

const fs = require('fs');
const path = require('path');

// Use an isolated DB file for the test, created fresh each run.
const TEST_DB = path.resolve(__dirname, '../../.tmp/consensus-test.db');
fs.mkdirSync(path.dirname(TEST_DB), { recursive: true });
if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);

// Must set the env BEFORE requiring node_store so it picks up our path.
process.env.NODE_DB_PATH = TEST_DB;

const { NodeStore, db } = require('../../data/node_store');

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERTION FAILED:', msg);
    process.exit(1);
  }
}

(async () => {
  try {
    console.log('== Smoke test: NodeStore ==');

    // 1) Create join request
    const pubkey = Buffer.alloc(32);
    const jr = NodeStore.createJoinRequest({ pubkey, alg: 'ed25519' });
    console.log('join created:', jr);
    assert(jr.id && jr.nonce && jr.expires_at, 'join request missing fields');

    // 2) Upsert node
    const nodeId = 'node-abc123';
    const created = NodeStore.upsertNode({
      id: nodeId,
      pubkey,
      alg: 'ed25519',
      region: 'us-east',
      capabilities: { http2: true, websockets: true },
      status: 'provisioning'
    });
    console.log('node created:', created);
    assert(created && created.id === nodeId, 'node not created');
    assert(created.domain == null && created.tls_mode == null, 'domain/tls should start null');

    // 3) Set domain + tls_mode and verify persistence
    const updatedWithDomain = NodeStore.setDomain(nodeId, 'n-abc123.us-east.consensus.net', 'wildcard');
    console.log('after setDomain:', updatedWithDomain);
    assert(updatedWithDomain.domain === 'n-abc123.us-east.consensus.net', 'domain not persisted');
    assert(updatedWithDomain.tls_mode === 'wildcard', 'tls_mode not persisted');

    // 4) Heartbeat #1
    const hb1 = NodeStore.heartbeat(nodeId, { rps: 42, p95_ms: 110, version: 'proxy/1.0.1' });
    console.log('after heartbeat #1:', hb1);
    assert(hb1.heartbeat && hb1.heartbeat.rps === 42, 'heartbeat #1 not visible on getNode');

    // 5) Heartbeat #2 should replace "latest"
    NodeStore.heartbeat(nodeId, { rps: 100, p95_ms: 90, version: 'proxy/1.0.2' });
    const afterHb2 = NodeStore.getNode(nodeId);
    console.log('after heartbeat #2:', afterHb2);
    assert(afterHb2.heartbeat.rps === 100 && afterHb2.heartbeat.version === 'proxy/1.0.2',
      `latest heartbeat not reflected, got ${JSON.stringify(afterHb2.heartbeat)}`);

    // 6) listNodes should include domain/tls and latest heartbeat
    const list = NodeStore.listNodes();
    console.log('listNodes:', list);
    assert(Array.isArray(list) && list.length === 1, 'listNodes length mismatch');
    assert(list[0].domain === 'n-abc123.us-east.consensus.net', 'listNodes missing domain');
    assert(list[0].tls_mode === 'wildcard', 'listNodes missing tls_mode');
    assert(list[0].heartbeat && list[0].heartbeat.rps === 100, 'listNodes missing latest heartbeat');

    // 7) getJoin + consumeJoin flow
    const gotJoin = NodeStore.getJoin(jr.id);
    console.log('getJoin:', gotJoin);
    assert(gotJoin && Buffer.isBuffer(gotJoin.nonce), 'getJoin missing nonce buffer');

    const consumed = NodeStore.consumeJoin(jr.id);
    console.log('consumeJoin:', consumed);
    assert(consumed.consumed_at != null, 'consumeJoin did not set consumed_at');

    console.log('\n✅ All checks passed.');
    try { db.close(); } catch (_) {}
    process.exit(0);
  } catch (err) {
    console.error(err);
    try { db.close(); } catch (_) {}
    process.exit(1);
  }
})();
