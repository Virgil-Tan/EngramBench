import assert from "node:assert/strict";
import test from "node:test";

import {
  D01_FROZEN_ROUTES,
  D01_OPERATION_CONTRACTS,
  D07_EVALUATOR_WORKLOAD,
  D08_HIDDEN_CASE_IDS,
  D08_LEGACY_EXCLUDED_IDS,
  D08_LEDGER_NODES,
  D08_REQUIREMENT_CHAINS,
  assertExactPublishedSchema,
  assertExecutableCaseEvidence,
  assertEvaluatorOwnedPerformanceTraffic,
  assertNonzeroTestReport,
  assertPermitForgePerformanceReport,
  assertProjectGateObservation,
  assertRequirementLayerEvidence,
  assertRecoveryBarrierEvidence,
} from "../cases/d.mjs";
import { CASES } from "../cases/index.mjs";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { createMissingV1CheckpointOutcome, PERMITFORGE_EVIDENCE_LAYERS } from "../lib/execution.mjs";
import { orderCasesForExecution } from "../run.mjs";

const PERFORMANCE_REPORT = `
application-current-read
clients=64 warmupSeconds=10 measureSeconds=60
p50=40 p95=100 p99=115 throughput=400 successful=24000 unexpected5xx=0 mixedRevisions=0
application-submit
clients=64 warmupSeconds=10 measureSeconds=60
p50=120 p95=300 p99=340 throughput=125 successful=7500 unexpected5xx=0 partialRevisions=0
permit-deadline-recovery
workers=2 applications=10000 p50=0 p95=0 p99=0 elapsedSeconds=70 backlogRemaining=0 staleDecisions=0 inventedPermits=0
perf-v1 applicants=20000 reviewers=2000 permitApplications=20000 applicationRevisions=20000 reviewClaims=20000 dueWork=10000
postLoadInvariants=passed
`;

function privateSummary(caseId, layers = ["HTTP"]) {
  return {
    schemaVersion: 1,
    caseId,
    observedEventCount: layers.length,
    layers: Object.fromEntries(layers.map((layer) => [layer, 1])),
    artifactRefs: layers.map((layer, index) => ({ layer, kind: `${layer} observed`, count: 1, ref: index.toString(16).padStart(64, "0") })),
  };
}

function directTrafficClosure() {
  const value = createFixtureFactory({ evaluationSeed: "permitforge-d07-traffic", caseId: "D-07", baseTime: "2035-06-01T12:00:00.000Z" });
  const histories = ["existing", "submitted-a", "submitted-b"].map((label) => value.history(label, "SUBMITTED"));
  const close = (history, label) => {
    const stage = {
      stageId: value.uuid(`${label}:stage`), applicationId: history.application.applicationId, revision: 1, ordinal: 1,
      name: "Legacy", state: "ACTIVE", policy: structuredClone(history.revision.policy),
      activatedAt: history.application.submittedAt, completedAt: null,
    };
    const application = { ...history.application, currentStageOrdinal: 1, stages: [stage] };
    const work = {
      workId: value.uuid(`${label}:work`), aggregateId: application.applicationId, kind: "PERMIT_DEADLINE",
      state: "PENDING", terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null,
    };
    const event = {
      eventId: value.uuid(`${label}:event`), aggregateId: application.applicationId, sequence: 1,
      type: "application.submitted", occurredAt: application.submittedAt, schemaVersion: 1, payload: {},
    };
    const body = {
      applicantId: application.applicantId, permitType: application.permitType, fields: structuredClone(history.revision.fields),
      deadlineAt: application.deadlineAt, reviewPolicy: structuredClone(history.revision.policy),
    };
    return { application, revision: history.revision, stage, work, event, body };
  };
  const items = histories.map((history, index) => close(history, `item-${index}`));
  const state = (selected) => {
    const resources = value.seedFromHistories("d07-direct", histories.slice(0, selected.length));
    delete resources.schemaVersion;
    delete resources.seedVersion;
    resources.permitApplications = selected.map(({ application }) => application).sort((left, right) => left.applicationId.localeCompare(right.applicationId));
    resources.applicationRevisions = selected.map(({ revision }) => revision).sort((left, right) => left.applicationId.localeCompare(right.applicationId));
    resources.reviewStages = selected.map(({ stage }) => stage).sort((left, right) => left.applicationId.localeCompare(right.applicationId));
    return {
      asOf: value.at(), resources,
      work: selected.map(({ work }) => work).sort((left, right) => left.workId.localeCompare(right.workId)),
      events: selected.map(({ event }) => event).sort((left, right) => left.aggregateId.localeCompare(right.aggregateId)),
    };
  };
  const before = state(items.slice(0, 1));
  const after = state(items);
  const detail = (item) => ({ application: item.application, currentRevision: item.revision, reviewClaims: [], reviewDecisions: [] });
  const reads = [0, 1].map((apiIndex) => ({
    apiIndex,
    path: `/api/v1/permit-applications/${items[0].application.applicationId}`,
    applicationId: items[0].application.applicationId,
    response: { status: 200, json: detail(items[0]) },
  }));
  const submissions = items.slice(1).map((item, apiIndex) => ({
    apiIndex,
    path: "/api/v1/permit-applications",
    body: item.body,
    response: { status: 201, json: { application: item.application, applicationRevision: item.revision } },
  }));
  return { before, after, reads, submissions };
}

