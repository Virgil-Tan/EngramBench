import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("all cases passing yields the frozen 100 points", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "x" })) });
  assert.equal(result.verdict, "accepted");
  assert.equal(result.score, 100);
});

test("a durable replay duplicate applies the 30-point cap", () => {
  const cases = manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "x" }));
  cases[5] = { id: "B-01", status: "failed", privateFailureCode: "NR_B01_DUPLICATE", hardCapIds: ["DURABLE_REPLAY_DUPLICATE"] };
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.rawScore, 95);
  assert.equal(result.score, 30);
});

test("frozen contract gaps stay diagnostic and cannot be silently scored", () => {
  const cases = manifest.cases.map(({ id }) => id === "A-05"
    ? { id, status: "diagnostic", diagnostics: [{ assertionId: "campaign-create-read-wire", status: "blocked", blockedBy: "SPEC-GAP-NR-01", policy: "fail-closed-diagnostic" }] }
    : { id, status: "passed", evidenceDigest: "x" });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.score, 94);
});
