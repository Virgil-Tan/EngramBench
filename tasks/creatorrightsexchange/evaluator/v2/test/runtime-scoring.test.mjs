import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateBarrierPayload } from "../lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";

test("CreatorRightsExchange barrier accepts only its published lease payload", () => {
  const payload = { aggregateId: "aggregate", attempt: 1, kind: "VIRUS_SCAN", leaseToken: "private-lease-token", point: "worker.claimed", workId: "work" };
  assert.equal(validateBarrierPayload(payload), true);
  assert.equal(validateBarrierPayload({ ...payload, point: "worker.effect-complete" }), true);
  assert.equal(validateBarrierPayload({ ...payload, point: "worker.before-commit" }), true);
  assert.equal(validateBarrierPayload({ ...payload, point: "dispatcher.response-received" }), true);
  assert.equal(validateBarrierPayload({ ...payload, leaseToken: "short" }), false);
  assert.equal(validateBarrierPayload({ ...payload, processRole: "worker" }), false);
  assert.equal(validateBarrierPayload({ ...payload, point: "invented.phase" }), false);
});

test("all-pass scoring preserves the frozen 100 point profile", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));
  const contractMap = JSON.parse(await readFile(new URL("../contract-map.v2.json", import.meta.url), "utf8"));
  assert.equal(validateManifest(manifest, contractMap), true);
  const result = scoreEvaluation(manifest, contractMap, { cases: manifest.cases.map(({ id, dimension, weight }) => ({ id, dimension, weight, status: "passed", durationMs: 1, evidenceDigest: "0".repeat(64) })) });
  assert.equal(result.rawScore, 100);
  assert.equal(result.score, 100);
  assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.hardCapsApplied, []);
});
