import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const applicationId = id(2);
const environmentId = id(3);
const revisionId = id(4);
const releaseId = id(5);
const timestamp = "2026-01-01T00:00:00.000Z";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function assignmentBucket(targetReleaseId, salt, clientId) {
  const value = `${tenantId}:${applicationId}:${environmentId}:${targetReleaseId}:${salt}:${clientId}`;
  return Number(createHash("sha256").update(value).digest().readBigUInt64BE(0) % 10_000n);
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
  assert.equal((await ctx.seed(value)).exitCode,0);
  return ctx.startApi();
}

let migrationHistory;

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function seed(seedVersion = "hidden-configorbit", environmentCount = 1, pendingInvalidations = 0, clientCount = 0) {
  const applicationCount = Math.ceil(environmentCount / 3);
  const applications = Array.from({ length: applicationCount }, (_, index) => ({
    applicationId: index === 0 ? applicationId : id(700_000 + index), tenantId,
    key: index === 0 ? "gateway" : `service-${index}`, name: index === 0 ? "Gateway" : `Service ${index}`,
  }));
  const environmentKeys = ["production", "staging", "development"];
  const environments = Array.from({ length: environmentCount }, (_, index) => ({
    environmentId: index === 0 ? environmentId : id(1_000 + index), applicationId: applications[Math.floor(index / 3)].applicationId,
    key: environmentKeys[index % 3], generation: 1,
    activeReleaseId: index === 0 ? releaseId : id(10_000 + index), createdAt: timestamp,
  }));
  const configRevisions = environments.map((environment, index) => ({
    revisionId: index === 0 ? revisionId : id(20_000 + index), environmentId: environment.environmentId,
    revision: 1, parentRevisionId: null, state: "PUBLISHED", document: { feature: "stable", region: index },
    documentDigest: digest({ feature: "stable", region: index }), schemaRevision: 1, createdAt: timestamp, publishedAt: timestamp,
  }));
  const releases = environments.map((environment, index) => ({
    releaseId: environment.activeReleaseId, environmentId: environment.environmentId,
    revisionId: configRevisions[index].revisionId, previousReleaseId: null, state: "ACTIVE",
    rolloutBasisPoints: 10_000, audienceSalt: `salt-${index}`, generation: 1,
    createdAt: timestamp, activatedAt: timestamp, terminalAt: null,
  }));
  const invalidations = Array.from({ length: pendingInvalidations }, (_, index) => {
    const environment = environments[index % environments.length];
    return { invalidationId: id(100_000 + index), environmentId: environment.environmentId,
      generation: 1 + Math.floor(index / environments.length), releaseId: environment.activeReleaseId,
      eventId: id(500_000 + index), state: "PENDING", createdAt: timestamp, deliveredAt: null };
  });
  return { schemaVersion:1, seedVersion, tenants:[{ tenantId, name:"Hidden Tenant" }],
    applications, environments,
    configRevisions, releases,
    clientObservations:Array.from({ length:clientCount }, (_, index) => ({ clientId:`client-${index}`,
      environmentId, lastGeneration:1, lastReleaseId:releaseId, lastSeenAt:timestamp })),
    invalidations, auditEntries:[] };
}

function revisionPayload(index, targetEnvironmentId = environmentId, parent = revisionId) {
  return { tenantId, applicationId, environmentId: targetEnvironmentId, parentRevisionId: parent,
    schemaRevision: 1, document: { feature: `candidate-${index}`, limits: { requests: 100 + index } }, authorRef: "hidden-evaluator" };
}

async function fixedLoad(ctx, count, concurrency, operation) {
  const latencies = []; const statuses = new Map(); const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const started = performance.now(); const response = await operation(index);
    latencies.push(response.durationMs ?? performance.now() - started);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  const p = (fraction) => latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
  return { completed:count, durationMs, throughput:count / (durationMs / 1_000), p50:p(0.5), p95:p(0.95), p99:p(0.99), statuses:Object.fromEntries(statuses) };
}