test("D-01 freezes exact statuses parameters and public mutation headers", () => {
  assert.deepEqual(Object.keys(D01_OPERATION_CONTRACTS), D01_FROZEN_ROUTES);
  assert.deepEqual(D01_OPERATION_CONTRACTS["POST /api/v1/permit-applications"].statuses, ["201", "400", "409", "415"]);
  for (const [route, contract] of Object.entries(D01_OPERATION_CONTRACTS)) {
    assert.ok(contract.statuses.includes("200") || contract.statuses.includes("201"), `${route} success status`);
    assert.equal(new Set(contract.statuses).size, contract.statuses.length, `${route} statuses unique`);
    if (route.startsWith("POST ")) {
      assert.ok(contract.parameters.some((item) => item.in === "header" && item.name === "Idempotency-Key" && item.required === true && item.minLength === 1 && item.maxLength === 128), `${route} exact idempotency header`);
    }
    for (const parameter of contract.parameters) {
      if (parameter.in === "path" && /Id$/u.test(parameter.name)) assert.equal(parameter.format, "uuid", `${route} ${parameter.name} uuid format`);
    }
  }
  assert.deepEqual(D01_OPERATION_CONTRACTS["GET /api/v1/domain-events"].parameters.map(({ name, required }) => [name, required]), [["aggregateId", true], ["afterSequence", true], ["limit", true]]);
});

test("D-01 exact published schema rejects nested format enum closure and OAS 3.0 nullable mutants", () => {
  const uuid = "9f8fe98e-b16f-4b20-aea7-e8d84ba029d1";
  const document = {
    openapi: "3.1.0",
    components: {},
    paths: {},
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["claimId", "createdAt", "leaseExpiresAt", "schemaVersion", "state"],
    properties: {
      claimId: { type: "string", format: "uuid" },
      createdAt: { type: "string", format: "date-time" },
      leaseExpiresAt: { type: ["string", "null"], format: "date-time" },
      schemaVersion: { type: "integer", const: 1 },
      state: { type: "string", enum: ["LEASED", "DECIDED", "EXPIRED"] },
    },
  };
  const value = { claimId: uuid, createdAt: "2026-01-01T00:00:00.000Z", leaseExpiresAt: null, schemaVersion: 1, state: "LEASED" };
  assert.equal(assertExactPublishedSchema(document, schema, value), true);
  for (const mutate of [
    (copy) => { delete copy.properties.claimId.format; },
    (copy) => { copy.properties.state.enum.push("OTHER"); },
    (copy) => { copy.additionalProperties = true; },
    (copy) => { copy.required = copy.required.filter((name) => name !== "state"); },
    (copy) => { copy.properties.leaseExpiresAt = { type: "string", format: "date-time", nullable: true }; },
    (copy) => { delete copy.properties.schemaVersion.const; },
  ]) {
    const broken = structuredClone(schema);
    mutate(broken);
    assert.throws(() => assertExactPublishedSchema(document, broken, value));
  }
});

test("D-07 performance report oracle enforces scale windows thresholds and postconditions", () => {
  assert.equal(assertPermitForgePerformanceReport(PERFORMANCE_REPORT), true);
  assert.throws(() => assertPermitForgePerformanceReport(PERFORMANCE_REPORT.replace("clients=64", "clients=32")), /read clients/u);
  assert.throws(() => assertPermitForgePerformanceReport(PERFORMANCE_REPORT.replace("throughput=400", "throughput=349")), /read throughput/u);
  assert.throws(() => assertPermitForgePerformanceReport(PERFORMANCE_REPORT.replace("backlogRemaining=0", "backlogRemaining=1")), /remaining backlog/u);
  assert.throws(() => assertPermitForgePerformanceReport(PERFORMANCE_REPORT.replace("dueWork=10000", "dueWork=9999")), /seed due Work/u);
  assert.throws(() => assertPermitForgePerformanceReport(PERFORMANCE_REPORT.replace("postLoadInvariants=passed", "postLoadInvariants=failed")), /post-load invariants/u);
});

