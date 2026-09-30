import assert from "node:assert/strict";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const basicPlanId = id(2);
const basicRevisionId = id(3);
const proPlanId = id(4);
const proRevisionId = id(5);
const past = "2025-12-01T00:00:00.000Z";
const future = "2030-01-01T00:00:00.000Z";

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function basePlans() {
  return {
    plans: [{ planId:basicPlanId, tenantId, key:"basic", name:"Basic" }, { planId:proPlanId, tenantId, key:"pro", name:"Pro" }],
    planRevisions: [
      { planRevisionId:basicRevisionId, planId:basicPlanId, revision:1, state:"PUBLISHED", priceMinor:1_000, currency:"USD", interval:"MONTH", features:{ reports:1 }, trialDays:14, graceDays:3, refundDays:7, createdAt:past, publishedAt:past },
      { planRevisionId:proRevisionId, planId:proPlanId, revision:1, state:"PUBLISHED", priceMinor:3_000, currency:"USD", interval:"MONTH", features:{ reports:10, exports:1 }, trialDays:14, graceDays:3, refundDays:7, createdAt:past, publishedAt:past },
    ],
  };
}

function seed(seedVersion = "hidden-entitlementhub", count = 0, due = false, history = false) {
  const { plans, planRevisions } = basePlans();
  const subscriptions = Array.from({ length:count }, (_, index) => ({
    subscriptionId:id(10_000 + index), tenantId, subjectId:`subject-${index}`,
    planRevisionId:history && index===0 ? proRevisionId : basicRevisionId,
    state:history ? ["ACTIVE","TRIALING","PAST_DUE"][index] ?? "ACTIVE" : "ACTIVE",
    periodStart:past, periodEnd:due ? past : future, trialEndsAt:history && index===1 ? future : null, cancelAtPeriodEnd:false,
    pendingPlanRevisionId:history && index===0 ? basicRevisionId : null, revocationVersion:1, createdAt:past, terminalAt:null, sequence:1,
  }));
  return { schemaVersion:1, seedVersion, tenants:[{ tenantId, name:"Hidden Tenant" }], plans, planRevisions,
    subscriptions, trialConsumptions:[],
    planChanges:history ? [{ changeId:id(200_000),subscriptionId:id(10_000),fromPlanRevisionId:proRevisionId,toPlanRevisionId:basicRevisionId,
      kind:"DOWNGRADE",state:"SCHEDULED",effectiveAt:future,amountMinor:0,createdAt:past }] : [],
    refunds:history ? [{ refundId:id(200_001),subscriptionId:id(10_000),providerRequestId:"history-refund",amountMinor:500,currency:"USD",state:"UNKNOWN",createdAt:past,resolvedAt:null }] : [],
    providerEvents:history ? [{ providerEventId:"history-provider-event",providerRequestId:"history-refund",kind:"REFUND",outcome:"UNKNOWN",occurredAt:past }] : [],
    entitlementGrants:subscriptions.flatMap((subscription, index) => [
      { grantId:id(100_000 + index),subscriptionId:subscription.subscriptionId,feature:"reports",limit:history&&index===0?10:1,validFrom:past,validUntil:null,grantRevision:1 },
      ...(history&&index===0 ? [{ grantId:id(110_000),subscriptionId:subscription.subscriptionId,feature:"exports",limit:1,validFrom:past,validUntil:null,grantRevision:1 }] : []),
    ]),
    revocationFences:subscriptions.map((subscription) => ({ tenantId, subjectId:subscription.subjectId, version:1, updatedAt:past })), auditEntries:[] };
}

function subscriptionPayload(index, subscriptionKind, planRevisionId = basicRevisionId) {
  return { tenantId, subjectId:`new-subject-${index}`, planRevisionId, startMode:"TRIAL", providerRequestId:`hidden-start-${index}`,
    ...(subscriptionKind ? { subscriptionKind } : {}) };
}

