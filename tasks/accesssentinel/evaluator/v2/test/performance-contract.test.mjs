import assert from "node:assert/strict";
import test from "node:test";

import { E_CASES } from "../cases/e.mjs";
import { createFixtureFactory } from "../fixtures/index.mjs";

test("all eight performance scenarios are task-owned and frozen", () => {
  const performanceCases = E_CASES.slice(3);
  assert.deepEqual(performanceCases.map(({ id }) => id), ["E-04", "E-05", "E-06", "E-07", "E-08", "E-09", "E-10", "E-11"]);
  assert.equal(performanceCases.every(({ taskId, fixtureFamily }) => taskId === "accesssentinel" && fixtureFamily === "AS-F-PERF"), true);
  const fixtures = createFixtureFactory({ evaluationSeed: "perf", caseId: "E-04", baseTime: "2035-06-01T12:00:00.000Z" }).performance();
  assert.deepEqual(Object.keys(fixtures.scenarios), ["session-refresh-storm", "access-decision-ingest", "policy-evaluation-hotset", "location-replay-convergence", "grant-revocation-fanout", "audit-chain-append", "outbox-ack-recovery", "revocation-fence-recovery"]);
  assert.equal(fixtures.scenarios["policy-evaluation-hotset"].operations, 1_000_000);
  assert.equal(fixtures.scenarios["revocation-fence-recovery"].grants, 50_000);
});
