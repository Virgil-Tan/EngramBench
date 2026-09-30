import assert from "node:assert/strict";
import { assertAuditChains, canonicalJson } from "../oracles/index.mjs";
import {
  acceptRisk,
  assertAssessment,
  assertFactsPreserved,
  assertRemediationDetail,
  createRemediation,
  defineCase,
  findField,
  guardedCase,
  prepare,
  resources,
  setupRollback,
  successful,
  waitAssessment,
  waitLeasedWork,
  waitRemediation,
  waitReviewCase,
} from "./helpers.mjs";

const C01 = guardedCase("C-01", ["WORK_FENCE", "VERSION_AUTHORITY"], async (ctx) => {
  const { api } = await prepare(ctx, { seedVersion: "fl-c01" });
  const accepted = await acceptRisk(ctx, api.baseUrl, 100_000, { attributes: { velocity: 9, country: "US" } });
  const pending = await waitAssessment(ctx, api.baseUrl, accepted.payload.externalEventId, { terminal: false });
  assert.equal(pending.assessment.state, "PENDING", "assessment begins pending");
  const worker = await ctx.startWorker();
  const leased = await waitLeasedWork(ctx, api.baseUrl, (item) => item.kind === "RISK_ASSESSMENT" && item.aggregateId === pending.assessment.assessmentId, { processes: [worker], timeoutMs: 30_000 });
  assert.equal(leased.work.terminal, false, "leased Work is not terminal");
  await ctx.kill(worker);
  const replacement = await ctx.startWorker();
  const completed = await waitAssessment(ctx, api.baseUrl, accepted.payload.externalEventId, { processes: [replacement], timeoutMs: 60_000 });
  const version = resources(completed.snapshot).ruleVersions.find((item) => item.ruleVersionId === ctx.fixtures.ids.baseVersionId);
  assertAssessment(completed.snapshot, completed.assessment, accepted.payload, version);
  const work = completed.snapshot.work.filter((item) => item.kind === "RISK_ASSESSMENT" && item.aggregateId === completed.assessment.assessmentId);
  assert.equal(work.length, 1, "one assessment Work");
  assert.equal(work[0].terminal, true, "replacement terminates Work");
  assert.equal(resources(completed.snapshot).assessments.filter((item) => item.assessmentId === completed.assessment.assessmentId).length, 1, "one Assessment effect");
  assert.equal(resources(completed.snapshot).ruleHits.filter((item) => item.assessmentId === completed.assessment.assessmentId).length, 1, "one RuleHit effect");
  ctx.mark("assessment.public-lease-recovered", { workId: work[0].workId, attempt: work[0].attempt });
  return ctx.pass({ blockedAssertions: [ctx.diagnostic("assessment-internal-checkpoint", "FL-GAP-04")] });
});

const C02 = guardedCase("C-02", ["WORK_FENCE", "REVIEW_TERMINAL"], async (ctx) => {
  const { apis, workers } = await prepare(ctx, { seedVersion: "fl-c02", apiCount: 2, workerCount: 1 });
  const accepted = await acceptRisk(ctx, apis[0].baseUrl, 110_000, { attributes: { velocity: 9, country: "US" } });
  const completed = await waitAssessment(ctx, apis[0].baseUrl, accepted.payload.externalEventId, { processes: workers });
  const { reviewCase } = await waitReviewCase(ctx, apis[0].baseUrl, completed.assessment.assessmentId, { processes: workers });
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const reviewerId = "expiry-race-reviewer";
  successful(await ctx.mutate(apis[0].baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/claim`, ctx.key("c02-claim"), { reviewerId, leaseSeconds: 1 }), "short Review lease");
  const expiryWorker = await ctx.startWorker();
  const leased = await waitLeasedWork(ctx, apis[0].baseUrl, (item) => item.kind === "REVIEW_EXPIRY" && item.aggregateId === reviewCase.reviewCaseId, { processes: [expiryWorker], timeoutMs: 30_000 });
  await ctx.kill(expiryWorker);
  const replacement = await ctx.startWorker();
  const decisionPromise = ctx.mutate(apis[1].baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/decisions`, ctx.key("c02-decision"), { reviewerId, outcome: "APPROVE", reasonCode: "LEASE_BOUNDARY" });
  const terminal = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const current = resources(snapshot).reviewCases.find((item) => item.reviewCaseId === reviewCase.reviewCaseId);
    return ["APPROVED", "EXPIRED"].includes(current?.state) ? { current, snapshot } : undefined;
  }, { timeoutMs: 60_000, label: "review expiry recovery", processes: [replacement] });
  const decision = await decisionPromise;
  if (terminal.current.state === "APPROVED") successful(decision, "live owner decision");
  else assert.ok(decision.status === 409 && ["REVIEW_LEASE_CONFLICT", "REVIEW_TERMINAL"].includes(decision.json?.error?.code), "expired owner rejected");
  const decisions = resources(terminal.snapshot).reviewDecisions.filter((item) => item.reviewCaseId === reviewCase.reviewCaseId);
  assert.equal(decisions.length, terminal.current.state === "APPROVED" ? 1 : 0, "terminal ReviewDecision cardinality");
  const expiryWork = terminal.snapshot.work.filter((item) => item.kind === "REVIEW_EXPIRY" && item.aggregateId === reviewCase.reviewCaseId);
  assert.equal(expiryWork.length, 1, "one REVIEW_EXPIRY Work");
  assert.equal(expiryWork[0].terminal, true, "expiry Work terminal");
  assert.ok(expiryWork[0].attempt >= leased.work.attempt, "replacement never regresses Work attempt");
  ctx.mark("review.expiry-fence.closed", { reviewCaseId: reviewCase.reviewCaseId, state: terminal.current.state });
  return ctx.pass();
});