function assertSuccessful(metric, allowed = [200, 201, 202]) {
  const failures = Object.entries(metric.statuses).filter(([status]) => !allowed.includes(Number(status)));
  assert.deepEqual(failures, [], `unexpected load responses: ${JSON.stringify(failures)}`);
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

async function prepareCase(ctx, value) {
  await ctx.prepare();
  assert.equal((await ctx.seed(value)).exitCode, 0);
  return ctx.startApi();
}

let migrationHistory;

async function fixedLoad(ctx, count, concurrency, operation) {
  const latencies = []; const statuses = new Map(); const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length:count }), concurrency, async (_, index) => {
    const started = performance.now(); const response = await operation(index);
    latencies.push(response.durationMs ?? performance.now() - started);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a,b) => a-b);
  const p = (fraction) => latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
  return { completed:count, durationMs, throughput:count/(durationMs/1_000), p50:p(0.5), p95:p(0.95), p99:p(0.99), statuses:Object.fromEntries(statuses) };
}

const spec = {
  label:"EntitlementHub Subscription creation",
  performanceScenarioIds:["entitlement-decision-read","upgrade-refund-race","expiry-revocation-recovery"],
  seed:async () => seed("hidden-entitlementhub",3,false,true), path:"/api/v1/subscriptions", payload:(index) => subscriptionPayload(index),
  conflictPayload:() => ({ ...subscriptionPayload(0), planRevisionId:proRevisionId }),
  resource:"subscriptions", identity:(json) => find(json,"subscriptionId"),
  resourceIdentity:({ subscriptionId }) => subscriptionId, workIdentity:(json) => find(json,"subscriptionId"),
  async afterPrepare(ctx, api, _receiver, workspace) {
    if (workspace===ctx.workspace) return;
    const created=await ctx.mutate(api.baseUrl,"/api/v1/subscriptions","h09-history-subscription",subscriptionPayload(700));
    assert.ok(created.status>=200&&created.status<300,created.text);
    const subscriptionId=find(created.json,"subscriptionId"); const worker=await ctx.startWorker({},workspace);
    const snapshot=await ctx.waitFor(async () => {
      const value=await ctx.snapshot(api.baseUrl);
      return ["TRIALING","ACTIVE"].includes(value.resources.subscriptions.find((entry) => entry.subscriptionId===subscriptionId)?.state) ? value : undefined;
    },{ label:"V1 migration subscription activation",children:[worker] });
    await ctx.stop(worker);
    migrationHistory={ subscriptionId,grantIds:snapshot.resources.entitlementGrants.filter((entry) => entry.subscriptionId===subscriptionId).map(({ grantId }) => grantId),
      eventIds:snapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean),workIds:snapshot.work.map(({ workId }) => workId) };
  },
  async verify(ctx, baseUrl, response) {
    const subscriptionId = find(response.json,"subscriptionId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      return value.resources.subscriptions.some((entry) => entry.subscriptionId === subscriptionId && ["TRIALING","ACTIVE"].includes(entry.state)) ? value : undefined;
    }, { label:"Subscription activation", children:[worker] });
    assert.equal(snapshot.resources.entitlementGrants.filter((entry) => entry.subscriptionId === subscriptionId && entry.feature === "reports").length, 1);
    const enabled = await ctx.request(baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=new-subject-0&feature=reports&knownRevocationVersion=0`);
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(find(enabled.json, "state"), "ENABLED");
    const sequence = snapshot.resources.subscriptions.find((entry) => entry.subscriptionId === subscriptionId).sequence;
    const upgraded = await ctx.mutate(baseUrl, `/api/v1/subscriptions/${subscriptionId}/change-plan`, "h03-upgrade", { toPlanRevisionId:proRevisionId, expectedSequence:sequence });
    assert.ok(upgraded.status >= 200 && upgraded.status < 300, upgraded.text);
    const changed = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      return value.resources.subscriptions.find((entry) => entry.subscriptionId === subscriptionId)?.planRevisionId === proRevisionId ? value : undefined;
    }, { label:"Subscription upgrade", children:[worker] });
    const grants = changed.resources.entitlementGrants.filter((entry) => entry.subscriptionId === subscriptionId && entry.feature === "reports").sort((a,b) => a.grantRevision-b.grantRevision);
    assert.equal(grants.length, 2);
    assert.equal(grants[0].validUntil, grants[1].validFrom);
    assert.ok(changed.resources.planChanges.some((entry) => entry.subscriptionId === subscriptionId && entry.kind === "UPGRADE" && entry.state === "APPLIED"));
  },
  async atomic(ctx, baseUrl) {
    const created = await ctx.mutate(baseUrl, "/api/v1/subscriptions", "h04-subscription", subscriptionPayload(40));
    const subscriptionId = find(created.json,"subscriptionId");
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, `/api/v1/subscriptions/${subscriptionId}/refunds`, "h04-refund", { amountMinor:-1, currency:"USD", providerRequestId:"bad-refund" });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.refunds.length, before.resources.refunds.length);
    assert.equal(after.resources.entitlementGrants.length, before.resources.entitlementGrants.length);
    const unpublished = await ctx.mutate(baseUrl, "/api/v1/subscriptions", "h04-unpublished", { ...subscriptionPayload(41), planRevisionId:id(999_999) });
    assert.ok([404,409].includes(unpublished.status), unpublished.text);
    const duplicate = await ctx.mutate(baseUrl, "/api/v1/subscriptions", "h04-duplicate-trial", { ...subscriptionPayload(40), providerRequestId:"duplicate-trial" });
    assert.equal(duplicate.status, 409, duplicate.text);
    const final = await ctx.snapshot(baseUrl);
    assert.equal(final.resources.refunds.length, before.resources.refunds.length);
    assert.equal(final.resources.subscriptions.filter((entry) => entry.subjectId === subscriptionPayload(40).subjectId).length, 1);
  },
  async contention(ctx, baseUrls) {
    const payload = { ...subscriptionPayload(60), subjectId:"trial-race-subject" };
    const results = await Promise.all(Array.from({ length:32 }, (_, index) => ctx.mutate(baseUrls[index % 2], "/api/v1/subscriptions", `h06-trial-${index}`, payload)));
    assert.equal(results.filter(({ status }) => status >= 200 && status < 300).length, 1);
    assert.equal(results.filter(({ status }) => status === 409).length, 31);
    let snapshot = await ctx.snapshot(baseUrls[0]);
    assert.equal(snapshot.resources.trialConsumptions.filter((entry) => entry.subjectId === "trial-race-subject").length, 1);
    const subscriptionId = snapshot.resources.subscriptions.find((entry) => entry.subjectId === "trial-race-subject").subscriptionId;
    const worker = await ctx.startWorker();
    snapshot = await ctx.waitFor(async () => {
      const value=await ctx.snapshot(baseUrls[0]);
      return ["TRIALING","ACTIVE"].includes(value.resources.subscriptions.find((entry) => entry.subscriptionId===subscriptionId)?.state) ? value : undefined;
    },{ label:"contended trial activation",children:[worker] });
    const sequence=snapshot.resources.subscriptions.find((entry) => entry.subscriptionId===subscriptionId).sequence;
    const lifecycle=await Promise.all(Array.from({ length:32 },(_,index) => index%2
      ? ctx.mutate(baseUrls[index%2],`/api/v1/subscriptions/${subscriptionId}/change-plan`,`h06-change-${index}`,{ toPlanRevisionId:proRevisionId,expectedSequence:sequence })
      : ctx.mutate(baseUrls[index%2],`/api/v1/subscriptions/${subscriptionId}/cancel`,`h06-cancel-${index}`,{ expectedSequence:sequence })));
    assert.equal(lifecycle.filter(({ status }) => status>=200&&status<300).length,1);
    assert.equal(lifecycle.filter(({ status }) => status===409).length,31);
    snapshot=await ctx.snapshot(baseUrls[0]);
    const grants=snapshot.resources.entitlementGrants.filter((entry) => entry.subscriptionId===subscriptionId).sort((a,b) => a.validFrom.localeCompare(b.validFrom));
    for (let index=1;index<grants.length;index+=1) assert.ok(grants[index-1].validUntil&&grants[index-1].validUntil<=grants[index].validFrom);
  },
  async prepareWork(ctx, baseUrl) {
    const created = await ctx.mutate(baseUrl, "/api/v1/subscriptions", "h07-subscription", subscriptionPayload(70));
    assert.ok(created.status >= 200 && created.status < 300, created.text);
    return created;
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const subscriptionId = find(created.json, "subscriptionId");
    assert.ok(snapshot.resources.subscriptions.some((entry) => entry.subscriptionId === subscriptionId));
    assert.ok(snapshot.resources.planRevisions.some((entry) => entry.planRevisionId === basicRevisionId && entry.state === "PUBLISHED"));
    assert.ok(snapshot.resources.subscriptions.some((entry) => entry.subscriptionId === id(10_000) && entry.state === "ACTIVE"));
    assert.ok(snapshot.resources.subscriptions.some((entry) => entry.subscriptionId === id(10_001) && entry.state === "TRIALING"));
    assert.ok(snapshot.resources.subscriptions.some((entry) => entry.subscriptionId === id(10_002) && entry.state === "PAST_DUE"));
    assert.ok(snapshot.resources.planChanges.some((entry) => entry.changeId === id(200_000) && entry.state === "SCHEDULED"));
    assert.ok(snapshot.resources.refunds.some((entry) => entry.refundId === id(200_001) && entry.state === "UNKNOWN"));
    assert.equal(snapshot.resources.entitlementPools.length, 0);
    assert.equal(snapshot.resources.seatAssignments.length, 0);
    assert.ok(migrationHistory);
    assert.ok(snapshot.resources.subscriptions.some((entry) => entry.subscriptionId===migrationHistory.subscriptionId&&["TRIALING","ACTIVE"].includes(entry.state)));
    for (const value of migrationHistory.grantIds) assert.ok(snapshot.resources.entitlementGrants.some((entry) => entry.grantId===value));
    for (const value of migrationHistory.eventIds) assert.ok(snapshot.events.some((entry) => find(entry,"eventId")===value));
    for (const value of migrationHistory.workIds) assert.ok(snapshot.work.some((entry) => entry.workId===value));
    assert.ok(snapshot.events.some((entry) => find(entry, "aggregateId") === subscriptionId));
    assert.ok(snapshot.work.some((entry) => entry.aggregateId === subscriptionId));
    assertUnique(snapshot.events.map((entry) => find(entry, "eventId")).filter(Boolean), "migrated event IDs");
    assertUnique(snapshot.work.map(({ workId }) => workId), "migrated Work IDs");
  },
  manager:{
    path:"/api/v1/entitlement-pools",
    async prepare(ctx, baseUrl) {
      const personal = await ctx.mutate(baseUrl, "/api/v1/subscriptions", "manager-personal-subscription", subscriptionPayload(79));
      assert.ok(personal.status >= 200 && personal.status < 300, personal.text);
      const personalId = find(personal.json,"subscriptionId");
      let worker = await ctx.startWorker();
      await ctx.waitFor(async () => ["ACTIVE","TRIALING"].includes((await ctx.snapshot(baseUrl)).resources.subscriptions.find((entry) => entry.subscriptionId === personalId)?.state), { label:"Personal subscription", children:[worker] });
      const rejected = await ctx.mutate(baseUrl, "/api/v1/entitlement-pools", "manager-personal-pool", { tenantId, subscriptionId:personalId, feature:"reports", seatLimit:10 });
      assert.equal(rejected.status, 409, rejected.text);
      assert.equal(find(rejected.json,"code"), "ORGANIZATION_SUBSCRIPTION_REQUIRED");
      const created = await ctx.mutate(baseUrl, "/api/v1/subscriptions", "manager-subscription", subscriptionPayload(80, "ORGANIZATION", proRevisionId));
      const subscriptionId = find(created.json,"subscriptionId");
      await ctx.waitFor(async () => ["ACTIVE","TRIALING"].includes((await ctx.snapshot(baseUrl)).resources.subscriptions.find((entry) => entry.subscriptionId === subscriptionId)?.state), { label:"Pool source subscription", children:[worker] });
      await ctx.stop(worker);
      return { subscriptionId, payload:() => ({ tenantId, subscriptionId, feature:"reports", seatLimit:10 }) };
    },
    payload:(index) => ({ tenantId, subscriptionId:id(999_999), feature:"reports", seatLimit:10 + index }),
    async verify(ctx, baseUrl, response) {
      const poolId = find(response.json,"poolId");
      let version = find(response.json,"version");
      assert.equal(version, 0);
      for (let index = 0; index < 10; index += 1) {
        const assigned = await ctx.mutate(baseUrl, `/api/v1/entitlement-pools/${poolId}/assignments`, `h10-seat-${index}`, { subjectId:`h10-seat-${index}`, expectedPoolVersion:version });
        assert.ok(assigned.status >= 200 && assigned.status < 300, assigned.text);
        const nextVersion = find(assigned.json,"version");
        assert.equal(nextVersion, version + 1);
        version = nextVersion;
      }
      const full = await ctx.mutate(baseUrl, `/api/v1/entitlement-pools/${poolId}/assignments`, "h10-seat-overflow", { subjectId:"h10-overflow", expectedPoolVersion:version });
      assert.equal(full.status, 409, full.text);
      assert.equal(find(full.json,"code"), "POOL_CAPACITY_EXCEEDED");
      const listed = await ctx.request(baseUrl, `/api/v1/entitlement-pools/${poolId}/assignments`);
      assert.equal(listed.status, 200, listed.text);
      assert.equal(find(listed.json,"items")?.length, 10);
      const access = await ctx.request(baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=h10-seat-0&feature=reports&knownRevocationVersion=0`);
      assert.equal(access.status, 200, access.text);
      assert.equal(find(access.json,"state"), "ENABLED");
      const snapshot = await ctx.snapshot(baseUrl);
      assert.equal(snapshot.resources.entitlementPools.filter((entry) => entry.poolId === poolId && entry.state === "ACTIVE").length, 1);
      assert.equal(snapshot.resources.seatAssignments.filter((entry) => entry.poolId === poolId && entry.state === "ACTIVE").length, 10);
    },
    async concurrentVerify(ctx, baseUrls, response, operation) {
      const poolId = find(response.json,"poolId");
      let version = find(response.json,"version") ?? 0;
      for (let index = 0; index < 9; index += 1) {
        const assigned = await ctx.mutate(baseUrls[index % 2], `/api/v1/entitlement-pools/${poolId}/assignments`, `seat-preload-${index}`, { subjectId:`seat-preload-${index}`, expectedPoolVersion:version });
        assert.ok(assigned.status >= 200 && assigned.status < 300, assigned.text);
        version = find(assigned.json,"version") ?? version + 1;
      }
      const assignments = await Promise.all(Array.from({ length:32 }, (_, index) => ctx.mutate(baseUrls[index % 2], `/api/v1/entitlement-pools/${poolId}/assignments`, `seat-${index}`, { subjectId:`seat-subject-${index}`, expectedPoolVersion:version })));
      assert.equal(assignments.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.equal(assignments.filter(({ status }) => status === 409).length, 31);
      let snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(snapshot.resources.seatAssignments.filter((entry) => entry.poolId === poolId && entry.state === "ACTIVE").length, 10);
      const poolVersion = snapshot.resources.entitlementPools.find((entry) => entry.poolId === poolId).version;
      const subjectId = snapshot.resources.seatAssignments.find((entry) => entry.poolId === poolId && entry.subjectId.startsWith("seat-subject-") && entry.state === "ACTIVE").subjectId;
      const revoked = await ctx.mutate(baseUrls[0], `/api/v1/entitlement-pools/${poolId}/assignments/${subjectId}/revoke`, "h11-seat-revoke", { expectedPoolVersion:poolVersion });
      assert.ok(revoked.status >= 200 && revoked.status < 300, revoked.text);
      snapshot = await ctx.snapshot(baseUrls[0]);
      const pending = snapshot.work.find((entry) => entry.kind === "POOL_REVOKE" && !entry.terminal);
      assert.ok(pending, "seat revocation scheduled no POOL_REVOKE Work");
      let release; const held = new Promise((resolve) => { release=resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pending.aggregateId ? held : { status:204 });
      const killed = await ctx.startWorker({ TEST_BARRIER_URL:barrier.url, TEST_BARRIER_TOKEN:"h11-pool" });
      await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === pending.aggregateId), { label:"Pool revoke claimed", children:[killed] });
      await ctx.stop(killed,"SIGKILL"); release({ status:204 });
      await new Promise((resolve) => setTimeout(resolve,3_200));
      const replacement = await ctx.startWorker();
      const deadline = Date.now()+2_000;
      await ctx.waitFor(async () => {
        const checks = await Promise.all(baseUrls.map((baseUrl) => ctx.request(baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=${subjectId}&feature=reports&knownRevocationVersion=0`)));
        return checks.every((entry) => entry.status === 200 && find(entry.json,"state") === "DISABLED") ? checks : undefined;
      }, { timeoutMs:2_000, label:"cross-process seat revocation", children:[replacement] });
      assert.ok(Date.now() <= deadline + 100);
      snapshot = await ctx.snapshot(baseUrls[0]);
      assert.ok(snapshot.work.some((entry) => entry.workId === pending.workId && entry.terminal));
      const subscription = snapshot.resources.subscriptions.find((entry) => entry.subscriptionId === operation.subscriptionId);
      const cancelled = await ctx.mutate(baseUrls[1], `/api/v1/subscriptions/${operation.subscriptionId}/cancel`, "h11-pool-subscription-cancel", { expectedSequence:subscription.sequence });
      assert.ok(cancelled.status >= 200 && cancelled.status < 300, cancelled.text);
      const cancellationDeadline = Date.now() + 2_000;
      const terminal = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const pool = value.resources.entitlementPools.find((entry) => entry.poolId === poolId);
        const activeSeats = value.resources.seatAssignments.filter((entry) => entry.poolId === poolId && entry.state === "ACTIVE");
        if (pool?.state !== "REVOKED" || activeSeats.length !== 0) return undefined;
        const checks = await Promise.all(baseUrls.map((baseUrl) => ctx.request(baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=seat-preload-0&feature=reports&knownRevocationVersion=0`)));
        return checks.every((entry) => entry.status === 200 && find(entry.json,"state") === "DISABLED") ? value : undefined;
      }, { timeoutMs:2_000, label:"subscription cancellation revokes Pool", children:[replacement] });
      assert.ok(Date.now() <= cancellationDeadline + 100);
      assert.ok(terminal.resources.seatAssignments.filter((entry) => entry.poolId === poolId).every((entry) => entry.state !== "ACTIVE"));
    },
  },
  cases:{ "H-05":entitlementIdempotency, "H-08":entitlementRevocationRecovery },
  performance:entitlementPerformance,
};

