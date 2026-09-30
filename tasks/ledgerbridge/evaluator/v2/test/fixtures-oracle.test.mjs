import assert from "node:assert/strict";
import test from "node:test";

import { accountCatalog, createFixtureFactory, ledgerSeed, multiTransferBody, performanceContract, workedExample } from "../lib/fixtures.mjs";
import { ReferenceLedger, assertPosting, safeSum } from "../lib/oracle.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "fixture-seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });

test("LedgerBridge fixtures freeze UUID, idempotency key, time and exact V1 seed", () => {
  assert.equal(fixtures.uuid("account"), fixtures.uuid("account"));
  assert.notEqual(fixtures.uuid("account"), fixtures.uuid("transfer"));
  assert.equal(fixtures.at({ seconds: 3 }), "2035-06-01T12:00:03.000Z");
  assert.match(fixtures.key("create"), /^lb-create-[0-9a-f]{24}$/u);
  assert.deepEqual(Object.keys(ledgerSeed(fixtures)), ["schemaVersion", "seedVersion", "accounts", "transfers"]);
});

test("safe sum rejects invalid members and stepwise overflow", () => {
  assert.equal(safeSum([30, 20, 10]), 60);
  assert.throws(() => safeSum([1, 0]), /positive/u);
  assert.throws(() => safeSum([Number.MAX_SAFE_INTEGER, 1]), /safe integer/u);
});

test("LB-W1 independently models reservation, ordered posting and atomic reversal", () => {
  const worked = workedExample(fixtures);
  const ledger = new ReferenceLedger([worked.catalog.source, ...worked.catalog.destinations], fixtures.uuid, fixtures.at());
  const transfer = ledger.create(worked.body);
  assert.deepEqual((({ balanceMinor, reservedMinor, availableMinor }) => ({ balanceMinor, reservedMinor, availableMinor }))(ledger.account(worked.catalog.source.accountId)), worked.sourceAfterCreate);
  const posting = ledger.settle(transfer.transferId);
  assert.deepEqual(posting.legs.map(({ direction }) => direction), worked.transferOrder);
  assertPosting(posting, { multi: true });
  const reversal = ledger.reverse(transfer.transferId);
  assert.deepEqual(reversal.legs.map(({ direction }) => direction), worked.reversalOrder);
  assertPosting(reversal, { multi: true });
  assert.equal(ledger.account(worked.catalog.source.accountId).balanceMinor, 100);
  assert.deepEqual(worked.catalog.destinations.map(({ accountId }) => ledger.account(accountId).balanceMinor), [0, 0, 0]);
});

test("one and twenty destination request fixtures preserve request order", () => {
  const catalog = accountCatalog(fixtures, { destinationCount: 20 });
  assert.equal(multiTransferBody(catalog, [1]).legs.length, 1);
  assert.deepEqual(multiTransferBody(catalog, Array.from({ length: 20 }, (_, index) => index + 1)).legs.map(({ amountMinor }) => amountMinor), Array.from({ length: 20 }, (_, index) => index + 1));
});

test("the fixed performance contract is exact at formal scale", () => {
  assert.deepEqual(performanceContract().statementRead, { concurrency: 64, warmupSeconds: 10, measureSeconds: 60, targetPerSecond: 150, p95Ms: 150, limit: 50 });
  assert.deepEqual(performanceContract().mutationMix.order, ["CREATE", "CREATE", "CANCEL", "REVERSE"]);
  assert.deepEqual(performanceContract().seed, { seedVersion: "perf-v1", accountCount: 20000, postedCount: 100000, pendingCount: 2000 });
});
