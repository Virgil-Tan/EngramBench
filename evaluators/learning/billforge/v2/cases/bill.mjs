import assert from "node:assert/strict";

import { billingSeed, emptySeed, plan, priceVersion } from "../lib/fixtures.mjs";
import { assertFrozen, canonical, selectEffectiveVersion } from "../lib/oracle.mjs";
import {
  assertAccountingClosure, assertExactError, assertInvoice, createInvoice, eventFor,
  finalizeInvoice, guarded, prepare, requireStatus, result, waitForInvoice, waitForSettlement,
} from "./helpers.mjs";

async function readInvoice(ctx, api, invoiceId) {
  return assertInvoice(requireStatus(await ctx.request(api.baseUrl, `/api/v1/invoices/${invoiceId}`), 200, "Invoice read"));
}

async function publishPrice(ctx, api, label, targetPlan, body) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/price-versions", ctx.key(`${label}-price`), { tenantId: targetPlan.tenantId, planId: targetPlan.planId, ...body });
  requireStatus(response, 200, `${label} PriceVersion`);
  return response.json;
}

const BILL01 = {
  id: "BILL-01",
  async run(ctx) {
    return guarded(["MONEY_OR_LEDGER_INVARIANT"], async () => {
      const fixture = billingSeed(ctx.fixtures, "terms");
      const boundary = ctx.at({ days: -180 });
      const nextBoundary = ctx.at({ days: -10 });
      const versions = [
        { ...fixture.price, version: 1, effectiveFrom: ctx.at({ days: -365 }), effectiveTo: boundary, unitAmountMinor: 8_000 },
        { ...fixture.price, priceVersionId: ctx.uuid("terms-price-v2"), version: 2, effectiveFrom: boundary, effectiveTo: nextBoundary, unitAmountMinor: 12_000 },
      ];
      fixture.seed.priceVersions = versions;
      const { api } = await prepare(ctx, fixture.seed);
      const periods = [
        [ctx.at({ days: -200 }), ctx.at({ days: -190 })],
        [ctx.at({ days: -170 }), ctx.at({ days: -160 })],
      ];
      const created = [];
      for (const [index, [periodStart, periodEnd]] of periods.entries()) {
        const item = await createInvoice(ctx, api, `terms-${index}`, fixture, { periodStart, periodEnd });
        const selected = selectEffectiveVersion(versions, periodStart);
        assert.equal(item.invoice.priceVersion, selected.version);
        // Tax/discount configuration has no published seed or request fields.
        // The case selects public price history without inventing tax configuration.
        assert.equal(item.invoice.exchangeRateSnapshotId, fixture.rate.exchangeRateSnapshotId);
        await finalizeInvoice(ctx, api, item.invoice, `terms-${index}`);
        created.push(item.invoice);
      }
      const worker = await ctx.startWorker();
      const beforeNewVersion = [];
      for (const item of created) beforeNewVersion.push(await waitForInvoice(ctx, api, item.invoiceId, ["OPEN"], { processes: [worker] }));
      await publishPrice(ctx, api, "later", fixture.plan, {
        effectiveFrom: nextBoundary, effectiveTo: null, unitAmountMinor: 99_999,
        currency: "USD", version: 3,
      });
      for (const [index, item] of beforeNewVersion.entries()) assertFrozen(item, await readInvoice(ctx, api, item.invoiceId), `frozen Invoice ${index}`);
      const snapshot = await ctx.snapshot(api.baseUrl);
      assertAccountingClosure(snapshot);
      return result({ invoiceIds: created.map(({ invoiceId }) => invoiceId), selectedVersions: periods.map(([start]) => selectEffectiveVersion(versions, start).version), scope: "published effective price selection and immutable invoice terms" });
    });
  },
};

