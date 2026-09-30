import assert from "node:assert/strict";

import { sha256 } from "../lib/fixtures.mjs";
import {
  assertDevice,
  assertDeviceChallenge,
  assertSigningKey,
  verifyAccessToken,
} from "../lib/oracle.mjs";
import {
  auditFor,
  blocked,
  boot,
  caseResult,
  createSuccessfulSession,
  createUnknownAttempt,
  defineCase,
  ensureActiveSigningKey,
  expectError,
  requireStatus,
  resource,
  scanPublicSurfaces,
  snapshot,
  stableSemantic,
} from "./helpers.mjs";

const a01 = defineCase(
  "A-01",
  "F-LOGIN success/fail/unknown/duplicate/reordered callback",
  "Create public login attempts and callbacks, reconcile UNKNOWN, and replay identities",
  "One terminal provider result, one successful Session family, and no secret durability",
  ["public HTTP", "provider callback double", "verification snapshot", "audit"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "a01" });
    const successful = await createSuccessfulSession(ctx, api.baseUrl, catalog, "a01-success");
    const duplicate = await ctx.providerCallback(api.baseUrl, successful.callback, { key: ctx.key("duplicate-provider-callback") });
    requireStatus(duplicate, 200, "duplicate provider callback");
    ctx.equal("duplicate callback keeps LoginAttempt identity", ctx.find(duplicate.json, "loginAttemptId"), successful.attempt.loginAttemptId);

    const unknown = await createUnknownAttempt(ctx, api.baseUrl, catalog, "a01-unknown");
    ctx.equal("UNKNOWN creates no Session", unknown.snapshot.resources.sessions.filter((item) => item.sessionId !== successful.session.sessionId).length, 0);
    const retry = await ctx.createLoginAttempt(api.baseUrl, ctx.loginBody(catalog, unknown.providerRequestId), { key: ctx.key("unknown-new-request") });
    expectError(ctx, retry, 409, "LOGIN_RESULT_UNKNOWN");
    const reconciled = await ctx.reconcileLogin(api.baseUrl, unknown.attemptId, {
      outcome: "SUCCEEDED",
      providerSubject: catalog.user.providerSubject,
    });
    requireStatus(reconciled, 200, "UNKNOWN reconcile");

    const failedRequestId = "provider-request-a01-failed";
    const failedAttempt = await ctx.createLoginAttempt(api.baseUrl, ctx.loginBody(catalog, failedRequestId));
    requireStatus(failedAttempt, 200, "failed LoginAttempt create");
    const failed = await ctx.providerCallback(api.baseUrl, ctx.callbackBody(catalog, "a01-failed", "FAILED", { providerRequestId: failedRequestId }));
    requireStatus(failed, 200, "failed provider callback");
    const final = await snapshot(ctx, api.baseUrl);
    const failedId = ctx.find(failedAttempt.json, "loginAttemptId");
    ctx.equal("failed attempt is terminal FAILED", resource(final, "loginAttempts", "loginAttemptId", failedId)?.state, "FAILED");
    ctx.equal("failed attempt has no Session", resource(final, "loginAttempts", "loginAttemptId", failedId)?.sessionId, null);
    ctx.equal("provider duplicate makes one successful transition audit", auditFor(final, catalog.tenant.tenantId, "login.succeeded").filter((entry) => entry.subjectRef.includes(successful.attempt.loginAttemptId) || entry.subjectRef.includes(successful.session.sessionId)).length, 1);
    scanPublicSurfaces(ctx, { snapshot: final, apiLogs: api.logs }, { ...ctx.sentinels("a01"), refreshToken: successful.refreshToken, accessToken: successful.accessToken });
    return caseResult(ctx, { successfulAttemptId: successful.attempt.loginAttemptId, reconciledAttemptId: unknown.attemptId });
  },
);

