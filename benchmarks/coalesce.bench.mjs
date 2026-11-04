import { bench, do_not_optimize, run } from 'mitata';
import { serializeKey, SingleFlight } from '../dist/index.js';

const CALLER_COUNT = 200;
const IO_LATENCY_MS = 10;
const FLIGHT_KEY = 'benchmark:record:1';

const keyInput = {
  account: {
    id: 'acct_42',
    roles: ['admin', 'reader'],
  },
  amount: 12345678901234567890n,
  metadata: new Map([
    ['region', 'eu-west-1'],
    ['flags', new Set(['beta', 'v2'])],
  ]),
};

const benchmarkExecutionsWithoutCoalescing = { value: 0 };
const benchmarkExecutionsWithSingleFlight = { value: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulatedDb(counter) {
  counter.value += 1;
  await sleep(IO_LATENCY_MS);
  return { id: 'record-1', status: 'ready' };
}

async function runWithoutCoalescing(counter) {
  const responses = await Promise.all(
    Array.from({ length: CALLER_COUNT }, () => simulatedDb(counter)),
  );
  return do_not_optimize(responses.length);
}

const flight = new SingleFlight();

async function runWithSingleFlight(counter) {
  const responses = await Promise.all(
    Array.from({ length: CALLER_COUNT }, () =>
      flight.do(FLIGHT_KEY, () => simulatedDb(counter)),
    ),
  );
  return do_not_optimize(responses.length);
}

bench('serializeKey: nested object + BigInt + Map', () =>
  do_not_optimize(serializeKey(keyInput)),
);

bench('200 callers: without coalescing', () =>
  runWithoutCoalescing(benchmarkExecutionsWithoutCoalescing),
);

bench('200 callers: with SingleFlight', () =>
  runWithSingleFlight(benchmarkExecutionsWithSingleFlight),
);

function formatBytes(bytes) {
  const sign = bytes < 0 ? '-' : '+';
  const absolute = Math.abs(bytes);
  if (absolute < 1024) return `${sign}${absolute} B`;
  if (absolute < 1024 ** 2) return `${sign}${(absolute / 1024).toFixed(2)} KiB`;
  return `${sign}${(absolute / 1024 ** 2).toFixed(2)} MiB`;
}

function formatDuration(nanoseconds) {
  if (nanoseconds < 1_000) return `${nanoseconds.toFixed(2)} ns`;
  if (nanoseconds < 1_000_000) return `${(nanoseconds / 1_000).toFixed(2)} µs`;
  if (nanoseconds < 1_000_000_000) return `${(nanoseconds / 1_000_000).toFixed(2)} ms`;
  return `${(nanoseconds / 1_000_000_000).toFixed(2)} s`;
}

async function measureBurst(name, runner) {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const counter = { value: 0 };
  const startedAt = performance.now();
  await runner(counter);
  const elapsedMs = performance.now() - startedAt;
  const after = process.memoryUsage().heapUsed;

  return {
    name,
    upstreamExecutions: counter.value,
    memoryDelta: after - before,
    elapsedMs,
  };
}

const mitataResult = await run({ colors: false });
const burstResults = [
  await measureBurst('without coalescing', runWithoutCoalescing),
  await measureBurst('with SingleFlight', runWithSingleFlight),
];

console.log('\nMitata throughput / latency summary');
console.log('| Benchmark | Average latency | Approx. throughput |');
console.log('| --- | ---: | ---: |');
for (const benchmark of mitataResult.benchmarks) {
  for (const result of benchmark.runs) {
    if (result.error) continue;
    const averageLatency = result.stats.avg;
    console.log(
      `| ${result.name} | ${formatDuration(averageLatency)} | ${(1e9 / averageLatency).toFixed(2)} ops/s |`,
    );
  }
}

console.log('\nCoalescing summary (one 200-caller burst)');
console.log('| Scenario | Upstream DB executions | Heap delta | Burst latency |');
console.log('| --- | ---: | ---: | ---: |');
for (const result of burstResults) {
  console.log(
    `| ${result.name} | ${result.upstreamExecutions} | ${formatBytes(result.memoryDelta)} | ${result.elapsedMs.toFixed(2)} ms |`,
  );
}

console.log('\nUpstream executions during Mitata run');
console.log(`- Without coalescing: ${benchmarkExecutionsWithoutCoalescing.value}`);
console.log(`- With SingleFlight: ${benchmarkExecutionsWithSingleFlight.value}`);
console.log(`- Callers per measured operation: ${CALLER_COUNT}`);
console.log(`- Simulated upstream latency: ${IO_LATENCY_MS} ms`);
console.log(`- Mitata benchmarks: ${mitataResult.benchmarks.length}`);