const BILL02 = {
  id: "BILL-02",
  async run(ctx) {
    return guarded(["MONEY_OR_LEDGER_INVARIANT", "DURABLE_IDEMPOTENCY"], async () => {
      const fixture = billingSeed(ctx.fixtures, "proration");
      const upgradedPlan = plan(ctx.fixtures, "upgrade", fixture.tenant);
      const upgradedPrice = priceVersion(ctx.fixtures, "upgrade", upgradedPlan, { unitAmountMinor: 18_000, effectiveTo: ctx.at({ days: 1 }) });
      fixture.seed.plans.push(upgradedPlan);
      fixture.seed.priceVersions.push(upgradedPrice);
      const { api } = await prepare(ctx, fixture.seed);
      const changedAt = ctx.at({ days: -45 });
      const changeBody = { expectedVersion: fixture.subscription.version, planId: upgradedPlan.planId, quantity: fixture.subscription.quantity, effectiveAt: changedAt };
      const changeKey = ctx.key("upgrade-change");
      const changed = await ctx.mutate(api.baseUrl, `/api/v1/subscriptions/${fixture.subscription.subscriptionId}/change`, changeKey, changeBody);
      requireStatus(changed, 200, "subscription upgrade");
      const replayedChange = await ctx.mutate(api.baseUrl, `/api/v1/subscriptions/${fixture.subscription.subscriptionId}/change`, changeKey, changeBody);
      assert.equal(replayedChange.status, changed.status);
      assert.deepEqual(replayedChange.json, changed.json);
      const generated = await createInvoice(ctx, api, "proration", fixture, { subscriptionVersion: changed.json.version, periodStart: ctx.at({ days: -60 }), periodEnd: ctx.at({ days: -30 }) });
      await finalizeInvoice(ctx, api, generated.invoice, "proration");
      const worker = await ctx.startWorker();
      const finalized = await waitForInvoice(ctx, api, generated.invoice.invoiceId, ["OPEN"], { processes: [worker] });
      assert.ok(finalized.lines.some(({ kind }) => kind === "PRORATION"), "changed period has no PRORATION line");
      assert.ok(finalized.lines.every(({ unitAmountMinor, amountMinor }) => Number.isSafeInteger(unitAmountMinor) && unitAmountMinor >= 0 && Number.isSafeInteger(amountMinor) && amountMinor >= 0));
      const cancelBody = { expectedVersion: changed.json.version, effectiveAt: new Date((Date.parse(changedAt) + Date.parse(changed.json.periodEnd)) / 2).toISOString() };
      const cancelKey = ctx.key("subscription-cancel");
      const cancelled = await ctx.mutate(api.baseUrl, `/api/v1/subscriptions/${fixture.subscription.subscriptionId}/cancel`, cancelKey, cancelBody);
      requireStatus(cancelled, 200, "subscription cancellation");
      assert.deepEqual((await ctx.mutate(api.baseUrl, `/api/v1/subscriptions/${fixture.subscription.subscriptionId}/cancel`, cancelKey, cancelBody)).json, cancelled.json);
      await publishPrice(ctx, api, "post-proration", upgradedPlan, {
        effectiveFrom: ctx.at({ days: 1 }), effectiveTo: null, unitAmountMinor: 25_000,
        currency: "USD", version: 2,
      });
      assertFrozen(finalized, await readInvoice(ctx, api, finalized.invoiceId), "proration Invoice");
      return result({ scope: "real subscription change/cancel, deterministic replay and frozen non-negative proration lines; no unpublished rounding formula" });
    });
  },
};

const BILL03 = {
  id: "BILL-03",
  async run(ctx) {
    return guarded(["MONEY_OR_LEDGER_INVARIANT", "SETTLEMENT_IMMUTABILITY_OR_RECOVERY"], async () => {
      const fixture = billingSeed(ctx.fixtures, "fx");
      fixture.price.currency = "EUR";
      fixture.price.unitAmountMinor = 9_000;
      fixture.rate.baseCurrency = "EUR";
      fixture.rate.quoteCurrency = "USD";
      fixture.rate.numerator = 11;
      fixture.rate.denominator = 10;
      const { api } = await prepare(ctx, fixture.seed);
      const generated = await createInvoice(ctx, api, "fx", fixture, { periodStart: ctx.at({ days: -60 }), periodEnd: ctx.at({ days: -30 }) });
      assert.equal(generated.invoice.exchangeRateSnapshotId, fixture.rate.exchangeRateSnapshotId);
      await finalizeInvoice(ctx, api, generated.invoice, "fx");
      const worker = await ctx.startWorker();
      const finalized = await waitForInvoice(ctx, api, generated.invoice.invoiceId, ["OPEN"], { processes: [worker] });
      const laterRate = {
        ...fixture.rate, exchangeRateSnapshotId: ctx.uuid("later-rate"), numerator: 13,
        denominator: 10, effectiveFrom: ctx.at({ days: -1 }), createdAt: ctx.at({ days: -1 }),
      };
      const incremental = { ...emptySeed(ctx.fixtures, "later-rate"), exchangeRateSnapshots: [laterRate] };
      const imported = await ctx.seed(incremental);
      assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
      assertFrozen(finalized, await readInvoice(ctx, api, finalized.invoiceId), "FX Invoice");
      const paymentResponse = await ctx.mutate(api.baseUrl, "/api/v1/payment-intents", ctx.key("fx-payment"), {
        invoiceId: finalized.invoiceId, amountMinor: finalized.totalMinor, currency: finalized.currency,
      });
      const payment = requireStatus(paymentResponse, 200, "FX PaymentIntent");
      await waitForInvoice(ctx, api, finalized.invoiceId, ["PAID"], { processes: [worker] });
      const settlementResponse = await ctx.mutate(api.baseUrl, "/api/v1/settlements", ctx.key("fx-settlement"), {
        tenantId: fixture.tenant.tenantId, periodStart: ctx.at({ days: -90 }), periodEnd: ctx.at({ days: -1 }),
      });
      const settlement = requireStatus(settlementResponse, 200, "FX SettlementRun");
      await waitForInvoice(ctx, api, finalized.invoiceId, ["PAID"], { processes: [worker] });
      const closed = await waitForSettlement(ctx, api, settlement.settlementRunId, ["CLOSED"], { processes: [worker] });
      assert.match(closed.snapshotDigest, /^[0-9a-f]{64}$/u);
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.equal(snapshot.resources.invoices.find(({ invoiceId }) => invoiceId === finalized.invoiceId).exchangeRateSnapshotId, fixture.rate.exchangeRateSnapshotId);
      assert.ok(snapshot.resources.ledgerEntries.filter(({ referenceId }) => referenceId === payment.paymentIntentId).every(({ currency }) => currency === finalized.currency));
      assertAccountingClosure(snapshot);
      return result({ scope: "invoice/payment/settlement retain frozen exchange-rate identity and currency; no unpublished FX rounding formula" });
    });
  },
};

