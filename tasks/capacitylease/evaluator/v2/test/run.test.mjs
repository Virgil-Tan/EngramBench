import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts a frozen submission and one or more case IDs", () => {
  assert.deepEqual(parseArgs([
    "--submission", "/submission",
    "--result", "/results/result.json",
    "--seed", "private-seed",
    "--case", "A-01,B-01",
    "--compatibility-adapter", "capacitylease-create-envelope-v1",
  ]), {
    workspace: "/submission",
    result: "/results/result.json",
    evaluationSeed: "private-seed",
    caseIds: ["A-01", "B-01"],
    compatibilityAdapter: "capacitylease-create-envelope-v1",
  });
  assert.throws(() => parseArgs(["--submission", "/submission"]), /required/u);
});

test("case selection preserves manifest order and rejects unknown IDs", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "B-01" }] };
  assert.deepEqual(selectCases(manifest, ["B-01", "A-01"]).map(({ id }) => id), ["A-01", "B-01"]);
  assert.throws(() => selectCases(manifest, ["X-01"]), /unknown case/u);
});

test("submission digest is stable and excludes declared generated directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "capacitylease-v2-digest-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "index.js"), "export default 1;\n");
  await writeFile(join(root, "node_modules", "generated"), "one");
  const one = await digestTree(root, { ignore: new Set(["node_modules"]) });
  await writeFile(join(root, "node_modules", "generated"), "two");
  const two = await digestTree(root, { ignore: new Set(["node_modules"]) });
  assert.equal(one, two);
  assert.match(one, /^[0-9a-f]{64}$/u);
});
