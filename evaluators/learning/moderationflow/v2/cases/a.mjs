import assert from "node:assert/strict";
import { assertEvidenceHistory, assertReconsiderationConservation, stablePublicSnapshot } from "../oracles/index.mjs";
import {
  activatePolicyVersion, appendEvidence, claimStage, completeCase, createAppeal, createContent, createPolicyVersion,
  createRecall, decideStage, defineCase, expectError, finalEvidence, getRecall, prepare, resource, snapshot, stopAll,
  waitSnapshot, waitStage,
} from "./helpers.mjs";

const A01 = defineCase("A-01", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("a01"); const { api } = await prepare(ctx, { seed }); const body = ctx.fixtures.submission(seed, "a01"); const key = ctx.key("a01-create");
  const created = await createContent(ctx, api.baseUrl, body, { key }); const replay = await createContent(ctx, api.baseUrl, structuredClone(body), { key });
  ctx.equal(replay, created, "exact content replay body", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
  const state = await snapshot(ctx, api.baseUrl); const contentItemId = resource(created, "contentItemId"); const caseId = resource(created, "caseId");
  ctx.equal(state.resources.contentItems.filter((item) => item.externalContentId === body.externalContentId).length, 1, "one external content authority", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const history = assertEvidenceHistory(state.resources.evidenceVersions, contentItemId); ctx.equal(history.length, 1, "one initial EvidenceVersion"); ctx.equal(history[0].version, 1, "initial evidence version");
  const moderationCase = state.resources.moderationCases.find((item) => item.caseId === caseId); ctx.equal(moderationCase.evidenceHeadVersion, 1, "Case captures initial evidence head"); ctx.equal(moderationCase.policyVersionId, seed.policyVersions[0].policyVersionId, "Case captures active policy");
  ctx.equal(state.work.filter(({ aggregateId, kind }) => aggregateId === caseId && kind === "CASE_OPEN").length, 1, "one CASE_OPEN Work"); ctx.equal(state.events.filter(({ type }) => type === "content.accepted").length, 1, "one content accepted Event");
  const changed = { ...body, text: `${body.text} changed`, bodyDigest: ctx.fixtures.digest(`${body.text} changed`) }; const before = stablePublicSnapshot(state); const conflict = await createContent(ctx, api.baseUrl, changed, { key: ctx.key("a01-changed"), allowFailure: true }); expectError(ctx, conflict, 409, "EXTERNAL_CONTENT_CONFLICT", "changed external content", { hardCapIds: ["DOMAIN_CORRECTNESS"] }); ctx.equal(stablePublicSnapshot(await snapshot(ctx, api.baseUrl)), before, "conflict leaves public state unchanged");
  return finalEvidence(ctx, { contentItemId, caseId, evidenceVersion: 1 });
});

const A02 = defineCase("A-02", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("a02"); const { api } = await prepare(ctx, { seed }); const created = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, "a02")); const contentItemId = resource(created, "contentItemId");
  await appendEvidence(ctx, api.baseUrl, contentItemId, ctx.fixtures.evidence("a02-2", 1)); await appendEvidence(ctx, api.baseUrl, contentItemId, ctx.fixtures.evidence("a02-3", 2));
  const before = await snapshot(ctx, api.baseUrl); const oldHistory = structuredClone(assertEvidenceHistory(before.resources.evidenceVersions, contentItemId));
  await appendEvidence(ctx, api.baseUrl, contentItemId, ctx.fixtures.evidence("a02-4", 3)); const after = await snapshot(ctx, api.baseUrl); const history = assertEvidenceHistory(after.resources.evidenceVersions, contentItemId);
  ctx.equal(history.length, 4, "four contiguous EvidenceVersions"); ctx.equal(history.slice(0, 3), oldHistory, "old evidence bodies remain immutable", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const stable = stablePublicSnapshot(after); const stale = await appendEvidence(ctx, api.baseUrl, contentItemId, ctx.fixtures.evidence("a02-stale", 2), { allowFailure: true }); expectError(ctx, stale, 409, "EVIDENCE_HEAD_CHANGED", "stale evidence head", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const tooLong = await appendEvidence(ctx, api.baseUrl, contentItemId, ctx.fixtures.evidence("a02-long", 4, { summary: "x".repeat(4097) }), { allowFailure: true, contractExpectation: "invalid" }); expectError(ctx, tooLong, 400, "EVIDENCE_INVALID", "oversized evidence", { hardCapIds: ["DOMAIN_CORRECTNESS"] }); ctx.equal(stablePublicSnapshot(await snapshot(ctx, api.baseUrl)), stable, "rejected evidence leaves no gap or side effect");
  return finalEvidence(ctx, { contentItemId, versions: history.map(({ version }) => version) });
});

