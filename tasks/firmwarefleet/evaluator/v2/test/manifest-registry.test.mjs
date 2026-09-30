import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url),
  manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root))),
  contractMap = JSON.parse(
    await readFile(new URL("contract-map.v2.json", root)),
  );
const IDS = [
  "A-01",
  "A-02",
  "A-03",
  "A-04",
  "A-05",
  "B-01",
  "B-02",
  "B-03",
  "B-04",
  "B-05",
  "C-01",
  "C-02",
  "C-03",
  "C-04",
  "D-01",
  "D-02",
  "D-03",
  "D-04",
  "E-01",
  "E-02",
  "E-03",
  "E-04",
];
test("frozen design has exact IDs order weights and 100 points", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.deepEqual(
    manifest.cases.map(({ id }) => id),
    IDS,
  );
  assert.deepEqual(
    manifest.cases.map(({ weight }) => weight),
    [6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 3, 2.5, 2.5, 2.5, 2.5],
  );
  assert.equal(
    manifest.cases.reduce((sum, item) => sum + item.weight, 0),
    100,
  );
});
test("all cases are FirmwareFleet owned async run contexts", () => {
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.deepEqual(
    CASES.map(({ id }) => id),
    IDS,
  );
  for (const item of CASES) {
    assert.equal(item.taskId, "firmwarefleet");
    assert.match(item.fixtureFamily, /^FF-F-/u);
    assert.equal(item.run.constructor.name, "AsyncFunction");
    assert.equal(item.run.length, 1);
  }
});
test("D-03 is the only frozen fail-closed diagnostic", async () => {
  assert.deepEqual(
    manifest.cases
      .filter(({ blockedAssertions }) => blockedAssertions)
      .map(({ id }) => id),
    ["D-03"],
  );
  assert.deepEqual(
    manifest.cases.find(({ id }) => id === "D-03").blockedAssertions,
    [
      {
        id: "device-update-manager-extension-shape",
        blockedBy: "FF-GAP-01",
        policy: "fail-closed-diagnostic",
      },
    ],
  );
});
test("sources use only task-local public execution seams", async () => {
  const files = [
      "cases/helpers.mjs",
      "cases/a.mjs",
      "cases/b.mjs",
      "cases/c.mjs",
      "cases/d.mjs",
      "cases/e.mjs",
      "fixtures/index.mjs",
      "oracles/index.mjs",
    ],
    source = (
      await Promise.all(
        files.map((file) => readFile(new URL(file, root), "utf8")),
      )
    ).join("\n");
  for (const seam of [
    "/api/v1/firmware-images",
    "/api/v1/firmware-campaigns",
    "/commands/poll",
    "/report-batches",
    "/upgrade-plan",
    "/retry",
    "/openapi.json",
    "loadChromium",
    "worker.claimed",
    "worker.effect-complete",
    "worker.before-commit",
    "dispatcher.response-received",
    "SIGKILL",
    "performanceBundle",
    "v1Workspace",
  ])
    assert.match(
      source,
      new RegExp(seam.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `missing ${seam}`,
    );
  assert.doesNotMatch(source, /tasks\/(?!firmwarefleet)[a-z0-9-]+\/evaluator/u);
  assert.doesNotMatch(
    source,
    /legacy.*evaluator|placeholder|TODO|not implemented/iu,
  );
});
