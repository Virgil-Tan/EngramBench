import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory, createPerformanceSeed } from "../fixtures/index.mjs";
import { assertCapacityConservation, assertDockChainOpenApi, dockChainOpenApiRoutes, overlaps, selectBundle } from "../oracles/index.mjs";
import { runClosedLoop } from "../cases/helpers.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "dockchain-test", caseId: "B-02", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures are deterministic, task-local, and cover every DockChain family", () => {
  const again = createFixtureFactory({ evaluationSeed: "dockchain-test", caseId: "B-02", baseTime: "2035-06-01T12:00:00.000Z" }); assert.equal(fixtures.uuid("call"), again.uuid("call")); assert.match(fixtures.key("create"), /^dc-/u); assert.equal(fixtures.empty().fixtureFamily, "DC-F-EMPTY"); assert.equal(fixtures.resourceGrid().fixtureFamily, "DC-F-RESOURCE-GRID"); assert.equal(fixtures.portCall().fixtureFamily, "DC-F-PORT-CALL"); assert.equal(fixtures.standby().fixtureFamily, "DC-F-STANDBY"); assert.equal(fixtures.idempotency().fixtureFamily, "DC-F-IDEMPOTENCY"); assert.equal(fixtures.work().fixtureFamily, "DC-F-WORK"); assert.equal(fixtures.event().fixtureFamily, "DC-F-EVENT"); assert.equal(fixtures.linked().fixtureFamily, "DC-F-LINKED"); assert.equal(fixtures.migration().fixtureFamily, "DC-F-MIGRATION"); assert.equal(fixtures.browser().fixtureFamily, "DC-F-BROWSER"); assert.deepEqual(fixtures.performance().scenarioIds, ["feasible-window-read", "port-call-create", "clearance-recovery"]);
});

test("half-open and independent bundle oracle distinguish common allocation errors", () => {
  const fixture = fixtures.resourceGrid(); const left = { startAt: fixture.at({ days: 2 }), endAt: fixture.at({ days: 2, hours: 2 }) }; const adjacent = { startAt: left.endAt, endAt: fixture.at({ days: 2, hours: 4 }) }; const overlapping = { startAt: fixture.at({ days: 2, hours: 1, minutes: 45 }), endAt: fixture.at({ days: 2, hours: 3 }) }; assert.equal(overlaps(left, adjacent), false); assert.equal(overlaps(left, overlapping), true); const request = { ...fixture.v1Payload("oracle"), startAt: fixture.at({ days: 2, hours: 8 }), endAt: fixture.at({ days: 2, hours: 10 }) }; const reservations = [{ ...request, ownerId: "existing", berthId: fixture.berths[1].berthId, tugPoolId: fixture.tugPools[0].tugPoolId, yardWindowId: fixture.yardWindows[1].yardWindowId, requiredTugs: 2, containerUnits: 100 }]; assert.deepEqual(selectBundle({ berths: fixture.berths, tugPools: fixture.tugPools, yardWindows: fixture.yardWindows, vessels: fixture.vessels, reservations }, request), { berthId: fixture.berths[0].berthId, tugPoolId: fixture.tugPools[1].tugPoolId, yardWindowId: fixture.yardWindows[0].yardWindowId });
});

test("capacity oracle rejects Berth overlap and accepts exact endpoint adjacency", () => {
  const fixture = fixtures.resourceGrid(); const call = (id, startAt, endAt) => ({ portCallId: id, vesselId: fixture.vessels[0].vesselId, arrivalAt: startAt, departureAt: endAt, requiredTugs: 1, containerUnits: 25, berthId: fixture.berths[0].berthId, tugPoolId: fixture.tugPools[0].tugPoolId, yardWindowId: fixture.yardWindows[0].yardWindowId, state: "HELD" }); const base = { resources: { berths: fixture.berths, tugPools: fixture.tugPools, yardWindows: fixture.yardWindows, portMovements: [], portCalls: [call("a", fixture.at({ days: 2 }), fixture.at({ days: 2, hours: 2 })), call("b", fixture.at({ days: 2, hours: 2 }), fixture.at({ days: 2, hours: 4 }))] } }; assert.equal(assertCapacityConservation(base), true); base.resources.portCalls[1].arrivalAt = fixture.at({ days: 2, hours: 1, minutes: 45 }); assert.throws(() => assertCapacityConservation(base), /double-booked/u);
});

test("formal performance seed freezes exact public scale", () => { const formal = createPerformanceSeed(); assert.equal(formal.seed.berths.length, 1_000); assert.equal(formal.seed.tugPools.length, 20); assert.equal(formal.seed.yardWindows.length, 20); assert.equal(formal.seed.vessels.length, 100_000); assert.equal(formal.seed.portCalls.length, 51_500); assert.equal(formal.seed.portCalls.filter(({ state }) => state === "COMPLETED").length, 50_000); assert.equal(formal.seed.portCalls.filter(({ state }) => state === "HELD").length, 1_500); assert.equal(formal.seed.portCalls[1_000].arrivalAt, "2040-01-01T03:00:00.000Z"); assert.equal(formal.seed.portCalls[50_000].arrivalAt, "2040-01-08T00:00:00.000Z"); });

test("task-owned OpenAPI oracle freezes every DockChain route family and fails closed", () => { const routes = dockChainOpenApiRoutes(); assert.equal(Object.keys(routes).length, 15); assert.equal(Object.values(routes).reduce((sum, methods) => sum + Object.keys(methods).length, 0), 16); assert.throws(() => assertDockChainOpenApi({ openapi: "3.1.0", paths: {}, components: { schemas: {} } }), /missing OpenAPI schema/u); });

test("closed-loop load drains warm-up before an immutable measured phase", async () => {
  let warmupOutstanding = 0; let measureStartedBeforeWarmupDrain = false; const phases = [];
  const result = await runClosedLoop({
    clients: 2,
    warmupMs: 2,
    measureMs: 10,
    async operation({ phase, measuring, ordinal }) {
      phases.push({ phase, measuring, ordinal });
      if (phase === "warmup") warmupOutstanding += 1;
      else if (warmupOutstanding > 0) measureStartedBeforeWarmupDrain = true;
      await new Promise((resolve) => setTimeout(resolve, phase === "measure" ? 20 : 3));
      if (phase === "warmup") warmupOutstanding -= 1;
      return { status: 200 };
    },
  });
  assert.equal(measureStartedBeforeWarmupDrain, false);
  assert.equal(result.count, 2, "responses started inside the fixed measurement window are counted after drain");
  assert.equal(result.durationMs, 10);
  assert.equal(result.measureWindowMs, 10);
  assert.ok(result.measuredElapsedMs >= result.measureWindowMs);
  assert.equal(result.statuses.get(200), 2);
  assert.ok(phases.filter(({ phase }) => phase === "warmup").every(({ measuring }) => measuring === false));
  assert.ok(phases.filter(({ phase }) => phase === "measure").every(({ measuring }) => measuring === true));
  assert.deepEqual(phases.filter(({ phase }) => phase === "measure").map(({ ordinal }) => ordinal).sort((a, b) => a - b), [1, 2]);
});
