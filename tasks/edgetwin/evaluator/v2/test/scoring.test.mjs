import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("the two frozen health assertions fail closed as diagnostic and are not scored", () => {
  const cases = manifest.cases.map(({ id }) => id === "DATA-03"
    ? { id, status: "diagnostic", diagnostics: [{ assertionId: "wave-health-adjudication", status: "blocked", blockedBy: "SPEC-GAP-ET-01", policy: "fail-closed-diagnostic" }] }
    : id === "RECOVERY-03"
      ? { id, status: "diagnostic", diagnostics: [{ assertionId: "automatic-health-gated-wave-advance", status: "blocked", blockedBy: "SPEC-GAP-ET-01", policy: "fail-closed-diagnostic" }] }
      : { id, status: "passed", evidenceDigest: "x" });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.score, 90);
  assert.equal(result.blockedWeight, 10);
});

test("a duplicate durable effect applies its frozen hard cap", () => {
  const cases = manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "x" }));
  cases[6] = { id: "DATA-02", status: "failed", privateFailureCode: "ET_DATA02_DUPLICATE", hardCapIds: ["DURABLE_IDEMPOTENCY"] };
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.rawScore, 95);
  assert.equal(result.score, 30);
});
