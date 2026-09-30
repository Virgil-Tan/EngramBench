import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureFactory, groupFixture, performanceContract, performanceSeed, reconciliationSeed, workedExample,
} from "../fixtures/index.mjs";
import { foldMatchActions, rankOneToOne, validateMatchGroup } from "../oracles/index.mjs";

test("fixtures deterministically freeze IDs, time, keys and exact V1 seed members", () => {
  const left = createFixtureFactory({ evaluationSeed: "seed", baseTime: "2035-06-01T12:00:00.000Z", caseId: "A-01" });
  const right = createFixtureFactory({ evaluationSeed: "seed", baseTime: "2035-06-01T12:00:00.000Z", caseId: "A-01" });
  assert.equal(left.uuid("line"), right.uuid("line"));
  assert.equal(left.key("import"), right.key("import"));
  assert.equal(left.time(5), right.time(5));
  const seed = reconciliationSeed(left, "unit");
  assert.deepEqual(Object.keys(seed), ["schemaVersion", "seedVersion", "ledgerEntries", "statementBatches", "matches"]);
  assert.equal(seed.schemaVersion, 1);
});

test("one-to-one oracle applies the published score, ordering and member uniqueness", () => {
  const fixture = createFixtureFactory({ evaluationSeed: "score", baseTime: "2035-06-01T12:00:00.000Z", caseId: "A-02" });
  const example = workedExample(fixture);
  const ranked = rankOneToOne(example.statementLines, example.ledgerEntries);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].ledgerEntryId, example.ledgerEntries[0].ledgerEntryId);
  assert.equal(ranked[0].score, 1050);
});

test("group oracle enforces member bounds, one currency, uniqueness and exact integer conservation", () => {
  const fixture = createFixtureFactory({ evaluationSeed: "group", baseTime: "2035-06-01T12:00:00.000Z", caseId: "A-04" });
  const group = groupFixture(fixture);
  assert.deepEqual(validateMatchGroup(group.statementLines, group.ledgerEntries).statementLineIds, group.statementLines.map(({ statementLineId }) => statementLineId).sort());
  assert.throws(() => validateMatchGroup(group.statementLines, [{ ...group.ledgerEntries[0], amountMinor: group.ledgerEntries[0].amountMinor + 1 }, ...group.ledgerEntries.slice(1)]), /sum/iu);
  assert.throws(() => validateMatchGroup([group.statementLines[0], group.statementLines[0]], group.ledgerEntries), /duplicate/iu);
});

test("immutable action folding preserves confirmation and reversal history", () => {
  const projection = foldMatchActions("PROPOSED", [
    { type: "CONFIRM", sequence: 1 },
    { type: "REVERSE", sequence: 2 },
  ]);
  assert.equal(projection.state, "REVERSED");
  assert.equal(projection.releaseCount, 1);
  assert.deepEqual(projection.sequences, [1, 2]);
  assert.throws(() => foldMatchActions("PROPOSED", [{ type: "REVERSE", sequence: 1 }]), /illegal/iu);
});

test("formal performance fixtures preserve the three published workloads exactly", () => {
  const fixture = createFixtureFactory({ evaluationSeed: "performance", baseTime: "2035-06-01T12:00:00.000Z", caseId: "E-04" });
  const contract = performanceContract();
  assert.deepEqual(contract.import, { clients: 64, warmupSeconds: 10, measureSeconds: 60, batchesPerSecond: 50, linesPerBatch: 100, p95Ms: 500, warmupBatches: 500, measuredBatches: 3_000 });
  assert.deepEqual(contract.review, { clients: 64, warmupSeconds: 10, measureSeconds: 60, readsPerSecond: 250, p95Ms: 180, limit: 100 });
  assert.deepEqual(contract.suggestion, { workers: 2, seconds: 60, unmatchedLines: 10_000, unmatchedLedgerEntries: 10_000, proposals: 10_000 });
  const seed = performanceSeed(fixture);
  assert.equal(seed.ledgerEntries.length, 20_000);
  assert.equal(seed.statementBatches.length, 200);
  assert.ok(seed.statementBatches.every(({ lines }) => lines.length === 100));
  assert.equal(seed.matches.length, 10_000);
  assert.equal(seed.ledgerEntries.filter(({ state }) => state === "UNMATCHED").length, 10_000);
  assert.equal(seed.statementBatches.flatMap(({ lines }) => lines).filter(({ state }) => state === "UNMATCHED").length, 10_000);
});
