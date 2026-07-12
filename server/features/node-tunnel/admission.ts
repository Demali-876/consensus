// Server-side admission verdict for the node eval. The candidate node runs the
// bench-cpu suites (composite / sustained / multicore) over the eval tunnel and
// reports the raw measurements; THIS module — running on the orchestrator — owns
// the thresholds and the admit/reject decision. That split is deliberate: the
// node is the measurement authority (only it can time its own CPU), but the
// network must not let a node decide its own admission, so the gate logic lives
// here, not there. It mirrors deriveAdmission() in consensus-node's bench-cpu.ts;
// the two must stay in agreement (shared validation vectors — see docs task 17).
//
// The metric: STABLE SUSTAINED node-side requests/sec at 16KB responses. 16KB is
// heavier than real traffic (~700-byte average), so a node never underperforms
// its rating. "Stable" means the windowed sustained run held its throughput on an
// owned core — burst-credit vCPUs and thermally throttled SBCs decay and fail
// here, which a short benchmark would never catch.

import { ADMISSION_FLOOR_REQ_S } from '../nodes/trial-config.ts';

// Late/early sustained throughput floor. Below this the machine slowed down
// across the window series — burst credits ran out or the SoC throttled.
export const STEADY_RATIO_FLOOR = 0.85;
// process CPU time / wall time floor. Below this the process was not getting a
// full core — hypervisor steal or host contention, not honest slow silicon.
export const CPU_TIME_RATIO_FLOOR = 0.9;
// Conservative capacity floor (slowest sustained window). Tunable via the
// --admission-floor-req-s flag (task #3) so it can be calibrated in production
// without a redeploy; the default stays permissive (any machine that can actually
// serve traffic clears it) and only rejects the truly incapable. Raise once real
// Pi + VPS eval readings give a data-backed number.
export const MIN_SUSTAINED_FLOOR_REQ_S = ADMISSION_FLOOR_REQ_S;

export type AdmissionBasis = 'sustained' | 'burst' | 'missing';

export interface AdmissionVerdict {
  metric: 'stable_sustained_16kb_req_s';
  /** Rank on this: mean node-side req/s across the sustained run. */
  capacity_req_s: number;
  /** Gate on this: the slowest sustained window (conservative floor). */
  floor_req_s: number;
  /** How many cores' worth of work the machine actually delivered (diagnostic). */
  effective_cores: number | null;
  /** 'sustained' = windowed authority; 'burst' = composite only; 'missing' = no CPU data. */
  basis: AdmissionBasis;
  /** true only when every admission check passed (no blockers). */
  stable: boolean;
  /** Why the node is not admissible-stable (empty when stable). */
  blockers: string[];
}

// The node-reported shapes we read. Loosely typed on purpose — the node is the
// source, the server validates the numbers, not the schema (same style as the
// rest of the eval scoring).
interface SustainedResultLike {
  node_rps_mean?: number;
  node_rps_min_window?: number;
  throttle_ratio?: number;
  cpu_time_ratio?: number;
  steady?: boolean;
}
interface CompositeResultLike {
  requests_per_second?: number;
  results?: Array<{ response_size_bytes?: number; node_requests_per_second?: number }>;
}
interface MultiCoreResultLike {
  effective_cores?: number;
}

export interface EvalResultsLike {
  benchmark_composite?: unknown;
  benchmark_sustained?: unknown;
  benchmark_multicore?: unknown;
}

/** Derive the admission verdict from the node-reported eval results. Pure and
 *  deterministic — the same inputs always yield the same verdict, which is what
 *  makes it testable and calibratable. */
export function deriveAdmission(results: EvalResultsLike): AdmissionVerdict {
  const sustained = results.benchmark_sustained as SustainedResultLike | undefined;
  const composite = results.benchmark_composite as CompositeResultLike | undefined;
  const multicore = results.benchmark_multicore as MultiCoreResultLike | undefined;

  const effectiveCores =
    typeof multicore?.effective_cores === 'number' ? multicore.effective_cores : null;
  const compositeCapacity = composite16kbReqS(composite);

  if (!sustained || typeof sustained.node_rps_mean !== 'number') {
    // No sustained run — a short composite burst is an estimate, never
    // admissible. (Distinct from 'missing' so the operator sees the difference.)
    return {
      metric: 'stable_sustained_16kb_req_s',
      capacity_req_s: Math.round(compositeCapacity ?? 0),
      floor_req_s: 0,
      effective_cores: effectiveCores,
      basis: compositeCapacity != null ? 'burst' : 'missing',
      stable: false,
      blockers: [
        compositeCapacity != null
          ? 'sustained suite not run — burst estimate only, not admissible'
          : 'no CPU benchmark results — cannot admit',
      ],
    };
  }

  const throttleRatio = Number(sustained.throttle_ratio ?? 0);
  const cpuTimeRatio = Number(sustained.cpu_time_ratio ?? 0);
  const capacity = Math.round(Number(sustained.node_rps_mean ?? 0));
  const floor = Math.round(Number(sustained.node_rps_min_window ?? 0));

  const blockers: string[] = [];
  if (throttleRatio < STEADY_RATIO_FLOOR) {
    blockers.push(
      `throttled: ratio ${throttleRatio} < ${STEADY_RATIO_FLOOR} (burst credits or thermal)`
    );
  }
  if (cpuTimeRatio < CPU_TIME_RATIO_FLOOR) {
    blockers.push(
      `shared core: cpu time ratio ${cpuTimeRatio} < ${CPU_TIME_RATIO_FLOOR} (steal/contention)`
    );
  }
  if (floor < MIN_SUSTAINED_FLOOR_REQ_S) {
    blockers.push(
      `capacity floor ${floor} req/s < minimum ${MIN_SUSTAINED_FLOOR_REQ_S} req/s (too slow to serve)`
    );
  }

  return {
    metric: 'stable_sustained_16kb_req_s',
    capacity_req_s: capacity,
    floor_req_s: floor,
    effective_cores: effectiveCores,
    basis: 'sustained',
    stable: blockers.length === 0,
    blockers,
  };
}

function composite16kbReqS(composite: CompositeResultLike | undefined): number | null {
  if (!composite) return null;
  const at16k = composite.results?.find((r) => r.response_size_bytes === 16384);
  if (typeof at16k?.node_requests_per_second === 'number') return at16k.node_requests_per_second;
  if (typeof composite.requests_per_second === 'number') return composite.requests_per_second;
  return null;
}