const spec = {
  label: "ConfigOrbit ConfigRevision creation",
  performanceScenarioIds: ["client-fetch-mix", "rollout-rollback-contention", "invalidation-recovery"],
  seed: async () => seed("hidden-configorbit", 3, 0, 1), path: "/api/v1/config-revisions",
  payload: (index) => revisionPayload(index),
  conflictPayload: () => ({ ...revisionPayload(0), document: { feature: "conflict" } }),
  resource: "configRevisions", identity: (json) => find(json, "revisionId"),
  resourceIdentity: ({ revisionId: value }) => value, workIdentity: (json) => find(json, "revisionId"),
  async afterPrepare(ctx, api, _receiver, workspace) {
    if (workspace === ctx.workspace) return;
    const targetEnvironmentId=id(1_001); const parentRevisionId=id(20_001);
    const created=await ctx.mutate(api.baseUrl,"/api/v1/config-revisions","h09-history-revision",revisionPayload(600,targetEnvironmentId,parentRevisionId));
    assert.ok(created.status>=200&&created.status<300,created.text);
    const createdRevisionId=find(created.json,"revisionId");
    const published=await ctx.mutate(api.baseUrl,`/api/v1/config-revisions/${createdRevisionId}/publish`,"h09-history-publish",{ rolloutBasisPoints:5_000,audienceSalt:"h09-history",expectedGeneration:1 });
    assert.ok(published.status>=200&&published.status<300,published.text);
    const snapshot=await ctx.snapshot(api.baseUrl); const nextRelease=snapshot.resources.releases.find((entry) => entry.environmentId===targetEnvironmentId&&entry.generation===2);
    assert.ok(nextRelease);
    migrationHistory={ revisionId:createdRevisionId,releaseId:nextRelease.releaseId,
      eventIds:snapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean),workIds:snapshot.work.map(({ workId }) => workId) };
  },
  async verify(ctx, baseUrl, response) {
    const createdRevisionId = find(response.json, "revisionId");
    const published = await ctx.mutate(baseUrl, `/api/v1/config-revisions/${createdRevisionId}/publish`, "h03-publish", { rolloutBasisPoints: 2_500, audienceSalt: "h03-salt", expectedGeneration: 1 });
    assert.ok(published.status >= 200 && published.status < 300, published.text);
    const snapshot = await ctx.snapshot(baseUrl);
    assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId === environmentId)?.generation, 2);
    const nextRelease = snapshot.resources.releases.find((entry) => entry.environmentId === environmentId && entry.generation === 2);
    assert.ok(nextRelease);
    assert.equal(snapshot.resources.configRevisions.find((entry) => entry.revisionId === createdRevisionId)?.documentDigest, digest(revisionPayload(0).document));
    for (let index = 0; index < 32; index += 1) {
      const clientId = `h03-client-${index}`;
      const resolved = await ctx.request(baseUrl, `/api/v1/client-config?tenantId=${tenantId}&applicationKey=gateway&environmentKey=production&clientId=${clientId}&knownGeneration=0`);
      assert.equal(resolved.status, 200, resolved.text);
      const expectedReleaseId = assignmentBucket(nextRelease.releaseId, "h03-salt", clientId) < 2_500 ? nextRelease.releaseId : releaseId;
      assert.equal(find(resolved.json, "releaseId"), expectedReleaseId);
      assert.equal(find(resolved.json, "generation"), 2);
      assert.equal(typeof find(resolved.json, "etag"), "string");
    }
    assert.ok(snapshot.events.some((entry) => find(entry, "aggregateId") === createdRevisionId || find(entry, "releaseId") === nextRelease.releaseId));
    assert.ok(snapshot.work.some((entry) => [createdRevisionId, nextRelease.releaseId, environmentId].includes(entry.aggregateId)));
    assert.ok(snapshot.resources.auditEntries.length > 0);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, `/api/v1/environments/${environmentId}/rollout`, "h04-invalid", { rolloutBasisPoints: 10_001, expectedGeneration: 1 });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.releases.length, before.resources.releases.length);
    assert.equal(after.resources.invalidations.length, before.resources.invalidations.length);
    const secret = await ctx.mutate(baseUrl, "/api/v1/config-revisions", "h04-secret", { ...revisionPayload(40, environmentId, revisionId), document:{ nested:{ token:"must-reject" } } });
    assert.equal(secret.status, 400, secret.text);
    const stale = await ctx.mutate(baseUrl, "/api/v1/config-revisions", "h04-stale-parent", revisionPayload(41, environmentId, id(999_999)));
    assert.equal(stale.status, 409, stale.text);
    const final = await ctx.snapshot(baseUrl);
    assert.equal(final.resources.releases.length, before.resources.releases.length);
    assert.equal(final.resources.invalidations.length, before.resources.invalidations.length);
  },
  async contention(ctx, baseUrls) {
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) => ctx.mutate(
      baseUrls[index % 2], `/api/v1/environments/${environmentId}/rollout`, `h06-rollout-${index}`,
      { rolloutBasisPoints: 5_000, expectedGeneration: 1 },
    )));
    assert.equal(results.filter(({ status }) => status >= 200 && status < 300).length, 1);
    assert.equal(results.filter(({ status }) => status === 409).length, 31);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId === environmentId)?.generation, 2);
    assert.equal(snapshot.resources.releases.filter((entry) => entry.environmentId === environmentId && entry.generation === 2).length, 1);
    const restarted=await ctx.startApi();
    await ctx.concurrent(Array.from({ length:64 }),32,async (_,index) => {
      const path=`/api/v1/client-config?tenantId=${tenantId}&applicationKey=gateway&environmentKey=production&clientId=h06-client-${index}&knownGeneration=0`;
      const [one,two]=await Promise.all([ctx.request(baseUrls[index%2],path),ctx.request(restarted.baseUrl,path)]);
      assert.equal(one.status,200,one.text); assert.equal(two.status,200,two.text);
      assert.equal(ctx.canonical(one.json),ctx.canonical(two.json));
      assert.equal(find(one.json,"generation"),2);
    });
  },
  async prepareWork(ctx, baseUrl) {
    const created = await ctx.mutate(baseUrl, "/api/v1/config-revisions", "h07-revision", revisionPayload(70));
    assert.ok(created.status >= 200 && created.status < 300, created.text);
    const createdRevisionId = find(created.json, "revisionId");
    const published = await ctx.mutate(baseUrl, `/api/v1/config-revisions/${createdRevisionId}/publish`, "h07-publish", { rolloutBasisPoints:10_000, audienceSalt:"h07", expectedGeneration:1 });
    assert.ok(published.status >= 200 && published.status < 300, published.text);
    const snapshot = await ctx.snapshot(baseUrl);
    const pending = snapshot.work.find((entry) => !entry.terminal && ["RELEASE_ACTIVATE","CACHE_INVALIDATE"].includes(entry.kind));
    assert.ok(pending, "publish scheduled no immediately claimable release/invalidation Work");
    return { json:{ revisionId:pending.aggregateId } };
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const createdRevisionId = find(created.json, "revisionId");
    for (const value of [revisionId, createdRevisionId]) assert.ok(snapshot.resources.configRevisions.some((entry) => entry.revisionId === value));
    assert.ok(snapshot.resources.releases.some((entry) => entry.releaseId === releaseId && entry.generation === 1));
    assert.ok(snapshot.resources.clientObservations.some((entry) => entry.clientId === "client-0" && entry.lastGeneration === 1));
    assert.equal(snapshot.resources.promotionTrains.length, 0);
    assert.equal(snapshot.resources.promotionStages.length, 0);
    assert.ok(migrationHistory);
    assert.ok(snapshot.resources.configRevisions.some((entry) => entry.revisionId===migrationHistory.revisionId));
    assert.ok(snapshot.resources.releases.some((entry) => entry.releaseId===migrationHistory.releaseId));
    for (const value of migrationHistory.eventIds) assert.ok(snapshot.events.some((entry) => find(entry,"eventId")===value));
    for (const value of migrationHistory.workIds) assert.ok(snapshot.work.some((entry) => entry.workId===value));
    assert.ok(snapshot.events.some((entry) => find(entry, "aggregateId") === createdRevisionId));
    assert.ok(snapshot.work.some((entry) => entry.aggregateId === createdRevisionId));
    assertUnique(snapshot.events.map((entry) => find(entry, "eventId")).filter(Boolean), "migrated event IDs");
    assertUnique(snapshot.work.map(({ workId }) => workId), "migrated Work IDs");
  },
  manager: {
    path: "/api/v1/promotion-trains",
    payload: (index) => ({ tenantId, applicationId, name:`hidden-train-${index}`, revisionId,
      stages:[
        { environmentId:id(1_002), rolloutBasisPoints:10_000 },
        { environmentId:id(1_001), rolloutBasisPoints:5_000 },
        { environmentId, rolloutBasisPoints:2_500 },
      ] }),
    async verify(ctx, baseUrl, response) {
      const trainId = find(response.json, "trainId");
      let snapshot = await ctx.snapshot(baseUrl);
      const initialReleaseCount = snapshot.resources.releases.length;
      const initialInvalidationCount = snapshot.resources.invalidations.length;
      const initialAuditCount = snapshot.resources.auditEntries.length;
      const initialEventCount = snapshot.events.length;
      assert.equal(snapshot.resources.promotionTrains.filter((entry) => entry.trainId === trainId && entry.state === "DRAFT").length, 1);
      assert.equal(snapshot.resources.promotionStages.filter((entry) => entry.trainId === trainId).length, 3);
      const frozenStages = ctx.canonical(snapshot.resources.promotionStages.filter((entry) => entry.trainId === trainId).map(({ position, environmentId:target, rolloutBasisPoints }) => ({ position, environmentId:target, rolloutBasisPoints })));
      const started = await ctx.mutate(baseUrl, `/api/v1/promotion-trains/${trainId}/start`, "h10-train-start", {});
      assert.ok(started.status >= 200 && started.status < 300, started.text);
      const worker = await ctx.startWorker();
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const train = value.resources.promotionTrains.find((entry) => entry.trainId === trainId);
        const stage = value.resources.promotionStages.find((entry) => entry.trainId === trainId && entry.position === 0);
        return train?.state === "RUNNING" && stage?.state === "ACTIVE" ? value : undefined;
      }, { label:"PromotionTrain start", children:[worker] });
      const developmentGeneration = snapshot.resources.environments.find((entry) => entry.environmentId === id(1_002)).generation;
      assert.equal(developmentGeneration, 2);
      assert.ok(snapshot.resources.releases.some((entry) => entry.environmentId === id(1_002) && entry.generation === developmentGeneration));
      assert.ok(snapshot.resources.invalidations.some((entry) => entry.environmentId === id(1_002) && entry.generation === developmentGeneration));
      const advanced = await ctx.mutate(baseUrl, `/api/v1/promotion-trains/${trainId}/advance`, "h10-train-advance", { expectedStage:0, expectedEnvironmentGeneration:developmentGeneration });
      assert.ok(advanced.status >= 200 && advanced.status < 300, advanced.text);
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const stages = value.resources.promotionStages.filter((entry) => entry.trainId === trainId);
        return stages.some((entry) => entry.position === 0 && entry.state === "PROMOTED") && stages.some((entry) => entry.position === 1 && entry.state === "ACTIVE") ? value : undefined;
      }, { label:"PromotionTrain advance", children:[worker] });
      const stagingGeneration = snapshot.resources.environments.find((entry) => entry.environmentId === id(1_001)).generation;
      assert.equal(stagingGeneration, 2);
      assert.ok(snapshot.resources.releases.some((entry) => entry.environmentId === id(1_001) && entry.generation === stagingGeneration));
      assert.ok(snapshot.resources.invalidations.some((entry) => entry.environmentId === id(1_001) && entry.generation === stagingGeneration));
      const rolledBack = await ctx.mutate(baseUrl, `/api/v1/promotion-trains/${trainId}/rollback`, "h10-train-rollback", { expectedStage:1, expectedEnvironmentGeneration:stagingGeneration });
      assert.ok(rolledBack.status >= 200 && rolledBack.status < 300, rolledBack.text);
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.promotionStages.some((entry) => entry.trainId === trainId && entry.position === 1 && entry.state === "ROLLED_BACK") ? value : undefined;
      }, { label:"PromotionTrain rollback", children:[worker] });
      assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId === environmentId).generation, 1);
      assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId === id(1_002)).generation, developmentGeneration);
      assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId === id(1_001)).generation, stagingGeneration + 1);
      assert.ok(snapshot.resources.releases.some((entry) => entry.environmentId === id(1_001) && entry.generation === stagingGeneration + 1));
      assert.equal(ctx.canonical(snapshot.resources.promotionStages.filter((entry) => entry.trainId === trainId).map(({ position, environmentId:target, rolloutBasisPoints }) => ({ position, environmentId:target, rolloutBasisPoints }))), frozenStages);
      assert.ok(snapshot.resources.releases.length >= initialReleaseCount + 3);
      assert.ok(snapshot.resources.invalidations.length >= initialInvalidationCount + 3);
      assert.ok(snapshot.resources.auditEntries.length >= initialAuditCount + 3);
      assert.ok(snapshot.events.length >= initialEventCount + 3);
      assertUnique(snapshot.resources.releases.map(({ releaseId:value }) => value), "PromotionTrain release IDs");
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const trainId = find(response.json, "trainId");
      const shield = await ctx.responseShield(baseUrls[0]);
      shield.dropNextMutation();
      await ctx.mutate(shield.baseUrl, `/api/v1/promotion-trains/${trainId}/start`, "h11-train-start", {}).catch(() => undefined);
      await ctx.waitFor(() => shield.captures.length === 1, { label:"committed PromotionTrain start response" });
      const started = await ctx.mutate(baseUrls[1], `/api/v1/promotion-trains/${trainId}/start`, "h11-train-start", {});
      assert.ok(started.status >= 200 && started.status < 300, started.text);
      assert.equal(ctx.canonical(started.json), ctx.canonical(JSON.parse(shield.captures[0].body)));
      let worker = await ctx.startWorker();
      let snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        return value.resources.promotionStages.some((entry) => entry.trainId === trainId && entry.position === 0 && entry.state === "ACTIVE") ? value : undefined;
      }, { label:"contended Train start", children:[worker] });
      await ctx.stop(worker);
      const generation = snapshot.resources.environments.find((entry) => entry.environmentId === id(1_002)).generation;
      const results = await Promise.all(Array.from({ length:32 }, (_, index) => ctx.mutate(
        baseUrls[index % 2], `/api/v1/promotion-trains/${trainId}/${index % 2 ? "advance" : "rollback"}`, `h11-train-transition-${index}`,
        { expectedStage:0, expectedEnvironmentGeneration:generation },
      )));
      assert.equal(results.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.equal(results.filter(({ status }) => status === 409).length, 31);
      snapshot = await ctx.snapshot(baseUrls[0]);
      const pending = snapshot.work.find((entry) => !entry.terminal && ["PROMOTION_ADVANCE","PROMOTION_ROLLBACK"].includes(entry.kind));
      assert.ok(pending, "winning Train transition scheduled no recoverable Work");
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pending.aggregateId ? held : { status:204 });
      const killed = await ctx.startWorker({ TEST_BARRIER_URL:barrier.url, TEST_BARRIER_TOKEN:"h11-train" });
      await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === pending.aggregateId), { label:"Train transition claimed", children:[killed] });
      await ctx.stop(killed, "SIGKILL"); release({ status:204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      worker = await ctx.startWorker();
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        return value.work.some((entry) => entry.workId === pending.workId && entry.terminal) ? value : undefined;
      }, { timeoutMs:60_000, label:"Train transition recovery", children:[worker] });
      assert.equal(snapshot.resources.promotionTrains.filter((entry) => entry.trainId === trainId).length, 1);
      const stages = snapshot.resources.promotionStages.filter((entry) => entry.trainId === trainId);
      assert.equal(stages.filter((entry) => entry.position === 0 && ["PROMOTED","ROLLED_BACK"].includes(entry.state)).length, 1);
      assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId === id(1_001)).generation, 1);
      assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId === environmentId).generation, 1);
    },
  },
  cases:{ "H-05":configIdempotency, "H-08":configInvalidationRecovery },
  performance: configPerformance,
};

