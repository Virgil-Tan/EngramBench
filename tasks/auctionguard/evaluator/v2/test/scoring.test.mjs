import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url)));
const contractMap = JSON.parse(await readFile(new URL("../contract-map.v2.json", import.meta.url)));

test("AuctionGuard manifest and contract map freeze 22 cases and five dimensions", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
});

test("all passing executable cases score 100", () => {
  const result = scoreEvaluation(manifest, contractMap, {
    cases: manifest.cases.map(({ id }) => ({ id, status: "passed", hardCapIds: [], blockedAssertions: [] })),
  });
  assert.equal(result.score, 100);
  assert.equal(result.verdict, "accepted");
});

test("a declared public-contract gap creates a diagnostic ceiling without renormalization", () => {
  const result = scoreEvaluation(manifest, contractMap, {
    cases: manifest.cases.map(({ id, weight }) => id === "CLEAR-02"
      ? { id, status: "excluded", reason: "blocked_public_contract", blockedWeight: weight, blockedAssertions: [{ assertionId: "equal-price-public-fixture", blockedBy: "SPEC-GAP-AG-04", policy: "fail-closed-diagnostic" }] }
      : { id, status: "passed", hardCapIds: [], blockedAssertions: [] }),
  });
  assert.equal(result.verdict, "rejected");
  assert.equal(result.evaluationMode, "diagnostic");
  assert.equal(result.formalEligible, false);
  assert.equal(result.score, 95);
});
