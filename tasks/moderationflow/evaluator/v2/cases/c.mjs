import assert from "node:assert/strict";

import { assertReconsiderationConservation, canonical } from "../oracles/index.mjs";
import {
  activatePolicyVersion, appendEvidence, cancelRecall, claimStage, completeCase, createContent, createPolicyVersion,
  createRecall, decideStage, defineCase, expectError, finalEvidence, getRecall, prepare, resource, snapshot, stopAll,
  waitSnapshot, waitStage,
} from "./helpers.mjs";

async function recallFixture(ctx, label, memberCount = 3) {
  const seed = ctx.fixtures.baseSeed(label, { action: "REMOVE" });
  const { api } = await prepare(ctx, { seed });
  const members = [];
  for (let index = 0; index < memberCount; index += 1) {
    members.push(await completeCase(ctx, api, ctx.fixtures.submission(seed, `${label}-${index}`), {
      outcome: "REMOVE", categoryCode: "ABUSE", reviewerId: `${label}-reviewer-${index}`,
    }));
  }
  const replacement = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, ctx.fixtures.policyCategories("ALLOW"));
  const replacementPolicyVersionId = resource(replacement, "policyVersionId");
  await activatePolicyVersion(ctx, api.baseUrl, replacementPolicyVersionId, seed.policyVersions[0].policyVersionId);
  const terminal = members.map(({ moderationCase }) => moderationCase);
  const request = {
    tenantId: seed.tenants[0].tenantId,
    recalledPolicyVersionId: seed.policyVersions[0].policyVersionId,
    replacementPolicyVersionId,
    decidedFrom: new Date(Math.min(...terminal.map(({ decidedAt }) => Date.parse(decidedAt))) - 1_000).toISOString(),
    decidedTo: new Date(Math.max(...terminal.map(({ decidedAt }) => Date.parse(decidedAt))) + 1_000).toISOString(),
  };
  return { api, members, request };
}

const C01 = defineCase("C-01", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("c01");
  const { api } = await prepare(ctx, { seed });
  const replacementApi = await ctx.startApi();
  const created = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, "c01"));
  const caseId = resource(created, "caseId");
  const opener = await ctx.startWorker();
  const stage = await waitStage(ctx, api.baseUrl, ({ caseId: candidate, state }) => candidate === caseId && state === "OPEN", {
    processes: [opener], label: "C01 opened ReviewStage",
  });
  await ctx.stop(opener);
  const firstReviewer = "c01-stale-reviewer";
  await claimStage(ctx, api.baseUrl, stage.stageId, firstReviewer, { leaseSeconds: 1 });
  await ctx.kill(api);
  await ctx.waitFor(async () => {
    const current = (await snapshot(ctx, replacementApi.baseUrl)).resources.reviewStages.find(({ stageId }) => stageId === stage.stageId);
    return current?.leaseExpiresAt && Date.parse(current.leaseExpiresAt) <= Date.now() ? current : false;
  }, { timeoutMs: 5_000, intervalMs: 25, label: "persisted review lease expiry" });
  const replacementReviewer = "c01-replacement-reviewer";
  await claimStage(ctx, replacementApi.baseUrl, stage.stageId, replacementReviewer, { leaseSeconds: 5, key: ctx.key("c01-reclaim") });
  const stale = await decideStage(ctx, replacementApi.baseUrl, stage.stageId, {
    reviewerId: firstReviewer, outcome: "REMOVE", categoryCode: "ABUSE", reason: "stale owner",
  }, { key: ctx.key("c01-stale-decision"), allowFailure: true });
  expectError(ctx, stale, 409, "REVIEW_LEASE_CONFLICT", "expired review owner", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  await decideStage(ctx, replacementApi.baseUrl, stage.stageId, {
    reviewerId: replacementReviewer, outcome: "ALLOW", categoryCode: "SAFE", reason: "replacement owner",
  }, { key: ctx.key("c01-final-decision") });
  const final = await snapshot(ctx, replacementApi.baseUrl);
  const decisions = final.resources.moderationDecisions.filter(({ stageId }) => stageId === stage.stageId);
  ctx.equal(decisions.length, 1, "one fenced terminal Decision", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  ctx.equal(decisions[0].reviewerId, replacementReviewer, "replacement reviewer owns terminal Decision");
  ctx.equal(final.resources.reviewStages.find(({ stageId }) => stageId === stage.stageId).state, "DECIDED", "Stage reaches one terminal state");
  return finalEvidence(ctx, { stageId: stage.stageId, killedApiPid: api.pid, decisionId: decisions[0].decisionId, staleStatus: stale.status });
});

