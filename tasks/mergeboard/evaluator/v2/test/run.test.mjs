import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("runner parses the task-package protocol and preserves manifest order", () => {
  assert.deepEqual(parseArgs(["--submission", "/workspace", "--result", "/result.json", "--seed", "s", "--case", "B-02,A-01"]), {
    caseIds: ["B-02", "A-01"], workspace: "/workspace", result: "/result.json", evaluationSeed: "s",
  });
  const manifest = { cases: [{ id: "A-01" }, { id: "B-02" }] };
  assert.deepEqual(selectCases(manifest, ["B-02", "A-01"]).map(({ id }) => id), ["A-01", "B-02"]);
});

test("runner digest is stable and ignores evaluator-owned build directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mergeboard-digest-"));
  try {
    await writeFile(join(directory, "a.txt"), "content");
    const first = await digestTree(directory, { ignore: new Set(["node_modules", "dist"]) });
    const second = await digestTree(directory, { ignore: new Set(["node_modules", "dist"]) });
    assert.equal(first, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
