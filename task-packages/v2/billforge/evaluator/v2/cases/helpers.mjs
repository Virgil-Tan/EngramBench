import assert from "node:assert/strict";

import { assertInvoiceArithmetic, balancePostings, canonical, refundableMinor } from "../lib/oracle.mjs";

export const INVOICE_LINE_KEYS = ["amountMinor", "description", "invoiceLineId", "kind", "quantity", "unitAmountMinor"];
export const INVOICE_KEYS = [
  "createdAt", "currency", "customerId", "discountVersion", "exchangeRateSnapshotId", "finalizedAt",
  "invoiceId", "lines", "outstandingMinor", "paidMinor", "periodEnd", "periodStart", "priceVersion",
  "refundedMinor", "sequence", "state", "subscriptionId", "taxVersion", "tenantId", "totalMinor",
];
export const PAYMENT_KEYS = [
  "amountMinor", "createdAt", "currency", "invoiceId", "paymentIntentId", "providerRequestId",
  "providerTransactionId", "resolvedAt", "sequence", "state",
];
export const REFUND_KEYS = ["amountMinor", "createdAt", "paymentIntentId", "providerTransactionId", "refundId", "resolvedAt", "state"];
export const LEDGER_KEYS = [
  "accountCode", "amountMinor", "createdAt", "currency", "direction", "ledgerEntryId", "postingId",
  "referenceId", "referenceType", "tenantId",
];
export const SETTLEMENT_KEYS = [
  "closedAt", "createdAt", "periodEnd", "periodStart", "sequence", "settlementRunId", "snapshotDigest",
  "state", "tenantId", "totalInvoiceMinor", "totalPaymentMinor", "totalRefundMinor",
];
export const WORK_KEYS = ["aggregateId", "attempt", "kind", "leaseExpiresAt", "leaseOwner", "state", "terminal", "workId"];
export const BASE_RESOURCE_KEYS = [
  "customers", "exchangeRateSnapshots", "invoices", "ledgerAccounts", "ledgerEntries", "paymentIntents",
  "plans", "priceVersions", "refunds", "settlementRuns", "subscriptions", "tenants",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const WORK_KINDS = new Set(["INVOICE_FINALIZATION", "PAYMENT_CAPTURE", "REFUND_PROCESSING", "SETTLEMENT_CLOSE"]);

function bytewise(left, right) { return Buffer.from(left).compare(Buffer.from(right)); }
export function result(evidence, extra = {}) { return { evidence, ...extra }; }

export function guarded(hardCapIds, operation) {
  return Promise.resolve().then(operation).catch((error) => {
    error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
    throw error;
  });
}

export function requireStatus(response, expected, label = "request") {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses.join("/")}, got ${response.status}: ${response.text}`);
  assert.notEqual(response.json, undefined, `${label}: response is not JSON`);
  return response.json;
}

export function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has wrong keys`);
}

export function assertExactError(response, status, code) {
  requireStatus(response, status, code);
  exactKeys(response.json, ["error"], "error response");
  exactKeys(response.json.error, ["code", "details", "message"], "error");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details));
}

