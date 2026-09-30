import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url); const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root))); const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root)));
const IDS = ["CONTRACT-01","CONTRACT-02","CONTRACT-03","CONTRACT-04","CONTRACT-05","DATA-01","DATA-02","DATA-03","DATA-04","DATA-05","RECOVERY-01","RECOVERY-02","RECOVERY-03","RECOVERY-04","LAYER-01","LAYER-02","LAYER-03","LAYER-04","OPERATE-01","OPERATE-02","OPERATE-03","OPERATE-04"];

test("frozen EvidenceChain design has exact IDs, order, weights and 100 points", () => {
  assert.equal(validateManifest(manifest, contractMap), true); assert.deepEqual(manifest.cases.map(({ id }) => id), IDS); assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [dimension, manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0)])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("every implementation is task-owned and exposes async run(ctx)", () => {
  assert.equal(validateCaseRegistry(manifest, CASES), true); assert.deepEqual(CASES.map(({ id }) => id), IDS);
  for (const item of CASES) { assert.equal(item.taskId, "evidencechain"); assert.match(item.fixtureFamily, /^EC-F-/u); assert.ok(item.action.length >= 24); assert.ok(item.oracle.length >= 24); assert.equal(item.run.constructor.name, "AsyncFunction"); assert.equal(item.run.length, 1); }
});

test("DATA-05 is the only diagnostic and remains fully fail closed", async () => {
  assert.deepEqual(manifest.cases.filter(({ blockedAssertions }) => blockedAssertions).map(({ id }) => id), ["DATA-05"]);
  const marks = []; const details = await CASES.find(({ id }) => id === "DATA-05").run({ evidence: [], mark(event, fields) { marks.push({ event, ...fields }); this.evidence.push({ event, ...fields }); }, diagnostic: (assertionId, blockedBy) => ({ assertionId, blockedBy }) });
  assert.deepEqual(details.diagnostics, [{ assertionId: "aliquot-transfer-reversal-authority", blockedBy: "SPEC-GAP-EC-01" }]); assert.deepEqual(marks, [{ event: "spec-gap.blocked", assertionId: "aliquot-transfer-reversal-authority", blockedBy: "SPEC-GAP-EC-01", policy: "fail-closed-diagnostic" }]);
});

test("case source contains task-local real seams and no guessed Aliquot transfer or cross-task evaluator", async () => {
  const files = ["cases/helpers.mjs", "cases/contract.mjs", "cases/data.mjs", "cases/recovery.mjs", "cases/layer.mjs", "cases/operate.mjs", "fixtures/index.mjs", "oracles/index.mjs"];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  for (const seam of ["/api/v1/intake-batches", "/api/v1/custody-matches", "/api/v1/collected-items/", "/api/v1/item-splits/", "/api/v1/custody-match-groups", "/openapi.json", "loadChromium", "worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received", "SIGKILL", "performanceSeed", "v1Workspace"]) assert.match(source, new RegExp(seam.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `missing ${seam}`);
  assert.doesNotMatch(source, /\/api\/v1\/aliquots\/[`$:{\w-]*\/transfers/u); assert.doesNotMatch(source, /tasks\/(?!evidencechain)[a-z0-9-]+\/evaluator/u); assert.doesNotMatch(source, /legacy.*evaluator|placeholder|TODO|not implemented/iu);
});
