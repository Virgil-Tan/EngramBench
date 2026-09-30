import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildPerformanceSeed } from "../cases/e.mjs";
import { createFixtureFactory } from "../lib/fixtures.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("fixed performance fixture has the published exact cardinalities and isolated execution queues", () => {
  const fixtures = createFixtureFactory({ evaluationSeed: "unit-seed", caseId: "E-03", baseTime: "2035-06-01T12:00:00.000Z" });
  const seed = buildPerformanceSeed(fixtures);
  assert.equal(seed.schemaVersion, 1);
  assert.equal(seed.seedVersion, "perf-v1");
  assert.deepEqual([
    seed.queues.length, seed.jobDefinitions.length, seed.runs.length,
    seed.attempts.length, seed.executionLeases.length,
  ], [100, 1_000, 27_000, 22_000, 2_000]);
  assert.deepEqual(Object.fromEntries([...Map.groupBy(seed.runs, ({ state }) => state)].map(([state, items]) => [state, items.length])), {
    SUCCEEDED: 20_000, QUEUED: 5_000, RUNNING: 2_000,
  });
  const queuedQueues = new Set(seed.runs.filter(({ state }) => state === "QUEUED").map(({ queueId }) => queueId));
  const recoveryQueues = new Set(seed.runs.filter(({ state }) => state === "RUNNING").map(({ queueId }) => queueId));
  assert.equal(queuedQueues.intersection(recoveryQueues).size, 0);
  assert.ok(seed.executionLeases.every(({ expiresAt }) => Date.parse(expiresAt) < Date.now()));
  const otherCaseFixtures = createFixtureFactory({ evaluationSeed: "unit-seed", caseId: "E-04", baseTime: "2035-06-01T12:00:00.000Z" });
  const sameFixedSeed = buildPerformanceSeed(otherCaseFixtures);
  assert.deepEqual(
    [sameFixedSeed.queues[0].queueId, sameFixedSeed.jobDefinitions[0].jobDefinitionId, sameFixedSeed.runs[0].runId, sameFixedSeed.executionLeases[0].leaseToken],
    [seed.queues[0].queueId, seed.jobDefinitions[0].jobDefinitionId, seed.runs[0].runId, seed.executionLeases[0].leaseToken],
  );
});

test("all-passed results score 100 and a declared QueueForge cap is enforced", () => {
  const passed = manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "0".repeat(64) }));
  const accepted = scoreEvaluation(manifest, contractMap, { cases: passed });
  assert.equal(accepted.verdict, "accepted");
  assert.equal(accepted.score, 100);
  const failed = passed.map((item) => item.id === "B-01" ? {
    ...item, status: "failed", privateFailureCode: "QF_B01_ASSERTION_FAILED", hardCapIds: ["DURABLE_IDEMPOTENCY"],
  } : item);
  const rejected = scoreEvaluation(manifest, contractMap, { cases: failed });
  assert.equal(rejected.verdict, "rejected");
  assert.equal(rejected.score, 30);
  assert.deepEqual(rejected.hardCapsApplied.map(({ id }) => id), ["DURABLE_IDEMPOTENCY"]);
});