export function assertInvoice(value) {
  exactKeys(value, INVOICE_KEYS, "Invoice");
  for (const key of ["invoiceId", "tenantId", "customerId", "subscriptionId", "exchangeRateSnapshotId"]) assert.match(value[key], UUID);
  for (const key of ["periodStart", "periodEnd", "createdAt"]) assert.match(value[key], TIMESTAMP);
  if (value.finalizedAt !== null) assert.match(value.finalizedAt, TIMESTAMP);
  assert.match(value.currency, /^[A-Z]{3}$/u);
  assert.ok(["DRAFT", "OPEN", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOID"].includes(value.state));
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  assert.ok(Array.isArray(value.lines));
  for (const line of value.lines) {
    exactKeys(line, INVOICE_LINE_KEYS, "InvoiceLine");
    assert.match(line.invoiceLineId, UUID);
    assert.ok(["BASE", "PRORATION", "DISCOUNT", "TAX"].includes(line.kind));
  }
  assertInvoiceArithmetic(value);
  return value;
}

export function assertPaymentIntent(value) {
  exactKeys(value, PAYMENT_KEYS, "PaymentIntent");
  assert.match(value.paymentIntentId, UUID);
  assert.match(value.invoiceId, UUID);
  assert.match(value.currency, /^[A-Z]{3}$/u);
  assert.ok(Number.isSafeInteger(value.amountMinor) && value.amountMinor >= 0);
  assert.ok(["CREATED", "PROCESSING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(value.state));
  assert.equal(typeof value.providerRequestId, "string");
  if (value.providerTransactionId !== null) assert.equal(typeof value.providerTransactionId, "string");
  assert.match(value.createdAt, TIMESTAMP);
  if (value.resolvedAt !== null) assert.match(value.resolvedAt, TIMESTAMP);
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  return value;
}

export function assertRefund(value) {
  exactKeys(value, REFUND_KEYS, "Refund");
  assert.match(value.refundId, UUID);
  assert.match(value.paymentIntentId, UUID);
  assert.ok(Number.isSafeInteger(value.amountMinor) && value.amountMinor >= 0);
  assert.ok(["REQUESTED", "PROCESSING", "SUCCEEDED", "FAILED"].includes(value.state));
  assert.match(value.createdAt, TIMESTAMP);
  if (value.resolvedAt !== null) assert.match(value.resolvedAt, TIMESTAMP);
  return value;
}

export function assertLedgerEntry(value) {
  exactKeys(value, LEDGER_KEYS, "LedgerEntry");
  for (const key of ["ledgerEntryId", "postingId", "tenantId", "referenceId"]) assert.match(value[key], UUID);
  assert.match(value.currency, /^[A-Z]{3}$/u);
  assert.ok(["DEBIT", "CREDIT"].includes(value.direction));
  assert.ok(["PAYMENT", "REFUND", "SETTLEMENT", "CHARGEBACK", "ADJUSTMENT"].includes(value.referenceType));
  assert.ok(Number.isSafeInteger(value.amountMinor) && value.amountMinor >= 0);
  assert.match(value.createdAt, TIMESTAMP);
  return value;
}

export function assertSettlement(value) {
  exactKeys(value, SETTLEMENT_KEYS, "SettlementRun");
  assert.match(value.settlementRunId, UUID);
  assert.match(value.tenantId, UUID);
  for (const key of ["periodStart", "periodEnd", "createdAt"]) assert.match(value[key], TIMESTAMP);
  if (value.closedAt !== null) assert.match(value.closedAt, TIMESTAMP);
  if (value.snapshotDigest !== null) assert.match(value.snapshotDigest, SHA256);
  assert.ok(["OPEN", "SNAPSHOTTING", "CALCULATING", "POSTING", "CLOSED"].includes(value.state));
  for (const key of ["totalInvoiceMinor", "totalPaymentMinor", "totalRefundMinor"]) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
  return value;
}

export async function prepare(ctx, seed, { build = true, apis = 1, workers = 0, dispatcherUrl } = {}) {
  if (build) {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
  }
  await ctx.migrate();
  if (seed) {
    const imported = await ctx.seed(seed, { timeoutMs: 600_000 });
    assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  }
  const apiProcesses = [];
  for (let index = 0; index < apis; index += 1) apiProcesses.push(await ctx.startApi());
  const workerProcesses = [];
  for (let index = 0; index < workers; index += 1) workerProcesses.push(await ctx.startWorker());
  const dispatcher = dispatcherUrl ? await ctx.startDispatcher({ webhookUrl: dispatcherUrl }) : undefined;
  return { api: apiProcesses[0], apis: apiProcesses, workers: workerProcesses, dispatcher };
}

export async function createInvoice(ctx, api, label, fixture, overrides = {}, options = {}) {
  const body = {
    tenantId: fixture.tenant.tenantId, customerId: fixture.customer.customerId,
    subscriptionId: fixture.subscription.subscriptionId, subscriptionVersion: fixture.subscription.version, currency: fixture.rate.quoteCurrency,
    periodStart: fixture.periodStart ?? ctx.at({ days: -60 }), periodEnd: fixture.periodEnd ?? ctx.at({ days: -30 }),
    ...overrides,
  };
  const response = await ctx.mutate(api.baseUrl, "/api/v1/invoices", options.key ?? ctx.key(`${label}-invoice`), body);
  const created = assertInvoice(requireStatus(response, 200, `${label} Invoice`));
  assert.equal(created.state, "DRAFT");
  return { invoice: created, request: body, response };
}

export async function finalizeInvoice(ctx, api, target, label, key = ctx.key(`${label}-finalize`)) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/invoices/${target.invoiceId}/finalize`, key, {});
  return { invoice: assertInvoice(requireStatus(response, 200, `${label} finalize`)), response };
}

export async function createPayment(ctx, api, targetInvoice, label, overrides = {}, key = ctx.key(`${label}-payment`)) {
  const body = {
    invoiceId: targetInvoice.invoiceId, amountMinor: targetInvoice.totalMinor,
    currency: targetInvoice.currency, ...overrides,
  };
  const response = await ctx.mutate(api.baseUrl, "/api/v1/payment-intents", key, body);
  return { paymentIntent: assertPaymentIntent(requireStatus(response, 200, `${label} PaymentIntent`)), request: body, response };
}

export async function createRefund(ctx, api, targetPayment, amountMinor, label, key = ctx.key(`${label}-refund`)) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/payment-intents/${targetPayment.paymentIntentId}/refunds`, key, { amountMinor });
  return { refund: assertRefund(requireStatus(response, 200, `${label} Refund`)), response };
}

export async function createSettlement(ctx, api, owner, periodStart, periodEnd, label, key = ctx.key(`${label}-settlement`)) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/settlements", key, { tenantId: owner.tenantId, periodStart, periodEnd });
  return { settlement: assertSettlement(requireStatus(response, 200, `${label} SettlementRun`)), response };
}

export async function waitForResource(ctx, api, resource, idKey, id, states, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: options.requestTimeoutMs });
    const value = snapshot.resources[resource]?.find((item) => item[idKey] === id);
    return value && states.includes(value.state) ? value : undefined;
  }, { timeoutMs: options.timeoutMs ?? 30_000, intervalMs: 50, label: `${resource}/${id} ${states.join("/")}`, processes: options.processes });
}

