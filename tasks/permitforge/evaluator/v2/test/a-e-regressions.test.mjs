import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEventDelta,
  assertFailedV1MigrationRollback,
  assertLegacyStageBackfill,
  interruptPopulatedFinalMigration,
  migrationPauseTriggerSql,
  parseUniquePgSleepBackend,
} from "../cases/a.mjs";
import {
  assertDeadlineRecoveryHistories,
  assertExactV1MigrationClosure,
  assertMeasuredSubmissionClosure,
  assertNoResidualLockPaths,
} from "../cases/e.mjs";
import {
  assertAggregateDetailAuthority,
  assertClaimTuple,
  assertSavedHttpReplay,
  assertV1ResourceBijection,
  blocked,
  defineCase,
} from "../cases/helpers.mjs";
import { createFixtureFactory } from "../fixtures/index.mjs";

function factory(caseId) {
  return createFixtureFactory({ evaluationSeed: "permitforge-a-e-regression", caseId, baseTime: "2035-06-01T12:00:00.000Z" });
}

const V1_APPLICATION_FIELDS = ["applicationId", "applicantId", "currentRevision", "deadlineAt", "decisionRevision", "permitType", "sequence", "state", "submittedAt", "terminalAt"];
const projectV1Application = (value) => Object.fromEntries(V1_APPLICATION_FIELDS.map((name) => [name, value[name]]));

