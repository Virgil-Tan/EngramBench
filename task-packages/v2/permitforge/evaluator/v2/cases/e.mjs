import assert from "node:assert/strict";

import {
  assertAggregateSequences,
  assertApplicationRevision,
  assertDomainEvent,
  assertPermitApplication,
  assertProjection,
  assertReviewClaim,
  assertReviewDecision,
  assertReviewStage,
  assertRetryIdentity,
  assertSnapshot,
  assertWork,
  canonicalJson,
  sha256,
} from "../oracles/index.mjs";
import {
  applicationFrom,
  assertAggregateDetailAuthority,
  assertExternalSecretBoundary,
  assertSavedHttpReplay,
  assertV1ResourceBijection,
  blocked,
  boot,
  caseResult,
  claimsFor,
  decisionsFor,
  defineCase,
  expectError,
  findObject,
  claimResource,
  findObjects,
  requireStatus,
  requireV1Workspace,
  revisionsFor,
  snapshot,
  stableSnapshot,
  submitApplication,
  waitSnapshot,
} from "./helpers.mjs";
import { assertMeasuredWindow, closedLoop } from "./perf.mjs";

const V1_APPLICATION_FIELDS = ["applicationId", "applicantId", "currentRevision", "deadlineAt", "decisionRevision", "permitType", "sequence", "state", "submittedAt", "terminalAt"];

function v1Application(value) {
  return Object.fromEntries(V1_APPLICATION_FIELDS.map((name) => [name, value[name]]));
}

function captureJson(capture) {
  return JSON.parse(capture.response.body);
}

function resourceById(items, name, value) {
  return items.find((item) => item[name] === value);
}

const V1_RESOURCE_NAMES = Object.freeze(["applicants", "reviewers", "permitApplications", "applicationRevisions", "reviewClaims", "reviewDecisions", "approvedPermits"]);

export function assertExactV1MigrationClosure(before, after) {
  assertV1ResourceBijection(before.resources, after.resources, { projectApplication: v1Application });
  for (const name of V1_RESOURCE_NAMES) {
    assert.equal(after.resources[name].length, before.resources[name].length, `${name} migration cardinality`);
  }
  assert.deepEqual(after.work, before.work, "V1 Work array retained without extra identities");
  assert.deepEqual(after.events, before.events, "V1 Event array retained without extra identities");
  assert.equal(after.resources.reviewStages.length, before.resources.permitApplications.length, "exactly one backfilled Stage per V1 Application");
  assert.equal(new Set(after.resources.reviewStages.map(({ stageId }) => stageId)).size, after.resources.reviewStages.length, "backfilled Stage identities unique");
  for (const application of before.resources.permitApplications) {
    const revisions = before.resources.applicationRevisions.filter(({ applicationId, revision }) => applicationId === application.applicationId && revision === application.currentRevision);
    assert.equal(revisions.length, 1, `${application.applicationId} exact V1 current Revision`);
    const stages = after.resources.reviewStages.filter(({ applicationId }) => applicationId === application.applicationId);
    assert.equal(stages.length, 1, `${application.applicationId} exact one backfilled Stage`);
    assertReviewStage(stages[0]);
    assert.equal(stages[0].revision, application.currentRevision, `${application.applicationId} backfilled current Revision`);
    assert.equal(stages[0].ordinal, 1, `${application.applicationId} backfilled ordinal`);
    assert.deepEqual(stages[0].policy, revisions[0].policy, `${application.applicationId} backfilled captured policy`);
  }
  return true;
}

