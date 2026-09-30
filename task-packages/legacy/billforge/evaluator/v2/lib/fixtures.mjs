import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 30) || "value";
}

function milliseconds(offset = {}) {
  if (typeof offset === "number") return offset;
  return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0);
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed), caseId: String(caseId), baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + milliseconds(offset)).toISOString(); },
    key(label) { return `bf-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 24)}`; },
    seedVersion(label = "seed") { return `bf-${slug(caseId)}-${slug(label)}-${hash(namespace, "seed", label).toString("hex").slice(0, 12)}`.slice(0, 64); },
  });
}

export function emptySeed(fixtures, label = "empty") {
  return {
    schemaVersion: 1, seedVersion: fixtures.seedVersion(label), importedAt: fixtures.baseTime,
    tenants: [], customers: [], plans: [], priceVersions: [], subscriptions: [], invoices: [],
    paymentIntents: [], refunds: [], exchangeRateSnapshots: [], ledgerAccounts: [], ledgerEntries: [], settlementRuns: [],
  };
}

export function tenant(fixtures, label = "tenant", overrides = {}) {
  return { tenantId: fixtures.uuid(`tenant-${label}`), name: `Tenant ${label}`, ...overrides };
}

export function customer(fixtures, label, owner, overrides = {}) {
  return { customerId: fixtures.uuid(`customer-${label}`), tenantId: owner.tenantId, name: `Customer ${label}`, billingCurrency: "USD", ...overrides };
}

export function plan(fixtures, label, owner, overrides = {}) {
  return { planId: fixtures.uuid(`plan-${label}`), tenantId: owner.tenantId, name: `Plan ${label}`, ...overrides };
}

export function priceVersion(fixtures, label, targetPlan, overrides = {}) {
  return {
    planId: targetPlan.planId, version: 1, effectiveFrom: fixtures.at({ days: -365 }), effectiveTo: null,
    unitAmountMinor: 10_000, currency: "USD", taxVersion: 1, discountVersion: 1, ...overrides,
  };
}

export function subscription(fixtures, label, owner, targetCustomer, targetPlan, overrides = {}) {
  return {
    subscriptionId: fixtures.uuid(`subscription-${label}`), tenantId: owner.tenantId,
    customerId: targetCustomer.customerId, planId: targetPlan.planId,
    startedAt: fixtures.at({ days: -365 }), endedAt: null, ...overrides,
  };
}

export function exchangeRate(fixtures, label, overrides = {}) {
  return {
    exchangeRateSnapshotId: fixtures.uuid(`exchange-${label}`), baseCurrency: "USD", quoteCurrency: "USD",
    numerator: 1, denominator: 1, capturedAt: fixtures.at({ days: -365 }), ...overrides,
  };
}

export function invoice(fixtures, label, owner, targetCustomer, targetSubscription, rate, overrides = {}) {
  const invoiceId = fixtures.uuid(`invoice-${label}`);
  const amount = overrides.totalMinor ?? 10_000;
  return {
    invoiceId, tenantId: owner.tenantId, customerId: targetCustomer.customerId,
    subscriptionId: targetSubscription.subscriptionId, currency: "USD",
    periodStart: fixtures.at({ days: -60 }), periodEnd: fixtures.at({ days: -30 }), state: "OPEN",
    totalMinor: amount, paidMinor: 0, refundedMinor: 0, outstandingMinor: amount,
    priceVersion: 1, taxVersion: 1, discountVersion: 1,
    exchangeRateSnapshotId: rate.exchangeRateSnapshotId,
    lines: [{ invoiceLineId: fixtures.uuid(`invoice-line-${label}`), kind: "BASE", description: `Base ${label}`, quantity: 1, unitAmountMinor: amount, amountMinor: amount }],
    createdAt: fixtures.at({ days: -61 }), finalizedAt: fixtures.at({ days: -60 }), sequence: 2, ...overrides,
  };
}

export function paymentIntent(fixtures, label, targetInvoice, overrides = {}) {
  return {
    paymentIntentId: fixtures.uuid(`payment-${label}`), invoiceId: targetInvoice.invoiceId,
    amountMinor: targetInvoice.totalMinor, currency: targetInvoice.currency, state: "UNKNOWN",
    providerRequestId: `provider-${slug(label)}`, providerTransactionId: null,
    createdAt: fixtures.at({ days: -29 }), resolvedAt: null, sequence: 2, ...overrides,
  };
}

export function settlementRun(fixtures, label, owner, overrides = {}) {
  return {
    settlementRunId: fixtures.uuid(`settlement-${label}`), tenantId: owner.tenantId,
    periodStart: fixtures.at({ days: -90 }), periodEnd: fixtures.at({ days: -60 }), state: "OPEN",
    snapshotDigest: null, totalInvoiceMinor: 0, totalPaymentMinor: 0, totalRefundMinor: 0,
    createdAt: fixtures.at({ days: -59 }), closedAt: null, sequence: 1, ...overrides,
  };
}

export function billingSeed(fixtures, label = "billing", overrides = {}) {
  const owner = tenant(fixtures, label);
  const targetCustomer = customer(fixtures, label, owner);
  const targetPlan = plan(fixtures, label, owner);
  const price = priceVersion(fixtures, label, targetPlan);
  const targetSubscription = subscription(fixtures, label, owner, targetCustomer, targetPlan);
  const rate = exchangeRate(fixtures, label);
  return {
    seed: { ...emptySeed(fixtures, label), tenants: [owner], customers: [targetCustomer], plans: [targetPlan], priceVersions: [price], subscriptions: [targetSubscription], exchangeRateSnapshots: [rate], ...overrides },
    tenant: owner, customer: targetCustomer, plan: targetPlan, price, subscription: targetSubscription, rate,
  };
}