const BILL04 = {
  id: "BILL-04",
  async run(ctx) {
    return guarded(["MONEY_OR_LEDGER_INVARIANT", "DURABLE_IDEMPOTENCY"], async () => {
      const fixture = billingSeed(ctx.fixtures, "discount-tax");
      fixture.price.unitAmountMinor = 1_001;
      fixture.price.effectiveTo = ctx.at({ days: 1 });
      const { api } = await prepare(ctx, fixture.seed);
      const key = ctx.key("discount-tax-invoice");
      const first = await createInvoice(ctx, api, "discount-tax", fixture, {}, { key });
      const replay = await ctx.mutate(api.baseUrl, "/api/v1/invoices", key, first.request);
      assert.equal(replay.status, first.response.status);
      assert.deepEqual(replay.json, first.response.json);
      assert.ok(first.invoice.lines.every(({ amountMinor }) => Number.isSafeInteger(amountMinor) && amountMinor >= 0));
      await finalizeInvoice(ctx, api, first.invoice, "discount-tax");
      const worker = await ctx.startWorker();
      const frozen = await waitForInvoice(ctx, api, first.invoice.invoiceId, ["OPEN"], { processes: [worker] });
      assert.ok(frozen.totalMinor >= 0 && frozen.outstandingMinor >= 0);
      await publishPrice(ctx, api, "post-tax", fixture.plan, {
        effectiveFrom: ctx.at({ days: 1 }), effectiveTo: null, unitAmountMinor: 2_000,
        currency: "USD", version: 2,
      });
      assertFrozen(frozen, await readInvoice(ctx, api, frozen.invoiceId), "tax and discount Invoice");
      return result({ scope: "line-total conservation, non-negative safe money and immutable finalized terms; no invented tax/discount configuration" });
    });
  },
};

const BILL05 = {
  id: "BILL-05",
  async run(ctx) {
    return guarded(["DURABLE_IDEMPOTENCY", "MONEY_OR_LEDGER_INVARIANT"], async () => {
      const fixture = billingSeed(ctx.fixtures, "unique");
      const { apis } = await prepare(ctx, fixture.seed, { apis: 2 });
      const body = {
        tenantId: fixture.tenant.tenantId, customerId: fixture.customer.customerId,
        subscriptionId: fixture.subscription.subscriptionId, subscriptionVersion: fixture.subscription.version, currency: fixture.rate.quoteCurrency,
        periodStart: ctx.at({ days: -60 }), periodEnd: ctx.at({ days: -30 }),
      };
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
        apis[index % 2].baseUrl, "/api/v1/invoices", ctx.key(`unique-${index}`), body,
      )));
      assert.equal(responses.filter(({ status }) => status === 200).length, 1);
      for (const response of responses.filter(({ status }) => status !== 200)) assertExactError(response, 409, "INVOICE_ALREADY_EXISTS");
      const invoice = assertInvoice(responses.find(({ status }) => status === 200).json);
      const shield = await ctx.responseShield(apis[0].baseUrl);
      const finalizeKey = ctx.key("lost-finalize");
      shield.dropNextMutation();
      await assert.rejects(ctx.mutate(shield.baseUrl, `/api/v1/invoices/${invoice.invoiceId}/finalize`, finalizeKey, {}));
      const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped Invoice finalize response" });
      const replay = await ctx.mutate(apis[1].baseUrl, `/api/v1/invoices/${invoice.invoiceId}/finalize`, finalizeKey, {});
      assert.equal(replay.status, capture.response.status);
      assert.deepEqual(replay.json, JSON.parse(capture.response.body));
      const worker = await ctx.startWorker();
      const finalized = await waitForInvoice(ctx, apis[1], invoice.invoiceId, ["OPEN"], { processes: [worker] });
      const before = canonical(finalized);
      const snapshot = await ctx.snapshot(apis[1].baseUrl);
      assert.equal(snapshot.resources.invoices.filter(({ invoiceId }) => invoiceId === invoice.invoiceId).length, 1);
      assert.equal(snapshot.work.filter(({ aggregateId, kind }) => aggregateId === invoice.invoiceId && kind === "INVOICE_FINALIZATION").length, 1);
      assert.equal(eventFor(snapshot, invoice.invoiceId, "invoice.created").length, 1);
      assert.equal(eventFor(snapshot, invoice.invoiceId, "invoice.finalized").length, 1);
      assert.equal(canonical(await readInvoice(ctx, apis[1], invoice.invoiceId)), before);
      return result({ invoiceId: invoice.invoiceId, contenders: responses.length, finalizeReplay: replay.json });
    });
  },
};

export const BILL_CASES = Object.freeze([BILL01, BILL02, BILL03, BILL04, BILL05]);
