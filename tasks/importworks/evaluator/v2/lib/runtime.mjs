import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";

import {
  createFixtureFactory,
  importPayload,
  importSeed,
  splitBytes,
  tenantSchemaFixture,
} from "./fixtures.mjs";
import { canonical, sha256 } from "./oracle.mjs";

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL
  ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);

const BLOCKED_ASSERTIONS = Object.freeze({
  "A-03": new Map([["error-report-download-bytes", "IW-GAP-01"]]),
  "C-01": new Map([["validate-effect-commit-window", "IW-GAP-03"]]),
  "C-02": new Map([["commit-report-effect-commit-window", "IW-GAP-03"]]),
  "C-03": new Map([["bundle-effect-commit-window", "IW-GAP-03"]]),
  "D-02": new Map([
    ["ui-error-report-download-bytes", "IW-GAP-01"],
    ["ui-bundle-refresh-history", "IW-GAP-02"],
  ]),
});

function identityResponse(_adapter, { json }) {
  return json;
}

function assertNoCompatibilityAdapter(value) {
  if (value !== undefined && value !== null) throw new Error("ImportWorks does not publish a response compatibility adapter");
}

export function isClaimedWorkerBarrier(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.point === "worker.claimed");
}

const runtime = shared.createCaseRuntime({
  taskSlug: "importworks",
  databasePrefix: "iw",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: identityResponse,
  assertCompatibilityAdapter: assertNoCompatibilityAdapter,
  validateBarrierPayload: isClaimedWorkerBarrier,
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
      throw new shared.EvaluationInfrastructureError(
        "EVALUATOR_UNDECLARED_BLOCKED_ASSERTION",
        "EVALUATOR_UNDECLARED_BLOCKED_ASSERTION",
      );
    }
    if (!this.blockedAssertions.some((item) => item.assertionId === assertionId)) {
      this.blockedAssertions.push({ assertionId, blockedBy, policy: "fail-closed-diagnostic" });
      this.assertions.push({ label: assertionId, status: "blocked", blockedBy });
    }
  }

  finish() {
    for (const [assertionId, blockedBy] of this.expectedBlocked) {
      if (!this.blockedAssertions.some((item) => item.assertionId === assertionId && item.blockedBy === blockedBy)) {
        throw new shared.EvaluationInfrastructureError(
          "EVALUATOR_MISSING_BLOCKED_DIAGNOSTIC",
          "EVALUATOR_MISSING_BLOCKED_DIAGNOSTIC",
        );
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
  const fixtureKey = context.key;
  let keySequence = 0;
  let seedSequence = 0;

  context.evidence = evidence;
  context.key = (label) => fixtureKey(`${label}-${keySequence++}`);
  context.catalog = (label = "primary", options = {}) => tenantSchemaFixture(context.fixtures, { label, ...options });
  context.seedFor = (seedVersion, options = {}) => importSeed(context.fixtures, seedVersion, options);
  context.assert = (label, operation, options) => evidence.check(label, operation, options);
  context.equal = (label, actual, expected, options) => evidence.check(label, () => assert.deepEqual(actual, expected), options);
  context.ok = (label, condition, message, options) => evidence.check(label, () => assert.ok(condition, message), options);
  context.blocked = (assertionId, blockedBy) => evidence.blocked(assertionId, blockedBy);
  context.metric = (name, value) => { evidence.metrics[name] = value; };
  context.sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
  context.canonical = canonical;
  context.sha256 = sha256;

  context.request = async (baseUrl, path, options = {}) => {
    const response = await originalRequest(baseUrl, path, options);
    if (options.record !== false) evidence.statuses.set(String(response.status), (evidence.statuses.get(String(response.status)) ?? 0) + 1);
    return response;
  };

  context.seed = async (value, options = {}) => {
    const path = context.tempPath(`importworks-seed-${String(seedSequence += 1).padStart(3, "0")}.json`);
    await writeFile(path, JSON.stringify(value));
    const result = await context.npm("db:seed", ["--file", path], {
      workspace: options.workspace,
      timeoutMs: options.timeoutMs ?? 900_000,
      allowFailure: true,
    });
    if (options.expectFailure) context.ok("invalid seed exits nonzero", result.exitCode !== 0, undefined, { failureCodeSuffix: "SEED_ACCEPTED_INVALID_INPUT" });
    else context.equal("valid seed exits zero", result.exitCode, 0, { failureCodeSuffix: "SEED_FAILED" });
    return result;
  };

  context.createImport = (baseUrl, catalog, bytes, options = {}) => context.mutate(
    baseUrl,
    "/api/v1/imports",
    options.key ?? context.key("create-import"),
    { ...importPayload(catalog, bytes, options), ...(options.extra ?? {}) },
  );
  context.putChunk = (baseUrl, importId, total, piece, options = {}) => context.request(
    baseUrl,
    `/api/v1/imports/${importId}/chunks/${options.chunkNumber ?? piece.chunkNumber}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${options.start ?? piece.start}-${options.endInclusive ?? piece.endInclusive}/${total}`,
        "x-chunk-sha256": options.digest ?? sha256(options.body ?? piece.body),
        "idempotency-key": options.key ?? context.key(`chunk-${piece.chunkNumber}`),
      },
      raw: options.body ?? piece.body,
    },
  );
  context.upload = async (baseUrl, importId, bytes, options = {}) => {
    const pieces = options.pieces ?? splitBytes(bytes, options.count ?? 4, options.order ?? [3, 0, 2, 1]);
    const responses = [];
    for (const piece of pieces) responses.push(await context.putChunk(baseUrl, importId, bytes.length, piece, {
      key: options.keyFor?.(piece) ?? context.key(`upload-${piece.chunkNumber}`),
    }));
    return { pieces, responses };
  };
  context.getImport = (baseUrl, importId) => context.request(baseUrl, `/api/v1/imports/${importId}`);
  context.completeImport = (baseUrl, importId, key = context.key("complete")) => context.mutate(baseUrl, `/api/v1/imports/${importId}/complete`, key, {});
  context.commitImport = (baseUrl, importId, key = context.key("commit")) => context.mutate(baseUrl, `/api/v1/imports/${importId}/commit`, key, {});
  context.cancelImport = (baseUrl, importId, key = context.key("cancel")) => context.mutate(baseUrl, `/api/v1/imports/${importId}/cancel`, key, {});
  context.getFindings = (baseUrl, importId, query = "limit=100") => context.request(baseUrl, `/api/v1/imports/${importId}/findings?${query}`);
  context.getErrorReport = (baseUrl, importId, options = {}) => context.request(baseUrl, `/api/v1/imports/${importId}/error-report`, options);
  context.getRecords = (baseUrl, tenantId, datasetKey, query = "limit=100") => context.request(baseUrl, `/api/v1/records?tenantId=${encodeURIComponent(tenantId)}&datasetKey=${encodeURIComponent(datasetKey)}&${query}`);
  context.createBundle = (baseUrl, tenantId, name, key = context.key("create-bundle")) => context.mutate(baseUrl, "/api/v1/import-bundles", key, { tenantId, name });
  context.addBundleMember = (baseUrl, bundleId, importId, key = context.key("add-member")) => context.mutate(baseUrl, `/api/v1/import-bundles/${bundleId}/members`, key, { importId });
  context.stageBundle = (baseUrl, bundleId, key = context.key("stage-bundle")) => context.mutate(baseUrl, `/api/v1/import-bundles/${bundleId}/stage`, key, {});
  context.publishBundle = (baseUrl, bundleId, key = context.key("publish-bundle")) => context.mutate(baseUrl, `/api/v1/import-bundles/${bundleId}/publish`, key, {});

  context.claimedBarrier = (predicate = () => true) => context.barrier({ hold: (payload) => isClaimedWorkerBarrier(payload) && predicate(payload) });
  context.startWorkerAtBarrier = (barrier, options = {}) => context.startWorker({
    ...options,
    env: {
      TEST_BARRIER_URL: barrier.url,
      TEST_BARRIER_TOKEN: barrier.token,
      ...(options.env ?? {}),
    },
  });
  context.startEventDispatcher = (webhookUrl, options = {}) => context.startDispatcher({
    ...options,
    webhookUrl,
  });
  context.readOpenApi = async (baseUrl) => {
    const response = await context.request(baseUrl, "/openapi.json");
    context.equal("OpenAPI route returns 200", response.status, 200);
    return response.json;
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
    if (context.caseId !== "E-01") await context.migrate();
    const outcome = await operation(context);
    const unexpected5xx = [...context.evidence.statuses]
      .filter(([status]) => Number(status) >= 500)
      .reduce((sum, [, count]) => sum + count, 0);
    context.equal("no unexpected HTTP 5xx", unexpected5xx, 0);
    const evidenceResult = context.evidence.finish();
    return {
      ...outcome,
      evidence: { ...evidenceResult, caseEvidence: outcome?.evidence ?? [] },
      ...(evidenceResult.blockedAssertions.length ? { blockedAssertions: evidenceResult.blockedAssertions } : {}),
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
  throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE", "EVALUATOR_CHROMIUM_UNAVAILABLE");
}

async function withPage(context, api, viewport, operation) {
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch (cause) { throw new shared.EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE", "EVALUATOR_PLAYWRIGHT_UNAVAILABLE", { cause }); }
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