function submissionClosure(caseId, label = "submission") {
  const value = factory(caseId);
  const history = value.history(label, "SUBMITTED");
  const stage = {
    stageId: value.uuid(`${label}:stage`),
    applicationId: history.application.applicationId,
    revision: 1,
    ordinal: 1,
    name: "Legacy",
    state: "ACTIVE",
    policy: structuredClone(history.revision.policy),
    activatedAt: history.application.submittedAt,
    completedAt: null,
  };
  const application = { ...history.application, currentStageOrdinal: 1, stages: [stage] };
  const work = {
    workId: value.uuid(`${label}:work`),
    aggregateId: application.applicationId,
    kind: "PERMIT_DEADLINE",
    state: "PENDING",
    terminal: false,
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  const event = {
    eventId: value.uuid(`${label}:event:1`),
    aggregateId: application.applicationId,
    sequence: 1,
    type: "application.submitted",
    occurredAt: application.submittedAt,
    schemaVersion: 1,
    payload: {},
  };
  const resources = value.seedFromHistories(label, [history]);
  resources.permitApplications = [application];
  resources.reviewStages = [stage];
  const state = { asOf: value.at(), resources, work: [work], events: [event] };
  const body = {
    applicantId: application.applicantId,
    permitType: application.permitType,
    fields: structuredClone(history.revision.fields),
    deadlineAt: application.deadlineAt,
    reviewPolicy: structuredClone(history.revision.policy),
  };
  return { value, state, application, revision: history.revision, stage, work, event, body };
}

test("Claim tuple oracle rejects cross-Revision reviewer and role drift", () => {
  const value = factory("A-07");
  const item = value.history("claim-tuple", "SUBMITTED");
  const claim = {
    claimId: value.uuid("claim-tuple"),
    applicationId: item.application.applicationId,
    revision: 1,
    reviewerId: value.securityReviewers[0].reviewerId,
    role: "security",
    state: "LEASED",
    attempt: 1,
    leaseExpiresAt: value.at({ seconds: 3 }),
  };
  const tuple = { applicationId: claim.applicationId, revision: 1, reviewerId: claim.reviewerId, role: "security", state: "LEASED", attempt: 1 };
  assert.equal(assertClaimTuple(claim, tuple), true);
  assert.throws(() => assertClaimTuple({ ...claim, revision: 2 }, tuple));
  assert.throws(() => assertClaimTuple({ ...claim, reviewerId: value.securityReviewers[1].reviewerId }, tuple));
  assert.throws(() => assertClaimTuple({ ...claim, role: "legal" }, tuple));
});

test("aggregate detail authority requires exact current Revision Claims Decisions and Permit", () => {
  const value = factory("A-05");
  const item = value.history("approved-detail", "APPROVED");
  const resources = value.seedFromHistories("approved-detail", [item]);
  const state = { resources };
  const detail = {
    application: item.application,
    currentRevision: item.revision,
    reviewClaims: item.claims,
    reviewDecisions: item.decisions,
    approvedPermit: item.permits[0],
  };
  const authority = assertAggregateDetailAuthority(detail, state, item.application.applicationId, { final: false });
  assert.deepEqual(authority.decisions, item.decisions);
  assert.deepEqual(authority.permit, item.permits[0]);
  assert.throws(() => assertAggregateDetailAuthority({ ...detail, reviewDecisions: item.decisions.slice(1) }, state, item.application.applicationId, { final: false }));
  assert.throws(() => assertAggregateDetailAuthority({ ...detail, currentRevision: { ...item.revision, fields: { changed: true } } }, state, item.application.applicationId, { final: false }));
  assert.throws(() => assertAggregateDetailAuthority({ ...detail, approvedPermit: undefined }, state, item.application.applicationId, { final: false }));
});

test("migration resource bijection rejects duplicate missing and mutated V1 identities", () => {
  const value = factory("E-01");
  const item = value.history("migration-bijection", "APPROVED");
  const before = value.seedFromHistories("migration-bijection", [item]);
  const after = structuredClone(before);
  after.permitApplications = after.permitApplications.map((application) => ({ ...application, currentStageOrdinal: 1, stages: [] }));
  assert.equal(assertV1ResourceBijection(before, after, { projectApplication: projectV1Application }), true);
  const duplicate = structuredClone(after);
  duplicate.reviewDecisions.push(structuredClone(duplicate.reviewDecisions[0]));
  assert.throws(() => assertV1ResourceBijection(before, duplicate, { projectApplication: projectV1Application }));
  const missing = structuredClone(after);
  missing.reviewClaims.pop();
  assert.throws(() => assertV1ResourceBijection(before, missing, { projectApplication: projectV1Application }));
  const changed = structuredClone(after);
  changed.approvedPermits[0].canonicalDigest = "0".repeat(64);
  assert.throws(() => assertV1ResourceBijection(before, changed, { projectApplication: projectV1Application }));
});

test("exact migration closure rejects extra resources Work Events and Stages", () => {
  const { value, state, application, stage, work, event } = submissionClosure("E-01", "migration-closure");
  const beforeResources = structuredClone(state.resources);
  delete beforeResources.reviewStages;
  beforeResources.permitApplications = beforeResources.permitApplications.map(projectV1Application);
  const before = { ...state, resources: beforeResources };
  assert.equal(assertExactV1MigrationClosure(before, state), true);

  const extraResource = structuredClone(state);
  extraResource.resources.applicants.push({ applicantId: value.uuid("extra-applicant"), name: "extra" });
  assert.throws(() => assertExactV1MigrationClosure(before, extraResource));
  const extraWork = structuredClone(state);
  extraWork.work.push({ ...work, workId: value.uuid("extra-work") });
  assert.throws(() => assertExactV1MigrationClosure(before, extraWork));
  const extraEvent = structuredClone(state);
  extraEvent.events.push({ ...event, eventId: value.uuid("extra-event"), sequence: 2, type: "review.claimed" });
  assert.throws(() => assertExactV1MigrationClosure(before, extraEvent));
  const extraStage = structuredClone(state);
  extraStage.resources.reviewStages.push({ ...stage, stageId: value.uuid("extra-stage") });
  assert.throws(() => assertExactV1MigrationClosure(before, extraStage));
  assert.equal(application.applicationId, stage.applicationId);
});

test("failed populated V1 to FINAL migration exposes no partial public state", () => {
  const fixture = submissionClosure("A-02", "failed-final-migration");
  const before = structuredClone(fixture.state);
  delete before.resources.reviewStages;
  before.resources.permitApplications = before.resources.permitApplications.map(projectV1Application);
  assert.equal(assertFailedV1MigrationRollback(before, structuredClone(before)), true);

  const partialStage = structuredClone(before);
  partialStage.resources.reviewStages = [fixture.stage];
  assert.throws(() => assertFailedV1MigrationRollback(before, partialStage), /unchanged|partial/u);

  const partialApplication = structuredClone(before);
  partialApplication.resources.permitApplications[0].currentStageOrdinal = 1;
  assert.throws(() => assertFailedV1MigrationRollback(before, partialApplication), /unchanged|partial/u);

  const rewrittenHistory = structuredClone(before);
  rewrittenHistory.events[0].payload = { migrated: true };
  assert.throws(() => assertFailedV1MigrationRollback(before, rewrittenHistory), /unchanged|partial/u);
});

test("A-02 pauses the first completed DDL without candidate connection metadata", () => {
  const sql = migrationPauseTriggerSql({ functionName: "pf_a02_pause_test", triggerName: "pf_a02_trigger_test" });
  assert.match(sql, /ON ddl_command_end/iu);
  assert.match(sql, /PERFORM pg_sleep\(60\)/u);
  assert.doesNotMatch(sql, /application_name|current_setting|nextval|sequence|ddl_ordinal/iu);
});

test("A-02 identifies one sleeping migration backend without application_name or a DDL ordinal", () => {
  assert.equal(parseUniquePgSleepBackend("4242\n"), 4242);
  assert.throws(() => parseUniquePgSleepBackend(""), /exactly one/iu);
  assert.throws(() => parseUniquePgSleepBackend("4242\n4343\n"), /exactly one/iu);
  assert.throws(() => parseUniquePgSleepBackend("not-a-pid\n"), /positive PostgreSQL PID/iu);
});

test("A-02 migration interruption needs neither application_name nor a second DDL", async () => {
  const sql = [];
  let migrationOptions;
  let resolveMigration;
  const ctx = {
    caseId: "A-02",
    databaseUrl: "postgresql://postgres@127.0.0.1/permitforge_a02",
    sleep: async () => {},
    migrate: (options) => {
      migrationOptions = options;
      return new Promise((resolve) => { resolveMigration = resolve; });
    },
    command: async (_binary, args) => {
      const statement = args[args.indexOf("--command") + 1];
      sql.push(statement);
      if (statement.startsWith("SELECT pid FROM pg_stat_activity")) return { exitCode: 0, stdout: "4242\n", stderr: "" };
      if (statement.includes("pid=4242") && statement.includes("pg_terminate_backend")) {
        resolveMigration({ exitCode: 1, signal: null });
        return { exitCode: 0, stdout: "1\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  assert.deepEqual(await interruptPopulatedFinalMigration(ctx), { observed: 1, terminated: 1, exitCode: 1, signal: null });
  assert.deepEqual(migrationOptions, { allowFailure: true, timeoutMs: 90_000 });
  assert.match(sql[0], /ON ddl_command_end/iu);
  assert.doesNotMatch(sql.join("\n"), /application_name|ddl_ordinal|nextval|CREATE SEQUENCE/iu);
});

test("saved HTTP replay oracle compares status raw bytes and stable headers", () => {
  const saved = { status: 201, body: "{\"ok\":true}", headers: { "content-type": "application/json", "content-length": "11", etag: "\"saved\"" } };
  const replay = { status: 201, text: "{\"ok\":true}", headers: new Headers({ "content-type": "application/json", "content-length": "11", etag: "\"saved\"" }) };
  assert.equal(assertSavedHttpReplay(saved, replay), true);
  assert.throws(() => assertSavedHttpReplay(saved, { ...replay, status: 200 }));
  assert.throws(() => assertSavedHttpReplay(saved, { ...replay, text: "{\"ok\":false}" }));
  assert.throws(() => assertSavedHttpReplay(saved, { ...replay, headers: new Headers({ "content-type": "application/json", "content-length": "12", etag: "\"saved\"" }) }));
});

test("A-12 transition oracle rejects wrong type duplicate and rewritten history", () => {
  const value = factory("A-12");
  const aggregateId = value.uuid("aggregate");
  const first = { eventId: value.uuid("event-1"), aggregateId, sequence: 1, type: "application.submitted", occurredAt: value.at(), schemaVersion: 1, payload: {} };
  const second = { eventId: value.uuid("event-2"), aggregateId, sequence: 2, type: "review.claimed", occurredAt: value.at({ milliseconds: 1 }), schemaVersion: 1, payload: {} };
  assert.equal(assertEventDelta([], [first], aggregateId, ["application.submitted"]), true);
  assert.equal(assertEventDelta([first], [first, second], aggregateId, ["review.claimed"]), true);
  assert.throws(() => assertEventDelta([first], [first, { ...second, type: "application.expired" }], aggregateId, ["review.claimed"]));
  assert.throws(() => assertEventDelta([first], [first, second, { ...second, eventId: value.uuid("duplicate-transition"), sequence: 3 }], aggregateId, ["review.claimed"]));
  assert.throws(() => assertEventDelta([first], [{ ...first, payload: { changed: true } }, second], aggregateId, ["review.claimed"]));
});

test("A-15 legacy Stage closure rejects missing duplicate and wrong-policy backfills", () => {
  const { value, state } = submissionClosure("A-15", "legacy-stage");
  assert.equal(assertLegacyStageBackfill(state.resources), true);
  const missing = structuredClone(state.resources);
  missing.reviewStages = [];
  assert.throws(() => assertLegacyStageBackfill(missing));
  const duplicate = structuredClone(state.resources);
  duplicate.reviewStages.push({ ...duplicate.reviewStages[0], stageId: value.uuid("duplicate-stage") });
  assert.throws(() => assertLegacyStageBackfill(duplicate));
  const wrongPolicy = structuredClone(state.resources);
  wrongPolicy.reviewStages[0].policy.requiredTotalApprovals += 1;
  assert.throws(() => assertLegacyStageBackfill(wrongPolicy));
});

test("E-05 measured submission closure rejects partial or duplicated effects", () => {
  const fixture = submissionClosure("E-05", "measured");
  const accepted = [{ application: fixture.application, revision: fixture.revision, body: fixture.body }];
  assert.equal(assertMeasuredSubmissionClosure(fixture.state, accepted), true);
  const duplicateRevision = structuredClone(fixture.state);
  duplicateRevision.resources.applicationRevisions.push(structuredClone(fixture.revision));
  assert.throws(() => assertMeasuredSubmissionClosure(duplicateRevision, accepted));
  const terminalWork = structuredClone(fixture.state);
  Object.assign(terminalWork.work[0], { state: "SUCCEEDED", terminal: true });
  assert.throws(() => assertMeasuredSubmissionClosure(terminalWork, accepted));
  const extraEvent = structuredClone(fixture.state);
  extraEvent.events.push({ ...fixture.event, eventId: fixture.value.uuid("measured-extra-event"), sequence: 2, type: "review.claimed" });
  assert.throws(() => assertMeasuredSubmissionClosure(extraEvent, accepted));
  const missingStage = structuredClone(fixture.state);
  missingStage.resources.reviewStages = [];
  assert.throws(() => assertMeasuredSubmissionClosure(missingStage, accepted));
});

test("E-06 recovery closure rejects changed deadlines extra history and wrong terminal Event", () => {
  const fixture = submissionClosure("E-06", "deadline-recovery");
  const initial = structuredClone(fixture.state);
  const final = structuredClone(fixture.state);
  const applicationId = fixture.application.applicationId;
  Object.assign(final.resources.permitApplications[0], { state: "EXPIRED", terminalAt: fixture.value.at({ seconds: 2 }), sequence: 2 });
  Object.assign(final.resources.reviewStages[0], { state: "TERMINAL", completedAt: fixture.value.at({ seconds: 2 }) });
  final.resources.permitApplications[0].stages = [structuredClone(final.resources.reviewStages[0])];
  final.events.push({ ...fixture.event, eventId: fixture.value.uuid("deadline-expired-event"), sequence: 2, type: "application.expired", occurredAt: fixture.value.at({ seconds: 2 }) });
  assert.equal(assertDeadlineRecoveryHistories(initial, final, new Set([applicationId])), true);

  const changedDeadline = structuredClone(final);
  changedDeadline.resources.permitApplications[0].deadlineAt = fixture.value.at({ days: 9 });
  assert.throws(() => assertDeadlineRecoveryHistories(initial, changedDeadline, new Set([applicationId])));
  const extraRevision = structuredClone(final);
  extraRevision.resources.applicationRevisions.push({ ...fixture.revision, revision: 2, createdAt: fixture.value.at({ seconds: 1 }) });
  assert.throws(() => assertDeadlineRecoveryHistories(initial, extraRevision, new Set([applicationId])));
  const extraDecision = structuredClone(final);
  extraDecision.resources.reviewDecisions.push({ decisionId: fixture.value.uuid("stale-decision"), applicationId, revision: 1, reviewerId: fixture.value.securityReviewers[0].reviewerId, role: "security", decision: "APPROVE", reason: "stale", decidedAt: fixture.value.at({ seconds: 1 }) });
  assert.throws(() => assertDeadlineRecoveryHistories(initial, extraDecision, new Set([applicationId])));
  const wrongEvent = structuredClone(final);
  wrongEvent.events[1].type = "application.approved";
  assert.throws(() => assertDeadlineRecoveryHistories(initial, wrongEvent, new Set([applicationId])));
});

test("fail-closed diagnostics never swallow a real operation failure", async () => {
  const diagnostic = blocked("PF-TEST-BLOCKED", "PF-GAP-01");
  const failing = defineCase("T-FAIL", "fixture", "action", "oracle", [], async () => { throw new Error("real candidate failure"); }, [diagnostic]);
  await assert.rejects(failing.run({}), /real candidate failure/u);
  const passing = defineCase("T-PASS", "fixture", "action", "oracle", [], async () => ({ status: "passed" }), [diagnostic]);
  assert.deepEqual(await passing.run({}), { status: "passed", diagnostics: [diagnostic] });
});

test("managed-root cleanup oracle permits data but rejects residual lock artifacts", () => {
  assert.equal(assertNoResidualLockPaths("\n"), true);
  assert.throws(() => assertNoResidualLockPaths("/tmp/permitforge/worker.pid\n"));
});
