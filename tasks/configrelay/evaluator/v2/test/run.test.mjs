import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts FINAL and V1 workspaces plus frozen Case selection", () => {
  assert.deepEqual(parseArgs(["--submission","/final","--v1-workspace","/v1","--result","/result/cr.json","--seed","private","--case","E-04,A-01","--postgres-admin-url","postgresql://localhost/postgres"]), { workspace:"/final",v1Workspace:"/v1",result:"/result/cr.json",evaluationSeed:"private",caseIds:["E-04","A-01"],postgresAdminUrl:"postgresql://localhost/postgres" });
  assert.throws(() => parseArgs(["--submission","/final"]), /required/u);
});

test("Case selection preserves manifest order", () => {
  const manifest = { cases:[{id:"A-01"},{id:"B-04"},{id:"E-04"}] };
  assert.deepEqual(selectCases(manifest,["E-04","A-01"]).map(({ id }) => id), ["A-01","E-04"]);
  assert.throws(() => selectCases(manifest,["X-01"]), /unknown/u);
});

test("tree digest ignores generated dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(),"configrelay-v2-"));
  await mkdir(join(directory,"src"));
  await mkdir(join(directory,"node_modules"));
  await writeFile(join(directory,"src","index.js"),"export default 1;\n");
  await writeFile(join(directory,"node_modules","generated"),"one");
  const first = await digestTree(directory,{ ignore:new Set(["node_modules"]) });
  await writeFile(join(directory,"node_modules","generated"),"two");
  assert.equal(await digestTree(directory,{ ignore:new Set(["node_modules"]) }),first);
  assert.match(first,/^[0-9a-f]{64}$/u);
});
