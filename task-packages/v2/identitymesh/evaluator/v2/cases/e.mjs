import assert from "node:assert/strict";

import { assertAuditChain, assertExactKeys, verifyAccessToken } from "../lib/oracle.mjs";
import {
  boot,
  caseResult,
  createSuccessfulSession,
  defineCase,
  expectError,
  requireStatus,
  resource,
  scanPublicSurfaces,
  snapshot,
  stableSemantic,
  waitSnapshot,
} from "./helpers.mjs";

const e01 = defineCase(
  "E-01",
  "Final-system restart same database with live, revoked, pending and saved identities",
  "Create current-system identity and replay state, restart the same final system, then replay and complete work",
  "Every current-system identity, fence, response, Work, Event and audit entry survives without synthetic Incident state",
  ["current-system public commands", "FINAL public commands", "same PostgreSQL database", "verification snapshot"],
  async (ctx) => {
    const catalog = ctx.catalog("e01");
    await ctx.seed(ctx.seedFor("e01", { catalogs: [catalog] }));
    const originalApi = await ctx.startApi();
    const active = await createSuccessfulSession(ctx, originalApi.baseUrl, catalog, "e01-active");
    const revoked = await createSuccessfulSession(ctx, originalApi.baseUrl, catalog, "e01-revoked");
    requireStatus(await ctx.revokeSession(originalApi.baseUrl, revoked.session.sessionId, { key: ctx.key("e01-revoke") }), 200, "current-system session revoke");
    const replayBody = ctx.loginBody(catalog);
    const replayKey = ctx.key("e01-saved-response");
    const saved = await ctx.createLoginAttempt(originalApi.baseUrl, replayBody, { key: replayKey });
    requireStatus(saved, 200, "current-system saved request");
    const before = await snapshot(ctx, originalApi.baseUrl, { final: true });
    await ctx.stop(originalApi);

    const finalApi = await ctx.startApi();
    const replay = await ctx.createLoginAttempt(finalApi.baseUrl, replayBody, { key: replayKey });
    stableSemantic(ctx, [saved, replay], "current-system saved response after restart", { failureCodeSuffix: "REPLAY_CHANGED" });
    const after = await snapshot(ctx, finalApi.baseUrl);
    for (const [key, idKey] of [["sessions", "sessionId"], ["devices", "deviceId"], ["signingKeys", "keyId"], ["revocations", "revocationId"], ["auditEntries", "entryId"]]) {
      const beforeIds = before.resources[key].map((item) => item[idKey]);
      const afterIds = new Set(after.resources[key].map((item) => item[idKey]));
      ctx.ok(`${key} identities preserved`, beforeIds.every((id) => afterIds.has(id)));
    }
    const beforeWork = new Map(before.work.map((item) => [item.workId, ctx.canonical(item)]));
    ctx.ok("current-system Work identities survive", [...beforeWork.keys()].every((id) => after.work.some((item) => item.workId === id)));
    if (Array.isArray(before.events)) {
      ctx.ok("current-system Event identities survive", before.events.every((event) => after.events?.some((item) => item.eventId === event.eventId && ctx.canonical(item) === ctx.canonical(event))));
    }
    ctx.equal("revoked Session remains revoked", resource(after, "sessions", "sessionId", revoked.session.sessionId).state, "REVOKED", { failureCodeSuffix: "REVOKED_SESSION_REENABLED", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const refresh = await ctx.refreshSession(finalApi.baseUrl, active.session.sessionId, active.refreshToken, { key: ctx.key("e01-post-restart-refresh") });
    requireStatus(refresh, 200, "current-system active Session refresh after restart");
    ctx.equal("restart preserves Incidents", after.resources.compromiseIncidents, before.resources.compromiseIncidents);
    ctx.equal("restart preserves approvals", after.resources.recoveryApprovals, before.resources.recoveryApprovals);
    ctx.assert("restarted audit chain unchanged and valid", () => assertAuditChain(after.resources.auditEntries));
    scanPublicSurfaces(ctx, { before, after, apiLogs: finalApi.logs }, { ...ctx.sentinels("e01"), activeRefreshToken: active.refreshToken, revokedRefreshToken: revoked.refreshToken, activeAccessToken: active.accessToken, revokedAccessToken: revoked.accessToken });
    return caseResult(ctx, { preservedSessions: before.resources.sessions.length, preservedWork: before.work.length });
  },
);

const e02 = defineCase(
  "E-02",
  "Published Session expiry and SigningKey retirement boundaries",
  "Exercise safe windows at least one second before and after database-published boundaries",
  "Refresh, token verification, key retirement and revocation decisions agree with published database timestamps",
  ["public HTTP", "JWKS", "verification snapshot", "database-published timestamps"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "e02" });
    const expirySession = await createSuccessfulSession(ctx, api.baseUrl, catalog, "e02-expiry");
    const keySession = await createSuccessfulSession(ctx, api.baseUrl, catalog, "e02-key");
    const beforeKeys = await ctx.snapshot(api.baseUrl);
    const active = beforeKeys.resources.signingKeys.find((item) => item.tenantId === catalog.tenant.tenantId && item.state === "ACTIVE");
    const rotated = await ctx.rotateKey(api.baseUrl, { tenantId: catalog.tenant.tenantId, expectedActiveKeyId: active.keyId, retiringForSeconds: 60 });
    requireStatus(rotated, 200, "boundary key rotation");
    const afterRotate = await snapshot(ctx, api.baseUrl);
    const prior = resource(afterRotate, "signingKeys", "keyId", active.keyId);
    const beforeJwks = requireStatus(await ctx.jwks(api.baseUrl, { tenantId: catalog.tenant.tenantId }), 200, "pre-boundary JWKS");
    verifyAccessToken(keySession.accessToken, beforeJwks, { issuedBefore: prior.retireAt });
    const preExpiry = await ctx.refreshSession(api.baseUrl, expirySession.session.sessionId, expirySession.refreshToken, { key: ctx.key("pre-expiry") });
    requireStatus(preExpiry, 200, "pre-expiry refresh");
    const latestRefreshToken = ctx.find(preExpiry.json, "refreshToken");
    const revocation = await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(catalog, "SESSION", keySession.session.sessionId));
    requireStatus(revocation, 200, "boundary revocation");
    const stale = await ctx.refreshSession(api.baseUrl, keySession.session.sessionId, keySession.refreshToken, { key: ctx.key("e02-revoked") });
    ctx.ok("revocation fence fails closed", stale.status === 409, undefined, { failureCodeSuffix: "REVOCATION_FAIL_OPEN", hardCapIds: ["REVOCATION_FAIL_OPEN"] });

    const worker = await ctx.startWorker();
    const postBoundaryAt = Math.max(Date.parse(expirySession.session.expiresAt), Date.parse(prior.retireAt)) + 1_100;
    const remaining = postBoundaryAt - Date.now();
    if (remaining > 0) await ctx.sleep(remaining);
    const postExpiry = await ctx.refreshSession(api.baseUrl, expirySession.session.sessionId, latestRefreshToken, { key: ctx.key("post-expiry") });
    ctx.ok("post-expiry refresh fails", [400, 409].includes(postExpiry.status), undefined, { failureCodeSuffix: "EXPIRED_SESSION_REFRESHED", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const final = await waitSnapshot(ctx, api.baseUrl, (state) => resource(state, "signingKeys", "keyId", active.keyId)?.state === "RETIRED" ? state : undefined, { label: "published key retirement boundary", timeoutMs: 120_000, processes: [worker] });
    const afterJwks = requireStatus(await ctx.jwks(api.baseUrl, { tenantId: catalog.tenant.tenantId }), 200, "post-boundary JWKS");
    const keys = Array.isArray(afterJwks) ? afterJwks : afterJwks.keys;
    ctx.ok("RETIRED key no longer verifies through published JWKS", !keys.some((item) => item.kid === active.keyId || item.keyId === active.keyId));
    ctx.equal("Session is expired or security-revoked", ["EXPIRED", "REVOKED"].includes(resource(final, "sessions", "sessionId", expirySession.session.sessionId).state), true);
    return caseResult(ctx, { sessionBoundary: expirySession.session.expiresAt, keyBoundary: prior.retireAt,
      staleLocalVerifier: { exercised: false, diagnostic: "The public refresh request cannot force a stale server-local verifier; revocation rejection is checked." } });
  },
);

const e03 = defineCase(
  "E-03",
  "Two tenants with session, device, user and tenant revocation controls",
  "Apply each public revocation scope and probe all derived refresh, challenge and login paths",
  "The affected set equals the requested scope and the control tenant remains usable",
  ["public HTTP", "two-tenant verification snapshot"],
  async (ctx) => {
    const tenant = ctx.catalog("e03-tenant");
    const siblingBase = ctx.catalog("e03-sibling");
    const sibling = {
      ...siblingBase,
      tenant: tenant.tenant,
      user: { ...siblingBase.user, tenantId: tenant.tenant.tenantId },
      device: { ...siblingBase.device, tenantId: tenant.tenant.tenantId },
    };
    const control = ctx.catalog("e03-control");
    const { api } = await boot(ctx, { catalogs: [tenant, sibling, control], label: "e03" });
    const sessionOnly = await createSuccessfulSession(ctx, api.baseUrl, tenant, "e03-session-only");
    const sameDevice = await createSuccessfulSession(ctx, api.baseUrl, tenant, "e03-same-device");
    const siblingSession = await createSuccessfulSession(ctx, api.baseUrl, sibling, "e03-sibling");
    const controlSession = await createSuccessfulSession(ctx, api.baseUrl, control, "e03-control");

    requireStatus(await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(tenant, "SESSION", sessionOnly.session.sessionId)), 200, "session scope revoke");
    const sessionDenied = await ctx.refreshSession(api.baseUrl, sessionOnly.session.sessionId, sessionOnly.refreshToken, { key: ctx.key("session-denied") });
    expectError(ctx, sessionDenied, 409, "SUBJECT_REVOKED");
    const sameDeviceControl = await ctx.refreshSession(api.baseUrl, sameDevice.session.sessionId, sameDevice.refreshToken, { key: ctx.key("same-device-control") });
    requireStatus(sameDeviceControl, 200, "same Device other Session remains before Device revoke");
    const sameDeviceT1 = ctx.find(sameDeviceControl.json, "refreshToken");

    requireStatus(await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(tenant, "DEVICE", tenant.device.deviceId)), 200, "device scope revoke");
    const deviceDenied = await ctx.refreshSession(api.baseUrl, sameDevice.session.sessionId, sameDeviceT1, { key: ctx.key("device-denied") });
    ctx.ok("Device-derived refresh denied", [400, 409].includes(deviceDenied.status));
    const challengeDenied = await ctx.createChallenge(api.baseUrl, tenant.device.deviceId, { userId: tenant.user.userId, expiresInSeconds: 60 });
    expectError(ctx, challengeDenied, 409, "SUBJECT_REVOKED");

    requireStatus(await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(sibling, "USER", sibling.user.userId)), 200, "user scope revoke");
    const userLogin = await ctx.createLoginAttempt(api.baseUrl, ctx.loginBody(sibling));
    expectError(ctx, userLogin, 409, "SUBJECT_REVOKED");
    const userRefresh = await ctx.refreshSession(api.baseUrl, siblingSession.session.sessionId, siblingSession.refreshToken, { key: ctx.key("user-denied") });
    expectError(ctx, userRefresh, 409, "SUBJECT_REVOKED");

    requireStatus(await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(tenant, "TENANT", tenant.tenant.tenantId)), 200, "tenant scope revoke");
    const tenantLogin = await ctx.createLoginAttempt(api.baseUrl, ctx.loginBody(tenant));
    expectError(ctx, tenantLogin, 409, "SUBJECT_REVOKED");
    const controlRefresh = await ctx.refreshSession(api.baseUrl, controlSession.session.sessionId, controlSession.refreshToken, { key: ctx.key("control-refresh") });
    requireStatus(controlRefresh, 200, "other tenant remains usable");
    const final = await snapshot(ctx, api.baseUrl);
    ctx.ok("all revoked tenant Sessions close", final.resources.sessions.filter((item) => item.tenantId === tenant.tenant.tenantId).every((item) => item.state === "REVOKED"), undefined, { failureCodeSuffix: "SCOPE_MISSED_SESSION", hardCapIds: ["IDENTITY_RESURRECTION"] });
    ctx.equal("control tenant Session stays ACTIVE", resource(final, "sessions", "sessionId", controlSession.session.sessionId).state, "ACTIVE");
    return caseResult(ctx, { revokedTenantId: tenant.tenant.tenantId, controlTenantId: control.tenant.tenantId });
  },
);

