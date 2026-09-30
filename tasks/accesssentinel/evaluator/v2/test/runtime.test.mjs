import assert from "node:assert/strict";
import test from "node:test";

import { validateBarrierPayload } from "../lib/runtime.mjs";

const base = { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId: "work", aggregateId: "aggregate", attempt: 1, leaseTokenHash: "a".repeat(64) };

test("barrier accepts only the three exact published AccessSentinel points", () => {
  assert.equal(validateBarrierPayload(base), true);
  assert.equal(validateBarrierPayload({ ...base, point: "worker.before-effect" }), true);
  assert.equal(validateBarrierPayload({ ...base, processRole: "dispatcher", point: "dispatcher.response-received" }), true);
  assert.equal(validateBarrierPayload({ ...base, point: "worker.before-commit" }), false);
  assert.equal(validateBarrierPayload({ ...base, processRole: "dispatcher", point: "dispatcher.before-send" }), false);
  assert.equal(validateBarrierPayload({ ...base, leaseToken: "secret" }), false);
  assert.equal(validateBarrierPayload({ ...base, processRole: "api" }), false);
});
