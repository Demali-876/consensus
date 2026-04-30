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
  crypto: {
    min_total_bytes_per_second: 10 * 1024 * 1024,
    iterations: 750,
    payload_size_kb: 16,
  },
  concurrency: {
    min_success_rate: 0.9,
    max_p95_latency_ms: 3500,
    requests: 24,
    concurrency: 6,
  },
  memory: {
    min_allocated_mb: 128,
    max_retained_mb: 128,
    pressure_test_size_mb: 256,
    pressure_rounds: 3,
  },
  system: {
    min_total_memory_mb: 512,
    min_cpus: 2,
  },
  min_total_score: 75,
};

export async function benchmarkNode(nodeTestEndpoint) {
  console.log('Running node benchmark tests...\n');

  try {
    const fetchResults = await testFetchPerformance(nodeTestEndpoint);
    console.log(`📡 Fetch test: ${fetchResults.grade} (${fetchResults.avg_latency_ms}ms avg)`);

    const cpuResults = await testCPUPerformance(nodeTestEndpoint);
    console.log(` CPU test: ${cpuResults.grade} (${cpuResults.hashes_per_second} h/s)`);
    const cryptoResults = await testCryptoPerformance(nodeTestEndpoint);
    console.log(` Crypto test: ${cryptoResults.grade} (${formatBytesPerSecond(cryptoResults.total_bytes_per_second)})`);
    const concurrencyResults = await testConcurrency(nodeTestEndpoint);
    console.log(` Concurrency test: ${concurrencyResults.grade} (${concurrencyResults.successful}/${concurrencyResults.requests} ok, ${concurrencyResults.p95_latency_ms}ms p95)`);
    const memResults = await testMemory(nodeTestEndpoint);
    console.log(` Memory test: ${memResults.grade} (${memResults.allocated_mb ?? 0}MB allocated)`);
    const systemResults = await testSystem(nodeTestEndpoint);
    console.log(` System test: ${systemResults.grade} (${systemResults.cpus} cpu, ${systemResults.total_memory_mb}MB ram)`);

    const score = calculateScore({
      fetch: fetchResults,
      cpu: cpuResults,
      crypto: cryptoResults,
      concurrency: concurrencyResults,
      memory: memResults,
      system: systemResults,
    });
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
        crypto: cryptoResults,
        concurrency: concurrencyResults,
        memory: memResults,
        system: systemResults,
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

async function testCryptoPerformance(nodeEndpoint) {
  const { iterations, payload_size_kb, min_total_bytes_per_second } = BENCHMARK_CONFIG.crypto;

  try {
    const response = await fetch(nodeEndpoint + '/benchmark/crypto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iterations, payload_size_kb }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || `HTTP ${response.status}`);

    const throughput = Number(result.total_bytes_per_second ?? 0);
    const score = Math.min(100, (throughput / min_total_bytes_per_second) * 70);

    return {
      algorithm: result.algorithm,
      total_bytes_per_second: Math.round(throughput),
      encrypted_bytes_per_second: Math.round(Number(result.encrypted_bytes_per_second ?? 0)),
      decrypted_bytes_per_second: Math.round(Number(result.decrypted_bytes_per_second ?? 0)),
      duration_ms: result.duration_ms,
      iterations: result.iterations,
      payload_size_kb: result.payload_size_kb,
      grade:
        throughput > min_total_bytes_per_second * 3
          ? 'A'
          : throughput > min_total_bytes_per_second * 1.5
            ? 'B'
            : throughput >= min_total_bytes_per_second
              ? 'C'
              : 'F',
      score: Math.round(score),
    };
  } catch (error) {
    return {
      total_bytes_per_second: 0,
      error: error.message,
      grade: 'F',
      score: 0,
    };
  }
}

async function testConcurrency(nodeEndpoint) {
  const { requests, concurrency, min_success_rate, max_p95_latency_ms } = BENCHMARK_CONFIG.concurrency;

  try {
    const response = await fetch(nodeEndpoint + '/benchmark/concurrency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_urls: BENCHMARK_CONFIG.fetch.test_urls,
        requests,
        concurrency,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);

    const successRate = Number(result.success_rate ?? 0);
    const p95Latency = Number(result.p95_latency_ms ?? max_p95_latency_ms);
    const avgLatency = Number(result.avg_latency_ms ?? max_p95_latency_ms);
    const reliabilityScore = successRate * 100;
    const latencyScore = Math.max(0, 100 - (p95Latency / max_p95_latency_ms) * 100);
    const score = reliabilityScore * 0.65 + latencyScore * 0.35;

    return {
      requests: result.requests ?? requests,
      concurrency: result.concurrency ?? concurrency,
      successful: result.successful ?? 0,
      failed: result.failed ?? requests,
      success_rate: successRate,
      avg_latency_ms: Math.round(avgLatency),
      p95_latency_ms: Math.round(p95Latency),
      requests_per_second: Number(result.requests_per_second ?? 0),
      duration_ms: result.duration_ms,
      grade: successRate < min_success_rate
        ? 'F'
        : p95Latency < 1000 ? 'A'
          : p95Latency < 2000 ? 'B'
            : p95Latency < max_p95_latency_ms ? 'C'
              : 'F',
      score: Math.round(score),
    };
  } catch (error) {
    return {
      requests,
      concurrency,
      successful: 0,
      failed: requests,
      success_rate: 0,
      p95_latency_ms: max_p95_latency_ms,
      error: error.message,
      grade: 'F',
      score: 0,
    };
  }
}

async function testMemory(nodeEndpoint) {
  const { min_allocated_mb, max_retained_mb, pressure_test_size_mb, pressure_rounds } = BENCHMARK_CONFIG.memory;

  try {
    const response = await fetch(nodeEndpoint + '/benchmark/memory-pressure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_size_mb: pressure_test_size_mb,
        rounds: pressure_rounds,
      }),
      signal: AbortSignal.timeout(15000),
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
    const retainedMb = Number(result.rss_retained_mb ?? 0);

    let score = 0;
    if (canAllocate) {
      score = 100;
      if (allocationTimeMs > 1000) score = 80;
      if (allocationTimeMs > 2000) score = 60;
      if (retainedMb > max_retained_mb) score = Math.min(score, 70);
      if (retainedMb > max_retained_mb * 2) score = Math.min(score, 50);
    }

    return {
      can_allocate: canAllocate,
      allocation_time_ms: allocationTimeMs,
      allocated_mb: result.allocated_mb,
      test_size_mb: result.requested_mb ?? pressure_test_size_mb,
      rounds: result.rounds ?? pressure_rounds,
      rss_before_mb: result.rss_before_mb,
      rss_peak_mb: result.rss_peak_mb,
      rss_after_mb: result.rss_after_mb,
      rss_retained_mb: retainedMb,
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

async function testSystem(nodeEndpoint) {
  const { min_total_memory_mb, min_cpus } = BENCHMARK_CONFIG.system;

  try {
    const response = await fetch(nodeEndpoint + '/benchmark/system', {
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || `HTTP ${response.status}`);

    const totalMemoryMb = Math.round(Number(result.total_memory_bytes ?? 0) / 1024 / 1024);
    const freeMemoryMb = Math.round(Number(result.free_memory_bytes ?? 0) / 1024 / 1024);
    const cpus = Number(result.cpus ?? 0);
    const memoryScore = Math.min(100, (totalMemoryMb / min_total_memory_mb) * 60);
    const cpuScore = Math.min(100, (cpus / min_cpus) * 60);
    const score = Math.round(memoryScore * 0.55 + cpuScore * 0.45);

    return {
      platform: result.platform,
      arch: result.arch,
      cpus,
      total_memory_mb: totalMemoryMb,
      free_memory_mb: freeMemoryMb,
      uptime_seconds: result.uptime_seconds,
      bun_version: result.bun_version,
      grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'F',
      score,
    };
  } catch (error) {
    return {
      cpus: 0,
      total_memory_mb: 0,
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
    fetch: 0.3,
    crypto: 0.2,
    concurrency: 0.2,
    cpu: 0.1,
    memory: 0.15,
    system: 0.05,
  };

  const totalScore =
    results.fetch.score * weights.fetch +
    results.crypto.score * weights.crypto +
    results.concurrency.score * weights.concurrency +
    results.cpu.score * weights.cpu +
    results.memory.score * weights.memory +
    results.system.score * weights.system;

  return Math.round(totalScore);
}

function formatBytesPerSecond(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s';
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

export { BENCHMARK_CONFIG };
