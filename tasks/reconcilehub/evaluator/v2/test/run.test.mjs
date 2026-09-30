import assert from "node:assert/strict";
import test from "node:test";

import { digestTree, parseArgs, selectCases } from "../run.mjs";

const manifest = { cases: [{ id: "A-01" }, { id: "B-01" }, { id: "E-04" }] };

test("runner parses reproducibility inputs and repeated case selection", () => {
  assert.deepEqual(parseArgs(["--workspace", "/tmp/work", "--result", "/tmp/result.json", "--seed", "seed", "--case", "A-01,B-01", "--case", "E-04"]), {
    workspace: "/tmp/work", result: "/tmp/result.json", evaluationSeed: "seed", caseIds: ["A-01", "B-01", "E-04"],
  });
});

test("runner selects cases in frozen manifest order", () => {
  assert.deepEqual(selectCases(manifest, ["E-04", "A-01"]), [{ id: "A-01" }, { id: "E-04" }]);
  assert.throws(() => selectCases(manifest, ["X-99"]), /unknown case/iu);
});

test("tree digest is stable and ignores dependency infrastructure", async () => {
  const first = await digestTree(new URL(".", import.meta.url), { ignore: new Set(["node_modules"]) });
  const second = await digestTree(new URL(".", import.meta.url), { ignore: new Set(["node_modules"]) });
  assert.equal(first, second);
});
