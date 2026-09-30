import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("runner parses required arguments and repeated NotifyRoute case selection", () => {
  assert.deepEqual(parseArgs(["--workspace", "/submission", "--result", "/result.json", "--seed", "secret", "--case", "A-01,B-01", "--case", "C-02"]).caseIds, ["A-01", "B-01", "C-02"]);
  assert.throws(() => parseArgs(["--workspace", "/submission"]), /required/u);
});

test("runner selects in frozen manifest order", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "B-01" }, { id: "C-01" }] };
  assert.deepEqual(selectCases(manifest, ["C-01", "A-01"]).map(({ id }) => id), ["A-01", "C-01"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case/u);
});

test("tree digest is stable and excludes installed dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "notifyroute-digest-"));
  await writeFile(join(root, "a.txt"), "a");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "ignored.txt"), "first");
  const first = await digestTree(root, { ignore: new Set(["node_modules"]) });
  await writeFile(join(root, "node_modules", "ignored.txt"), "second");
  assert.equal(await digestTree(root, { ignore: new Set(["node_modules"]) }), first);
});
