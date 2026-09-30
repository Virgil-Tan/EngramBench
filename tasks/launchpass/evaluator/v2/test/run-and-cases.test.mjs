import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { parseOpenApi } from "../cases/d.mjs";
import { createCaseContext } from "../lib/runtime.mjs";
import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("runner CLI accepts a frozen submission and selected LaunchPass cases", () => {
  assert.deepEqual(parseArgs([
    "--submission", "/submission",
    "--result", "/results/launchpass.json",
    "--seed", "private-seed",
    "--case", "A-01,B-04",
  ]), {
    workspace: "/submission",
    result: "/results/launchpass.json",
    evaluationSeed: "private-seed",
    caseIds: ["A-01", "B-04"],
  });
  assert.throws(() => parseArgs(["--submission", "/submission"]), /required/u);
});

test("case selection preserves manifest order and rejects unknown IDs", () => {
  const manifest = { cases: [{ id: "A-01" }, { id: "A-02" }, { id: "B-01" }] };
  assert.deepEqual(selectCases(manifest, ["B-01", "A-01"]).map(({ id }) => id), ["A-01", "B-01"]);
  assert.throws(() => selectCases(manifest, ["LP-CON-01"]), /unknown case/u);
});

test("submission digest is stable and excludes generated dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpass-v2-digest-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "index.js"), "export default 1;\n");
  await writeFile(join(root, "node_modules", "generated"), "one");
  const first = await digestTree(root, { ignore: new Set(["node_modules"]) });
  await writeFile(join(root, "node_modules", "generated"), "two");
  const second = await digestTree(root, { ignore: new Set(["node_modules"]) });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

test("the 22 cases are task-local implementations, not renamed legacy scenarios", async () => {
  const source = await Promise.all(["a", "b", "c", "d", "e"].map((family) => readFile(new URL(`../cases/${family}.mjs`, import.meta.url), "utf8")));
  const joined = source.join("\n");
  assert.doesNotMatch(joined, /hidden\/launchpass|LP-(?:E2E|CON|REC|PERF|AUD)-\d+/u);
  assert.equal(CASES.length, 22);
  assert.equal(new Set(CASES.map(({ run }) => run)).size, 22);
  for (const token of ["INSUFFICIENT_CAPACITY", "WAITLIST_ENTRY_EXISTS", "HOLD_NOT_CONFIRMABLE", "LP-GAP-01", "150 completed requests/s"]) {
    assert.match(joined, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("task-local OpenAPI parser reads JSON and the required YAML mapping surface", () => {
  const yaml = `
openapi: 3.1.0
paths:
  /api/events/{eventId}:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EventEnvelope'
components:
  schemas:
    EventEnvelope:
      type: object
      additionalProperties: false
      properties:
        event: { type: object, additionalProperties: false }
`;
  const parsed = parseOpenApi(yaml);
  assert.equal(parsed.openapi, "3.1.0");
  assert.equal(parsed.paths["/api/events/{eventId}"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/EventEnvelope");
  assert.equal(parsed.components.schemas.EventEnvelope.additionalProperties, false);
  assert.deepEqual(parseOpenApi('{"openapi":"3.1.0","paths":{}}'), { openapi: "3.1.0", paths: {} });
});

test("LaunchPass runtime adapter adds only published task seams and validates blocked assertions", async () => {
  const context = await createCaseContext({
    caseId: "A-05",
    workspace: process.cwd(),
    evaluationSeed: "adapter-test",
    baseTime: "2035-06-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    assert.equal(typeof context.createHold, "function");
    assert.equal(typeof context.joinWaitlist, "function");
    assert.equal(typeof context.withPage, "function");
    assert.notEqual(context.key("one"), context.key("one"));
    assert.doesNotThrow(() => context.blocked("waitlist-get-success-status", "LP-GAP-01"));
    assert.throws(
      () => context.blocked("invented-product-seam", "LP-GAP-01"),
      (error) => error.code === "EVALUATOR_UNDECLARED_BLOCKED_ASSERTION",
    );
  } finally {
    await context.teardown();
  }
});
