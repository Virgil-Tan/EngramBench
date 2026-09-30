import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts submission alias, seed, result, V1 checkpoint, and case selection", () => {
  assert.deepEqual(parseArgs([
    "--submission", "/candidate",
    "--result", "/result.json",
    "--seed", "secret",
    "--v1-workspace", "/v1",
    "--case", "A-09,B-03",
  ]), {
    workspace: "/candidate",
    result: "/result.json",
    evaluationSeed: "secret",
    v1Workspace: "/v1",
    caseIds: ["A-09", "B-03"],
  });
});

test("case selection follows manifest order and rejects unknown ids", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "B-01" }, { id: "E-07" }] };
  assert.deepEqual(selectCases(manifest, ["E-07", "A-01"]).map(({ id }) => id), ["A-01", "E-07"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case ids/u);
});

test("tree digest is deterministic and ignores named directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parcelflow-v2-digest-"));
  try {
    await writeFile(join(directory, "a.txt"), "alpha");
    const first = await digestTree(directory, { ignore: new Set(["node_modules"]) });
    const second = await digestTree(directory, { ignore: new Set(["node_modules"]) });
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
