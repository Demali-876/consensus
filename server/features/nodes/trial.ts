// 24h stability trial — pure logic (no I/O), so the scoring and lifecycle can be
// unit-tested in isolation. Persistence lives in data/node_store.js (the
// `node_trials` table, one row per node, overwritten in place — storage never
// grows with trial length); the scheduler that drives probes lives elsewhere and
// folds signals through the pure functions here.
//
// WHY a trial at all: a one-shot eval proves peak capability but not that the
// operator will keep the box up 24/7. The trial watches a node over a full
// day/night cycle before it ever serves real traffic (a node in `trial` status is
// excluded from routing — the Router only routes `status === 'active'`).
//
// The verdict is ADAPTIVE: instead of global thresholds we learn each node's OWN
// latency baseline + jitter with an EWMA/EWMV (the same estimator TCP uses for
// RTT/RTO and Unix uses for load average) and judge deviations relative to that
// band, so a steady residential node and a datacenter box are both scored fairly.
// A single self-healing `stability_score` is the running verdict: good probes heal
// it toward 100, real deviations knock it down, and it recovers — a dynamic error
// budget rather than a brittle strike count. Availability (heartbeat continuity)
// and probe success-rate are separate hard floors so a node can't pass on a high
// score alone.

// Trial timing comes from CLI flags (see trial-config.ts): 24h in prod,
// overridable for testing. Re-exported here so trial-manager and tests import all
// trial constants from one place.
import { TRIAL_DURATION_MS, TRIAL_DISCONNECT_VOID_MS } from './trial-config.ts';
export { TRIAL_DURATION_MS };
// A continuous heartbeat gap this long voids the running trial (the node clearly
// went away) — it restarts fresh on reconnect and costs a strike. Shorter blips
// only dent the score.
export const DISCONNECT_VOID_MS = TRIAL_DISCONNECT_VOID_MS;
// Three voided/failed attempts and the node is unfit — discarded, must pay to join
// again. Adversarial failures (integrity/identity) bypass this and discard at once.
export const MAX_STRIKES = 3;
// The node sends a heartbeat every 30s over the control tunnel; expected-heartbeat
// count derives from this, which drives the continuity ratio.
export const HEARTBEAT_INTERVAL_MS = 30_000;

// ─── Scoring tuning (internal; calibratable under task #3) ──────────────────────
const SCORE_START = 75;
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const PASS_BAR = 60; // stability_score must be ≥ this at the deadline
const CONTINUITY_FLOOR = 0.95; // ≥95% of expected heartbeats must have arrived
const FETCH_SUCCESS_FLOOR = 0.9; // ≥90% of real-URL probes must have succeeded
const MIN_FETCH_SAMPLES = 3; // need at least a few probes to judge at all
const EWMA_ALPHA = 0.3; // smoothing for the learned latency/capacity band
const HEAL_PER_GOOD_FETCH = 3; // a healthy probe nudges the score back up
const FETCH_FAIL_PENALTY = 20; // a failed probe is a real deviation
const LATENCY_Z_TOLERANCE = 2; // only penalize latency beyond ~2σ of the node's own band
const LATENCY_PENALTY_PER_Z = 5;
const LATENCY_MAX_PENALTY = 15;
const RECONNECT_PENALTY = 8;
const CAPACITY_DROP_FRACTION = 0.25; // sustained-bench sample this far below its EWMA = throttling
const CAPACITY_PENALTY = 10;

export type TrialStatus = 'running' | 'passed' | 'failed' | 'voided' | 'discarded';

// The scorecard = the `node_trials` row. Timestamps are epoch milliseconds (this
// module and the scheduler use Date.now(); the rest of node_store uses seconds).
export interface TrialCard {
  node_id: string;
  attempt: number;
  strikes: number;
  started_at: number;
  deadline: number;
  hb_received: number;
  worst_gap_ms: number;
  last_hb_at: number | null;
  reconnects: number;
  ewma_latency: number | null;
  ewmv_latency: number | null;
  fetch_ok: number;
  fetch_total: number;
  ewma_capacity: number | null;
  stability_score: number;
  last_integrity_ok: number | null; // 1 | 0 | null (not yet checked)
  status: TrialStatus;
  updated_at: number;
}