const A03 = defineCase("A-03", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("a03"); const { api } = await prepare(ctx, { seed }); const created = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, "a03")); const caseId = resource(created, "caseId"); const contentItemId = resource(created, "contentItemId");
  const worker = await ctx.startWorker(); const levelOne = await waitStage(ctx, api.baseUrl, ({ caseId: candidate, level, state }) => candidate === caseId && level === "LEVEL_1" && state === "OPEN", { processes: [worker], label: "A03 LEVEL_1" }); await ctx.stop(worker);
  await claimStage(ctx, api.baseUrl, levelOne.stageId, "reviewer-a03"); await appendEvidence(ctx, api.baseUrl, contentItemId, ctx.fixtures.evidence("a03-late", 1));
  const nextVersion = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, ctx.fixtures.policyCategories("REMOVE")); const nextId = resource(nextVersion, "policyVersionId"); await activatePolicyVersion(ctx, api.baseUrl, nextId, seed.policyVersions[0].policyVersionId);
  await decideStage(ctx, api.baseUrl, levelOne.stageId, { reviewerId: "reviewer-a03", outcome: "ESCALATE", categoryCode: "ABUSE", reason: "needs level two" });
  const secondWorker = await ctx.startWorker(); const levelTwo = await waitStage(ctx, api.baseUrl, ({ caseId: candidate, level, state }) => candidate === caseId && level === "LEVEL_2" && state === "OPEN", { processes: [secondWorker], label: "A03 LEVEL_2" }); await ctx.stop(secondWorker);
  await claimStage(ctx, api.baseUrl, levelTwo.stageId, "reviewer-a03-2"); const illegal = await decideStage(ctx, api.baseUrl, levelTwo.stageId, { reviewerId: "reviewer-a03-2", outcome: "ESCALATE", categoryCode: "ABUSE", reason: "illegal" }, { allowFailure: true }); ctx.ok([400, 409].includes(illegal.status), "LEVEL_2 ESCALATE is rejected");
  await decideStage(ctx, api.baseUrl, levelTwo.stageId, { reviewerId: "reviewer-a03-2", outcome: "REMOVE", categoryCode: "ABUSE", reason: "final" }); const state = await snapshot(ctx, api.baseUrl); const decisions = state.resources.moderationDecisions.filter((item) => [levelOne.stageId, levelTwo.stageId].includes(item.stageId));
  ctx.equal(decisions.length, 2, "exactly two Decisions", { hardCapIds: ["DOMAIN_CORRECTNESS"] }); const first = decisions.find(({ stageId }) => stageId === levelOne.stageId); const second = decisions.find(({ stageId }) => stageId === levelTwo.stageId);
  ctx.equal(first.evidenceHeadVersion, 1, "LEVEL_1 retains captured evidence"); ctx.equal(first.policyVersionId, seed.policyVersions[0].policyVersionId, "LEVEL_1 retains captured policy"); ctx.equal(second.evidenceHeadVersion, 2, "LEVEL_2 captures current case evidence"); ctx.equal(second.policyVersionId, seed.policyVersions[0].policyVersionId, "LEVEL_2 retains Case policy despite new ACTIVE version"); ctx.equal(state.resources.moderationCases.find((item) => item.caseId === caseId).finalDecisionId, second.decisionId, "Case final authority is LEVEL_2 Decision");
  return finalEvidence(ctx, { caseId, levelOneDecisionId: first.decisionId, levelTwoDecisionId: second.decisionId });
});

