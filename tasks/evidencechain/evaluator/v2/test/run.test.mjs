import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts submission, result, seed and optional V1/cases", () => {
  assert.deepEqual(parseArgs(["--submission", "/submission", "--result", "/result.json", "--seed", "private", "--v1-workspace", "/v1", "--case", "CONTRACT-01,DATA-05"]), { workspace: "/submission", result: "/result.json", evaluationSeed: "private", v1Workspace: "/v1", caseIds: ["CONTRACT-01", "DATA-05"] }); assert.throws(() => parseArgs(["--submission", "/submission"]), /required/u);
});

test("case selection preserves frozen order and rejects unknown IDs", () => {
  const manifest = { cases: [{ id: "CONTRACT-01" }, { id: "DATA-05" }] }; assert.deepEqual(selectCases(manifest, ["DATA-05", "CONTRACT-01"]).map(({ id }) => id), ["CONTRACT-01", "DATA-05"]); assert.throws(() => selectCases(manifest, ["OTHER"]), /unknown case/u);
});

test("digestTree is stable and ignores generated directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidencechain-v2-")); await mkdir(join(directory, "src")); await mkdir(join(directory, "node_modules")); await writeFile(join(directory, "src", "index.mjs"), "export default 1;\n"); await writeFile(join(directory, "node_modules", "generated"), "one"); const one = await digestTree(directory, { ignore: new Set(["node_modules"]) }); await writeFile(join(directory, "node_modules", "generated"), "two"); assert.equal(await digestTree(directory, { ignore: new Set(["node_modules"]) }), one); assert.match(one, /^[a-f0-9]{64}$/u);
});