export type TrialDecision =
  | { kind: 'continue' }
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }
  | { kind: 'void'; reason: string };

export type StrikeOutcome = 'restart' | 'discard';

const clampScore = (score: number): number => Math.max(SCORE_MIN, Math.min(SCORE_MAX, score));

/** A fresh scorecard for a new attempt. `strikes`/`attempt` carry across restarts
 *  (the whole point of counting to MAX_STRIKES); every measured field resets. */
export function newTrial(
  nodeId: string,
  opts: { now: number; durationMs?: number; attempt?: number; strikes?: number }
): TrialCard {
  const durationMs = opts.durationMs ?? TRIAL_DURATION_MS;
  return {
    node_id: nodeId,
    attempt: opts.attempt ?? 1,
    strikes: opts.strikes ?? 0,
    started_at: opts.now,
    deadline: opts.now + durationMs,
    hb_received: 0,
    worst_gap_ms: 0,
    last_hb_at: null,
    reconnects: 0,
    ewma_latency: null,
    ewmv_latency: null,
    fetch_ok: 0,
    fetch_total: 0,
    ewma_capacity: null,
    stability_score: SCORE_START,
    last_integrity_ok: null,
    status: 'running',
    updated_at: opts.now,
  };
}

/** Fold one heartbeat: bump the received count, track the worst gap, advance the
 *  clock. Heartbeats measure AVAILABILITY (continuity/gap), not the score. */
export function foldHeartbeat(card: TrialCard, now: number): TrialCard {
  const since = card.last_hb_at ?? card.started_at;
  const gap = Math.max(0, now - since);
  return {
    ...card,
    hb_received: card.hb_received + 1,
    worst_gap_ms: Math.max(card.worst_gap_ms, gap),
    last_hb_at: now,
    updated_at: now,
  };
}

/** Fold one real-URL fetch probe. Success heals the score and updates the learned
 *  latency band; an unusually slow-but-successful fetch is penalized relative to
 *  the node's OWN band (z-score); a failed fetch is a flat penalty. */
export function foldFetch(
  card: TrialCard,
  probe: { ok: boolean; latencyMs: number },
  now: number
): TrialCard {
  let ewma = card.ewma_latency;
  let ewmv = card.ewmv_latency;
  let score = card.stability_score;

  if (probe.ok) {
    // Penalize against the node's own learned band before updating it.
    if (ewma != null && ewmv != null && ewmv > 0) {
      const z = (probe.latencyMs - ewma) / ewmv;
      if (z > LATENCY_Z_TOLERANCE) {
        score -= Math.min(LATENCY_MAX_PENALTY, (z - LATENCY_Z_TOLERANCE) * LATENCY_PENALTY_PER_Z);
      }
    }
    if (ewma == null || ewmv == null) {
      ewma = probe.latencyMs;
      ewmv = 0;
    } else {
      const dev = Math.abs(probe.latencyMs - ewma);
      ewma = EWMA_ALPHA * probe.latencyMs + (1 - EWMA_ALPHA) * ewma;
      ewmv = EWMA_ALPHA * dev + (1 - EWMA_ALPHA) * ewmv;
    }
    score += HEAL_PER_GOOD_FETCH;
  } else {
    score -= FETCH_FAIL_PENALTY;
  }

  return {
    ...card,
    fetch_ok: card.fetch_ok + (probe.ok ? 1 : 0),
    fetch_total: card.fetch_total + 1,
    ewma_latency: ewma,
    ewmv_latency: ewmv,
    stability_score: clampScore(score),
    updated_at: now,
  };
}

/** Fold an occasional sustained-bench sample. Real-URL fetches can't see compute
 *  headroom, so this catches thermal throttling / oversubscription over the day:
 *  a sample far below the node's learned capacity docks the score. */
