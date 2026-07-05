import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAdmission,
  STEADY_RATIO_FLOOR,
  CPU_TIME_RATIO_FLOOR,
  MIN_SUSTAINED_FLOOR_REQ_S,
  type EvalResultsLike,
} from '../../features/node-tunnel/admission.ts';

// A healthy sustained run: holds throughput (throttle ~1), owns its core
// (cpu_time ~1), comfortably above the capacity floor.
function healthySustained(overrides: Record<string, number> = {}) {
  return {
    node_rps_mean: 4200,
    node_rps_min_window: 3900,
    throttle_ratio: 0.98,
    cpu_time_ratio: 0.99,
    steady: true,
    ...overrides,
  };
}

function results(parts: Partial<EvalResultsLike>): EvalResultsLike {
  return parts;
}

test('admits a stable node: sustained authority, capacity + floor from the run', () => {
  const verdict = deriveAdmission(
    results({
      benchmark_sustained: healthySustained(),
      benchmark_multicore: { effective_cores: 10.8 },
    })
  );
  assert.equal(verdict.stable, true);
  assert.equal(verdict.basis, 'sustained');
  assert.equal(verdict.capacity_req_s, 4200, 'ranks on sustained mean');
  assert.equal(verdict.floor_req_s, 3900, 'gates on slowest window');
  assert.equal(verdict.effective_cores, 10.8, 'passes multicore through');
  assert.deepEqual(verdict.blockers, []);
});

test('rejects a throttling node (burst credits / thermal)', () => {
  const verdict = deriveAdmission(
    results({ benchmark_sustained: healthySustained({ throttle_ratio: 0.7 }) })
  );
  assert.equal(verdict.stable, false);
  assert.equal(verdict.basis, 'sustained', 'the run happened — it just decayed');
  assert.ok(
    verdict.blockers.some((b) => b.includes('throttled') && b.includes(String(STEADY_RATIO_FLOOR))),
    'blocker names the throttle floor'
  );
});

test('rejects a shared core (hypervisor steal / contention)', () => {
  const verdict = deriveAdmission(
    results({ benchmark_sustained: healthySustained({ cpu_time_ratio: 0.6 }) })
  );
  assert.equal(verdict.stable, false);
  assert.ok(
    verdict.blockers.some((b) => b.includes('shared core') && b.includes(String(CPU_TIME_RATIO_FLOOR))),
    'blocker names the cpu-time floor'
  );
});

test('rejects a machine too slow to serve (floor below minimum)', () => {
  const verdict = deriveAdmission(
    results({ benchmark_sustained: healthySustained({ node_rps_mean: 40, node_rps_min_window: 10 }) })
  );
  assert.equal(verdict.stable, false);
  assert.ok(
    verdict.blockers.some((b) => b.includes('floor') && b.includes(String(MIN_SUSTAINED_FLOOR_REQ_S))),
    'blocker names the capacity floor'
  );
});

test('a machine can fail multiple checks at once (all blockers reported)', () => {
  const verdict = deriveAdmission(
    results({
      benchmark_sustained: healthySustained({
        throttle_ratio: 0.5,
        cpu_time_ratio: 0.5,
        node_rps_min_window: 5,
      }),
    })
  );
  assert.equal(verdict.stable, false);
  assert.equal(verdict.blockers.length, 3, 'throttle + shared-core + floor');
});

test('without a sustained run, a composite burst is an estimate, never admissible', () => {
  const verdict = deriveAdmission(
    results({
      benchmark_composite: {
        requests_per_second: 5000,
        results: [
          { response_size_bytes: 1024, node_requests_per_second: 9000 },
          { response_size_bytes: 16384, node_requests_per_second: 5000 },
        ],
      },
    })
  );
  assert.equal(verdict.stable, false);
  assert.equal(verdict.basis, 'burst');
  assert.equal(verdict.capacity_req_s, 5000, 'uses the 16KB composite figure');
  assert.equal(verdict.floor_req_s, 0);
  assert.ok(verdict.blockers[0].includes('sustained suite not run'));
});

test('with no CPU results at all, the verdict is missing (cannot admit)', () => {
  const verdict = deriveAdmission(results({}));
  assert.equal(verdict.stable, false);
  assert.equal(verdict.basis, 'missing');
  assert.equal(verdict.capacity_req_s, 0);
  assert.ok(verdict.blockers[0].includes('no CPU benchmark results'));
});
