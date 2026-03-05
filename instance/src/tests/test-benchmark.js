import { benchmarkNode } from '../../../server/utils/benchmark.js';

console.log('🚀 Consensus Node Benchmark Test\n');
console.log('Testing benchmark utility against test node server...\n');
console.log('Make sure test-node-server.js is running on port 9090!\n');
console.log('='.repeat(60));
console.log('\n');

const TEST_ENDPOINT = 'http://localhost:9090';

async function runTest() {
  try {
    // Run the benchmark
    const result = await benchmarkNode(TEST_ENDPOINT);

    console.log('\n' + '='.repeat(60));
    console.log('\n📊 BENCHMARK RESULTS\n');
    console.log('='.repeat(60));
    console.log('\n');

    console.log(`Status: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Overall Score: ${result.score}/100`);
    console.log(`Timestamp: ${new Date(result.timestamp).toISOString()}`);

    if (result.error) {
      console.log(`Error: ${result.error}`);
    }

    if (result.details) {
      console.log('\n📡 Fetch Performance:');
      console.log(`   Grade: ${result.details.fetch.grade}`);
      console.log(`   Score: ${result.details.fetch.score}/100`);
      console.log(`   Avg Latency: ${result.details.fetch.avg_latency_ms}ms`);
      console.log(`   Success Rate: ${(result.details.fetch.success_rate * 100).toFixed(1)}%`);
      console.log(
        `   Successful: ${result.details.fetch.successful}/${result.details.fetch.successful + result.details.fetch.failed}`
      );

      console.log('\n⚙️  CPU Performance:');
      console.log(`   Grade: ${result.details.cpu.grade}`);
      console.log(`   Score: ${result.details.cpu.score}/100`);
      console.log(`   Hashes/Second: ${result.details.cpu.hashes_per_second.toLocaleString()}`);
      console.log(`   Duration: ${result.details.cpu.duration_ms}ms`);

      console.log('\n💾 Memory:');
      console.log(`   Grade: ${result.details.memory.grade}`);
      console.log(`   Score: ${result.details.memory.score}/100`);
      if (result.details.memory.can_allocate !== undefined) {
        console.log(`   Can Allocate: ${result.details.memory.can_allocate ? 'Yes ✓' : 'No ✗'}`);
        console.log(`   Test Size: ${result.details.memory.test_size_mb}MB`);
        console.log(`   Allocation Time: ${result.details.memory.allocation_time_ms}ms`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('\n');

    if (result.passed) {
      console.log('✅ This node meets the minimum requirements!\n');
      console.log('Requirements:');
      console.log('   • Fetch latency < 2000ms ✓');
      console.log('   • CPU > 5000 hashes/sec ✓');
      console.log('   • Memory > 256MB free ✓');
      console.log('   • Overall score > 80/100 ✓');
    } else {
      console.log('❌ This node does NOT meet minimum requirements.\n');
      console.log('Requirements:');
      console.log('   • Fetch latency < 2000ms');
      console.log('   • CPU > 5000 hashes/sec');
      console.log('   • Memory > 256MB free');
      console.log('   • Overall score > 80/100');
      console.log('\nPlease improve hardware or network conditions and try again.');
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runTest();