async function configIdempotency(ctx, assertions) {
  let api=await prepareCase(ctx,seed("h05-configorbit",3));
  const created=await ctx.mutate(api.baseUrl,"/api/v1/config-revisions","h05-revision",revisionPayload(50));
  assert.ok(created.status>=200&&created.status<300,created.text);
  const createdRevisionId=find(created.json,"revisionId");
  const path=`/api/v1/config-revisions/${createdRevisionId}/publish`;
  const payload={ rolloutBasisPoints:5_000,audienceSalt:"h05",expectedGeneration:1 };
  const shield=await ctx.responseShield(api.baseUrl); shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl,path,"h05-publish",payload).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length===1,{ label:"committed publish response" });
  await ctx.stop(api); api=await ctx.startApi();
  const replay=await ctx.mutate(api.baseUrl,path,"h05-publish",payload);
  assert.equal(ctx.canonical(replay.json),ctx.canonical(JSON.parse(shield.captures[0].body)));
  const concurrent=await ctx.concurrent(Array.from({ length:20 }),20,() => ctx.mutate(api.baseUrl,path,"h05-publish",payload));
  assert.equal(new Set(concurrent.map(({ status,json }) => `${status}:${ctx.canonical(json)}`)).size,1);
  const conflict=await ctx.mutate(api.baseUrl,path,"h05-publish",{ ...payload,rolloutBasisPoints:7_500 });
  assert.equal(conflict.status,409,conflict.text);
  const snapshot=await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.resources.environments.find((entry) => entry.environmentId===environmentId).generation,2);
  assert.equal(snapshot.resources.releases.filter((entry) => entry.environmentId===environmentId&&entry.generation===2).length,1);
  assertUnique(snapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean),"publish event IDs");
  assertions.push("publish unknown response, 20-way replay, restart, and conflict preserve one generation");
}

