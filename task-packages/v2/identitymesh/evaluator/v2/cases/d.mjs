import assert from "node:assert/strict";

import { auditCheckpoint, v1Seed } from "../lib/fixtures.mjs";
import { assertAuditChain, assertOpenApiV1, openApiOperation } from "../lib/oracle.mjs";
import {
  boot,
  caseResult,
  createSuccessfulSession,
  defineCase,
  requireStatus,
  scanPublicSurfaces,
  snapshot,
} from "./helpers.mjs";

import { approveIncident, incidentScenario, productionShell, recoverIncident } from "./final-system.mjs";

const d01 = defineCase(
  "D-01",
  "Final-system production shell and identity read surfaces",
  "Load and reload the production browser shell, then read durable identities through public HTTP",
  "A real visible page loads and public identities persist without browser storage",
  ["Chromium", "public HTTP", "verification snapshot"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "d01" });
    await productionShell(ctx, api);
    const state = await snapshot(ctx, api.baseUrl);
    assert.ok(state.resources.users.some(x => x.userId === catalog.user.userId));
    const listed = requireStatus(await ctx.request(api.baseUrl, "/api/v1/sessions?tenantId=" + catalog.tenant.tenantId), 200, "public session listing");
    assert.ok(Array.isArray(listed.items));
    return caseResult(ctx, { browserLoaded: true, userId: catalog.user.userId });
  },
);

const d02 = defineCase(
  "D-02",
  "Final-system public Incident read and recovery lineage",
  "Read a real Incident and its approvals before and after recovery",
  "The published read surface agrees with durable state without inventing UI controls",
  ["public HTTP", "verification snapshot", "Provider"],
  async (ctx) => {
    const scenario = await incidentScenario(ctx, "d02");
    const path = "/api/v1/compromise-incidents/" + scenario.incident.incidentId;
    const before = requireStatus(await ctx.request(scenario.api.baseUrl, path), 200, "Incident read");
    assert.deepEqual(before.incident, scenario.incident);
    assert.deepEqual(before.approvals, []);
    const recovered = await recoverIncident(ctx, scenario);
    const after = requireStatus(await ctx.request(recovered.api.baseUrl, path), 200, "recovered Incident read");
    assert.equal(after.incident.state, "RECOVERED");
    assert.equal(after.approvals.length, 2);
    assert.ok(after.approvals.every(x => x.incidentId === scenario.incident.incidentId && x.compromiseEpoch === scenario.incident.compromiseEpoch));
    return caseResult(ctx, { incidentId: scenario.incident.incidentId, approvals: after.approvals.length });
  },
);

const d03 = defineCase(
  "D-03",
  "F-AUDIT all V1 resource states and sentinel secrets",
  "Cross-check OpenAPI with runtime while concurrent activity overlaps a point-in-time snapshot",
  "V1 resource keys, exact shapes, deterministic order and referential integrity hold with zero secret exposure",
  ["public HTTP", "OpenAPI", "verification snapshot", "process logs"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "d03", provider: { initialOutcome: "SUCCEEDED" } });
    const login = await createSuccessfulSession(ctx, api.baseUrl, catalog, "d03");
    const openapi = await ctx.readOpenApi(api.baseUrl);
    ctx.assert("OpenAPI publishes every V1 operation", () => assertOpenApiV1(openapi));
    ctx.assert("OpenAPI publishes Manager Incident create path without inferring its schema", () => openApiOperation(openapi, "POST", "/api/v1/compromise-incidents"));
    const activity = ctx.concurrent(Array.from({ length: 12 }), 6, async (_, index) => {
      return ctx.createLoginAttempt(api.baseUrl, ctx.loginBody(catalog), { key: ctx.key(`d03-attempt-${index}`) });
    });
    // Observe early rejection; the original promise below still carries the failure.
    void activity.catch(() => {});
    const during = await snapshot(ctx, api.baseUrl);
    const responses = await activity;
    ctx.ok("concurrent activity uses public success responses", responses.every(({ status }) => status === 200));
    const final = await snapshot(ctx, api.baseUrl);
    for (const session of final.resources.sessions) {
      ctx.ok(`Session user exists ${session.sessionId}`, final.resources.users.some(({ userId }) => userId === session.userId));
      ctx.ok(`Session device exists ${session.sessionId}`, final.resources.devices.some(({ deviceId }) => deviceId === session.deviceId));
    }
    for (const attempt of final.resources.loginAttempts) {
      if (attempt.sessionId !== null) ctx.ok(`LoginAttempt Session exists ${attempt.loginAttemptId}`, final.resources.sessions.some(({ sessionId }) => sessionId === attempt.sessionId));
    }
    ctx.ok("point-in-time snapshot has a published asOf", Date.parse(during.asOf) <= Date.parse(final.asOf));
    scanPublicSurfaces(ctx, { during, final, apiLogs: api.logs }, { ...ctx.sentinels("d03"), refreshToken: login.refreshToken, accessToken: login.accessToken });
    ctx.ok("direct token-bearing response excluded from snapshot", !JSON.stringify(final).includes(login.refreshToken), undefined, { failureCodeSuffix: "REFRESH_TOKEN_IN_SNAPSHOT", hardCapIds: ["SECRET_EXPOSURE"] });
    const incident = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/compromise-incidents", ctx.key("d03-incident"), { tenantId: catalog.tenant.tenantId, approverIds: ["snapshot-owner", "snapshot-reviewer"], requiredApprovals: 2 }), 201, "snapshot Incident mutation");
    const approval = requireStatus(await approveIncident(ctx, api, incident, "snapshot-owner"), 200, "snapshot Approval mutation");
    const manager = await snapshot(ctx, api.baseUrl);
    assert.deepEqual(manager.resources.recoveryApprovals.filter(x => x.incidentId === incident.incidentId), [approval.approval]);
    assert.equal(manager.resources.compromiseIncidents.find(x => x.incidentId === incident.incidentId).state, "QUARANTINED");
    scanPublicSurfaces(ctx, { manager }, { ...ctx.sentinels("d03"), refreshToken: login.refreshToken, accessToken: login.accessToken });
    return caseResult(ctx, { asOf: during.asOf, resourceKeys: Object.keys(manager.resources).sort(), incidentId: incident.incidentId });
  },
);

