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

test("manifest, contract map, and registry freeze the SeatReserve design", async () => {
  const [manifest, contractMap, design] = await Promise.all([readJson("manifest.v2.json"), readJson("contract-map.v2.json"), readFile(designPath, "utf8")]);
  const frozen = [...design.matchAll(/^### ([A-E]-\d{2})\b.*?— ([0-9]+(?:\.[0-9]+)?) 分$/gmu)].map((match) => ({ id: match[1], weight: Number(match[2]) }));
  assert.equal(frozen.length, 22); assert.deepEqual(manifest.cases.map(({ id, weight }) => ({ id, weight })), frozen); assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100); assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-SR-01", "SPEC-GAP-SR-02"]); assert.equal(validateManifest(manifest, contractMap), true); assert.equal(validateCaseRegistry(manifest, CASES), true); assert.ok(CASES.every((item) => item.taskId === "seatreserve" && item.run.length >= 1));
});

test("runner contains no placeholder, old-runner, or cross-task evaluator import", async () => {
  const files = await listFiles(root); const placeholderPattern = new RegExp([["TO", "DO"].join(""), ["FIX", "ME"].join(""), "map\\(pending\\)", ["case is not ", "implemented"].join(""), ["not", "Implemented"].join(""), ["legacy ", "H-\\d+"].join("")].join("|"), "iu"); const crossTaskPattern = new RegExp([["hidden", "hard-fullstack"].join("/"), ["legacy-process", "evaluator"].join("-"), ["/evaluator", "run\\.mjs"].join("/"), "\\.\\.\\/\\.\\.\\/[^/]+\\/evaluator\\/v2"].join("|"), "iu");
  for (const path of files.filter((value) => value.endsWith(".mjs"))) { const source = await readFile(path, "utf8"); assert.doesNotMatch(source, placeholderPattern, path); assert.doesNotMatch(source, crossTaskPattern, path); }
});

async function readJson(name) { return JSON.parse(await readFile(resolve(root, name), "utf8")); }
async function listFiles(path) { const values = []; for (const entry of await readdir(path, { withFileTypes: true })) { const child = resolve(path, entry.name); if (entry.isDirectory()) values.push(...await listFiles(child)); else values.push(child); } return values; }
