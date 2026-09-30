import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory, makeLotFixture, makeSingleLotFirstFixture, makeSplitFixture } from "../fixtures/index.mjs";
import { assertAllocationSet, assertLotConservation, canonicalJson, certificateV2, eligibleLots, enrichAllocations, selectAllocations } from "../oracles/index.mjs";
import { assertSnapshot, sustainedClosedLoop } from "../cases/helpers.mjs";
import { PERF_COUNTS } from "../cases/perf.mjs";

const options = { evaluationSeed: "carbonledger-hidden-seed", caseId: "B-02", baseTime: "2035-06-01T12:00:00.000Z" };

test("CarbonLedger fixtures are deterministic and V1-seed exact", () => {
  assert.deepEqual(makeLotFixture(options).seed, makeLotFixture(options).seed);
  assert.notEqual(createFixtureFactory(options).uuid("lot-0"), createFixtureFactory({ ...options, caseId: "B-03" }).uuid("lot-0"));
  assert.deepEqual(Object.keys(makeLotFixture(options).seed), ["schemaVersion", "seedVersion", "projects", "beneficiaries", "creditLots", "retirements", "certificates"]);
});

test("single-Lot-first dominates an earlier greedy prefix", () => {
  const fixture = makeSingleLotFirstFixture(options);
  const selected = selectAllocations(fixture.creditLots, fixture.quantityGrams);
  assert.deepEqual(selected, [{ ordinal: 1, creditLotId: eligibleLots(fixture.creditLots)[2].creditLotId, quantityGrams: 5 }]);
});

test("split oracle closes stable prefix remainder provenance and canonical bytes", () => {
  const fixture = makeSplitFixture(options, 8);
  const selected = selectAllocations(fixture.creditLots, fixture.quantityGrams);
  assert.ok(Array.isArray(selected) && selected.length === 4);
  assert.deepEqual(selected.map(({ quantityGrams }) => quantityGrams), [2, 2, 2, 1]);
  const retirementId = fixture.fixtures.uuid("retirement");
  const allocations = enrichAllocations(selected, fixture.creditLots, retirementId, (ordinal) => fixture.fixtures.uuid(`allocation-${ordinal}`));
  assertAllocationSet(allocations, fixture.creditLots, fixture.quantityGrams);
  assertLotConservation(fixture.creditLots);
  const certificate = certificateV2({ retirement: { retirementId, beneficiaryId: fixture.beneficiaryId, quantityGrams: fixture.quantityGrams }, allocations, retiredAt: fixture.fixtures.at({ minutes: 1 }) });
  assert.equal(certificate.bytes.toString("utf8"), canonicalJson(certificate.value));
  assert.match(certificate.digest, /^[0-9a-f]{64}$/u);
});

test("snapshot oracle closes exact identities, references, event sequence and provenance", () => {
  const fixture = makeLotFixture(options, { lotCount: 1, capacities: [10] }); const source = fixture.creditLots[0]; const retirementId = fixture.fixtures.uuid("snapshot-retirement"); const allocation = { lotAllocationId: fixture.fixtures.uuid("snapshot-allocation"), retirementId, ordinal: 1, creditLotId: source.creditLotId, quantityGrams: 1, projectId: source.projectId, vintage: source.vintage, methodology: source.methodology, provenanceDigest: source.provenanceDigest }; const retirement = { retirementId, beneficiaryId: fixture.beneficiaryId, quantityGrams: 1, state: "RESERVED", allocation: { creditLotId: source.creditLotId, quantityGrams: 1 }, expiresAt: fixture.fixtures.at({ minutes: 10 }), certificateDigest: null, createdAt: fixture.fixtures.at(), terminalAt: null, sequence: 1, allocations: [allocation] }; const snapshot = { asOf: fixture.fixtures.at({ minutes: 1 }), resources: { projects: [...fixture.projects].sort((left, right) => left.projectId.localeCompare(right.projectId)), beneficiaries: fixture.beneficiaries, creditLots: [{ ...source, availableGrams: 9, reservedGrams: 1 }], retirements: [retirement], certificates: [], lotAllocations: [allocation], splitCertificates: [] }, work: [{ workId: fixture.fixtures.uuid("snapshot-work"), kind: "CERTIFICATE_GENERATION", aggregateId: retirementId, state: "PENDING", terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null }], events: [{ eventId: fixture.fixtures.uuid("snapshot-event"), aggregateId: retirementId, sequence: 1, type: "retirement.reserved", occurredAt: fixture.fixtures.at(), schemaVersion: 1, payload: {} }] }; assertSnapshot(snapshot); const broken = structuredClone(snapshot); broken.resources.lotAllocations[0].provenanceDigest = fixture.fixtures.hex("wrong-provenance"); assert.throws(() => assertSnapshot(broken));
});

test("formal performance counts and phase semantics remain frozen", async () => {
  assert.deepEqual(PERF_COUNTS, { projects: 1_000, beneficiaries: 10_000, creditLots: 50_000, retirements: 105_000, certificates: 100_000, reserved: 5_000 }); let warmupOutstanding = 0; let crossed = false; const phases = []; const result = await sustainedClosedLoop({ clients: 2, warmupMs: 2, measureMs: 10, async operation({ phase, measuring, ordinal }) { phases.push({ phase, measuring, ordinal }); if (phase === "warmup") warmupOutstanding += 1; else if (warmupOutstanding) crossed = true; await new Promise((resolve) => setTimeout(resolve, phase === "measure" ? 20 : 3)); if (phase === "warmup") warmupOutstanding -= 1; return { status: 200 }; } }); assert.equal(crossed, false); assert.equal(result.count, 2); assert.equal(result.measureWindowMs, 10); assert.ok(result.measuredElapsedMs >= 10); assert.equal(result.statuses.get(200), 2); assert.ok(phases.filter(({ phase }) => phase === "warmup").every(({ measuring }) => !measuring)); assert.deepEqual(phases.filter(({ phase }) => phase === "measure").map(({ ordinal }) => ordinal).sort((a, b) => a - b), [1, 2]);
});
