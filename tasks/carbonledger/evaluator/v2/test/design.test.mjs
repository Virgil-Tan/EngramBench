import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest, contract map, and registry exactly freeze all CarbonLedger cases", async () => {
  const [manifest, contractMap, design] = await Promise.all([json("manifest.v2.json"), json("contract-map.v2.json"), readFile(resolve(root, "../HIDDEN_TEST_V2_DESIGN.zh-CN.md"), "utf8")]); const frozen = [...design.matchAll(/^### ([A-E]-\d{2})\b.*?（([0-9]+(?:\.[0-9]+)?) 分）$/gmu)].map((match) => ({ id: match[1], weight: Number(match[2]) })); assert.equal(frozen.length, 49); assert.deepEqual(manifest.cases.map(({ id, weight }) => ({ id, weight })), frozen); assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100); assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-01", "SPEC-GAP-02"]); assert.equal(validateManifest(manifest, contractMap), true); assert.equal(validateCaseRegistry(manifest, CASES), true); assert.ok(CASES.every((item) => item.taskId === "carbonledger" && item.run.constructor.name === "AsyncFunction" && item.run.length >= 1));
});

test("runner contains no unfinished stub, old gate, or cross-task evaluator dependency", async () => {
  const files = await listFiles(root); const bannedStub = new RegExp([["TO", "DO"].join(""), ["FIX", "ME"].join(""), ["pending", "Cases"].join(""), ["not ", "implemented"].join(""), ["place", "holder"].join("")].join("|"), "iu"); const forbidden = new RegExp([["hidden", "hard-fullstack"].join("/"), ["legacy-process", "evaluator"].join("-"), "\\.\\.\\/\\.\\.\\/[^/]+\\/evaluator\\/v2", ["old H", "-"].join("")].join("|"), "iu"); for (const path of files.filter((value) => value.endsWith(".mjs") && !value.endsWith("design.test.mjs"))) { const source = await readFile(path, "utf8"); assert.doesNotMatch(source, bannedStub, path); assert.doesNotMatch(source, forbidden, path); }
});

async function json(name) { return JSON.parse(await readFile(resolve(root, name), "utf8")); }
async function listFiles(path) { const values = []; for (const entry of await readdir(path, { withFileTypes: true })) { const child = resolve(path, entry.name); if (entry.isDirectory()) values.push(...await listFiles(child)); else values.push(child); } return values; }
