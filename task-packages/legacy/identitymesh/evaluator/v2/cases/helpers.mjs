import assert from "node:assert/strict";

import {
  assertLoginAttempt,
  assertNoSecrets,
  assertPublicError,
  assertSession,
  assertSnapshot,
} from "../lib/oracle.mjs";

export function defineCase(id, fixtureFamily, action, oracle, seams, run) {
  return Object.freeze({ id, taskId: "identitymesh", fixtureFamily, action, oracle, seams: Object.freeze([...seams]), run });
}

export function caseResult(ctx, details = {}, diagnostics = []) {
  return {
    evidence: [{ caseId: ctx.caseId, taskId: "identitymesh", ...details }],
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

export function blocked(assertionId, blockedBy) { return { assertionId, blockedBy }; }

export function requireStatus(response, status, label = "request") {
  const allowed = Array.isArray(status) ? status : [status];
  assert.ok(allowed.includes(response.status), `${label}: expected ${allowed.join("/")}, got ${response.status}: ${response.text}`);
  return response.json;
}

export function expectError(ctx, response, status, code, options = {}) {
  ctx.assert(`${code} exact error`, () => assertPublicError(response, status, code), options);
  return response;
}

export async function boot(ctx, options = {}) {
  const catalogs = options.catalogs ?? [ctx.catalog(options.label ?? ctx.caseId.toLowerCase())];
  if (options.seed !== false) await ctx.seed(options.seed ?? ctx.seedFor(options.label ?? ctx.caseId.toLowerCase(), { catalogs }));
  const apis = [];
  for (let index = 0; index < (options.apiCount ?? 1); index += 1) apis.push(await ctx.startApi());
  return { catalogs, catalog: catalogs[0], apis, api: apis[0] };
}

export async function snapshot(ctx, url, options = {}) {
  const value = await ctx.snapshot(url, options);
  ctx.assert("snapshot V1 resources, shapes, order and Work", () => assertSnapshot(value, { final: options.final ?? true }), options.assertionOptions);
  return value;
}

export async function waitSnapshot(ctx, url, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const state = await ctx.snapshot(url, { timeoutMs: options.requestTimeoutMs });
    return predicate(state) ? state : undefined;
  }, {
    label: options.label ?? "IdentityMesh durable state",
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 100,
    processes: options.processes ?? [],
  });
}

export function resource(state, key, idKey, id) {
  return state.resources[key].find((item) => item[idKey] === id);
}

export function workFor(state, kind, aggregateId) {
  return state.work.filter((item) => item.kind === kind && (aggregateId === undefined || item.aggregateId === aggregateId));
}

export function auditFor(state, tenantId, eventType) {
  return state.resources.auditEntries.filter((item) => item.tenantId === tenantId && (eventType === undefined || item.eventType === eventType));
}

export async function ensureActiveSigningKey(ctx, url, catalog, options = {}) {
  const before = await ctx.snapshot(url);
  const active = before.resources.signingKeys.find((item) => item.tenantId === catalog.tenant.tenantId && item.state === "ACTIVE");
  if (active) return active;
  const response = await ctx.rotateKey(url, { tenantId: catalog.tenant.tenantId, expectedActiveKeyId: null }, { key: options.key });
  requireStatus(response, 200, "initial key rotation");
  return ctx.find(response.json, "keyId") ? response.json.signingKey ?? response.json : (await ctx.snapshot(url)).resources.signingKeys.find((item) => item.tenantId === catalog.tenant.tenantId && item.state === "ACTIVE");
}

