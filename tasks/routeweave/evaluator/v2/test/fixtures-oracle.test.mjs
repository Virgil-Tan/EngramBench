import assert from "node:assert/strict";
import test from "node:test";
import { consignmentBody, createFixtureFactory, performanceContract, routeCatalog, scanSequence, v1Seed } from "../lib/fixtures.mjs";
import { aggregateConsignment, canonical, digestProjection, replayPiece, replayShipment, sortEvidence, validateRoute } from "../lib/oracle.mjs";

const fixtures = createFixtureFactory({ evaluationSeed:"fixture",caseId:"A-01",baseTime:"2035-06-01T12:00:00.000Z" });

test("deterministic fixtures freeze IDs, keys, timestamps and exact V1 seed members",() => {
  assert.equal(fixtures.uuid("shipment"),fixtures.uuid("shipment")); assert.notEqual(fixtures.uuid("shipment"),fixtures.uuid("tenant"));
  assert.match(fixtures.key("scan"),/^rw-scan-[0-9a-f]{24}$/u); assert.equal(fixtures.at({ seconds:3 }),"2035-06-01T12:00:03.000Z");
  assert.deepEqual(Object.keys(v1Seed(fixtures)),["schemaVersion","seedVersion","importedAt","tenants","hubs","carriers","shipments","routePlans","transportLegs","scanEvents","journeyProjections","lossCases","reassignments"]);
});

test("route oracle rejects gaps and disconnected adjacent legs",() => {
  const catalog = routeCatalog(fixtures,{ legCount:4 });
  assert.doesNotThrow(() => validateRoute(catalog.legs));
  assert.throws(() => validateRoute(catalog.legs.map((leg,index) => index===2 ? { ...leg,ordinal:4 } : leg)),/ordinal/u);
  assert.throws(() => validateRoute(catalog.legs.map((leg,index) => index===2 ? { ...leg,fromHubId:catalog.hubs[0].hubId } : leg)),/connected/u);
});

test("worked evidence order uses observedAt, precedence and scannerEventId",() => {
  const catalog = routeCatalog(fixtures,{ legCount:1 }), events = scanSequence(fixtures,catalog,{ includeLoss:true });
  const sorted = sortEvidence([...events].reverse());
  assert.deepEqual(sorted.map(({ type }) => type),["PICKED_UP","DEPARTED","ARRIVED","LOSS_REPORTED","FOUND","DELIVERED"]);
  const projection = replayShipment(catalog,[...events].reverse());
  assert.equal(projection.state,"DELIVERED"); assert.equal(projection.currentHubId,catalog.hubs.at(-1).hubId);
  assert.equal(digestProjection(projection),digestProjection(replayShipment(catalog,events)));
});

test("loss applies after prior movement and found resumes pending evidence",() => {
  const catalog=routeCatalog(fixtures,{ legCount:1,label:"loss-replay" }), events=scanSequence(fixtures,catalog);
  const loss={ ...events[1],scannerEventId:"loss-after-departure",type:"LOSS_REPORTED",observedAt:fixtures.at({ seconds:4 }) };
  const found={ ...events[1],scannerEventId:"found-after-loss",type:"FOUND",observedAt:fixtures.at({ seconds:5 }) };
  const lost=replayShipment(catalog,[events[0],events[1],events[2],loss]);
  assert.equal(lost.state,"LOST");assert.equal(lost.currentHubId,catalog.hubs[1].hubId);
  assert.equal(replayShipment(catalog,[...events.slice(0,3),loss,found,events.at(-1)]).state,"DELIVERED");
});

test("piece replay deduplicates scanner identity and aggregate is recomputed",() => {
  const catalog = routeCatalog(fixtures,{ legCount:1 }), events = scanSequence(fixtures,catalog), duplicate = { ...events[2] };
  const projection = replayPiece(catalog,[...events,duplicate]);
  assert.equal(projection.sequence,new Set(events.map(({ scannerEventId }) => scannerEventId)).size);
  assert.equal(aggregateConsignment(["DELIVERED","IN_TRANSIT"]),"PARTIALLY_DELIVERED");
  assert.equal(aggregateConsignment(["DELIVERED","LOST"]),"EXCEPTION");
  assert.equal(aggregateConsignment(["DELIVERED","DELIVERED"]),"DELIVERED");
});

test("Consignment body freezes one through one hundred stable pieceRefs",() => {
  const catalog = routeCatalog(fixtures,{ legCount:2 }), one = consignmentBody(catalog,1), hundred = consignmentBody(catalog,100);
  assert.deepEqual(one.pieceRefs,["piece-000"]); assert.equal(hundred.pieceRefs.length,100); assert.equal(new Set(hundred.pieceRefs).size,100);
});

test("formal performance contract preserves all published scales and thresholds",() => {
  const perf = performanceContract();
  assert.deepEqual(perf.plan,{ operationCount:50000,hubCount:100,carrierCount:20,legCount:4,concurrency:64,targetPerSecond:300,p95Ms:400 });
  assert.deepEqual(perf.scans,{ shipmentCount:20000,operationCount:200000,duplicatePercent:20,targetPerSecond:600,p95Ms:500 });
  assert.deepEqual(perf.recovery,{ shipmentCount:10000,killedWorkers:2,replacementWorkers:4,maximumSeconds:60 });
});

test("canonical projection digest is key-order independent",() => {
  assert.equal(canonical({ b:2,a:1 }),'{"a":1,"b":2}'); assert.equal(digestProjection({ b:2,a:1 }),digestProjection({ a:1,b:2 }));
});
