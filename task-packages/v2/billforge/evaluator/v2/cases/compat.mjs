import assert from "node:assert/strict";

import { unknownPaymentScenario } from "./current-system.mjs";
import { billingSeed, emptySeed, invoice as seededInvoice, paymentIntent as seededPaymentIntent } from "../lib/fixtures.mjs";
import { balancePostings, canonical, refundableMinor } from "../lib/oracle.mjs";
import {
  BASE_RESOURCE_KEYS, assertAccountingClosure, assertExactError, assertSnapshot, createInvoice, createPayment,
  createRefund, createSettlement, finalizeInvoice, guarded, result, stableSnapshot,
  waitForInvoice, waitForPayment, waitForRefund, waitForSettlement,
} from "./helpers.mjs";

function withUnknownPayment(ctx, label) {
  const fixture = billingSeed(ctx.fixtures, label);
  const oldInvoice = seededInvoice(ctx.fixtures, `${label}-unknown`, fixture.tenant, fixture.customer, fixture.subscription, fixture.rate, {
    periodStart: ctx.at({ days: -120 }), periodEnd: ctx.at({ days: -90 }), state: "OPEN",
    createdAt: ctx.at({ days: -121 }), finalizedAt: ctx.at({ days: -120 }), sequence: 2,
  });
  const unknown = seededPaymentIntent(ctx.fixtures, `${label}-unknown`, oldInvoice, {
    amountMinor: Math.floor(oldInvoice.totalMinor / 2), state: "UNKNOWN", createdAt: ctx.at({ days: -89 }), sequence: 2,
  });
  fixture.seed.invoices = [oldInvoice];
  fixture.seed.paymentIntents = [unknown];
  return { fixture, oldInvoice, unknown };
}

const COMPAT01 = {
  id: "COMPAT-01",
  async run(ctx) {
    return guarded(["MIGRATION_COMPATIBILITY", "MONEY_OR_LEDGER_INVARIANT", "DURABLE_IDEMPOTENCY"], async () => {
      const current = ctx;
      await current.command("npm", ["ci"], { timeoutMs: 600_000 });
      await current.npm("build", [], { timeoutMs: 600_000 });
      await current.migrate();
      const { fixture, unknown } = withUnknownPayment(ctx, "restart");
      const seeded = await current.seed(fixture.seed);
      assert.equal(seeded.exitCode, 0, seeded.stderr || seeded.stdout);
      const api = await current.startApi();
      const replayKey = ctx.key("restart-invoice-replay");
      const created = await createInvoice(ctx, api, "restart-current", fixture, {
        periodStart: ctx.at({ days: -59 }), periodEnd: ctx.at({ days: -29 }),
      }, { key: replayKey });
      const savedStatus = created.response.status;
      const savedBody = structuredClone(created.response.json);
      await finalizeInvoice(ctx, api, created.invoice, "restart-current");
      const worker = await current.startWorker();
      const open = await waitForInvoice(ctx, api, created.invoice.invoiceId, ["OPEN"], { processes: [worker] });
      const paymentCreated = await createPayment(ctx, api, open, "restart-payment");
      const payment = await waitForPayment(ctx, api, paymentCreated.paymentIntent.paymentIntentId, ["SUCCEEDED"], { processes: [worker] });
      const refundCreated = await createRefund(ctx, api, payment, Math.floor(payment.amountMinor / 4), "restart-refund");
      const refund = await waitForRefund(ctx, api, refundCreated.refund.refundId, ["SUCCEEDED"], { processes: [worker] });
      const settlementCreated = await createSettlement(ctx, api, fixture.tenant, ctx.at({ days: -180 }), ctx.at({ days: -1 }), "restart");
      const settlement = await waitForSettlement(ctx, api, settlementCreated.settlement.settlementRunId, ["CLOSED"], { timeoutMs: 60_000, processes: [worker] });
      const before = await ctx.snapshot(api.baseUrl);
      assertSnapshot(before);
      assertAccountingClosure(before);
      await ctx.stop(worker);
      await ctx.stop(api);
      await current.migrate();
      await current.migrate();
      const finalApi = await current.startApi();
      const after = await ctx.snapshot(finalApi.baseUrl);
      assertSnapshot(after);
      for (const key of BASE_RESOURCE_KEYS) assert.equal(canonical(after.resources[key]), canonical(before.resources[key]), `restart rewrote ${key}`);
      assert.equal(canonical(after.work), canonical(before.work));
      assert.equal(canonical(after.events), canonical(before.events));
      assert.equal(after.resources.paymentIntents.find(({ paymentIntentId }) => paymentIntentId === unknown.paymentIntentId).state, "UNKNOWN");
      assert.equal(canonical(after.resources.settlementRuns.find(({ settlementRunId }) => settlementRunId === settlement.settlementRunId)), canonical(settlement));
      if (Array.isArray(after.resources.disputes)) assert.deepEqual(after.resources.disputes, []);
      if (Array.isArray(after.resources.adjustments)) assert.deepEqual(after.resources.adjustments, []);
      const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/invoices", replayKey, created.request);
      assert.equal(replay.status, savedStatus);
      assert.deepEqual(replay.json, savedBody);
      assertAccountingClosure(after);
      return result({ invoiceId: created.invoice.invoiceId, paymentIntentId: payment.paymentIntentId, refundId: refund.refundId, settlementRunId: settlement.settlementRunId, unknownPaymentIntentId: unknown.paymentIntentId });
    });
  },
};