async function entitlementIdempotency(ctx, assertions) {
  let api = await prepareCase(ctx, seed("h05-entitlement", 1));
  const path = `/api/v1/subscriptions/${id(10_000)}/refunds`;
  const payload = { amountMinor:1_000, currency:"USD", providerRequestId:"h05-refund" };
  const shield = await ctx.responseShield(api.baseUrl);
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, path, "h05-refund", payload).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label:"committed refund response" });
  await ctx.stop(api); api=await ctx.startApi();
  const replay = await ctx.mutate(api.baseUrl, path, "h05-refund", payload);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(JSON.parse(shield.captures[0].body)));
  const concurrent = await ctx.concurrent(Array.from({ length:20 }), 20, () => ctx.mutate(api.baseUrl, path, "h05-refund", payload));
  assert.equal(new Set(concurrent.map(({ status,json }) => `${status}:${ctx.canonical(json)}`)).size,1);
  const refundId = find(replay.json,"refundId");
  const unknown = await ctx.mutate(api.baseUrl, "/api/v1/provider/events", "h05-provider-unknown", { providerEventId:"h05-provider-unknown", providerRequestId:"h05-refund", kind:"REFUND", outcome:"UNKNOWN", occurredAt:new Date().toISOString() });
  assert.ok(unknown.status >= 200 && unknown.status < 300, unknown.text);
  let snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.resources.refunds.find((entry) => entry.refundId === refundId)?.state,"UNKNOWN");
  const overReserved = await ctx.mutate(api.baseUrl, path, "h05-second-refund", { amountMinor:1, currency:"USD", providerRequestId:"h05-second" });
  assert.equal(overReserved.status,409,overReserved.text);
  const resolved = await ctx.mutate(api.baseUrl, "/api/v1/provider/events", "h05-provider-success", { providerEventId:"h05-provider-success", providerRequestId:"h05-refund", kind:"REFUND", outcome:"SUCCEEDED", occurredAt:new Date().toISOString() });
  assert.ok(resolved.status >= 200 && resolved.status < 300,resolved.text);
  const worker = await ctx.startWorker();
  snapshot = await ctx.waitFor(async () => {
    const value=await ctx.snapshot(api.baseUrl);
    return value.resources.refunds.find((entry) => entry.refundId === refundId)?.state === "SUCCEEDED" ? value : undefined;
  }, { label:"UNKNOWN refund reconciliation", children:[worker] });
  assert.equal(snapshot.resources.refunds.filter((entry) => entry.providerRequestId === "h05-refund").length,1);
  assertUnique(snapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean),"refund event IDs");
  assertions.push("refund unknown outcome, reservation, replay, and reconciliation converge once");
}