function appealBoundarySeed(ctx) {
  const seed = ctx.fixtures.baseSeed("a04-boundary"); const now = Date.now();
  for (const [label, ageMs, sequence] of [["inside", 30 * 86_400_000 - 60_000, 1], ["outside", 30 * 86_400_000 + 60_000, 2]]) {
    const contentItemId = ctx.fixtures.uuid(`a04:${label}:content`); const evidenceVersionId = ctx.fixtures.uuid(`a04:${label}:evidence`); const caseId = ctx.fixtures.uuid(`a04:${label}:case`); const stageId = ctx.fixtures.uuid(`a04:${label}:stage`); const decisionId = ctx.fixtures.uuid(`a04:${label}:decision`); const createdAt = new Date(now - ageMs - 60_000).toISOString(); const decidedAt = new Date(now - ageMs).toISOString();
    seed.contentItems.push({ contentItemId, tenantId: seed.tenants[0].tenantId, externalContentId: `a04-${label}`, contentType: "POST", bodyDigest: ctx.fixtures.digest(label), text: label, createdAt, sequence }); seed.evidenceVersions.push({ evidenceVersionId, contentItemId, version: 1, kind: "SUBMISSION", digest: ctx.fixtures.digest(`evidence-${label}`), summary: label, createdBy: "seed", createdAt }); seed.reviewStages.push({ stageId, caseId, level: "LEVEL_1", state: "DECIDED", assigneeId: "seed-reviewer", leaseExpiresAt: null, openedAt: createdAt, closedAt: decidedAt, revision: 2 }); seed.moderationDecisions.push({ decisionId, stageId, outcome: "ALLOW", categoryCode: "SAFE", reason: "seed", reviewerId: "seed-reviewer", evidenceHeadVersion: 1, policyVersionId: seed.policyVersions[0].policyVersionId, createdAt: decidedAt }); seed.moderationCases.push({ caseId, contentItemId, policyVersionId: seed.policyVersions[0].policyVersionId, evidenceHeadVersion: 1, state: "DECIDED", finalDecisionId: decisionId, createdAt, decidedAt, sequence });
  }
  return seed;
}