async function configInvalidationRecovery(ctx, assertions) {
  const apiA=await prepareCase(ctx,seed("h08-configorbit",3)); const apiB=await ctx.startApi();
  const query=`tenantId=${tenantId}&applicationKey=gateway&environmentKey=production&clientId=h08-client`;
  const before=await ctx.request(apiA.baseUrl,`/api/v1/client-config?${query}&knownGeneration=0`);
  assert.equal(before.status,200,before.text); const oldEtag=find(before.json,"etag");
  const created=await ctx.mutate(apiA.baseUrl,"/api/v1/config-revisions","h08-revision",revisionPayload(80));
  const createdRevisionId=find(created.json,"revisionId");
  const published=await ctx.mutate(apiA.baseUrl,`/api/v1/config-revisions/${createdRevisionId}/publish`,"h08-publish",{ rolloutBasisPoints:10_000,audienceSalt:"h08",expectedGeneration:1 });
  assert.ok(published.status>=200&&published.status<300,published.text);
  const worker=await ctx.startWorker();
  await ctx.waitFor(async () => {
    const responses=await Promise.all([apiA,apiB].map((api) => ctx.request(api.baseUrl,`/api/v1/client-config?${query}&knownGeneration=1`,{ headers:{ "if-none-match":oldEtag } })));
    return responses.every((entry) => entry.status===200&&find(entry.json,"generation")===2&&find(entry.json,"revisionId")===createdRevisionId) ? responses : undefined;
  },{ timeoutMs:5_000,label:"cross-process configuration convergence",children:[worker] });
  const webhook=await ctx.receiver(); let release; const held=new Promise((resolve) => { release=resolve; });
  const barrier=await ctx.receiver((entry) => entry.json?.point==="dispatcher.response-received" ? held : { status:204 });
  const first=await ctx.startDispatcher(webhook.url,{ TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:"h08-config" });
  await ctx.waitFor(() => barrier.ledger.length>0,{ label:"config event response",children:[first] });
  await ctx.stop(first,"SIGKILL"); release({ status:204 });
  const replacement=await ctx.startDispatcher(webhook.url);
  await ctx.waitFor(() => webhook.ledger.length>=2,{ timeoutMs:60_000,label:"config event retry",children:[replacement] });
  assert.equal(webhook.ledger[0].raw,webhook.ledger[1].raw);
  const eventHeader=Object.keys(webhook.ledger[0].headers).find((name) => name.endsWith("-event-id"));
  assert.ok(eventHeader); assert.equal(webhook.ledger[0].headers[eventHeader],webhook.ledger[1].headers[eventHeader]);
  assertions.push("stale ETag cannot hide a new generation and outbox retry preserves identity");
}

