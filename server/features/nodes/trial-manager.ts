// The stability-trial scheduler. It reacts to control-tunnel events (a trial node
// connecting, heartbeating, disconnecting) and runs a periodic tick that drives
// real-URL fetch probes over the node's existing control tunnel, folds every
// signal through the pure logic in trial.ts, and acts on the verdict —
// graduating a node to 'active', restarting a voided/failed attempt, or discarding
// after three strikes.
//
// It is dependency-injected (store + requestProxy + isConnected + now) so the
// orchestration can be unit-tested without a DB or a live tunnel. In production
// server.js wires the real NodeStore and the node-tunnel handle.
//
// Fetch probes reuse the tunnel's existing PROXY_REQUEST path — the node already
// does a real, SSRF-guarded GET and returns the status — so this needs no
// node-side change. The occasional sustained-bench (thermal) and integrity
// re-attest probes come in a later step; the trial is already meaningful on
// availability + real-URL performance alone.

import { log } from '../../utils/log.ts';
import {
  newTrial,
  foldHeartbeat,
  foldFetch,
  foldReconnect,
  evaluate,
  registerStrike,
  foldCapacity,
  foldIntegrity,
  newMonitor,
  readyToRecover,
  MONITOR_QUARANTINE_FLOOR,
  MONITOR_QUARANTINE_GRACE_MS,
  TRIAL_DURATION_MS,
  type TrialCard,
} from './trial.ts';
import { TRIAL_PROBE_URLS } from './trial-config.ts';

// A rotating set of public, abuse-tolerant, SSRF-safe targets. Rotating spreads
// load (we never hammer one host), keeps a provider blip from skewing the verdict,
// and makes the probe harder to game. Override with TRIAL_PROBE_URLS (comma-sep).
const DEFAULT_PROBE_URLS = [
  'https://speed.cloudflare.com/__down?bytes=16384',
  'https://www.google.com/generate_204',
  'https://cloudflare.com/cdn-cgi/trace',
  'https://api.github.com/',
  'https://www.wikipedia.org/',
];

function probeUrls(): string[] {
  return TRIAL_PROBE_URLS ?? DEFAULT_PROBE_URLS;
}

// Aim for ~48 capacity/performance samples across the whole trial, but never probe
// more often than every 3s (dev short trials) or less than every 30min (prod).
const TARGET_PROBES = 48;
const PROBE_MIN_INTERVAL_MS = 3_000;
const PROBE_MAX_INTERVAL_MS = 30 * 60_000;
// Only forgive a boot gap if the orchestrator was down longer than this (a normal
// restart), so we don't shift trials over routine tick jitter.
const BOOT_DOWNTIME_MIN_MS = 2 * 60_000;
const LAST_TICK_KEY = 'trial_last_tick';

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

// A scorecard is "live" — probes fold into it — while a node is on trial, being
// monitored, or quarantined; not once it has reached a terminal state.
function isLiveCard(status: TrialCard['status']): boolean {
  return status === 'running' || status === 'monitoring' || status === 'quarantined';
}

function effectiveProbeIntervalMs(durationMs: number): number {
  return clamp(Math.floor(durationMs / TARGET_PROBES), PROBE_MIN_INTERVAL_MS, PROBE_MAX_INTERVAL_MS);
}

// The heavier sustained-bench (thermal) and integrity re-attest probes run much
// less often than the fetch probe — a few times across the whole trial.
const CAPACITY_SAMPLES_TARGET = 6;
const INTEGRITY_SAMPLES_TARGET = 3;

function capacityIntervalMs(durationMs: number): number {
  return clamp(Math.floor(durationMs / CAPACITY_SAMPLES_TARGET), 30_000, 6 * 60 * 60 * 1000);
}
function integrityIntervalMs(durationMs: number): number {
  return clamp(Math.floor(durationMs / INTEGRITY_SAMPLES_TARGET), 60_000, 8 * 60 * 60 * 1000);
}