test("D-07 evaluator-owned traffic closes real read and submit responses against the snapshot", () => {
  const fixture = directTrafficClosure();
  const options = { apiCount: 2, reads: 2, submissions: 2 };
  assert.equal(assertEvaluatorOwnedPerformanceTraffic(fixture.before, fixture.after, fixture, options), true);
  assert.deepEqual(D07_EVALUATOR_WORKLOAD, { apiCount: 2, reads: 64, submissions: 16 });

  const oneApi = structuredClone(fixture);
  oneApi.reads[1].apiIndex = 0;
  assert.throws(() => assertEvaluatorOwnedPerformanceTraffic(oneApi.before, oneApi.after, oneApi, options), /two|API|api/u);

  const fakeRead = structuredClone(fixture);
  fakeRead.reads[0].response.json.currentRevision.fields = { fake: true };
  assert.throws(() => assertEvaluatorOwnedPerformanceTraffic(fakeRead.before, fakeRead.after, fakeRead, options), /Revision|authority|snapshot|digest/u);

  const partialSubmit = structuredClone(fixture);
  partialSubmit.after.work = partialSubmit.after.work.slice(0, -1);
  assert.throws(() => assertEvaluatorOwnedPerformanceTraffic(partialSubmit.before, partialSubmit.after, partialSubmit, options), /Work|delta|submission/u);

  const inventedEvent = structuredClone(fixture);
  inventedEvent.after.events.push({ ...inventedEvent.after.events.at(-1), eventId: "6fa459ea-ee8a-4ca4-894e-db77e160355e", sequence: 2 });
  assert.throws(() => assertEvaluatorOwnedPerformanceTraffic(inventedEvent.before, inventedEvent.after, inventedEvent, options), /Event|delta|submission/u);
});

test("D-07 rejects zero-test and print-only project gates", () => {
  assert.equal(assertNonzeroTestReport("TAP version 13\n# tests 4\n# pass 4", "unit"), true);
  assert.throws(() => assertNonzeroTestReport("TAP version 13\n# tests 0\n# pass 0", "unit"), /zero executed tests/u);
  assert.throws(() => assertNonzeroTestReport("all tests passed", "unit"), /nonzero executed test count/u);
});

test("D-07 gate and recovery evidence reject sleeper, fake topology and unbound replacement mutants", () => {
  const observation = {
    databaseConnections: 4,
    databaseTransactionDelta: 20_000,
    databaseTupleDelta: 20_000,
    maxApiProcesses: 2,
    maxWorkerProcesses: 2,
    maxChromiumProcesses: 1,
    maxHttpListeners: 2,
    maxHttpEstablished: 1,
    maxDescendants: 6,
    uniqueWorkerProcessCount: 4,
    workerPidDisappearances: 2,
  };
  const requirements = { databaseConnections: 4, databaseTransactionDelta: 20_000, databaseTupleDelta: 20_000, maxApiProcesses: 2, maxWorkerProcesses: 2, maxChromiumProcesses: 1, maxHttpListeners: 2, maxHttpEstablished: 1, uniqueWorkerProcessCount: 4, workerPidDisappearances: 2 };
  assert.equal(assertProjectGateObservation(observation, requirements), true);
  for (const field of Object.keys(requirements)) assert.throws(() => assertProjectGateObservation({ ...observation, [field]: 0 }, requirements), new RegExp(field, "u"));

  const workId = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
  const aggregateId = "7fa459ea-ee8a-4ca4-894e-db77e160355e";
  const dispatcher = { json: { processRole: "dispatcher", point: "dispatcher.response-received", workId: "8fa459ea-ee8a-4ca4-894e-db77e160355e", aggregateId, attempt: 1 } };
  const ledger = [
    { json: { processRole: "worker", point: "worker.claimed", workId, aggregateId, attempt: 1 } },
    { json: { processRole: "worker", point: "worker.claimed", workId, aggregateId, attempt: 2 } },
    dispatcher,
  ];
  assert.equal(assertRecoveryBarrierEvidence(ledger).recoveredWorkCount, 1);
  assert.throws(() => assertRecoveryBarrierEvidence(ledger.slice(0, 2)), /dispatcher/u);
  assert.throws(() => assertRecoveryBarrierEvidence([{ ...ledger[0], json: { ...ledger[0].json, workId: "fake" } }, ledger[1], dispatcher]), /Work identity/u);
  assert.throws(() => assertRecoveryBarrierEvidence([ledger[0], { ...ledger[1], json: { ...ledger[1].json, aggregateId: "8fa459ea-ee8a-4ca4-894e-db77e160355e" } }, dispatcher]), /replacement attempts/u);
});

