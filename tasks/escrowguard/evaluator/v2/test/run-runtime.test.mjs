import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertFixedPerformanceGateObservation, connectedIdentityClosures, ESCROWGUARD_EVIDENCE_REQUIREMENTS, outcomeEvidenceLedger } from "../cases/d.mjs";
import { createMissingV1CheckpointOutcome, createPrivateCaseState, executeCase, privateEvidenceFor, summarizeCaseEvidence } from "../lib/execution.mjs";
import { validateBarrierPayload } from "../lib/runtime.mjs";
import { orderCaseOutcomes, parseArgs, scheduleCases, selectCases } from "../run.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));

test("CLI parsing and frozen-order selection are deterministic", () => {
  const parsed = parseArgs(["--submission", "/tmp/work", "--result", "/tmp/result.json", "--seed", "seed", "--case", "E-07,A-01"]); assert.equal(parsed.workspace, "/tmp/work"); assert.deepEqual(selectCases(manifest, parsed.caseIds).map(({ id }) => id), ["A-01", "E-07"]); assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case/u);
});

test("D-08 executes after all selected evidence while persisted outcomes remain frozen-order", () => {
  const selected = selectCases(manifest, ["A-01", "D-08", "E-07"]);
  assert.deepEqual(scheduleCases(selected).map(({ id }) => id), ["A-01", "E-07", "D-08"]);
  const outcomes = [{ id: "A-01" }, { id: "E-07" }, { id: "D-08" }];
  assert.deepEqual(orderCaseOutcomes(selected, outcomes).map(({ id }) => id), ["A-01", "D-08", "E-07"]);
});

test("D-08 consumes every prior frozen outcome and fails closed on an unpassed or missing Case", () => {
  const prior = manifest.cases.filter(({ id }) => id !== "D-08").map(({ id }) => ({ id, status: "passed", evidenceDigest: "a".repeat(64) }));
  const layers = ["http", "openapi", "ui", "snapshot", "work", "event", "hidden"];
  const identity = "b".repeat(64);
  const summaries = prior.map(({ id }) => ({
    caseId: id,
    layers: Object.fromEntries(layers.map((layer) => [layer, 1])),
    evidenceKinds: ["escrowguard-case-summary"],
    observations: layers.map((layer) => ({ layer, ...(layer === "http" || layer === "openapi" ? { method: "GET", path: "/api/v1/escrows/{uuid}", status: 200 } : {}), identityHashes: [identity] })),
    bindings: [{ kind: "identity", hash: identity, layers: ["event", "http", "snapshot", "ui", "work"] }],
  }));
  const ledger = outcomeEvidenceLedger(prior, summaries);
  assert.equal(Object.keys(ledger).length, ESCROWGUARD_EVIDENCE_REQUIREMENTS.length);
  const failed = prior.map((outcome) => outcome.id === "B-07" ? { ...outcome, status: "failed" } : outcome);
  assert.throws(() => outcomeEvidenceLedger(failed, summaries), /B-07 passed/u);
  assert.throws(() => outcomeEvidenceLedger(prior.slice(1), summaries.slice(1)), /all prior outcomes in frozen order/u);
  const missingOpenApi = summaries.map((summary) => summary.caseId === "D-01" ? { ...summary, layers: { ...summary.layers, openapi: 99 }, observations: summary.observations.filter(({ layer }) => layer !== "openapi") } : summary);
  assert.throws(() => outcomeEvidenceLedger(prior, missingOpenApi), /actual openapi observations/u);
  const countOnly = summaries.map((summary) => summary.caseId === "A-05" ? { ...summary, observations: summary.observations.filter(({ layer }) => layer !== "snapshot") } : summary);
  assert.throws(() => outcomeEvidenceLedger(prior, countOnly), /actual snapshot observations/u);
  const noIdentityClosure = summaries.map((summary) => summary.caseId === "A-06" ? { ...summary, bindings: [] } : summary);
  assert.throws(() => outcomeEvidenceLedger(prior, noIdentityClosure), /one hashed resource identity/u);
});