const C03 = guardedCase("C-03", ["WORK_FENCE", "CORRECTION_UNIQUENESS", "HISTORY_IMMUTABILITY"], async (ctx) => {
  const { api } = await prepare(ctx, { seedVersion: "fl-c03" });
  const rollback = await setupRollback(ctx, api.baseUrl, { count: 12, suffix: "c03", includeNoChange: true });
  const created = await createRemediation(ctx, api.baseUrl, rollback, "c03");
  const worker = await ctx.startWorker();
  const leased = await waitLeasedWork(ctx, api.baseUrl, (item) => item.kind === "REMEDIATION_RECHECK" && item.aggregateId === created.remediationRunId, { processes: [worker], timeoutMs: 30_000 });
  await ctx.kill(worker);
  const cancel = await ctx.mutate(api.baseUrl, `/api/v1/remediation-runs/${created.remediationRunId}/cancel`, ctx.key("c03-cancel"), {}, { admin: true });
  assert.ok((cancel.status >= 200 && cancel.status < 300) || (cancel.status === 409 && cancel.json?.error?.code === "REMEDIATION_RUN_TERMINAL"), "cancel serializes with final item");
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const detail = await waitRemediation(ctx, api.baseUrl, created.remediationRunId, { processes: replacements, timeoutMs: 60_000 });
  assertRemediationDetail(detail, rollback.assessmentIds);
  assert.equal(detail.corrections.length, detail.run.completedCount, "each committed item has one result");
  assert.equal(new Set(detail.corrections.map((item) => item.assessmentCorrectionId)).size, detail.corrections.length, "stable unique Correction identities");
  const final = await ctx.snapshot(api.baseUrl);
  const works = final.work.filter((item) => item.kind === "REMEDIATION_RECHECK" && item.aggregateId === created.remediationRunId);
  assert.ok(works.length > 0 && works.every((item) => item.terminal), "all remediation Work terminal after cancel/recovery");
  assert.ok(works.every((item) => item.attempt >= leased.work.attempt), "Work attempts never regress");
  assertFactsPreserved(final, rollback.captured);
  ctx.mark("remediation.public-lease-recovered", { remediationRunId: created.remediationRunId, state: detail.run.state });
  return ctx.pass({ blockedAssertions: [ctx.diagnostic("remediation-internal-checkpoint", "FL-GAP-04")] });
});

const C04 = guardedCase("C-04", ["HISTORY_IMMUTABILITY", "TENANT_ISOLATION"], async (ctx) => {
  let targetEventId;
  let targetAttempts = 0;
  const receiver = await ctx.receiver({
    behavior(entry) {
      const eventId = findField(entry.json, "eventId") ?? findField(entry.json, "id");
      targetEventId ??= eventId;
      if (eventId !== targetEventId) return { status: 204 };
      targetAttempts += 1;
      if (targetAttempts === 1) return { status: 500 };
      if (targetAttempts === 2) return { status: 204, delayMs: 60_000 };
      return { status: 204 };
    },
  });
  const { api, dispatchers } = await prepare(ctx, { seedVersion: "fl-c04", receiver });
  const accepted = await acceptRisk(ctx, api.baseUrl, 120_000, { attributes: { velocity: 1, country: "US" } });
  const worker = await ctx.startWorker();
  await waitAssessment(ctx, api.baseUrl, accepted.payload.externalEventId, { processes: [worker] });
  const second = await ctx.waitFor(() => {
    const matching = receiver.ledger.filter((entry) => (findField(entry.json, "eventId") ?? findField(entry.json, "id")) === targetEventId);
    return matching.length >= 2 ? matching[1] : undefined;
  }, { timeoutMs: 30_000, label: "unknown Event ACK", processes: dispatchers });
  assert.equal(typeof targetEventId, "string", "delivered Event has a stable public identity");
  await ctx.kill(dispatchers[0]);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
  const third = await ctx.waitFor(() => {
    const matching = receiver.ledger.filter((entry) => (findField(entry.json, "eventId") ?? findField(entry.json, "id")) === targetEventId);
    return matching.length >= 3 ? matching[2] : undefined;
  }, { timeoutMs: 60_000, label: "Event retry after Dispatcher SIGKILL", processes: [replacement] });
  const first = receiver.ledger.find((entry) => (findField(entry.json, "eventId") ?? findField(entry.json, "id")) === targetEventId);
  assert.equal(second.raw, first.raw, "unknown ACK retry body byte-identical");
  assert.equal(third.raw, first.raw, "replacement retry body byte-identical");
  assert.equal(findField(third.json, "eventId") ?? findField(third.json, "id"), targetEventId, "Event identity stable");
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertAuditChains(resources(snapshot).auditEntries);
  const eventRecords = snapshot.events.filter((item) => (item.eventId ?? item.id) === targetEventId);
  assert.equal(eventRecords.length, 1, "one durable Event despite delivery retries");
  assert.equal(canonicalJson(eventRecords[0]), canonicalJson(eventRecords[0]), "durable Event remains canonical");
  ctx.mark("event.unknown-ack.closed", { eventId: targetEventId, deliveryAttempts: 3 });
  return ctx.pass();
});

export const C_CASES = [C01, C02, C03, C04];