test("D-08 ledger maps every frozen hidden Case and never self-certifies a requirement", () => {
  assert.deepEqual(D08_REQUIREMENT_CHAINS.map(({ node }) => node), D08_LEDGER_NODES);
  const mapped = [...new Set(D08_REQUIREMENT_CHAINS.flatMap(({ hiddenCases }) => hiddenCases))].sort();
  assert.deepEqual(mapped, [...D08_HIDDEN_CASE_IDS].sort());
  assert.deepEqual(mapped, CASES.map(({ id }) => id).sort());
  for (const item of D08_REQUIREMENT_CHAINS) {
    assert.ok(item.layers.includes("hidden-case"), item.node);
    assert.ok(item.hiddenCases.some((caseId) => caseId !== "D-08"), `${item.node} has independent evidence`);
    assert.ok(item.requirement.length > 20, `${item.node} names the frozen requirement`);
  }
});

test("D-08 consumes executable outcomes, fails closed on unrun/failed, and executes last without changing frozen result order", () => {
  const digest = "a".repeat(64);
  const outcomes = D08_HIDDEN_CASE_IDS.filter((id) => id !== "D-08").map((id) => ({ id, status: "passed", evidenceDigest: digest, privateEvidenceSummary: privateSummary(id) }));
  const complete = assertExecutableCaseEvidence(outcomes);
  assert.equal(complete.passed, 47);
  assert.equal(complete.partial, 0);
  const diagnostic = outcomes.map((item) => item.id === "D-01" ? { ...item, status: "diagnostic", diagnostics: [{ assertionId: "PF-D01-CLAIM-SUCCESS-ENVELOPE" }] } : item);
  assert.equal(assertExecutableCaseEvidence(diagnostic).partial, 1);
  assert.throws(() => assertExecutableCaseEvidence(outcomes.slice(1)), /unrun/u);
  assert.throws(() => assertExecutableCaseEvidence(outcomes.map((item) => item.id === "A-01" ? { ...item, status: "failed" } : item)), /is failed/u);
  assert.throws(() => assertExecutableCaseEvidence(outcomes.map((item) => item.id === "A-01" ? { ...item, evidenceDigest: "" } : item)), /executable evidence/u);
  assert.throws(() => assertExecutableCaseEvidence(outcomes.map((item) => item.id === "A-01" ? { ...item, privateEvidenceSummary: { ...item.privateEvidenceSummary, caseId: "other" } } : item)), /task-local evidence summary/u);

  const singleRoute = outcomes.map((item) => D08_LEGACY_EXCLUDED_IDS.includes(item.id)
    ? createMissingV1CheckpointOutcome({ id: item.id, prerequisites: ["V1"] })
    : item);
  const retired = assertExecutableCaseEvidence(singleRoute);
  assert.equal(retired.passed, 44);
  assert.equal(retired.partial, 0);
  assert.equal(retired.excluded, 3);
  assert.equal(retired.evidence["E-01"].privateEvidenceSummary, undefined);
  assert.throws(() => assertExecutableCaseEvidence(singleRoute.map((item) => item.id === "E-01"
    ? { ...item, evidenceDigest: digest }
    : item)), /valid single-route V1 exclusion/u);

  const definitions = [{ id: "A-01" }, { id: "D-08" }, { id: "E-01" }];
  assert.deepEqual(orderCasesForExecution(definitions).map(({ id }) => id), ["A-01", "E-01", "D-08"]);
  assert.deepEqual(definitions.map(({ id }) => id), ["A-01", "D-08", "E-01"]);
});

test("D-08 requirement matrix consumes observed layers and fails closed when cited evidence is absent", () => {
  const digest = "a".repeat(64);
  const outcomes = D08_HIDDEN_CASE_IDS.filter((id) => id !== "D-08").map((id) => ({
    id,
    status: "passed",
    evidenceDigest: digest,
    privateEvidenceSummary: privateSummary(id, PERMITFORGE_EVIDENCE_LAYERS),
  }));
  const complete = assertExecutableCaseEvidence(outcomes);
  assert.equal(assertRequirementLayerEvidence(complete.evidence), true);
  const singleRoute = assertExecutableCaseEvidence(outcomes.map((item) => D08_LEGACY_EXCLUDED_IDS.includes(item.id)
    ? createMissingV1CheckpointOutcome({ id: item.id, prerequisites: ["V1"] })
    : item));
  assert.equal(assertRequirementLayerEvidence(singleRoute.evidence), true);
  const mutated = structuredClone(complete.evidence);
  for (const id of ["A-12", "C-08"]) {
    delete mutated[id].privateEvidenceSummary.layers.event;
    mutated[id].privateEvidenceSummary.artifactRefs = mutated[id].privateEvidenceSummary.artifactRefs.filter(({ layer }) => layer !== "event");
    mutated[id].privateEvidenceSummary.observedEventCount -= 1;
  }
  assert.throws(() => assertRequirementLayerEvidence(mutated), /transactional-event lacks observed event/u);
});
