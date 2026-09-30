import assert from "node:assert/strict";
import test from "node:test";

import { CaseExcluded } from "../lib/execution.mjs";
import { E_CASES, assertRecoveryPromotions, percentile, runClosedLoop } from "../cases/e.mjs";

test("E registry exposes the seven frozen migration, performance, and hygiene cases", () => {
  assert.deepEqual(E_CASES.map(({ id }) => id), ["E-01", "E-02", "E-03", "E-04", "E-05", "E-06", "E-07"]);
  assert.equal(E_CASES.every(({ run }) => typeof run === "function"), true);
});

test("migration cases explicitly exclude FINAL-only samples", async () => {
  for (const item of E_CASES.slice(0, 3)) {
    await assert.rejects(item.run({ v1Workspace: undefined }), (error) => (
      error instanceof CaseExcluded && error.reason === "missing_v1_checkpoint"
    ));
  }
});

test("percentile uses the nearest-rank latency without mutating samples", () => {
  const samples = [9, 1, 5, 3, 7];
  assert.equal(percentile(samples, 0.5), 5);
  assert.equal(percentile(samples, 0.95), 9);
  assert.deepEqual(samples, [9, 1, 5, 3, 7]);
});

test("closed-loop runner keeps exact client concurrency and separates warm-up metrics", async () => {
  let active = 0;
  let peak = 0;
  const metrics = await runClosedLoop({
    concurrency: 4,
    warmupMs: 15,
    measureMs: 25,
    async operation({ phase, ordinal }) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { success: true, status: 200, latencyMs: ordinal % 3 + 1, phase };
    },
  });

  assert.equal(peak, 4);
  assert.ok(metrics.warmup.attempts > 0);
  assert.ok(metrics.measured.attempts > 0);
  assert.ok(metrics.measured.successes <= metrics.measured.attempts);
  assert.equal(metrics.measured.totalSuccesses, metrics.measured.attempts);
  assert.ok(metrics.measured.attempts - metrics.measured.successes <= 4, "only final in-flight responses may complete outside the measured window");
  assert.equal(metrics.measured.unexpected5xx, 0);
  assert.equal(metrics.measured.latencies.length, metrics.measured.successes);
});

test("recovery performance requires one exact promoted Lease per Admission Entry", () => {
  const admission = {
    admissionEntryId: "admission-1",
    poolId: "pool-1",
    ownerId: "owner-1",
    startAt: "2035-01-01T00:00:00.000Z",
    endAt: "2035-01-01T01:00:00.000Z",
    units: 1,
    priority: 2,
  };
  const promoted = {
    leaseId: "lease-promoted",
    state: "HELD",
    poolId: admission.poolId,
    ownerId: admission.ownerId,
    startAt: admission.startAt,
    endAt: admission.endAt,
    units: admission.units,
    priority: admission.priority,
  };
  const fixture = { seed: { admissionEntries: [admission], capacityLeases: [{ leaseId: "lease-due" }] } };
  const completed = {
    resources: {
      admissionEntries: [{ ...admission, state: "PROMOTED", promotedLeaseId: promoted.leaseId }],
      capacityLeases: [fixture.seed.capacityLeases[0], promoted],
    },
  };

  assert.doesNotThrow(() => assertRecoveryPromotions(completed, fixture));
  completed.resources.capacityLeases[1] = { ...promoted, units: 2 };
  assert.throws(() => assertRecoveryPromotions(completed, fixture), /changed units/u);
});
