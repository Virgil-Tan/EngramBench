import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createFixtureFactory, customerFixture, eventFixture } from "./fixtures.mjs";

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL
  ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);

const BLOCKED_REASON = "blocked_public_contract";
const BLOCKED_ASSERTIONS = Object.freeze({
  "A-05": new Map([
    ["waitlist-get-success-status", "LP-GAP-01"],
    ["waitlist-delete-success-status", "LP-GAP-01"],
  ]),
  "D-04": new Map([
    ["openapi-waitlist-get-success-status", "LP-GAP-01"],
    ["openapi-waitlist-delete-success-status", "LP-GAP-01"],
  ]),
});

function identityResponse(_adapter, { json }) {
  return json;
}

function assertNoCompatibilityAdapter(value) {
  if (value !== undefined && value !== null) throw new Error("LaunchPass does not publish a compatibility response adapter");
}

const runtime = shared.createCaseRuntime({
  taskSlug: "launchpass",
  databasePrefix: "lp",
  snapshotPath: "/api/health",
  createFixtureFactory,
  adaptCompatibilityResponse: identityResponse,
  assertCompatibilityAdapter: assertNoCompatibilityAdapter,
  validateBarrierPayload: () => false,
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
  constructor(caseId) {
    this.assertions = [];
    this.statuses = new Map();
    this.metrics = {};
    this.blockedAssertions = [];
    this.expectedBlocked = BLOCKED_ASSERTIONS[caseId] ?? new Map();
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
      throw new shared.EvaluationInfrastructureError("EVALUATOR_UNDECLARED_BLOCKED_ASSERTION");
    }
    if (!this.blockedAssertions.some((item) => item.assertionId === assertionId)) {
      this.blockedAssertions.push({ assertionId, blockedBy, policy: "fail-closed-diagnostic" });
      this.assertions.push({ label: assertionId, status: "blocked", blockedBy });
    }
  }

  finish() {
    for (const [assertionId, blockedBy] of this.expectedBlocked) {
      if (!this.blockedAssertions.some((item) => item.assertionId === assertionId && item.blockedBy === blockedBy)) {
        throw new shared.EvaluationInfrastructureError("EVALUATOR_MISSING_BLOCKED_DIAGNOSTIC");
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
  const evidence = new Evidence(context.caseId);
  const originalRequest = context.request;
  const originalStartProcess = context.startProcess;
  const fixtureKey = context.key;
  let keySequence = 0;
  let seedSequence = 0;

  context.evidence = evidence;
  context.key = (label) => fixtureKey(`${label}-${keySequence++}`);
  context.event = (label, overrides) => eventFixture(context.fixtures, label, overrides);
  context.customer = (label) => customerFixture(context.fixtures, label);
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

  context.seed = async (value, options = {}) => {
    const path = context.tempPath(`launchpass-seed-${String(seedSequence += 1).padStart(3, "0")}.json`);
    await writeFile(path, JSON.stringify(value));
    const result = await context.npm("seed", ["--file", path], {
      timeoutMs: options.timeoutMs ?? 900_000,
      allowFailure: true,
    });
    if (options.expectFailure) context.ok("invalid seed exits nonzero", result.exitCode !== 0, undefined, { failureCodeSuffix: "SEED_ACCEPTED_INVALID_INPUT" });
    else context.equal("valid seed exits zero", result.exitCode, 0, { failureCodeSuffix: "SEED_FAILED" });
    return result;
  };

  context.startApi = async (options = {}) => {
    const port = options.port ?? await context.freePort();
    const record = await originalStartProcess("api", "start", {
      env: {
        PORT: port,
        HOLD_TTL_SECONDS: options.ttl ?? 120,
        WAITLIST_HOLD_TTL_SECONDS: options.waitlistTtl ?? 60,
        ...(options.env ?? {}),
      },
    });
    record.port = port;
    record.baseUrl = `http://127.0.0.1:${port}`;
    try {
      await context.waitFor(async () => {
        const response = await context.request(record.baseUrl, "/api/health", { timeoutMs: 1_000, record: false }).catch(() => undefined);
        return response?.status === 200 && response?.json?.status === "ok";
      }, { timeoutMs: options.healthTimeoutMs ?? 45_000, intervalMs: 50, label: "LaunchPass API health", processes: [record] });
    } catch (cause) {
      throw new shared.CandidateResponseError(`LaunchPass API did not become healthy; logs: ${record.logs}`, record, { cause });
    }
    return record;
  };

  context.createEvent = (baseUrl, event, key = context.key("create-event"), options = {}) => context.request(baseUrl, "/api/admin/events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${context.adminToken}`,
      "idempotency-key": key,
      ...(options.headers ?? {}),
    },
    json: { slug: event.slug, title: event.title, startsAt: event.startsAt, capacity: event.capacity, ...(options.extra ?? {}) },
  });
  context.createHold = (baseUrl, payload, key = context.key("create-hold"), options = {}) => context.request(baseUrl, "/api/holds", {
    method: "POST", headers: { "idempotency-key": key, ...(options.headers ?? {}) }, json: payload,
  });
  context.confirm = (baseUrl, holdId, key = context.key("confirm")) => context.request(baseUrl, `/api/holds/${holdId}/confirm`, {
    method: "POST", headers: { "idempotency-key": key },
  });
  context.release = (baseUrl, holdId, key = context.key("release")) => context.request(baseUrl, `/api/holds/${holdId}`, {
    method: "DELETE", headers: { "idempotency-key": key },
  });
  context.joinWaitlist = (baseUrl, eventId, customerId, quantity, key = context.key("join-waitlist")) => context.request(baseUrl, `/api/events/${eventId}/waitlist`, {
    method: "POST", headers: { "idempotency-key": key }, json: { customerId, quantity },
  });
  context.getWaitlist = (baseUrl, eventId, customerId) => context.request(baseUrl, `/api/events/${eventId}/waitlist/${customerId}`);
  context.withdrawWaitlist = (baseUrl, eventId, customerId, key = context.key("withdraw-waitlist")) => context.request(baseUrl, `/api/events/${eventId}/waitlist/${customerId}`, {
    method: "DELETE", headers: { "idempotency-key": key },
  });
  context.startResponseShield = async (upstreamBaseUrl) => {
    const owned = await context.responseShield(upstreamBaseUrl);
    const captures = owned.captures;
    return {
      baseUrl: owned.baseUrl,
      dropNextMutation: owned.dropNextMutation,
      get captures() {
        return captures.map((capture) => {
          let json;
          try { json = JSON.parse(capture.response.body); } catch {}
          return { status: capture.response.status, headers: capture.response.headers, body: capture.response.body, json };
        });
      },
    };
  };
  context.readOpenApi = () => readFile(join(context.workspace, "openapi.yaml"), "utf8");
  context.withPage = (api, viewport, operation) => withPage(context, api, viewport, operation);
  return context;
}

export async function createCaseContext(options) {
  return decorateContext(await runtime.createCaseContext(options));
}

export async function withCaseContext(options, operation) {
  return runtime.withCaseContext(options, async (rawContext) => {
    const context = await decorateContext(rawContext);
    await context.migrate();
    const outcome = await operation(context);
    const unexpected5xx = [...context.evidence.statuses]
      .filter(([status]) => Number(status) >= 500)
      .reduce((sum, [, count]) => sum + count, 0);
    context.equal("no unexpected HTTP 5xx", unexpected5xx, 0);
    const evidence = context.evidence.finish();
    return {
      ...outcome,
      evidence: { ...evidence, caseEvidence: outcome?.evidence ?? [] },
      ...(evidence.blockedAssertions.length ? { status: "excluded", reason: BLOCKED_REASON } : {}),
    };
  });
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
  throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE");
}

async function withPage(context, api, viewport, operation) {
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch (cause) { throw new shared.EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE", { cause }); }
  const browser = await chromium.launch({
    executablePath: await chromiumExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const browserContext = await browser.newContext({ viewport, baseURL: api.baseUrl });
  const page = await browserContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource.*4\d\d/iu.test(message.text())) errors.push(message.text());
  });
  try {
    await operation(page);
    context.equal("production browser has no page or console errors", errors, []);
    context.equal("production browser layout has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  } finally {
    await browserContext.close();
    await browser.close();
  }
}

export const {
  CandidateResponseError,
  CommandError,
  EvaluationInfrastructureError,
  freePort,
  runCommand,
} = shared;