export async function createSuccessfulSession(ctx, url, catalog, label = "success", options = {}) {
  if (options.ensureKey !== false) await ensureActiveSigningKey(ctx, url, catalog, { key: options.rotateKey });
  const providerRequestId = options.providerRequestId ?? `provider-request-${label}`;
  const attemptResponse = await ctx.createLoginAttempt(url, ctx.loginBody(catalog, providerRequestId), { key: options.attemptKey });
  requireStatus(attemptResponse, 200, "login attempt");
  const attemptId = ctx.find(attemptResponse.json, "loginAttemptId");
  assert.ok(attemptId, "loginAttemptId");
  const callback = ctx.callbackBody(catalog, label, "SUCCEEDED", { providerRequestId, providerEventId: options.providerEventId });
  const callbackResponse = await ctx.providerCallback(url, callback, { key: options.callbackKey });
  requireStatus(callbackResponse, 200, "provider callback");
  const final = await waitSnapshot(ctx, url, (state) => state.resources.loginAttempts.some((item) => item.loginAttemptId === attemptId && item.state === "SUCCEEDED"), { label: "successful login" });
  const attempt = resource(final, "loginAttempts", "loginAttemptId", attemptId);
  assertLoginAttempt(attempt);
  const sessionId = attempt.sessionId ?? ctx.find(callbackResponse.json, "sessionId");
  const session = resource(final, "sessions", "sessionId", sessionId);
  assertSession(session);
  const refreshToken = ctx.find(callbackResponse.json, "refreshToken");
  const accessToken = ctx.find(callbackResponse.json, "accessToken");
  assert.ok(typeof refreshToken === "string" && refreshToken.length > 0, "successful login returns refreshToken only on direct response");
  assert.ok(typeof accessToken === "string" && accessToken.length > 0, "successful login returns accessToken only on direct response");
  return { providerRequestId, attemptResponse, attempt, callback, callbackResponse, session, refreshToken, accessToken, snapshot: final };
}

export async function createUnknownAttempt(ctx, url, catalog, label = "unknown", options = {}) {
  const providerRequestId = options.providerRequestId ?? `provider-request-${label}`;
  const attemptResponse = await ctx.createLoginAttempt(url, ctx.loginBody(catalog, providerRequestId), { key: options.attemptKey });
  requireStatus(attemptResponse, 200, "unknown login attempt");
  const attemptId = ctx.find(attemptResponse.json, "loginAttemptId");
  const callback = ctx.callbackBody(catalog, label, "UNKNOWN", { providerRequestId, providerEventId: options.providerEventId });
  const callbackResponse = await ctx.providerCallback(url, callback, { key: options.callbackKey });
  requireStatus(callbackResponse, 200, "unknown callback");
  const state = await waitSnapshot(ctx, url, (value) => resource(value, "loginAttempts", "loginAttemptId", attemptId)?.state === "UNKNOWN", { label: "UNKNOWN login result" });
  return { providerRequestId, attemptId, attempt: resource(state, "loginAttempts", "loginAttemptId", attemptId), callback, callbackResponse, snapshot: state };
}

export function stableSemantic(ctx, responses, label, options = {}) {
  ctx.ok(`${label} has responses`, responses.length > 0);
  ctx.equal(`${label} status stable`, new Set(responses.map(({ status }) => status)).size, 1, options);
  ctx.equal(`${label} body stable`, new Set(responses.map(({ json }) => ctx.canonical(json))).size, 1, options);
  return responses[0];
}

export function scanPublicSurfaces(ctx, surfaces, sentinels, options = {}) {
  ctx.assert(options.label ?? "public surfaces contain no secrets", () => {
    for (const [label, value] of Object.entries(surfaces)) assertNoSecrets(value, sentinels, label);
  }, { failureCodeSuffix: "SECRET_EXPOSURE", hardCapIds: ["SECRET_EXPOSURE"] });
}

export function requireV1Workspace(ctx) {
  if (!ctx.v1Workspace) {
    const error = new Error("EVALUATOR_V1_WORKSPACE_REQUIRED");
    error.origin = "infrastructure";
    error.code = "EVALUATOR_V1_WORKSPACE_REQUIRED";
    throw error;
  }
  return ctx.forWorkspace(ctx.v1Workspace);
}
