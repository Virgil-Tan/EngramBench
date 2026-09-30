import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("runner parses required arguments and repeated case selection", () => {
  assert.deepEqual(parseArgs(["--workspace", "/submission", "--result", "/result.json", "--seed", "secret", "--case", "CONTRACT-01,DATA-01", "--case", "RECOVERY-03"]).caseIds, ["CONTRACT-01", "DATA-01", "RECOVERY-03"]);
  assert.throws(() => parseArgs(["--workspace", "/submission"]), /required/u);
});

test("runner selects cases in frozen order", () => {
  const manifest = { cases: [{ id: "CONTRACT-01" }, { id: "DATA-01" }, { id: "RECOVERY-01" }] };
  assert.deepEqual(selectCases(manifest, ["RECOVERY-01", "CONTRACT-01"]).map(({ id }) => id), ["CONTRACT-01", "RECOVERY-01"]);
  assert.throws(() => selectCases(manifest, ["UNKNOWN-99"]), /unknown case/u);
});

test("tree digest is stable and ignores dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "edgetwin-digest-"));
  await writeFile(join(root, "a.txt"), "a");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "ignored.txt"), "first");
  const first = await digestTree(root, { ignore: new Set(["node_modules"]) });
  await writeFile(join(root, "node_modules", "ignored.txt"), "second");
  assert.equal(await digestTree(root, { ignore: new Set(["node_modules"]) }), first);
});