export async function waitForInvoice(ctx, api, invoiceId, states, options) {
  return assertInvoice(await waitForResource(ctx, api, "invoices", "invoiceId", invoiceId, states, options));
}
export async function waitForPayment(ctx, api, paymentIntentId, states, options) {
  return assertPaymentIntent(await waitForResource(ctx, api, "paymentIntents", "paymentIntentId", paymentIntentId, states, options));
}
export async function waitForRefund(ctx, api, refundId, states, options) {
  return assertRefund(await waitForResource(ctx, api, "refunds", "refundId", refundId, states, options));
}
export async function waitForSettlement(ctx, api, settlementRunId, states, options) {
  return assertSettlement(await waitForResource(ctx, api, "settlementRuns", "settlementRunId", settlementRunId, states, options));
}

export function stableSnapshot(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

export function assertNoPrivateFields(value, path = "snapshot") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoPrivateFields(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.doesNotMatch(key, /(?:Token|credential|secret|idempotencyKey|raw.*provider|provider.*raw|privatePath)$/iu, `${path}.${key} exposes private data`);
    assertNoPrivateFields(item, `${path}.${key}`);
  }
}

function assertSorted(items, comparator, label) {
  assert.deepEqual(items, items.toSorted(comparator), `${label} is not in published order`);
}

