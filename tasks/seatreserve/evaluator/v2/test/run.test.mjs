import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, selectCases } from "../run.mjs";

test("CLI requires workspace, result, seed and preserves frozen case selection", () => {
  const parsed = parseArgs(["--workspace", "/tmp/work", "--result", "/tmp/result.json", "--seed", "s", "--case", "A-01,E-04", "--v1-workspace", "/tmp/v1"]); assert.deepEqual(parsed.caseIds, ["A-01", "E-04"]); assert.equal(parsed.v1Workspace, "/tmp/v1"); const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "E-04" }] }; assert.deepEqual(selectCases(manifest, parsed.caseIds).map(({ id }) => id), ["A-01", "E-04"]); assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case ids/u);
});
