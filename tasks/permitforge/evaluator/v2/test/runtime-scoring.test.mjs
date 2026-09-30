import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertPermitForgeEvidenceSummary, executeCase, summarizePermitForgeEvidence } from "../lib/execution.mjs";
import { validateBarrierPayload } from "../lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";
import { parseArgs, selectCases } from "../run.mjs";

test("PermitForge barrier accepts only the exact published role and point payload", () => {
  const worker = { aggregateId: "aggregate", attempt: 1, leaseTokenHash: "a".repeat(64), point: "worker.claimed", processRole: "worker", schemaVersion: 1, workId: "work" };
  assert.equal(validateBarrierPayload(worker), true);
  assert.equal(validateBarrierPayload({ ...worker, point: "worker.effect-complete" }), true);
  assert.equal(validateBarrierPayload({ ...worker, point: "worker.before-commit" }), true);
  assert.equal(validateBarrierPayload({ ...worker, processRole: "dispatcher", point: "dispatcher.response-received" }), true);
  assert.equal(validateBarrierPayload({ ...worker, point: "invented" }), false);
  assert.equal(validateBarrierPayload({ ...worker, leaseTokenHash: "private-token" }), false);
  assert.equal(validateBarrierPayload({ ...worker, extra: true }), false);
});

test("declared PF gaps force diagnostic scoring and reduce formal maximum", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));
  const contractMap = JSON.parse(await readFile(new URL("../contract-map.v2.json", import.meta.url), "utf8"));
  assert.equal(validateManifest(manifest, contractMap), true);
  const cases = manifest.cases.map((item) => item.blockedAssertions?.length ? {
    id: item.id,
    status: "diagnostic",
    durationMs: 1,
    evidenceDigest: "0".repeat(64),
    diagnostics: item.blockedAssertions.map(({ id, blockedBy, policy }) => ({ assertionId: id, status: "blocked", blockedBy, policy })),
  } : { id: item.id, status: "passed", durationMs: 1, evidenceDigest: "0".repeat(64) });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  const blockedWeight = manifest.cases.filter((item) => item.blockedAssertions?.length).reduce((sum, item) => sum + item.weight, 0);
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.formalEligible, false);
  assert.equal(result.blockedWeight, blockedWeight);
  assert.equal(result.maxAchievable, 100 - blockedWeight);
});

test("candidate correctness failure applies only declared hard cap", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));
  const contractMap = JSON.parse(await readFile(new URL("../contract-map.v2.json", import.meta.url), "utf8"));
  const cases = manifest.cases.map((item) => item.id === "B-01" ? {
    id: item.id,
    status: "failed",
    privateFailureCode: "PF_B_01_ASSERTION_FAILED",
    hardCapIds: ["REVIEW_AUTHORITY"],
    durationMs: 1,
    evidenceDigest: "0".repeat(64),
  } : item.blockedAssertions?.length ? {
    id: item.id,
    status: "diagnostic",
    diagnostics: item.blockedAssertions.map(({ id, blockedBy, policy }) => ({ assertionId: id, status: "blocked", blockedBy, policy })),
    durationMs: 1,
    evidenceDigest: "0".repeat(64),
  } : { id: item.id, status: "passed", durationMs: 1, evidenceDigest: "0".repeat(64) });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.hardCapsApplied.length, 1);
  assert.equal(result.hardCapsApplied[0].id, "REVIEW_AUTHORITY");
  assert.ok(result.score <= 35);
});

test("CLI parsing and case selection stay explicit", async () => {
  const parsed = parseArgs(["--workspace", "/workspace", "--result", "/result.json", "--seed", "seed", "--case", "A-01,E-07"]);
  assert.deepEqual(parsed.caseIds, ["A-01", "E-07"]);
  const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));
  assert.deepEqual(selectCases(manifest, parsed.caseIds).map(({ id }) => id), parsed.caseIds);
  assert.throws(() => selectCases(manifest, ["Z-99"]));
});

test("task-local execution keeps bounded layer evidence private from the public result", async () => {
  const definition = { id: "A-01", dimension: "A", weight: 2 };
  const implementation = {
    async run(ctx) {
      ctx.evidence.push(
        { event: "HTTP", kind: "GET /healthz 200", count: 2 },
        { event: "snapshot", kind: "resources=1;work=1;events=1", count: 1 },
      );
      return { status: "passed", evidence: [{ public: "digest-only" }] };
    },
  };
  const outcome = await executeCase({
    definition,
    implementation,
    withContext: async (_options, operation) => operation({ evidence: [] }),
    contextOptions: {},
    failureCodePrefix: "PF_A_01_",
  });
  assert.equal(outcome.status, "passed");
  assert.equal(assertPermitForgeEvidenceSummary(outcome.privateEvidenceSummary, "A-01"), true);
  assert.deepEqual(outcome.privateEvidenceSummary.layers, { HTTP: 2, snapshot: 1 });
  assert.equal(JSON.stringify(outcome).includes("privateEvidenceSummary"), false);
  assert.equal(Object.keys(outcome).includes("privateEvidenceSummary"), false);
});

test("private evidence summarizer redacts sensitive kinds and emits one bounded artifact per observed layer", () => {
  const events = Array.from({ length: 500 }, (_, index) => ({ event: "HTTP", kind: `GET /items/${index} 200`, count: 1 }));
  events.push({ event: "process", kind: "Authorization: Bearer private-token", count: 1 });
  const summary = summarizePermitForgeEvidence(events, "D-07");
  assert.equal(assertPermitForgeEvidenceSummary(summary, "D-07"), true);
  assert.deepEqual(summary.layers, { HTTP: 500, process: 1 });
  assert.equal(summary.artifactRefs.length, 2);
  assert.equal(summary.artifactRefs.find(({ layer }) => layer === "process").kind, "process observed");
  assert.ok(JSON.stringify(summary).length < 16_384);
});
