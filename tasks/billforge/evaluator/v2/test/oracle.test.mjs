import assert from "node:assert/strict";
import test from "node:test";

import { assertInvoiceArithmetic, balancePostings, effectiveBalance, selectEffectiveVersion } from "../lib/oracle.mjs";

test("billing oracle selects half-open effective versions and freezes integer Invoice arithmetic", () => {
  const versions = [
    { version: 1, effectiveFrom: "2030-01-01T00:00:00.000Z", effectiveTo: "2030-02-01T00:00:00.000Z" },
    { version: 2, effectiveFrom: "2030-02-01T00:00:00.000Z", effectiveTo: null },
  ];
  assert.equal(selectEffectiveVersion(versions, "2030-01-31T23:59:59.999Z").version, 1);
  assert.equal(selectEffectiveVersion(versions, "2030-02-01T00:00:00.000Z").version, 2);
  const invoice = { totalMinor: 1_000, paidMinor: 700, refundedMinor: 125, outstandingMinor: 425, lines: [{ quantity: 1, unitAmountMinor: 1_000, amountMinor: 1_000 }] };
  assert.doesNotThrow(() => assertInvoiceArithmetic(invoice));
  assert.equal(effectiveBalance(invoice), 425);
});

test("ledger oracle balances independently by Posting and currency", () => {
  const entries = [
    { postingId: "p1", currency: "USD", direction: "DEBIT", amountMinor: 500 },
    { postingId: "p1", currency: "USD", direction: "CREDIT", amountMinor: 500 },
    { postingId: "p2", currency: "EUR", direction: "DEBIT", amountMinor: 20 },
    { postingId: "p2", currency: "EUR", direction: "CREDIT", amountMinor: 20 },
  ];
  assert.deepEqual(balancePostings(entries), [{ postingId: "p1", currency: "USD", debitMinor: 500, creditMinor: 500 }, { postingId: "p2", currency: "EUR", debitMinor: 20, creditMinor: 20 }]);
  assert.throws(() => balancePostings(entries.slice(0, 1)), /unbalanced/iu);
});