// Tick often enough to fire probes on schedule and catch voids promptly: ~15s in
// prod, a few seconds for short dev trials (so a full trial is watchable in
// minutes). Void detection latency is bounded by this, which is fine against a 1h
// void threshold.
export function schedulerTickMs(durationMs: number = TRIAL_DURATION_MS): number {
  return clamp(Math.min(15_000, effectiveProbeIntervalMs(durationMs)), 1_000, 15_000);
}

// The subset of NodeStore the manager touches — declared so tests can supply a fake.
export interface TrialStore {
  getNode(id: string): { status: string } | null;
  getTrial(nodeId: string): TrialCard | null;
  saveTrial(card: TrialCard): unknown;
  listRunningTrials(): TrialCard[];
  listMonitoredNodes(): TrialCard[];
  setNodeStatus(id: string, status: string): unknown;
  deleteNode(id: string): unknown;
  deleteTrial(nodeId: string): unknown;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): unknown;
}

export interface TrialManagerDeps {
  store: TrialStore;
  // Send a real-URL fetch over the node's control tunnel; resolves with its status.
  requestProxy: (
    nodeId: string,
    input: { target_url: string; method: string }
  ) => Promise<{ status: number }>;
  // Is the node's control tunnel currently connected?
  isConnected: (nodeId: string) => boolean;
  // Optional heavier probes over the control tunnel (need node-side support). When
  // absent, the trial runs on availability + real-URL fetch alone.
  runSustainedProbe?: (nodeId: string) => Promise<{ capacity_req_s: number | null }>;
  reattestIntegrity?: (nodeId: string) => Promise<{ ok: boolean; reason?: string }>;
  now?: () => number;
  urls?: string[];
}

export interface TrialListeners {
  onConnect: (nodeId: string) => void;
  onHeartbeat: (nodeId: string) => void;
  onDisconnect: (nodeId: string) => void;
}

