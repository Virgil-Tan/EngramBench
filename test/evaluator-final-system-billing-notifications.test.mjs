import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFixtureFactory as billFixtures, paymentIntent, settlementRun } from "../evaluators/learning/billforge/v2/lib/fixtures.mjs";
import { createFixtureFactory as notifyFixtures } from "../evaluators/learning/notifyroute/v2/fixtures/index.mjs";
import { disputeScenario, pendingRefundScenario, providerIdentityScenario, reserveRaceScenario, settlementScenario, unknownPaymentScenario } from "../evaluators/learning/billforge/v2/cases/current-system.mjs";
import { campaignControlScenario, campaignFreezeScenario, campaignRecoveryScenario, ingestScenario } from "../evaluators/learning/notifyroute/v2/cases/current-system.mjs";
import { validateManifest as validateBill } from "../evaluators/learning/billforge/v2/lib/scoring.mjs";
import { validateManifest as validateNotify } from "../evaluators/learning/notifyroute/v2/lib/scoring.mjs";
import { BILL_CASES } from "../evaluators/learning/billforge/v2/cases/bill.mjs";
import { CASES as notifyCases } from "../evaluators/learning/notifyroute/v2/cases/index.mjs";
import { webhookSignature } from "../evaluators/learning/notifyroute/v2/oracles/index.mjs";
import { D_CASES } from "../evaluators/learning/notifyroute/v2/cases/d.mjs";
import { validator, requestValidator, matchOperation } from "../task-packages/v2/notifyroute/public-contract/runtime.mjs";

const contracts = Object.fromEntries(await Promise.all(["billforge", "notifyroute"].map(async task => [task, JSON.parse(await readFile(new URL(`../task-packages/v2/${task}/public-contract/contract.json`, import.meta.url)))])));

