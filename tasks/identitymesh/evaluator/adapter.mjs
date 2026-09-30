import assert from "node:assert/strict";
import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const userId = id(2);
const deviceId = id(3);

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function seed(seedVersion = "hidden-identitymesh") {
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Tenant", revocationVersion: 0 }],
    users: [{ userId, tenantId, providerSubject: "hidden-user", state: "ACTIVE" }],
    devices: [{ deviceId, tenantId, userId, publicKeyFingerprint: "1".repeat(64), state: "TRUSTED", trustRevision: 1, createdAt: "2026-01-01T00:00:00.000Z", terminalAt: null }],
    sessions: [], signingKeys: [], revocations: [], auditEntries: [], auditCheckpoints: [],
  };
}

const spec = {
  label: "IdentityMesh LoginAttempt creation",
  performanceScenarioIds: ["session-refresh-contention", "revocation-fanout", "audit-chain-append"],
  seed: async () => seed(),
  path: "/api/v1/login-attempts",
  payload: (index) => ({ tenantId, providerRequestId: `hidden-login-${index}`, deviceId }),
  conflictPayload: () => ({ tenantId, providerRequestId: "changed-login", deviceId }),
  resource: "loginAttempts",
  identity: (json) => find(json, "loginAttemptId"),
  resourceIdentity: ({ loginAttemptId }) => loginAttemptId,
  workIdentity: (json) => find(json, "loginAttemptId"),
  async verify(ctx, baseUrl, response) {
    const loginAttemptId = find(response.json, "loginAttemptId");
    const snapshot = await ctx.snapshot(baseUrl);
    assert.equal(snapshot.resources.loginAttempts.filter((attempt) => attempt.loginAttemptId === loginAttemptId).length, 1);
    assert.ok(snapshot.resources.auditEntries.every((entry) => !/(token|credential|assertion|privateKey)/iu.test(JSON.stringify(entry))));
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, `/api/v1/devices/${deviceId}/challenges`, "h04-invalid-ttl", { ttlSeconds: 0 });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.deviceChallenges.length, before.resources.deviceChallenges.length);
    assert.equal(after.resources.auditEntries.length, before.resources.auditEntries.length);
  },
  async contention(ctx, baseUrls) {
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) => ctx.mutate(baseUrls[index % 2], "/api/v1/revocations", "h06-shared-revocation", { tenantId, subjectType: "DEVICE", subjectId: deviceId, reason: "contention" })));
    assert.equal(new Set(results.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    const tenant = snapshot.resources.tenants.find((item) => item.tenantId === tenantId);
    assert.equal(snapshot.resources.revocations.filter((item) => item.subjectId === deviceId).length, 1);
    assert.ok(tenant.revocationVersion >= 1);
  },
  manager: {
    path: "/api/v1/compromise-incidents",
    payload: () => ({ tenantId, reason: "suspected signing material compromise", requiredApproverIds: [id(41), id(42), id(43)], requiredApprovals: 2 }),
    async verify(ctx, baseUrl, response) {
      const incidentId = find(response.json, "incidentId");
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.compromiseIncidents.some((item) => item.incidentId === incidentId && item.state === "QUARANTINED") ? value : undefined;
      }, { children: [worker], label: "Tenant quarantine" });
      assert.equal(snapshot.resources.compromiseIncidents.filter((item) => item.incidentId === incidentId).length, 1);
      assert.ok(snapshot.resources.sessions.every((session) => session.tenantId !== tenantId || session.state === "REVOKED"));
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const incidentId = find(response.json, "incidentId");
      const worker = await ctx.startWorker();
      await ctx.waitFor(async () => (await ctx.snapshot(baseUrls[0])).resources.compromiseIncidents.some((item) => item.incidentId === incidentId && item.state === "QUARANTINED"), { children: [worker], label: "contended Tenant quarantine" });
      const approvals = await Promise.all([id(41), id(42), id(43)].map((approverId, index) => ctx.mutate(baseUrls[index % 2], `/api/v1/compromise-incidents/${incidentId}/approvals`, `h11-approval-${index}`, { approverId })));
      assert.equal(approvals.filter(({ status }) => status >= 200 && status < 300).length, 3);
      const recoveries = await Promise.all(baseUrls.map((baseUrl, index) => ctx.mutate(baseUrl, `/api/v1/compromise-incidents/${incidentId}/recover`, `h11-recover-${index}`, {})));
      assert.equal(recoveries.filter(({ status }) => status >= 200 && status < 300).length, 1);
      const snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(snapshot.resources.compromiseIncidents.filter((item) => item.incidentId === incidentId && item.state === "RECOVERED").length, 1);
    },
  },
  performance: identityPerformance,
};

