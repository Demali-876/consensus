import test from 'node:test';
import assert from 'node:assert/strict';
import { TrialManager, type TrialStore } from '../../features/nodes/trial-manager.ts';
import { newTrial, HEARTBEAT_INTERVAL_MS, type TrialCard } from '../../features/nodes/trial.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// In-memory TrialStore + a controllable clock, so the manager's orchestration can
// be driven deterministically without a DB or a live tunnel.
function harness() {
  const nodes = new Map<string, { status: string }>();
  const trials = new Map<string, TrialCard>();
  const meta = new Map<string, string>();
  const proxyCalls: Array<{ nodeId: string; url: string }> = [];
  let clock = 0;
  let proxyStatus = 200;
  let proxyThrows = false;

  const store: TrialStore = {
    getNode: (id) => nodes.get(id) ?? null,
    getTrial: (id) => trials.get(id) ?? null,
    saveTrial: (card) => { trials.set(card.node_id, { ...card }); return card; },
    listRunningTrials: () => [...trials.values()].filter((c) => c.status === 'running'),
    setNodeStatus: (id, status) => { const n = nodes.get(id); if (n) n.status = status; },
    deleteNode: (id) => { nodes.delete(id); trials.delete(id); },
    deleteTrial: (id) => { trials.delete(id); },
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => { meta.set(k, String(v)); },
  };

  const manager = new TrialManager({
    store,
    requestProxy: async (nodeId, input) => {
      proxyCalls.push({ nodeId, url: input.target_url });
      if (proxyThrows) throw new Error('tunnel down');
      return { status: proxyStatus };
    },
    isConnected: () => true,
    now: () => clock,
    urls: ['https://probe.example/one', 'https://probe.example/two'],
  });

  return {
    store, manager, nodes, trials, meta, proxyCalls,
    setClock: (t: number) => { clock = t; },
    advance: (dt: number) => { clock += dt; },
    setProxy: (status: number, throws = false) => { proxyStatus = status; proxyThrows = throws; },
    setConnected: (fn: () => boolean) => {
      // rebuild manager with a different isConnected
      return new TrialManager({
        store,
        requestProxy: async (nodeId, input) => { proxyCalls.push({ nodeId, url: input.target_url }); return { status: proxyStatus }; },
        isConnected: fn,
        now: () => clock,
        urls: ['https://probe.example/one'],
      });
    },
  };
}

test('onConnect starts a trial for a trial-status node', () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.setClock(1_000);
  h.manager.onConnect('n1');
  const card = h.store.getTrial('n1');
  assert.ok(card, 'a trial card should be created');
  assert.equal(card?.status, 'running');
  assert.equal(card?.started_at, 1_000);
});

test('onConnect ignores a non-trial node', () => {
  const h = harness();
  h.nodes.set('n1', { status: 'active' });
  h.manager.onConnect('n1');
  assert.equal(h.store.getTrial('n1'), null);
});

test('onConnect folds a reconnect into a running trial (no restart)', () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.setClock(0);
  h.manager.onConnect('n1');
  const before = h.store.getTrial('n1');
  h.setClock(5_000);
  h.manager.onConnect('n1'); // reconnect
  const after = h.store.getTrial('n1');
  assert.equal(after?.reconnects, 1);
  assert.equal(after?.started_at, before?.started_at, 'reconnect must not reset the clock');
});

test('onHeartbeat folds availability into a running trial', () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.setClock(0);
  h.manager.onConnect('n1');
  h.setClock(30_000);
  h.manager.onHeartbeat('n1');
  assert.equal(h.store.getTrial('n1')?.hb_received, 1);
});

test('tick drives a fetch probe over the tunnel when connected and due', async () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  // Recent heartbeat (no void), deadline far away, clock past the probe interval.
  h.store.saveTrial({ ...newTrial('n1', { now: 0, durationMs: DAY }), last_hb_at: 2_000_000 });
  h.setClock(2_000_000);
  await h.manager.tick();
  assert.equal(h.proxyCalls.length, 1, 'one probe should have been sent');
  assert.match(h.proxyCalls[0].url, /probe\.example/);
  assert.equal(h.store.getTrial('n1')?.fetch_total, 1);
  assert.equal(h.store.getTrial('n1')?.fetch_ok, 1);
});

