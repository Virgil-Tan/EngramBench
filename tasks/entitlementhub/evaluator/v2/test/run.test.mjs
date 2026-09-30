import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, selectCases } from "../run.mjs";
test("CLI supports frozen named case selection", () => { const parsed = parseArgs(["--workspace", "/tmp/w", "--result", "/tmp/r", "--seed", "s", "--case", "CONTRACT-01,OPERATE-04"]); assert.deepEqual(parsed.caseIds, ["CONTRACT-01", "OPERATE-04"]); const manifest = { cases: [{ id: "CONTRACT-01" }, { id: "DATA-01" }, { id: "OPERATE-04" }] }; assert.deepEqual(selectCases(manifest, parsed.caseIds).map(({ id }) => id), ["CONTRACT-01", "OPERATE-04"]); assert.throws(() => selectCases(manifest, ["X-99"]), /unknown case ids/u); });
