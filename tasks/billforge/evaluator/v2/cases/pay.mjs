import assert from "node:assert/strict";

import { billingSeed } from "../lib/fixtures.mjs";
import { assertFrozen, balancePostings, effectiveBalance, refundableMinor } from "../lib/oracle.mjs";
import {
  assertAccountingClosure, assertExactError, assertLedgerEntry, createInvoice, createPayment, createRefund,
  diagnostics, finalizeInvoice, guarded, prepare, result, waitForInvoice, waitForPayment, waitForRefund,
} from "./helpers.mjs";

async function openInvoice(ctx, api, fixture, label) {
  const created = await createInvoice(ctx, api, label, fixture);
  await finalizeInvoice(ctx, api, created.invoice, label);
  const worker = await ctx.startWorker();
  const invoice = await waitForInvoice(ctx, api, created.invoice.invoiceId, ["OPEN"], { processes: [worker] });
  return { invoice, worker };
}

const PAY01 = {
  id: "PAY-01",
  async run(ctx) {
    return guarded(["DURABLE_IDEMPOTENCY", "PROVIDER_IDENTITY_OR_UNKNOWN"], async () => {
      const fixture = billingSeed(ctx.fixtures, "payment-idempotency");
      const { apis } = await prepare(ctx, fixture.seed, { apis: 2 });
      const [api1, api2] = apis;
      const { invoice, worker } = await openInvoice(ctx, api1, fixture, "payment-idempotency");
      await ctx.stop(worker);
      const body = {
        invoiceId: invoice.invoiceId, amountMinor: invoice.totalMinor, currency: invoice.currency,
        providerRequestId: `provider-${ctx.key("unknown-payment-response")}`,
      };
      const key = ctx.key("unknown-payment-response");
      const shield = await ctx.responseShield(api1.baseUrl);
      shield.dropNextMutation();
      await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/payment-intents", key, body));
      const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped PaymentIntent response" });
      assert.equal(capture.response.status, 200);
      const original = JSON.parse(capture.response.body);
      await ctx.stop(api1);
      const restarted = await ctx.startApi();
      const replay = await ctx.mutate(api2.baseUrl, "/api/v1/payment-intents", key, body);
      assert.equal(replay.status, capture.response.status);
      assert.deepEqual(replay.json, original);
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
        [api2, restarted][index % 2].baseUrl, "/api/v1/payment-intents", key, body,
      )));
      assert.ok(responses.every(({ status, json }) => status === replay.status && JSON.stringify(json) === JSON.stringify(replay.json)));
      const conflict = await ctx.mutate(api2.baseUrl, "/api/v1/payment-intents", key, { ...body, amountMinor: body.amountMinor - 1 });
      assertExactError(conflict, 409, "IDEMPOTENCY_CONFLICT");
      const snapshot = await ctx.snapshot(api2.baseUrl);
      const matching = snapshot.resources.paymentIntents.filter(({ providerRequestId }) => providerRequestId === body.providerRequestId);
      assert.equal(matching.length, 1);
      assert.equal(matching[0].paymentIntentId, replay.json.paymentIntentId);
      assert.equal(snapshot.work.filter(({ aggregateId, kind }) => aggregateId === matching[0].paymentIntentId && kind === "PAYMENT_CAPTURE").length, 1);
      assert.equal(snapshot.resources.ledgerEntries.some(({ referenceId }) => referenceId === matching[0].paymentIntentId), false);
      return result({ paymentIntentId: matching[0].paymentIntentId, providerRequestId: matching[0].providerRequestId, replayCount: responses.length });
    });
  },
};

const PAY02 = {
  id: "PAY-02",
  async run(_ctx) {
    return diagnostics([{ assertionId: "BF-PAY02-PROVIDER-CONTROL", blockedBy: "SPEC-GAP-BF-06" }]);
  },
};

const PAY03 = {
  id: "PAY-03",
  async run(_ctx) {
    return diagnostics([{ assertionId: "BF-PAY03-WEBHOOK-WIRE", blockedBy: "SPEC-GAP-BF-06" }]);
  },
};

const PAY04 = {
  id: "PAY-04",
  async run(_ctx) {
    return diagnostics([
      { assertionId: "BF-PAY04-UNKNOWN-STATE", blockedBy: "SPEC-GAP-BF-04" },
      { assertionId: "BF-PAY04-PROVIDER-CONTROL", blockedBy: "SPEC-GAP-BF-06" },
    ]);
  },
};