export class TrialManager {
  private readonly store: TrialStore;
  private readonly requestProxy: TrialManagerDeps['requestProxy'];
  private readonly isConnected: (nodeId: string) => boolean;
  private readonly now: () => number;
  private readonly urls: string[];
  private readonly lastProbeAt = new Map<string, number>();
  private readonly lastCapacityAt = new Map<string, number>();
  private readonly lastIntegrityAt = new Map<string, number>();
  // Per-node timestamp of when a monitored node's score first dropped below the
  // quarantine floor; cleared when it recovers. Quarantine needs this to persist
  // across the grace window (in-memory, so an orchestrator restart resets it —
  // erring toward NOT quarantining, which suits the high bar).
  private readonly belowFloorSince = new Map<string, number>();
  private readonly runSustainedProbe?: TrialManagerDeps['runSustainedProbe'];
  private readonly reattestIntegrity?: TrialManagerDeps['reattestIntegrity'];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: TrialManagerDeps) {
    this.store = deps.store;
    this.requestProxy = deps.requestProxy;
    this.isConnected = deps.isConnected;
    this.now = deps.now ?? Date.now;
    this.urls = deps.urls ?? probeUrls();
    this.runSustainedProbe = deps.runSustainedProbe;
    this.reattestIntegrity = deps.reattestIntegrity;
  }

  /** The hooks node-tunnel.ts calls on control-tunnel lifecycle events. */
  listeners(): TrialListeners {
    return {
      onConnect: (id) => this.onConnect(id),
      onHeartbeat: (id) => this.onHeartbeat(id),
      onDisconnect: (id) => this.onDisconnect(id),
    };
  }

  // A trial node's control tunnel came up: start a fresh trial, or fold a reconnect
  // into a running one. Non-trial nodes (already active, or the server itself) are
  // ignored.
  onConnect(nodeId: string): void {
    const node = this.store.getNode(nodeId);
    if (!node || node.status !== 'trial') return;
    const now = this.now();
    const card = this.store.getTrial(nodeId);
    if (!card) {
      this.store.saveTrial(newTrial(nodeId, { now }));
      log.info('trial', 'started', { node_id: nodeId });
      return;
    }
    if (card.status === 'running') {
      this.store.saveTrial(foldReconnect(card, now));
      return;
    }
    // Terminal card but the node is still on trial (defensive) — start fresh,
    // carrying the strike count and bumping the attempt.
    this.store.saveTrial(newTrial(nodeId, { now, attempt: card.attempt + 1, strikes: card.strikes }));
  }

  onHeartbeat(nodeId: string): void {
    const card = this.store.getTrial(nodeId);
    if (card && card.status === 'running') {
      this.store.saveTrial(foldHeartbeat(card, this.now()));
    }
  }

  // Disconnects are judged by the tick (a gap past the void threshold voids the
  // attempt); nothing to do synchronously.
  onDisconnect(_nodeId: string): void {}

  /** One scheduler pass: probe + evaluate every running trial, then stamp the tick. */
  async tick(): Promise<void> {
    const onError = (card: TrialCard) => (error: unknown) => {
      log.error('trial', 'process-failed', {
        node_id: card.node_id,
        message: error instanceof Error ? error.message : String(error),
      });
    };
    const running = this.store.listRunningTrials();
    const monitored = this.store.listMonitoredNodes();
    await Promise.all([
      ...running.map((card) => this.processTrial(card).catch(onError(card))),
      ...monitored.map((card) => this.processMonitor(card).catch(onError(card))),
    ]);
    this.store.setMeta(LAST_TICK_KEY, String(this.now()));
  }

  private async processTrial(card: TrialCard): Promise<void> {
    const node = this.store.getNode(card.node_id);
    // Orphaned (node gone) or already moved on (graduated/failed elsewhere): drop
    // the stale trial row.
    if (!node || node.status !== 'trial') {
      this.store.deleteTrial(card.node_id);
      this.clearProbeState(card.node_id);
      return;
    }

    if (await this.runDueProbes(card.node_id, card)) return; // integrity breach → discarded

    // Re-read: the probes (and any concurrent heartbeat fold) mutated the row.
    const fresh = this.store.getTrial(card.node_id);
    if (!fresh || fresh.status !== 'running') return;
    this.act(fresh, evaluate(fresh, this.now()));
  }

  // Post-join watch of an ACTIVE (or quarantined) node — same probes, lighter
  // cadence (the monitoring card's far-future deadline pins the intervals at their
  // caps), acting on quarantine/recovery instead of graduation.
  private async processMonitor(card: TrialCard): Promise<void> {
    const node = this.store.getNode(card.node_id);
    if (!node) {
      this.store.deleteTrial(card.node_id);
      this.clearProbeState(card.node_id);
      return;
    }
    // Node left the monitorable set (e.g. entered the update lifecycle) — drop the row.
    if (node.status !== 'active' && node.status !== 'quarantined') {
      this.store.deleteTrial(card.node_id);
      this.clearProbeState(card.node_id);
      return;
    }

    if (await this.runDueProbes(card.node_id, card)) return; // integrity breach → discarded

    const fresh = this.store.getTrial(card.node_id);
    if (!fresh || (fresh.status !== 'monitoring' && fresh.status !== 'quarantined')) return;
    this.monitorAct(node.status, fresh);
  }

  // Runs any due probes over the tunnel. Returns true if an integrity breach
  // discarded the node (the caller should stop). Shared by trial + monitoring.
  private async runDueProbes(nodeId: string, card: TrialCard): Promise<boolean> {
    if (!this.isConnected(nodeId)) return false;
    if (this.probeDue(card)) {
      await this.runFetchProbe(nodeId, card.fetch_total);
    }
    if (this.runSustainedProbe && this.capacityDue(card)) {
      await this.runCapacityProbe(nodeId);
    }
    if (this.reattestIntegrity && this.integrityDue(card)) {
      return await this.runIntegrityProbe(nodeId);
    }
    return false;
  }

  // Quarantine an active node ONLY after its score has stayed below the floor
  // continuously for the grace window (never on a transient dip); restore a
  // quarantined node once it climbs back to the higher recovery floor.
  private monitorAct(nodeStatus: string, card: TrialCard): void {
    const now = this.now();
    if (nodeStatus === 'active') {
      if (card.stability_score < MONITOR_QUARANTINE_FLOOR) {
        const since = this.belowFloorSince.get(card.node_id);
        if (since == null) {
          this.belowFloorSince.set(card.node_id, now); // start the grace clock
          return;
        }
        if (now - since >= MONITOR_QUARANTINE_GRACE_MS) {
          this.store.setNodeStatus(card.node_id, 'quarantined');
          this.store.saveTrial({ ...card, status: 'quarantined', updated_at: now });
          this.belowFloorSince.delete(card.node_id);
          log.warn('trial', 'quarantined', {
            node_id: card.node_id,
            score: Math.round(card.stability_score),
            floor: MONITOR_QUARANTINE_FLOOR,
            sustained_ms: now - since,
          });
        }
      } else {
        this.belowFloorSince.delete(card.node_id); // healthy again — reset the grace clock
      }
      return;
    }
    // quarantined → recover once healthy (hysteresis via the higher recovery floor)
    if (readyToRecover(card)) {
      this.store.setNodeStatus(card.node_id, 'active');
      this.store.saveTrial({ ...card, status: 'monitoring', updated_at: now });
      log.info('trial', 'recovered', { node_id: card.node_id, score: Math.round(card.stability_score) });
    }
  }

  private probeDue(card: TrialCard): boolean {
    const last = this.lastProbeAt.get(card.node_id) ?? 0;
    return this.now() - last >= effectiveProbeIntervalMs(card.deadline - card.started_at);
  }

  private async runFetchProbe(nodeId: string, fetchTotal: number): Promise<void> {
    const url = this.urls[fetchTotal % this.urls.length];
    const t0 = this.now();
    let ok = false;
    try {
      const response = await this.requestProxy(nodeId, { target_url: url, method: 'GET' });
      ok = response.status >= 200 && response.status < 400;
    } catch {
      ok = false; // timeout, tunnel drop, SSRF refusal — all count as a failed probe
    }
    const latencyMs = this.now() - t0;
    this.lastProbeAt.set(nodeId, this.now());

    const card = this.store.getTrial(nodeId);
    if (!card || !isLiveCard(card.status)) return;
    this.store.saveTrial(foldFetch(card, { ok, latencyMs }, this.now()));
  }

  private capacityDue(card: TrialCard): boolean {
    const last = this.lastCapacityAt.get(card.node_id) ?? 0;
    return this.now() - last >= capacityIntervalMs(card.deadline - card.started_at);
  }

  private integrityDue(card: TrialCard): boolean {
    const last = this.lastIntegrityAt.get(card.node_id) ?? 0;
    return this.now() - last >= integrityIntervalMs(card.deadline - card.started_at);
  }

  // Occasional sustained-bench sample → capacity EWMA (thermal / oversubscription
  // that a fetch can't see).
  private async runCapacityProbe(nodeId: string): Promise<void> {
    this.lastCapacityAt.set(nodeId, this.now()); // set before await so a failure still respects the interval
    let capacity: number | null = null;
    try {
      const result = await this.runSustainedProbe!(nodeId);
      capacity = result.capacity_req_s;
    } catch {
      return; // transient tunnel/probe error — try again next interval
    }
    if (capacity == null) return;
    const card = this.store.getTrial(nodeId);
    if (!card || !isLiveCard(card.status)) return;
    this.store.saveTrial(foldCapacity(card, capacity, this.now()));
  }

  // Integrity re-attestation — a HARD gate. A verified failure (swapped binary /
  // changed identity) discards the node immediately, bypassing the strike budget.
  // Returns true if the node was discarded. A transient tunnel error is not a
  // failure; it just retries next interval.
  private async runIntegrityProbe(nodeId: string): Promise<boolean> {
    this.lastIntegrityAt.set(nodeId, this.now());
    let verdict: { ok: boolean; reason?: string };
    try {
      verdict = await this.reattestIntegrity!(nodeId);
    } catch {
      return false;
    }
    const card = this.store.getTrial(nodeId);
    if (!card || !isLiveCard(card.status)) return false;
    if (!verdict.ok) {
      this.store.saveTrial(foldIntegrity(card, false, this.now()));
      this.store.deleteNode(nodeId);
      this.clearProbeState(nodeId);
      log.warn('trial', 'integrity-breach-discard', { node_id: nodeId, reason: verdict.reason });
      return true;
    }
    this.store.saveTrial(foldIntegrity(card, true, this.now()));
    return false;
  }

  private clearProbeState(nodeId: string): void {
    this.lastProbeAt.delete(nodeId);
    this.lastCapacityAt.delete(nodeId);
    this.lastIntegrityAt.delete(nodeId);
    this.belowFloorSince.delete(nodeId);
  }

  private act(card: TrialCard, decision: ReturnType<typeof evaluate>): void {
    if (decision.kind === 'continue') return;
    const now = this.now();

    if (decision.kind === 'pass') {
      this.store.setNodeStatus(card.node_id, 'active');
      // Graduated: hand the node to ongoing post-join monitoring (task #11).
      this.store.saveTrial(newMonitor(card.node_id, { now }));
      this.clearProbeState(card.node_id);
      log.info('trial', 'graduated', {
        node_id: card.node_id,
        attempt: card.attempt,
        stability_score: Math.round(card.stability_score),
      });
      return;
    }

    const { card: struck, outcome } = registerStrike(card, decision.kind, now);
    this.store.saveTrial(struck);
    this.clearProbeState(card.node_id);

    if (outcome === 'discard') {
      this.store.deleteNode(card.node_id);
      log.warn('trial', 'discarded', {
        node_id: card.node_id,
        kind: decision.kind,
        strikes: struck.strikes,
        reason: decision.reason,
      });
      return;
    }

    // Restart a fresh attempt, carrying the (incremented) strike count.
    this.store.saveTrial(newTrial(card.node_id, { now, attempt: struck.attempt + 1, strikes: struck.strikes }));
    log.warn('trial', 'restarted', {
      node_id: card.node_id,
      kind: decision.kind,
      attempt: struck.attempt + 1,
      strikes: struck.strikes,
      reason: decision.reason,
    });
  }

  // On boot, slide every in-flight trial forward by however long the orchestrator
  // was down, so that downtime counts against neither the deadline nor the node's
  // heartbeat continuity (the node isn't at fault for the orchestrator restarting).
  resumeAfterDowntime(): void {
    const lastRaw = this.store.getMeta(LAST_TICK_KEY);
    if (!lastRaw) return;
    const now = this.now();
    const downtime = now - Number(lastRaw);
    if (!Number.isFinite(downtime) || downtime < BOOT_DOWNTIME_MIN_MS) return;

    const running = this.store.listRunningTrials();
    for (const card of running) {
      this.store.saveTrial({
        ...card,
        started_at: card.started_at + downtime,
        deadline: card.deadline + downtime,
        last_hb_at: card.last_hb_at == null ? null : card.last_hb_at + downtime,
        updated_at: now,
      });
    }
    if (running.length > 0) {
      log.info('trial', 'resumed-after-downtime', { downtime_ms: downtime, trials: running.length });
    }
  }

  /** Begin the periodic tick. Forgives any boot downtime first. */
  start(): this {
    this.resumeAfterDowntime();
    const ms = schedulerTickMs();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        log.error('trial', 'tick-failed', { message: error instanceof Error ? error.message : String(error) });
      });
    }, ms);
    this.timer.unref?.();
    log.info('trial', 'scheduler-started', { tick_ms: ms, duration_ms: TRIAL_DURATION_MS });
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
