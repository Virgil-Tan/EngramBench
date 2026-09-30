import assert from "node:assert/strict";
import test from "node:test";
import { validateBarrierPayload } from "../lib/runtime.mjs";

const worker = { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId: "work", aggregateId: "aggregate", attempt: 1, leaseTokenHash: "a".repeat(64) };
test("barrier accepts only exact published worker and dispatcher payloads", () => { assert.equal(validateBarrierPayload(worker), true); assert.equal(validateBarrierPayload({ ...worker, point: "worker.effect-complete" }), true); assert.equal(validateBarrierPayload({ ...worker, point: "worker.before-commit" }), true); assert.equal(validateBarrierPayload({ ...worker, processRole: "dispatcher", point: "dispatcher.response-received" }), true); assert.equal(validateBarrierPayload({ ...worker, leaseToken: "secret" }), false); assert.equal(validateBarrierPayload({ ...worker, point: "private.before-write" }), false); assert.equal(validateBarrierPayload({ ...worker, processRole: "api" }), false); });
