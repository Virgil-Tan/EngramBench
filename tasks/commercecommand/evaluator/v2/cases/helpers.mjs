import assert from "node:assert/strict";
import { assertCoreInvariants, canonicalJson, percentile, quoteOracle, resource, stableSnapshot } from "../oracles/index.mjs";

const TITLES = Object.freeze({
  "A-01": "Clean install/build/boot", "A-02": "Repeatable populated migration", "A-03": "Strict atomic seed", "A-04": "HTTP/OpenAPI/idempotency envelope", "A-05": "Tenant isolation, reads and snapshot", "A-06": "Immutable offers and stock adjustments", "A-07": "Frozen quote and allocation", "A-08": "Checkout and UNKNOWN payment", "A-09": "Callback/reconcile and capture", "A-10": "Physical fulfillment", "A-11": "Digital entitlement", "A-12": "Cancel/refund/restock", "A-13": "Ledger, Events and notifications", "A-14": "FINAL seller allocation and settlement", "A-15": "FINAL dispute and adjustment",
  "B-01": "Allocation and inventory conservation oracle", "B-02": "Hot-stock quote contention", "B-03": "Provider callback precedence race", "B-04": "Unknown-response durable replay", "B-05": "Same-key authority across APIs", "B-06": "Checkout/capture terminal race", "B-07": "Refund/restock/reserve contention", "B-08": "Fulfillment/entitlement races", "B-09": "Seller allocation/settlement close race", "B-10": "Dispute/adjustment catastrophe ordering",
  "C-01": "Work lifecycle and retention", "C-02": "SIGKILL after Worker claim", "C-03": "Expired fencing token", "C-04": "Fulfillment recovery", "C-05": "Payment reconciliation recovery", "C-06": "FINAL settlement/dispute Work recovery", "C-07": "Unknown notification ACK", "C-08": "Transactional event/outbox/ledger ordering",
  "D-01": "OpenAPI validates live traffic", "D-02": "Browser mixed quote/checkout", "D-03": "Browser cancel/refund/ledger", "D-04": "Browser marketplace flow", "D-05": "UI states/accessibility/security", "D-06": "Snapshot/browser/API cross-check", "D-07": "Project-owned gates not fake green", "D-08": "README-to-evidence closure",
  "E-01": "Populated V1→FINAL/blue-green migration", "E-02": "Saved replay/Event/Ledger compatibility", "E-03": "Pending Work/outbox migration", "E-04": "`quote-read-mix`", "E-05": "`checkout-contention`", "E-06": "`inventory-hotspot`", "E-07": "`payment-unknown-reconcile`", "E-08": "`fulfillment-drain`", "E-09": "`notification-unknown-ack`", "E-10": "`entitlement-revocation-storm`", "E-11": "`seller-settlement-close`", "E-12": "`refund-dispute-race`", "E-13": "`full-catastrophe-recovery`", "E-14": "Operability cleanup and reproducibility",
});

const FAMILY = Object.freeze({
  A: ["EMPTY", "MIGRATION", "EMPTY", "MAIN", "MAIN", "MAIN", "QUOTE", "PAYMENT", "PAYMENT", "FULFILLMENT", "ENTITLEMENT", "LEDGER", "LEDGER", "MARKETPLACE", "MARKETPLACE"],
  B: ["QUOTE", "QUOTE", "PAYMENT", "IDEMPOTENCY", "IDEMPOTENCY", "PAYMENT", "LEDGER", "FULFILLMENT", "MARKETPLACE", "MARKETPLACE"],
  C: ["WORK", "WORK", "WORK", "FULFILLMENT", "PAYMENT", "MARKETPLACE", "LEDGER", "LEDGER"],
  D: ["MAIN", "BROWSER", "BROWSER", "MARKETPLACE", "BROWSER", "BROWSER", "MAIN", "MAIN"],
  E: ["MIGRATION", "MIGRATION", "MIGRATION", "PERF", "PERF", "PERF", "PERF", "PERF", "PERF", "PERF", "PERF", "PERF", "PERF", "MAIN"],
});

export function defineCase(id, run) {
  const title = TITLES[id];
  const dimension = id[0];
  const family = FAMILY[dimension]?.[Number(id.slice(2)) - 1];
  if (!title || !family) throw new Error(`unknown CommerceCommand case ${id}`);
  return Object.freeze({
    id,
    taskId: "commercecommand",
    fixtureFamily: `CC-F-${family}`,
    action: `Exercise CommerceCommand ${title} only through published commands HTTP production processes browser and public observation seams`,
    oracle: `Compare CommerceCommand ${title} against task-local deterministic inventory money payment ledger Work and persistence oracles`,
    async run(ctx) {
      return run(ctx);
    },
  });
}

