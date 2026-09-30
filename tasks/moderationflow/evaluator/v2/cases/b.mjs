import assert from "node:assert/strict";
import { assertEvidenceHistory, assertReconsiderationConservation, canonical } from "../oracles/index.mjs";
import {
  activatePolicyVersion, appendEvidence, claimStage, completeCase, createAppeal, createContent, createPolicyVersion,
  createRecall, decideStage, defineCase, expectError, finalEvidence, getRecall, prepare, resource, snapshot, stopAll,
  waitSnapshot, waitStage,
} from "./helpers.mjs";

const B01 = defineCase("B-01", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("b01"); const { api } = await prepare(ctx, { seed }); const api2 = await ctx.startApi(); const created = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, "b01")); const contentItemId = resource(created, "contentItemId"); const sameKey = ctx.key("b01-same"); const sameBody = ctx.fixtures.evidence("b01-same", 1);
  const same = await Promise.all(Array.from({ length: 20 }, (_, index) => appendEvidence(ctx, index % 2 ? api.baseUrl : api2.baseUrl, contentItemId, structuredClone(sameBody), { key: sameKey, allowFailure: true })));
  ctx.ok(same.every(({ status }) => status >= 200 && status < 300), "same-key concurrent evidence replays succeed", { hardCapIds: ["DURABLE_IDEMPOTENCY"] }); ctx.equal(new Set(same.map(({ text }) => text)).size, 1, "same-key response is stable", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
  const labels = Array.from({ length: 10 }, (_, index) => `b01-distinct-${index}`);
  await ctx.concurrent(labels, 10, async (label, index) => {
    for (;;) {
      const state = await snapshot(ctx, api.baseUrl); const history = assertEvidenceHistory(state.resources.evidenceVersions, contentItemId); const body = ctx.fixtures.evidence(label, history.length); const response = await appendEvidence(ctx, index % 2 ? api.baseUrl : api2.baseUrl, contentItemId, body, { key: ctx.key(label), allowFailure: true });
      if (response.status >= 200 && response.status < 300) return response;
      expectError(ctx, response, 409, "EVIDENCE_HEAD_CHANGED", `${label} contention`);
    }
  });
  const state = await snapshot(ctx, api.baseUrl); const history = assertEvidenceHistory(state.resources.evidenceVersions, contentItemId); ctx.equal(history.length, 12, "initial plus replay plus ten distinct versions"); ctx.equal(new Set(history.map(({ version }) => version)).size, 12, "one authority per version", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  return finalEvidence(ctx, { contentItemId, versions: history.length, sameKeyReplays: same.length });
});

