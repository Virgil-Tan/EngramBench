import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { canonicalJson, frozenRecallSet, hmacSha256, projectReadings, telemetryLine, validateCustodySteps } from "../oracles/index.mjs";

const options={evaluationSeed:"f".repeat(64),caseId:"B-05",baseTime:"2035-07-01T12:00:00.000Z"};

test("fixtures are deterministic task-local and retain the exact V1 seed surface",()=>{
  const left=createFixtureFactory(options),right=createFixtureFactory(options),fixture=left.recall();assert.equal(left.uuid("x"),right.uuid("x"));assert.equal(left.key("x"),right.key("x"));assert.equal(canonicalJson(fixture.seed),canonicalJson(right.recall().seed));assert.deepEqual(Object.keys(fixture.seed).sort(),["auditEntries","carriers","configAssignments","configRevisions","deviceCredentials","devices","excursions","importedAt","notificationDeliveries","notificationPolicies","schemaVersion","seedVersion","shipmentLegs","shipmentProjections","shipments","sites","telemetryReadings","tenants"].sort());assert.equal(fixture.fixtureFamily,"CCC-F-RECALL");assert.equal(validateCustodySteps(fixture.custodyBody.steps,fixture.shipment,fixture.sites),true);
});

test("performance fixture owns the exact frozen cardinalities and target set",()=>{
  const factory=createFixtureFactory(options),fleet=factory.performanceSeed({tenantCount:100,deviceCount:2_000,shipmentCount:500,policiesPerTenant:2,targetCount:250,label:"fixture-test"});assert.deepEqual([fleet.tenants.length,fleet.devices.length,fleet.shipments.length,fleet.notificationPolicies.length],[100,2_000,500,200]);assert.equal(fleet.seed.deviceCredentials.length,2_000);assert.equal(fleet.seed.configAssignments.length,2_000);assert.equal(fleet.seed.shipmentLegs.length,1_000);assert.equal(frozenRecallSet(fleet.shipments,fleet.tenants[0].tenantId,"PERF-TARGET-LOT").length,3);const reading=factory.performanceReading(fleet,0,"one",{sequence:1});assert.equal(reading.signature,hmacSha256(fleet.credentials[0].secret,telemetryLine(reading)));
});

test("ordered projection oracle handles late readings and three-out/three-in closure",()=>{
  const factory=createFixtureFactory(options),fixture=factory.excursion(),ordered=[fixture.readings[3],fixture.readings[4],fixture.readings[5],fixture.readings[0],fixture.readings[1],fixture.readings[2]],projection=projectReadings(ordered,{sites:fixture.sites});assert.equal(projection.lastSequence,6);assert.equal(projection.excursions.length,1);assert.equal(projection.excursions[0].firstSequence,1);assert.equal(projection.excursions[0].state,"RESOLVED");
});