const e04 = defineCase(
  "E-04",
  "More than 100 pages of deterministic failed-login AuditEntries",
  "Generate the chain, paginate from a frozen cursor while appending, then cross-check snapshot, checkpoint and verify",
  "Opaque cursors have no duplicates or gaps and new appends do not reorder the frozen prefix",
  ["public HTTP", "audit pagination", "verification snapshot", "audit verify"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "e04", provider: { initialOutcome: "FAILED" } });
    const createFailure = async (index) => {
      const attempt = await ctx.createLoginAttempt(api.baseUrl, ctx.loginBody(catalog), { key: ctx.key(`e04-attempt-${index}`) });
      requireStatus(attempt, 200, "pagination LoginAttempt");
      const providerRequestId = attempt.json.loginAttempt.providerRequestId;
      const callback = await ctx.providerCallback(api.baseUrl, ctx.callbackBody(catalog, `e04-${index}`, "FAILED", { providerRequestId }), { key: ctx.key(`e04-callback-${index}`) });
      requireStatus(callback, 200, "pagination failed callback");
    };
    await ctx.concurrent(Array.from({ length: 105 }), 20, (_, index) => createFailure(index));
    const frozen = await snapshot(ctx, api.baseUrl);
    const frozenIds = frozen.resources.auditEntries.filter((item) => item.tenantId === catalog.tenant.tenantId).map(({ entryId }) => entryId);
    ctx.ok("fixture spans more than one hundred one-item pages", frozenIds.length > 100);

    const seen = [];
    let cursor;
    let appendPromise;
    for (let page = 0; page < 250; page += 1) {
      const response = await ctx.audit(api.baseUrl, { limit: "1", ...(cursor ? { cursor } : {}) });
      requireStatus(response, 200, "audit page");
      assertExactKeys(response.json, ["items", "nextCursor"], "audit collection");
      assert.equal(response.json.items.length, 1, "one item per nonterminal page");
      seen.push(response.json.items[0]);
      if (page === 9) {
        appendPromise = ctx.concurrent(Array.from({ length: 10 }), 5, (_, index) => createFailure(105 + index));
        // Pagination can yield or fail before awaiting the append result.
        void appendPromise.catch(() => {});
      }
      cursor = response.json.nextCursor;
      if (cursor === null) break;
    }
    await appendPromise;
    ctx.ok("pagination terminates", cursor === null);
    const seenIds = seen.map(({ entryId }) => entryId);
    ctx.equal("no duplicate page entries", new Set(seenIds).size, seenIds.length);
    ctx.ok("every frozen entry appears exactly once", frozenIds.every((id) => seenIds.filter((seenId) => seenId === id).length === 1));
    const final = await snapshot(ctx, api.baseUrl);
    ctx.assert("full post-append tenant chain verifies independently", () => assertAuditChain(final.resources.auditEntries), { failureCodeSuffix: "PAGINATED_CHAIN_MISMATCH", hardCapIds: ["AUDIT_IMMUTABILITY"] });
    const checkpoint = final.resources.auditCheckpoints.find((item) => item.tenantId === catalog.tenant.tenantId);
    const latest = final.resources.auditEntries.filter((item) => item.tenantId === catalog.tenant.tenantId).at(-1);
    ctx.equal("checkpoint latest sequence", checkpoint.sequence, latest.sequence);
    ctx.equal("checkpoint latest digest", checkpoint.digest, latest.digest);
    const verified = await ctx.verifyAudit(api.baseUrl, { tenantId: catalog.tenant.tenantId });
    requireStatus(verified, 200, "post-pagination audit verify");
    ctx.equal("post-pagination audit valid", ctx.find(verified.json, "valid"), true);
    scanPublicSurfaces(ctx, { pages: seen, snapshot: final, apiLogs: api.logs }, ctx.sentinels("e04"));
    return caseResult(ctx, { pages: seen.length, frozenEntries: frozenIds.length, finalEntries: final.resources.auditEntries.length });
  },
);

export const E_CASES = Object.freeze([e01, e02, e03, e04]);