const a02 = defineCase(
  "A-02",
  "F-REFRESH generations, reuse, replay and database expiry",
  "Rotate T0 to T1, replay the saved request, reuse T0, and inspect the family fence",
  "Generation advances once, reuse revokes every family Session, and signed access tokens remain independently verifiable",
  ["public HTTP", "JWKS", "verification snapshot", "database time"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "a02" });
    const login = await createSuccessfulSession(ctx, api.baseUrl, catalog, "a02");
    const jwks = requireStatus(await ctx.jwks(api.baseUrl, { tenantId: catalog.tenant.tenantId }), 200, "JWKS");
    verifyAccessToken(login.accessToken, jwks);
    const rotationKey = ctx.key("t0-to-t1");
    const rotated = await ctx.refreshSession(api.baseUrl, login.session.sessionId, login.refreshToken, { key: rotationKey, localRevocationVersion: login.session.requiredRevocationVersion });
    requireStatus(rotated, 200, "T0 rotation");
    const t1 = ctx.find(rotated.json, "refreshToken");
    const access1 = ctx.find(rotated.json, "accessToken");
    assert.ok(typeof t1 === "string" && t1 !== login.refreshToken, "rotation returns a distinct T1");
    verifyAccessToken(access1, jwks);
    const afterRotate = await snapshot(ctx, api.baseUrl);
    const rotatedSession = resource(afterRotate, "sessions", "sessionId", login.session.sessionId);
    ctx.equal("refresh generation increments exactly once", rotatedSession.refreshGeneration, login.session.refreshGeneration + 1);
    const replay = await ctx.refreshSession(api.baseUrl, login.session.sessionId, login.refreshToken, { key: rotationKey, localRevocationVersion: login.session.requiredRevocationVersion });
    stableSemantic(ctx, [rotated, replay], "saved refresh replay");
    const reused = await ctx.refreshSession(api.baseUrl, login.session.sessionId, login.refreshToken, { key: ctx.key("reuse-t0"), localRevocationVersion: login.session.requiredRevocationVersion });
    expectError(ctx, reused, 409, "REFRESH_TOKEN_REUSED", { failureCodeSuffix: "REUSE_NOT_DETECTED", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const final = await snapshot(ctx, api.baseUrl);
    const family = final.resources.sessions.filter((session) => session.tokenFamilyId === login.session.tokenFamilyId);
    ctx.ok("token family has Sessions", family.length > 0);
    ctx.ok("reuse closes entire token family", family.every((session) => session.state === "REVOKED"), undefined, { failureCodeSuffix: "FAMILY_RESURRECTED", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const t1AfterReuse = await ctx.refreshSession(api.baseUrl, login.session.sessionId, t1, { key: ctx.key("t1-after-reuse") });
    ctx.ok("T1 cannot refresh after family reuse", [400, 409].includes(t1AfterReuse.status), undefined, { failureCodeSuffix: "T1_AFTER_FAMILY_REVOKE", hardCapIds: ["IDENTITY_RESURRECTION"] });
    scanPublicSurfaces(ctx, { snapshot: final, apiLogs: api.logs }, { ...ctx.sentinels("a02"), refreshToken: login.refreshToken, rotatedRefreshToken: t1, accessToken: login.accessToken, rotatedAccessToken: access1 });
    return caseResult(ctx, { familyId: login.session.tokenFamilyId, initialGeneration: login.session.refreshGeneration, finalGeneration: resource(final, "sessions", "sessionId", login.session.sessionId)?.refreshGeneration });
  },
);

const a03 = defineCase(
  "A-03",
  "F-DEVICE nonce/user/fingerprint/expiry and derived Session",
  "Register a stable fingerprint, approve valid and invalid challenges, then revoke the Device",
  "Nonce binding is single-use and Device revocation closes challenges and derived Sessions",
  ["public HTTP", "task-local device key fixture", "verification snapshot"],
  async (ctx) => {
    const first = ctx.catalog("a03-primary");
    const second = ctx.catalog("a03-control");
    const { api } = await boot(ctx, { catalogs: [first, second], label: "a03" });
    const registered = await ctx.registerDevice(api.baseUrl, {
      tenantId: first.tenant.tenantId,
      userId: first.user.userId,
      publicKeyFingerprint: first.material.fingerprint,
    });
    requireStatus(registered, 200, "device registration");
    ctx.assert("registered Device has exact public shape", () => assertDevice(registered.json.device ?? registered.json));
    ctx.equal("stable fingerprint resolves existing Device", ctx.find(registered.json, "deviceId"), first.device.deviceId);
    const login = await createSuccessfulSession(ctx, api.baseUrl, first, "a03-session");

    const nonce = ctx.fixtures.secret("a03-nonce");
    const challenge = await ctx.createChallenge(api.baseUrl, first.device.deviceId, { nonceDigest: sha256(Buffer.from(nonce)), ttlSeconds: 60 });
    requireStatus(challenge, 200, "challenge create");
    const challengeValue = challenge.json.deviceChallenge ?? challenge.json;
    ctx.assert("DeviceChallenge exact public shape", () => assertDeviceChallenge(challengeValue));
    const challengeId = ctx.find(challenge.json, "challengeId");
    const crossUser = await ctx.approveChallenge(api.baseUrl, challengeId, { userId: second.user.userId, nonce }, { key: ctx.key("cross-user") });
    expectError(ctx, crossUser, 409, "DEVICE_CHALLENGE_INVALID");
    const approved = await ctx.approveChallenge(api.baseUrl, challengeId, { userId: first.user.userId, nonce });
    requireStatus(approved, 200, "challenge approve");
    const replay = await ctx.approveChallenge(api.baseUrl, challengeId, { userId: first.user.userId, nonce }, { key: ctx.key("nonce-replay") });
    expectError(ctx, replay, 409, "DEVICE_CHALLENGE_INVALID");
    const revoked = await ctx.revokeDevice(api.baseUrl, first.device.deviceId);
    requireStatus(revoked, 200, "device revoke");
    const afterRevokeChallenge = await ctx.createChallenge(api.baseUrl, first.device.deviceId, { nonceDigest: sha256(Buffer.from(ctx.fixtures.secret("after-revoke"))), ttlSeconds: 60 });
    expectError(ctx, afterRevokeChallenge, 409, "SUBJECT_REVOKED", { failureCodeSuffix: "REVOKED_DEVICE_CHALLENGE", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const afterRevokeRefresh = await ctx.refreshSession(api.baseUrl, login.session.sessionId, login.refreshToken);
    ctx.ok("derived Session cannot refresh", [400, 409].includes(afterRevokeRefresh.status), undefined, { failureCodeSuffix: "REVOKED_DEVICE_REFRESH", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const final = await snapshot(ctx, api.baseUrl);
    const device = resource(final, "devices", "deviceId", first.device.deviceId);
    ctx.equal("Device is REVOKED", device.state, "REVOKED");
    ctx.ok("trust revision remains monotonic", device.trustRevision >= first.device.trustRevision);
    ctx.equal("derived Session is revoked", resource(final, "sessions", "sessionId", login.session.sessionId).state, "REVOKED");
    scanPublicSurfaces(ctx, { snapshot: final, apiLogs: api.logs }, { nonce, refreshToken: login.refreshToken, accessToken: login.accessToken });
    return caseResult(ctx, { deviceId: first.device.deviceId, challengeId, trustRevision: device.trustRevision });
  },
);

const a04 = defineCase(
  "A-04",
  "F-KEY ACTIVE/RETIRING retirement boundary and concurrency",
  "Rotate one active key under concurrent replay and independently verify a token against JWKS",
  "Exactly one ACTIVE key remains, prior key is RETIRING, and public material matches signatures without private exposure",
  ["public HTTP", "JWKS", "verification snapshot", "task-local token oracle"],
  async (ctx) => {
    const { apis, catalog } = await boot(ctx, { label: "a04", apiCount: 2 });
    const first = await ensureActiveSigningKey(ctx, apis[0].baseUrl, catalog);
    ctx.assert("initial SigningKey exact", () => assertSigningKey(first));
    const login = await createSuccessfulSession(ctx, apis[0].baseUrl, catalog, "a04-token", { ensureKey: false });
    const rotateKey = ctx.key("concurrent-key-rotation");
    const body = { tenantId: catalog.tenant.tenantId, expectedActiveKeyId: first.keyId };
    const responses = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.rotateKey(apis[index % 2].baseUrl, body, { key: rotateKey }));
    responses.forEach((response) => requireStatus(response, 200, "concurrent rotation replay"));
    stableSemantic(ctx, responses, "concurrent rotation replay");
    const final = await snapshot(ctx, apis[0].baseUrl);
    const tenantKeys = final.resources.signingKeys.filter((item) => item.tenantId === catalog.tenant.tenantId);
    ctx.equal("exactly one ACTIVE signing key", tenantKeys.filter((item) => item.state === "ACTIVE").length, 1, { failureCodeSuffix: "MULTIPLE_ACTIVE_KEYS", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const prior = tenantKeys.find((item) => item.keyId === first.keyId);
    ctx.ok("prior key leaves ACTIVE", ["RETIRING", "RETIRED"].includes(prior.state));
    ctx.ok("prior publishes retirement boundary", prior.retireAt !== null);
    const jwks = requireStatus(await ctx.jwks(apis[0].baseUrl, { tenantId: catalog.tenant.tenantId }), 200, "JWKS");
    verifyAccessToken(login.accessToken, jwks, { issuedBefore: prior.retireAt });
    scanPublicSurfaces(ctx, { snapshot: final, jwks, apiLogs: apis.map(({ logs }) => logs) }, { ...ctx.sentinels("a04"), refreshToken: login.refreshToken, accessToken: login.accessToken });
    return caseResult(ctx, { activeKeyId: tenantKeys.find((item) => item.state === "ACTIVE").keyId, priorKeyId: first.keyId, priorState: prior.state });
  },
);

const a05 = defineCase(
  "A-05",
  "Manager quarantine fixture",
  "Do not call an unpublished Incident create wire",
  "Fail-closed until CompromiseIncident request, response, states, epochs and errors are published",
  ["blocked by IM-GAP-01"],
  async (ctx) => {
    return caseResult(ctx, { publicActionAttempted: false }, [blocked("IM-A05-QUARANTINE-WIRE", "IM-GAP-01")]);
  },
);

export const A_CASES = Object.freeze([a01, a02, a03, a04, a05]);
