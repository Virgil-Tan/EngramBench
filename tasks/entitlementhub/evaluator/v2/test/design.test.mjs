import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const designPath = resolve(root, "../HIDDEN_TEST_V2_DESIGN.zh-CN.md");

test("manifest, contract map, and registry freeze the EntitlementHub design", async () => {
  const [manifest, contractMap, design] = await Promise.all([json("manifest.v2.json"), json("contract-map.v2.json"), readFile(designPath, "utf8")]);
  const frozen = [...design.matchAll(/^### ([A-Z][A-Z0-9_-]*-\d+)\b.*?— ([0-9]+(?:\.[0-9]+)?) 分$/gmu)].map((match) => ({ id: match[1], weight: Number(match[2]) }));
  assert.deepEqual(manifest.cases.map(({ id, weight }) => ({ id, weight })), frozen);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-EH-01", "SPEC-GAP-EH-02", "SPEC-GAP-EH-03", "SPEC-GAP-EH-04", "SPEC-GAP-EH-05"]);
  assert.equal(validateManifest(manifest, contractMap), true); assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.ok(CASES.every((item) => item.taskId === "entitlementhub" && item.run.length >= 1));
});

test("case modules contain no placeholder or forbidden evaluator dependency", async () => {
  const forbidden = new RegExp([["TO", "DO"].join(""), ["FIX", "ME"].join(""), "map\\(pending\\)", ["case is not ", "implemented"].join(""), ["not", "Implemented"].join(""), ["legacy ", "H-\\d+"].join(""), ["hidden", "hard-fullstack"].join("/"), ["legacy-process", "evaluator"].join("-"), ["/evaluator", "run\\.mjs"].join("/"), "\\.\\.\\/\\.\\.\\/[^/]+\\/evaluator\\/v2"].join("|"), "iu");
  for (const path of await list(resolve(root, "cases"))) assert.doesNotMatch(await readFile(path, "utf8"), forbidden, path);
});

async function json(name) { return JSON.parse(await readFile(resolve(root, name), "utf8")); }
async function list(path) { const values = []; for (const entry of await readdir(path, { withFileTypes: true })) { const child = resolve(path, entry.name); if (entry.isDirectory()) values.push(...await list(child)); else if (entry.name.endsWith(".mjs")) values.push(child); } return values; }
