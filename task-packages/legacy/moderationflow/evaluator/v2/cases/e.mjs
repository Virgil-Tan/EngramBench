import assert from "node:assert/strict";

import { CaseExcluded } from "../lib/execution.mjs";
import { assertAuditChain, canonical, percentile } from "../oracles/index.mjs";
import {
  activatePolicyVersion, claimStage, createAppeal, createContent, createPolicyVersion, defineCase, finalEvidence,
  prepare, resource, snapshot, stopAll, waitSnapshot,
} from "./helpers.mjs";

function withCaps(error, hardCapIds) {
  error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
  return error;
}

function requireV1(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  return ctx.forWorkspace(ctx.v1Workspace);
}

async function installBuild(target) {
  await target.command("npm", ["ci", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
  await target.npm("build", [], { timeoutMs: 600_000 });
  await target.migrate({ timeoutMs: 300_000 });
}

function containsEveryRecord(actual, expected, label) {
  const rows = new Set(actual.map(canonical));
  for (const item of expected) assert.ok(rows.has(canonical(item)), `${label} changed record ${canonical(item)}`);
}

const E01 = defineCase("E-01", async function run(ctx) {
  try {
    const v1 = requireV1(ctx);
    const seed = ctx.fixtures.baseSeed("e01");
    await installBuild(v1);
    const seeded = await v1.seed(seed, { timeoutMs: 300_000 });
    assert.equal(seeded.exitCode, 0, seeded.stderr || seeded.stdout);
    const oldApi = await v1.startApi();
    const savedBody = ctx.fixtures.submission(seed, "e01-saved");
    const savedKey = ctx.key("e01-saved-replay");
    const oldCreate = await ctx.mutate(oldApi.baseUrl, "/api/v1/content-items", savedKey, savedBody);
    assert.ok(oldCreate.status >= 200 && oldCreate.status < 300, oldCreate.text);
    const oldReplay = await ctx.mutate(oldApi.baseUrl, "/api/v1/content-items", savedKey, structuredClone(savedBody));
    assert.equal(oldReplay.status, oldCreate.status);
    assert.equal(canonical(oldReplay.json), canonical(oldCreate.json));
    const pendingBody = ctx.fixtures.submission(seed, "e01-pending");
    const pending = await createContent(ctx, oldApi.baseUrl, pendingBody, { key: ctx.key("e01-pending") });
    const before = await ctx.snapshot(oldApi.baseUrl);
    const pendingCaseId = resource(pending, "caseId");
    assert.ok(before.work.some(({ aggregateId, terminal }) => aggregateId === pendingCaseId && !terminal), "V1 pending Work fixture exists");
    await ctx.stop(oldApi);

    const finalTarget = ctx.forWorkspace(ctx.workspace);
    await installBuild(finalTarget);
    const api = await finalTarget.startApi();
    const after = await ctx.snapshot(api.baseUrl);
    for (const name of [
      "tenants", "policies", "policyVersions", "contentItems", "evidenceVersions", "moderationCases", "reviewStages",
      "moderationDecisions", "appeals", "auditEntries", "auditCheckpoints",
    ]) containsEveryRecord(after.resources[name], before.resources[name], name);
    containsEveryRecord(after.work, before.work, "Work");
    containsEveryRecord(after.events, before.events, "Events");
    assert.equal(after.resources.policyRecallRuns.length, 0, "FINAL migration invents no Recall Run");
    assert.equal(after.resources.reconsiderations.length, 0, "FINAL migration invents no Reconsideration");
    const finalReplay = await ctx.mutate(api.baseUrl, "/api/v1/content-items", savedKey, structuredClone(savedBody));
    assert.equal(finalReplay.status, oldCreate.status, "FINAL replay preserves V1 status");
    assert.equal(canonical(finalReplay.json), canonical(oldCreate.json), "FINAL replay preserves V1 body");
    const recovered = await ctx.startWorker();
    const completedPending = await waitSnapshot(ctx, api.baseUrl, (value) => value.resources.reviewStages.some(({ caseId, level }) => caseId === pendingCaseId && level === "LEVEL_1"), {
      processes: [recovered], timeoutMs: 60_000, label: "V1 pending Work under FINAL",
    });
    await ctx.stop(recovered);
    assert.equal(completedPending.resources.reviewStages.filter(({ caseId, level }) => caseId === pendingCaseId && level === "LEVEL_1").length, 1, "pending V1 Work completes once");
    return finalEvidence(ctx, { savedCaseId: resource(oldCreate.json, "caseId"), pendingCaseId, savedReplayStatus: finalReplay.status });
  } catch (error) {
    if (error instanceof CaseExcluded) throw error;
    throw withCaps(error, ["MIGRATION_COMPATIBILITY"]);
  }
});

async function fixedLoad(ctx, { count, concurrency, operation }) {
  const latencies = [];
  const responses = new Array(count);
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }, (_, index) => index), concurrency, async (index) => {
    const started = performance.now();
    responses[index] = await operation(index);
    latencies.push(performance.now() - started);
  });
  const durationMs = performance.now() - startedAt;
  return {
    count, durationMs, throughput: count / (durationMs / 1_000), p95Ms: percentile(latencies, 0.95), responses,
    unexpected5xx: responses.filter(({ status }) => status >= 500).length,
  };
}

