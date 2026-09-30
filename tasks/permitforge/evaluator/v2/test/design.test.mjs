import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { B_INTERLEAVINGS } from "../cases/b.mjs";
import { D01_FROZEN_ROUTES, D05_STATES, D05_VIEWPORTS, D08_LEDGER_NODES } from "../cases/d.mjs";
import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { IDS, validateManifest } from "../lib/scoring.mjs";

const CASE_HEADING = /^### ([A-E]-\d{2}) (.+?) — ([0-9]+(?:\.[0-9]+)?)$/gmu;

test("manifest and contract-map exactly freeze all PermitForge cases", async () => {
  const [design, manifestSource, contractSource] = await Promise.all([
    readFile(new URL("../../HIDDEN_TEST_V2_DESIGN.zh-CN.md", import.meta.url), "utf8"),
    readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"),
    readFile(new URL("../contract-map.v2.json", import.meta.url), "utf8"),
  ]);
  const expected = [...design.matchAll(CASE_HEADING)].map((match) => ({ id: match[1], title: match[2], weight: Number(match[3]) }));
  const manifest = JSON.parse(manifestSource);
  const contractMap = JSON.parse(contractSource);
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.deepEqual(manifest.cases.map(({ id, title, weight }) => ({ id, title, weight })), expected);
  assert.deepEqual(manifest.cases.map(({ id }) => id), IDS);
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), IDS);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.equal(CASES.length, 48);
  for (const item of CASES) {
    assert.equal(item.taskId, "permitforge");
    assert.equal(item.run.constructor.name, "AsyncFunction");
    assert.equal(item.run.length, 1);
  }
});

test("every blocked assertion is implemented fail-closed and gap-owned", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));
  const definitions = new Map(manifest.cases.map((item) => [item.id, item]));
  for (const implementation of CASES) {
    const expected = (definitions.get(implementation.id).blockedAssertions ?? []).map(({ id, blockedBy, policy }) => ({ assertionId: id, blockedBy, policy }));
    assert.deepEqual(implementation.blockedAssertions, expected, implementation.id);
  }
});

test("race, OpenAPI, browser and evidence-closure matrices stay structurally frozen", () => {
  assert.deepEqual(B_INTERLEAVINGS, {
    B04: ["concurrent-after-expiry", "new-reviewer-first", "old-reviewer-first"],
    B05: ["replacement-first", "claim-first", "concurrent"],
    B06: ["replacement-before-worker-commit", "expiry-before-replacement"],
    B10: ["claim-before-deadline", "claim-while-worker-held", "claim-after-expiry"],
  });
  assert.deepEqual(D01_FROZEN_ROUTES, [
    "GET /api/v1/permitApplications",
    "GET /api/v1/permitApplications/{permitApplicationId}",
    "POST /api/v1/permit-applications",
    "POST /api/v1/permit-applications/{applicationId}/review-claims",
    "POST /api/v1/review-claims/{claimId}/decisions",
    "POST /api/v1/permit-applications/{applicationId}/revisions",
    "GET /api/v1/permit-applications/{applicationId}",
    "GET /api/v1/permit-applications/{applicationId}/revisions/{revision}",
    "GET /api/v1/permit-applications/{applicationId}/stages",
    "GET /api/v1/domain-events",
    "GET /api/v1/verification-snapshot",
  ]);
  assert.deepEqual(D05_VIEWPORTS, { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } });
  assert.deepEqual(D05_STATES, ["empty", "validation", "loading", "stale-conflict", "offline-retry", "terminal", "permission"]);
  assert.deepEqual(D08_LEDGER_NODES, [
    "migration", "seed", "production-build", "production-boot", "collection-read", "aggregate-detail", "immutable-revision",
    "captured-policy", "staged-submit", "current-stage-claim", "replacement-revision", "durable-idempotency", "validation-error",
    "deadline-work", "transactional-event", "dispatcher-delivery", "openapi-runtime", "browser-authority", "verification-snapshot",
    "seeded-decision-history", "seeded-permit-history",
  ]);
});

test("B and C keep deterministic race and non-vacuous recovery closure", async () => {
  const [b, c] = await Promise.all([
    readFile(new URL("../cases/b.mjs", import.meta.url), "utf8"),
    readFile(new URL("../cases/c.mjs", import.meta.url), "utf8"),
  ]);
  assert.ok((b.match(/frozenClientBarrier\(/gu) ?? []).length >= 4, "B-04/B-05/B-10 use the evaluator-side dispatch barrier");
  assert.ok((b.match(/assertOperationEffects\(/gu) ?? []).length >= 3, "B-07/B-08 use operation-level effect oracles");
  assert.match(b, /b09-invalid-fresh/u);
  assert.match(b, /INVALID_REVIEW_STAGES/u);
  assert.equal((b.match(/claims = await claimRequests\(\)/gu) ?? []).length, 3, "B-10 sends three Claim requests in every frozen schedule");
  assert.match(b, /exact retained terminal Deadline Work/u);

  assert.ok((c.match(/observeStableAuthority\(/gu) ?? []).length >= 3, "C-01/C-05 observe stale owners across a full lease window");
  assert.match(c, /disconnect: true/u);
  assert.equal((c.match(/assertRecoveredDelivery\(/gu) ?? []).length, 2, "C-07/C-08 bind retries to the held Event identity");
  assert.match(c, /old Claim remains EXPIRED/u);
  assert.match(c, /assertSingleAggregateWork/u);
});