// This deliberately small HTTP peer tests the evaluator, not a candidate score.
// Each mutant changes one business fact while preserving the request/response
// transport. Cases must call HTTP and then reject the targeted business defect.
async function peer(t, task, defect) {
  const fixtures = (task === "billforge" ? billFixtures : notifyFixtures)({ evaluationSeed: "evaluator-regression", caseId: "A-01", baseTime: "2026-09-08T00:00:00.000Z" });
  const clone = value => structuredClone(value);
  let resources, workers = 0, counter = 0, seed, signingSecret;
  const events = [], work = [], calls = [], replays = new Map(), receiver = { ledger: [], url: "http://127.0.0.1:9/events" };
  const id = label => fixtures.uuid(`${label}-${++counter}`);
  const ok = value => ({ status: 200, json: clone(value) });
  const conflict = () => ({ status: 409, json: { error: { code: "IDEMPOTENCY_CONFLICT", message: "business conflict", details: {} } } });
  function posting(referenceType, referenceId, amountMinor, currency, postingId = id("posting")) {
    const invoice = resources.invoices[0];
    resources.ledgerEntries.push(...["DEBIT", "CREDIT"].map((direction, index) => ({ ledgerEntryId: id("entry"), postingId, tenantId: invoice.tenantId, currency,
      accountCode: index ? "CashClearing" : referenceType === "PAYMENT" ? "CustomerReceivable" : "RefundExpense", direction, amountMinor, referenceType, referenceId, createdAt: fixtures.at() })));
    return postingId;
  }
  function notification(body) {
    const value = { ...clone(body), notificationId: id("notification"), routePolicyRevision: 1, state: "ACCEPTED", acceptedAt: fixtures.at(), terminalAt: null, sequence: 1 };
    resources.notifications.push(value); return value;
  }
  function pump() {
    if (!workers) return;
    if (task === "billforge") {
      for (const value of resources.settlementRuns.filter(item => item.state !== "CLOSED")) Object.assign(value, { state: "CLOSED", snapshotDigest: "a".repeat(64), closedAt: fixtures.at(), sequence: 2 });
      return;
    }
    for (const campaign of resources.campaigns) {
      if (!["QUEUED", "RUNNING"].includes(campaign.state) && !(defect === "ignore-cancel" && campaign.state === "CANCELLED")) continue;
      for (const member of resources.campaignRecipients.filter(item => item.campaignId === campaign.campaignId && !item.notificationId)) {
        if (defect === "drop-fanout") continue;
        const value = notification({ tenantId: campaign.tenantId, recipientId: member.recipientId, category: campaign.category, dedupeKey: `${campaign.campaignId}-${member.recipientId}`, templateVersionId: campaign.templateVersionId, routePolicyId: campaign.routePolicyId, data: campaign.data });
        member.notificationId = value.notificationId;
      }
      campaign.state = "COMPLETED"; campaign.completedAt = fixtures.at();
    }
    for (const value of resources.notifications.filter(item => item.terminalAt === null)) {
      const endpoint = resources.channelEndpoints.find(item => item.recipientId === value.recipientId && item.channel === "WEBHOOK");
      if (!endpoint) continue;
      if (resources.deliveries.some(item => item.notificationId === value.notificationId)) continue;
      const delivery = { deliveryId: id("delivery"), notificationId: value.notificationId, endpointId: endpoint.endpointId, channel: "WEBHOOK", routeOrdinal: 1, state: "DELIVERED", attemptCount: 1, providerMessageId: id("message"), suppressionRevision: 1, nextAttemptAt: null, createdAt: fixtures.at(), terminalAt: fixtures.at(), sequence: 1 };
      resources.deliveries.push(delivery);
      const limit = resources.rateLimitPolicies.find(item => item.channel === "WEBHOOK").recipientLimit;
      if (receiver.ledger.length >= (defect === "overspend-quota" ? Math.max(2, limit) : limit)) {
        Object.assign(delivery, { state: "RATE_LIMITED", attemptCount: 0, providerMessageId: null, nextAttemptAt: new Date((Math.floor(Date.now() / 60_000) + 1) * 60_000).toISOString(), terminalAt: null });
        continue;
      }
      resources.deliveryAttempts.push({ attemptId: id("attempt"), deliveryId: delivery.deliveryId, attemptNumber: 1, providerRequestId: id("provider"), outcome: "ACCEPTED", startedAt: fixtures.at(), finishedAt: fixtures.at() });
      const call = { raw: "Hello Ada Code 042", headers: { "x-notifyroute-delivery-id": delivery.deliveryId, "idempotency-key": id("provider-key") }, json: {} };
      if (signingSecret) call.headers["x-notifyroute-signature"] = webhookSignature(defect === "wrong-signature" ? "wrong-key" : signingSecret, call.raw);
      receiver.ledger.push(call);
      receiver.behavior?.(call);
      value.state = "DELIVERED"; value.terminalAt = fixtures.at();
    }
  }
  async function handle(path, method, body) {
    if (path === "/api/v1/verification-snapshot") {
      pump();
      const sorted = clone(resources);
      for (const values of Object.values(sorted)) values.sort((a, b) => {
        const key = Object.keys(a).find(key => /Id$/.test(key)); return String(a[key]).localeCompare(String(b[key]));
      });
      return ok({ asOf: fixtures.at(), resources: sorted, work: clone(work).sort((a, b) => a.workId.localeCompare(b.workId)), events });
    }
    if (path === "/openapi.json") return ok({ paths: Object.fromEntries(["/api/v1/disputes", "/api/v1/disputes/{disputeId}/resolve", "/api/v1/adjustments"].map(path => [path, {}])) });
    if (task === "notifyroute") {
      if (path === "/api/v1/campaigns") {
        const { recipientIds, ...inputs } = body;
        const campaign = { ...inputs, campaignId: id("campaign"), routePolicyRevision: 1, state: "QUEUED", recipientCount: new Set(recipientIds).size, createdAt: fixtures.at(), completedAt: null, cancelledAt: null };
        const members = (defect === "duplicate-audience" ? recipientIds : [...new Set(recipientIds)]).map(recipientId => ({ campaignId: campaign.campaignId, recipientId, suppressionRevision: 1, notificationId: null }));
        resources.campaigns.push(campaign); resources.campaignRecipients.push(...members);
        work.push({ workId: id("work"), kind: "CAMPAIGN_FANOUT", aggregateId: campaign.campaignId, state: "PENDING", terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null });
        return ok({ campaign, campaignRecipients: members });
      }
      const match = path.match(/^\/api\/v1\/campaigns\/([^/]+)(?:\/(pause|resume|cancel))?$/);
      if (match) {
        const campaign = resources.campaigns.find(item => item.campaignId === match[1]);
        if (method === "GET") return ok({ campaign, campaignRecipients: resources.campaignRecipients.filter(item => item.campaignId === campaign.campaignId) });
        campaign.state = ({ pause: "PAUSED", resume: "QUEUED", cancel: "CANCELLED" })[match[2]];
        if (match[2] === "cancel") campaign.cancelledAt = fixtures.at();
        return ok(campaign);
      }
      if (path === "/api/v1/template-versions") {
        const value = { ...body, templateVersionId: id("template-version"), contentDigest: "b".repeat(64), createdAt: fixtures.at() };
        resources.templateVersions.push(value);
        if (defect === "rewrite-template") resources.campaigns[0].templateVersionId = value.templateVersionId;
        return ok(value);
      }
      if (path === "/api/v1/notifications") return ok(notification(body));
      if (path === "/api/v1/provider/receipts") {
        const previous = resources.providerReceipts.find(item => item.providerEventId === body.providerEventId);
        if (previous) return ok(previous);
        const value = { ...body, providerReceiptId: id("receipt"), receivedAt: fixtures.at() };
        resources.providerReceipts.push(value); return ok(value);
      }
    } else {
      if (path === "/api/v1/payment-intents") {
        const invoice = resources.invoices.find(item => item.invoiceId === body.invoiceId);
        const value = paymentIntent(fixtures, `runtime-${++counter}`, invoice, { ...body, state: "CREATED", sequence: 1 });
        resources.paymentIntents.push(value); return ok(value);
      }
      if (path === "/api/v1/provider/webhooks") {
        const value = resources.paymentIntents.find(item => item.providerRequestId === body.providerRequestId);
        if (resources.paymentIntents.some(item => item.providerTransactionId === body.providerTransactionId && item.paymentIntentId !== value.paymentIntentId)) return conflict();
        if (value.state === "SUCCEEDED") {
          if (defect === "duplicate-posting") posting("PAYMENT", value.paymentIntentId, value.amountMinor, value.currency);
          return ok(value);
        }
        Object.assign(value, { state: "SUCCEEDED", providerTransactionId: body.providerTransactionId, resolvedAt: fixtures.at(), sequence: value.sequence + 1 });
        const invoice = resources.invoices.find(item => item.invoiceId === value.invoiceId);
        Object.assign(invoice, { paidMinor: value.amountMinor, outstandingMinor: invoice.totalMinor - value.amountMinor, state: "PAID" });
        posting("PAYMENT", value.paymentIntentId, value.amountMinor, value.currency);
        return ok(value);
      }
      if (path.endsWith("/reconcile")) return ok(resources.paymentIntents.find(item => path.includes(item.paymentIntentId)));
      if (path.endsWith("/refunds") || path === "/api/v1/disputes") {
        const payment = resources.paymentIntents.find(item => item.paymentIntentId === (body.paymentIntentId ?? path.split("/")[4]));
        const used = resources.refunds.filter(item => item.paymentIntentId === payment.paymentIntentId).reduce((sum, item) => sum + item.amountMinor, 0)
          + resources.disputes.filter(item => item.paymentIntentId === payment.paymentIntentId).reduce((sum, item) => sum + item.reservedMinor, 0);
        if (payment.state !== "SUCCEEDED" || (defect !== "overspend" && used + body.amountMinor > payment.amountMinor)) return conflict();
        if (path.endsWith("/refunds")) {
          const value = { refundId: id("refund"), paymentIntentId: payment.paymentIntentId, amountMinor: body.amountMinor, state: defect === "premature-refund" ? "SUCCEEDED" : "REQUESTED", providerTransactionId: null, createdAt: fixtures.at(), resolvedAt: null };
          resources.refunds.push(value); return ok(value);
        }
        const value = { ...body, disputeId: id("dispute"), currency: payment.currency, state: "OPEN", reservedMinor: body.amountMinor, chargebackPostingId: null, createdAt: fixtures.at(), resolvedAt: null };
        resources.disputes.push(value); return ok(value);
      }
      if (path.endsWith("/resolve")) {
        const value = resources.disputes.find(item => path.includes(item.disputeId));
        Object.assign(value, { state: body.outcome, reservedMinor: 0, resolvedAt: fixtures.at() });
        if (body.outcome === "LOST") {
          value.chargebackPostingId = posting("CHARGEBACK", value.disputeId, value.amountMinor, value.currency);
          if (defect === "duplicate-chargeback") posting("CHARGEBACK", value.disputeId, value.amountMinor, value.currency);
        }
        return ok(value);
      }
      if (path === "/api/v1/settlements") {
        const value = settlementRun(fixtures, `runtime-${++counter}`, resources.tenants[0], body);
        resources.settlementRuns.push(value);
        work.push({ workId: id("work"), kind: "SETTLEMENT_CLOSE", aggregateId: value.settlementRunId, state: "PENDING", terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null });
        return ok(value);
      }
      if (path === "/api/v1/adjustments") {
        if (resources.settlementRuns.find(item => item.settlementRunId === body.settlementRunId).state === "CLOSED") return conflict();
        const value = { ...body, adjustmentId: id("adjustment"), postingId: id("adjustment-posting"), createdAt: fixtures.at() };
        resources.adjustments.push(value);
        posting("ADJUSTMENT", value.adjustmentId, value.amountMinor, value.currency, value.postingId);
        if (defect === "rewrite-history") resources.settlementRuns.find(item => item.state === "CLOSED").snapshotDigest = "c".repeat(64);
        return ok(value);
      }
    }
    throw new Error(`Unexpected evaluator call ${method} ${path}`);
  }
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : null, key = `${request.method}:${request.url}:${request.headers["idempotency-key"]}`;
      calls.push({ path: request.url, method: request.method, body });
      let output;
      if (request.method === "POST" && replays.has(key)) {
        const prior = replays.get(key); output = JSON.stringify(body) === prior.body ? prior.output : conflict();
      } else {
        output = await handle(request.url, request.method, body);
        if (request.method === "POST") replays.set(key, { body: JSON.stringify(body), output: clone(output) });
      }
      response.writeHead(output.status, { "content-type": "application/json" }); response.end(JSON.stringify(output.json));
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (base, path, options = {}) => {
    if (options.method === "POST") {
      const matched = matchOperation(contracts[task].operations, "POST", path);
      assert.ok(matched, `evaluator uses a public route: ${path}`);
      const validated = requestValidator(contracts[task])(matched.operation, { params: matched.params, body: JSON.parse(options.body), hasBody: true, headers: options.headers });
      assert.equal(validated.valid, true, `${path}: ${JSON.stringify(validated.errors)}`);
    }
    const response = await fetch(`${base}${path}`, options);
    const text = await response.text(); return { status: response.status, json: JSON.parse(text), text };
  };
  const ctx = {
    workspace: `peer-${task}-${defect ?? "correct"}`, fixtures, uuid: fixtures.uuid, key: fixtures.key, at: fixtures.at,
    command: async () => ({ exitCode: 0 }), npm: async () => ({ exitCode: 0 }), migrate: async () => ({ exitCode: 0 }), forWorkspace: () => ctx,
    seed: async value => { const valid = validator(contracts[task])(contracts[task].seed.schema); assert.ok(valid(value), JSON.stringify(valid.errors)); seed = clone(value); resources = Object.fromEntries(Object.entries(seed).filter(([, value]) => Array.isArray(value))); Object.assign(resources, task === "billforge" ? { disputes: [], adjustments: [] } : { campaigns: [], campaignRecipients: [] }); return { exitCode: 0 }; },
    startApi: async () => ({ baseUrl, kind: "api" }), stop: async value => { if (value.kind === "worker") workers--; }, kill: async value => { if (value.kind === "worker") workers--; },
    startWorker: async (options = {}) => { signingSecret = options.env?.NOTIFYROUTE_WEBHOOK_SIGNING_SECRET; workers++; pump(); return { kind: "worker" }; }, receiver: async options => { receiver.behavior = options.behavior; return receiver; },
    request, mutate: (base, path, key, body) => request(base, path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) }),
    snapshot: async base => (await request(base, "/api/v1/verification-snapshot")).json,
    waitFor: async operation => { for (let i = 0; i < 5; i++) { const result = await operation(); if (result) return result; } throw new Error("observable business work did not complete"); },
    equal: (a, b, label) => assert.deepEqual(a, b, label), ok: (a, label) => assert.ok(a, label), pass: value => ({ status: "passed", ...value }), mark: () => {},
  };
  return { ctx, calls };
}

