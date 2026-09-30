import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compilationBody, evaluationBody, writePerformanceSeed } from "../cases/perf.mjs";
import { snapshotDigest } from "../oracles/index.mjs";

test("perf-v1 catalog is exact and task-local", async () => { const directory = await mkdtemp(join(tmpdir(), "flagfoundry-perf-test-")); try { const catalog = await writePerformanceSeed({ tempPath: (name) => join(directory, name) }); assert.equal(catalog.projects.length, 100); assert.equal(catalog.environments.length, 300); assert.equal(catalog.flags.length, 5_000); assert.equal(catalog.activeRevisions.length, 5_000); assert.equal(catalog.pairs.length, 5_000); assert.equal(new Set(catalog.pairs.map(({ flag }) => flag.flagId)).size, 5_000); for (const pair of catalog.pairs.slice(0, 20)) assert.equal(pair.revision.snapshotDigest, snapshotDigest(pair.snapshot)); const compiled = compilationBody(catalog, catalog.pairs[0], 1); assert.equal(compiled.variants.length, 2); assert.equal(compiled.rules.length, 10); assert.equal(compiled.variants.reduce((sum, item) => sum + item.allocationBasisPoints, 0), 10_000); assert.deepEqual(Object.keys(evaluationBody(catalog.pairs[0], 1).context).sort(), ["region", "subjectKey", "tier"]); } finally { await rm(directory, { recursive: true, force: true }); } });
