import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI parses workspace result seed V1 and cases", () => {
  assert.deepEqual(
    parseArgs([
      "--submission",
      "/submission",
      "--result",
      "/result.json",
      "--seed",
      "private",
      "--v1-workspace",
      "/v1",
      "--case",
      "A-01,D-03",
    ]),
    {
      workspace: "/submission",
      result: "/result.json",
      evaluationSeed: "private",
      v1Workspace: "/v1",
      caseIds: ["A-01", "D-03"],
    },
  );
  assert.throws(() => parseArgs(["--submission", "/submission"]), /required/u);
});
test("case selection keeps frozen order", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "D-03" }] };
  assert.deepEqual(
    selectCases(manifest, ["D-03", "A-01"]).map(({ id }) => id),
    ["A-01", "D-03"],
  );
  assert.throws(() => selectCases(manifest, ["OTHER"]), /unknown case/u);
});
test("tree digest ignores generated dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "firmwarefleet-v2-"));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "node_modules"));
  await writeFile(join(directory, "src", "index.mjs"), "export default 1;\n");
  await writeFile(join(directory, "node_modules", "generated"), "one");
  const one = await digestTree(directory, {
    ignore: new Set(["node_modules"]),
  });
  await writeFile(join(directory, "node_modules", "generated"), "two");
  assert.equal(
    await digestTree(directory, { ignore: new Set(["node_modules"]) }),
    one,
  );
  assert.match(one, /^[a-f0-9]{64}$/u);
});