const PAY05 = {
  id: "PAY-05",
  async run(ctx) {
    return guarded(["MONEY_OR_LEDGER_INVARIANT", "REFUND_OR_RESERVE_BOUND", "DURABLE_IDEMPOTENCY"], async () => {
      const fixture = billingSeed(ctx.fixtures, "ledger");
      const { api } = await prepare(ctx, fixture.seed);
      const { invoice, worker } = await openInvoice(ctx, api, fixture, "ledger");
      const paymentCreated = await createPayment(ctx, api, invoice, "ledger");
      const payment = await waitForPayment(ctx, api, paymentCreated.paymentIntent.paymentIntentId, ["SUCCEEDED"], { processes: [worker] });
      const paidInvoice = await waitForInvoice(ctx, api, invoice.invoiceId, ["PAID"], { processes: [worker] });
      assert.equal(payment.amountMinor, paidInvoice.totalMinor);
      const refundSpecs = [[3_000, "first"], [2_000, "second"]];
      const succeededRefunds = [];
      let firstPosting;
      for (const [amount, label] of refundSpecs) {
        const key = ctx.key(`${label}-partial-refund`);
        const created = await createRefund(ctx, api, payment, amount, label, key);
        const replay = await ctx.mutate(api.baseUrl, `/api/v1/payment-intents/${payment.paymentIntentId}/refunds`, key, { amountMinor: amount });
        assert.deepEqual(replay.json, created.response.json);
        const refund = await waitForRefund(ctx, api, created.refund.refundId, ["SUCCEEDED"], { processes: [worker] });
        succeededRefunds.push(refund);
        const snapshot = await ctx.snapshot(api.baseUrl);
        const own = snapshot.resources.ledgerEntries.filter(({ referenceId }) => referenceId === refund.refundId);
        balancePostings(own);
        if (firstPosting === undefined) firstPosting = structuredClone(own);
        else {
          const currentFirst = snapshot.resources.ledgerEntries.filter(({ referenceId }) => referenceId === succeededRefunds[0].refundId);
          assertFrozen(firstPosting, currentFirst, "first Refund Posting");
        }
      }
      assert.equal(refundableMinor(payment, succeededRefunds), payment.amountMinor - 5_000);
      const snapshot = await ctx.snapshot(api.baseUrl);
      const paymentEntries = snapshot.resources.ledgerEntries.filter(({ referenceId }) => referenceId === payment.paymentIntentId);
      assert.equal(new Set(paymentEntries.map(({ postingId }) => postingId)).size, 1);
      assert.deepEqual(new Set(paymentEntries.map(({ accountCode }) => accountCode)), new Set(["CustomerReceivable", "CashClearing"]));
      balancePostings(paymentEntries);
      for (const refund of succeededRefunds) {
        const entries = snapshot.resources.ledgerEntries.filter(({ referenceId }) => referenceId === refund.refundId);
        assert.equal(new Set(entries.map(({ postingId }) => postingId)).size, 1);
        assert.deepEqual(new Set(entries.map(({ accountCode }) => accountCode)), new Set(["RefundExpense", "CashClearing"]));
      }
      const ledgerResponse = await ctx.request(api.baseUrl, `/api/v1/invoices/${invoice.invoiceId}/ledger`);
      assert.equal(ledgerResponse.status, 200, ledgerResponse.text);
      const ledgerItems = Array.isArray(ledgerResponse.json) ? ledgerResponse.json : ledgerResponse.json.items;
      assert.ok(Array.isArray(ledgerItems));
      ledgerItems.forEach(assertLedgerEntry);
      const finalInvoice = snapshot.resources.invoices.find(({ invoiceId }) => invoiceId === invoice.invoiceId);
      assert.equal(finalInvoice.refundedMinor, 5_000);
      assert.equal(finalInvoice.outstandingMinor, effectiveBalance(finalInvoice));
      assertAccountingClosure(snapshot);
      return result({ invoiceId: invoice.invoiceId, paymentIntentId: payment.paymentIntentId, refundIds: succeededRefunds.map(({ refundId }) => refundId), postingIds: [...new Set(ledgerItems.map(({ postingId }) => postingId))] });
    });
  },
};

export const PAY_CASES = Object.freeze([PAY01, PAY02, PAY03, PAY04, PAY05]);
