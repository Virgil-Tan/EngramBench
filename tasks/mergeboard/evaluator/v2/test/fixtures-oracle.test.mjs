import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createFixtureFactory, workedMergeFixture } from "../fixtures/index.mjs";
import { applyOperations, canonicalJson, documentDigest, documentDiff, mergePreview, rebaseOperations } from "../oracles/index.mjs";

test("fixtures are deterministic and isolated by case", () => {
  const left = createFixtureFactory({ evaluationSeed: "seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });
  const right = createFixtureFactory({ evaluationSeed: "seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });
  const other = createFixtureFactory({ evaluationSeed: "seed", caseId: "A-02", baseTime: "2035-06-01T12:00:00.000Z" });
  assert.equal(left.uuid("document"), right.uuid("document"));
  assert.notEqual(left.uuid("document"), other.uuid("document"));
  assert.equal(left.at({ minutes: 2 }), "2035-06-01T12:02:00.000Z");
  assert.deepEqual(left.v1Seed("fixture"), right.v1Seed("fixture"));
});

test("operation and digest oracle follows the worked merge example", () => {
  const fixture = workedMergeFixture(createFixtureFactory({ evaluationSeed: "gold", caseId: "B-01", baseTime: "2035-06-01T12:00:00.000Z" }));
  const applied = applyOperations(fixture.baseBlocks, fixture.sourceOperations);
  assert.deepEqual(applied.blocks, fixture.expectedBlocks);
  assert.equal(documentDigest(fixture.documentId, 1, applied.blocks), createHash("sha256").update(canonicalJson({ documentId: fixture.documentId, revision: 1, blocks: applied.blocks })).digest("hex"));
  assert.deepEqual(mergePreview(fixture.baseBlocks, fixture.sourceOperations).blocks, fixture.expectedBlocks);
});

test("rebase and diff oracle reports every deterministic conflict and stable item order", () => {
  const blocks = [{ blockId: "00000000-0000-4000-8000-000000000001", text: "a" }, { blockId: "00000000-0000-4000-8000-000000000002", text: "b" }];
  const operations = [
    { op: "REPLACE", blockId: blocks[0].blockId, expectedText: "old", newText: "new" },
    { op: "DELETE", blockId: "00000000-0000-4000-8000-000000000003", expectedText: "gone" },
  ];
  assert.deepEqual(rebaseOperations(blocks, operations).conflicts.map(({ operationIndex, code }) => [operationIndex, code]), [[0, "TARGET_CHANGED"], [1, "TARGET_MISSING"]]);
  const diff = documentDiff(blocks, [{ blockId: blocks[1].blockId, text: "b2" }, { blockId: blocks[0].blockId, text: "a" }]);
  assert.deepEqual(diff.map(({ blockId, kind }) => [blockId, kind]), [[blocks[0].blockId, "MOVE"], [blocks[1].blockId, "REPLACE"], [blocks[1].blockId, "MOVE"]]);
});