test('a failed probe is folded as a failure', async () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.store.saveTrial({ ...newTrial('n1', { now: 0, durationMs: DAY }), last_hb_at: 2_000_000 });
  h.setClock(2_000_000);
  h.setProxy(500);
  await h.manager.tick();
  assert.equal(h.store.getTrial('n1')?.fetch_total, 1);
  assert.equal(h.store.getTrial('n1')?.fetch_ok, 0);
});

test('tick graduates a node that cleared every floor at the deadline', async () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  const expected = Math.floor(DAY / HEARTBEAT_INTERVAL_MS);
  h.store.saveTrial({
    ...newTrial('n1', { now: 0, durationMs: DAY }),
    hb_received: expected,
    last_hb_at: DAY,
    fetch_ok: 50,
    fetch_total: 50,
    stability_score: 80,
  });
  h.setClock(DAY);
  await h.manager.tick();
  assert.equal(h.nodes.get('n1')?.status, 'active', 'node should graduate to active');
  assert.equal(h.store.getTrial('n1')?.status, 'passed');
});

test('tick voids a long-disconnected trial and restarts it, carrying a strike', async () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.store.saveTrial({ ...newTrial('n1', { now: 0, durationMs: DAY }), last_hb_at: 0 });
  h.setClock(2 * HOUR); // gap 2h ≥ 1h void threshold
  await h.manager.tick();
  const card = h.store.getTrial('n1');
  assert.equal(card?.status, 'running', 'a fresh attempt should be running');
  assert.equal(card?.strikes, 1);
  assert.equal(card?.attempt, 2);
  assert.equal(h.nodes.get('n1')?.status, 'trial', 'still on trial, not discarded');
});

test('the third strike discards the node (must pay to join again)', async () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.store.saveTrial({ ...newTrial('n1', { now: 0, durationMs: DAY, strikes: 2 }), last_hb_at: 0 });
  h.setClock(2 * HOUR);
  await h.manager.tick();
  assert.equal(h.store.getNode('n1'), null, 'node row removed');
  assert.equal(h.store.getTrial('n1'), null, 'trial row removed');
});

test('resumeAfterDowntime slides in-flight trials forward by the downtime', () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.store.saveTrial({ ...newTrial('n1', { now: 5_000, durationMs: DAY }), last_hb_at: 5_000 });
  h.store.setMeta('trial_last_tick', '1000'); // last tick at t=1000
  const downtime = 30 * 60 * 1000; // 30 min down
  h.setClock(1_000 + downtime);
  h.manager.resumeAfterDowntime();
  const card = h.store.getTrial('n1');
  assert.equal(card?.started_at, 5_000 + downtime);
  assert.equal(card?.deadline, 5_000 + DAY + downtime);
  assert.equal(card?.last_hb_at, 5_000 + downtime);
});

test('resumeAfterDowntime does nothing for a brief gap', () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  h.store.saveTrial({ ...newTrial('n1', { now: 5_000, durationMs: DAY }), last_hb_at: 5_000 });
  h.store.setMeta('trial_last_tick', '1000');
  h.setClock(1_000 + 30_000); // only 30s down (< 2min minimum)
  h.manager.resumeAfterDowntime();
  assert.equal(h.store.getTrial('n1')?.started_at, 5_000, 'no shift for a routine restart');
});

test('a disconnected node is not probed', async () => {
  const h = harness();
  h.nodes.set('n1', { status: 'trial' });
  const offlineManager = h.setConnected(() => false);
  h.store.saveTrial({ ...newTrial('n1', { now: 0, durationMs: DAY }), last_hb_at: 2_000_000 });
  h.setClock(2_000_000);
  await offlineManager.tick();
  assert.equal(h.proxyCalls.length, 0, 'no probe should be sent to a disconnected node');
});