test("D-08 accepts only verified V1 exclusions without private evidence", () => {
  const excludedIds = new Set(["E-01", "E-02", "E-03"]);
  const prior = manifest.cases.filter(({ id }) => id !== "D-08").map((definition) => excludedIds.has(definition.id)
    ? createMissingV1CheckpointOutcome(definition)
    : { id: definition.id, status: "passed", evidenceDigest: "a".repeat(64) });
  const identity = "b".repeat(64);
  const layers = ["http", "openapi", "ui", "snapshot", "work", "event", "hidden"];
  const summaries = prior.filter(({ status }) => status !== "excluded").map(({ id }) => ({
    caseId: id,
    layers: Object.fromEntries(layers.map((layer) => [layer, 1])),
    evidenceKinds: ["escrowguard-case-summary"],
    observations: layers.map((layer) => ({ layer, ...(layer === "http" || layer === "openapi" ? { method: "GET", path: "/api/v1/escrows/{uuid}", status: 200 } : {}), identityHashes: [identity] })),
    bindings: [{ kind: "identity", hash: identity, layers: ["event", "http", "snapshot", "ui", "work"] }],
  }));
  const ledger = outcomeEvidenceLedger(prior, summaries);
  assert.equal(ledger["repeatable-and-compatible-migration"].nodes.work.status, "not-applicable");
  const forged = prior.map((outcome) => outcome.id === "E-01" ? { ...outcome, evidenceDigest: "f".repeat(64) } : outcome);
  assert.throws(() => outcomeEvidenceLedger(forged, summaries), /E-01 passed|private actual evidence/u);
  const illegal = prior.map((outcome) => outcome.id === "A-02" ? { ...outcome, status: "excluded", reason: "missing_v1_checkpoint" } : outcome);
  assert.throws(() => outcomeEvidenceLedger(illegal, summaries), /A-02 passed/u);
});

test("D-08 requires one resource identity across applicable layers and rejects shared-layer bridges", () => {
  const connected = [{ kind: "identity", hash: "a".repeat(64), layers: ["http", "snapshot", "work", "event"] }];
  assert.equal(connectedIdentityClosures(connected, ["http", "snapshot", "work", "event"]).length, 1);
  assert.throws(() => connectedIdentityClosures([
    { kind: "identity", hash: "a".repeat(64), layers: ["http", "snapshot"] },
    { kind: "identity", hash: "b".repeat(64), layers: ["snapshot", "work"] },
    { kind: "identity", hash: "c".repeat(64), layers: ["work", "event"] },
  ], ["http", "snapshot", "work", "event"]), /one hashed resource identity/u);
});

test("private layer summaries are bounded and never serialize into public Case outcomes", async () => {
  const identity = "c".repeat(64);
  const http = { layer: "http", method: "GET", path: "/api/v1/escrows/{uuid}", status: 200, identityHashes: [identity], aggregateHashes: [], workHashes: [], eventHashes: [], resourceHashes: [] };
  const snapshot = { layer: "snapshot", identityHashes: [identity], aggregateHashes: [], workHashes: [], eventHashes: [], resourceHashes: [] };
  const outcome = await executeCase({
    definition: { id: "D-99", dimension: "D", weight: 0 },
    implementation: { async run(ctx) { return { status: "passed", evidence: [{ kind: "summary", secret: "not-public" }] }; } },
    withContext: async (options, operation) => operation({ caseId: options.caseId, evidence: [], layerEvidenceCounts: { http: 1, snapshot: 1 }, layerEvidence: [http, snapshot] }),
    contextOptions: {},
    failureCodePrefix: "EG-D99-",
  });
  assert.deepEqual(privateEvidenceFor(outcome), { caseId: "D-99", layers: { http: 1, snapshot: 1 }, evidenceKinds: ["summary"], observations: [http, snapshot], bindings: [{ kind: "identity", hash: identity, layers: ["http", "snapshot"] }] });
  assert.equal(JSON.stringify(outcome).includes("layers"), false);
  assert.equal(JSON.stringify(outcome).includes("not-public"), false);
});