const e01 = defineCase(
  "E-01",
  "PF-F-MIGRATION populated V1 checkpoint",
  "Use the frozen V1 workspace to create all seeded states plus saved submit, Claim and Decision-bearing reads, then migrate the same PostgreSQL database twice and repeat the exact old requests on FINAL",
  "Every V1 resource is a one-to-one immutable identity, Work and Event survive exactly once, each current Revision backfills one Stage, and saved public response evidence remains exact without inventing a Decision token wire",
  ["frozen V1 workspace", "same PostgreSQL database", "FINAL migration twice", "old public client", "verification snapshots"],
  async (ctx) => {
    const v1 = requireV1Workspace(ctx);
    const family = ctx.fixtures.migration();
    await v1.migrate();
    await v1.seed(family.seed);
    const v1Api = await v1.startApi();
    const oldSubmitBody = ctx.fixtures.submissionBody("e01-old-submit");
    const oldSubmitKey = ctx.key("e01-old-submit");
    const oldSubmit = await v1.mutate(v1Api.baseUrl, "/api/v1/permit-applications", oldSubmitKey, oldSubmitBody);
    requireStatus(ctx, oldSubmit, 201, "V1 old-client submit");
    const submittedId = findObject(oldSubmit.json, "applicationId").applicationId;
    const legacy = family.histories.find(({ application }) => application.state === "SUBMITTED" && Date.parse(application.deadlineAt) > Date.now());
    const reviewer = family.reviewers.find(({ roles }) => roles.includes("security"));
    const claimBody = { reviewerId: reviewer.reviewerId, role: "security" };
    const claimKey = ctx.key("e01-old-claim");
    const oldClaim = await v1.mutate(v1Api.baseUrl, `/api/v1/permit-applications/${legacy.application.applicationId}/review-claims`, claimKey, claimBody);
    requireStatus(ctx, oldClaim, 200, "V1 old-client Claim");
    const oldRead = await v1.request(v1Api.baseUrl, `/api/v1/permit-applications/${legacy.application.applicationId}`);
    requireStatus(ctx, oldRead, 200, "V1 old-client read");
    const approved = family.histories.find(({ application }) => application.state === "APPROVED");
    const oldDecisionRead = await v1.request(v1Api.baseUrl, `/api/v1/permit-applications/${approved.application.applicationId}`);
    requireStatus(ctx, oldDecisionRead, 200, "saved V1 Decision-bearing read");
    const before = await v1.snapshot(v1Api.baseUrl);
    ctx.assert("exact V1 checkpoint snapshot", () => assertSnapshot(before, { final: false }));
    const oldReadAuthority = ctx.assert("saved V1 old-client detail exact", () => assertAggregateDetailAuthority(oldRead.json, before, legacy.application.applicationId, { final: false }));
    const savedDecisionAuthority = ctx.assert("saved V1 Decision response evidence exact", () => assertAggregateDetailAuthority(oldDecisionRead.json, before, approved.application.applicationId, { final: false }));
    ctx.equal(savedDecisionAuthority.decisions, approved.decisions, "saved V1 detail carries all Decision identities");
    ctx.equal(savedDecisionAuthority.permit, approved.permits[0], "saved V1 detail carries exact Permit");
    await ctx.stop(v1Api);
    await ctx.migrate();
    await ctx.migrate();
    const finalApi = await ctx.startApi();
    const replaySubmit = await ctx.mutate(finalApi.baseUrl, "/api/v1/permit-applications", oldSubmitKey, oldSubmitBody);
    const replayClaim = await ctx.mutate(finalApi.baseUrl, `/api/v1/permit-applications/${legacy.application.applicationId}/review-claims`, claimKey, claimBody);
    ctx.assert("old submit status bytes and headers preserved", () => assertSavedHttpReplay(oldSubmit, replaySubmit), { hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"] });
    ctx.assert("old Claim status bytes and headers preserved", () => assertSavedHttpReplay(oldClaim, replayClaim), { hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"] });
    const finalRead = await ctx.request(finalApi.baseUrl, `/api/v1/permit-applications/${legacy.application.applicationId}`);
    requireStatus(ctx, finalRead, 200, "FINAL old-client read");
    const finalDecisionRead = await ctx.request(finalApi.baseUrl, `/api/v1/permit-applications/${approved.application.applicationId}`);
    requireStatus(ctx, finalDecisionRead, 200, "FINAL migrated Decision-bearing read");
    const after = await snapshot(ctx, finalApi.baseUrl);
    ctx.assert("all V1 resources Work Events and backfilled Stages form an exact FINAL closure", () => assertExactV1MigrationClosure(before, after), { hardCapIds: ["MIGRATION_COMPATIBILITY", "EVENT_ATOMICITY"] });
    const finalReadAuthority = ctx.assert("FINAL legacy detail closes migrated authority", () => assertAggregateDetailAuthority(finalRead.json, after, legacy.application.applicationId));
    ctx.equal(v1Application(finalReadAuthority.application), oldReadAuthority.application, "old read Application semantics preserved");
    ctx.equal(finalReadAuthority.revision, oldReadAuthority.revision, "old read current Revision preserved");
    ctx.equal(finalReadAuthority.claims, oldReadAuthority.claims, "old read Claim history preserved");
    ctx.equal(finalReadAuthority.decisions, oldReadAuthority.decisions, "old read Decision history preserved");
    ctx.equal(finalReadAuthority.permit, oldReadAuthority.permit, "old read Permit semantics preserved");
    const finalDecisionAuthority = ctx.assert("FINAL Decision-bearing detail exact", () => assertAggregateDetailAuthority(finalDecisionRead.json, after, approved.application.applicationId));
    ctx.equal(finalDecisionAuthority.decisions, savedDecisionAuthority.decisions, "saved V1 Decision identities and payloads preserved");
    ctx.equal(finalDecisionAuthority.permit, savedDecisionAuthority.permit, "saved V1 Permit identity and payload preserved");
    ctx.equal(after.resources.permitApplications.filter(({ applicationId }) => applicationId === submittedId).length, 1, "old submitted Application remains exactly once");
    return caseResult(ctx, { migratedApplications: before.resources.permitApplications.length, submittedId, legacyApplicationId: legacy.application.applicationId, savedDecisionIds: savedDecisionAuthority.decisions.map(({ decisionId }) => decisionId), savedPermitId: savedDecisionAuthority.permit.permitId });
  },
  [blocked("PF-E01-DECISION-REPLAY-WIRE", "PF-GAP-01")],
);

const e02 = defineCase(
  "E-02",
  "PF-F-MIGRATION saved replay and Event checkpoint",
  "Drop a committed V1 submit response behind the response shield, save an exact idempotency conflict and aggregate Events, migrate to FINAL and replay both requests",
  "Original status and complete semantic body, Application identity, eventId, type, payload and sequence remain unchanged; no evaluator-defined legacy media negotiation is assumed",
  ["frozen V1 workspace", "response shield", "same PostgreSQL migration", "FINAL replay", "Domain Event snapshot"],
  async (ctx) => {
    const v1 = requireV1Workspace(ctx);
    const family = ctx.fixtures.migration();
    await v1.migrate();
    await v1.seed(family.seed);
    const v1Api = await v1.startApi();
    const shield = await v1.responseShield(v1Api.baseUrl);
    const body = ctx.fixtures.submissionBody("e02-saved");
    const key = ctx.key("e02-saved");
    shield.dropNextMutation();
    await v1.mutate(shield.baseUrl, "/api/v1/permit-applications", key, body).catch(() => undefined);
    const saved = shield.captures.find(({ dropped }) => dropped);
    ctx.ok(saved, "V1 response saved after commit");
    const applicationId = findObject(captureJson(saved), "applicationId").applicationId;
    const conflictBody = ctx.fixtures.submissionBody("e02-conflict");
    const conflict = await v1.mutate(v1Api.baseUrl, "/api/v1/permit-applications", key, conflictBody);
    expectError(ctx, conflict, 409, "IDEMPOTENCY_CONFLICT");
    const savedRead = await v1.request(v1Api.baseUrl, `/api/v1/permit-applications/${applicationId}`);
    requireStatus(ctx, savedRead, 200, "V1 saved Application read");
    const before = await v1.snapshot(v1Api.baseUrl);
    ctx.assert("exact V1 replay snapshot", () => assertSnapshot(before, { final: false }));
    const beforeApplication = applicationFrom(before, applicationId);
    ctx.ok(beforeApplication, "dropped response committed one V1 Application");
    const savedReadAuthority = ctx.assert("saved V1 read closes aggregate authority", () => assertAggregateDetailAuthority(savedRead.json, before, applicationId, { final: false }));
    ctx.equal(savedReadAuthority.application, beforeApplication, "saved V1 read names committed Application exactly");
    const beforeEvents = before.events.filter(({ aggregateId }) => aggregateId === applicationId);
    ctx.ok(beforeEvents.length > 0, "saved V1 aggregate Event history nonempty");
    ctx.equal(new Set(beforeEvents.map(({ eventId }) => eventId)).size, beforeEvents.length, "saved V1 Event identities unique");
    await ctx.stop(v1Api);
    await ctx.migrate();
    const finalApi = await ctx.startApi();
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/permit-applications", key, body);
    ctx.assert("saved response status raw bytes and stable headers preserved", () => assertSavedHttpReplay(saved.response, replay), { hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"] });
    const conflictReplay = await ctx.mutate(finalApi.baseUrl, "/api/v1/permit-applications", key, conflictBody);
    ctx.assert("saved conflict status raw bytes and stable headers preserved", () => assertSavedHttpReplay(conflict, conflictReplay), { hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"] });
    const finalRead = await ctx.request(finalApi.baseUrl, `/api/v1/permit-applications/${applicationId}`);
    requireStatus(ctx, finalRead, 200, "FINAL saved Application read");
    const after = await snapshot(ctx, finalApi.baseUrl);
    const finalReadAuthority = ctx.assert("FINAL replay read closes migrated aggregate authority", () => assertAggregateDetailAuthority(finalRead.json, after, applicationId));
    ctx.equal(v1Application(finalReadAuthority.application), savedReadAuthority.application, "saved Application public fields survive exactly");
    ctx.equal(finalReadAuthority.revision, savedReadAuthority.revision, "saved current Revision survives exactly");
    ctx.equal(finalReadAuthority.claims, savedReadAuthority.claims, "saved Claim history survives exactly");
    ctx.equal(finalReadAuthority.decisions, savedReadAuthority.decisions, "saved Decision history survives exactly");
    ctx.equal(finalReadAuthority.permit, savedReadAuthority.permit, "saved Permit survives exactly");
    ctx.equal(after.events.filter(({ aggregateId }) => aggregateId === applicationId), beforeEvents, "saved Event identity body and sequence preserved", { hardCapIds: ["MIGRATION_COMPATIBILITY", "EVENT_ATOMICITY"] });
    ctx.equal(after.resources.permitApplications.filter(({ applicationId: id }) => id === applicationId).length, 1, "unknown response created one Application");
    return caseResult(ctx, { applicationId, savedStatus: saved.response.status, savedBodyBytes: Buffer.byteLength(saved.response.body), eventIds: beforeEvents.map(({ eventId }) => eventId) });
  },
  [blocked("PF-E02-LEGACY-MEDIA-TYPE", "PF-GAP-02")],
);

const e03 = defineCase(
  "E-03",
  "PF-F-MIGRATION pending Claim Work and Event",
  "Create a leased V1 Claim while due and future Deadline Work and undelivered Events exist, migrate in place, wait for expiry, reclaim publicly and drain with FINAL Worker and Dispatcher replacements",
  "Application, deadline, Claim and Work identities, attempts and lease facts survive; stale owners cannot commit; old event payloads deliver and FINAL roles process the inherited backlog",
  ["frozen V1 workspace", "leased Claim", "pending Deadline Work", "FINAL Worker and Dispatcher", "verification snapshot"],
  async (ctx) => {
    const v1 = requireV1Workspace(ctx);
    const family = ctx.fixtures.migration();
    await v1.migrate();
    await v1.seed(family.seed);
    const v1Api = await v1.startApi();
    const pending = family.histories.find(({ application }) => application.state === "SUBMITTED" && Date.parse(application.deadlineAt) > Date.now());
    const due = family.histories.find(({ application }) => application.state === "SUBMITTED" && Date.parse(application.deadlineAt) < Date.now());
    const reviewer = family.reviewers.find(({ roles }) => roles.includes("security"));
    const claim = await v1.mutate(v1Api.baseUrl, `/api/v1/permit-applications/${pending.application.applicationId}/review-claims`, ctx.key("e03-v1-claim"), { reviewerId: reviewer.reviewerId, role: "security" });
    requireStatus(ctx, claim, 200, "V1 leased Claim");
    const claimId = claimResource(claim.json).claimId;
    const before = await v1.snapshot(v1Api.baseUrl);
    ctx.assert("V1 pending authority snapshot", () => assertSnapshot(before, { final: false }));
    const oldClaim = resourceById(before.resources.reviewClaims, "claimId", claimId);
    ctx.assert("V1 leased Claim exact", () => assertReviewClaim(oldClaim));
    ctx.equal(oldClaim.state, "LEASED", "V1 Claim is visibly leased before migration");
    const dueWorkMatches = before.work.filter(({ aggregateId, terminal }) => aggregateId === due.application.applicationId && !terminal);
    const futureWorkMatches = before.work.filter(({ aggregateId, terminal }) => aggregateId === pending.application.applicationId && !terminal);
    ctx.equal(dueWorkMatches.length, 1, "V1 due Application has exactly one pending Deadline Work");
    ctx.equal(futureWorkMatches.length, 1, "V1 future Application has exactly one pending Deadline Work");
    const [dueWork] = dueWorkMatches;
    const [futureWork] = futureWorkMatches;
    ctx.assert("V1 due Work exact", () => assertWork(dueWork));
    ctx.assert("V1 future Work exact", () => assertWork(futureWork));
    ctx.equal(dueWork.state, "PENDING", "V1 due Work starts PENDING");
    ctx.equal(futureWork.state, "PENDING", "V1 future Work starts PENDING");

    let acknowledge = false;
    const receiver = await ctx.receiver({ behavior: () => ({ status: acknowledge ? 204 : 500 }) });
    const v1Dispatcher = await v1.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => receiver.ledger.some(({ responseStatus }) => responseStatus === 500) ? true : undefined, { label: "V1 undelivered Event attempt", timeoutMs: 120_000, processes: [v1Dispatcher] });
    const barrier = await ctx.barrier({ hold: ({ point, aggregateId, workId }) => {
      return point === "worker.claimed" && aggregateId === due.application.applicationId && workId === dueWork.workId;
    } });
    const v1Worker = await v1.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const heldEntry = await barrier.waitFor(({ json }) => json.point === "worker.claimed" && json.workId === dueWork.workId, { timeoutMs: 120_000, processes: [v1Worker] });
    const leased = await v1.snapshot(v1Api.baseUrl);
    ctx.assert("V1 held checkpoint exact", () => assertSnapshot(leased, { final: false }));
    const leasedDueWork = leased.work.find(({ workId }) => workId === dueWork.workId);
    ctx.assert("V1 actually leased Work exact", () => assertWork(leasedDueWork));
    ctx.equal(leasedDueWork.state, "LEASED", "V1 due Work is visibly LEASED at checkpoint");
    ctx.equal(leasedDueWork.attempt, dueWork.attempt + 1, "V1 Work claim increments attempt exactly once");
    ctx.equal(leasedDueWork.attempt, heldEntry.json.attempt, "barrier attempt equals persisted lease attempt");
    ctx.equal(leased.work.find(({ workId }) => workId === futureWork.workId), futureWork, "future pending Work remains unchanged at V1 checkpoint");
    const v1Events = leased.events;
    ctx.ok(v1Events.length > 0, "V1 checkpoint has Event backlog");
    ctx.equal(new Set(v1Events.map(({ eventId }) => eventId)).size, v1Events.length, "V1 Event backlog identities unique");
    await ctx.kill(v1Worker);
    await ctx.kill(v1Dispatcher);
    await ctx.stop(v1Api);
    await ctx.migrate();
    const finalApi = await ctx.startApi();
    const migrated = await snapshot(ctx, finalApi.baseUrl);
    const migratedClaim = resourceById(migrated.resources.reviewClaims, "claimId", claimId);
    ctx.equal(migratedClaim, oldClaim, "Claim identity lease and attempt survive migration");
    const migratedWork = migrated.work.find(({ workId }) => workId === dueWork.workId);
    ctx.equal(migratedWork, leasedDueWork, "leased Work identity attempt and lease facts survive migration");
    ctx.equal(migrated.work.find(({ workId }) => workId === futureWork.workId), futureWork, "pending future Work survives migration exactly");
    ctx.equal(migrated.events.filter(({ eventId }) => v1Events.some((event) => event.eventId === eventId)), v1Events, "all V1 Events survive migration exactly once");
    await ctx.sleep(Math.max(0, Date.parse(oldClaim.leaseExpiresAt) - Date.now() + 100));
    const reclaim = await ctx.mutate(finalApi.baseUrl, `/api/v1/permit-applications/${pending.application.applicationId}/review-claims`, ctx.key("e03-reclaim"), { reviewerId: reviewer.reviewerId, role: "security" });
    requireStatus(ctx, reclaim, 200, "FINAL Claim reclaim");
    const reclaimedResponse = claimResource(reclaim.json);
    ctx.assert("FINAL reclaimed Claim exact", () => assertReviewClaim(reclaimedResponse));
    ctx.equal(reclaimedResponse.claimId, oldClaim.claimId, "Claim reclaim retains identity");
    ctx.equal(reclaimedResponse.attempt, oldClaim.attempt + 1, "Claim reclaim increments attempt exactly once");
    const afterReclaim = await snapshot(ctx, finalApi.baseUrl);
    ctx.equal(resourceById(afterReclaim.resources.reviewClaims, "claimId", claimId), reclaimedResponse, "reclaimed Claim response equals persisted authority");
    await ctx.sleep(Math.max(0, Date.parse(migratedWork.leaseExpiresAt) - Date.now() + 100));
    acknowledge = true;
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const final = await waitSnapshot(ctx, finalApi.baseUrl, (value) => applicationFrom(value, due.application.applicationId)?.state === "EXPIRED" && value.work.find(({ workId }) => workId === dueWork.workId)?.terminal ? value : undefined, { label: "migrated backlog drain", timeoutMs: 180_000, processes: workers });
    await ctx.waitFor(() => v1Events.every(({ eventId }) => receiver.ledger.some(({ acknowledged: didAck, responseStatus, headers }) => didAck && responseStatus >= 200 && responseStatus < 300 && headers["x-permitforge-event-id"] === eventId)) ? receiver.ledger : undefined, { label: "complete V1 Event backlog delivery", timeoutMs: 180_000, processes: [dispatcher] });
    const reclaimed = claimsFor(final, pending.application.applicationId).find(({ claimId: id }) => id === claimId);
    ctx.equal(reclaimed, reclaimedResponse, "reclaimed Claim remains the migrated current authority");
    ctx.equal(applicationFrom(final, due.application.applicationId).state, "EXPIRED", "inherited due Application drained once");
    ctx.equal(applicationFrom(final, due.application.applicationId).deadlineAt, due.application.deadlineAt, "inherited Application deadline remains exact");
    const recoveredWork = final.work.find(({ workId }) => workId === dueWork.workId);
    ctx.assert("FINAL recovered Work exact", () => assertWork(recoveredWork));
    ctx.equal(recoveredWork.attempt, leasedDueWork.attempt + 1, "replacement advances inherited leased Work exactly once", { hardCapIds: ["WORK_FENCING"] });
    ctx.equal(recoveredWork.state, "SUCCEEDED", "replacement terminal result reflects expiry");
    ctx.equal(final.work.find(({ workId }) => workId === futureWork.workId), futureWork, "future Work identity remains pending and immutable");
    const staleAttemptEntries = barrier.ledger.filter(({ json }) => json.workId === dueWork.workId && json.attempt === leasedDueWork.attempt);
    ctx.ok(staleAttemptEntries.length > 0, "held stale attempt observed by barrier");
    ctx.ok(staleAttemptEntries.every(({ json }) => json.point === "worker.claimed"), "killed stale attempt never reaches effect or commit barrier", { hardCapIds: ["WORK_FENCING"] });
    ctx.equal(final.events.filter(({ aggregateId, type }) => aggregateId === due.application.applicationId && type === "application.expired").length, 1, "one inherited expiry Event");
    ctx.assert("all inherited webhook retry identities stable", () => assertRetryIdentity(receiver.ledger));
    return caseResult(ctx, { claimId, dueWorkId: dueWork.workId, leasedWorkAttempt: leasedDueWork.attempt, recoveredWorkAttempt: recoveredWork.attempt, reclaimedAttempt: reclaimed.attempt, inheritedEventIds: v1Events.map(({ eventId }) => eventId), deliveries: receiver.ledger.length });
  },
  [blocked("PF-E03-STALE-CLAIM-DECISION", "PF-GAP-01")],
);

function completeCurrentRead(response, expected) {
  if (response.status !== 200 || !response.json) return false;
  try {
    const applications = findObjects(response.json, "currentRevision").filter(({ applicationId, currentRevision }) => applicationId === expected.application.applicationId && Number.isSafeInteger(currentRevision));
    const revisions = findObjects(response.json, "canonicalDigest").filter(({ applicationId, fields }) => applicationId === expected.application.applicationId && fields !== undefined);
    const claims = findObjects(response.json, "claimId").filter(({ applicationId }) => applicationId === expected.application.applicationId);
    const decisions = findObjects(response.json, "decisionId").filter(({ applicationId }) => applicationId === expected.application.applicationId);
    const permits = findObjects(response.json, "permitId").filter(({ applicationId }) => applicationId === expected.application.applicationId);
    if (applications.length !== 1 || revisions.length !== 1 || permits.length > 1) return false;
    const [application] = applications;
    const [revision] = revisions;
    assertPermitApplication(application, { final: true });
    assertApplicationRevision(revision);
    claims.forEach(assertReviewClaim);
    decisions.forEach(assertReviewDecision);
    assertProjection(application, revision, decisions, permits[0]);
    return canonicalJson(application) === canonicalJson(expected.application)
      && canonicalJson(revision) === canonicalJson(expected.revision)
      && canonicalJson(claims) === canonicalJson(expected.claims)
      && canonicalJson(decisions) === canonicalJson(expected.decisions)
      && canonicalJson(permits) === canonicalJson(expected.permits);
  } catch {
    return false;
  }
}

const e04 = defineCase(
  "E-04",
  "PF-F-PERF exact perf-v1 current reads",
  "Load the exact 20k/2k/20k/20k/20k/10k perf-v1 seed and run 64 closed-loop clients for a disjoint 10-second warm-up and full 60-second measured round-robin current-read window",
  "Only complete revision-consistent 200 bodies count; measured throughput is at least 350/s, p95 at most 120 ms, unexpected 5xx zero and all post-load read authority remains unchanged",
  ["exact public perf seed", "64-client closed-loop HTTP", "60-second measured window", "verification snapshot"],
  async (ctx) => {
    const fixture = ctx.fixtures.performance();
    const seed = fixture.buildSeed();
    const family = { fixtureFamily: "PF-F-PERF", seed };
    const { api } = await boot(ctx, { family, seed, seedTimeoutMs: 900_000 });
    const targets = seed.permitApplications.filter(({ deadlineAt }) => Date.parse(deadlineAt) > Date.now()).map(({ applicationId }) => applicationId).sort();
    ctx.equal(targets.length, 10_000, "exact stable target population");
    const before = await snapshot(ctx, api.baseUrl, { timeoutMs: 60_000 });
    ctx.equal(before.resources.permitApplications.length, fixture.spec.applications, "exact pre-read Application population");
    ctx.equal(before.resources.applicationRevisions.length, fixture.spec.revisions, "exact pre-read Revision population");
    ctx.equal(before.resources.reviewClaims.length, fixture.spec.claims, "exact pre-read Claim population");
    ctx.equal(before.resources.reviewDecisions.length, 0, "fixed read seed has no Decision");
    ctx.equal(before.resources.approvedPermits.length, 0, "fixed read seed has no Permit");
    const seedApplications = new Map(seed.permitApplications.map((item) => [item.applicationId, item]));
    const seedRevisions = new Map(seed.applicationRevisions.map((item) => [item.applicationId, item]));
    const expected = new Map(targets.map((applicationId) => {
      const application = applicationFrom(before, applicationId);
      const revision = revisionsFor(before, applicationId).find(({ revision: number }) => number === application.currentRevision);
      const claims = claimsFor(before, applicationId);
      const decisions = decisionsFor(before, applicationId);
      const permits = before.resources.approvedPermits.filter((item) => item.applicationId === applicationId);
      ctx.equal(v1Application(application), seedApplications.get(applicationId), `${applicationId} fixed Application projection`);
      ctx.equal(revision, seedRevisions.get(applicationId), `${applicationId} fixed Revision authority`);
      ctx.equal(claims, seed.reviewClaims.filter((item) => item.applicationId === applicationId), `${applicationId} fixed Claim authority`);
      ctx.assert(`${applicationId} independent quorum and Permit projection`, () => assertProjection(application, revision, decisions, permits[0]));
      return [applicationId, { application, revision, claims, decisions, permits }];
    }));
    const operation = ({ ordinal }) => {
      const applicationId = targets[ordinal % targets.length];
      return ctx.request(api.baseUrl, `/api/v1/permit-applications/${applicationId}`, { timeoutMs: 10_000 }).then((response) => ({ ...response, applicationId }));
    };
    const accept = (response) => completeCurrentRead(response, expected.get(response.applicationId));
    const warmup = await closedLoop({ clients: fixture.spec.read.clients, durationMs: fixture.spec.read.warmupMs, operation, accept });
    assertMeasuredWindow(ctx, warmup, fixture.spec.read.warmupMs, "read warm-up");
    const measured = await closedLoop({ clients: fixture.spec.read.clients, durationMs: fixture.spec.read.measureMs, ordinalStart: warmup.nextOrdinal, operation, accept });
    assertMeasuredWindow(ctx, measured, fixture.spec.read.measureMs, "read measurement");
    ctx.ok(measured.throughput >= fixture.spec.read.minimumThroughput, `read throughput ${measured.throughput.toFixed(2)} >= ${fixture.spec.read.minimumThroughput}`);
    ctx.ok(measured.latency.p95 <= fixture.spec.read.maximumP95Ms, `read p95 ${measured.latency.p95.toFixed(2)} <= ${fixture.spec.read.maximumP95Ms}`);
    ctx.equal(measured.records.filter(({ value }) => value.status >= 500).length, 0, "read unexpected 5xx zero");
    const after = await snapshot(ctx, api.baseUrl, { timeoutMs: 60_000 });
    ctx.equal(stableSnapshot(after), stableSnapshot(before), "read load leaves every resource Work and Event bytewise-semantic unchanged", { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
    return caseResult(ctx, { accepted: measured.accepted.length, throughput: measured.throughput, p95Ms: measured.latency.p95, measuredMs: fixture.spec.read.measureMs });
  },
);

function submitPerfBody(ctx, seed, ordinal, phase) {
  const applicants = [...seed.applicants].sort((left, right) => left.applicantId.localeCompare(right.applicantId));
  const reviewers = [...seed.reviewers].sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  const reviewer = reviewers[ordinal % reviewers.length];
  return {
    applicantId: applicants[ordinal % applicants.length].applicantId,
    permitType: "PERF",
    fields: { phase, ordinal, canonical: `permit-${phase}-${String(ordinal).padStart(12, "0")}` },
    deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    reviewPolicy: { roles: [{ role: "reviewer", eligibleReviewerIds: [reviewer.reviewerId], requiredApprovals: 1, veto: false }], requiredTotalApprovals: 1 },
  };
}

function completeSubmit(response) {
  if (response.status !== 201 || !response.json) return false;
  try {
    const application = findObject(response.json, "applicationId");
    assertPermitApplication(application, { final: true });
    return application.state === "SUBMITTED" && application.currentRevision === 1;
  } catch {
    return false;
  }
}

export function assertMeasuredSubmissionClosure(state, accepted) {
  const applicationRows = groupBy(state.resources.permitApplications, ({ applicationId }) => applicationId);
  const revisionRows = groupBy(state.resources.applicationRevisions, ({ applicationId }) => applicationId);
  const stageRows = groupBy(state.resources.reviewStages, ({ applicationId }) => applicationId);
  const workRows = groupBy(state.work, ({ aggregateId }) => aggregateId);
  const eventRows = groupBy(state.events, ({ aggregateId }) => aggregateId);
  const claimRows = groupBy(state.resources.reviewClaims, ({ applicationId }) => applicationId);
  const decisionRows = groupBy(state.resources.reviewDecisions, ({ applicationId }) => applicationId);
  const permitRows = groupBy(state.resources.approvedPermits, ({ applicationId }) => applicationId);
  for (const item of accepted) {
    const applicationId = item.application.applicationId;
    const applications = applicationRows.get(applicationId) ?? [];
    assert.equal(applications.length, 1, `${applicationId} exact one measured Application`);
    const [application] = applications;
    assertPermitApplication(application, { final: true });
    assert.deepEqual(application, item.application, `${applicationId} response Application equals snapshot`);
    assert.equal(application.applicantId, item.body.applicantId, `${applicationId} Applicant captured`);
    assert.equal(application.permitType, item.body.permitType, `${applicationId} permit type captured`);
    assert.equal(application.deadlineAt, item.body.deadlineAt, `${applicationId} deadline captured`);
    assert.equal(application.currentRevision, 1, `${applicationId} current Revision 1`);
    assert.equal(application.state, "SUBMITTED", `${applicationId} remains SUBMITTED`);
    assert.equal(application.decisionRevision, null, `${applicationId} no Decision winner`);

    const revisions = revisionRows.get(applicationId) ?? [];
    assert.equal(revisions.length, 1, `${applicationId} exact one immutable Revision`);
    assertApplicationRevision(revisions[0]);
    // Revision authority is separately published by snapshot/detail, not invented in the create response.
    assert.equal(revisions[0].revision, 1, `${applicationId} Revision number`);
    assert.deepEqual(revisions[0].fields, item.body.fields, `${applicationId} fields captured`);
    assert.equal(revisions[0].canonicalDigest, sha256(canonicalJson(item.body.fields)), `${applicationId} canonical digest`);
    assert.deepEqual(revisions[0].policy, item.body.reviewPolicy, `${applicationId} policy captured`);

    const stages = stageRows.get(applicationId) ?? [];
    assert.equal(stages.length, 1, `${applicationId} exact one legacy Stage`);
    assertReviewStage(stages[0]);
    assert.equal(stages[0].revision, 1, `${applicationId} Stage Revision`);
    assert.equal(stages[0].ordinal, 1, `${applicationId} Stage ordinal`);
    assert.equal(stages[0].state, "ACTIVE", `${applicationId} Stage active`);
    assert.deepEqual(stages[0].policy, item.body.reviewPolicy, `${applicationId} Stage policy captured`);

    const work = workRows.get(applicationId) ?? [];
    assert.equal(work.length, 1, `${applicationId} exact one Deadline Work`);
    assertWork(work[0]);
    assert.equal(work[0].state, "PENDING", `${applicationId} Deadline Work pending`);
    assert.equal(work[0].terminal, false, `${applicationId} Deadline Work nonterminal`);
    assert.equal(work[0].leaseOwner, null, `${applicationId} Deadline Work unleased`);
    assert.equal(work[0].leaseExpiresAt, null, `${applicationId} Deadline Work lease expiry empty`);

    const events = eventRows.get(applicationId) ?? [];
    assert.equal(events.length, 1, `${applicationId} exact one submitted Event`);
    assertDomainEvent(events[0]);
    assert.equal(events[0].sequence, 1, `${applicationId} submitted Event sequence`);
    assert.equal(events[0].type, "application.submitted", `${applicationId} submitted Event type`);
    assert.deepEqual(events[0].payload, {}, `${applicationId} submitted Event payload`);
    assert.equal((claimRows.get(applicationId) ?? []).length, 0, `${applicationId} no Claim`);
    assert.equal((decisionRows.get(applicationId) ?? []).length, 0, `${applicationId} no Decision`);
    assert.equal((permitRows.get(applicationId) ?? []).length, 0, `${applicationId} no Permit`);
  }
  return true;
}

const e05 = defineCase(
  "E-05",
  "PF-F-PERF exact perf-v1 submissions",
  "Run 64 closed-loop clients for a 10-second warm-up and separate full 60-second measured POST window, advancing bytewise Applicant/policy combinations with fresh canonical fields and Idempotency-Keys",
  "Only complete 201 SUBMITTED Revision-1 bodies count; throughput is at least 100/s, p95 at most 350 ms, unexpected 5xx zero and each measured Application has one Revision, Deadline Work and submitted Event",
  ["exact public perf seed", "fresh public HTTP mutations", "64-client closed loop", "post-load verification snapshot"],
  async (ctx) => {
    const fixture = ctx.fixtures.performance();
    const seed = fixture.buildSeed();
    const family = { fixtureFamily: "PF-F-PERF", seed };
    const { api } = await boot(ctx, { family, seed, seedTimeoutMs: 900_000 });
    const run = (phase, offset, durationMs) => closedLoop({
      clients: fixture.spec.submit.clients,
      durationMs,
      ordinalStart: offset,
      operation: async ({ ordinal }) => {
        const body = submitPerfBody(ctx, seed, ordinal, phase);
        const response = await ctx.mutate(api.baseUrl, "/api/v1/permit-applications", ctx.key(`e05-${phase}-${ordinal}`), body, { timeoutMs: 10_000 });
        return { ...response, bodySent: body };
      },
      accept: completeSubmit,
    });
    const warmup = await run("warmup", 0, fixture.spec.submit.warmupMs);
    assertMeasuredWindow(ctx, warmup, fixture.spec.submit.warmupMs, "submit warm-up");
    const measured = await run("measured", warmup.nextOrdinal + 1_000_000, fixture.spec.submit.measureMs);
    assertMeasuredWindow(ctx, measured, fixture.spec.submit.measureMs, "submit measurement");
    ctx.ok(measured.throughput >= fixture.spec.submit.minimumThroughput, `submit throughput ${measured.throughput.toFixed(2)} >= ${fixture.spec.submit.minimumThroughput}`);
    ctx.ok(measured.latency.p95 <= fixture.spec.submit.maximumP95Ms, `submit p95 ${measured.latency.p95.toFixed(2)} <= ${fixture.spec.submit.maximumP95Ms}`);
    ctx.equal(measured.records.filter(({ value }) => value.status >= 500).length, 0, "submit unexpected 5xx zero");
    const warmupIds = new Set(warmup.accepted.map(({ value }) => findObject(value.json, "applicationId").applicationId));
    const accepted = measured.accepted.map(({ value }) => ({ application: findObject(value.json, "applicationId"), body: value.bodySent }));
    ctx.equal(new Set(accepted.map(({ application }) => application.applicationId)).size, accepted.length, "measured Application identities fresh");
    ctx.ok(accepted.every(({ application }) => !warmupIds.has(application.applicationId)), "warm-up and measured Application identities disjoint");
    const after = await snapshot(ctx, api.baseUrl, { timeoutMs: 60_000 });
    ctx.assert("every measured response closes exact Application Revision Stage Work and Event authority", () => assertMeasuredSubmissionClosure(after, accepted), { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
    return caseResult(ctx, { accepted: accepted.length, throughput: measured.throughput, p95Ms: measured.latency.p95, measuredMs: fixture.spec.submit.measureMs });
  },
);

function groupBy(items, select) {
  const grouped = new Map();
  for (const item of items) {
    const key = select(item);
    const values = grouped.get(key) ?? [];
    values.push(item);
    grouped.set(key, values);
  }
  return grouped;
}

export function assertDeadlineRecoveryHistories(initial, final, dueIds) {
  const initialApplications = groupBy(initial.resources.permitApplications, ({ applicationId }) => applicationId);
  const finalApplications = groupBy(final.resources.permitApplications, ({ applicationId }) => applicationId);
  const initialRevisions = groupBy(initial.resources.applicationRevisions, ({ applicationId }) => applicationId);
  const finalRevisions = groupBy(final.resources.applicationRevisions, ({ applicationId }) => applicationId);
  const initialClaims = groupBy(initial.resources.reviewClaims, ({ applicationId }) => applicationId);
  const finalClaims = groupBy(final.resources.reviewClaims, ({ applicationId }) => applicationId);
  const initialDecisions = groupBy(initial.resources.reviewDecisions, ({ applicationId }) => applicationId);
  const finalDecisions = groupBy(final.resources.reviewDecisions, ({ applicationId }) => applicationId);
  const initialPermits = groupBy(initial.resources.approvedPermits, ({ applicationId }) => applicationId);
  const finalPermits = groupBy(final.resources.approvedPermits, ({ applicationId }) => applicationId);
  const initialStages = groupBy(initial.resources.reviewStages, ({ applicationId }) => applicationId);
  const finalStages = groupBy(final.resources.reviewStages, ({ applicationId }) => applicationId);
  const initialEvents = groupBy(initial.events, ({ aggregateId }) => aggregateId);
  const finalEvents = groupBy(final.events, ({ aggregateId }) => aggregateId);
  const immutableApplicationFields = ["applicationId", "applicantId", "permitType", "currentRevision", "decisionRevision", "submittedAt", "deadlineAt", "currentStageOrdinal"];
  const stableStage = ({ stageId, applicationId, revision, ordinal, name, policy, activatedAt }) => ({ stageId, applicationId, revision, ordinal, name, policy, activatedAt });

  for (const applicationId of dueIds) {
    const beforeApplications = initialApplications.get(applicationId) ?? [];
    const afterApplications = finalApplications.get(applicationId) ?? [];
    assert.equal(beforeApplications.length, 1, `${applicationId} exact initial Application`);
    assert.equal(afterApplications.length, 1, `${applicationId} exact final Application`);
    const [beforeApplication] = beforeApplications;
    const [afterApplication] = afterApplications;
    assertPermitApplication(beforeApplication, { final: true });
    assertPermitApplication(afterApplication, { final: true });
    for (const field of immutableApplicationFields) assert.deepEqual(afterApplication[field], beforeApplication[field], `${applicationId} immutable Application ${field}`);
    assert.equal(beforeApplication.state, "SUBMITTED", `${applicationId} initially SUBMITTED`);
    assert.equal(afterApplication.state, "EXPIRED", `${applicationId} finally EXPIRED`);
    assert.equal(afterApplication.decisionRevision, null, `${applicationId} no Decision winner`);
    assert.ok(afterApplication.terminalAt !== null, `${applicationId} terminal timestamp present`);
    assert.equal(afterApplication.sequence, beforeApplication.sequence + 1, `${applicationId} exactly one committed transition`);

    assert.deepEqual(finalRevisions.get(applicationId) ?? [], initialRevisions.get(applicationId) ?? [], `${applicationId} Revision history immutable`);
    assert.deepEqual(finalClaims.get(applicationId) ?? [], initialClaims.get(applicationId) ?? [], `${applicationId} Claim history immutable`);
    assert.deepEqual(finalDecisions.get(applicationId) ?? [], initialDecisions.get(applicationId) ?? [], `${applicationId} Decision history immutable`);
    assert.equal((finalDecisions.get(applicationId) ?? []).length, 0, `${applicationId} no stale Decision committed`);
    assert.deepEqual(finalPermits.get(applicationId) ?? [], initialPermits.get(applicationId) ?? [], `${applicationId} Permit history immutable`);
    assert.equal((finalPermits.get(applicationId) ?? []).length, 0, `${applicationId} no Permit invented`);

    const beforeStages = initialStages.get(applicationId) ?? [];
    const afterStages = finalStages.get(applicationId) ?? [];
    assert.equal(beforeStages.length, 1, `${applicationId} exact initial legacy Stage`);
    assert.equal(afterStages.length, 1, `${applicationId} exact retained legacy Stage`);
    assertReviewStage(beforeStages[0]);
    assertReviewStage(afterStages[0]);
    assert.deepEqual(stableStage(afterStages[0]), stableStage(beforeStages[0]), `${applicationId} Stage identity Revision ordinal name policy immutable`);

    const beforeEvents = initialEvents.get(applicationId) ?? [];
    const afterEvents = finalEvents.get(applicationId) ?? [];
    assert.equal(beforeEvents.length, beforeApplication.sequence, `${applicationId} initial Event count matches aggregate sequence`);
    assertAggregateSequences(beforeEvents);
    assert.deepEqual(afterEvents.slice(0, beforeEvents.length), beforeEvents, `${applicationId} prior Event prefix immutable`);
    const added = afterEvents.slice(beforeEvents.length);
    assert.equal(added.length, 1, `${applicationId} exactly one recovery Event`);
    assertDomainEvent(added[0]);
    assert.equal(added[0].type, "application.expired", `${applicationId} recovery Event type`);
    assert.equal(added[0].sequence, afterApplication.sequence, `${applicationId} recovery Event sequence matches Application`);
    assertAggregateSequences(afterEvents);
  }
  return true;
}

const e06 = defineCase(
  "E-06",
  "PF-F-PERF exact 10k Deadline recovery",
  "Load perf-v1, hold exactly two Workers after distinct due Work claims, SIGKILL both, wait for lease expiry, spawn two replacements and time the full 10,000-Application drain",
  "Within 75 seconds every due Application is EXPIRED once, every matching Work is terminal at a replacement attempt, no Permit or stale commit exists and expiry Events are unique",
  ["exact public perf seed", "two worker.claimed barriers", "SIGKILL", "two replacement Workers", "post-load snapshot"],
  async (ctx) => {
    const fixture = ctx.fixtures.performance();
    const seed = fixture.buildSeed();
    const family = { fixtureFamily: "PF-F-PERF", seed };
    const { api } = await boot(ctx, { family, seed, seedTimeoutMs: 900_000 });
    const dueIds = new Set(seed.permitApplications.filter(({ deadlineAt }) => Date.parse(deadlineAt) < Date.now()).map(({ applicationId }) => applicationId));
    ctx.equal(dueIds.size, fixture.spec.recovery.applications, "exact due population");
    const initial = await snapshot(ctx, api.baseUrl, { timeoutMs: 60_000 });
    const initialDueWork = initial.work.filter(({ aggregateId }) => dueIds.has(aggregateId));
    ctx.equal(initialDueWork.length, fixture.spec.recovery.applications, "exact 10k due Work population");
    ctx.equal(new Set(initialDueWork.map(({ workId }) => workId)).size, initialDueWork.length, "10k due Work identities unique");
    ctx.equal(new Set(initialDueWork.map(({ aggregateId }) => aggregateId)).size, dueIds.size, "one due Work per Application");
    ctx.ok(initialDueWork.every(({ state, terminal }) => state === "PENDING" && !terminal), "all 10k due Work initially pending");
    initialDueWork.forEach(assertWork);
    const initialWorkById = new Map(initialDueWork.map((item) => [item.workId, item]));
    const heldWorkIds = new Set();
    const barrier = await ctx.barrier({ hold: ({ point, aggregateId, workId }) => {
      if (point !== "worker.claimed" || !dueIds.has(aggregateId)) return false;
      if (heldWorkIds.has(workId)) return true;
      if (heldWorkIds.size >= fixture.spec.recovery.workers) return false;
      heldWorkIds.add(workId);
      return true;
    } });
    const killed = await Promise.all(Array.from({ length: fixture.spec.recovery.workers }, () => ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } })));
    const heldEntries = await ctx.waitFor(() => {
      const entries = barrier.ledger.filter(({ json }) => json.point === "worker.claimed" && dueIds.has(json.aggregateId));
      return new Set(entries.map(({ json }) => json.workId)).size === fixture.spec.recovery.workers ? entries : undefined;
    }, { label: "two distinct held Deadline Work", timeoutMs: 120_000, processes: killed });
    const heldByWorkId = new Map();
    for (const entry of heldEntries) heldByWorkId.set(entry.json.workId, entry);
    ctx.equal(heldByWorkId.size, fixture.spec.recovery.workers, "exactly two distinct Work leases held");
    const leasedCheckpoint = await snapshot(ctx, api.baseUrl, { timeoutMs: 60_000 });
    for (const [workId, entry] of heldByWorkId) {
      const leasedWork = leasedCheckpoint.work.find((item) => item.workId === workId);
      ctx.assert(`${workId} held Work exact`, () => assertWork(leasedWork));
      ctx.equal(leasedWork.state, "LEASED", `${workId} visibly LEASED before SIGKILL`);
      ctx.equal(leasedWork.attempt, initialWorkById.get(workId).attempt + 1, `${workId} first claim increments attempt exactly once`);
      ctx.equal(leasedWork.attempt, entry.json.attempt, `${workId} barrier attempt equals persisted attempt`);
    }
    for (const worker of killed) await ctx.kill(worker);
    await ctx.sleep(3_300);
    const replacements = await Promise.all(Array.from({ length: fixture.spec.recovery.workers }, () => ctx.startWorker()));
    const startedAt = performance.now();
    const final = await waitSnapshot(ctx, api.baseUrl, (value) => {
      let expired = 0;
      for (const application of value.resources.permitApplications) if (dueIds.has(application.applicationId) && application.state === "EXPIRED") expired += 1;
      const nonterminal = value.work.some(({ aggregateId, terminal }) => dueIds.has(aggregateId) && !terminal);
      return expired === dueIds.size && !nonterminal ? value : undefined;
    }, { label: "10k Deadline recovery", timeoutMs: fixture.spec.recovery.deadlineMs, intervalMs: 500, requestTimeoutMs: 30_000, processes: replacements });
    const elapsedMs = performance.now() - startedAt;
    ctx.ok(elapsedMs <= fixture.spec.recovery.deadlineMs, `recovery ${elapsedMs.toFixed(0)}ms <= ${fixture.spec.recovery.deadlineMs}ms`);
    ctx.assert("exact post-recovery snapshot", () => assertSnapshot(final, { final: true }));
    ctx.assert("deadline recovery preserves every Revision Claim Stage and prior Event while adding one expiry transition", () => assertDeadlineRecoveryHistories(initial, final, dueIds), { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
    const dueApplications = final.resources.permitApplications.filter(({ applicationId }) => dueIds.has(applicationId));
    ctx.equal(dueApplications.length, dueIds.size, "all and only 10k due Applications retained");
    ctx.ok(dueApplications.every(({ state }) => state === "EXPIRED"), "all due Applications EXPIRED");
    ctx.equal(final.resources.approvedPermits.filter(({ applicationId }) => dueIds.has(applicationId)).length, 0, "due recovery invents no Permit");
    const finalDueWork = final.work.filter(({ workId }) => initialWorkById.has(workId));
    ctx.equal(finalDueWork.length, initialDueWork.length, "all 10k original Work identities retained exactly once");
    ctx.equal(new Set(finalDueWork.map(({ workId }) => workId)).size, initialDueWork.length, "final due Work identities remain unique");
    for (const recovered of finalDueWork) {
      const original = initialWorkById.get(recovered.workId);
      ctx.assert(`${recovered.workId} recovered Work exact`, () => assertWork(recovered));
      ctx.equal({ workId: recovered.workId, aggregateId: recovered.aggregateId, kind: recovered.kind }, { workId: original.workId, aggregateId: original.aggregateId, kind: original.kind }, `${recovered.workId} immutable Work identity tuple`);
      ctx.equal(recovered.state, "SUCCEEDED", `${recovered.workId} terminal expiry success`);
      ctx.equal(recovered.terminal, true, `${recovered.workId} terminal retained`);
      ctx.equal(recovered.leaseOwner, null, `${recovered.workId} final lease owner cleared`);
      ctx.equal(recovered.leaseExpiresAt, null, `${recovered.workId} final lease expiry cleared`);
      const heldEntry = heldByWorkId.get(recovered.workId);
      if (heldEntry) ctx.equal(recovered.attempt, heldEntry.json.attempt + 1, `${recovered.workId} held attempt recovered exactly once`, { hardCapIds: ["WORK_FENCING"] });
      else ctx.ok(recovered.attempt >= original.attempt + 1, `${recovered.workId} terminal processing advances attempt`, { hardCapIds: ["WORK_FENCING"] });
    }
    for (const [workId, entry] of heldByWorkId) {
      const staleAttemptEntries = barrier.ledger.filter(({ json }) => json.workId === workId && json.attempt === entry.json.attempt);
      ctx.ok(staleAttemptEntries.length > 0, `${workId} stale attempt observed`);
      ctx.ok(staleAttemptEntries.every(({ json }) => json.point === "worker.claimed"), `${workId} killed attempt never reaches effect or commit`, { hardCapIds: ["WORK_FENCING"] });
    }
    const expiryEvents = Map.groupBy(final.events.filter(({ aggregateId, type }) => dueIds.has(aggregateId) && type === "application.expired"), ({ aggregateId }) => aggregateId);
    ctx.equal(expiryEvents.size, dueIds.size, "every due Application has expiry Event");
    ctx.ok([...expiryEvents.values()].every((items) => items.length === 1), "each due Application expires exactly once", { hardCapIds: ["EVENT_ATOMICITY"] });
    return caseResult(ctx, { applications: dueIds.size, workers: replacements.length, elapsedMs });
  },
);

async function closeOwnedServer(record) {
  if (!record?.server || record.closed) return;
  record.closed = true;
  for (const socket of record.sockets ?? []) socket.destroy();
  record.server.closeAllConnections?.();
  if (!record.server.listening) return;
  await Promise.race([
    new Promise((resolve) => record.server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function assertClosedUrl(ctx, baseUrl, label) {
  const rejected = await ctx.request(baseUrl, "/healthz", { timeoutMs: 500 }).then(() => false).catch(() => true);
  ctx.ok(rejected, `${label} port closed`);
}

export function assertNoResidualLockPaths(stdout) {
  assert.equal(stdout.trim(), "", "managed root has no residual lock pid or socket path");
  return true;
}

function reproducibleDetailEvidence(detail, state, applicationId) {
  const authority = assertAggregateDetailAuthority(detail, state, applicationId);
  return {
    application: {
      applicantId: authority.application.applicantId,
      permitType: authority.application.permitType,
      currentRevision: authority.application.currentRevision,
      state: authority.application.state,
      decisionRevision: authority.application.decisionRevision,
      deadlineAt: authority.application.deadlineAt,
      terminalAt: authority.application.terminalAt,
      sequence: authority.application.sequence,
      stageCount: authority.application.stages.length,
      currentStageOrdinal: authority.application.currentStageOrdinal,
      stages: authority.application.stages.map(({ ordinal, name, policy, state: stageState }) => ({ ordinal, name, policy, state: stageState })),
    },
    revision: {
      revision: authority.revision.revision,
      fields: authority.revision.fields,
      canonicalDigest: authority.revision.canonicalDigest,
      policy: authority.revision.policy,
    },
    claims: authority.claims.map(({ revision, reviewerId, role, state: claimState, attempt }) => ({ revision, reviewerId, role, state: claimState, attempt })),
    decisions: authority.decisions.map(({ revision, reviewerId, role, decision, reason }) => ({ revision, reviewerId, role, decision, reason })),
    permit: authority.permit ? { revision: authority.permit.revision, canonicalDigest: authority.permit.canonicalDigest } : null,
    work: state.work.filter(({ aggregateId }) => aggregateId === applicationId).map(({ kind, state: workState, terminal, attempt }) => ({ kind, state: workState, terminal, attempt })),
    events: state.events.filter(({ aggregateId }) => aggregateId === applicationId).map(({ sequence, type, payload, schemaVersion }) => ({ sequence, type, payload, schemaVersion })),
  };
}

const e07 = defineCase(
  "E-07",
  "PF-F-V1-POLICY cleanup and deterministic replay",
  "Run the same public Submission and seed twice, normally terminate evaluator-owned API, Worker, Dispatcher and receiver resources, prove every listener closes, then reset the isolated database",
  "No owned process, port, lock or secret remains, and the same Submission plus seed produces the same public Application/Revision evidence digest on a fresh database",
  ["owned process groups", "managed data root", "public health HTTP", "database reset", "deterministic seed projection"],
  async (ctx) => {
    const family = ctx.fixtures.main("e07");
    const target = ctx.forWorkspace(ctx.workspace);
    const statusBefore = await target.command("git", ["status", "--porcelain", "--untracked-files=all"]);
    const runProjection = async () => {
      const receiver = await ctx.receiver();
      const { api } = await boot(ctx, { family });
      const worker = await ctx.startWorker();
      const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
      const body = ctx.fixtures.submissionBody("e07-repeatable");
      const key = ctx.key("e07-repeatable-submit");
      const created = await submitApplication(ctx, api.baseUrl, body, "e07 repeatable Submission", { key });
      const applicationId = created.application.applicationId;
      const detail = await ctx.request(api.baseUrl, `/api/v1/permit-applications/${applicationId}`);
      requireStatus(ctx, detail, 200, "reproducible submitted detail");
      const state = await snapshot(ctx, api.baseUrl);
      const semantic = reproducibleDetailEvidence(detail.json, state, applicationId);
      const digest = sha256(canonicalJson(semantic));
      const submittedEvents = state.events.filter(({ aggregateId }) => aggregateId === applicationId);
      ctx.ok(submittedEvents.length > 0, "repeatable Submission has non-vacuous Event evidence");
      await ctx.waitFor(() => submittedEvents.every(({ eventId }) => receiver.ledger.some(({ acknowledged, responseStatus, headers }) => acknowledged && responseStatus >= 200 && responseStatus < 300 && headers["x-permitforge-event-id"] === eventId)) ? true : undefined, { label: "repeatable Event delivery", timeoutMs: 120_000, processes: [dispatcher] });
      const processes = [api, worker, dispatcher];
      for (const process of [...processes].reverse()) await ctx.stop(process);
      ctx.ok(processes.every(({ stopped, forcedKill }) => stopped && !forcedKill), "API Worker and Dispatcher process groups terminate normally");
      const logText = processes.map(({ stdout, stderr }) => `${stdout ?? ""}${stderr ?? ""}`).join("\n");
      for (const process of processes.filter(({ baseUrl }) => baseUrl)) await assertClosedUrl(ctx, process.baseUrl, `${process.role} ${process.pid}`);
      await closeOwnedServer(receiver);
      await assertClosedUrl(ctx, receiver.baseUrl, "receiver");
      const locks = await target.command("find", [ctx.managedDataRoot, "-mindepth", "1", "(", "-type", "s", "-o", "-name", "*.lock", "-o", "-name", "*.pid", "-o", "-name", "*.sock", ")", "-print"], { allowFailure: true, timeoutMs: 10_000 });
      ctx.equal(locks.exitCode, 0, "managed root inspection succeeds");
      ctx.assert("managed root lock cleanup", () => assertNoResidualLockPaths(locks.stdout));
      const sessions = await target.command("psql", ["--dbname", ctx.postgresAdminUrl, "--tuples-only", "--no-align", "--command", `SELECT count(*) FROM pg_stat_activity WHERE datname='${ctx.databaseName}'`], { timeoutMs: 10_000 });
      ctx.equal(Number(sessions.stdout.trim()), 0, "normal termination leaves no database session or lock owner");
      const webhookBodies = receiver.ledger.map(({ raw }) => raw).filter(Boolean);
      assertExternalSecretBoundary(logText, ctx, [family.seed.seedVersion, JSON.stringify(family.seed), key, JSON.stringify(body), ...webhookBodies]);
      return { digest, semantic, logs: logText, receiver, processes, applicationId };
    };
    const first = await runProjection();
    await ctx.resetDatabase();
    const second = await runProjection();
    ctx.equal(second.semantic, first.semantic, "same Submission and seed reproduce semantic evidence");
    ctx.equal(second.digest, first.digest, "same seed public evidence digest reproducible");
    ctx.ok([...first.processes, ...second.processes].every(({ stopped, forcedKill }) => stopped && !forcedKill), "all owned process groups remain normally stopped");
    const statusAfter = await target.command("git", ["status", "--porcelain", "--untracked-files=all"]);
    ctx.equal(statusAfter.stdout, statusBefore.stdout, "candidate workspace unchanged by operability runs");
    const invalid = await target.npm("definitely-not-a-published-script", [], { allowFailure: true, timeoutMs: 30_000 });
    ctx.ok(invalid.exitCode !== 0, "invalid project command exits nonzero");
    return caseResult(ctx, { evidenceDigest: first.digest, processRuns: 2, stoppedProcesses: first.processes.length + second.processes.length, closedListeners: 4, workspaceUnchanged: true });
  },
);

export const E_CASES = Object.freeze([e01, e02, e03, e04, e05, e06, e07]);