export function foldCapacity(card: TrialCard, capacityReqS: number, now: number): TrialCard {
  let score = card.stability_score;
  if (card.ewma_capacity != null && capacityReqS < card.ewma_capacity * (1 - CAPACITY_DROP_FRACTION)) {
    score -= CAPACITY_PENALTY;
  }
  const ewma =
    card.ewma_capacity == null
      ? capacityReqS
      : EWMA_ALPHA * capacityReqS + (1 - EWMA_ALPHA) * card.ewma_capacity;
  return { ...card, ewma_capacity: ewma, stability_score: clampScore(score), updated_at: now };
}

/** A control-tunnel drop during trial. Occasional reconnects are tolerated (the
 *  score absorbs them); a storm of them tanks it. */
export function foldReconnect(card: TrialCard, now: number): TrialCard {
  return {
    ...card,
    reconnects: card.reconnects + 1,
    stability_score: clampScore(card.stability_score - RECONNECT_PENALTY),
    updated_at: now,
  };
}

/** Record a re-attestation result. Integrity is a HARD gate handled by the caller
 *  (a false result → immediate discard, bypassing strikes); this only stamps the
 *  latest outcome onto the card for observability. */
export function foldIntegrity(card: TrialCard, ok: boolean, now: number): TrialCard {
  return { ...card, last_integrity_ok: ok ? 1 : 0, updated_at: now };
}

/** Heartbeats we'd expect by `now` given the 30s cadence and elapsed connected
 *  time (capped at the deadline). */
export function expectedHeartbeats(card: TrialCard, now: number): number {
  const elapsed = Math.min(now, card.deadline) - card.started_at;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / HEARTBEAT_INTERVAL_MS);
}

/** Fraction of expected heartbeats actually received (1 before any are expected). */
export function continuity(card: TrialCard, now: number): number {
  const expected = expectedHeartbeats(card, now);
  if (expected <= 0) return 1;
  return Math.min(1, card.hb_received / expected);
}

/** The running verdict. Void takes precedence (a long disconnect invalidates the
 *  attempt); otherwise nothing happens until the deadline, at which point the node
 *  must clear every hard floor AND the stability bar. */
export function evaluate(card: TrialCard, now: number, voidMs: number = DISCONNECT_VOID_MS): TrialDecision {
  const since = card.last_hb_at ?? card.started_at;
  const gap = now - since;
  if (gap >= voidMs) {
    return { kind: 'void', reason: `no heartbeat for ${Math.round(gap / 1000)}s (≥ ${Math.round(voidMs / 1000)}s void threshold)` };
  }
  if (now < card.deadline) return { kind: 'continue' };

  const cont = continuity(card, now);
  if (cont < CONTINUITY_FLOOR) {
    return { kind: 'fail', reason: `heartbeat continuity ${(cont * 100).toFixed(1)}% < ${(CONTINUITY_FLOOR * 100).toFixed(0)}% floor` };
  }
  if (card.fetch_total < MIN_FETCH_SAMPLES) {
    return { kind: 'fail', reason: `only ${card.fetch_total} probe samples (< ${MIN_FETCH_SAMPLES} minimum)` };
  }
  const successRate = card.fetch_ok / card.fetch_total;
  if (successRate < FETCH_SUCCESS_FLOOR) {
    return { kind: 'fail', reason: `probe success ${(successRate * 100).toFixed(1)}% < ${(FETCH_SUCCESS_FLOOR * 100).toFixed(0)}% floor` };
  }
  if (card.stability_score < PASS_BAR) {
    return { kind: 'fail', reason: `stability score ${card.stability_score.toFixed(1)} < ${PASS_BAR} pass bar` };
  }
  return { kind: 'pass' };
}

/** Apply a void/fail outcome: increment strikes, stamp the terminal-for-this-
 *  attempt status, and decide whether the node restarts a fresh trial or is
 *  discarded. Pure — the caller persists the returned card and acts on `outcome`. */
export function registerStrike(card: TrialCard, kind: 'void' | 'fail', now: number): { card: TrialCard; outcome: StrikeOutcome } {
  const strikes = card.strikes + 1;
  const outcome: StrikeOutcome = strikes >= MAX_STRIKES ? 'discard' : 'restart';
  return {
    card: { ...card, strikes, status: kind === 'void' ? 'voided' : 'failed', updated_at: now },
    outcome,
  };
}