async function entitlementRevocationRecovery(ctx, assertions) {
  const apiA = await prepareCase(ctx, seed("h08-entitlement",1));
  const apiB = await ctx.startApi();
  const before = await ctx.request(apiA.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=subject-0&feature=reports&knownRevocationVersion=0`);
  assert.equal(find(before.json,"state"),"ENABLED");
  const cancelled = await ctx.mutate(apiA.baseUrl, `/api/v1/subscriptions/${id(10_000)}/cancel`, "h08-cancel", { expectedSequence:1 });
  assert.ok(cancelled.status >= 200 && cancelled.status < 300,cancelled.text);
  const worker = await ctx.startWorker();
  await ctx.waitFor(async () => {
    const checks=await Promise.all([apiA,apiB].map((api) => ctx.request(api.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=subject-0&feature=reports&knownRevocationVersion=0`)));
    return checks.every((entry) => entry.status === 200 && find(entry.json,"state") === "DISABLED") ? checks : undefined;
  }, { timeoutMs:2_000,label:"revocation convergence",children:[worker] });
  const webhook=await ctx.receiver();
  let release; const held=new Promise((resolve) => { release=resolve; });
  const barrier=await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? held : { status:204 });
  const first=await ctx.startDispatcher(webhook.url,{ TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:"h08-entitlement" });
  await ctx.waitFor(() => barrier.ledger.length>0,{ label:"revocation event response",children:[first] });
  await ctx.stop(first,"SIGKILL"); release({ status:204 });
  const replacement=await ctx.startDispatcher(webhook.url);
  await ctx.waitFor(() => webhook.ledger.length>=2,{ timeoutMs:60_000,label:"revocation event retry",children:[replacement] });
  assert.equal(webhook.ledger[0].raw,webhook.ledger[1].raw);
  const eventHeader=Object.keys(webhook.ledger[0].headers).find((name) => name.endsWith("-event-id"));
  assert.ok(eventHeader); assert.equal(webhook.ledger[0].headers[eventHeader],webhook.ledger[1].headers[eventHeader]);
  assertions.push("revocation converges across APIs and its outbox identity survives unknown ACK");
}

