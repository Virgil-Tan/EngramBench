import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { canaryBucket, chooseBackend, chooseRoute, freezeStages, matchPattern, normalizePath, rateWindowStart } from "../oracles/index.mjs";

const options = { evaluationSeed: "f".repeat(64), caseId: "A-01", baseTime: "2035-07-01T12:00:00.000Z" };

test("fixtures are deterministic task-local and V1 seed-complete", () => {
  const left = createFixtureFactory(options), right = createFixtureFactory(options);
  assert.equal(left.uuid("x"), right.uuid("x"));
  assert.equal(left.key("x"), right.key("x"));
  assert.deepEqual(left.routing(["http://127.0.0.1:1", "http://127.0.0.1:2"]), right.routing(["http://127.0.0.1:1", "http://127.0.0.1:2"]));
  assert.deepEqual(Object.keys(left.contract().seed).sort(), ["backends", "circuitPolicies", "circuitWindows", "configReleases", "gatewayRequests", "importedAt", "rateLimitPolicies", "rateWindows", "routeDefinitions", "routeRevisions", "schemaVersion", "seedVersion", "tenants", "upstreamAttempts"]);
});

test("route oracle closes normalization matching precedence and exact canary intervals", () => {
  assert.deepEqual(matchPattern("/shops/:shopId/items/:itemId", "/shops/a/items/b"), { matched: true, parameters: { shopId: "a", itemId: "b" } });
  assert.equal(matchPattern("/shops/*", "/shops/a/items/b").matched, true);
  for (const path of ["/a//b", "/a/%2f/b", "/a/../b", "/%ZZ"]) assert.throws(() => normalizePath(path));
  const routes = [
    { routeId: "b", priority: 100, pathPattern: "/shops/*", methods: ["GET"], headerMatches: [] },
    { routeId: "c", priority: 100, pathPattern: "/shops/:shopId/items/:itemId", methods: ["GET"], headerMatches: [] },
    { routeId: "a", priority: 100, pathPattern: "/shops/:shopId/items/:itemId", methods: ["GET"], headerMatches: [] },
  ];
  assert.equal(chooseRoute(routes, { method: "GET", path: "/shops/a/items/b" }).routeId, "a");
  const bucket = canaryBucket("tenant", "revision", "affinity");
  assert.ok(bucket >= 0 && bucket < 10_000);
  assert.equal(chooseBackend([{ version: "v1", weight: bucket + 1 }, { version: "v2", weight: 9_999 - bucket }], bucket).version, "v1");
});

test("rollout and rate reference models preserve exact boundaries", () => {
  assert.deepEqual(freezeStages([{ region: "a", minimumObservationSeconds: 1, failureThresholdPercent: 0 }, { region: "b", minimumObservationSeconds: 2, failureThresholdPercent: 100 }, { region: "a", minimumObservationSeconds: 9, failureThresholdPercent: 9 }], "prior", "target"), [
    { ordinal: 0, region: "a", minimumObservationSeconds: 1, failureThresholdPercent: 0, priorConfigReleaseId: "prior", targetConfigReleaseId: "target" },
    { ordinal: 1, region: "b", minimumObservationSeconds: 2, failureThresholdPercent: 100, priorConfigReleaseId: "prior", targetConfigReleaseId: "target" },
  ]);
  assert.equal(rateWindowStart(Date.parse("2035-07-01T12:00:59.999Z"), 60), "2035-07-01T12:00:00.000Z");
  assert.equal(rateWindowStart(Date.parse("2035-07-01T12:01:00.000Z"), 60), "2035-07-01T12:01:00.000Z");
});