const A04 = defineCase("A-04", async function run(ctx) {
  const seed = appealBoundarySeed(ctx); const { api } = await prepare(ctx, { seed }); const [inside, outside] = seed.moderationCases;
  const key = ctx.key("a04-inside"); const timely = await createAppeal(ctx, api.baseUrl, inside.caseId, "timely appeal", { key }); const replay = await createAppeal(ctx, api.baseUrl, inside.caseId, "timely appeal", { key }); ctx.equal(replay, timely, "Appeal exact replay", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
  const duplicate = await createAppeal(ctx, api.baseUrl, inside.caseId, "second reality", { key: ctx.key("a04-duplicate"), allowFailure: true }); expectError(ctx, duplicate, 409, "APPEAL_ALREADY_EXISTS", "second Appeal", { hardCapIds: ["DOMAIN_CORRECTNESS"] }); const late = await createAppeal(ctx, api.baseUrl, outside.caseId, "late appeal", { key: ctx.key("a04-late"), allowFailure: true }); expectError(ctx, late, 409, "APPEAL_WINDOW_CLOSED", "late Appeal", { hardCapIds: ["DOMAIN_CORRECTNESS"] });
  const state = await snapshot(ctx, api.baseUrl); const appealId = resource(timely, "appealId"); const appeal = state.resources.appeals.find((item) => item.appealId === appealId); ctx.equal(appeal.challengedDecisionId, inside.finalDecisionId, "Appeal freezes challenged Decision"); ctx.equal(appeal.evidenceHeadVersion, inside.evidenceHeadVersion, "Appeal freezes evidence head"); ctx.equal(state.resources.appeals.filter(({ caseId }) => caseId === inside.caseId).length, 1, "one Appeal authority"); ctx.equal(state.resources.appeals.filter(({ caseId }) => caseId === outside.caseId).length, 0, "late Appeal has no row");
  return finalEvidence(ctx, { appealId, challengedDecisionId: appeal.challengedDecisionId });
});

async function terminalUnderActive(ctx, api, seed, label) { return completeCase(ctx, api, ctx.fixtures.submission(seed, label), { outcome: "REMOVE", categoryCode: "ABUSE", reviewerId: `reviewer-${label}` }); }

const A05 = defineCase("A-05", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("a05", { action: "REMOVE" }); const { api } = await prepare(ctx, { seed }); const first = await terminalUnderActive(ctx, api, seed, "a05-first"); const second = await terminalUnderActive(ctx, api, seed, "a05-second"); const pending = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, "a05-pending"));
  const incompatible = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, [{ categoryCode: "SAFE", severity: 0, level1Action: "ALLOW" }]); const incompatibleId = resource(incompatible, "policyVersionId"); await activatePolicyVersion(ctx, api.baseUrl, incompatibleId, seed.policyVersions[0].policyVersionId);
  const decided = [first.moderationCase, second.moderationCase]; const range = { tenantId: seed.tenants[0].tenantId, recalledPolicyVersionId: seed.policyVersions[0].policyVersionId, replacementPolicyVersionId: incompatibleId, decidedFrom: new Date(Math.min(...decided.map((item) => Date.parse(item.decidedAt))) - 1_000).toISOString(), decidedTo: new Date(Math.max(...decided.map((item) => Date.parse(item.decidedAt))) + 1_000).toISOString() };
  const before = await snapshot(ctx, api.baseUrl); const rejected = await createRecall(ctx, api.baseUrl, range, { allowFailure: true, key: ctx.key("a05-incompatible") }); expectError(ctx, rejected, 409, "POLICY_RECALL_POLICY_INCOMPATIBLE", "incompatible replacement", { hardCapIds: ["DOMAIN_CORRECTNESS"] }); const afterRejected = await snapshot(ctx, api.baseUrl); ctx.equal(afterRejected.resources.policyRecallRuns.length, before.resources.policyRecallRuns.length, "incompatible Recall creates no Run"); ctx.equal(afterRejected.work.length, before.work.length, "incompatible Recall creates no Work");
  const compatible = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, ctx.fixtures.policyCategories("ALLOW")); const compatibleId = resource(compatible, "policyVersionId"); await activatePolicyVersion(ctx, api.baseUrl, compatibleId, incompatibleId); const run = await createRecall(ctx, api.baseUrl, { ...range, replacementPolicyVersionId: compatibleId }, { key: ctx.key("a05-compatible") }); const runId = resource(run, "policyRecallRunId"); ctx.equal(resource(run, "totalCount"), 2, "Recall freezes two terminal Cases");
  const workers = [await ctx.startWorker(), await ctx.startWorker()]; const final = await waitSnapshot(ctx, api.baseUrl, (value) => value.resources.policyRecallRuns.find(({ policyRecallRunId, state }) => policyRecallRunId === runId && state === "COMPLETED"), { processes: workers, timeoutMs: 120_000, label: "A05 Recall completion" }); await stopAll(ctx, workers); const detail = await getRecall(ctx, api.baseUrl, runId); const selected = assertReconsiderationConservation(detail.run, detail.reconsiderations, final); ctx.equal(new Set(selected.map(({ caseId }) => caseId)), new Set(decided.map(({ caseId }) => caseId)), "Recall exact closed cohort"); ctx.ok(!selected.some(({ caseId }) => caseId === resource(pending, "caseId")), "non-terminal Case excluded");
  return finalEvidence(ctx, { runId, frozenCaseIds: selected.map(({ caseId }) => caseId).sort(), totalCount: detail.run.totalCount });
});

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05]);