async function configPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-configorbit-fetch", 1, 0, Math.max(100, Math.ceil(50_000 * scale))))).exitCode, 0);
  let api = await ctx.startApi();
  const probe = await ctx.request(api.baseUrl, `/api/v1/client-config?tenantId=${tenantId}&applicationKey=gateway&environmentKey=production&clientId=probe&knownGeneration=0`);
  assert.equal(probe.status, 200, probe.text);
  const currentEtag = find(probe.json, "etag");
  assert.equal(typeof currentEtag, "string");
  let requestIndex = 0;
  const fetchMetric = await measuredLoad(ctx, { concurrency:128, warmupMs:10_000 * scale, measureMs:60_000 * scale,
    request: async () => {
      const index = requestIndex++ % 50_000;
      const current = index % 5 !== 0;
      const response = await ctx.request(api.baseUrl, `/api/v1/client-config?tenantId=${tenantId}&applicationKey=gateway&environmentKey=production&clientId=client-${index}&knownGeneration=${current ? 1 : 0}`, {
        headers: current ? { "if-none-match": currentEtag } : {},
      });
      assert.equal(response.status, current ? 304 : 200, response.text);
      if (!current) assert.equal(find(response.json, "generation"), 1);
      return response;
    } });
  assert.ok(fetchMetric.throughput >= 800 && fetchMetric.p95 <= 150, `client-fetch-mix ${fetchMetric.throughput}/s p95=${fetchMetric.p95}`);
  assert.equal(Object.entries(fetchMetric.statuses).filter(([status]) => !["200","304"].includes(status)).reduce((sum, [, count]) => sum + count, 0), 0);
  assertions.push(`client-fetch-mix ${fetchMetric.throughput.toFixed(1)}/s p95 ${fetchMetric.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(seed("perf-configorbit-rollout", 100))).exitCode, 0);
  api = await ctx.startApi(); const apiB = await ctx.startApi();
  const mutationCount = Math.max(100, Math.ceil(10_000 * scale));
  const mutationMetric = await fixedLoad(ctx, mutationCount, 64, (index) => {
    const target = index % 100 === 0 ? environmentId : id(1_000 + (index % 100));
    return ctx.mutate(index % 2 ? api.baseUrl : apiB.baseUrl, `/api/v1/environments/${target}/rollout`, `perf-rollout-${index}`,
      { rolloutBasisPoints: index % 2 ? 2_500 : 7_500, expectedGeneration: 1 });
  });
  assert.ok(mutationMetric.throughput >= 100 && mutationMetric.p95 <= 500, `rollout-rollback-contention ${mutationMetric.throughput}/s p95=${mutationMetric.p95}`);
  assertSuccessful(mutationMetric, [200, 201, 202, 409]);
  assert.equal([200,201,202].reduce((sum, status) => sum + (mutationMetric.statuses[status] ?? 0), 0), 100);
  const mutationSnapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(mutationSnapshot.resources.environments.filter(({ generation }) => generation === 2).length, 100);
  assert.equal(mutationSnapshot.resources.releases.filter(({ generation }) => generation === 2).length, 100);
  assertUnique(mutationSnapshot.resources.releases.map(({ releaseId:value }) => value), "rollout release IDs");
  assertUnique(mutationSnapshot.events.map((entry) => find(entry, "eventId")).filter(Boolean), "rollout event IDs");
  assertions.push(`rollout-rollback-contention ${mutationMetric.throughput.toFixed(1)}/s p95 ${mutationMetric.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const invalidationCount = Math.max(100, Math.ceil(100_000 * scale));
  assert.equal((await ctx.seed(seed("perf-configorbit-invalidation", 100, invalidationCount))).exitCode, 0);
  api = await ctx.startApi();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status:204 });
  const killed = await Promise.all(Array.from({ length:2 }, () => ctx.startWorker({ TEST_BARRIER_URL:barrier.url, TEST_BARRIER_TOKEN:"configorbit-perf" })));
  await ctx.waitFor(() => barrier.ledger.length >= 2, { label:"Two invalidation claims", children:killed });
  await Promise.all(killed.map((process) => ctx.stop(process, "SIGKILL"))); release({ status:204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length:4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.invalidations.filter(({ state }) => state === "DELIVERED").length === invalidationCount && snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs:90_000, label:"Invalidation recovery drain", children:replacements });
  const durationMs = Date.now() - startedAt;
  assert.ok(durationMs <= 90_000);
  assert.equal(new Set(final.resources.invalidations.map(({ invalidationId }) => invalidationId)).size, invalidationCount);
  assert.ok(final.resources.environments.every(({ generation }) => generation >= 1));
  assertUnique(final.events.map((entry) => find(entry, "eventId")).filter(Boolean), "invalidation event IDs");
  assertions.push(`invalidation-recovery ${invalidationCount} messages in ${durationMs}ms after two SIGKILLs`);
  return { metrics:[
    { scenarioId:"client-fetch-mix", ...fetchMetric },
    { scenarioId:"rollout-rollback-contention", ...mutationMetric },
    { scenarioId:"invalidation-recovery", completed:invalidationCount, durationMs, killedWorkers:2, replacementWorkers:4 },
  ] };
}

export default standardAdapter(spec);
