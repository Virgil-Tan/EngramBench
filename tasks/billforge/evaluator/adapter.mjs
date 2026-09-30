import assert from "node:assert/strict";
import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const customerId = id(2);
const planId = id(3);
const subscriptionId = id(4);
const rateId = id(5);
const periodStart = "2026-07-01T00:00:00.000Z";
const periodEnd = "2026-08-01T00:00:00.000Z";

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function seed(seedVersion = "hidden-billforge") {
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Tenant" }],
    customers: [{ customerId, tenantId, name: "Hidden Customer", billingCurrency: "USD" }],
    plans: [{ planId, tenantId, name: "Hidden Plan" }],
    priceVersions: [{ planId, version: 1, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, unitAmountMinor: 10_000, currency: "USD", taxVersion: 1, discountVersion: 1 }],
    subscriptions: [{ subscriptionId, tenantId, customerId, planId, startedAt: "2026-01-01T00:00:00.000Z", endedAt: null }],
    exchangeRateSnapshots: [{ exchangeRateSnapshotId: rateId, baseCurrency: "USD", quoteCurrency: "USD", numerator: 1, denominator: 1, capturedAt: periodStart }],
    invoices: [], paymentIntents: [], refunds: [], ledgerAccounts: [], ledgerEntries: [], settlementRuns: [],
  };
}

const spec = {
  label: "BillForge invoice generation",
  performanceScenarioIds: ["invoice-generation", "payment-reconcile", "settlement-recovery"],
  seed: async () => seed(),
  path: "/api/v1/invoices",
  payload: (index) => ({ tenantId, customerId, subscriptionId, periodStart: `2026-${String((index % 6) + 1).padStart(2, "0")}-01T00:00:00.000Z`, periodEnd: `2026-${String((index % 6) + 2).padStart(2, "0")}-01T00:00:00.000Z` }),
  conflictPayload: () => ({ tenantId, customerId, subscriptionId, periodStart, periodEnd: "2026-09-01T00:00:00.000Z" }),
  resource: "invoices",
  identity: (json) => find(json, "invoiceId"),
  resourceIdentity: ({ invoiceId }) => invoiceId,
  workIdentity: (json) => find(json, "invoiceId"),
  async verify(ctx, baseUrl, response) {
    const invoiceId = find(response.json, "invoiceId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const invoice = value.resources.invoices.find((item) => item.invoiceId === invoiceId);
      return invoice?.state === "OPEN" ? value : undefined;
    }, { label: "Invoice finalization", children: [worker] });
    const invoice = snapshot.resources.invoices.find((item) => item.invoiceId === invoiceId);
    assert.equal(invoice.totalMinor, invoice.lines.reduce((sum, line) => sum + line.amountMinor, 0));
    assert.equal(invoice.outstandingMinor, invoice.totalMinor - invoice.paidMinor + invoice.refundedMinor);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/payment-intents", "h04-overflow", { invoiceId: id(999), amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD", providerRequestId: "overflow" });
    assert.ok([400, 404, 409].includes(rejected.status), rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.paymentIntents.length, before.resources.paymentIntents.length);
    assert.equal(after.resources.ledgerEntries.length, before.resources.ledgerEntries.length);
  },
  async contention(ctx, baseUrls) {
    const snapshot = await ctx.snapshot(baseUrls[0]);
    for (const postingId of new Set(snapshot.resources.ledgerEntries.map(({ postingId }) => postingId))) {
      const entries = snapshot.resources.ledgerEntries.filter((entry) => entry.postingId === postingId);
      const signed = entries.reduce((sum, entry) => sum + (entry.direction === "DEBIT" ? entry.amountMinor : -entry.amountMinor), 0);
      assert.equal(signed, 0, `Posting ${postingId} is not balanced`);
    }
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const invoice = await ctx.mutate(baseUrl, "/api/v1/invoices", "manager-invoice", { tenantId, customerId, subscriptionId, periodStart, periodEnd });
      const invoiceId = find(invoice.json, "invoiceId");
      const worker = await ctx.startWorker();
      await ctx.waitFor(async () => (await ctx.snapshot(baseUrl)).resources.invoices.some((item) => item.invoiceId === invoiceId && item.state === "OPEN"), { children: [worker], label: "Manager Invoice OPEN" });
      const payment = await ctx.mutate(baseUrl, "/api/v1/payment-intents", "manager-payment", { invoiceId, amountMinor: 10_000, currency: "USD", providerRequestId: "manager-provider-payment" });
      const paymentIntentId = find(payment.json, "paymentIntentId");
      await ctx.waitFor(async () => (await ctx.snapshot(baseUrl)).resources.paymentIntents.some((item) => item.paymentIntentId === paymentIntentId && item.state === "SUCCEEDED"), { children: [worker], label: "Manager PaymentIntent SUCCEEDED" });
      return { path: `/api/v1/payment-intents/${paymentIntentId}/disputes`, payload: () => ({ providerDisputeId: "hidden-dispute", amountMinor: 4_000 }) };
    },
    async verify(ctx, baseUrl, response) {
      const disputeId = find(response.json, "disputeId");
      const resolved = await ctx.mutate(baseUrl, `/api/v1/disputes/${disputeId}/resolve`, "h10-dispute-resolve", { outcome: "LOST" });
      assert.ok(resolved.status >= 200 && resolved.status < 300, resolved.text);
      const snapshot = await ctx.snapshot(baseUrl);
      const dispute = snapshot.resources.disputes.find((item) => item.disputeId === disputeId);
      assert.equal(dispute?.state, "LOST");
      assert.ok(snapshot.resources.ledgerEntries.some((entry) => entry.postingId === dispute.chargebackPostingId));
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const disputeId = find(response.json, "disputeId");
      const results = await Promise.all(["WON", "LOST"].map((outcome, index) => ctx.mutate(baseUrls[index], `/api/v1/disputes/${disputeId}/resolve`, `h11-dispute-${outcome}`, { outcome })));
      assert.equal(results.filter(({ status }) => status >= 200 && status < 300).length, 1);
      const snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(snapshot.resources.disputes.filter((item) => item.disputeId === disputeId && ["WON", "LOST"].includes(item.state)).length, 1);
    },
  },
  performance: billforgePerformance,
};

