import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { computeSourceFixtureCommit } from "../../../scripts/materialize-source-fixture.mjs";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const managerPaths = [
  "/api/v1/consignments",
  "/api/v1/consignments/:consignmentId",
  "/api/v1/consignments/:consignmentId/reassign",
  "/api/v1/consignments/:consignmentId/cancel",
  "/api/v1/parcel-pieces/:pieceId/scan-events",
  "/api/v1/parcel-pieces/:pieceId/loss",
  "/api/v1/parcel-pieces/:pieceId/found",
];
const managerOnlyTokens = [
  "Consignment",
  "ParcelPiece",
  "PieceProjection",
  "CONSIGNMENT_PROJECT",
  "PIECE_REF_CONFLICT",
  "PIECE_TERMINAL",
  "CONSIGNMENT_TERMINAL",
  "EXPECTED_ROUTE_PLAN_REVISION_MISMATCH",
  ...managerPaths,
];
const managerContractTokens = [
  "GET/POST /api/v1/consignments",
  "GET /api/v1/consignments/:consignmentId",
  ...managerPaths.slice(2).map((path) => `POST ${path}`),
  "{tenantId,externalRef,pieceRefs,legs}",
  "{reason,expectedRoutePlanRevision,legs}",
  "{tenantId,scannerEventId,type:PICKED_UP|DEPARTED|ARRIVED|DELIVERED,routePlanRevision,legId,hubId,observedAt}",
  "{reason,observedAt}",
  "{observedAt}",
  "Consignment = {consignmentId,tenantId,externalRef,routePlanId,routePlanRevision:int,state:PLANNED|IN_TRANSIT|PARTIALLY_DELIVERED|DELIVERED|EXCEPTION,createdAt,updatedAt,sequence:int}",
  "ParcelPiece = {pieceId,consignmentId,pieceRef,legacyShipmentId:null|uuid,state:PLANNED|IN_TRANSIT|DELIVERED|LOST|CANCELLED,createdAt,terminalAt:null|timestamp}",
  "PieceProjection = {pieceId,routePlanRevision:int,currentLegOrdinal:int|null,currentHubId:null|uuid,state:PLANNED|IN_TRANSIT|DELIVERED|LOST|CANCELLED,lastObservedAt:null|timestamp,sequence:int}",
  "{consignment:Consignment,pieces:ParcelPiece[]}",
  "CONSIGNMENT_PROJECT",
  "aggregateId",
  "consignmentId",
  "PIECE_REF_CONFLICT",
  "PIECE_TERMINAL",
  "CONSIGNMENT_TERMINAL",
  "EXPECTED_ROUTE_PLAN_REVISION_MISMATCH",
  "legacyShipmentId",
  "trackingCode",
  "RoutePlan",
  "ScanEvent",
  "Projection",
  "Event",
  "Work",
  "幂等 replay",
];
const normalized = (value) => value.replace(/\s+/g, " ");

test("RouteWeave is an independent executable benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json")]);
  assert.equal(task.id, "routeweave");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 23);
  assert.equal(dialogue.minimumTurns, 22);
  assert.equal(dialogue.hardMaxTurns, 80);
  assert.ok(dialogue.scenes.every((scene) => !("maxVisits" in scene)));
  assert.ok(dialogue.scenes.every(({ speakerRole }) => ["delivery_lead", "manager"].includes(speakerRole)));
  const managerScenes = dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager");
  assert.equal(managerScenes.length, 1);
  assert.deepEqual(managerScenes[0].revealsRequirementIds, managerScenes[0].requirementIds);
  assert.equal(task.hiddenTests.length, 13);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), Array.from({ length: 13 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), ["shipment-plan-ingest", "out-of-order-scan-storm", "loss-reroute-recovery"]);
  assert.ok(managerPaths.every((path) => contract.publicPaths.includes(path)));
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) => assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
  assert.equal(task.fixture.commit, await computeSourceFixtureCommit(new URL("../workspace", import.meta.url).pathname, task.id));
});

test("RouteWeave public, Manager, and hidden contracts share one bounded domain", async () => {
  const [readme, plan, manager, adapter, dialogue] = await Promise.all([read("workspace/README.md"), read("evaluator/E2E_TEST_PLAN.zh-CN.md"), read("orchestration/manager-prompt.zh-CN.md"), read("evaluator/adapter.mjs"), json("dialogue-script.json")]);
  const managerIndex = dialogue.scenes.findIndex(({ speakerRole }) => speakerRole === "manager");
  const fixedMessage = dialogue.scenes[managerIndex].fixedMessage;
  const preManagerScenes = JSON.stringify(dialogue.scenes.slice(0, managerIndex));
  assert.match(readme, /JourneyProjection/);
  assert.match(readme, /out-of-order-scan-storm/);
  for (const token of managerOnlyTokens) {
    assert.ok(!readme.includes(token), `${token} leaked into the initial README`);
    assert.ok(!preManagerScenes.includes(token), `${token} leaked before the Manager scene`);
  }
  assert.match(plan, /H-13/);
  for (const text of [manager, fixedMessage].map(normalized)) {
    assert.ok(managerContractTokens.every((token) => text.includes(normalized(token))));
  }
  assert.match(fixedMessage, /本轮只做.*影响分析.*不立即编码/);
  assert.match(adapter, /loss-reroute-recovery/);
});

test("RouteWeave evaluator loads from its isolated bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "routeweave-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds, ["shipment-plan-ingest", "out-of-order-scan-storm", "loss-reroute-recovery"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
