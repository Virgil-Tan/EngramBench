import assert from "node:assert/strict";
import test from "node:test";
import { validateBarrierPayload } from "../lib/runtime.mjs";

const valid = { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId: "work", aggregateId: "aggregate", attempt: 1, leaseTokenHash: "a".repeat(64) };
test("IncidentRelay barrier accepts only the exact public payload", () => {
  assert.equal(validateBarrierPayload(valid), true);
  assert.equal(validateBarrierPayload({ ...valid, leaseToken: "secret" }), false);
  assert.equal(validateBarrierPayload({ ...valid, leaseTokenHash: "bad" }), false);
  assert.equal(validateBarrierPayload({ ...valid, point: "internal.before-write" }), false);
  assert.equal(validateBarrierPayload({ ...valid, processRole: "api" }), false);
});
