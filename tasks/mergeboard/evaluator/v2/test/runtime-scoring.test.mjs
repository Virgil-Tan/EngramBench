import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateBarrierPayload } from "../lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("barrier validation is exact and never accepts a lease token", () => {
  const valid = { schemaVersion: 1, processRole: "worker", point: "worker.before-commit", workId: "w", aggregateId: "a", attempt: 1, leaseTokenHash: "a".repeat(64) };
  assert.equal(validateBarrierPayload(valid), true);
  assert.equal(validateBarrierPayload({ ...valid, leaseToken: "secret" }), false);
  assert.equal(validateBarrierPayload({ ...valid, point: "worker.after-commit" }), false);
});

test("scoring applies the frozen correctness hard cap", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  const cases = manifest.cases.map((item) => ({ id: item.id, status: "passed", evidenceDigest: "a".repeat(64) }));
  cases.find(({ id }) => id === "B-05").status = "failed";
  Object.assign(cases.find(({ id }) => id === "B-05"), { privateFailureCode: "MB_B05_ASSERTION_FAILED", hardCapIds: ["MERGE_ATOMICITY"] });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.rawScore, 95);
  assert.equal(result.score, 30);
  assert.equal(result.verdict, "rejected");
});

test("declared contract gaps are fail-closed diagnostics", () => {
  const cases = manifest.cases.map((item) => ({ id: item.id, status: "passed", evidenceDigest: "a".repeat(64) }));
  Object.assign(cases.find(({ id }) => id === "A-05"), {
    status: "diagnostic",
    diagnostics: [{ assertionId: "MB-A05-TERMINAL-STATE", status: "blocked", blockedBy: "MB-GAP-01", policy: "fail-closed-diagnostic" }],
  });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.formalEligible, false);
  assert.equal(result.blockedWeight, 6);
  assert.equal(result.maxAchievable, 94);
});