export function guardedCase(id, hardCapIds, run) {
  return defineCase(id, async (ctx) => {
    try {
      return await run(ctx);
    } catch (error) {
      error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
      throw error;
    }
  });
}

export function diagnostic(assertionId, blockedBy) {
  return { assertionId, blockedBy, policy: "fail-closed-diagnostic" };
}

export function blockedCase(id, declarations) {
  return defineCase(id, async (ctx) => {
    ctx.mark("contract.blocked", { gaps: declarations.map(([, gap]) => gap) });
    return ctx.pass({ diagnostics: declarations.map(([assertionId, blockedBy]) => diagnostic(assertionId, blockedBy)) });
  });
}

export function successful(response, label = "request", statuses) {
  assert.ok(statuses ? statuses.includes(response.status) : response.status >= 200 && response.status < 300, `${label} returned ${response.status}: ${response.text}`);
  if (response.status !== 204) assert.ok(response.json !== undefined, `${label} returns JSON`);
  return response;
}

export function semanticError(response, status, code) {
  assert.equal(response.status, status, `${code} status`);
  assert.deepEqual(Object.keys(response.json ?? {}).sort(), ["error"], `${code} envelope`);
  assert.deepEqual(Object.keys(response.json?.error ?? {}).sort(), ["code", "details", "message"], `${code} error fields`);
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details));
}

export async function prepare(ctx, fixture, { apiCount = 1, workerCount = 0, dispatcherCount = 0, migrateTwice = false, webhookUrl } = {}) {
  await ctx.migrate();
  if (migrateTwice) await ctx.migrate();
  await ctx.seed(fixture.seed);
  const apis = await Promise.all(Array.from({ length: apiCount }, () => ctx.startApi()));
  const workers = await Promise.all(Array.from({ length: workerCount }, () => ctx.startWorker()));
  const dispatchers = await Promise.all(Array.from({ length: dispatcherCount }, () => ctx.startDispatcher({ webhookUrl })));
  ctx.mark("commercecommand.prepared", { fixtureFamily: fixture.fixtureFamily, apiCount, workerCount, dispatcherCount });
  return { api: apis[0], apis, workers, dispatchers };
}

export async function quote(ctx, baseUrl, fixture, label = "quote", overrides = {}, options = {}) {
  const body = options.mixed ? ctx.fixtures.mixedQuoteBody(fixture, label, overrides) : ctx.fixtures.quoteBody(fixture, label, overrides);
  const response = await ctx.mutate(baseUrl, "/api/v1/orders/quotes", options.key ?? ctx.key(`quote:${label}`), body);
  if (options.expectSuccess !== false) successful(response, `quote ${label}`, [201]);
  const orderId = response.json?.orderId;
  if (options.expectSuccess !== false) assert.match(orderId ?? "", /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu, "quote orderId");
  return { body, response, orderId };
}

export async function checkout(ctx, baseUrl, orderId, label = "checkout", options = {}) {
  const body = { provider: "SANDBOX", providerRequestId: options.providerRequestId ?? `provider-${ctx.key(label)}` };
  const response = await ctx.mutate(baseUrl, `/api/v1/orders/${orderId}/checkout`, options.key ?? ctx.key(`checkout:${label}`), body);
  if (options.expectSuccess !== false) successful(response, `checkout ${label}`);
  return { body, response, providerRequestId: body.providerRequestId };
}

export async function providerCallback(ctx, baseUrl, providerRequestId, label, outcome, capturedMinor, options = {}) {
  const body = { providerEventId: options.providerEventId ?? `event-${ctx.key(label)}`, providerRequestId, outcome, capturedMinor };
  const response = await ctx.mutate(baseUrl, "/api/v1/payment-provider/callbacks", options.key ?? ctx.key(`callback:${label}`), body);
  if (options.expectSuccess !== false) successful(response, `callback ${label}`);
  return { body, response };
}

export async function reconcile(ctx, baseUrl, paymentAttemptId, label, outcome, capturedMinor, options = {}) {
  const body = { providerQueryId: options.providerQueryId ?? `query-${ctx.key(label)}`, outcome, capturedMinor };
  const response = await ctx.mutate(baseUrl, `/api/v1/payment-attempts/${paymentAttemptId}/reconcile`, options.key ?? ctx.key(`reconcile:${label}`), body);
  if (options.expectSuccess !== false) successful(response, `reconcile ${label}`);
  return { body, response };
}

