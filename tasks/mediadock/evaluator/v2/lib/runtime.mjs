import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import { createFixtureFactory, profileFixture, seedFixture, uploadFixture } from "./fixtures.mjs";

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL
  ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);

const EXPECTED_BLOCKED = Object.freeze({
  "C-02": new Map([["exact-effect-window", "MD-GAP-05"]]),
  "C-03": new Map([["exact-delete-window", "MD-GAP-05"]]),
  "D-02": new Map([["alias-public-wire", "MD-GAP-01"], ["alias-render-target", "MD-GAP-02"]]),
  "D-03": new Map([["alias-snapshot-shape", "MD-GAP-01"]]),
  "D-04": new Map([["publication-wire", "MD-GAP-01"], ["grant-lineage", "MD-GAP-02"], ["old-revision-retention", "MD-GAP-03"]]),
  "E-04": new Map([["publication-cas-wire", "MD-GAP-01"], ["publication-effect-window", "MD-GAP-05"]]),
});

function identityResponse(_adapter, { json }) { return json; }
function assertNoCompatibilityAdapter(value) { if (value !== undefined && value !== null) throw new Error("MediaDock has no public compatibility adapter"); }
function validateBarrierPayload(value) {
  return value && typeof value === "object" && value.schemaVersion === 1
    && ["worker", "dispatcher"].includes(value.processRole)
    && typeof value.workId === "string" && typeof value.aggregateId === "string";
}

const runtime = shared.createCaseRuntime({
  taskSlug: "mediadock",
  databasePrefix: "md",
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
  constructor(caseId) {
    this.assertions = [];
    this.metrics = {};
    this.statuses = {};
    this.blockedAssertions = [];
    this.expectedBlocked = EXPECTED_BLOCKED[caseId] ?? new Map();
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
      throw new shared.EvaluationInfrastructureError("EVALUATOR_UNDECLARED_BLOCKED_ASSERTION", `${assertionId} is not a frozen MediaDock gap`);
    }
    this.blockedAssertions.push({ assertionId, blockedBy, policy: "fail-closed-diagnostic" });
    this.assertions.push({ label: assertionId, status: "blocked", blockedBy });
  }

  finish() {
    for (const [assertionId, blockedBy] of this.expectedBlocked) {
      if (!this.blockedAssertions.some((entry) => entry.assertionId === assertionId && entry.blockedBy === blockedBy)) {
        throw new shared.EvaluationInfrastructureError("EVALUATOR_MISSING_BLOCKED_DIAGNOSTIC", `missing ${assertionId}`);
      }
    }
    return { assertions: this.assertions, metrics: this.metrics, statuses: this.statuses, blockedAssertions: this.blockedAssertions };
  }
}

async function decorate(context) {
  const evidence = new Evidence(context.caseId);
  const request = context.request;
  let ordinal = 0;
  context.evidence = evidence;
  context.uniqueKey = (label) => context.key(`${label}-${ordinal++}`);
  context.uploadFixture = (label, options) => uploadFixture(context.fixtures, label, options);
  context.profileFixture = (label, operation, prefix, revision) => profileFixture(context.fixtures, label, operation, prefix, revision);
  context.seedFixture = (label, overrides) => seedFixture(context.fixtures, label, overrides);
  context.assert = (label, operation, options) => evidence.check(label, operation, options);
  context.equal = (label, actual, expected, options) => evidence.check(label, () => assert.deepEqual(actual, expected), options);
  context.ok = (label, condition, message, options) => evidence.check(label, () => assert.ok(condition, message), options);
  context.blocked = (id, gap) => evidence.blocked(id, gap);
  context.metric = (name, value) => { evidence.metrics[name] = value; };
  context.request = async (...args) => {
    const response = await request(...args);
    evidence.statuses[response.status] = (evidence.statuses[response.status] ?? 0) + 1;
    return response;
  };
  context.createTenant = (baseUrl, label) => context.mutate(baseUrl, "/api/v1/tenants", context.uniqueKey(`tenant-${label}`), { name: `Tenant ${label}` });
  context.createProfile = (baseUrl, body, key = context.uniqueKey("profile")) => context.mutate(baseUrl, "/api/v1/transcode-profiles", key, body);
  context.createUpload = (baseUrl, body, key = context.uniqueKey("upload")) => context.mutate(baseUrl, "/api/v1/uploads", key, body);
  context.getUpload = (baseUrl, uploadId) => context.request(baseUrl, `/api/v1/uploads/${uploadId}`);
  context.putPart = (baseUrl, uploadId, part, total, key = context.uniqueKey(`part-${part.partNumber}`)) => context.request(baseUrl, `/api/v1/uploads/${uploadId}/parts/${part.partNumber}`, {
    method: "PUT",
    raw: part.bytes,
    headers: { "content-type": "application/octet-stream", "content-range": `bytes ${part.start}-${part.end}/${total}`, "x-part-sha256": part.sha256, "idempotency-key": key },
  });
  context.completeUpload = (baseUrl, uploadId, manifest, key = context.uniqueKey("complete")) => context.mutate(baseUrl, `/api/v1/uploads/${uploadId}/complete`, key, { parts: manifest.map(({ partNumber, sha256, size }) => ({ partNumber, sha256, size })) });
  context.getAsset = (baseUrl, assetId) => context.request(baseUrl, `/api/v1/assets/${assetId}`);
  context.getRenditions = (baseUrl, assetId) => context.request(baseUrl, `/api/v1/assets/${assetId}/renditions`);
  context.waitSnapshot = (baseUrl, predicate, options = {}) => context.waitFor(async () => {
    const snapshot = await context.snapshot(baseUrl);
    return predicate(snapshot) ? snapshot : undefined;
  }, options);
  return context;
}

export async function createCaseContext(options) { return decorate(await runtime.createCaseContext(options)); }

export async function withCaseContext(options, operation) {
  return runtime.withCaseContext(options, async (raw) => {
    const context = await decorate(raw);
    if (!(context.caseId === "E-01" && context.v1Workspace)) await context.migrate();
    const outcome = await operation(context);
    const unexpected5xx = Object.entries(context.evidence.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0);
    context.equal("no unexpected HTTP 5xx", unexpected5xx, 0);
    const evidence = context.evidence.finish();
    return {
      ...outcome,
      evidence: { ...evidence, caseEvidence: outcome?.evidence ?? [] },
      ...(evidence.blockedAssertions.length ? { status: "excluded", reason: "blocked_public_contract" } : {}),
    };
  });
}

export async function chromiumExecutable() {
  for (const path of [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) {
    try { await access(path); return path; } catch {}
  }
  throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE", "Chromium is unavailable");
}
