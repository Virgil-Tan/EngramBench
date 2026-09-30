import assert from "node:assert/strict";

import {
  boot,
  caseResult,
  createSuccessfulSession,
  defineCase,
  expectError,
  requireStatus,
  resource,
  snapshot,
  stableSemantic,
  waitSnapshot,
} from "./helpers.mjs";

import { incidentScenario, recoverIncident } from "./final-system.mjs";

const b01 = defineCase(
  "B-01",
  "F-LOGIN two APIs and response shield",
  "Drop a committed response, replay the request, conflict its key, and race provider identities",
  "Request replay returns one saved response while provider callback identity admits one terminal result",
  ["public HTTP", "two API processes", "response shield", "verification snapshot"],
  async (ctx) => {
    const { apis, catalog } = await boot(ctx, { label: "b01", apiCount: 2 });
    const shield = await ctx.responseShield(apis[0].baseUrl);
    const body = ctx.loginBody(catalog);
    const key = ctx.key("unknown-response-login");
    shield.dropNextMutation();
    await ctx.createLoginAttempt(shield.baseUrl, body, { key }).catch(() => undefined);
    const capture = await ctx.waitFor(() => shield.captures.find((item) => item.dropped), { label: "committed response shield capture" });
    const replay = await ctx.createLoginAttempt(apis[1].baseUrl, body, { key });
    requireStatus(replay, 200, "saved request replay");
    ctx.equal("saved replay status", replay.status, capture.response.status);
    ctx.equal("saved replay body", ctx.canonical(replay.json), ctx.canonical(JSON.parse(capture.response.body)));
    const providerRequestId = replay.json.loginAttempt.providerRequestId;
    const conflict = await ctx.createLoginAttempt(apis[0].baseUrl, { ...body, username: `${body.username}-changed` }, { key });
    expectError(ctx, conflict, 409, "IDEMPOTENCY_CONFLICT");

    ctx.provider.resolve(providerRequestId, "SUCCEEDED");
    const success = ctx.callbackBody(catalog, "b01-success", "SUCCEEDED", { providerRequestId });
    // Conflicting notification input does not reverse the test provider's terminal truth.
    const failed = ctx.callbackBody(catalog, "b01-failed", "FAILED", { providerRequestId });
    const callbacks = await Promise.all([
      ctx.providerCallback(apis[0].baseUrl, success, { key: ctx.key("callback-success") }),
      ctx.providerCallback(apis[1].baseUrl, failed, { key: ctx.key("callback-failed") }),
      ctx.providerCallback(apis[0].baseUrl, success, { key: ctx.key("callback-success-duplicate") }),
    ]);
    ctx.ok("callback race has no server failure", callbacks.every(({ status }) => status < 500));
    const final = await snapshot(ctx, apis[0].baseUrl);
    const matching = final.resources.loginAttempts.filter((item) => item.providerRequestId === providerRequestId);
    ctx.equal("one LoginAttempt for providerRequestId", matching.length, 1);
    ctx.ok("one terminal provider outcome", ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(matching[0].state));
    ctx.ok("at most one Session family", final.resources.sessions.filter((item) => item.sessionId === matching[0].sessionId).length <= 1);
    return caseResult(ctx, { loginAttemptId: matching[0].loginAttemptId, outcome: matching[0].state, shielded: true });
  },
);

