import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import { auctionFixture, bidderFixture, createFixtureFactory, lotFixture } from "./fixtures.mjs";

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL
  ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);

const EXPECTED_BLOCKED = Object.freeze({
  "BID-03": new Map([["exact-anti-sniping-equality", "SPEC-GAP-AG-03"]]),
  "BID-04": new Map([["exact-effective-end-equality", "SPEC-GAP-AG-03"]]),
  "CLEAR-02": new Map([["equal-price-public-fixture", "SPEC-GAP-AG-04"]]),
  "MIGRATE-01": new Map([["frozen-v1-winner-checkpoint", "SPEC-GAP-AG-05"]]),
  "MIGRATE-02": new Map([["frozen-v1-work-checkpoint", "SPEC-GAP-AG-05"]]),
});

function identityResponse(_adapter, { json }) {
  return json;
}

function assertNoCompatibilityAdapter(value) {
  if (value !== undefined && value !== null) throw new Error("AuctionGuard does not publish a compatibility response adapter");
}

function validateBarrierPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (JSON.stringify(value).includes("leaseToken\"")) return false;
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"])) return false;
  return value.schemaVersion === 1
    && ["worker", "dispatcher"].includes(value.processRole)
    && ["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"].includes(value.point)
    && typeof value.workId === "string"
    && typeof value.aggregateId === "string"
    && Number.isSafeInteger(value.attempt)
    && value.attempt >= 1
    && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash);
}

const runtime = shared.createCaseRuntime({
  taskSlug: "auctionguard",
  databasePrefix: "ag",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: identityResponse,
  assertCompatibilityAdapter: assertNoCompatibilityAdapter,
  validateBarrierPayload,
});

class ScenarioFailure extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScenarioFailure";
    this.failureCodeSuffix = options.failureCodeSuffix ?? "ASSERTION_FAILED";
    this.hardCapIds = options.hardCapIds ?? [];
  }
}

class Evidence {
  constructor(caseId, hasV1Workspace) {
    this.assertions = [];
    this.statuses = new Map();
    this.metrics = {};
    this.blockedAssertions = [];
    this.expectedBlocked = hasV1Workspace && caseId.startsWith("MIGRATE-")
      ? new Map()
      : EXPECTED_BLOCKED[caseId] ?? new Map();
  }

  check(label, operation, options = {}) {
    try {
      operation();
      this.assertions.push({ label, status: "passed" });
    } catch (cause) {
      this.assertions.push({ label, status: "failed" });
      throw new ScenarioFailure(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause,
        failureCodeSuffix: options.failureCodeSuffix,
        hardCapIds: options.hardCapIds,
      });
    }
  }

  blocked(assertionId, blockedBy) {
    if (this.expectedBlocked.get(assertionId) !== blockedBy) {
      throw new shared.EvaluationInfrastructureError("EVALUATOR_UNDECLARED_BLOCKED_ASSERTION", `undeclared blocked assertion ${assertionId}`);
    }
    if (!this.blockedAssertions.some((entry) => entry.assertionId === assertionId)) {
      this.blockedAssertions.push({ assertionId, blockedBy, policy: "fail-closed-diagnostic" });
      this.assertions.push({ label: assertionId, status: "blocked", blockedBy });
    }
  }

  finish() {
    for (const [assertionId, blockedBy] of this.expectedBlocked) {
      if (!this.blockedAssertions.some((entry) => entry.assertionId === assertionId && entry.blockedBy === blockedBy)) {
        throw new shared.EvaluationInfrastructureError("EVALUATOR_MISSING_BLOCKED_DIAGNOSTIC", `missing ${assertionId}`);
      }
    }
    return {
      assertions: this.assertions,
      statuses: Object.fromEntries([...this.statuses.entries()].sort()),
      metrics: this.metrics,
      blockedAssertions: this.blockedAssertions,
    };
  }
}

