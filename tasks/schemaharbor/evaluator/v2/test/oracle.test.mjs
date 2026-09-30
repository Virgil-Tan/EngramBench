import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAcyclic,
  canonicalDigest,
  compatibilityFindings,
  releaseBundleOracle,
  validateRecordSchema,
} from "../lib/oracle.mjs";
import { field, recordSchema } from "../lib/fixtures.mjs";

test("canonical digest ignores object insertion order but not dependency order after normalization", () => {
  const left = recordSchema("Account", { id: field("STRING", true), active: field("BOOLEAN") });
  const right = { fields: { active: { required: false, type: "BOOLEAN" }, id: { required: true, type: "STRING" } }, name: "Account" };
  const dependencies = [{ subjectId: "00000000-0000-4000-8000-000000000002", version: 2 }, { subjectId: "00000000-0000-4000-8000-000000000001", version: 1 }];
  assert.equal(canonicalDigest(left, dependencies), canonicalDigest(right, [...dependencies].reverse()));
});

test("RecordSchema and compatibility oracle enforce the published restricted dialect", () => {
  const oldSchema = recordSchema("Account", { id: field("STRING", true), active: field("BOOLEAN") });
  assert.deepEqual(validateRecordSchema(oldSchema), oldSchema);
  assert.throws(() => validateRecordSchema({ ...oldSchema, extra: true }), /unknown RecordSchema key/iu);
  assert.equal(compatibilityFindings("BACKWARD", [oldSchema], recordSchema("Account", { id: field("INTEGER", true) })).length > 0, true);
  assert.equal(compatibilityFindings("FORWARD", [oldSchema], recordSchema("Account", { id: field("STRING", true), added: field("INTEGER", true) })).length, 0);
  assert.equal(compatibilityFindings("FULL", [oldSchema], recordSchema("Account", { id: field("STRING", true), added: field("INTEGER", true) })).length > 0, true);
});

test("dependency and bundle oracles reject cycles and freeze canonical ordering", () => {
  assert.throws(() => assertAcyclic(new Map([["a", ["b"]], ["b", ["a"]]])), /cycle/iu);
  const bundle = releaseBundleOracle({
    members: [
      { subjectId: "00000000-0000-4000-8000-000000000002", expectedHeadVersion: 4, schema: recordSchema("B", { id: field("STRING", true) }), dependencies: [] },
      { subjectId: "00000000-0000-4000-8000-000000000001", expectedHeadVersion: 2, schema: recordSchema("A", { id: field("STRING", true) }), dependencies: [{ kind: "BUNDLE_MEMBER", subjectId: "00000000-0000-4000-8000-000000000002" }] },
    ],
    catalogSnapshot: [
      { subjectId: "00000000-0000-4000-8000-000000000002", headVersion: 4, modeRevision: 1 },
      { subjectId: "00000000-0000-4000-8000-000000000001", headVersion: 2, modeRevision: 3 },
    ],
  });
  assert.deepEqual(bundle.members.map(({ subjectId }) => subjectId), ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
  assert.match(bundle.canonicalDigest, /^[0-9a-f]{64}$/u);
});
