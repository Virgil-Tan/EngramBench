import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts submission alias seed result and repeated case filters", () => {
  assert.deepEqual(parseArgs(["--submission", "/submission", "--result", "/result.json", "--seed", "a".repeat(64), "--case", "A-01,B-02", "--case", "D-03"]), { caseIds: ["A-01", "B-02", "D-03"], workspace: "/submission", result: "/result.json", evaluationSeed: "a".repeat(64) });
  assert.throws(() => parseArgs(["--submission", "/x"]), /required/u);
});

test("case selection preserves frozen manifest order", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "B-01" }] };
  assert.deepEqual(selectCases(manifest, ["B-01", "A-01"]).map((item) => item.id), ["A-01", "B-01"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case/u);
});

test("submission digest is stable and ignores named directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routepilot-run-test-"));
  try {
    await writeFile(join(directory, "a.txt"), "a");
    const first = await digestTree(directory, { ignore: new Set(["node_modules"]) });
    const second = await digestTree(directory, { ignore: new Set(["node_modules"]) });
    assert.equal(first, second); assert.match(first, /^[a-f0-9]{64}$/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