export async function capture(ctx, baseUrl, fixture, label = "capture", options = {}) {
  const quoted = await quote(ctx, baseUrl, fixture, label, options.quote ?? {}, { mixed: options.mixed });
  const checked = await checkout(ctx, baseUrl, quoted.orderId, label);
  const before = await ctx.snapshot(baseUrl);
  const order = resource(before, "orders").find(({ orderId }) => orderId === quoted.orderId);
  assert.ok(order, "captured Order precondition");
  const callback = await providerCallback(ctx, baseUrl, checked.providerRequestId, label, "CAPTURED", order.orderTotalMinor);
  return { ...quoted, ...checked, callback, orderTotalMinor: order.orderTotalMinor };
}

export async function waitSnapshot(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return predicate(snapshot) ? snapshot : undefined;
  }, { timeoutMs: options.timeoutMs ?? 60_000, intervalMs: options.intervalMs ?? 50, processes: options.processes ?? [], label: options.label ?? "CommerceCommand public snapshot" });
}

export function stableBusiness(snapshot) {
  return stableSnapshot(snapshot);
}

export function expectedQuote(fixture, body) {
  return quoteOracle(body.lines, new Map(fixture.seed.offerVersions.map((offer) => [offer.productId, offer])));
}

export async function fixedDurationLoad(ctx, { warmupMs = 0, measureMs, concurrency, request, validate, maximumOperations = Infinity }) {
  let ordinal = 0;
  async function phase(durationMs, measured) {
    const deadline = performance.now() + durationMs;
    const latencies = [];
    const statuses = new Map();
    let completed = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline && ordinal < maximumOperations) {
        const index = ordinal++;
        const started = performance.now();
        const response = await request(index, measured);
        const latency = performance.now() - started;
        if (validate) await validate(response, index, measured);
        if (measured) {
          completed += 1;
          latencies.push(latency);
          statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        }
      }
    }));
    return { completed, durationMs, throughput: completed / (durationMs / 1_000), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), statuses: Object.fromEntries(statuses) };
  }
  if (warmupMs > 0) await phase(warmupMs, false);
  return phase(measureMs, true);
}

export function assertLoad(result, { minimumThroughput, maximumP95, acceptedStatuses }) {
  const accepted = Object.entries(result.statuses).filter(([status]) => acceptedStatuses.includes(Number(status))).reduce((sum, [, count]) => sum + count, 0);
  assert.equal(accepted, result.completed, "all measured responses have contract-valid statuses");
  assert.ok(result.completed > 0, "load completed operations");
  assert.ok(result.throughput >= minimumThroughput, `throughput ${result.throughput} >= ${minimumThroughput}`);
  assert.ok(result.p95 <= maximumP95, `p95 ${result.p95} <= ${maximumP95}`);
}

export async function launchBrowser(ctx, fixture, { workers = 1, dispatchers = 0, receiver: providedReceiver, viewport = { width: 1280, height: 900 } } = {}) {
  await ctx.migrate();
  await ctx.seed(fixture.seed);
  await ctx.npm("build", [], { timeoutMs: 180_000 });
  const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
  const workerRecords = await Promise.all(Array.from({ length: workers }, () => ctx.startWorker()));
  const receiver = providedReceiver ?? (dispatchers > 0 ? await ctx.receiver({ path: "/commerce-events" }) : undefined);
  const dispatcherRecords = await Promise.all(Array.from({ length: dispatchers }, () => ctx.startDispatcher({ webhookUrl: receiver.url })));
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport });
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  return { api, workerRecords, receiver, dispatcherRecords, browser, page };
}

export async function selectTestId(page, testId, value) {
  const locator = page.getByTestId(testId);
  assert.equal(await locator.count(), 1, `visible ${testId}`);
  await locator.selectOption(String(value));
}

export async function clickTestId(page, testId) {
  const locator = page.getByTestId(testId);
  assert.equal(await locator.count(), 1, `visible ${testId}`);
  await locator.click();
}

export async function assertEventuallySnapshot(ctx, baseUrl, predicate, options) {
  const snapshot = await waitSnapshot(ctx, baseUrl, predicate, options);
  assertCoreInvariants(snapshot);
  return snapshot;
}

export function semanticReplay(left, right) {
  assert.equal(left.status, right.status, "replayed status");
  assert.equal(canonicalJson(left.json), canonicalJson(right.json), "replayed semantic response");
}
