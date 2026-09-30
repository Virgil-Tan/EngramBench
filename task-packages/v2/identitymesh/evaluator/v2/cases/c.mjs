import assert from "node:assert/strict";

import { assertAuditChain, verifyAccessToken } from "../lib/oracle.mjs";
import {
  boot,
  caseResult,
  createSuccessfulSession,
  createUnknownAttempt,
  defineCase,
  requireStatus,
  resource,
  scanPublicSurfaces,
  snapshot,
  waitSnapshot,
  workFor,
} from "./helpers.mjs";

import { incidentScenario, recoverIncident } from "./final-system.mjs";

const c01 = defineCase(
  "C-01",
  "F-LOGIN/F-RECOVERY UNKNOWN attempt and committed Work",
  "Observe LOGIN_RECONCILIATION Work, SIGKILL its Worker, replace it, and reconcile the same Attempt",
  "One stable provider outcome, Session family, terminal Work and Audit survive the crash",
  ["public HTTP", "verification snapshot", "independent worker", "SIGKILL"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "c01" });
    const unknown = await createUnknownAttempt(ctx, api.baseUrl, catalog, "c01");
    const pending = workFor(unknown.snapshot, "LOGIN_RECONCILIATION", unknown.attemptId);
    ctx.equal("one reconciliation Work", pending.length, 1);
    const firstWorker = await ctx.startWorker();
    const leased = await waitSnapshot(ctx, api.baseUrl, (state) => workFor(state, "LOGIN_RECONCILIATION", unknown.attemptId).length > 0, {
      label: "LOGIN_RECONCILIATION durably visible",
      timeoutMs: 90_000,
      intervalMs: 10,
      processes: [firstWorker],
    });
    const leasedWork = workFor(leased, "LOGIN_RECONCILIATION", unknown.attemptId)[0];
    await ctx.kill(firstWorker);
    ctx.provider.resolve(unknown.providerRequestId, "SUCCEEDED");
    const replacement = await ctx.startWorker();
    const reconciled = await ctx.reconcileLogin(api.baseUrl, unknown.attemptId, {}, { key: ctx.key("recovery-reconcile") });
    requireStatus(reconciled, 200, "recovery reconcile");
    const final = await waitSnapshot(ctx, api.baseUrl, (state) => {
      const attempt = resource(state, "loginAttempts", "loginAttemptId", unknown.attemptId);
      const works = workFor(state, "LOGIN_RECONCILIATION", unknown.attemptId);
      return attempt?.state === "SUCCEEDED" && works.length === 1 && works[0].terminal ? state : undefined;
    }, { label: "reconciliation recovery closure", timeoutMs: 90_000, processes: [replacement] });
    const attempt = resource(final, "loginAttempts", "loginAttemptId", unknown.attemptId);
    ctx.equal("one resulting Session", final.resources.sessions.filter((item) => item.sessionId === attempt.sessionId).length, 1);
    ctx.equal("Work identity stable", workFor(final, "LOGIN_RECONCILIATION", unknown.attemptId)[0].workId, leasedWork.workId);
    ctx.equal("one login success audit", final.resources.auditEntries.filter((item) => item.eventType === "login.succeeded" && item.tenantId === catalog.tenant.tenantId).length, 1);
    return caseResult(ctx, { workId: leasedWork.workId, killedAttempt: leasedWork.attempt, observedState: leasedWork.state });
  },
);

const c02 = defineCase(
  "C-02",
  "F-REVOKE committed propagation Work",
  "Observe REVOCATION_PROPAGATION Work, SIGKILL its Worker, and converge with a replacement",
  "Revocation identity and version remain stable and no verifier re-enables the subject during recovery",
  ["public HTTP", "verification snapshot", "independent worker", "SIGKILL"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "c02" });
    const login = await createSuccessfulSession(ctx, api.baseUrl, catalog, "c02");
    const key = ctx.key("c02-revocation");
    const response = await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(catalog, "SESSION", login.session.sessionId), { key });
    requireStatus(response, 200, "revocation request");
    const revocationId = ctx.find(response.json, "revocationId");
    const firstWorker = await ctx.startWorker();
    const leased = await waitSnapshot(ctx, api.baseUrl, (state) => workFor(state, "REVOCATION_PROPAGATION", revocationId).length > 0, {
      label: "REVOCATION_PROPAGATION durably visible",
      timeoutMs: 90_000,
      intervalMs: 10,
      processes: [firstWorker],
    });
    const leasedWork = workFor(leased, "REVOCATION_PROPAGATION", revocationId)[0];
    const staleDuringRecovery = await ctx.refreshSession(api.baseUrl, login.session.sessionId, login.refreshToken, { key: ctx.key("recovery-revoked") });
    ctx.ok("recovery window fails closed", staleDuringRecovery.status === 409, undefined, { failureCodeSuffix: "RECOVERY_FAIL_OPEN", hardCapIds: ["REVOCATION_FAIL_OPEN"] });
    await ctx.kill(firstWorker);
    const replacement = await ctx.startWorker();
    const final = await waitSnapshot(ctx, api.baseUrl, (state) => {
      const revocation = resource(state, "revocations", "revocationId", revocationId);
      const work = workFor(state, "REVOCATION_PROPAGATION", revocationId);
      return revocation?.state === "PROPAGATED" && work.length === 1 && work[0].terminal ? state : undefined;
    }, { label: "revocation recovery closure", timeoutMs: 90_000, processes: [replacement] });
    const replay = await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(catalog, "SESSION", login.session.sessionId), { key });
    requireStatus(replay, 200, "revocation replay after recovery");
    ctx.equal("revocation identity replay", ctx.find(replay.json, "revocationId"), revocationId);
    ctx.equal("Work identity stable", workFor(final, "REVOCATION_PROPAGATION", revocationId)[0].workId, leasedWork.workId);
    ctx.equal("Session never re-enabled", resource(final, "sessions", "sessionId", login.session.sessionId).state, "REVOKED", { failureCodeSuffix: "SESSION_REENABLED", hardCapIds: ["IDENTITY_RESURRECTION"] });
    return caseResult(ctx, { revocationId, workId: leasedWork.workId,
      staleLocalVerifier: { exercised: false, diagnostic: "The public refresh request cannot force a stale server-local verifier; recovery-window rejection is checked." } },
    );
  },
);

