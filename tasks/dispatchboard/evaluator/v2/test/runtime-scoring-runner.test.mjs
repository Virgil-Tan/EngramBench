import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateBarrierPayload } from "../lib/runtime.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";
import { parseArgs, selectCases } from "../run.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("the recovery barrier accepts only the published closed payload", () => {
  const payload = {
    schemaVersion: 1, processRole: "worker", point: "worker.before-commit",
    workId: "w", aggregateId: "a", attempt: 2, leaseTokenHash: "a".repeat(64),
  };
  assert.equal(validateBarrierPayload(payload), true);
  assert.equal(validateBarrierPayload({ ...payload, leaseToken: "secret" }), false);
  assert.equal(validateBarrierPayload({ ...payload, point: "worker.after-commit" }), false);
});

test("the blocked migration case is diagnostic and its weight is not redistributed", () => {
  const cases = manifest.cases.map((definition) => definition.id === "E-04" ? {
    id: definition.id, status: "diagnostic", evidenceDigest: "1".repeat(64),
    diagnostics: [{ assertionId: "DB-E04-DRIVER-LINEAGE", blockedBy: "SPEC-GAP-DB-01", status: "blocked", policy: "fail-closed-diagnostic" }],
  } : { id: definition.id, status: "passed", evidenceDigest: "0".repeat(64) });
  const scored = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(scored.verdict, "diagnostic");
  assert.equal(scored.rawScore, 97.5);
  assert.equal(scored.maxAchievable, 97.5);
  assert.equal(scored.blockedWeight, 2.5);
});

test("runner keeps reproducibility inputs and frozen case selection", () => {
  assert.deepEqual(selectCases(manifest, ["A-01", "E-03"]).map(({ id }) => id), ["A-01", "E-03"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case ids/iu);
  assert.deepEqual(parseArgs(["--workspace", "/candidate", "--result", "/result.json", "--seed", "secret", "--case", "A-01,C-04"]), {
    caseIds: ["A-01", "C-04"], workspace: "/candidate", result: "/result.json", evaluationSeed: "secret",
  });
});
