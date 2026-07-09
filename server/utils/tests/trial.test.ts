import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newTrial,
  foldHeartbeat,
  foldFetch,
  foldCapacity,
  foldReconnect,
  evaluate,
  continuity,
  registerStrike,
  MAX_STRIKES,
  HEARTBEAT_INTERVAL_MS,
  type TrialCard,
} from '../../features/nodes/trial.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A card at its deadline that has cleared every hard floor, so tests can isolate
// one failing condition at a time by breaking exactly one field.
function passingCardAtDeadline(): TrialCard {
  const started = 0;
  const now = DAY;
  const expected = Math.floor(DAY / HEARTBEAT_INTERVAL_MS);
  return {
    ...newTrial('n1', { now: started, durationMs: DAY }),
    hb_received: expected, // full continuity
    last_hb_at: now, // fresh heartbeat → no void
    fetch_ok: 50,
    fetch_total: 50, // 100% success
    stability_score: 80, // above the 60 bar
    updated_at: now,
  };
}

test('newTrial seeds a fresh running card with the right deadline', () => {
  const card = newTrial('n1', { now: 1_000, durationMs: DAY });
  assert.equal(card.status, 'running');
  assert.equal(card.started_at, 1_000);
  assert.equal(card.deadline, 1_000 + DAY);
  assert.equal(card.strikes, 0);
  assert.equal(card.attempt, 1);
  assert.equal(card.fetch_total, 0);
  assert.equal(card.ewma_latency, null);
});

test('newTrial carries strikes and attempt across a restart', () => {
  const card = newTrial('n1', { now: 0, durationMs: DAY, attempt: 3, strikes: 2 });
  assert.equal(card.attempt, 3);
  assert.equal(card.strikes, 2);
  assert.equal(card.status, 'running');
});

test('evaluate continues before the deadline with a healthy card', () => {
  const card = { ...newTrial('n1', { now: 0, durationMs: DAY }), last_hb_at: 5_000 };
  assert.equal(evaluate(card, 6_000).kind, 'continue');
});

test('evaluate voids after a disconnect ≥ the void threshold', () => {
  const card = { ...newTrial('n1', { now: 0, durationMs: DAY }), last_hb_at: 1_000 };
  const decision = evaluate(card, 1_000 + HOUR + 1, HOUR);
  assert.equal(decision.kind, 'void');
});

test('evaluate tolerates a brief gap below the void threshold', () => {
  const card = { ...newTrial('n1', { now: 0, durationMs: DAY }), last_hb_at: 1_000 };
  assert.equal(evaluate(card, 1_000 + 5 * 60 * 1000, HOUR).kind, 'continue');
});

test('evaluate passes at the deadline when every floor is cleared', () => {
  assert.equal(evaluate(passingCardAtDeadline(), DAY).kind, 'pass');
});

test('evaluate fails at the deadline on low heartbeat continuity', () => {
  const card = { ...passingCardAtDeadline(), hb_received: 10 }; // far below expected
  const decision = evaluate(card, DAY);
  assert.equal(decision.kind, 'fail');
  assert.match((decision as { reason: string }).reason, /continuity/);
});

test('evaluate fails at the deadline on low probe success rate', () => {
  const card = { ...passingCardAtDeadline(), fetch_ok: 30, fetch_total: 50 }; // 60%
  const decision = evaluate(card, DAY);
  assert.equal(decision.kind, 'fail');
  assert.match((decision as { reason: string }).reason, /success/);
});

test('evaluate fails at the deadline when too few probes ran', () => {
  const card = { ...passingCardAtDeadline(), fetch_ok: 1, fetch_total: 1 };
  const decision = evaluate(card, DAY);
  assert.equal(decision.kind, 'fail');
  assert.match((decision as { reason: string }).reason, /samples/);
});

test('evaluate fails at the deadline on a low stability score', () => {
  const card = { ...passingCardAtDeadline(), stability_score: 40 };
  const decision = evaluate(card, DAY);
  assert.equal(decision.kind, 'fail');
  assert.match((decision as { reason: string }).reason, /score/);
});

test('foldHeartbeat tracks received count and worst gap', () => {
  let card = newTrial('n1', { now: 0, durationMs: DAY });
  card = foldHeartbeat(card, 30_000); // first gap measured from started_at
  card = foldHeartbeat(card, 90_000); // 60s gap
  assert.equal(card.hb_received, 2);
  assert.equal(card.worst_gap_ms, 60_000);
  assert.equal(card.last_hb_at, 90_000);
});

test('a failed fetch drops the score; good fetches heal it back', () => {
  let card = newTrial('n1', { now: 0, durationMs: DAY });
  const start = card.stability_score;
  card = foldFetch(card, { ok: false, latencyMs: 0 }, 1);
  assert.ok(card.stability_score < start, 'failure should drop the score');
  const dropped = card.stability_score;
  for (let i = 0; i < 10; i++) card = foldFetch(card, { ok: true, latencyMs: 100 }, 2 + i);
  assert.ok(card.stability_score > dropped, 'good probes should heal the score');
});

test('foldFetch learns the latency baseline (EWMA converges)', () => {
  let card = newTrial('n1', { now: 0, durationMs: DAY });
  for (let i = 0; i < 20; i++) card = foldFetch(card, { ok: true, latencyMs: 200 }, i);
  assert.ok(card.ewma_latency !== null);
  assert.ok(Math.abs((card.ewma_latency as number) - 200) < 1, 'EWMA should converge to the steady latency');
});

test('a latency spike far outside the learned band is penalized', () => {
  let card = newTrial('n1', { now: 0, durationMs: DAY });
  // Establish a tight band around ~200ms with a little jitter.
  for (let i = 0; i < 20; i++) card = foldFetch(card, { ok: true, latencyMs: 195 + (i % 3) * 5 }, i);
  const before = card.stability_score;
  card = foldFetch(card, { ok: true, latencyMs: 5_000 }, 100); // huge spike, still "ok"
  assert.ok(card.stability_score <= before, 'a large latency spike should not heal (net penalty)');
});

test('a capacity sample far below the learned band docks the score (thermal)', () => {
  let card = newTrial('n1', { now: 0, durationMs: DAY });
  for (let i = 0; i < 10; i++) card = foldCapacity(card, 4_000, i); // learn ~4000 req/s
  const before = card.stability_score;
  card = foldCapacity(card, 1_000, 100); // throttled to 25% → below the drop floor
  assert.ok(card.stability_score < before, 'a capacity crater should dock the score');
});

test('reconnects dock the score', () => {
  let card = newTrial('n1', { now: 0, durationMs: DAY });
  const before = card.stability_score;
  card = foldReconnect(card, 1);
  assert.ok(card.stability_score < before);
  assert.equal(card.reconnects, 1);
});

test('continuity is 1 before any heartbeats are expected', () => {
  const card = newTrial('n1', { now: 0, durationMs: DAY });
  assert.equal(continuity(card, 10_000), 1); // < one interval elapsed
});

test('registerStrike restarts under the cap and discards at the cap', () => {
  let card = newTrial('n1', { now: 0, durationMs: DAY });
  // First MAX_STRIKES-1 outcomes restart.
  for (let i = 1; i < MAX_STRIKES; i++) {
    const r = registerStrike(card, 'fail', i);
    assert.equal(r.outcome, 'restart');
    assert.equal(r.card.strikes, i);
    card = r.card;
  }
  // The MAX_STRIKES-th outcome discards.
  const last = registerStrike(card, 'void', 99);
  assert.equal(last.card.strikes, MAX_STRIKES);
  assert.equal(last.outcome, 'discard');
  assert.equal(last.card.status, 'voided');
});
