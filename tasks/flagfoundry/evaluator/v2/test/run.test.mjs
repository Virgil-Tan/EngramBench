import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts submission, V1 checkpoint and frozen case filters", () => { assert.deepEqual(parseArgs(["--submission", "/submission", "--result", "/result.json", "--seed", "seed", "--v1-workspace", "/v1", "--case", "A-01,E-01"]), { caseIds: ["A-01", "E-01"], workspace: "/submission", result: "/result.json", evaluationSeed: "seed", v1Workspace: "/v1" }); assert.throws(() => parseArgs(["--submission", "/x"]), /required/u); });
test("case selection preserves manifest order", () => { const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "E-05" }] }; assert.deepEqual(selectCases(manifest, ["E-05", "A-01"]).map(({ id }) => id), ["A-01", "E-05"]); assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case/u); });
test("submission digest is deterministic", async () => { const directory = await mkdtemp(join(tmpdir(), "flagfoundry-run-test-")); try { await writeFile(join(directory, "a.txt"), "a"); assert.equal(await digestTree(directory), await digestTree(directory)); } finally { await rm(directory, { recursive: true, force: true }); } });