async function billforgePerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-billforge"))).exitCode, 0);
  const api = await ctx.startApi();
  const worker = await ctx.startWorker();
  let sequence = 0;
  const invoice = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: () => {
      const index = sequence++;
      const start = new Date(Date.UTC(2030, index, 1)).toISOString();
      const end = new Date(Date.UTC(2030, index + 1, 1)).toISOString();
      return ctx.mutate(api.baseUrl, "/api/v1/invoices", `perf-invoice-${index}`, { tenantId, customerId, subscriptionId, periodStart: start, periodEnd: end });
    },
  });
  assert.ok(invoice.throughput >= 250 && invoice.p95 <= 500, `invoice-generation ${invoice.throughput}/s p95=${invoice.p95}`);
  assertions.push(`invoice-generation ${invoice.throughput.toFixed(1)}/s p95 ${invoice.p95.toFixed(1)}ms`);

  const ready = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const open = snapshot.resources.invoices.filter(({ state }) => state === "OPEN");
    return open.length >= Math.min(1_000, Math.floor(invoice.completed / 2)) ? open : undefined;
  }, { timeoutMs: 120_000, label: "performance Invoices OPEN", children: [worker] });
  let paymentSequence = 0;
  const payment = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: () => {
      const index = paymentSequence++;
      const target = ready[index % ready.length];
      return ctx.mutate(api.baseUrl, "/api/v1/payment-intents", `perf-payment-${index}`, { invoiceId: target.invoiceId, amountMinor: 1, currency: target.currency, providerRequestId: `perf-provider-${index}` });
    },
  });
  assert.ok(payment.throughput >= 150 && payment.p95 <= 600, `payment-reconcile ${payment.throughput}/s p95=${payment.p95}`);
  assertions.push(`payment-reconcile ${payment.throughput.toFixed(1)}/s p95 ${payment.p95.toFixed(1)}ms`);

  await ctx.stop(worker);
  const settlementResponse = await ctx.mutate(api.baseUrl, "/api/v1/settlements", "perf-settlement", { tenantId, periodStart: "2030-01-01T00:00:00.000Z", periodEnd: "2100-01-01T00:00:00.000Z" });
  assert.ok(settlementResponse.status >= 200 && settlementResponse.status < 300, settlementResponse.text);
  const settlementRunId = find(settlementResponse.json, "settlementRunId");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "billforge-perf" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "billforge-perf" })];
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === settlementRunId), { label: "Settlement claimed", children: first });
  await Promise.all(first.map((process) => ctx.stop(process, "SIGKILL")));
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const run = snapshot.resources.settlementRuns.find((item) => item.settlementRunId === settlementRunId);
    return run?.state === "CLOSED" && !snapshot.work.some(({ kind, terminal }) => kind === "SETTLEMENT_CLOSE" && !terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "Settlement recovery", children: replacements });
  const durationMs = Date.now() - startedAt;
  for (const postingId of new Set(final.resources.ledgerEntries.map(({ postingId }) => postingId))) {
    const entries = final.resources.ledgerEntries.filter((entry) => entry.postingId === postingId);
    assert.equal(entries.reduce((sum, entry) => sum + (entry.direction === "DEBIT" ? entry.amountMinor : -entry.amountMinor), 0), 0);
  }
  assertions.push(`settlement-recovery ${durationMs}ms after two SIGKILLs`);
  return { metrics: [{ scenarioId: "invoice-generation", ...invoice }, { scenarioId: "payment-reconcile", ...payment }, { scenarioId: "settlement-recovery", completed: ready.length, durationMs, killedWorkers: 2, replacementWorkers: 2 }] };
}

export default standardAdapter(spec);