function assertAllSuccessful(ctx, load, label) {
  ctx.equal(load.responses.filter(({ status }) => status >= 200 && status < 300).length, load.count, `${label} successful operation count`);
  ctx.equal(load.unexpected5xx, 0, `${label} unexpected 5xx count`);
}

const E02 = defineCase("E-02", async function run(ctx) {
  const fixture = ctx.fixtures.performance.ingest;
  const seed = ctx.fixtures.baseSeed("e02");
  const { api } = await prepare(ctx, { seed });
  const apis = [api, await ctx.startApi(), await ctx.startApi(), await ctx.startApi()];
  const load = await fixedLoad(ctx, {
    count: fixture.requests, concurrency: fixture.concurrency,
    operation: (index) => ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/content-items", ctx.key(`e02:${index}`), ctx.fixtures.submission(seed, `e02-${index}`)),
  });
  assertAllSuccessful(ctx, load, "moderation-ingest");
  ctx.ok(load.throughput >= fixture.minimumPerSecond, `moderation-ingest throughput ${load.throughput.toFixed(2)}/s >= ${fixture.minimumPerSecond}`);
  ctx.ok(load.p95Ms <= fixture.p95Ms, `moderation-ingest p95 ${load.p95Ms.toFixed(2)}ms <= ${fixture.p95Ms}ms`);
  const final = await snapshot(ctx, api.baseUrl);
  const content = final.resources.contentItems.filter(({ externalContentId }) => externalContentId.startsWith("mf-e02-"));
  const contentIds = new Set(content.map(({ contentItemId }) => contentItemId));
  const cases = final.resources.moderationCases.filter(({ contentItemId }) => contentIds.has(contentItemId));
  ctx.equal(content.length, fixture.requests, "exact measured ContentItem population");
  ctx.equal(cases.length, fixture.requests, "one Case per measured ContentItem", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  ctx.ok(cases.every(({ policyVersionId, evidenceHeadVersion }) => policyVersionId === seed.policyVersions[0].policyVersionId && evidenceHeadVersion === 1), "every Case freezes measured policy and evidence", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const measuredEvidence = final.resources.evidenceVersions.filter(({ contentItemId }) => contentIds.has(contentItemId));
  const evidenceCounts = new Map();
  for (const item of measuredEvidence) {
    ctx.equal(item.version, 1, `initial evidence version ${item.evidenceVersionId}`);
    evidenceCounts.set(item.contentItemId, (evidenceCounts.get(item.contentItemId) ?? 0) + 1);
  }
  ctx.equal(measuredEvidence.length, fixture.requests, "exact measured initial evidence population");
  ctx.ok([...contentIds].every((contentItemId) => evidenceCounts.get(contentItemId) === 1), "every measured ContentItem has exactly one initial EvidenceVersion", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const caseIds = new Set(cases.map(({ caseId }) => caseId));
  ctx.equal(final.work.filter(({ aggregateId, kind }) => caseIds.has(aggregateId) && kind === "CASE_OPEN").length, fixture.requests, "one CASE_OPEN Work per measured Case");
  ctx.equal(final.events.filter(({ aggregateId, type }) => contentIds.has(aggregateId) && type === "content.accepted").length, fixture.requests, "one content.accepted Event per measured ContentItem");
  const replayIndex = Math.floor(fixture.requests / 2);
  const replay = await ctx.mutate(api.baseUrl, "/api/v1/content-items", ctx.key(`e02:${replayIndex}`), ctx.fixtures.submission(seed, `e02-${replayIndex}`));
  ctx.equal(replay.status, load.responses[replayIndex].status, "post-load idempotency status");
  ctx.equal(canonical(replay.json), canonical(load.responses[replayIndex].json), "post-load idempotency body", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
  ctx.equal(final.work.filter(({ state }) => state === "FAILED").length, 0, "load leaves no failed Work");
  return finalEvidence(ctx, { scenarioId: "moderation-ingest", requests: fixture.requests, concurrency: fixture.concurrency, throughput: load.throughput, p95Ms: load.p95Ms });
});

async function prepareContention(ctx, api, apis, seed, count) {
  const created = await ctx.concurrent(Array.from({ length: count }, (_, index) => index), 64, (index) => createContent(ctx, apis[index % apis.length].baseUrl, ctx.fixtures.submission(seed, `e03-${index}`), { key: ctx.key(`e03-create:${index}`) }));
  const caseIds = new Set(created.map((item) => resource(item, "caseId")));
  const workers = [await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker()];
  const opened = await waitSnapshot(ctx, api.baseUrl, (value) => {
    const stages = value.resources.reviewStages.filter(({ caseId, level }) => caseIds.has(caseId) && level === "LEVEL_1");
    return stages.length === count ? value : false;
  }, { processes: workers, timeoutMs: 300_000, label: "contention Stage population" });
  await stopAll(ctx, workers);
  const stagesByCase = new Map(opened.resources.reviewStages.filter(({ caseId, level }) => caseIds.has(caseId) && level === "LEVEL_1").map((item) => [item.caseId, item]));
  return created.map((item, index) => ({
    contentItemId: resource(item, "contentItemId"), caseId: resource(item, "caseId"),
    stage: stagesByCase.get(resource(item, "caseId")), reviewerId: `e03-reviewer-${index}`,
  }));
}

const E03 = defineCase("E-03", async function run(ctx) {
  const fixture = ctx.fixtures.performance.contention;
  const seed = ctx.fixtures.baseSeed("e03");
  const { api } = await prepare(ctx, { seed });
  const apis = [api, await ctx.startApi(), await ctx.startApi(), await ctx.startApi()];
  const rows = await prepareContention(ctx, api, apis, seed, fixture.operations);
  const load = await fixedLoad(ctx, {
    count: fixture.operations, concurrency: fixture.concurrency,
    operation: async (index) => {
      const row = rows[index];
      const one = apis[index % apis.length].baseUrl;
      const two = apis[(index + 1) % apis.length].baseUrl;
      await claimStage(ctx, one, row.stage.stageId, row.reviewerId, { leaseSeconds: 30, key: ctx.key(`e03-claim:${index}`) });
      const appends = await Promise.all([0, 1].map((contender) => ctx.mutate(
        contender ? two : one, `/api/v1/content-items/${row.contentItemId}/evidence-versions`, ctx.key(`e03-append:${index}:${contender}`),
        ctx.fixtures.evidence(`e03-${index}-${contender}`, 1, { createdBy: row.reviewerId }),
      )));
      assert.equal(appends.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.ok(appends.filter(({ status }) => status >= 300).every(({ status, json }) => status === 409 && json?.error?.code === "EVIDENCE_HEAD_CHANGED"));
      const decisions = await Promise.all([
        ctx.mutate(one, `/api/v1/review-stages/${row.stage.stageId}/decisions`, ctx.key(`e03-decide:${index}:allow`), { reviewerId: row.reviewerId, outcome: "ALLOW", categoryCode: "SAFE", reason: "contention allow" }),
        ctx.mutate(two, `/api/v1/review-stages/${row.stage.stageId}/decisions`, ctx.key(`e03-decide:${index}:remove`), { reviewerId: row.reviewerId, outcome: "REMOVE", categoryCode: "ABUSE", reason: "contention remove" }),
      ]);
      assert.equal(decisions.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.ok(decisions.filter(({ status }) => status >= 300).every(({ status, json }) => status === 409 && json?.error?.code === "REVIEW_TERMINAL"));
      const appeals = await Promise.all([0, 1].map((contender) => createAppeal(ctx, contender ? two : one, row.caseId, `contention appeal ${contender}`, { key: ctx.key(`e03-appeal:${index}:${contender}`), allowFailure: true })));
      assert.equal(appeals.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.ok(appeals.filter(({ status }) => status >= 300).every(({ status, json }) => status === 409 && json?.error?.code === "APPEAL_ALREADY_EXISTS"));
      return appeals.find(({ status }) => status >= 200 && status < 300);
    },
  });
  assertAllSuccessful(ctx, load, "evidence-appeal-contention");
  ctx.ok(load.throughput >= fixture.minimumPerSecond, `contention throughput ${load.throughput.toFixed(2)}/s >= ${fixture.minimumPerSecond}`);
  ctx.ok(load.p95Ms <= fixture.p95Ms, `contention p95 ${load.p95Ms.toFixed(2)}ms <= ${fixture.p95Ms}ms`);
  const final = await snapshot(ctx, api.baseUrl);
  const contentIds = new Set(rows.map(({ contentItemId }) => contentItemId));
  const caseIds = new Set(rows.map(({ caseId }) => caseId));
  const stageIds = new Set(rows.map(({ stage }) => stage.stageId));
  const histories = new Map([...contentIds].map((contentItemId) => [contentItemId, []]));
  for (const item of final.resources.evidenceVersions) if (histories.has(item.contentItemId)) histories.get(item.contentItemId).push(item.version);
  ctx.ok([...histories.values()].every((versions) => canonical([...versions].sort((left, right) => left - right)) === "[1,2]"), "every contention evidence history has exactly one winner", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const decisions = final.resources.moderationDecisions.filter(({ stageId }) => stageIds.has(stageId));
  ctx.equal(decisions.length, fixture.operations, "one Decision per contended Stage", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  ctx.equal(new Set(decisions.map(({ stageId }) => stageId)), stageIds, "every contended Stage owns one Decision", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const appeals = final.resources.appeals.filter(({ caseId }) => caseIds.has(caseId));
  ctx.equal(appeals.length, fixture.operations, "one Appeal per contended Case", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  ctx.equal(new Set(appeals.map(({ caseId }) => caseId)), caseIds, "every contended Case owns one Appeal", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  return finalEvidence(ctx, { scenarioId: "evidence-appeal-contention", operations: fixture.operations, concurrency: fixture.concurrency, throughput: load.throughput, p95Ms: load.p95Ms });
});

async function createBoundaryCases(ctx, apis, seed, count, prefix) {
  return ctx.concurrent(Array.from({ length: count }, (_, index) => index), 64, (index) => createContent(ctx, apis[index % apis.length].baseUrl, ctx.fixtures.submission(seed, `${prefix}-${index}`), { key: ctx.key(`${prefix}:${index}`) }));
}

const E04 = defineCase("E-04", async function run(ctx) {
  const fixture = ctx.fixtures.performance.recall;
  const seed = ctx.fixtures.baseSeed("e04");
  const { api } = await prepare(ctx, { seed });
  const apis = [api, await ctx.startApi(), await ctx.startApi(), await ctx.startApi()];
  const old = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, ctx.fixtures.policyCategories("REMOVE"));
  const oldPolicyVersionId = resource(old, "policyVersionId");
  await activatePolicyVersion(ctx, api.baseUrl, oldPolicyVersionId, seed.policyVersions[0].policyVersionId);
  const oldCount = Math.floor(fixture.members * 0.8);
  const beforeActivation = await createBoundaryCases(ctx, apis, seed, oldCount, "e04-before");
  const beforeCaseIds = new Set(beforeActivation.map((item) => resource(item, "caseId")));
  const barrier = await ctx.barrier({ hold: ({ processRole, point, aggregateId }) => processRole === "worker" && point === "worker.claimed" && beforeCaseIds.has(aggregateId) });
  const killed = [
    await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }),
    await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }),
  ];
  const claims = [];
  while (claims.length < fixture.killedWorkers) {
    const entry = await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && beforeCaseIds.has(json?.aggregateId) && !claims.some((item) => item.json.workId === json.workId), { processes: killed, timeoutMs: 60_000 });
    claims.push(entry);
  }
  await Promise.all(killed.map((worker) => ctx.kill(worker)));
  const replacement = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, ctx.fixtures.policyCategories("ALLOW"));
  const newPolicyVersionId = resource(replacement, "policyVersionId");
  await activatePolicyVersion(ctx, api.baseUrl, newPolicyVersionId, oldPolicyVersionId);
  const afterActivation = await createBoundaryCases(ctx, apis, seed, fixture.members - oldCount, "e04-after");
  const afterCaseIds = new Set(afterActivation.map((item) => resource(item, "caseId")));
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_250));
  const startedAt = performance.now();
  const workers = await Promise.all(Array.from({ length: fixture.replacementWorkers }, () => ctx.startWorker()));
  const allCaseIds = new Set([...beforeCaseIds, ...afterCaseIds]);
  const final = await waitSnapshot(ctx, api.baseUrl, (value) => {
    const stages = value.resources.reviewStages.filter(({ caseId, level }) => allCaseIds.has(caseId) && level === "LEVEL_1");
    const work = value.work.filter(({ aggregateId, kind }) => allCaseIds.has(aggregateId) && kind === "CASE_OPEN");
    return stages.length === fixture.members && work.length === fixture.members && work.every(({ terminal }) => terminal) ? value : false;
  }, { processes: workers, timeoutMs: fixture.maximumSeconds * 1_000, label: "policy-boundary recovery drain" });
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  await stopAll(ctx, workers);
  ctx.ok(durationSeconds <= fixture.maximumSeconds, `boundary recovery ${durationSeconds.toFixed(2)}s <= ${fixture.maximumSeconds}s`, { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  const oldCases = final.resources.moderationCases.filter(({ caseId }) => beforeCaseIds.has(caseId));
  const newCases = final.resources.moderationCases.filter(({ caseId }) => afterCaseIds.has(caseId));
  ctx.equal(oldCases.length, oldCount, "all pre-activation Cases retained");
  ctx.ok(oldCases.every(({ policyVersionId, evidenceHeadVersion }) => policyVersionId === oldPolicyVersionId && evidenceHeadVersion === 1), "pre-activation policy boundary frozen", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  ctx.equal(newCases.length, fixture.members - oldCount, "all post-activation Cases retained");
  ctx.ok(newCases.every(({ policyVersionId, evidenceHeadVersion }) => policyVersionId === newPolicyVersionId && evidenceHeadVersion === 1), "post-activation policy boundary frozen", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const stages = final.resources.reviewStages.filter(({ caseId, level }) => allCaseIds.has(caseId) && level === "LEVEL_1");
  ctx.equal(new Set(stages.map(({ caseId }) => caseId)), allCaseIds, "exactly one LEVEL_1 Stage per boundary Case", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  assertAuditChain(final.resources.auditEntries);
  ctx.equal(final.work.filter(({ state }) => state === "FAILED").length, 0, "boundary recovery leaves no failed Work");
  return finalEvidence(ctx, { scenarioId: "policy-boundary-recovery", members: fixture.members, killedWorkers: fixture.killedWorkers, replacementWorkers: fixture.replacementWorkers, durationSeconds });
});

export const E_CASES = Object.freeze([E01, E02, E03, E04]);