async function entitlementPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  const decisionCount = Math.max(100, Math.ceil(100_000 * scale));
  assert.equal((await ctx.seed(seed("perf-entitlement-read", decisionCount))).exitCode, 0);
  let api = await ctx.startApi(); let requestIndex = 0;
  const decisions = await measuredLoad(ctx, { concurrency:128, warmupMs:10_000*scale, measureMs:60_000*scale,
    request:async () => {
      const index=requestIndex++ % decisionCount; const enabled=index % 5 !== 0;
      const response = await ctx.request(api.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=subject-${index}&feature=${enabled ? "reports" : "exports"}&knownRevocationVersion=${enabled ? 1 : 0}`);
      assert.equal(response.status, 200, response.text);
      assert.equal(find(response.json,"state"), enabled ? "ENABLED" : "DISABLED");
      assert.ok((find(response.json,"revocationVersion") ?? 0) >= 1);
      return response;
    } });
  assert.ok(decisions.throughput >= 1_500 && decisions.p95 <= 100, `entitlement-decision-read ${decisions.throughput}/s p95=${decisions.p95}`);
  assertSuccessful(decisions, [200]);
  assertions.push(`entitlement-decision-read ${decisions.throughput.toFixed(1)}/s p95 ${decisions.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const raceCount = Math.max(100, Math.ceil(20_000*scale));
  assert.equal((await ctx.seed(seed("perf-entitlement-race", raceCount))).exitCode, 0);
  api = await ctx.startApi(); const raceApiB = await ctx.startApi();
  const races = await fixedLoad(ctx, raceCount * 2, 64, (index) => {
    const baseUrl = index % 2 ? api.baseUrl : raceApiB.baseUrl;
    const subscriptionId = id(10_000 + (index % raceCount));
    return index % 3 === 0
      ? ctx.mutate(baseUrl, `/api/v1/subscriptions/${subscriptionId}/refunds`, `race-refund-${index}`, { amountMinor:1_000, currency:"USD", providerRequestId:`race-refund-${index}` })
      : ctx.mutate(baseUrl, `/api/v1/subscriptions/${subscriptionId}/change-plan`, `race-change-${index}`, { toPlanRevisionId:proRevisionId, expectedSequence:1 });
  });
  assert.ok(races.throughput >= 100 && races.p95 <= 750, `upgrade-refund-race ${races.throughput}/s p95=${races.p95}`);
  assertSuccessful(races, [200,201,202,409]);
  assert.ok([200,201,202].reduce((sum,status) => sum+(races.statuses[status] ?? 0),0) > 0);
  let raceSnapshot = await ctx.snapshot(api.baseUrl);
  const unresolved = raceSnapshot.resources.refunds.filter(({ state }) => ["REQUESTED","UNKNOWN"].includes(state));
  await ctx.concurrent(unresolved, 64, (refund, index) => ctx.mutate(api.baseUrl, "/api/v1/provider/events", `race-provider-${index}`, {
    providerEventId:`race-provider-event-${index}`, providerRequestId:refund.providerRequestId,
    kind:"REFUND", outcome:"SUCCEEDED", occurredAt:new Date().toISOString(),
  }));
  const raceWorkers = await Promise.all(Array.from({ length:4 }, () => ctx.startWorker()));
  raceSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs:90_000, label:"Plan change and refund drain", children:raceWorkers });
  const refundTotals = new Map();
  for (const refund of raceSnapshot.resources.refunds.filter(({ state }) => state === "SUCCEEDED")) refundTotals.set(refund.subscriptionId, (refundTotals.get(refund.subscriptionId) ?? 0) + refund.amountMinor);
  assert.ok([...refundTotals.values()].every((amount) => amount <= 1_000));
  for (const subscription of raceSnapshot.resources.subscriptions) {
    const grants = raceSnapshot.resources.entitlementGrants.filter((entry) => entry.subscriptionId === subscription.subscriptionId).sort((a,b) => a.validFrom.localeCompare(b.validFrom));
    for (let index=1; index<grants.length; index+=1) assert.ok(grants[index-1].validUntil && grants[index-1].validUntil <= grants[index].validFrom, `grant overlap ${subscription.subscriptionId}`);
  }
  assertUnique(raceSnapshot.resources.refunds.map(({ refundId }) => refundId), "refund IDs");
  assertUnique(raceSnapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean), "race event IDs");
  assertions.push(`upgrade-refund-race ${races.throughput.toFixed(1)}/s p95 ${races.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const expiryCount = Math.max(100, Math.ceil(50_000*scale));
  assert.equal((await ctx.seed(seed("perf-entitlement-expiry", expiryCount, true))).exitCode, 0);
  api = await ctx.startApi();
  const apiB = await ctx.startApi();
  const scheduled = await ctx.mutate(api.baseUrl, "/api/v1/admin/expire-due", "perf-expire-due", {});
  assert.ok(scheduled.status >= 200 && scheduled.status < 300, scheduled.text);
  let release; const held = new Promise((resolve) => { release=resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status:204 });
  const killed = await Promise.all(Array.from({ length:2 }, () => ctx.startWorker({ TEST_BARRIER_URL:barrier.url, TEST_BARRIER_TOKEN:"entitlementhub-perf" })));
  await ctx.waitFor(() => barrier.ledger.length >= 2, { label:"Two expiry claims", children:killed });
  await Promise.all(killed.map((process) => ctx.stop(process,"SIGKILL"))); release({ status:204 });
  await new Promise((resolve) => setTimeout(resolve,3_200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length:4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.subscriptions.filter(({ state }) => state === "EXPIRED").length === expiryCount && snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs:90_000, label:"Expiry revocation drain", children:replacements });
  const durationMs = Date.now()-startedAt;
  assert.ok(durationMs <= 90_000);
  assert.equal(final.resources.entitlementGrants.filter(({ validUntil }) => validUntil === null).length, 0);
  await ctx.concurrent(Array.from({ length:Math.min(100, expiryCount) }), 32, async (_, index) => {
    const response = await ctx.request(index % 2 ? api.baseUrl : apiB.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&subjectId=subject-${index}&feature=reports&knownRevocationVersion=0`);
    assert.equal(response.status,200,response.text);
    assert.equal(find(response.json,"state"),"DISABLED");
  });
  assertUnique(final.events.map((entry) => find(entry,"eventId")).filter(Boolean), "expiry event IDs");
  assertions.push(`expiry-revocation-recovery ${expiryCount} subscriptions in ${durationMs}ms after two SIGKILLs`);
  return { metrics:[
    { scenarioId:"entitlement-decision-read", ...decisions },
    { scenarioId:"upgrade-refund-race", ...races },
    { scenarioId:"expiry-revocation-recovery", completed:expiryCount, durationMs, killedWorkers:2, replacementWorkers:4 },
  ] };
}

export default standardAdapter(spec);
