import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));

test("the executable registry implements every manifest case exactly once", () => {
  assert.equal(CASES.length, 49);
  assert.equal(new Set(CASES.map(({ id }) => id)).size, 49);
  assert.deepEqual(
    CASES.map(({ id }) => id).sort(),
    manifest.cases.map(({ id }) => id).sort(),
  );

  for (const item of CASES) {
    assert.equal(typeof item.run, "function", `${item.id} has no run function`);
  }
});
