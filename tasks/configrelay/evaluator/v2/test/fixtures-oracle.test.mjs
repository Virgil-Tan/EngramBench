import assert from "node:assert/strict";
import test from "node:test";
import { agentCatalog, createFixtureFactory, performanceContract, performanceSeed, seededAssignment, seededLegacyDeployment, stagedPlan, v1Seed } from "../lib/fixtures.mjs";
import { affectedAgents, basisPoints, canonical, cohortVerdict, digestMembers, reconcileSnapshot, sha256 } from "../lib/oracle.mjs";

const fixtures = createFixtureFactory({ evaluationSeed:"fixture", caseId:"B-03", baseTime:"2035-06-01T12:00:00.000Z" });

test("fixtures deterministically freeze IDs, keys, time and exact V1 seed members", () => {
  assert.equal(fixtures.uuid("agent"), fixtures.uuid("agent"));
  assert.notEqual(fixtures.uuid("agent"), fixtures.uuid("fleet"));
  assert.equal(fixtures.at({ seconds:3 }), "2035-06-01T12:00:03.000Z");
  assert.match(fixtures.key("deploy"), /^cr-deploy-[0-9a-f]{24}$/u);
  assert.deepEqual(Object.keys(v1Seed(fixtures)), ["schemaVersion","seedVersion","fleets","agents","configurations","deployments","assignments"]);
});

test("independent canonicalizer and target oracle reproduce RFC 8785 examples", () => {
  const value = { z:-0, a:[3,{ "\u20ac":"Euro", "\r":"CR" }], n:1e30 };
  assert.equal(canonical(value), '{"a":[3,{"\\r":"CR","€":"Euro"}],"n":1e+30,"z":0}');
  assert.equal(sha256(value), sha256(canonical(value)));
  assert.equal(digestMembers(["b","a"]), sha256("a\nb"));
  assert.throws(() => canonical("\ud800"), /surrogate/u);
});

test("basis-point health uses integer floor and deadline moves missing to failure", () => {
  assert.equal(basisPoints(4, 7), 5714);
  assert.equal(basisPoints(3, 7), 4285);
  assert.deepEqual(cohortVerdict({ targetCount:7, successCount:4, failureCount:2, pendingCount:1, minimumSuccessBasisPoints:5714, maximumFailureBasisPoints:4285 }, { deadline:true }), { successCount:4, failureCount:3, pendingCount:0, state:"SUCCEEDED" });
  assert.equal(cohortVerdict({ targetCount:7, successCount:4, failureCount:2, pendingCount:1, minimumSuccessBasisPoints:5715, maximumFailureBasisPoints:4285 }, { deadline:true }).state, "FAILED");
});

test("rollback affected-set includes only changed APPLY acknowledgements from current and earlier Cohorts", () => {
  const commands = [
    { agentId:"a", cohortOrdinal:0, kind:"APPLY", state:"ACKED", fromRevision:1, toRevision:2 },
    { agentId:"b", cohortOrdinal:1, kind:"APPLY", state:"ACKED", fromRevision:2, toRevision:2 },
    { agentId:"c", cohortOrdinal:1, kind:"APPLY", state:"SENT", fromRevision:1, toRevision:2 },
    { agentId:"d", cohortOrdinal:2, kind:"APPLY", state:"ACKED", fromRevision:1, toRevision:2 }
  ];
  assert.deepEqual(affectedAgents(commands, 1), ["a"]);
});

test("staged fixture partitions its immutable outer target exactly once", () => {
  const catalog = agentCatalog(fixtures, { count:7 });
  const plan = stagedPlan(catalog, 3);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map(({ selector }) => selector.labels.key), ["cohort","cohort","cohort"]);
  assert.equal(new Set(catalog.agents.map(({ labels }) => labels.cohort)).size, 3);
});

test("scaled perf fixture retains published cardinality ratios and formal contract is exact", () => {
  const seed = performanceSeed(fixtures, .001), perf = performanceContract(.001);
  assert.deepEqual([seed.fleets.length,seed.agents.length,seed.configurations.length,seed.deployments.length,seed.assignments.length], [perf.seed.fleetCount,perf.seed.agentCount,perf.seed.configurationCount,perf.seed.deploymentCount,perf.seed.assignmentCount]);
  assert.deepEqual(performanceContract().poll, { concurrency:64,warmupSeconds:10,measureSeconds:60,targetPerSecond:2000,p95Ms:80,agentCount:100000,commandCount:50000 });
  assert.deepEqual(performanceContract().delivery, { concurrency:2,maximumSeconds:120,assignmentCount:50000 });
});

test("snapshot oracle rejects token leaks and reconciles cohort, command and rollback references", () => {
  assert.throws(() => reconcileSnapshot({ asOf:fixtures.at(), resources:{agents:[],configurations:[],deployments:[],assignments:[],acknowledgements:[],deploymentCohorts:[],rolloutCommands:[{assignmentToken:"secret"}],deploymentRollbacks:[]}, work:[], events:[] }), /Token/u);
});

test("snapshot oracle accepts a closed sorted token-redacted FINAL view", () => {
  const catalog = agentCatalog(fixtures,{ count:1 }), deployment = seededLegacyDeployment(fixtures,catalog), assignment = seededAssignment(fixtures,deployment,catalog.agents[0],0,{ digest:catalog.configuration.canonicalDigest });
  const { assignmentToken: _token,...redactedAssignment } = assignment;
  const agent = { ...catalog.agents[0],desiredRevision:1,desiredDigest:catalog.configuration.canonicalDigest,drift:true };
  assert.equal(reconcileSnapshot({ asOf:fixtures.at(),resources:{ agents:[agent],configurations:[catalog.configuration],deployments:[deployment],assignments:[redactedAssignment],acknowledgements:[],deploymentCohorts:[],rolloutCommands:[],deploymentRollbacks:[] },work:[],events:[] }),true);
});