const b02 = defineCase(
  "B-02",
  "F-REFRESH 20-way two-API contention",
  "Lose the winner response, replay it, then race distinct keys using T0",
  "At most one rotation effect exists and reuse closes the family without a second generation",
  ["public HTTP", "two API processes", "response shield", "verification snapshot"],
  async (ctx) => {
    const { apis, catalog } = await boot(ctx, { label: "b02", apiCount: 2 });
    const login = await createSuccessfulSession(ctx, apis[0].baseUrl, catalog, "b02");
    const shield = await ctx.responseShield(apis[0].baseUrl);
    const winnerKey = ctx.key("winner");
    shield.dropNextMutation();
    await ctx.refreshSession(shield.baseUrl, login.session.sessionId, login.refreshToken, { key: winnerKey }).catch(() => undefined);
    const capture = await ctx.waitFor(() => shield.captures.find((item) => item.dropped), { label: "lost refresh winner response" });
    const saved = await ctx.refreshSession(apis[1].baseUrl, login.session.sessionId, login.refreshToken, { key: winnerKey });
    requireStatus(saved, 200, "winner saved replay");
    ctx.equal("winner replay body unchanged", ctx.canonical(saved.json), ctx.canonical(JSON.parse(capture.response.body)));
    const contenders = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.refreshSession(
      apis[index % 2].baseUrl,
      login.session.sessionId,
      login.refreshToken,
      { key: ctx.key(`reuse-${index}`) },
    ));
    ctx.equal("no second T0 rotation succeeds", contenders.filter(({ status }) => status >= 200 && status < 300).length, 0, { failureCodeSuffix: "DOUBLE_ROTATION", hardCapIds: ["IDENTITY_RESURRECTION"] });
    ctx.ok("reuse responses are semantic conflicts", contenders.every(({ status }) => status === 409));
    const final = await snapshot(ctx, apis[0].baseUrl);
    const family = final.resources.sessions.filter((item) => item.tokenFamilyId === login.session.tokenFamilyId);
    ctx.ok("contended family entirely revoked", family.every((item) => item.state === "REVOKED"), undefined, { failureCodeSuffix: "FAMILY_ACTIVE_AFTER_REUSE", hardCapIds: ["IDENTITY_RESURRECTION"] });
    ctx.equal("one accepted generation", Math.max(...family.map(({ refreshGeneration }) => refreshGeneration)), login.session.refreshGeneration + 1);
    return caseResult(ctx, { tokenFamilyId: login.session.tokenFamilyId, contenderCount: contenders.length });
  },
);