test("maximum task-local evidence stays below both private and accumulated prior-state limits", () => {
  const hashes = Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(64, "0"));
  const layerEvidence = ["http", "openapi", "ui", "snapshot", "work", "event", "hidden"].flatMap((layer) => Array.from({ length: 24 }, (_, index) => ({
    layer,
    method: "POST",
    path: `/api/v1/escrows/${index}`,
    status: 200,
    identityHashes: hashes,
    aggregateHashes: hashes,
    workHashes: hashes,
    eventHashes: hashes,
    resourceHashes: hashes,
  })));
  const summary = summarizeCaseEvidence({ caseId: "D-99", layerEvidence, layerEvidenceCounts: { http: 24, openapi: 24, ui: 24, snapshot: 24, work: 24, event: 24, hidden: 24 } }, { evidence: [{ kind: "maximum" }] });
  const state = createPrivateCaseState("escrowguard", "D-99", summary);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 256 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) * 47 < 8 * 1024 * 1024);
});

test("private identity bindings are independent of the six displayed observations", () => {
  const retained = "d".repeat(64);
  const noises = { http: "a".repeat(64), snapshot: "b".repeat(64), work: "c".repeat(64), event: "e".repeat(64) };
  const layerEvidence = ["http", "snapshot", "work", "event"].flatMap((layer) => Array.from({ length: 12 }, () => ({ layer, identityHashes: [noises[layer]], aggregateHashes: [], workHashes: [], eventHashes: [], resourceHashes: [] })));
  const summary = summarizeCaseEvidence({
    caseId: "D-99",
    layerEvidence,
    layerEvidenceCounts: { http: 12, snapshot: 12, work: 12, event: 12 },
    layerIdentityBindings: new Map([[retained, new Set(["http", "snapshot", "work", "event"])]]),
  }, { evidence: [{ kind: "streamed" }] });
  assert.deepEqual(connectedIdentityClosures(summary.bindings, ["http", "snapshot", "work", "event"]), [{ kind: "identity", hash: retained, layers: ["event", "http", "snapshot", "work"] }]);
});

test("D-07 external performance evidence rejects sleep/print and requires replacement identities", () => {
  const entry = (workId, aggregateId, attempt) => ({ json: { processRole: "worker", point: "worker.claimed", workId, aggregateId, attempt } });
  const real = { durationMs: 140_000, maxConcurrentApiClients: 64, maxDescendants: 4, httpProbeSuccesses: 6, databaseTransactionDelta: 22_800, databaseTupleDelta: 100_000, observedApiPorts: [3001, 3002], observedApiPids: [101, 102], verifiedApiPids: [101, 102], apiDatabasePids: [101, 102], observedWorkerPids: [201, 202], candidateHttpTraffic: [{ pid: 101, method: "GET", path: "/api/v1/escrows/136c36b3-733a-4f37-b477-931ce3ed0316", status: 200 }, { pid: 102, method: "POST", path: "/api/v1/escrows", status: 201 }], barrierLedger: [entry("w1", "a1", 1), entry("w2", "a2", 1), entry("w1", "a1", 2), entry("w2", "a2", 2)] };
  assert.deepEqual(assertFixedPerformanceGateObservation(real, { dueCount: 2 }), { claimedWorkCount: 2, recoveredWorkCount: 2 });
  assert.throws(() => assertFixedPerformanceGateObservation({ ...real, databaseTransactionDelta: 0, databaseTupleDelta: 0, barrierLedger: [] }, { dueCount: 2 }), /fixed HTTP workloads/u);
  assert.throws(() => assertFixedPerformanceGateObservation({ ...real, observedApiPorts: [3001], observedApiPids: [101], apiDatabasePids: [101], httpProbeSuccesses: 3 }, { dueCount: 2 }), /2 public API/u);
  assert.throws(() => assertFixedPerformanceGateObservation({ ...real, barrierLedger: real.barrierLedger.slice(0, 2) }, { dueCount: 2 }), /replacement attempts/u);
});

test("barrier validator accepts only the exact EscrowGuard public body", () => {
  const payload = { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId: "w", aggregateId: "a", attempt: 1, leaseTokenHash: "a".repeat(64) }; assert.equal(validateBarrierPayload(payload), true); assert.equal(validateBarrierPayload({ ...payload, token: "secret" }), false); assert.equal(validateBarrierPayload({ ...payload, point: "private.before-sql" }), false);
});
