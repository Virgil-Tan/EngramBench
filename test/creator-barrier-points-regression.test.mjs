import assert from "node:assert/strict";
import test from "node:test";

import {
  createCaseContext,
  validateBarrierPayload,
} from "../evaluators/transfer/creatorrightsexchange/v2/lib/runtime.mjs";

const claim = {
  point: "worker.claimed",
  kind: "VIRUS_SCAN",
  workId: "31000000-0000-4000-8000-000000000001",
  aggregateId: "31000000-0000-4000-8000-000000000002",
  attempt: 1,
  leaseToken: "regression-only-lease-token",
};

const invalidBodies = [
  null,
  [],
  { ...claim, point: undefined },
  { ...claim, point: "" },
  { ...claim, point: 1 },
  { ...claim, kind: "" },
  { ...claim, workId: "" },
  { ...claim, aggregateId: "" },
  { ...claim, attempt: 0 },
  { ...claim, attempt: -1 },
  { ...claim, attempt: 1.5 },
  { ...claim, attempt: "1" },
  { ...claim, leaseToken: "short" },
  { ...claim, extra: "not-published" },
];

async function createBarrier(t, options) {
  const ctx = await createCaseContext({
    caseId: "C-03",
    workspace: process.cwd(),
    evaluationSeed: "creator-public-barrier-points",
    manageDatabase: false,
  });
  let barrier;
  t.after(async () => {
    barrier?.releaseAll();
    await ctx.teardown();
  });
  barrier = await ctx.barrier(options);
  const post = (body, headers = { authorization: `Bearer ${barrier.token}` }) =>
    fetch(barrier.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { barrier, post };
}

test("Creator public barrier points are open strings but the six-field claim remains typed", () => {
  // Public legacy README section 9 requires a hook after every external response;
  // neither it nor the V2 public contract enumerates those point names.
  for (const point of [
    "worker.claimed",
    "worker.effect-complete",
    "worker.before-commit",
    "dispatcher.response-received",
    "worker.external-response",
    "worker.response",
    "dispatcher.external-response",
  ]) {
    assert.equal(validateBarrierPayload({ ...claim, point }), true, point);
  }
  for (const body of invalidBodies) {
    assert.equal(validateBarrierPayload(body), false);
  }
});

test("real Creator barrier records external-response hooks without satisfying or bypassing a target claim", async (t) => {
  const { barrier, post } = await createBarrier(t, {
    hold: (body) => body.point === "worker.claimed" && body.kind === "TRANSCODE",
  });
  for (const point of ["worker.external-response", "worker.response"]) {
    const body = { ...claim, point };
    assert.equal((await post(body)).status, 204, point);
    assert.deepEqual(barrier.ledger.at(-1).json, body);
    assert.equal(barrier.ledger.at(-1).released, true);
  }
  for (const point of ["worker.claimed", "worker.effect-complete", "worker.before-commit"]) {
    await assert.rejects(
      barrier.waitFor((entry) => entry.json.point === point, { timeoutMs: 20, intervalMs: 1 }),
      /recovery barrier request/,
    );
  }
  let completed = false;
  const body = { ...claim, kind: "TRANSCODE" };
  const response = post(body).then((value) => {
    completed = true;
    return value;
  });
  const held = await barrier.waitFor((entry) => entry.json.point === "worker.claimed");
  assert.deepEqual(held.json, body);
  assert.equal(held.released, false);
  assert.equal(completed, false);
  barrier.release(held);
  assert.equal((await response).status, 204);
  assert.equal(barrier.ledger.length, 3);
});

test("real Creator barrier preserves authentication and rejects malformed claim payloads before recording", async (t) => {
  const { barrier, post } = await createBarrier(t);
  const body = { ...claim, point: "worker.external-response" };
  for (const headers of [
    {},
    { authorization: "Bearer incorrect" },
    { "x-test-barrier-token": "incorrect" },
    { authorization: `Bearer ${barrier.token}`, "x-test-barrier-token": "incorrect" },
    { authorization: "Bearer incorrect", "x-test-barrier-token": barrier.token },
  ]) {
    assert.equal((await post(body, headers)).status, 401);
  }
  for (const invalid of invalidBodies) {
    assert.equal((await post(invalid)).status, 400);
  }
  assert.equal(barrier.ledger.length, 0);
  for (const headers of [
    { authorization: `Bearer ${barrier.token}` },
    { "x-test-barrier-token": barrier.token },
    { authorization: `Bearer ${barrier.token}`, "x-test-barrier-token": barrier.token },
  ]) {
    assert.equal((await post(body, headers)).status, 204);
  }
  assert.equal(barrier.ledger.length, 3);
});