async function decisionEvidenceRace(ctx, label, evidenceFirst) {
  await ctx.resetDatabase(); const seed = ctx.fixtures.baseSeed(label); const { api } = await prepare(ctx, { seed }); const api2 = await ctx.startApi(); const created = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, label)); const caseId = resource(created, "caseId"); const contentItemId = resource(created, "contentItemId"); const worker = await ctx.startWorker();
  const stage = await ctx.waitFor(async () => (await snapshot(ctx, api.baseUrl)).resources.reviewStages.find(({ caseId: candidate, state }) => candidate === caseId && state === "OPEN") ?? false, { processes: [worker], timeoutMs: 60_000, label: `${label} stage` }); await ctx.stop(worker);
  const reviewerId = `reviewer-${label}`; const claim = await ctx.mutate(api.baseUrl, `/api/v1/review-stages/${stage.stageId}/claim`, ctx.key(`${label}:claim`), { reviewerId, leaseSeconds: 5 }); assert.ok(claim.status >= 200 && claim.status < 300, claim.text);
  const append = () => appendEvidence(ctx, api2.baseUrl, contentItemId, ctx.fixtures.evidence(`${label}:late`, 1), { key: ctx.key(`${label}:append`), allowFailure: true });
  const decide = () => ctx.mutate(api.baseUrl, `/api/v1/review-stages/${stage.stageId}/decisions`, ctx.key(`${label}:decision`), { reviewerId, outcome: "ALLOW", categoryCode: "SAFE", reason: label });
  let appended; let decided;
  if (evidenceFirst) { appended = await append(); decided = await decide(); }
  else { [decided, appended] = await Promise.all([decide(), append()]); }
  assert.ok(decided.status >= 200 && decided.status < 300, decided.text);
  if (evidenceFirst || appended.status < 300) assert.ok(appended.status >= 200 && appended.status < 300, appended.text);
  else ctx.ok((appended.status === 409 && appended.json?.error?.code === "REVIEW_TERMINAL") || (appended.status === 400 && appended.json?.error?.code === "EVIDENCE_INVALID"), `${label} append serialized after terminal Decision with a published stable error`);
  const state = await snapshot(ctx, api.baseUrl); const decision = state.resources.moderationDecisions.find(({ stageId }) => stageId === stage.stageId); ctx.equal(decision.evidenceHeadVersion, stage.evidenceHeadVersion ?? 1, `${label} Decision uses Stage evidence authority`, { hardCapIds: ["DOMAIN_CORRECTNESS"] }); const historyLength = assertEvidenceHistory(state.resources.evidenceVersions, contentItemId).length; ctx.equal(historyLength, appended.status < 300 ? 2 : 1, `${label} evidence history matches the winning serialization`, { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  return { caseId, decisionId: decision.decisionId, evidenceHeadVersion: decision.evidenceHeadVersion, appendStatus: appended.status };
}

const B02 = defineCase("B-02", async function run(ctx) {
  const appendThenDecision = await decisionEvidenceRace(ctx, "b02-append-first", true); const concurrent = await decisionEvidenceRace(ctx, "b02-concurrent", false);
  return finalEvidence(ctx, { appendThenDecision, concurrent });
});

const B03 = defineCase("B-03", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("b03"); const { api } = await prepare(ctx, { seed }); const api2 = await ctx.startApi(); const completed = await completeCase(ctx, api, ctx.fixtures.submission(seed, "b03"));
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => createAppeal(ctx, index % 2 ? api.baseUrl : api2.baseUrl, completed.caseId, `appeal-${index}`, { key: ctx.key(`b03-${index}`), allowFailure: true })));
  ctx.equal(responses.filter(({ status }) => status >= 200 && status < 300).length, 1, "one Appeal creation wins", { hardCapIds: ["DOMAIN_CORRECTNESS"] }); for (const response of responses.filter(({ status }) => status >= 300)) expectError(ctx, response, 409, "APPEAL_ALREADY_EXISTS", "competing Appeal");
  const state = await snapshot(ctx, api.baseUrl); const appeals = state.resources.appeals.filter(({ caseId }) => caseId === completed.caseId); ctx.equal(appeals.length, 1, "one durable Appeal", { hardCapIds: ["DOMAIN_CORRECTNESS"] }); ctx.equal(state.resources.reviewStages.filter(({ caseId, level }) => caseId === completed.caseId && level === "APPEAL").length, 1, "one Appeal Stage"); ctx.equal(state.work.filter(({ aggregateId, kind }) => aggregateId === appeals[0].appealId && kind === "APPEAL_OPEN").length, 1, "one APPEAL_OPEN Work");
  return finalEvidence(ctx, { caseId: completed.caseId, appealId: appeals[0].appealId, contenders: responses.length });
});

async function recallFixture(ctx, label, { mixed = false } = {}) {
  const seed = ctx.fixtures.baseSeed(label, { action: "REMOVE" }); const { api } = await prepare(ctx, { seed }); const api2 = await ctx.startApi(); const changed = await completeCase(ctx, api, ctx.fixtures.submission(seed, `${label}-changed`), { outcome: "REMOVE", categoryCode: "ABUSE" }); const same = mixed ? await completeCase(ctx, api, ctx.fixtures.submission(seed, `${label}-same`), { outcome: "ALLOW", categoryCode: "SAFE" }) : await completeCase(ctx, api, ctx.fixtures.submission(seed, `${label}-second`), { outcome: "REMOVE", categoryCode: "ABUSE" }); const pending = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, `${label}-pending`));
  const replacement = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, ctx.fixtures.policyCategories("ALLOW")); const replacementId = resource(replacement, "policyVersionId"); await activatePolicyVersion(ctx, api.baseUrl, replacementId, seed.policyVersions[0].policyVersionId);
  const terminal = [changed.moderationCase, same.moderationCase]; const request = { tenantId: seed.tenants[0].tenantId, recalledPolicyVersionId: seed.policyVersions[0].policyVersionId, replacementPolicyVersionId: replacementId, decidedFrom: new Date(Math.min(...terminal.map(({ decidedAt }) => Date.parse(decidedAt))) - 1_000).toISOString(), decidedTo: new Date(Math.max(...terminal.map(({ decidedAt }) => Date.parse(decidedAt))) + 60_000).toISOString() };
  return { seed, api, api2, terminal, pending, request, changed, same };
}