for (const [label, task, run, defect, pattern] of [
  ["Campaign freezes exact deduplicated audience", "notifyroute", campaignFreezeScenario, "duplicate-audience", /every frozen audience member/],
  ["Campaign rejects later template rewrite", "notifyroute", campaignFreezeScenario, "rewrite-template", /freezes TemplateVersion/],
  ["Campaign pause/resume executes real fan-out", "notifyroute", campaignControlScenario, "drop-fanout", /did not complete/],
  ["Campaign cancellation survives replacement", "notifyroute", ctx => campaignControlScenario(ctx, { recover: true, cancel: true }), "ignore-cancel", /creates no member Notification/],
  ["Campaign recovery prevents missing member effects", "notifyroute", campaignRecoveryScenario, "drop-fanout", /did not complete/],
  ["Payment duplicate facts cannot duplicate posting", "billforge", providerIdentityScenario, "duplicate-posting", /duplicates never append/],
  ["Reconcile and duplicate fact preserve one posting", "billforge", ctx => providerIdentityScenario(ctx, { reconcile: true }), "duplicate-posting", /duplicates never append/],
  ["Refund reservation cannot report premature success", "billforge", pendingRefundScenario, "premature-refund", /unprocessed refund is reserved/],
  ["Refund and dispute cannot overspend shared reserve", "billforge", reserveRaceScenario, "overspend", /only one contender/],
  ["LOST dispute creates exactly one chargeback", "billforge", ctx => disputeScenario(ctx, { resolution: true }), "duplicate-chargeback", /exactly one balanced chargeback/],
  ["Next-period adjustment cannot rewrite CLOSED history", "billforge", ctx => settlementScenario(ctx, { adjustment: true }), "rewrite-history", /CLOSED settlement snapshot is immutable/],
  ["Actual received Webhook must use the public signing secret", "notifyroute", ctx => D_CASES.find(item => item.id === "D-02").run(ctx), "wrong-signature", /actual Webhook signs exact raw body/],
  ["Hot recipient workload cannot overspend epoch quota", "notifyroute", ctx => ingestScenario(ctx, { quota: true }), "overspend-quota", /recipient quota is never overspent/],
]) {
  test(`${label}: correct HTTP peer passes`, async t => {
    const { ctx, calls } = await peer(t, task); await run(ctx);
    assert.ok(calls.some(item => item.method === "POST"), "must call candidate mutation API");
    assert.ok(calls.some(item => item.path === "/api/v1/verification-snapshot"), "must observe candidate durable state");
  });
  test(`${label}: targeted business mutant fails`, async t => {
    const { ctx } = await peer(t, task, defect); await assert.rejects(run(ctx), pattern);
  });
}

