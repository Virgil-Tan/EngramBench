import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("runner parses required arguments and repeated case selection", () => {
  assert.deepEqual(parseArgs([
    "--workspace", "/submission", "--result", "/result.json", "--seed", "secret",
    "--case", "A-01,A-02", "--case", "C-01",
  ]).caseIds, ["A-01", "A-02", "C-01"]);
  assert.throws(() => parseArgs(["--workspace", "/submission"]), /required/u);
});

test("runner selects cases in frozen manifest order", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "B-01" }] };
  assert.deepEqual(selectCases(manifest, ["B-01", "A-01"]).map(({ id }) => id), ["A-01", "B-01"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case/u);
});

test("tree digest is stable and honors ignored infrastructure directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "geopulse-digest-"));
  await writeFile(join(root, "a.txt"), "a");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "ignored.txt"), "first");
  const first = await digestTree(root, { ignore: new Set(["node_modules"]) });
  await writeFile(join(root, "node_modules", "ignored.txt"), "second");
  assert.equal(await digestTree(root, { ignore: new Set(["node_modules"]) }), first);
});