const COMPAT02 = {
  id: "COMPAT-02",
  async run(ctx) {
    return unknownPaymentScenario(ctx, { restart: true, resolve: true });
  },
};

const COMPAT03 = {
  id: "COMPAT-03",
  async run(ctx) {
    return guarded(["MIGRATION_COMPATIBILITY", "MONEY_OR_LEDGER_INVARIANT", "REFUND_OR_RESERVE_BOUND"], async () => {
      await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
      await ctx.npm("build", [], { timeoutMs: 600_000 });
      await ctx.migrate();
      const { fixture } = withUnknownPayment(ctx, "snapshot");
      const imported = await ctx.seed(fixture.seed);
      assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
      const replayed = await ctx.seed(fixture.seed);
      assert.equal(replayed.exitCode, 0, replayed.stderr || replayed.stdout);
      const api = await ctx.startApi();
      const initial = await ctx.snapshot(api.baseUrl);
      assertSnapshot(initial);
      assertAccountingClosure(initial);

      const conflictingSeed = structuredClone(fixture.seed);
      conflictingSeed.tenants[0].name = "Changed digest";
      const conflict = await ctx.seed(conflictingSeed, { allowFailure: true });
      assert.notEqual(conflict.exitCode, 0);
      assert.match(`${conflict.stdout}\n${conflict.stderr}`, /SEED_VERSION_CONFLICT/u);
      assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(initial));

      const invalidReference = emptySeed(ctx.fixtures, "invalid-reference");
      invalidReference.customers = [{ ...fixture.customer, customerId: ctx.uuid("orphan-customer"), tenantId: ctx.uuid("missing-tenant") }];
      const invalid = await ctx.seed(invalidReference, { allowFailure: true });
      assert.notEqual(invalid.exitCode, 0);
      assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(initial));

      const managerMember = { ...emptySeed(ctx.fixtures, "manager-member"), disputes: [] };
      const managerRejected = await ctx.seed(managerMember, { allowFailure: true, contractExpectation: "invalid" });
      assert.notEqual(managerRejected.exitCode, 0);
      assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(initial));

      const generated = await createInvoice(ctx, api, "snapshot-current", fixture, {
        periodStart: ctx.at({ days: -59 }), periodEnd: ctx.at({ days: -29 }),
      });
      await finalizeInvoice(ctx, api, generated.invoice, "snapshot-current");
      const worker = await ctx.startWorker();
      const open = await waitForInvoice(ctx, api, generated.invoice.invoiceId, ["OPEN"], { processes: [worker] });
      const paymentCreated = await createPayment(ctx, api, open, "snapshot-payment");
      const payment = await waitForPayment(ctx, api, paymentCreated.paymentIntent.paymentIntentId, ["SUCCEEDED"], { processes: [worker] });
      const refundRequests = Array.from({ length: 8 }, (_, index) => ({ index, amountMinor: 2_000 }));
      const requestsPromise = Promise.all(refundRequests.map(({ index, amountMinor }) => ctx.mutate(
        api.baseUrl, `/api/v1/payment-intents/${payment.paymentIntentId}/refunds`, ctx.key(`snapshot-refund-${index}`), { amountMinor },
      )));
      // Observe early rejection without replacing the original promise awaited below.
      void requestsPromise.catch(() => {});
      const observed = [];
      while (observed.length < 5) {
        const snapshot = await ctx.snapshot(api.baseUrl);
        assertAccountingClosure(snapshot);
        observed.push(snapshot);
      }
      const refundResponses = await requestsPromise;
      for (const response of refundResponses.filter(({ status }) => status !== 200)) assertExactError(response, 409, "REFUND_AMOUNT_EXCEEDED");
      const accepted = refundResponses.filter(({ status }) => status === 200).map(({ json }) => json);
      for (const item of accepted) await waitForRefund(ctx, api, item.refundId, ["SUCCEEDED", "FAILED"], { processes: [worker] });
      const final = await ctx.snapshot(api.baseUrl);
      assertSnapshot(final);
      assertAccountingClosure(final);
      const refunds = final.resources.refunds.filter(({ paymentIntentId }) => paymentIntentId === payment.paymentIntentId);
      assert.ok(refundableMinor(payment, refunds) >= 0);
      balancePostings(final.resources.ledgerEntries);
      return result({ seedVersion: fixture.seed.seedVersion, observedSnapshots: observed.map(({ asOf }) => asOf), acceptedRefunds: accepted.length, rejectedRefunds: refundResponses.length - accepted.length });
    });
  },
};

export const COMPAT_CASES = Object.freeze([COMPAT01, COMPAT02, COMPAT03]);
