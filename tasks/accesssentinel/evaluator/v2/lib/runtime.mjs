import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
const FIELDS = ["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"];
export function validateBarrierPayload(value) {
  const validPoint = value?.processRole === "worker"
    ? ["worker.claimed", "worker.before-effect"].includes(value.point)
    : value?.processRole === "dispatcher" && value.point === "dispatcher.response-received";
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(FIELDS)
    && value.schemaVersion === 1 && validPoint
    && typeof value.workId === "string" && value.workId.length > 0
    && typeof value.aggregateId === "string" && value.aggregateId.length > 0
    && Number.isSafeInteger(value.attempt) && value.attempt > 0
    && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash));
}

const base = shared.createCaseRuntime({
  taskSlug: "accesssentinel",
  databasePrefix: "as",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => { if (adapter !== undefined && adapter !== null) throw new TypeError("AccessSentinel forbids compatibility adapters"); },
  validateBarrierPayload,
});

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
  context.assert = (label, operation, options = {}) => { try { return operation(); } catch (cause) { throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); } };
  context.equal = (actual, expected, label, options = {}) => context.assert(label, () => assert.deepStrictEqual(actual, expected), options);
  context.ok = (condition, label, options = {}) => context.assert(label, () => assert.ok(condition), options);
  context.sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  context.openApi = (baseUrl) => context.request(baseUrl, "/openapi.json");
  context.tenants = (baseUrl) => context.request(baseUrl, "/api/v1/tenants");
  context.principals = (baseUrl, tenantId) => context.request(baseUrl, `/api/v1/principals?${new URLSearchParams({ tenantId })}`);
  context.devices = (baseUrl, tenantId, principalId) => context.request(baseUrl, `/api/v1/devices?${new URLSearchParams({ tenantId, ...(principalId ? { principalId } : {}) })}`);
  context.accessRequest = (baseUrl, id) => context.request(baseUrl, `/api/v1/access-requests/${encodeURIComponent(id)}`);
  const mutate = (path, label, body, options = {}) => context.mutate(options.baseUrl, path, options.key ?? context.key(label), body, options);
  context.createSession = (baseUrl, body, options = {}) => mutate("/api/v1/sessions", "session", body, { ...options, baseUrl });
  context.refreshSession = (baseUrl, id, body, options = {}) => mutate(`/api/v1/sessions/${encodeURIComponent(id)}/refresh`, `refresh:${id}`, body, { ...options, baseUrl });
  context.revokeSession = (baseUrl, id, body, options = {}) => mutate(`/api/v1/sessions/${encodeURIComponent(id)}/revoke`, `session-revoke:${id}`, body, { ...options, baseUrl });
  context.publishTrust = (baseUrl, id, body, options = {}) => mutate(`/api/v1/devices/${encodeURIComponent(id)}/trust-revisions`, `trust:${id}`, body, { ...options, baseUrl });
  context.revokeDevice = (baseUrl, id, body, options = {}) => mutate(`/api/v1/devices/${encodeURIComponent(id)}/revoke`, `device-revoke:${id}`, body, { ...options, baseUrl });
  context.revokePrincipal = (baseUrl, id, body, options = {}) => mutate(`/api/v1/principals/${encodeURIComponent(id)}/revoke`, `principal-revoke:${id}`, body, { ...options, baseUrl });
  context.revokeTenant = (baseUrl, id, body, options = {}) => mutate(`/api/v1/tenants/${encodeURIComponent(id)}/revoke`, `tenant-revoke:${id}`, body, { ...options, baseUrl });
  context.createPolicy = (baseUrl, body, options = {}) => mutate("/api/v1/policy-bundles", "policy", body, { ...options, baseUrl });
  context.publishPolicy = (baseUrl, id, body, options = {}) => mutate(`/api/v1/policy-bundles/${encodeURIComponent(id)}/publish`, `policy-publish:${id}`, body, { ...options, baseUrl });
  context.rollbackPolicy = (baseUrl, id, body, options = {}) => mutate(`/api/v1/policy-bundles/${encodeURIComponent(id)}/rollback`, `policy-rollback:${id}`, body, { ...options, baseUrl });
  context.observeLocation = (baseUrl, body, options = {}) => mutate("/api/v1/location-observations", `location:${body.deviceId}:${body.deviceSequence}`, body, { ...options, baseUrl });
  context.createAccessRequest = (baseUrl, body, options = {}) => mutate("/api/v1/access-requests", "access-request", body, { ...options, baseUrl });
  context.createAccessBatch = (baseUrl, body, options = {}) => mutate("/api/v1/access-requests:batch", "access-batch", body, { ...options, baseUrl });
  context.reviewAccess = (baseUrl, id, body, options = {}) => mutate(`/api/v1/access-requests/${encodeURIComponent(id)}/reviews`, `review:${id}`, body, { ...options, baseUrl });
  context.grantAccess = (baseUrl, id, body, options = {}) => mutate(`/api/v1/access-requests/${encodeURIComponent(id)}/grant`, `grant:${id}`, body, { ...options, baseUrl });
  context.checkGrant = (baseUrl, id) => context.request(baseUrl, `/api/v1/grants/${encodeURIComponent(id)}/check`);
  context.revokeGrant = (baseUrl, id, body, options = {}) => mutate(`/api/v1/grants/${encodeURIComponent(id)}/revoke`, `grant-revoke:${id}`, body, { ...options, baseUrl });
  context.createBreakGlass = (baseUrl, body, options = {}) => mutate("/api/v1/break-glass-sessions", "break-glass", body, { ...options, baseUrl });
  context.approveBreakGlass = (baseUrl, id, body, options = {}) => mutate(`/api/v1/break-glass-sessions/${encodeURIComponent(id)}/approvals`, `break-glass-approval:${id}`, body, { ...options, baseUrl });
  context.activateBreakGlass = (baseUrl, id, body, options = {}) => mutate(`/api/v1/break-glass-sessions/${encodeURIComponent(id)}/activate`, `break-glass-activate:${id}`, body, { ...options, baseUrl });
  context.closeBreakGlass = (baseUrl, id, body, options = {}) => mutate(`/api/v1/break-glass-sessions/${encodeURIComponent(id)}/close`, `break-glass-close:${id}`, body, { ...options, baseUrl });
  context.checkBreakGlass = (baseUrl, id, body, options = {}) => context.request(baseUrl, `/api/v1/break-glass-sessions/${encodeURIComponent(id)}/check`, { ...options, method: "POST", json: body });
  context.quarantineRegion = (baseUrl, region, body, options = {}) => mutate(`/api/v1/regions/${encodeURIComponent(region)}/quarantine`, `quarantine:${region}`, body, { ...options, baseUrl });
  context.releaseRegion = (baseUrl, region, body, options = {}) => mutate(`/api/v1/regions/${encodeURIComponent(region)}/release`, `release:${region}`, body, { ...options, baseUrl });
  context.reviewRetrospective = (baseUrl, id, body, options = {}) => mutate(`/api/v1/break-glass-sessions/${encodeURIComponent(id)}/retrospective-reviews`, `retrospective:${id}`, body, { ...options, baseUrl });
  return context;
}

export async function createCaseContext(options) { return attach(await base.createCaseContext(options)); }
export async function withCaseContext(options, operation) { const context = await createCaseContext(options); let operationError; try { await context.setup(); return await operation(context); } catch (error) { operationError = error; throw error; } finally { try { await context.teardown(); } catch (cleanupError) { if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError; throw cleanupError; } } }
export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
