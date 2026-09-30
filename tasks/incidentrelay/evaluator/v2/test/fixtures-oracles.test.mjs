import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { acknowledgementQuorum, assertEventSequence, assertOneActiveDedup, assertWork, canonicalJson, chooseLegacyAcknowledge, freezePolicy, notificationQuorum, recursivelyOmitTokens, retryDelaySeconds, schedule, tupleSort } from "../oracles/index.mjs";

const factory = createFixtureFactory({ evaluationSeed: "seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures are deterministic task-local and seed remains exactly V1", () => {
  const first = factory.quorum(["http://127.0.0.1:1/n", "http://127.0.0.1:2/n", "http://127.0.0.1:3/n"]);
  const second = createFixtureFactory({ evaluationSeed: "seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" }).quorum(["http://127.0.0.1:1/n", "http://127.0.0.1:2/n", "http://127.0.0.1:3/n"]);
  const serializable = (fixture) => Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== "incidentBody"));
  assert.equal(canonicalJson(serializable(first)), canonicalJson(serializable(second)));
  assert.equal(first.fixtureFamily, "IR-F-QUORUM");
  assert.deepEqual(Object.keys(first.seed).sort(), ["escalationPolicies", "escalationSteps", "incidents", "notificationDeliveries", "responders", "schemaVersion", "seedVersion", "services"].sort());
  assert.deepEqual(Object.keys(first.service).sort(), ["currentPolicyId", "currentPolicyVersion", "name", "serviceId"].sort());
  assert.deepEqual(Object.keys(first.incidentBody("x")).sort(), ["dedupKey", "details", "serviceId", "severity", "title"].sort());
});

test("independent schedule retry and quorum oracles close exact math", () => {
  const fixture = factory.quorum();
  const frozen = freezePolicy(fixture.policyGroup);
  assert.deepEqual(frozen.steps[0].responderIds, [...frozen.steps[0].responderIds].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))));
  const scheduled = schedule(fixture.policyGroup, "2035-06-01T12:00:00.000Z");
  assert.deepEqual(scheduled.map(({ dueAt }) => dueAt), ["2035-06-01T12:00:00.000Z", "2035-06-01T12:00:20.000Z"]);
  assert.deepEqual([1, 2, 3, 7, 8].map(retryDelaySeconds), [1, 2, 4, 60, 60]);
  const deliveries = frozen.steps[0].responderIds.map((responderId, index) => ({ responderId, state: index < 2 ? "DELIVERED" : "PENDING" }));
  assert.deepEqual(notificationQuorum(frozen.steps[0], deliveries), { deliveredCount: 2, sent: true });
  assert.deepEqual(acknowledgementQuorum(frozen.steps[0], deliveries.map(({ responderId }, index) => ({ responderId, stepIndex: 0, state: index < 2 ? "DELIVERED" : "PENDING" }))), { acknowledgementCount: 3, reached: true });
  assert.equal(chooseLegacyAcknowledge([{ stepIndex: 2, state: "SENT", responderId: "r" }, { stepIndex: 1, state: "SENT", responderId: "r" }], "r").stepIndex, 1);
});

test("snapshot invariants sort omit tokens and conserve Work and Events", () => {
  assert.deepEqual(recursivelyOmitTokens({ leaseToken: "x", nested: { safe: 1, authToken: "y" } }), { nested: { safe: 1 } });
  assert.deepEqual(tupleSort([{ id: "b" }, { id: "a" }], ["id"]).map(({ id }) => id), ["a", "b"]);
  assert.equal(assertOneActiveDedup([{ serviceId: "s", dedupKey: "k", state: "ACKNOWLEDGED" }, { serviceId: "s", dedupKey: "k", state: "RESOLVED" }]), true);
  assert.throws(() => assertOneActiveDedup([{ serviceId: "s", dedupKey: "k", state: "OPEN" }, { serviceId: "s", dedupKey: "k", state: "ACKNOWLEDGED" }]));
  assert.equal(assertWork([{ workId: "w", state: "LEASED", terminal: false, leaseOwner: "a", leaseExpiresAt: "x" }, { workId: "x", state: "SUCCEEDED", terminal: true, leaseOwner: null, leaseExpiresAt: null }]), true);
  assert.equal(assertEventSequence([{ aggregateId: "a", sequence: 2 }, { aggregateId: "a", sequence: 1 }, { aggregateId: "b", sequence: 1 }]), true);
});
