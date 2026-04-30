import crypto from 'crypto';

const BENCHMARK_CONFIG = {
  fetch: {
    max_avg_latency_ms: 2000,
    max_p95_latency_ms: 3500,
    min_success_rate: 0.8,
    test_urls: [
      'https://httpbin.org/json',
      'https://api.github.com/zen',
      'https://jsonplaceholder.typicode.com/posts/1',
    ],
    iterations: 9,
  },
  cpu: {
    min_hashes_per_second: 5000,
    iterations: 5000,
  },
  memory: {
    min_allocated_mb: 128,
  },
  min_total_score: 80,
};

export async function benchmarkNode(nodeTestEndpoint) {
  console.log('Running node benchmark tests...\n');

  try {
    const fetchResults = await testFetchPerformance(nodeTestEndpoint);
    console.log(`📡 Fetch test: ${fetchResults.grade} (${fetchResults.avg_latency_ms}ms avg)`);

    const cpuResults = await testCPUPerformance(nodeTestEndpoint);
    console.log(` CPU test: ${cpuResults.grade} (${cpuResults.hashes_per_second} h/s)`);
    const memResults = await testMemory(nodeTestEndpoint);
    console.log(` Memory test: ${memResults.grade} (${memResults.allocated_mb ?? 0}MB allocated)`);

    const score = calculateScore({ fetch: fetchResults, cpu: cpuResults, memory: memResults });
    const passed = score >= BENCHMARK_CONFIG.min_total_score;

    console.log(
      `\n${passed ? '✅' : '❌'} Overall score: ${score}/100 ${passed ? '(PASSED)' : '(FAILED)'}`
    );

    return {
      passed,
      score,
      timestamp: Date.now(),
      details: {
        fetch: fetchResults,
        cpu: cpuResults,
        memory: memResults,
      },
    };
  } catch (error) {
    console.error('Benchmark error:', error);
    return {
      passed: false,
      score: 0,
      error: error.message,
      timestamp: Date.now(),
    };
  }
}

async function testFetchPerformance(nodeEndpoint) {
  const { test_urls, iterations, max_avg_latency_ms, max_p95_latency_ms } = BENCHMARK_CONFIG.fetch;
  const latencies = [];
  let successful = 0;

  for (let i = 0; i < iterations; i++) {
    const testUrl = test_urls[i % test_urls.length];
    const start = Date.now();

    try {
      const response = await fetch(nodeEndpoint + '/benchmark/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_url: testUrl }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        successful++;
        latencies.push(Date.now() - start);
      } else {
        latencies.push(max_avg_latency_ms);
      }
    } catch (error) {
      latencies.push(max_avg_latency_ms);
    }
  }

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p95Latency = percentile(sortedLatencies, 0.95);
  const successRate = successful / iterations;

  const latencyScore = Math.max(0, 100 - (avgLatency / max_avg_latency_ms) * 100);
  const tailLatencyScore = Math.max(0, 100 - (p95Latency / max_p95_latency_ms) * 100);
  const reliabilityScore = successRate * 100;
  const fetchScore = latencyScore * 0.45 + tailLatencyScore * 0.25 + reliabilityScore * 0.3;

  return {
    avg_latency_ms: Math.round(avgLatency),
    p95_latency_ms: Math.round(p95Latency),
    success_rate: successRate,
    successful,
    failed: iterations - successful,
    grade: successRate < BENCHMARK_CONFIG.fetch.min_success_rate
      ? 'F'
      : avgLatency < 500 && p95Latency < 1000 ? 'A'
        : avgLatency < 1000 && p95Latency < 2000 ? 'B'
          : avgLatency < 2000 && p95Latency < 3500 ? 'C'
            : 'F',
    score: Math.round(fetchScore),
  };
}

async function testCPUPerformance(nodeEndpoint) {
  const { iterations, min_hashes_per_second } = BENCHMARK_CONFIG.cpu;
  const testData = crypto.randomBytes(512).toString('hex');

  try {
    const response = await fetch(nodeEndpoint + '/benchmark/cpu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iterations, data: testData }),
      signal: AbortSignal.timeout(10000),
    });

    const result = await response.json();
    const hashesPerSecond = result.hashes_per_second;

    const cpuScore = Math.min(100, (hashesPerSecond / min_hashes_per_second) * 50);

    return {
      hashes_per_second: Math.round(hashesPerSecond),
      duration_ms: result.duration_ms,
      grade:
        hashesPerSecond > 50000
          ? 'A'
          : hashesPerSecond > 20000
            ? 'B'
            : hashesPerSecond > 5000
              ? 'C'
              : 'F',
      score: Math.round(cpuScore),
    };
  } catch (error) {
    return {
      hashes_per_second: 0,
      error: error.message,
      grade: 'F',
      score: 0,
    };
  }
}

async function testMemory(nodeEndpoint) {
  const { min_allocated_mb } = BENCHMARK_CONFIG.memory;

  try {
    const response = await fetch(nodeEndpoint + '/benchmark/memory-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_size_mb: 256,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const result = await response.json();

    if (!result.success) {
      return {
        free_memory_mb: 0,
        can_allocate: false,
        error: result.error,
        grade: 'F',
        score: 0,
      };
    }
    const canAllocate = result.allocated_mb >= min_allocated_mb;
    const allocationTimeMs = result.duration_ms;

    let score = 0;
    if (canAllocate) {
      score = 100;
      if (allocationTimeMs > 1000) score = 80;
      if (allocationTimeMs > 2000) score = 60;
    }

    return {
      can_allocate: canAllocate,
      allocation_time_ms: allocationTimeMs,
      allocated_mb: result.allocated_mb,
      test_size_mb: result.requested_mb ?? 256,
      grade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'F',
      score,
    };
  } catch (error) {
    return {
      can_allocate: false,
      error: error.message,
      grade: 'F',
      score: 0,
    };
  }
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * p) - 1);
  return sortedValues[index];
}

function calculateScore(results) {
  const weights = {
    fetch: 0.6,
    cpu: 0.25,
    memory: 0.15,
  };

  const totalScore =
    results.fetch.score * weights.fetch +
    results.cpu.score * weights.cpu +
    results.memory.score * weights.memory;

  return Math.round(totalScore);
}

export { BENCHMARK_CONFIG };
