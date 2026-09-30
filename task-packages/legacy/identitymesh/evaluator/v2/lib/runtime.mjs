import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import {
  canonical,
  createFixtureFactory,
  identityCatalog,
  loginAttemptBody,
  providerCallback,
  revocationBody,
  secretSentinels,
  v1Seed,
} from "./fixtures.mjs";

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);

function identity(_adapter, { json }) { return json; }
function rejectAdapter(value) { if (value != null) throw new Error("IdentityMesh publishes no evaluator response adapter"); }

export function isIdentityMeshBarrier() {
  // IM-GAP-05: no barrier protocol or payload is public, so no payload is accepted.
  return false;
}

const runtime = shared.createCaseRuntime({
  taskSlug: "identitymesh",
  databasePrefix: "im",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: identity,
  assertCompatibilityAdapter: rejectAdapter,
  validateBarrierPayload: isIdentityMeshBarrier,
});

class ScenarioFailure extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.failureCodeSuffix = options.failureCodeSuffix ?? "ASSERTION_FAILED";
    this.hardCapIds = options.hardCapIds ?? [];
  }
}

class Evidence {
  constructor() { this.assertions = []; this.statuses = new Map(); this.metrics = {}; }
  check(label, operation, options = {}) {
    try {
      operation();
      this.assertions.push({ label, status: "passed" });
    } catch (cause) {
      this.assertions.push({ label, status: "failed" });
      throw new ScenarioFailure(`${label}: ${cause?.message ?? cause}`, { ...options, cause });
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

function deepFind(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = deepFind(child, key);
    if (found !== undefined) return found;
  }
}

async function decorate(ctx) {
  const evidence = new Evidence();
  const originalRequest = ctx.request;
  const fixtureKey = ctx.key;
  let keyOrdinal = 0;
  let seedOrdinal = 0;
  ctx.evidence = evidence;
  ctx.key = (label) => fixtureKey(`${label}-${keyOrdinal++}`);
  ctx.catalog = (label, options) => identityCatalog(ctx.fixtures, label, options);
  ctx.seedFor = (label, options) => v1Seed(ctx.fixtures, label, options);
  ctx.loginBody = loginAttemptBody;
  ctx.callbackBody = (catalog, label, outcome, options) => providerCallback(ctx.fixtures, catalog, label, outcome, options);
  ctx.revocationBody = revocationBody;
  ctx.sentinels = (label) => secretSentinels(ctx.fixtures, label);
  ctx.canonical = canonical;
  ctx.find = deepFind;
  ctx.assert = (label, operation, options) => evidence.check(label, operation, options);
  ctx.equal = (label, actual, expected, options) => evidence.check(label, () => assert.deepEqual(actual, expected), options);
  ctx.ok = (label, value, message, options) => evidence.check(label, () => assert.ok(value, message), options);
  ctx.metric = (name, value) => { evidence.metrics[name] = value; };
  ctx.sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
  ctx.request = async (baseUrl, path, options = {}) => {
    const response = await originalRequest(baseUrl, path, options);
    if (options.record !== false) {
      const key = String(response.status);
      evidence.statuses.set(key, (evidence.statuses.get(key) ?? 0) + 1);
    }
    return response;
  };
  ctx.seed = async (value, options = {}) => {
    const path = ctx.tempPath(`identitymesh-seed-${String(++seedOrdinal).padStart(3, "0")}.json`);
    await writeFile(path, JSON.stringify(value));
    const result = await ctx.seedFile(path, {
      workspace: options.workspace,
      timeoutMs: options.timeoutMs ?? 3_600_000,
      allowFailure: true,
    });
    if (options.expectFailure) {
      ctx.ok("invalid seed exits nonzero", result.exitCode !== 0, undefined, {
        failureCodeSuffix: "SEED_ACCEPTED_INVALID",
        hardCapIds: ["AUDIT_IMMUTABILITY"],
      });
    } else {
      ctx.equal("valid seed exits zero", result.exitCode, 0, {
        failureCodeSuffix: "SEED_FAILED",
      });
    }
    return result;
  };
  ctx.seedRaw = async (value, options = {}) => {
    const path = ctx.tempPath(`identitymesh-seed-raw-${String(++seedOrdinal).padStart(3, "0")}.json`);
    await writeFile(path, JSON.stringify(value));
    return ctx.seedFile(path, {
      workspace: options.workspace,
      timeoutMs: options.timeoutMs ?? 3_600_000,
      allowFailure: true,
    });
  };

  ctx.createLoginAttempt = (url, body, options = {}) => ctx.mutate(url, "/api/v1/login-attempts", options.key ?? ctx.key("login-attempt"), body, options);
  ctx.providerCallback = (url, body, options = {}) => ctx.mutate(url, "/api/v1/provider/callbacks", options.key ?? ctx.key("provider-callback"), body, options);
  ctx.reconcileLogin = (url, attemptId, body, options = {}) => ctx.mutate(url, `/api/v1/login-attempts/${attemptId}/reconcile`, options.key ?? ctx.key("login-reconcile"), body, options);
  ctx.refreshSession = (url, sessionId, refreshToken, options = {}) => ctx.mutate(url, `/api/v1/sessions/${sessionId}/refresh`, options.key ?? ctx.key("session-refresh"), { refreshToken, ...(options.localRevocationVersion === undefined ? {} : { localRevocationVersion: options.localRevocationVersion }) }, options);
  ctx.revokeSession = (url, sessionId, options = {}) => ctx.mutate(url, `/api/v1/sessions/${sessionId}/revoke`, options.key ?? ctx.key("session-revoke"), options.body ?? {}, options);
  ctx.registerDevice = (url, body, options = {}) => ctx.mutate(url, "/api/v1/devices/register", options.key ?? ctx.key("device-register"), body, options);
  ctx.createChallenge = (url, deviceId, body, options = {}) => ctx.mutate(url, `/api/v1/devices/${deviceId}/challenges`, options.key ?? ctx.key("device-challenge"), body, options);
  ctx.approveChallenge = (url, challengeId, body, options = {}) => ctx.mutate(url, `/api/v1/device-challenges/${challengeId}/approve`, options.key ?? ctx.key("challenge-approve"), body, options);
  ctx.revokeDevice = (url, deviceId, options = {}) => ctx.mutate(url, `/api/v1/devices/${deviceId}/revoke`, options.key ?? ctx.key("device-revoke"), options.body ?? {}, options);
  ctx.rotateKey = (url, body, options = {}) => ctx.mutate(url, "/api/v1/signing-keys/rotate", options.key ?? ctx.key("key-rotate"), body, options);
  ctx.jwks = (url, query = {}) => ctx.request(url, `/api/v1/signing-keys/jwks?${new URLSearchParams(query)}`);
  ctx.revokeSubject = (url, body, options = {}) => ctx.mutate(url, "/api/v1/revocations", options.key ?? ctx.key("revocation"), body, options);
  ctx.audit = (url, query = {}) => ctx.request(url, `/api/v1/audit?${new URLSearchParams(query)}`);
  ctx.verifyAudit = (url, query = {}) => ctx.request(url, `/api/v1/audit/verify?${new URLSearchParams(query)}`);
  ctx.readOpenApi = async (url) => {
    const response = await ctx.request(url, "/openapi.json");
    ctx.equal("OpenAPI status", response.status, 200);
    return response.json;
  };
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
    const unexpected5xx = [...ctx.evidence.statuses]
      .filter(([status]) => Number(status) >= 500)
      .reduce((sum, [, count]) => sum + count, 0);
    ctx.equal("no unexpected HTTP 5xx", unexpected5xx, 0);
    return {
      ...outcome,
      evidence: { ...ctx.evidence.finish(), caseEvidence: outcome?.evidence ?? [] },
    };
  });
}

export const {
  CandidateResponseError,
  CommandError,
  EvaluationInfrastructureError,
  freePort,
  runCommand,
} = shared;
