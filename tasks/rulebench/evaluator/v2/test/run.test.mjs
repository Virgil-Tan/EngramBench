import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));

test("runner parses explicit private inputs and preserves manifest case order", () => {
  const options = parseArgs([
    "--workspace", "/tmp/submission", "--result", "/tmp/result.json", "--seed", "private-seed",
    "--case", "E-04,A-01", "--base-time", "2035-06-01T12:00:00.000Z",
  ]);
  assert.deepEqual(options.caseIds, ["E-04", "A-01"]);
  assert.deepEqual(selectCases(manifest, options.caseIds).map(({ id }) => id), ["A-01", "E-04"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case ids/u);
});

test("runner submission digest is deterministic and honors evaluator-owned ignores", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rulebench-runner-test-"));
  try {
    await writeFile(join(workspace, "source.txt"), "stable");
    const first = await digestTree(workspace, { ignore: new Set(["ignored.txt"]) });
    await writeFile(join(workspace, "ignored.txt"), "private evaluator scratch");
    assert.equal(await digestTree(workspace, { ignore: new Set(["ignored.txt"]) }), first);
    await writeFile(join(workspace, "source.txt"), "changed");
    assert.notEqual(await digestTree(workspace, { ignore: new Set(["ignored.txt"]) }), first);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