const d04 = defineCase(
  "D-04",
  "F-AUDIT generated chain plus public-seed tamper variants",
  "Generate security transitions, independently recompute the chain, then import deletion/insertion/reorder/mutation variants",
  "Original verification passes and every tamper is rejected or publicly verifies invalid without rewriting history",
  ["public HTTP", "audit verify", "verification snapshot", "public seed import"],
  async (ctx) => {
    const { api, catalog } = await boot(ctx, { label: "d04" });
    await createSuccessfulSession(ctx, api.baseUrl, catalog, "d04-login-1");
    await createSuccessfulSession(ctx, api.baseUrl, catalog, "d04-login-2");
    await ctx.revokeSubject(api.baseUrl, ctx.revocationBody(catalog, "DEVICE", catalog.device.deviceId), { key: ctx.key("d04-revoke") });
    const original = await snapshot(ctx, api.baseUrl);
    const entries = original.resources.auditEntries.filter((item) => item.tenantId === catalog.tenant.tenantId);
    ctx.ok("audit fixture has multiple entries", entries.length >= 4);
    ctx.assert("independent tenant audit recomputation", () => assertAuditChain(original.resources.auditEntries), { failureCodeSuffix: "CHAIN_MISMATCH", hardCapIds: ["AUDIT_IMMUTABILITY"] });
    const verified = await ctx.verifyAudit(api.baseUrl, { tenantId: catalog.tenant.tenantId });
    requireStatus(verified, 200, "original audit verify");
    ctx.equal("original audit valid", ctx.find(verified.json, "valid"), true);

    const baseSeed = v1Seed(ctx.fixtures, "d04-export", {
      catalogs: [{ catalog, tenant: catalog.tenant, user: catalog.user, device: catalog.device }],
      sessions: original.resources.sessions,
      signingKeys: original.resources.signingKeys,
      revocations: original.resources.revocations,
      auditEntries: original.resources.auditEntries,
      auditCheckpoints: original.resources.auditCheckpoints.length ? original.resources.auditCheckpoints : [auditCheckpoint(catalog, entries)],
    });
    const variants = {
      deletion: (seed) => { seed.auditEntries.splice(1, 1); },
      insertion: (seed) => { seed.auditEntries.splice(1, 0, { ...seed.auditEntries[0], entryId: ctx.fixtures.uuid("d04-inserted") }); },
      reorder: (seed) => { [seed.auditEntries[0], seed.auditEntries[1]] = [seed.auditEntries[1], seed.auditEntries[0]]; },
      payloadMutation: (seed) => { seed.auditEntries[1].payloadDigest = "f".repeat(64); },
    };
    const outcomes = {};
    for (const [name, mutate] of Object.entries(variants)) {
      await ctx.resetDatabase(); await ctx.migrate();
      const seed = structuredClone(baseSeed); seed.seedVersion = `d04-${name}`; mutate(seed);
      const imported = await ctx.seedRaw(seed);
      if (imported.exitCode !== 0) { outcomes[name] = "seed-rejected"; continue; }
      const variantApi = await ctx.startApi();
      const check = await ctx.verifyAudit(variantApi.baseUrl, { tenantId: catalog.tenant.tenantId });
      ctx.ok(`${name} publicly verifies invalid`, check.status >= 400 || ctx.find(check.json, "valid") === false, undefined, { failureCodeSuffix: `${name.toUpperCase()}_UNDETECTED`, hardCapIds: ["AUDIT_IMMUTABILITY"] });
      outcomes[name] = "verify-rejected";
    }
    ctx.equal("all four tamper classes detected", Object.keys(outcomes).sort(), Object.keys(variants).sort());
    return caseResult(ctx, { entries: entries.length, tamperOutcomes: outcomes });
  },
);

export const D_CASES = Object.freeze([d01, d02, d03, d04]);
