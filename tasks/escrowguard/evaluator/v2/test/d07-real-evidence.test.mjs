import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCandidateBusinessTraffic,
  assertConcurrentGateObservation,
  assertFixedPerformanceGateObservation,
  assertHttpDatabaseGateObservation,
  assertRecoveryGateObservation,
  assertUnitGateObservation,
} from "../cases/d.mjs";

function authorities(overrides = {}) {
  return {
    observedApiPorts: [3101, 3102],
    observedApiPids: [101, 102],
    verifiedApiPids: [101, 102],
    observedWorkerPids: [201, 202],
    apiDatabasePids: [101, 102],
    httpProbeSuccesses: 6,
    maxDescendants: 6,
    ...overrides,
  };
}

function claim(workId, aggregateId, attempt, extra = {}) {
  return { json: { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId, aggregateId, attempt, leaseTokenHash: "a".repeat(64) }, released: true, disconnected: false, ...extra };
}

test("D-07 accepts only externally observed HTTP/PostgreSQL API authorities", () => {
  assert.equal(assertHttpDatabaseGateObservation(authorities({ databaseTransactionDelta: 30 })), true);
  assert.throws(() => assertHttpDatabaseGateObservation({ logs: "99 tests passed; API and database OK" }), /public API listener/u);
  assert.throws(() => assertHttpDatabaseGateObservation(authorities({ apiDatabasePids: [] })), /PostgreSQL connections/u);
});

test("D-07 concurrency requires two verified API and two PostgreSQL Worker processes", () => {
  assert.equal(assertConcurrentGateObservation(authorities()), true);
  assert.throws(() => assertConcurrentGateObservation(authorities({ observedApiPids: [101], observedApiPorts: [3101], httpProbeSuccesses: 3, apiDatabasePids: [101] })), /2 public API/u);
  assert.throws(() => assertConcurrentGateObservation(authorities({ observedWorkerPids: [201] })), /2 distinct non-API Worker/u);
});

test("D-07 unit and business gates reject sleep-only and health-only false greens", () => {
  assert.equal(assertUnitGateObservation({ unitProductionFiles: ["dist/domain.js"], unitExecutedFunctions: 3, unitExecutedBytes: 512 }), true);
  assert.throws(() => assertUnitGateObservation({ durationMs: 60_000, unitProductionFiles: [], unitExecutedFunctions: 0, unitExecutedBytes: 0 }), /production code/u);

  const traffic = { verifiedApiPids: [101], candidateHttpTraffic: [
    { pid: 101, method: "POST", path: "/api/v1/escrows", status: 201 },
    { pid: 101, method: "GET", path: "/api/v1/escrows/136c36b3-733a-4f37-b477-931ce3ed0316", status: 200 },
  ] };
  assert.deepEqual(assertCandidateBusinessTraffic(traffic), { traffic: 2, successfulMutations: 1 });
  assert.throws(() => assertCandidateBusinessTraffic({ candidateHttpTraffic: [{ pid: 101, method: "GET", path: "/healthz", status: 200 }] }), /business HTTP/u);
  assert.throws(() => assertCandidateBusinessTraffic({ candidateHttpTraffic: [{ pid: 101, method: "GET", path: "/api/v1/escrows", status: 200 }] }), /successful public mutation/u);
  assert.throws(() => assertCandidateBusinessTraffic({ candidateHttpTraffic: [{ pid: 101, method: "POST", path: "/api/v1/escrows", status: 201 }] }), /resource identity/u);
  assert.throws(() => assertCandidateBusinessTraffic({ verifiedApiPids: [101], candidateHttpTraffic: [{ pid: 999, method: "POST", path: "/api/v1/escrows", status: 201 }, { pid: 999, method: "GET", path: "/api/v1/escrows/136c36b3-733a-4f37-b477-931ce3ed0316", status: 200 }] }), /independently verified against PostgreSQL/u);
  assert.throws(() => assertCandidateBusinessTraffic({ verifiedApiPids: [101], candidateHttpTraffic: [{ pid: 101, method: "POST", path: "/api/v1/escrows", status: 201, userAgent: "node" }, { pid: 101, method: "GET", path: "/api/v1/escrows/136c36b3-733a-4f37-b477-931ce3ed0316", status: 200 }] }, { requiredUserAgent: "evaluator-browser" }), /production Chromium/u);
});

test("D-07 recovery binds evaluator SIGKILL, disconnected barrier socket and later reclaim", () => {
  const real = authorities({
    evaluatorKills: [{ pid: 201, workId: "w1", aggregateId: "a1", attempt: 1 }],
    evaluatorKilledPidsExited: [201],
    barrierLedger: [claim("w1", "a1", 1, { released: false, disconnected: true }), claim("w1", "a1", 2)],
  });
  assert.deepEqual(assertRecoveryGateObservation(real), { killedPid: 201, workId: "w1", replacementAttempt: 2 });
  assert.throws(() => assertRecoveryGateObservation({ ...real, evaluatorKills: [] }), /evaluator SIGKILLs/u);
  assert.throws(() => assertRecoveryGateObservation({ ...real, barrierLedger: [claim("w1", "a1", 1, { released: false, disconnected: true })] }), /replacement Worker/u);
  assert.throws(() => assertRecoveryGateObservation({ ...real, barrierLedger: [claim("w1", "a1", 1), claim("w1", "a1", 2)] }), /severed/u);
});

test("D-07 fixed performance rejects print/sleep mutants and missing 64-client socket evidence", () => {
  const barrierLedger = [claim("w1", "a1", 1), claim("w2", "a2", 1), claim("w1", "a1", 2), claim("w2", "a2", 2)];
  const real = authorities({
    durationMs: 140_000,
    maxConcurrentApiClients: 64,
    databaseTransactionDelta: 22_800,
    databaseTupleDelta: 100_000,
    candidateHttpTraffic: [
      { pid: 101, method: "GET", path: "/api/v1/escrows/136c36b3-733a-4f37-b477-931ce3ed0316", status: 200 },
      { pid: 102, method: "POST", path: "/api/v1/escrows", status: 201 },
    ],
    barrierLedger,
  });
  assert.deepEqual(assertFixedPerformanceGateObservation(real, { dueCount: 2 }), { claimedWorkCount: 2, recoveredWorkCount: 2 });
  assert.throws(() => assertFixedPerformanceGateObservation({ logs: "p50 p95 p99 throughput success; slept 140 seconds", durationMs: 140_000, barrierLedger: [] }, { dueCount: 2 }), /fixed HTTP workloads/u);
  assert.throws(() => assertFixedPerformanceGateObservation({ ...real, maxConcurrentApiClients: 63 }, { dueCount: 2 }), /64-client/u);
  assert.throws(() => assertFixedPerformanceGateObservation({ ...real, barrierLedger: barrierLedger.slice(0, 2) }, { dueCount: 2 }), /replacement attempts/u);
});
