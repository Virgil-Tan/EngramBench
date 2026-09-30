import assert from "node:assert/strict";
import test from "node:test";
import {
  baseBundle,
  createFixtureFactory,
  invalidBundles,
  performanceBundle,
  performanceContract,
} from "../fixtures/index.mjs";
import {
  canonicalJson,
  canonicalVersion,
  compareVersions,
  pathDigest,
  percentile,
  selectUpgradePath,
  selectedDevices,
  targetDigest,
} from "../oracles/index.mjs";

const options = {
  evaluationSeed: "private",
  caseId: "A-04",
  baseTime: "2035-07-01T12:00:00.000Z",
};
test("fixtures are deterministic and task local", () => {
  const one = createFixtureFactory(options),
    two = createFixtureFactory(options);
  assert.equal(one.uuid("device"), two.uuid("device"));
  assert.equal(one.key("request"), two.key("request"));
  assert.notEqual(one.uuid("device"), one.uuid("image"));
  assert.match(one.uuid("device"), /^[0-9a-f-]{36}$/u);
});
test("base and formal bundles freeze the published scale", () => {
  const fixtures = createFixtureFactory(options),
    bundle = baseBundle(fixtures, { devicesPerModel: 3 });
  assert.deepEqual(Object.keys(bundle.seed).sort(), [
    "campaigns",
    "commands",
    "deviceModels",
    "deviceUpdates",
    "devices",
    "firmwareImages",
    "reports",
    "schemaVersion",
    "seedVersion",
  ]);
  assert.equal(bundle.seed.devices.length, 6);
  assert.equal(bundle.seed.firmwareImages.length, 6);
  assert.equal(invalidBundles(fixtures).length, 3);
  assert.deepEqual(performanceBundle(fixtures, { materialize: false }), {
    models: 100,
    devices: 100_000,
    images: 500,
    campaigns: 100,
    updates: 100_000,
    commands: 100_000,
    reports: 0,
  });
  assert.deepEqual(performanceContract(), {
    poll: {
      clients: 64,
      warmupSeconds: 10,
      measureSeconds: 60,
      minimumThroughput: 3000,
      maximumP95Ms: 80,
    },
    report: {
      clients: 64,
      warmupSeconds: 10,
      measureSeconds: 60,
      minimumThroughput: 2000,
      maximumP95Ms: 200,
      warmupUnique: 10_000,
      measuredUnique: 60_000,
    },
    recovery: {
      items: 100_000,
      killedWorkers: 2,
      replacementWorkers: 2,
      maximumSeconds: 180,
    },
  });
});
test("version selector path digest and percentile oracles are independent", () => {
  const fixtures = createFixtureFactory(options),
    bundle = baseBundle(fixtures, { devicesPerModel: 2 }),
    model = bundle.seed.deviceModels[0],
    device = bundle.seed.devices.find((item) => item.modelId === model.modelId),
    images = bundle.seed.firmwareImages.filter(
      (item) => item.modelId === model.modelId,
    ),
    target = images.find((item) => canonicalVersion(item.version) === "4"),
    path = selectUpgradePath("1", target, images);
  assert.deepEqual(
    path.map(({ version }) => version),
    ["2", "4"],
  );
  assert.equal(pathDigest(device.deviceId, "1.0", "4.0", path).length, 64);
  assert.equal(canonicalVersion("1.0.0"), "1");
  assert.equal(compareVersions("2", "1.9"), 1);
  assert.equal(
    selectedDevices(bundle.seed.devices, { modelId: model.modelId }).length,
    2,
  );
  assert.equal(targetDigest([device]).length, 64);
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});