const C02 = defineCase("C-02", async function run(ctx) {
  const fixture = await recallFixture(ctx, "c02", 4);
  const created = await createRecall(ctx, fixture.api.baseUrl, fixture.request);
  const runId = resource(created, "policyRecallRunId");
  const barrier = await ctx.barrier({ hold: ({ processRole, point, aggregateId }) => processRole === "worker" && point === "worker.before-commit" && aggregateId === runId });
  const killed = [];
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const entry = await barrier.waitFor(({ json }) => json?.aggregateId === runId && json?.point === "worker.before-commit" && !killed.some((item) => item.workId === json.workId && item.attempt === json.attempt), {
      processes: [worker], timeoutMs: 60_000,
    });
    killed.push(entry.json);
    await ctx.kill(worker);
  }
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await waitSnapshot(ctx, fixture.api.baseUrl, (value) => value.resources.policyRecallRuns.some(({ policyRecallRunId, state }) => policyRecallRunId === runId && state === "COMPLETED"), {
    processes: replacements, timeoutMs: 120_000, label: "Recall recovery after two owner deaths",
  });
  await stopAll(ctx, replacements);
  const detail = await getRecall(ctx, fixture.api.baseUrl, runId);
  const members = assertReconsiderationConservation(detail.run, detail.reconsiderations, final);
  ctx.equal(members.length, fixture.members.length, "every frozen member recovered exactly once", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  ctx.equal(new Set(members.map(({ caseId }) => caseId)), new Set(fixture.members.map(({ caseId }) => caseId)), "recovery loses no frozen member", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  ctx.ok(killed.every(({ leaseTokenHash }) => /^[a-f0-9]{64}$/u.test(leaseTokenHash)), "killed owners expose only token hashes");
  return finalEvidence(ctx, { runId, killedAttempts: killed.map(({ attempt }) => attempt), recoveredMembers: members.length });
});

const C03 = defineCase("C-03", async function run(ctx) {
  const fixture = await recallFixture(ctx, "c03", 1);
  const created = await createRecall(ctx, fixture.api.baseUrl, fixture.request);
  const runId = resource(created, "policyRecallRunId");
  const barrier = await ctx.barrier({ hold: ({ processRole, point, aggregateId }) => processRole === "worker" && point === "worker.before-commit" && aggregateId === runId });
  const owner = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const entry = await barrier.waitFor(({ json }) => json?.aggregateId === runId && json?.point === "worker.before-commit", { processes: [owner], timeoutMs: 60_000 });
  const cancellation = cancelRecall(ctx, fixture.api.baseUrl, runId, { key: ctx.key("c03-cancel"), allowFailure: true });
  barrier.release(entry);
  await ctx.kill(owner);
  const cancelResponse = await cancellation;
  ctx.ok(cancelResponse.status === 200 || cancelResponse.status === 409, "cancel races through a published terminal response");
  const replacement = await ctx.startWorker();
  const final = await waitSnapshot(ctx, fixture.api.baseUrl, (value) => {
    const run = value.resources.policyRecallRuns.find(({ policyRecallRunId }) => policyRecallRunId === runId);
    return ["COMPLETED", "CANCELLED"].includes(run?.state) ? value : false;
  }, { processes: [replacement], timeoutMs: 60_000, label: "Recall cancel/commit terminal state" });
  const beforeFenceCheck = canonical(final.resources);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const afterFenceCheck = await snapshot(ctx, fixture.api.baseUrl);
  ctx.equal(canonical(afterFenceCheck.resources), beforeFenceCheck, "terminal Recall fences later stale effects", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  await ctx.stop(replacement);
  const detail = await getRecall(ctx, fixture.api.baseUrl, runId);
  ctx.ok(["COMPLETED", "CANCELLED"].includes(detail.run.state), "Recall chooses one legal terminal state", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  assertReconsiderationConservation(detail.run, detail.reconsiderations, afterFenceCheck);
  if (detail.run.state === "COMPLETED") ctx.equal(detail.run.completedCount, 1, "completed winner commits final member");
  else ctx.ok(detail.run.completedCount === 0 || detail.run.completedCount === 1, "cancelled winner preserves only a linearized commit");
  return finalEvidence(ctx, { runId, terminalState: detail.run.state, completedCount: detail.run.completedCount, cancelStatus: cancelResponse.status });
});

function eventIdentity(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.eventId === "string") return value.eventId;
  for (const child of Object.values(value)) { const found = eventIdentity(child); if (found) return found; }
}

function deliveredEvent(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.eventId === "string" && Number.isSafeInteger(value.sequence)) return value;
  for (const child of Object.values(value)) { const found = deliveredEvent(child); if (found) return found; }
}

const C04 = defineCase("C-04", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("c04");
  const { api } = await prepare(ctx, { seed });
  let unknownAckEventId;
  const receiver = await ctx.receiver({
    path: "/events",
    behavior: (entry, ledger) => eventIdentity(entry.json) === unknownAckEventId
      && ledger.filter(({ json }) => eventIdentity(json) === unknownAckEventId).length === 1
      ? { disconnect: true }
      : { status: 204 },
  });
  const created = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, "c04"));
  const contentItemId = resource(created, "contentItemId");
  await appendEvidence(ctx, api.baseUrl, contentItemId, ctx.fixtures.evidence("c04", 1));
  const before = await snapshot(ctx, api.baseUrl);
  const expected = before.events.find(({ aggregateId, type }) => aggregateId === contentItemId && type === "evidence.appended")
    ?? before.events.find(({ type }) => type === "evidence.appended");
  assert.ok(expected, "evidence.appended event exists before dispatch");
  unknownAckEventId = expected.eventId;
  const first = await ctx.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => receiver.ledger.find(({ json }) => eventIdentity(json) === expected.eventId) ?? false, { processes: [first], timeoutMs: 30_000, label: "receiver persisted unknown-ACK event" });
  await ctx.kill(first);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => receiver.ledger.filter(({ json }) => eventIdentity(json) === expected.eventId).some(({ acknowledged }) => acknowledged), { processes: [replacement], timeoutMs: 30_000, label: "dispatcher retry acknowledgement" });
  await ctx.stop(replacement);
  const attempts = receiver.ledger.filter(({ json }) => eventIdentity(json) === expected.eventId);
  ctx.ok(attempts.length >= 2, "unknown ACK retries the same event");
  ctx.equal(new Set(attempts.map(({ json }) => canonical(json))).size, 1, "retry preserves canonical event body", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  ctx.equal(new Set(attempts.map(({ json }) => eventIdentity(json))), new Set([expected.eventId]), "retry preserves event identity", { hardCapIds: ["WORK_RECOVERY_CORRECTNESS"] });
  const final = await snapshot(ctx, api.baseUrl);
  ctx.equal(final.events.filter(({ eventId }) => eventId === expected.eventId).length, 1, "outbox retry creates no duplicate Event");
  const delivered = receiver.ledger.map(({ json }) => deliveredEvent(json)).filter((event) => event?.aggregateId === expected.aggregateId);
  const ordered = delivered.map(({ sequence }) => sequence);
  ctx.equal(ordered, [...ordered].sort((left, right) => left - right), "delivery preserves aggregate sequence through retry");
  return finalEvidence(ctx, { eventId: expected.eventId, deliveryAttempts: attempts.length, acknowledged: attempts.some(({ acknowledged }) => acknowledged) });
});

export const C_CASES = Object.freeze([C01, C02, C03, C04]);