export function assertSnapshot(snapshot) {
  exactKeys(snapshot, ["asOf", "events", "resources", "work"], "verification snapshot");
  assert.match(snapshot.asOf, TIMESTAMP);
  assert.ok(Array.isArray(snapshot.work), "snapshot Work is not an array");
  assert.ok(Array.isArray(snapshot.events), "snapshot Events is not an array");
  assert.ok(snapshot.resources && typeof snapshot.resources === "object" && !Array.isArray(snapshot.resources));
  for (const key of BASE_RESOURCE_KEYS) assert.ok(Array.isArray(snapshot.resources[key]), `snapshot misses base ${key}`);
  assertNoPrivateFields(snapshot);
  for (const item of snapshot.resources.invoices) assertInvoice(item);
  for (const item of snapshot.resources.paymentIntents) assertPaymentIntent(item);
  for (const item of snapshot.resources.refunds) assertRefund(item);
  for (const item of snapshot.resources.ledgerEntries) assertLedgerEntry(item);
  for (const item of snapshot.resources.settlementRuns) assertSettlement(item);
  for (const item of snapshot.work) {
    exactKeys(item, WORK_KEYS, "Work");
    assert.match(item.workId, UUID);
    assert.match(item.aggregateId, UUID);
    assert.ok(WORK_KINDS.has(item.kind), `unpublished Work kind ${item.kind}`);
    assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state));
    assert.equal(item.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state));
    assert.equal(item.leaseOwner !== null, item.state === "LEASED");
    assert.equal(item.leaseExpiresAt !== null, item.state === "LEASED");
  }
  assertSorted(snapshot.resources.tenants, (a, b) => bytewise(a.tenantId, b.tenantId), "tenants");
  assertSorted(snapshot.resources.customers, (a, b) => bytewise(a.customerId, b.customerId), "customers");
  assertSorted(snapshot.resources.plans, (a, b) => bytewise(a.planId, b.planId), "plans");
  assertSorted(snapshot.resources.priceVersions, (a, b) => bytewise(a.priceVersionId, b.priceVersionId), "priceVersions");
  assertSorted(snapshot.resources.subscriptions, (a, b) => bytewise(a.subscriptionId, b.subscriptionId), "subscriptions");
  assertSorted(snapshot.resources.exchangeRateSnapshots, (a, b) => bytewise(a.exchangeRateSnapshotId, b.exchangeRateSnapshotId), "exchangeRateSnapshots");
  assertSorted(snapshot.resources.invoices, (a, b) => bytewise(a.invoiceId, b.invoiceId), "invoices");
  assertSorted(snapshot.resources.paymentIntents, (a, b) => bytewise(a.paymentIntentId, b.paymentIntentId), "paymentIntents");
  assertSorted(snapshot.resources.refunds, (a, b) => bytewise(a.refundId, b.refundId), "refunds");
  assertSorted(snapshot.resources.ledgerAccounts, (a, b) => bytewise(a.ledgerAccountId, b.ledgerAccountId), "ledgerAccounts");
  assertSorted(snapshot.resources.ledgerEntries, (a, b) => bytewise(a.ledgerEntryId, b.ledgerEntryId), "ledgerEntries");
  assertSorted(snapshot.resources.settlementRuns, (a, b) => bytewise(a.settlementRunId, b.settlementRunId), "settlementRuns");
  assertSorted(snapshot.work, (a, b) => bytewise(a.workId, b.workId), "work");
  return snapshot;
}

export function assertAccountingClosure(snapshot) {
  assertSnapshot(snapshot);
  balancePostings(snapshot.resources.ledgerEntries);
  const invoiceById = new Map(snapshot.resources.invoices.map((item) => [item.invoiceId, item]));
  const paymentById = new Map(snapshot.resources.paymentIntents.map((item) => [item.paymentIntentId, item]));
  for (const payment of paymentById.values()) assert.ok(invoiceById.has(payment.invoiceId), "PaymentIntent references a missing Invoice");
  const refundsByPayment = Map.groupBy(snapshot.resources.refunds, ({ paymentIntentId }) => paymentIntentId);
  for (const [paymentIntentId, refunds] of refundsByPayment) {
    const payment = paymentById.get(paymentIntentId);
    assert.ok(payment, "Refund references a missing PaymentIntent");
    refundableMinor(payment, refunds);
  }
  const successfulPaymentsByInvoice = new Map();
  for (const payment of paymentById.values()) if (payment.state === "SUCCEEDED") {
    successfulPaymentsByInvoice.set(payment.invoiceId, (successfulPaymentsByInvoice.get(payment.invoiceId) ?? 0) + payment.amountMinor);
  }
  const successfulRefundsByInvoice = new Map();
  for (const refund of snapshot.resources.refunds) if (refund.state === "SUCCEEDED") {
    const payment = paymentById.get(refund.paymentIntentId);
    assert.ok(payment, "successful Refund has no PaymentIntent");
    successfulRefundsByInvoice.set(payment.invoiceId, (successfulRefundsByInvoice.get(payment.invoiceId) ?? 0) + refund.amountMinor);
  }
  for (const invoice of invoiceById.values()) {
    assert.equal(invoice.paidMinor, successfulPaymentsByInvoice.get(invoice.invoiceId) ?? 0, "Invoice paidMinor does not match successful payments");
    assert.equal(invoice.refundedMinor, successfulRefundsByInvoice.get(invoice.invoiceId) ?? 0, "Invoice refundedMinor does not match successful refunds");
  }
  const eventGroups = Map.groupBy(snapshot.events, ({ aggregateId }) => aggregateId);
  for (const events of eventGroups.values()) {
    assert.deepEqual(events.map(({ sequence }) => sequence), Array.from({ length: events.length }, (_, index) => index + 1));
    assert.equal(new Set(events.map(({ eventId }) => eventId)).size, events.length);
  }
  return true;
}

export function eventFor(snapshot, aggregateId, type) {
  return snapshot.events.filter((event) => event.aggregateId === aggregateId && event.type === type);
}

export function canonicalResource(value) { return canonical(value); }
