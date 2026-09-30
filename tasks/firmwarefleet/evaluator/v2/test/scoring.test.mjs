import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url),
  manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root))),
  contractMap = JSON.parse(
    await readFile(new URL("contract-map.v2.json", root)),
  );
const passing = () =>
  manifest.cases.map(({ id }) =>
    id === "D-03"
      ? {
          id,
          status: "diagnostic",
          diagnostics: [
            {
              assertionId: "device-update-manager-extension-shape",
              status: "blocked",
              blockedBy: "FF-GAP-01",
              policy: "fail-closed-diagnostic",
            },
          ],
        }
      : { id, status: "passed" },
  );
test("one frozen blocker yields honest 96 diagnostic", () => {
  const scored = scoreEvaluation(manifest, contractMap, { cases: passing() });
  assert.equal(scored.score, 96);
  assert.equal(scored.rawScore, 96);
  assert.equal(scored.blockedWeight, 4);
  assert.equal(scored.maxAchievable, 96);
  assert.equal(scored.verdict, "diagnostic");
  assert.equal(scored.formalEligible, false);
});
test("hard caps and the single V1 exclusion are enforced", () => {
  const cases = passing(),
    index = cases.findIndex(({ id }) => id === "B-03");
  cases[index] = {
    id: "B-03",
    status: "failed",
    privateFailureCode: "FF_B03_REPLAY",
    hardCapIds: ["REPORT_REPLAY"],
  };
  const scored = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(scored.rawScore, 91);
  assert.equal(scored.score, 30);
  assert.deepEqual(
    scored.hardCapsApplied.map(({ id }) => id),
    ["REPORT_REPLAY"],
  );
  const excluded = passing();
  excluded[excluded.findIndex(({ id }) => id === "E-01")] = createMissingV1CheckpointOutcome(
    manifest.cases.find(({ id }) => id === "E-01"),
  );
  assert.equal(
    scoreEvaluation(manifest, contractMap, { cases: excluded }).blockedWeight,
    4,
  );
  assert.equal(scoreEvaluation(manifest, contractMap, { cases: excluded }).excludedWeight, 2.5);
  const illegal = passing();
  illegal[0] = {
    id: "A-01",
    status: "excluded",
    reason: "missing_v1_checkpoint",
  };
  assert.throws(
    () => scoreEvaluation(manifest, contractMap, { cases: illegal }),
    /A-01 missing_v1_checkpoint exclusion/u,
  );
});
