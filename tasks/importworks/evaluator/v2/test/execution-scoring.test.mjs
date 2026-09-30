import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeCase } from "../lib/execution.mjs";
import { createCaseContext, isClaimedWorkerBarrier } from "../lib/runtime.mjs";
import { classifyFailure, scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("blocked subassertions fail closed and produce diagnostics", async () => {
  const context = await createCaseContext({
    caseId: "A-03",
    workspace: process.cwd(),
    evaluationSeed: "blocked-seed",
    baseTime: "2035-06-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    assert.throws(() => context.blocked("invented", "IW-GAP-01"), /UNDECLARED/u);
    assert.throws(() => context.evidence.finish(), /MISSING_BLOCKED/u);
    context.blocked("error-report-download-bytes", "IW-GAP-01");
    assert.deepEqual(context.evidence.finish().blockedAssertions, [
      { assertionId: "error-report-download-bytes", blockedBy: "IW-GAP-01", policy: "fail-closed-diagnostic" },
    ]);
  } finally {
    await context.teardown();
  }

  const definition = manifest.cases.find(({ id }) => id === "A-03");
  const outcome = await executeCase({
    definition,
    implementation: { run: async () => ({}) },
    withContext: async (_options, operation) => {
      await operation({});
      return { blockedAssertions: [{ assertionId: "error-report-download-bytes", blockedBy: "IW-GAP-01" }] };
    },
    contextOptions: {},
    failureCodePrefix: "IW_A03_",
  });
  assert.equal(outcome.status, "diagnostic");
  assert.deepEqual(outcome.diagnostics, [{
    assertionId: "error-report-download-bytes",
    status: "blocked",
    blockedBy: "IW-GAP-01",
    policy: "fail-closed-diagnostic",
  }]);
});
test("only the published claimed-worker barrier point is accepted", () => {
  assert.equal(isClaimedWorkerBarrier({ point: "worker.claimed", workId: "w", aggregateId: "a" }), true);
  assert.equal(isClaimedWorkerBarrier({ point: "worker.effect-complete" }), false);
  assert.equal(isClaimedWorkerBarrier({ point: "worker.before-commit" }), false);
  assert.equal(isClaimedWorkerBarrier(null), false);
});

test("candidate and evaluator failures remain distinct", async () => {
  assert.equal(classifyFailure({ origin: "candidate" }), "failed");
  assert.equal(classifyFailure({ origin: "infrastructure" }), "evaluator_error");
  assert.equal(classifyFailure({ origin: "submission-integrity", kind: "invalid_sample" }), "invalid");

  const definition = manifest.cases[0];
  const candidate = await executeCase({
    definition,
    implementation: { run: async () => { throw new Error("candidate mismatch"); } },
    withContext: async (_options, operation) => operation({}),
    contextOptions: {},
    failureCodePrefix: "IW_A01_",
  });
  assert.equal(candidate.status, "failed");
  assert.equal(candidate.privateFailureCode, "IW_A01_ASSERTION_FAILED");

  const infrastructure = await executeCase({
    definition,
    implementation: { run: async () => { throw Object.assign(new Error("port"), { origin: "infrastructure", code: "EVALUATOR_PORT" }); } },
    withContext: async (_options, operation) => operation({}),
    contextOptions: {},
    failureCodePrefix: "IW_A01_",
  });
  assert.equal(infrastructure.status, "evaluator_error");
  assert.equal(infrastructure.evaluatorErrorCode, "EVALUATOR_PORT");
});

test("weighted scoring accepts all green, diagnoses gaps and applies correctness cap", () => {
  const passed = manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "0".repeat(64) }));
  assert.deepEqual(
    (({ score, rawScore, verdict, formalEligible }) => ({ score, rawScore, verdict, formalEligible }))(scoreEvaluation(manifest, contractMap, { cases: passed })),
    { score: 100, rawScore: 100, verdict: "accepted", formalEligible: true },
  );

  const diagnostic = passed.map((item) => item.id === "A-03" ? {
    ...item,
    status: "diagnostic",
    diagnostics: [{ assertionId: "error-report-download-bytes", status: "blocked", blockedBy: "IW-GAP-01", policy: "fail-closed-diagnostic" }],
  } : item);
  const diagnosticScore = scoreEvaluation(manifest, contractMap, { cases: diagnostic });
  assert.equal(diagnosticScore.verdict, "diagnostic");
  assert.equal(diagnosticScore.formalEligible, false);
  assert.equal(diagnosticScore.blockedWeight, 6);

  const failed = passed.map((item) => item.id === "A-04" ? {
    ...item,
    status: "failed",
    privateFailureCode: "IW_A04_PARTIAL_PUBLICATION",
    hardCapIds: ["CORRECTNESS_INVARIANT"],
  } : item);
  const capped = scoreEvaluation(manifest, contractMap, { cases: failed });
  assert.equal(capped.rawScore, 94);
  assert.equal(capped.score, 30);
});
