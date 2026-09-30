import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("runner parses required arguments and repeated task case selection", () => {
  assert.deepEqual(parseArgs(["--workspace", "/submission", "--result", "/result.json", "--seed", "secret", "--case", "SLOT-01,PLAN-01", "--case", "RACE-03"]).caseIds, ["SLOT-01", "PLAN-01", "RACE-03"]);
  assert.throws(() => parseArgs(["--workspace", "/submission"]), /required/u);
});

test("runner selects cases in frozen manifest order", () => {
  const manifest = { cases: [{ id: "SLOT-01" }, { id: "PLAN-01" }, { id: "RACE-01" }] };
  assert.deepEqual(selectCases(manifest, ["RACE-01", "SLOT-01"]).map(({ id }) => id), ["SLOT-01", "RACE-01"]);
  assert.throws(() => selectCases(manifest, ["UNKNOWN-99"]), /unknown case/u);
});

test("tree digest is stable and ignores dependency infrastructure", async () => {
  const root = await mkdtemp(join(tmpdir(), "clinicgrid-digest-"));
  await writeFile(join(root, "a.txt"), "a");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "ignored.txt"), "first");
  const first = await digestTree(root, { ignore: new Set(["node_modules"]) });
  await writeFile(join(root, "node_modules", "ignored.txt"), "second");
  assert.equal(await digestTree(root, { ignore: new Set(["node_modules"]) }), first);
});