test("UNKNOWN final-system restart resolves only through public provider fact", async t => {
  const { ctx, calls } = await peer(t, "billforge"); await unknownPaymentScenario(ctx, { restart: true, resolve: true });
  assert.equal(calls.filter(item => item.path === "/api/v1/provider/webhooks").length, 1);
});
test("Bounded ingest and restart use real duplicate HTTP calls, no performance score", async t => {
  const { ctx, calls } = await peer(t, "notifyroute"); await ingestScenario(ctx, { restart: true });
  assert.equal(calls.filter(item => item.path === "/api/v1/notifications").length, 24);
});
test("Both final-system manifests retain 22 cases/100 points and reject placeholder metadata", async () => {
  for (const [task, validate] of [["billforge", validateBill], ["notifyroute", validateNotify]]) {
    const manifest = JSON.parse(await readFile(new URL(`../evaluators/learning/${task}/v2/manifest.v2.json`, import.meta.url)));
    const map = JSON.parse(await readFile(new URL(`../evaluators/learning/${task}/v2/contract-map.v2.json`, import.meta.url)));
    validate(manifest, map);
    assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
    manifest.cases[0].blockedAssertions = [{ id: "fake", blockedBy: "fake" }];
    assert.throws(() => validate(manifest, map), /real business assertions/);
  }
  assert.equal(BILL_CASES.length, 5); assert.equal(notifyCases.length, 22);
});
test("HMAC oracle is byte-sensitive and the executable security case checks candidate header", async () => {
  assert.equal(webhookSignature("key", "The quick brown fox jumps over the lazy dog"), "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  assert.notEqual(webhookSignature("key", "body"), webhookSignature("key", "body "));
  const source = await readFile(new URL("../evaluators/learning/notifyroute/v2/cases/d.mjs", import.meta.url), "utf8");
  assert.match(source, /NOTIFYROUTE_WEBHOOK_SIGNING_SECRET/);
  assert.match(source, /call\.headers\["x-notifyroute-signature"\]/);
});
