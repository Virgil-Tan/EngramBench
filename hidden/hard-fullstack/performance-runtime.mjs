import assert from "node:assert/strict";

export function performanceScale() {
  const scale = Number(process.env.BENCH_PERF_SCALE ?? 1);
  assert.ok(scale > 0 && scale <= 1, "BENCH_PERF_SCALE must be in (0,1]");
  return scale;
}

export function performanceMode() {
  const scale = performanceScale();
  return { scale, nonScoring: scale < 1 };
}

export function assertPerformanceScenarioIds(value, label = "performance scenario IDs") {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.length >= 3, `${label} must contain at least three IDs`);
  for (const id of value) {
    assert.equal(typeof id, "string", `${label} must contain strings`);
    assert.ok(id.trim().length > 0, `${label} must not contain empty IDs`);
  }
  assert.equal(new Set(value).size, value.length, `${label} must contain unique IDs`);
  return value;
}

export async function measuredLoad(ctx, { concurrency, warmupMs, measureMs, request }) {
  let collect = false;
  let completed = 0;
  const latencies = [];
  const statuses = new Map();
  const run = async (durationMs) => {
    const deadline = Date.now() + durationMs;
    await ctx.concurrent(Array.from({ length: concurrency }), concurrency, async (_, client) => {
      while (Date.now() < deadline) {
        const response = await request({ measured: collect, client });
        if (collect) {
          completed += 1;
          latencies.push(response.durationMs);
          statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        }
      }
    });
  };
  await run(warmupMs);
  collect = true;
  await run(measureMs);
  latencies.sort((left, right) => left - right);
  return {
    completed,
    throughput: completed / (measureMs / 1_000),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    statuses: Object.fromEntries(statuses),
  };
}

export function percentile(ordered, fraction) {
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}
