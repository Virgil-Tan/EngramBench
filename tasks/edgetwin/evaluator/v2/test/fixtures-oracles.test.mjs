import assert from "node:assert/strict";
import test from "node:test";

import { baseSeed, createFixtureFactory, performanceContract, performanceSeed, receiptPermutation } from "../fixtures/index.mjs";
import { applyMergePatch, assertEdgeInvariants, canonicalJson, partitionWaves, percentile, projectReceipts } from "../oracles/index.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "edgetwin-fixtures", caseId: "CONTRACT-01", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures freeze deterministic identities, times and exact seed shape", () => {
  assert.equal(fixtures.uuid("device"), fixtures.uuid("device"));
  assert.notEqual(fixtures.uuid("device"), fixtures.uuid("tenant"));
  assert.match(fixtures.key("shadow"), /^et-contract-01-shadow-[a-f0-9]{18}$/u);
  assert.deepEqual(Object.keys(baseSeed(fixtures)), ["schemaVersion", "seedVersion", "importedAt", "tenants", "devices", "deviceShadows", "deviceCommands", "commandReceipts", "firmwareReleases", "upgradeCampaigns", "upgradeTargets"]);
});

test("independent RFC7396 oracle merges objects, replaces scalars and deletes null keys", () => {
  assert.deepEqual(applyMergePatch({ a: 1, nested: { x: 1, y: 2 } }, { a: null, nested: { y: 3, z: 4 } }), { nested: { x: 1, y: 3, z: 4 } });
  assert.deepEqual(applyMergePatch({ a: 1 }, [1, 2]), [1, 2]);
  assert.throws(() => applyMergePatch({}, { "__proto__": { unsafe: true } }), /dangerous/u);
  assert.equal(canonicalJson({ z: 1, a: [-0, 2] }), '{"a":[0,2],"z":1}');
  assert.throws(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1), /safe integer/u);
});

test("receipt projection uses immutable identities, matching base and delivery identity rather than arrival order", () => {
  const seed = baseSeed(fixtures);
  const receipts = receiptPermutation(fixtures, seed);
  const result = projectReceipts({ shadow: seed.deviceShadows[0], command: seed.deviceCommands[0], receipts });
  assert.equal(result.shadow.reportedVersion, seed.deviceShadows[0].reportedVersion + 1);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.applied.length, 1);
  assert.equal(result.stale.length, 1);
});

test("wave partition freezes ordinals and rejects duplicate membership", () => {
  const ids = [fixtures.uuid("d1"), fixtures.uuid("d2"), fixtures.uuid("d3")];
  assert.deepEqual(partitionWaves([{ name: "canary", deviceIds: ids.slice(0, 1) }, { name: "fleet", deviceIds: ids.slice(1) }]).map(({ ordinal }) => ordinal), [0, 1]);
  assert.throws(() => partitionWaves([{ name: "a", deviceIds: [ids[0]] }, { name: "b", deviceIds: [ids[0]] }]), /one wave/u);
});

test("formal fixtures retain exact published workload sizes and close independent invariants", () => {
  const contract = performanceContract();
  assert.deepEqual(contract, {
    shadow: { devices: 100000, clients: 64, minimumThroughput: 500, maximumP95Ms: 300 },
    commands: { commands: 50000, minimumThroughput: 350, maximumP95Ms: 450, apiProcesses: 2 },
    upgrade: { devices: 10000, killedWorkers: 2, replacementWorkers: 4, maximumRecoverySeconds: 60 },
  });
  const compact = performanceSeed(fixtures, { materialize: false });
  assert.deepEqual(compact.cardinalities, { shadowDevices: 100000, commands: 50000, upgradeDevices: 10000 });
  assert.equal(percentile([8, 2, 5, 3], 0.95), 8);
  assert.doesNotThrow(() => assertEdgeInvariants({ resources: baseSeed(fixtures), work: [], events: [] }));
});
