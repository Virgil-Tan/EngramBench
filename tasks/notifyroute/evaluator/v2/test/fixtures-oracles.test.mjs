import assert from "node:assert/strict";
import test from "node:test";

import { baseSeed, createFixtureFactory, notificationFixture, routeFixture } from "../fixtures/index.mjs";
import { canonicalJson, contentDigest, evaluateSuppression, nextWindow, projectRoute, reduceProviderFacts, sortEvents } from "../oracles/index.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "notifyroute-tests", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures deterministically freeze identities, time, keys and exact V1 seed collections", () => {
  assert.equal(fixtures.uuid("tenant"), fixtures.uuid("tenant"));
  assert.notEqual(fixtures.uuid("tenant"), fixtures.uuid("recipient"));
  assert.equal(fixtures.at({ seconds: 3 }), "2035-06-01T12:00:03.000Z");
  assert.match(fixtures.key("notify"), /^nr-a-01-notify-[a-f0-9]{18}$/u);
  assert.deepEqual(Object.keys(baseSeed(fixtures)), [
    "schemaVersion", "seedVersion", "importedAt", "tenants", "recipients", "channelEndpoints", "templates", "templateVersions",
    "routePolicies", "rateLimitPolicies", "notifications", "deliveries", "deliveryAttempts", "suppressions", "providerReceipts",
  ]);
});

test("route oracle freezes ordered fallback and only advances after failure or suppression", () => {
  const route = routeFixture(fixtures);
  assert.deepEqual(projectRoute(route.steps, []).eligibleOrdinals, [1]);
  assert.deepEqual(projectRoute(route.steps, [{ routeOrdinal: 1, state: "FAILED" }]).eligibleOrdinals, [2]);
  assert.deepEqual(projectRoute(route.steps, [{ routeOrdinal: 1, state: "ACCEPTED" }]).eligibleOrdinals, []);
});

test("suppression oracle applies monotonic ALL, channel and category scopes", () => {
  const value = notificationFixture(fixtures);
  const base = { recipientId: value.recipientId, category: value.category, channel: "EMAIL" };
  assert.equal(evaluateSuppression([], base), null);
  const channel = { suppressionId: "a", recipientId: value.recipientId, channel: "EMAIL", category: null, state: "ACTIVE", revision: 2 };
  const all = { suppressionId: "b", recipientId: value.recipientId, channel: "ALL", category: value.category, state: "ACTIVE", revision: 3 };
  assert.equal(evaluateSuppression([channel, all], base).revision, 3);
});

test("rate window and provider fact reduction use independent fixed examples", () => {
  assert.equal(nextWindow("2035-06-01T12:00:59.999Z", 60), "2035-06-01T12:01:00.000Z");
  const facts = [
    { kind: "attempt", providerRequestId: "stable", outcome: "TIMEOUT" },
    { kind: "receipt", providerRequestId: "stable", outcome: "DELIVERED", providerMessageId: "m-1" },
    { kind: "receipt", providerRequestId: "stable", outcome: "DELIVERED", providerMessageId: "m-1" },
  ];
  assert.deepEqual(reduceProviderFacts(facts), { state: "DELIVERED", providerRequestId: "stable", providerMessageId: "m-1" });
  assert.throws(() => reduceProviderFacts([...facts, { kind: "receipt", providerRequestId: "other", outcome: "FAILED", providerMessageId: "m-2" }]), /identity/u);
});

test("canonical content, digest and event order are deterministic", () => {
  assert.equal(canonicalJson({ z: 1, a: [0, -0] }), '{"a":[0,0],"z":1}');
  assert.match(contentDigest({ subject: "Hello", body: "Hi {{name}}" }), /^[a-f0-9]{64}$/u);
  const seed = baseSeed(fixtures);
  assert.equal(seed.templateVersions[0].contentDigest, contentDigest({ subject: seed.templateVersions[0].subject, body: seed.templateVersions[0].body }));
  const events = [{ aggregateId: "b", sequence: 1, eventId: "z" }, { aggregateId: "a", sequence: 2, eventId: "b" }, { aggregateId: "a", sequence: 1, eventId: "a" }];
  assert.deepEqual(sortEvents(events), [events[2], events[1], events[0]]);
});
