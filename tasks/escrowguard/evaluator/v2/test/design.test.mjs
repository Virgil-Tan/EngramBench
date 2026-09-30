import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("manifest exactly freezes the 48 designed cases", async () => {
  const design = await readFile(new URL("../../HIDDEN_TEST_V2_DESIGN.zh-CN.md", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));
  const frozen = [...design.matchAll(/^### ([A-E]-\d{2}) (.+) — ([0-9.]+)$/gmu)].map((match) => ({ id: match[1], title: match[2], weight: Number(match[3]) }));
  assert.equal(frozen.length, 48);
  assert.deepEqual(manifest.cases.map(({ id, title, weight }) => ({ id, title, weight })), frozen);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(["A", "B", "C", "D", "E"].map((dimension) => [dimension, manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0)])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("production evaluator has no cross-task, old-runner, or unfinished imports", async () => {
  const files = [];
  async function visit(url) { for (const entry of await readdir(url, { withFileTypes: true })) { const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, url); if (entry.isDirectory()) { if (entry.name !== "test" && entry.name !== "node_modules") await visit(child); } else if (/\.(?:mjs|json)$/u.test(entry.name)) files.push(child); } }
  await visit(root);
  const unfinished = new RegExp(["place", "holder"].join(""), "iu");
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /tasks\/(?!escrowguard\/)|evaluator\/(?:legacy|v1)|from\s+["'][^"']*\/(?:carbonledger|dockchain|capacitylease|permitforge)\//u, file.pathname);
    assert.doesNotMatch(source, unfinished, file.pathname);
    assert.doesNotMatch(source, /\b(?:TODO|FIXME)\b/u, file.pathname);
  }
});
