import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));

test("CLI parsing requires workspace, result and seed", () => {
  assert.deepEqual(parseArgs(["--workspace", "/tmp/work", "--result", "/tmp/result.json", "--seed", "s", "--case", "A-01,B-01"]), { caseIds: ["A-01", "B-01"], workspace: "/tmp/work", result: "/tmp/result.json", evaluationSeed: "s" }); assert.throws(() => parseArgs(["--workspace", "/tmp/work"]));
});

test("case selection preserves frozen manifest order", () => {
  assert.deepEqual(selectCases(manifest, ["B-01", "A-01"]).map(({ id }) => id), ["A-01", "B-01"]); assert.throws(() => selectCases(manifest, ["Z-99"]));
});

test("tree digest is deterministic and changes with content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "metersettle-v2-test-")); await writeFile(join(directory, "a"), "one"); const first = await digestTree(directory); const second = await digestTree(directory); assert.equal(first, second); await writeFile(join(directory, "a"), "two"); assert.notEqual(await digestTree(directory), first);
});