const b03 = defineCase(
  "B-03",
  "F-DEVICE/F-REVOKE fixed two-API interleaving",
  "Race Device revoke with live challenge approval and derived Session refresh, then retry behind the fence",
  "After the revoke fence no trust or refresh can succeed and queued identity work cannot reopen the Device",
  ["public HTTP", "two API processes", "verification snapshot"],
  async (ctx) => {
    const { apis, catalog } = await boot(ctx, { label: "b03", apiCount: 2 });
    const login = await createSuccessfulSession(ctx, apis[0].baseUrl, catalog, "b03");
    const challenge = await ctx.createChallenge(apis[0].baseUrl, catalog.device.deviceId, { userId: catalog.user.userId, expiresInSeconds: 60 });
    requireStatus(challenge, 200, "race challenge");
    const nonce = challenge.json.nonce;
    const approval = { tenantId: catalog.tenant.tenantId, userId: catalog.user.userId, publicKeyFingerprint: catalog.device.publicKeyFingerprint, nonce,
      expectedTrustRevision: resource(login.snapshot, "devices", "deviceId", catalog.device.deviceId).trustRevision };
    const challengeId = ctx.find(challenge.json, "challengeId");
    const [revoked, approved, refreshed] = await Promise.all([
      ctx.revokeDevice(apis[0].baseUrl, catalog.device.deviceId, { key: ctx.key("race-revoke") }),
      ctx.approveChallenge(apis[1].baseUrl, challengeId, approval, { key: ctx.key("race-approve") }),
      ctx.refreshSession(apis[1].baseUrl, login.session.sessionId, login.refreshToken, { key: ctx.key("race-refresh") }),
    ]);
    requireStatus(revoked, 200, "Device revoke winner");
    ctx.ok("racing requests return public outcomes", [approved, refreshed].every(({ status }) => status < 500));
    const postChallenge = await ctx.createChallenge(apis[1].baseUrl, catalog.device.deviceId, { userId: catalog.user.userId, expiresInSeconds: 60 });
    expectError(ctx, postChallenge, 409, "SUBJECT_REVOKED", { failureCodeSuffix: "POST_FENCE_CHALLENGE", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const postRefresh = await ctx.refreshSession(apis[0].baseUrl, login.session.sessionId, ctx.find(refreshed.json, "refreshToken") ?? login.refreshToken, { key: ctx.key("post-fence-refresh") });
    ctx.ok("post-fence refresh fails", [400, 409].includes(postRefresh.status), undefined, { failureCodeSuffix: "POST_FENCE_REFRESH", hardCapIds: ["IDENTITY_RESURRECTION"] });
    const final = await snapshot(ctx, apis[0].baseUrl);
    ctx.equal("Device remains REVOKED", resource(final, "devices", "deviceId", catalog.device.deviceId).state, "REVOKED");
    ctx.equal("derived Session remains REVOKED", resource(final, "sessions", "sessionId", login.session.sessionId).state, "REVOKED");
    ctx.ok("queued refresh work is closed", final.work.filter((item) => item.aggregateId === login.session.sessionId).every((item) => item.terminal || item.kind !== "LOGIN_RECONCILIATION"));
    return caseResult(ctx, { deviceId: catalog.device.deviceId, raceStatuses: [revoked.status, approved.status, refreshed.status] });
  },
);

const b04 = defineCase(
  "B-04",
  "F-REVOKE duplicate, concurrent and reordered worker completion",
  "Create monotonic revocations, replay one identity, run competing workers, and retry a revoked Session",
  "Versions only increase, duplicate replay preserves identity, and a revoked Session fails closed",
  ["public HTTP", "two API processes", "multiple workers", "verification snapshot"],
  async (ctx) => {
    const primary = ctx.catalog("b04-primary");
    const control = ctx.catalog("b04-control");
    const { apis } = await boot(ctx, { catalogs: [primary, control], apiCount: 2, label: "b04" });
    const target = await createSuccessfulSession(ctx, apis[0].baseUrl, primary, "b04-target");
    const unaffected = await createSuccessfulSession(ctx, apis[1].baseUrl, control, "b04-control");
    const bodies = [
      ctx.revocationBody(primary, "SESSION", target.session.sessionId),
      ctx.revocationBody(primary, "DEVICE", primary.device.deviceId),
      ctx.revocationBody(primary, "USER", primary.user.userId),
    ];
    const keys = bodies.map((_, index) => ctx.key(`revocation-${index}`));
    const first = await ctx.revokeSubject(apis[0].baseUrl, bodies[0], { key: keys[0] }); requireStatus(first, 200, "session revocation");
    const duplicate = await ctx.revokeSubject(apis[1].baseUrl, bodies[0], { key: keys[0] }); requireStatus(duplicate, 200, "revocation replay");
    stableSemantic(ctx, [first, duplicate], "revocation identity replay");
    const later = await Promise.all(bodies.slice(1).map((body, index) => ctx.revokeSubject(apis[index].baseUrl, body, { key: keys[index + 1] })));
    later.forEach((response) => requireStatus(response, 200, "later revocation"));
    const workers = await Promise.all(Array.from({ length: 3 }, () => ctx.startWorker()));
    const converged = await waitSnapshot(ctx, apis[0].baseUrl, (state) => state.resources.revocations.filter((item) => item.tenantId === primary.tenant.tenantId).every((item) => item.state === "PROPAGATED"), { label: "revocation propagation convergence", timeoutMs: 90_000, processes: workers });
    const versions = converged.resources.revocations.filter((item) => item.tenantId === primary.tenant.tenantId).map(({ version }) => version);
    ctx.equal("revocation versions unique", new Set(versions).size, versions.length, { failureCodeSuffix: "VERSION_REGRESSION", hardCapIds: ["REVOCATION_FAIL_OPEN"] });
    ctx.equal("revocation versions sorted", versions, [...versions].sort((a, b) => a - b), { failureCodeSuffix: "VERSION_REORDERED", hardCapIds: ["REVOCATION_FAIL_OPEN"] });
    const stale = await ctx.refreshSession(apis[0].baseUrl, target.session.sessionId, target.refreshToken, { key: ctx.key("revoked-session") });
    ctx.ok("revoked Session fails closed", stale.status === 409 && ["REVOCATION_FENCE_STALE", "SUBJECT_REVOKED"].includes(stale.json?.error?.code), undefined, { failureCodeSuffix: "STALE_VERIFIER_ALLOWED", hardCapIds: ["REVOCATION_FAIL_OPEN"] });
    const controlRefresh = await ctx.refreshSession(apis[1].baseUrl, unaffected.session.sessionId, unaffected.refreshToken, { key: ctx.key("other-tenant-control") });
    requireStatus(controlRefresh, 200, "other tenant refresh control");
    return caseResult(ctx, { versions, controlTenantId: control.tenant.tenantId,
      staleLocalVerifier: { exercised: false, diagnostic: "The public refresh request cannot force a stale server-local verifier; revoked-Session rejection is checked." } });
  },
);

const b05 = defineCase(
  "B-05",
  "Final-system recovery quorum under concurrent replay",
  "Race final approvals and recover requests through the published Incident routes",
  "Quorum and recovery emit one transition and never restore old identity",
  ["public HTTP", "verification snapshot", "Provider"],
  async (ctx) => {
    const scenario = await incidentScenario(ctx, "b05");
    const final = await recoverIncident(ctx, scenario, { concurrent: true });
    return caseResult(ctx, { incidentId: final.incidentId, approvals: final.approvals, recoveryResponses: final.recoveryResponses });
  },
);

export const B_CASES = Object.freeze([b01, b02, b03, b04, b05]);
