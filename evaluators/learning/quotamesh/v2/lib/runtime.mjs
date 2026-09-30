import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import {
  createFixtureFactory,
  quotaCatalog,
  reserveBody,
  v1Seed,
} from "./fixtures.mjs";
import { canonical, sha256 } from "./oracle.mjs";
const sharedUrl =
  process.env.FRONTAL_V2_SHARED_RUNTIME_URL ??
  new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url)
    .href;
const shared = await import(sharedUrl);
const BARRIER_KEYS = [
  "schemaVersion",
  "processRole",
  "point",
  "workId",
  "aggregateId",
  "attempt",
  "leaseTokenHash",
];
function identity(_adapter, { json }) {
  return json;
}
function noAdapter(value) {
  if (value != null)
    throw new Error("QuotaMesh publishes no compatibility response adapter");
}
export function isQuotaBarrier(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...BARRIER_KEYS].sort())
  )
    return false;
  const point =
    value.processRole === "worker"
      ? [
          "worker.claimed",
          "worker.effect-complete",
          "worker.before-commit",
        ].includes(value.point)
      : value.processRole === "dispatcher" &&
        value.point === "dispatcher.response-received";
  return (
    value.schemaVersion === 1 &&
    point &&
    typeof value.workId === "string" &&
    typeof value.aggregateId === "string" &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt >= 1 &&
    /^[0-9a-f]{64}$/u.test(value.leaseTokenHash)
  );
}
const runtime = shared.createCaseRuntime({
  taskSlug: "quotamesh",
  databasePrefix: "qm",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: identity,
  assertCompatibilityAdapter: noAdapter,
  validateBarrierPayload: isQuotaBarrier,
});
class ScenarioFailure extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.origin = "candidate"; this.failureCodeSuffix = options.failureCodeSuffix ?? "ASSERTION_FAILED";
    this.hardCapIds = options.hardCapIds ?? [];
  }
}
class Evidence {
  constructor() {
    this.assertions = [];
    this.statuses = new Map();
    this.metrics = {};
  }
  check(label, operation, options = {}) {
    try {
      operation();
      this.assertions.push({ label, status: "passed" });
    } catch (cause) {
      shared.assertCandidateError(cause);
      this.assertions.push({ label, status: "failed" });
      throw new ScenarioFailure(`${label}: ${cause?.message ?? cause}`, {
        ...options,
        cause,
      });
    }
  }
  finish() {
    return {
      assertions: this.assertions,
      statuses: Object.fromEntries([...this.statuses.entries()].sort()),
      metrics: this.metrics,
    };
  }
}
async function decorate(ctx) {
  const evidence = new Evidence();
  const originalRequest = ctx.request;
  const fixtureKey = ctx.key;
  let keys = 0,
    seeds = 0;
  ctx.evidence = evidence;
  ctx.key = (label) => fixtureKey(`${label}-${keys++}`);
  ctx.catalog = (options = {}) => quotaCatalog(ctx.fixtures, options);
  ctx.seedFor = (version, options = {}) =>
    v1Seed(ctx.fixtures, version, options);
  ctx.reserveBody = (catalog, quantities, overrides) =>
    reserveBody(catalog, quantities, overrides);
  ctx.assert = (label, operation, options) =>
    evidence.check(label, operation, options);
  ctx.equal = (label, actual, expected, options) =>
    evidence.check(label, () => assert.deepEqual(actual, expected), options);
  ctx.ok = (label, condition, message, options) =>
    evidence.check(label, () => assert.ok(condition, message), options);
  ctx.metric = (name, value) => {
    evidence.metrics[name] = value;
  };
  ctx.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  ctx.canonical = canonical;
  ctx.sha256 = sha256;
  ctx.request = async (baseUrl, path, options = {}) => {
    const response = await originalRequest(baseUrl, path, options);
    if (options.record !== false)
      evidence.statuses.set(
        String(response.status),
        (evidence.statuses.get(String(response.status)) ?? 0) + 1,
      );
    return response;
  };
  ctx.seed = async (value, options = {}) => {
    const path = ctx.tempPath(
      `quotamesh-seed-${String(++seeds).padStart(3, "0")}.json`,
    );
    await writeFile(path, JSON.stringify(value));
    const result = await ctx.npm("db:seed", ["--file", path], {
      workspace: options.workspace,
      timeoutMs: options.timeoutMs ?? 1_800_000,
      allowFailure: true,
    });
    if (options.expectFailure)
      ctx.ok("invalid seed exits nonzero", result.exitCode !== 0, undefined, {
        failureCodeSuffix: "SEED_ACCEPTED_INVALID",
      });
    else
      ctx.equal("valid seed exits zero", result.exitCode, 0, {
        failureCodeSuffix: "SEED_FAILED",
      });
    return result;
  };
  ctx.createPool = (url, body, options = {}) =>
    ctx.mutate(
      url,
      "/api/v1/quota-pools",
      options.key ?? ctx.key("create-pool"),
      body,
    );
  ctx.getPool = (url, poolId) =>
    ctx.request(url, `/api/v1/quota-pools/${poolId}`);
  ctx.reservePool = (url, poolId, body, options = {}) =>
    ctx.mutate(
      url,
      `/api/v1/quota-pools/${poolId}/reservations`,
      options.key ?? ctx.key("reserve-pool"),
      body,
      { timeoutMs: options.timeoutMs },
    );
  ctx.getReservation = (url, id) =>
    ctx.request(url, `/api/v1/reservations/${id}`);
  ctx.listReservations = (url, query = "limit=100") =>
    ctx.request(url, `/api/v1/reservations?${query}`);
  ctx.commitReservation = (url, id, options = {}) =>
    ctx.mutate(
      url,
      `/api/v1/reservations/${id}/commit`,
      options.key ?? ctx.key("commit"),
      {},
    );
  ctx.releaseReservation = (url, id, options = {}) =>
    ctx.mutate(
      url,
      `/api/v1/reservations/${id}/release`,
      options.key ?? ctx.key("release"),
      { reason: options.reason ?? "evaluator" },
    );
  ctx.enqueue = (url, body, options = {}) =>
    ctx.mutate(
      url,
      "/api/v1/admission-queue",
      options.key ?? ctx.key("admission"),
      body,
    );
  ctx.getQueue = (url, poolId) =>
    ctx.request(url, `/api/v1/quota-pools/${poolId}/admission-queue`);
  ctx.createOrganization = (url, body, options = {}) =>
    ctx.mutate(
      url,
      "/api/v1/quota-organizations",
      options.key ?? ctx.key("create-org"),
      body,
    );
  ctx.createProject = (url, orgId, body, options = {}) =>
    ctx.mutate(
      url,
      `/api/v1/quota-organizations/${orgId}/projects`,
      options.key ?? ctx.key("create-project"),
      body,
    );
  ctx.getOrganization = (url, id) =>
    ctx.request(url, `/api/v1/quota-organizations/${id}`);
  ctx.getProject = (url, orgId, projectId) =>
    ctx.request(
      url,
      `/api/v1/quota-organizations/${orgId}/projects/${projectId}`,
    );
  ctx.reserveProject = (url, orgId, projectId, body, options = {}) =>
    ctx.mutate(
      url,
      `/api/v1/quota-organizations/${orgId}/projects/${projectId}/reservations`,
      options.key ?? ctx.key("reserve-project"),
      body,
    );
  ctx.updateOrganization = (url, id, body, options = {}) =>
    ctx.mutate(
      url,
      `/api/v1/quota-organizations/${id}/capacity`,
      options.key ?? ctx.key("org-capacity"),
      body,
      { method: "PUT" },
    );
  ctx.updateProject = (url, orgId, projectId, body, options = {}) =>
    ctx.mutate(
      url,
      `/api/v1/quota-organizations/${orgId}/projects/${projectId}/allocation`,
      options.key ?? ctx.key("project-allocation"),
      body,
      { method: "PUT" },
    );
  ctx.workerBarrier = (points, predicate = () => true) => {
    const accepted = new Set(Array.isArray(points) ? points : [points]);
    return ctx.barrier({
      hold: (payload) =>
        payload.processRole === "worker" &&
        accepted.has(payload.point) &&
        predicate(payload),
    });
  };
  ctx.dispatcherBarrier = (predicate = () => true) =>
    ctx.barrier({
      hold: (payload) =>
        payload.processRole === "dispatcher" &&
        payload.point === "dispatcher.response-received" &&
        predicate(payload),
    });
  ctx.startWorkerAtBarrier = (barrier, options = {}) =>
    ctx.startWorker({
      ...options,
      env: {
        TEST_BARRIER_URL: barrier.url,
        TEST_BARRIER_TOKEN: barrier.token,
        ...options.env,
      },
    });
  ctx.startDispatcherAtBarrier = (receiver, barrier, options = {}) =>
    ctx.startDispatcher({
      ...options,
      webhookUrl: receiver.url,
      env: {
        TEST_BARRIER_URL: barrier.url,
        TEST_BARRIER_TOKEN: barrier.token,
        ...options.env,
      },
    });
  ctx.readOpenApi = async (url) => {
    const response = await ctx.request(url, "/openapi.json");
    ctx.equal("OpenAPI returns 200", response.status, 200);
    return response.json;
  };
  ctx.withPage = (api, viewport, operation) =>
    withPage(ctx, api, viewport, operation);
  return ctx;
}
export async function createCaseContext(options) {
  return decorate(await runtime.createCaseContext(options));
}
export async function withCaseContext(options, operation) {
  return runtime.withCaseContext(options, async (raw) => {
    const ctx = await decorate(raw);
    if (ctx.caseId !== "E-01") await ctx.migrate();
    const outcome = await operation(ctx);
    const unexpected = [...ctx.evidence.statuses]
      .filter(([status]) => Number(status) >= 500)
      .reduce((sum, [, count]) => sum + count, 0);
    ctx.equal("no unexpected HTTP 5xx", unexpected, 0);
    return {
      ...outcome,
      evidence: {
        ...ctx.evidence.finish(),
        caseEvidence: outcome?.evidence ?? [],
      },
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
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new shared.EvaluationInfrastructureError(
    "EVALUATOR_CHROMIUM_UNAVAILABLE",
    "EVALUATOR_CHROMIUM_UNAVAILABLE",
  );
}
async function withPage(ctx, api, viewport, operation) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch (cause) {
    throw new shared.EvaluationInfrastructureError(
      "EVALUATOR_PLAYWRIGHT_UNAVAILABLE",
      "EVALUATOR_PLAYWRIGHT_UNAVAILABLE",
      { cause },
    );
  }
  const browser = await chromium.launch({
    executablePath: await chromiumExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const browserContext = await browser.newContext({
    viewport,
    baseURL: api.baseUrl,
  });
  const page = await browserContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/Failed to load resource.*4\d\d/iu.test(message.text())
    )
      errors.push(message.text());
  });
  try {
    await operation(page);
    ctx.equal("browser console clean", errors, []);
    ctx.equal(
      "browser no horizontal overflow",
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      true,
    );
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
