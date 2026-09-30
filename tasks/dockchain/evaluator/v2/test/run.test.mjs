import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, selectCases } from "../run.mjs";

test("CLI requires workspace, result and seed and preserves frozen selection", () => { const parsed = parseArgs(["--workspace", "/tmp/final", "--v1-workspace", "/tmp/v1", "--result", "/tmp/result.json", "--seed", "s", "--case", "A-01,E-05"]); assert.deepEqual(parsed.caseIds, ["A-01", "E-05"]); assert.equal(parsed.v1Workspace, "/tmp/v1"); const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "E-05" }] }; assert.deepEqual(selectCases(manifest, parsed.caseIds).map(({ id }) => id), ["A-01", "E-05"]); assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case ids/u); });