async function createSession(ctx, baseUrl, index) {
  const providerRequestId = `perf-login-${index}`;
  const attempt = await ctx.mutate(baseUrl, "/api/v1/login-attempts", `perf-attempt-${index}`, { tenantId, providerRequestId, deviceId });
  assert.ok(attempt.status >= 200 && attempt.status < 300, attempt.text);
  const callback = await ctx.mutate(baseUrl, "/api/v1/provider/callbacks", `perf-callback-${index}`, { providerEventId: `perf-event-${index}`, providerRequestId, outcome: "SUCCEEDED", providerSubject: "hidden-user" });
  assert.ok(callback.status >= 200 && callback.status < 300, callback.text);
  return { sessionId: find(callback.json, "sessionId"), refreshToken: find(callback.json, "refreshToken") };
}

async function identityPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-identitymesh"))).exitCode, 0);
  const api = await ctx.startApi();
  const sessionCount = Math.max(1_000, Math.ceil(20_000 * scale));
  const sessions = await ctx.concurrent(Array.from({ length: sessionCount }), 64, (_, index) => createSession(ctx, api.baseUrl, index));
  assert.ok(sessions.every(({ sessionId, refreshToken }) => sessionId && refreshToken), "login setup did not return opaque Session credentials");
  const current = sessions.map((session) => ({ ...session, version: 0 }));
  const refresh = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async ({ client }) => {
      const state = current[client % current.length];
      const response = await ctx.mutate(api.baseUrl, `/api/v1/sessions/${state.sessionId}/refresh`, `perf-refresh-${client}-${state.version}`, { refreshToken: state.refreshToken, localRevocationVersion: 0 });
      if (response.status >= 200 && response.status < 300) {
        state.refreshToken = find(response.json, "refreshToken");
        state.version += 1;
      }
      return response;
    },
  });
  assert.ok(refresh.throughput >= 200 && refresh.p95 <= 300, `session-refresh-contention ${refresh.throughput}/s p95=${refresh.p95}`);
  assertions.push(`session-refresh-contention ${refresh.throughput.toFixed(1)}/s p95 ${refresh.p95.toFixed(1)}ms`);

  let revocationIndex = 0;
  const revoke = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 1_000 * scale, measureMs: 5_000 * scale,
    request: () => {
      const index = revocationIndex++;
      return ctx.mutate(api.baseUrl, "/api/v1/revocations", `perf-revocation-${index}`, { tenantId, subjectType: "SESSION", subjectId: sessions[index % sessions.length].sessionId, reason: "perf" });
    },
  });
  assert.ok(revoke.throughput >= 500, `revocation-fanout ${revoke.throughput}/s`);
  assertions.push(`revocation-fanout ${revoke.throughput.toFixed(1)}/s`);

  const worker = await ctx.startWorker();
  const startedAt = Date.now();
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ kind, terminal }) => kind !== "AUDIT_DELIVERY" || terminal) ? snapshot : undefined;
  }, { timeoutMs: 1_000_000, label: "Audit delivery drain", children: [worker] });
  const durationMs = Date.now() - startedAt;
  const audit = final.resources.auditEntries;
  const byTenant = audit.filter((entry) => entry.tenantId === tenantId).sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < byTenant.length; index += 1) {
    assert.equal(byTenant[index].sequence, index + 1);
    assert.equal(byTenant[index].priorDigest, index === 0 ? null : byTenant[index - 1].digest);
  }
  assertions.push(`audit-chain-append ${audit.length} entries in ${durationMs}ms`);
  return { metrics: [{ scenarioId: "session-refresh-contention", ...refresh }, { scenarioId: "revocation-fanout", ...revoke }, { scenarioId: "audit-chain-append", completed: audit.length, durationMs, p50: 0, p95: 0, p99: 0, throughput: durationMs ? audit.length / (durationMs / 1_000) : audit.length, statuses: {} }] };
}

export default standardAdapter(spec);