async function decorateContext(context) {
  const evidence = new Evidence(context.caseId, Boolean(context.v1Workspace));
  const originalRequest = context.request;
  const fixtureKey = context.key;
  let keySequence = 0;

  context.evidence = evidence;
  context.key = (label) => fixtureKey(`${label}-${keySequence++}`);
  context.bidder = (label) => bidderFixture(context.fixtures, label);
  context.lot = (label) => lotFixture(context.fixtures, label);
  context.auction = (label, lotId, overrides) => auctionFixture(context.fixtures, label, lotId, overrides);
  context.assert = (label, operation, options) => evidence.check(label, operation, options);
  context.equal = (label, actual, expected, options) => evidence.check(label, () => assert.deepEqual(actual, expected), options);
  context.ok = (label, condition, message, options) => evidence.check(label, () => assert.ok(condition, message), options);
  context.blocked = (assertionId, blockedBy) => evidence.blocked(assertionId, blockedBy);
  context.metric = (name, value) => { evidence.metrics[name] = value; };
  context.sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  context.request = async (baseUrl, path, options = {}) => {
    const response = await originalRequest(baseUrl, path, options);
    if (options.record !== false) evidence.statuses.set(String(response.status), (evidence.statuses.get(String(response.status)) ?? 0) + 1);
    return response;
  };

  context.createAuction = (baseUrl, payload, key = context.key("create-auction")) => context.mutate(
    baseUrl, "/api/v1/admin/auctions", key, payload, { admin: true },
  );
  context.openAuction = (baseUrl, auctionId, key = context.key("open-auction")) => context.mutate(
    baseUrl, `/api/v1/admin/auctions/${auctionId}/open`, key, {}, { admin: true },
  );
  context.placeBid = (baseUrl, auctionId, payload, key = context.key("place-bid")) => context.mutate(
    baseUrl, `/api/v1/auctions/${auctionId}/bids`, key, payload,
  );
  context.cancelAuction = (baseUrl, auctionId, reason, key = context.key("cancel-auction")) => context.mutate(
    baseUrl, `/api/v1/auctions/${auctionId}/cancel`, key, { reason },
  );
  context.getAuction = (baseUrl, auctionId) => context.request(baseUrl, `/api/v1/auctions/${auctionId}`);
  context.getBids = (baseUrl, auctionId, query = "limit=100") => context.request(baseUrl, `/api/v1/auctions/${auctionId}/bids?${query}`);
  context.getEvents = (baseUrl, auctionId, afterSequence = 0, limit = 100) => context.request(baseUrl, `/api/v1/domain-events?aggregateId=${auctionId}&afterSequence=${afterSequence}&limit=${limit}`);
  context.getTime = (baseUrl) => context.request(baseUrl, "/api/v1/time");
  context.getOpenApi = (baseUrl) => context.request(baseUrl, "/openapi.json");
  context.startResponseShield = async (upstreamBaseUrl) => {
    const owned = await context.responseShield(upstreamBaseUrl);
    return {
      baseUrl: owned.baseUrl,
      dropNextMutation: owned.dropNextMutation,
      get captures() {
        return owned.captures.map((capture) => {
          let json;
          try { json = JSON.parse(capture.response.body); } catch {}
          return { ...capture, json };
        });
      },
    };
  };
  context.withPage = (api, viewport, operation) => withPage(context, api, viewport, operation);
  return context;
}

export async function createCaseContext(options) {
  return decorateContext(await runtime.createCaseContext(options));
}

export async function withCaseContext(options, operation) {
  return runtime.withCaseContext(options, async (rawContext) => {
    const context = await decorateContext(rawContext);
    if (!(context.v1Workspace && ["MIGRATE-01", "MIGRATE-02"].includes(context.caseId))) {
      await context.migrate();
    }
    const outcome = await operation(context);
    const unexpected5xx = [...evidenceEntries(context)]
      .filter(([status]) => Number(status) >= 500)
      .reduce((sum, [, count]) => sum + count, 0);
    context.equal("no unexpected HTTP 5xx", unexpected5xx, 0);
    const evidence = context.evidence.finish();
    return {
      ...outcome,
      evidence: { ...evidence, caseEvidence: outcome?.evidence ?? [] },
      ...(evidence.blockedAssertions.length ? { status: "excluded", reason: "blocked_public_contract" } : {}),
    };
  });
}

function evidenceEntries(context) {
  return context.evidence.statuses.entries();
}

async function chromiumExecutable() {
  for (const candidate of [
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE", "Chromium is unavailable");
}

async function withPage(context, api, viewport, operation) {
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch (cause) { throw new shared.EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE", "playwright-core is unavailable", { cause }); }
  const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const browserContext = await browser.newContext({ viewport, baseURL: api.baseUrl });
  const page = await browserContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource.*4\d\d/iu.test(message.text())) errors.push(message.text()); });
  try {
    await operation(page);
    context.equal("production browser has no page or console errors", errors, []);
    context.equal("production browser has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  } finally {
    await browserContext.close();
    await browser.close();
  }
}
