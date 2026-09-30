import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { runCase } from "../framework/runner.mjs";
import { performanceMode } from "../framework/performance-runtime.mjs";
import adapter, { PERFORMANCE_SCENARIO_IDS } from "./adapter.mjs";

const options = parse(process.argv.slice(2));
const contract = JSON.parse(await readFile(new URL("contract.json", import.meta.url), "utf8"));
const common = {
  ...options,
  task: "coldchaincontrol",
  adapter,
  contract,
  workspace: process.env.WORKSPACE ?? "/workspace",
  allowNonScoring: process.env.BENCH_ALLOW_NON_SCORING === "1",
};

const result = options.case === "H-12"
  ? await runFiveScenarioPerformance(common)
  : options.case === "H-02"
    ? await runContractSecurity(common)
    : await runCase(common);
console.log(JSON.stringify(result));

async function runContractSecurity(input) {
  const baseline = await runCase(input);
  const supplement = await runCase({ ...input, case: "coldchain-contract-security" });
  return {
    ...baseline,
    durationMs: baseline.durationMs + supplement.durationMs,
    assertions: [...baseline.assertions, ...supplement.assertions],
    supplements: [{ caseId: supplement.caseId, durationMs: supplement.durationMs }],
  };
}

async function runFiveScenarioPerformance(input) {
  const privateCase = "five-scenario-performance";
  const { scale, nonScoring } = performanceMode();
  assert.ok(!nonScoring || input.allowNonScoring, "BENCH_PERF_SCALE must equal 1 for scoring runs");
  const performanceAdapter = {
    ...adapter,
    cases: { ...adapter.cases, [privateCase]: adapter.cases["H-12"] },
  };
  const value = await runCase({ ...input, case: privateCase, adapter: performanceAdapter });
  const expected = contract.perfScenarios.map(({ id }) => id);
  assert.deepEqual(adapter.performanceScenarioIds, PERFORMANCE_SCENARIO_IDS);
  assert.deepEqual(expected, PERFORMANCE_SCENARIO_IDS);
  assert.deepEqual(value.metrics?.map(({ scenarioId }) => scenarioId), PERFORMANCE_SCENARIO_IDS);
  for (const scenario of contract.perfScenarios) {
    const metric = value.metrics.find(({ scenarioId }) => scenarioId === scenario.id);
    assert.ok(metric, `missing performance metric ${scenario.id}`);
    for (const field of ["completed", "durationMs", "throughput", "p50", "p95", "p99"]) {
      assert.ok(Number.isFinite(metric[field]) && metric[field] >= 0, `${scenario.id}.${field} must be a non-negative number`);
    }
    assert.ok(metric.statuses && typeof metric.statuses === "object" && !Array.isArray(metric.statuses), `${scenario.id}.statuses must be an object`);
    if (!nonScoring) assertThresholds(scenario, metric);
  }
  return { ...value, caseId: "H-12", performanceScale: scale, nonScoring };
}

function assertThresholds(scenario, metric) {
  if (scenario.minimumThroughput !== undefined) {
    assert.ok(metric.throughput >= scenario.minimumThroughput, `${scenario.id} throughput ${metric.throughput} < ${scenario.minimumThroughput}`);
  }
  if (scenario.maximumP95Ms !== undefined) {
    assert.ok(metric.p95 <= scenario.maximumP95Ms, `${scenario.id} p95 ${metric.p95}ms > ${scenario.maximumP95Ms}ms`);
  }
  if (scenario.maximumRecoveryMs !== undefined) {
    assert.ok(metric.recoveryMs <= scenario.maximumRecoveryMs, `${scenario.id} recovery ${metric.recoveryMs}ms > ${scenario.maximumRecoveryMs}ms`);
  }
  if (scenario.maximumQueueP95Ms !== undefined) {
    assert.ok(metric.queueP95Ms <= scenario.maximumQueueP95Ms, `${scenario.id} queue p95 ${metric.queueP95Ms}ms > ${scenario.maximumQueueP95Ms}ms`);
  }
}

function parse(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--case", "--snapshot"].includes(flag) || !value) throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
    parsed[flag.slice(2)] = value;
  }
  if (!/^H-(?:0[1-9]|1[0-9]|20)$/u.test(parsed.case ?? "")) throw new Error("--case H-01..H-20 is required");
  return parsed;
}
