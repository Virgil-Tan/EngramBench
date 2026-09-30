import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts submission seed result V1 checkpoint and case filters", () => {
  assert.deepEqual(parseArgs(["--submission", "/submission", "--result", "/result.json", "--seed", "seed", "--v1-workspace", "/v1", "--case", "A-01,E-01"]), { caseIds: ["A-01", "E-01"], workspace: "/submission", result: "/result.json", evaluationSeed: "seed", v1Workspace: "/v1" });
  assert.throws(() => parseArgs(["--submission", "/x"]), /required/u);
});

test("case selection preserves frozen order", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "E-05" }] };
  assert.deepEqual(selectCases(manifest, ["E-05", "A-01"]).map(({ id }) => id), ["A-01", "E-05"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case/u);
});

test("submission digest is stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incidentrelay-run-test-"));
  try { await writeFile(join(directory, "a.txt"), "a"); const first = await digestTree(directory); const second = await digestTree(directory); assert.equal(first, second); assert.match(first, /^[a-f0-9]{64}$/u); } finally { await rm(directory, { recursive: true, force: true }); }
});
