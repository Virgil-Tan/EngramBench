import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url)));

test("all 22 frozen AuctionGuard cases have task-owned executable implementations", () => {
  assert.equal(manifest.cases.length, 22);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
  assert.ok(CASES.every(({ taskId, run }) => taskId === "auctionguard" && typeof run === "function"));
});