const B04 = defineCase("B-04", async function run(ctx) {
  const fixture = await recallFixture(ctx, "b04"); const key = ctx.key("b04-recall"); const shield = await ctx.responseShield(fixture.api.baseUrl); shield.dropNextMutation(); await createRecall(ctx, shield.baseUrl, fixture.request, { key, allowFailure: true }).catch(() => undefined); await ctx.waitFor(() => shield.captures.some(({ dropped }) => dropped), { timeoutMs: 30_000, label: "lost Recall response" });
  const pendingCaseId = resource(fixture.pending, "caseId"); const opener = await ctx.startWorker(); const lateStage = await waitStage(ctx, fixture.api.baseUrl, ({ caseId, level, state }) => caseId === pendingCaseId && level === "LEVEL_1" && state === "OPEN", { processes: [opener], label: "post-freeze eligible Case" }); await ctx.stop(opener); await claimStage(ctx, fixture.api.baseUrl, lateStage.stageId, "b04-late-reviewer"); await decideStage(ctx, fixture.api.baseUrl, lateStage.stageId, { reviewerId: "b04-late-reviewer", outcome: "REMOVE", categoryCode: "ABUSE", reason: "became terminal after Recall freeze" });
  const replayResponses = await Promise.all(Array.from({ length: 20 }, (_, index) => createRecall(ctx, index % 2 ? fixture.api.baseUrl : fixture.api2.baseUrl, structuredClone(fixture.request), { key, allowFailure: true })));
  ctx.ok(replayResponses.every(({ status }) => status === 201), "all Recall replays return original status", { hardCapIds: ["DURABLE_IDEMPOTENCY"] }); ctx.equal(new Set(replayResponses.map(({ text }) => text)).size, 1, "Recall replay body is stable", { hardCapIds: ["DURABLE_IDEMPOTENCY"] }); const run = replayResponses[0].json; const runId = resource(run, "policyRecallRunId"); ctx.equal(resource(run, "totalCount"), 2, "frozen total remains two");
  const changedPayload = { ...fixture.request, decidedTo: new Date(Date.parse(fixture.request.decidedTo) + 1_000).toISOString() }; const conflict = await createRecall(ctx, fixture.api.baseUrl, changedPayload, { key, allowFailure: true }); expectError(ctx, conflict, 409, "IDEMPOTENCY_CONFLICT", "changed Recall replay", { hardCapIds: ["DURABLE_IDEMPOTENCY"] }); const state = await snapshot(ctx, fixture.api.baseUrl); ctx.equal(state.resources.policyRecallRuns.filter(({ policyRecallRunId }) => policyRecallRunId === runId).length, 1, "one Recall Run"); ctx.equal(state.work.filter(({ aggregateId, kind }) => aggregateId === runId && kind === "POLICY_RECALL").length, 1, "one Recall Work");
  ctx.ok(!state.resources.reconsiderations.some(({ policyRecallRunId, caseId }) => policyRecallRunId === runId && caseId === pendingCaseId), "post-freeze eligible Case never joins existing cohort");
  return finalEvidence(ctx, { runId, replayCount: replayResponses.length, totalCount: resource(run, "totalCount"), excludedLateCaseId: pendingCaseId });
});

const B05 = defineCase("B-05", async function run(ctx) {
  const fixture = await recallFixture(ctx, "b05", { mixed: true }); const before = await snapshot(ctx, fixture.api.baseUrl); const original = canonical({ contentItems: before.resources.contentItems, evidenceVersions: before.resources.evidenceVersions, moderationCases: before.resources.moderationCases, moderationDecisions: before.resources.moderationDecisions, appeals: before.resources.appeals }); const run = await createRecall(ctx, fixture.api.baseUrl, fixture.request); const runId = resource(run, "policyRecallRunId"); const workers = [await ctx.startWorker(), await ctx.startWorker()]; const final = await waitSnapshot(ctx, fixture.api.baseUrl, (value) => value.resources.policyRecallRuns.find(({ policyRecallRunId, state }) => policyRecallRunId === runId && state === "COMPLETED"), { processes: workers, timeoutMs: 120_000, label: "mixed Recall completion" }); await stopAll(ctx, workers); const detail = await getRecall(ctx, fixture.api.baseUrl, runId); const members = assertReconsiderationConservation(detail.run, detail.reconsiderations, final); ctx.equal(detail.run.completedCount, 2, "two completed members"); ctx.equal(detail.run.changedCount, 1, "one changed member"); ctx.equal(detail.run.noChangeCount, 1, "one no-change member"); ctx.equal(new Set(members.map(({ caseId }) => caseId)), new Set(fixture.terminal.map(({ caseId }) => caseId)), "one result for each frozen Case");
  const after = canonical({ contentItems: final.resources.contentItems, evidenceVersions: final.resources.evidenceVersions, moderationCases: final.resources.moderationCases, moderationDecisions: final.resources.moderationDecisions, appeals: final.resources.appeals }); ctx.equal(after, original, "Recall never rewrites V1 domain history", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  return finalEvidence(ctx, { runId, changedCount: detail.run.changedCount, noChangeCount: detail.run.noChangeCount });
});

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05]);
