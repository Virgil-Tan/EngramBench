import assert from "node:assert/strict";
import { providerIdentityScenario, reserveRaceScenario, settlementScenario } from "./current-system.mjs";

import { billingSeed } from "../lib/fixtures.mjs";
import {
  assertAccountingClosure, createInvoice, createPayment, eventFor, finalizeInvoice, guarded,
  prepare, result, waitForInvoice, waitForPayment, waitForRefund, waitForSettlement,
} from "./helpers.mjs";

async function lostMutation(ctx, shield, api, path, key, body) {
  const beforeCount = shield.captures.length;
  shield.dropNextMutation();
  await assert.rejects(ctx.mutate(shield.baseUrl, path, key, body));
  const capture = await ctx.waitFor(() => shield.captures.slice(beforeCount).find(({ dropped }) => dropped), { label: `dropped ${path} response` });
  const replay = await ctx.mutate(api.baseUrl, path, key, body);
  assert.equal(replay.status, capture.response.status);
  assert.deepEqual(replay.json, JSON.parse(capture.response.body));
  return { capture, replay };
}

const RACE01 = {
  id: "RACE-01",
  async run(ctx) {
    return guarded(["DURABLE_IDEMPOTENCY", "MONEY_OR_LEDGER_INVARIANT", "SETTLEMENT_IMMUTABILITY_OR_RECOVERY"], async () => {
      const fixture = billingSeed(ctx.fixtures, "response-loss");
      const { apis } = await prepare(ctx, fixture.seed, { apis: 2 });
      const [api1, api2] = apis;
      const invoiceCreated = await createInvoice(ctx, api1, "lost-finalize", fixture);
      const shield = await ctx.responseShield(api1.baseUrl);
      const finalize = await lostMutation(ctx, shield, api2, `/api/v1/invoices/${invoiceCreated.invoice.invoiceId}/finalize`, ctx.key("lost-finalize"), {});
      const worker = await ctx.startWorker();
      const invoice = await waitForInvoice(ctx, api2, invoiceCreated.invoice.invoiceId, ["OPEN"], { processes: [worker] });
      const paymentCreated = await createPayment(ctx, api2, invoice, "lost-refund-payment");
      const payment = await waitForPayment(ctx, api2, paymentCreated.paymentIntent.paymentIntentId, ["SUCCEEDED"], { processes: [worker] });
      const refund = await lostMutation(
        ctx, shield, api2, `/api/v1/payment-intents/${payment.paymentIntentId}/refunds`,
        ctx.key("lost-refund"), { amountMinor: Math.floor(payment.amountMinor / 4) },
      );
      const refundId = refund.replay.json.refundId;
      await waitForRefund(ctx, api2, refundId, ["SUCCEEDED"], { processes: [worker] });
      const settlement = await lostMutation(ctx, shield, api2, "/api/v1/settlements", ctx.key("lost-settlement"), {
        tenantId: fixture.tenant.tenantId, periodStart: ctx.at({ days: -90 }), periodEnd: ctx.at({ days: -1 }),
      });
      const settlementRunId = settlement.replay.json.settlementRunId;
      await waitForSettlement(ctx, api2, settlementRunId, ["CLOSED"], { timeoutMs: 60_000, processes: [worker] });
      const snapshot = await ctx.snapshot(api2.baseUrl);
      assert.equal(snapshot.resources.invoices.filter(({ invoiceId }) => invoiceId === invoice.invoiceId).length, 1);
      assert.equal(snapshot.resources.refunds.filter(({ refundId: id }) => id === refundId).length, 1);
      assert.equal(snapshot.resources.settlementRuns.filter(({ settlementRunId: id }) => id === settlementRunId).length, 1);
      assert.equal(snapshot.work.filter(({ aggregateId, kind }) => aggregateId === invoice.invoiceId && kind === "INVOICE_FINALIZATION").length, 1);
      assert.equal(snapshot.work.filter(({ aggregateId, kind }) => aggregateId === refundId && kind === "REFUND_PROCESSING").length, 1);
      assert.equal(snapshot.work.filter(({ aggregateId, kind }) => aggregateId === settlementRunId && kind === "SETTLEMENT_CLOSE").length, 1);
      assert.equal(eventFor(snapshot, invoice.invoiceId, "invoice.finalized").length, 1);
      assert.equal(eventFor(snapshot, refundId, "refund.succeeded").length, 1);
      assert.equal(eventFor(snapshot, settlementRunId, "settlement.closed").length, 1);
      assertAccountingClosure(snapshot);
      return result({ invoiceId: invoice.invoiceId, refundId, settlementRunId, replayBodies: [finalize.replay.json, refund.replay.json, settlement.replay.json] });
    });
  },
};

const RACE02 = {
  id: "RACE-02",
  async run(ctx) {
    return guarded(["PROVIDER_IDENTITY_OR_UNKNOWN", "DURABLE_IDEMPOTENCY"], () => providerIdentityScenario(ctx, { reconcile: true }));
  },
};

const RACE03 = {
  id: "RACE-03",
  async run(ctx) {
    return guarded(["REFUND_OR_RESERVE_BOUND"], () => reserveRaceScenario(ctx));
  },
};

const RACE04 = {
  id: "RACE-04",
  async run(ctx) {
    return guarded(["SETTLEMENT_IMMUTABILITY_OR_RECOVERY"], () => settlementScenario(ctx));
  },
};

export const RACE_CASES = Object.freeze([RACE01, RACE02, RACE03, RACE04]);