const c03 = defineCase(
  "C-03",
  "Final-system quarantine recovery after process replacement",
  "Commit a quarantine, kill its Worker and restart the API before completing recovery",
  "The same Incident, quorum and revoked identities survive process replacement",
  ["public HTTP", "verification snapshot", "SIGKILL"],
  async (ctx) => {
    const scenario = await incidentScenario(ctx, "c03");
    const work = scenario.after.work.filter(x => x.kind === "TENANT_QUARANTINE");
    assert.equal(work.length, 1, "quarantine commits one durable Work");
    const worker = await ctx.startWorker();
    await ctx.snapshot(scenario.api.baseUrl);
    await ctx.kill(worker);
    const recovered = await recoverIncident(ctx, scenario, { restart: true });
    assert.ok(recovered.final.work.some(x => x.workId === work[0].workId && x.terminal), "quarantine Work identity reaches a terminal state");
    return caseResult(ctx, { incidentId: recovered.incidentId, processRestarted: true });
  },
);

const c04 = defineCase(
  "C-04",
  "F-KEY/F-AUDIT retirement Work and unknown receiver ACK",
  "Rotate an issuing key, kill a Worker after public Work observation, then drop an audit ACK and restart its Dispatcher",
  "Key retirement commits once and audit redelivery preserves exact entry identity and body",
  ["public HTTP", "JWKS", "verification snapshot", "receiver", "SIGKILL"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "c04" });
    const login = await createSuccessfulSession(ctx, api.baseUrl, catalog, "c04");
    const before = await ctx.snapshot(api.baseUrl);
    const active = before.resources.signingKeys.find((item) => item.tenantId === catalog.tenant.tenantId && item.state === "ACTIVE");
    const rotated = await ctx.rotateKey(api.baseUrl, { tenantId: catalog.tenant.tenantId, expectedActiveKeyId: active.keyId, retiringForSeconds: 60 });
    requireStatus(rotated, 200, "second key rotation");
    const afterRotate = await snapshot(ctx, api.baseUrl);
    const prior = resource(afterRotate, "signingKeys", "keyId", active.keyId);
    ctx.ok("prior key is retiring", ["RETIRING", "RETIRED"].includes(prior.state));
    const jwks = requireStatus(await ctx.jwks(api.baseUrl, { tenantId: catalog.tenant.tenantId }), 200, "JWKS before retirement");
    verifyAccessToken(login.accessToken, jwks, { issuedBefore: prior.retireAt });

    const retirementWork = workFor(afterRotate, "KEY_RETIREMENT", active.keyId);
    ctx.equal("one KEY_RETIREMENT Work", retirementWork.length, 1);
    const worker = await ctx.startWorker();
    const leased = await waitSnapshot(ctx, api.baseUrl, (state) => workFor(state, "KEY_RETIREMENT", active.keyId).length > 0, {
      label: "KEY_RETIREMENT durably visible",
      timeoutMs: 120_000,
      intervalMs: 10,
      processes: [worker],
    });
    const leasedWork = workFor(leased, "KEY_RETIREMENT", active.keyId)[0];
    await ctx.kill(worker);
    const replacement = await ctx.startWorker();

    const receiver = await ctx.receiver({
      path: "/audit",
      behavior: (_entry, ledger) => ledger.length === 1 ? { disconnect: true } : { status: 204 },
    });
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const firstDelivery = await ctx.waitFor(() => receiver.ledger[0], { label: "first audit body", timeoutMs: 90_000, processes: [dispatcher] });
    await ctx.kill(dispatcher);
    const replacementDispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const redelivery = await ctx.waitFor(() => receiver.ledger.find((entry, index) => index > 0 && entry.acknowledged), { label: "audit redelivery acknowledgement", timeoutMs: 90_000, processes: [replacementDispatcher] });
    ctx.equal("audit redelivery body stable", redelivery.raw, firstDelivery.raw);
    ctx.equal("audit redelivery entry identity stable", ctx.find(redelivery.json, "entryId"), ctx.find(firstDelivery.json, "entryId"));
    const final = await waitSnapshot(ctx, api.baseUrl, (state) => {
      const work = workFor(state, "KEY_RETIREMENT", active.keyId);
      return work.length === 1 && work[0].terminal ? state : undefined;
    }, { label: "key retirement closure", timeoutMs: 180_000, processes: [replacement] });
    ctx.equal("retirement Work identity stable", workFor(final, "KEY_RETIREMENT", active.keyId)[0].workId, leasedWork.workId);
    ctx.assert("audit chain remains closed", () => assertAuditChain(final.resources.auditEntries));
    scanPublicSurfaces(ctx, { snapshot: final, workerLogs: replacement.logs, dispatcherLogs: replacementDispatcher.logs }, { ...ctx.sentinels("c04"), refreshToken: login.refreshToken, accessToken: login.accessToken });
    return caseResult(ctx, { keyId: active.keyId, retirementWorkId: leasedWork.workId, deliveryAttempts: receiver.ledger.length });
  },
);

export const C_CASES = Object.freeze([c01, c02, c03, c04]);
