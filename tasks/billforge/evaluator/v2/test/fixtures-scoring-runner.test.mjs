import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { billingSeed, createFixtureFactory } from "../lib/fixtures.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";
import { parseArgs, selectCases } from "../run.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("BillForge fixture is deterministic and uses the exact V1 seed envelope", () => {
  const options = { evaluationSeed: "unit-seed", caseId: "BILL-01", baseTime: "2035-06-01T12:00:00.000Z" };
  const first = billingSeed(createFixtureFactory(options), "fixture");
  const second = billingSeed(createFixtureFactory(options), "fixture");
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.seed).sort(), [
    "customers", "exchangeRateSnapshots", "importedAt", "invoices", "ledgerAccounts", "ledgerEntries",
    "paymentIntents", "plans", "priceVersions", "refunds", "schemaVersion", "seedVersion",
    "settlementRuns", "subscriptions", "tenants",
  ]);
  assert.equal(first.seed.schemaVersion, 1);
});

test("declared SPEC-GAP diagnostics are preserved without score redistribution", () => {
  const cases = manifest.cases.map((definition) => {
    const blocked = definition.blockedAssertions ?? [];
    return blocked.length === 0 ? { id: definition.id, status: "passed", evidenceDigest: "0".repeat(64) } : {
      id: definition.id,
      status: "diagnostic",
      evidenceDigest: "1".repeat(64),
      diagnostics: blocked.map(({ id, blockedBy }) => ({ assertionId: id, blockedBy, status: "blocked", policy: "fail-closed-diagnostic" })),
    };
  });
  const scored = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(scored.verdict, "diagnostic");
  assert.equal(scored.formalEligible, false);
  assert.equal(scored.rawScore, 32);
  assert.equal(scored.maxAchievable, 32);
  assert.equal(scored.blockedWeight, 68);
});

test("runner parses reproducibility inputs and selects only frozen BillForge IDs", () => {
  assert.deepEqual(selectCases(manifest, ["BILL-01", "COMPAT-03"]).map(({ id }) => id), ["BILL-01", "COMPAT-03"]);
  assert.throws(() => selectCases(manifest, ["UNKNOWN-99"]), /unknown case ids/iu);
  assert.deepEqual(parseArgs(["--workspace", "/candidate", "--result", "/result.json", "--seed", "secret", "--case", "PAY-01,RACE-01"]), {
    caseIds: ["PAY-01", "RACE-01"], workspace: "/candidate", result: "/result.json", evaluationSeed: "secret",
  });
});
