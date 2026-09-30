import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import {
  allocateRoyalty,
  assertAggregateSequences,
  assertBalancedPosting,
  assertRetryIdentity,
  chunkOracle,
  editionManifestDigest,
  fraudV1,
  periodEntries,
  renditionOracle,
} from "../oracles/index.mjs";

function factory(caseId = "A-01") {
  return createFixtureFactory({ evaluationSeed: "creator-rights-test-seed", caseId, baseTime: "2035-06-01T12:00:00.000Z" });
}

test("CreatorRightsExchange fixtures are deterministic, isolated and task-owned", () => {
  const left = factory("A-08").upload("media");
  const right = factory("A-08").upload("media");
  const other = factory("B-01").upload("media");
  assert.equal(left.fixtureFamily, "CRE-F-UPLOAD");
  assert.deepEqual(left.seed, right.seed);
  assert.deepEqual(left.media, right.media);
  assert.notEqual(left.uploadId, other.uploadId);
  assert.equal(left.seed.uploadSessions.length, 0);
});

test("raw chunk and rendition oracles preserve exact managed bytes", () => {
  const value = factory("A-08").upload("chunks");
  const plan = chunkOracle(value.media, value.chunkSize);
  assert.equal(plan.sha256, value.uploadSession.contentSha256);
  assert.equal(Buffer.concat(plan.chunks.map(({ bytes }) => bytes)).compare(value.media), 0);
  assert.equal(plan.chunks.at(-1).endByte, value.media.length - 1);
  const copy = renditionOracle(value.media, value.profiles[0]);
  const prefixed = renditionOracle(value.media, value.profiles[1]);
  assert.equal(copy.bytes.compare(value.media), 0);
  assert.equal(prefixed.bytes.subarray(-value.media.length).compare(value.media), 0);
  assert.notEqual(prefixed.sha256, copy.sha256);
});

test("Edition, fraud and largest-remainder oracles are independent", () => {
  const value = factory("A-10").edition("manifest");
  const first = editionManifestDigest({ rightsRevision: 1, assets: [value.editionAsset] });
  const second = editionManifestDigest({ rightsRevision: 2, assets: [value.editionAsset] });
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.notEqual(first, second);
  assert.deepEqual(fraudV1({ velocity: 49, country: "US", deviceTrust: "KNOWN" }), { rulesVersion: 1, score: 0, recommendation: "APPROVE" });
  assert.deepEqual(fraudV1({ velocity: 50, country: "US", deviceTrust: "KNOWN" }), { rulesVersion: 1, score: 300, recommendation: "REVIEW" });
  assert.deepEqual(fraudV1({ velocity: 50, country: "XX", deviceTrust: "NEW" }), { rulesVersion: 1, score: 600, recommendation: "BLOCK" });
  assert.deepEqual(allocateRoyalty(10_001, value.rightsSplits).map(({ amountMinor }) => amountMinor), [3_333, 3_333, 3_335]);
});

test("posting, period and aggregate sequence oracles reject common corruption", () => {
  const posting = [
    { royaltyEntryId: "entry-a", postingId: "post", direction: "DEBIT", amountMinor: 10_001, currency: "USD", createdAt: "2035-06-01T00:00:00.000Z" },
    { royaltyEntryId: "entry-b", postingId: "post", direction: "CREDIT", amountMinor: 10_001, currency: "USD", createdAt: "2035-06-02T00:00:00.000Z" },
  ];
  assert.equal(assertBalancedPosting(posting), true);
  assert.throws(() => assertBalancedPosting([{ ...posting[0], amountMinor: 9_999 }, posting[1]]));
  assert.deepEqual(periodEntries(posting, "2035-06-01T00:00:00.000Z", "2035-06-02T00:00:00.000Z").map(({ royaltyEntryId }) => royaltyEntryId), ["entry-a"]);
  const events = [
    { eventId: "event-2", aggregateType: "Edition", aggregateId: "edition", sequence: 2 },
    { eventId: "event-1", aggregateType: "Edition", aggregateId: "edition", sequence: 1 },
  ];
  assert.equal(assertAggregateSequences(events), true);
  assert.throws(() => assertAggregateSequences([{ ...events[0], sequence: 3 }, events[1]]));
  const receiver = [
    { headers: { "x-event-id": "event-a" }, raw: '{"id":"a"}' },
    { headers: { "x-event-id": "event-a" }, raw: '{"id":"a"}' },
  ];
  assert.equal(assertRetryIdentity(receiver), true);
  assert.throws(() => assertRetryIdentity([receiver[0], { ...receiver[1], raw: '{"id":"changed"}' }]));
});

test("performance fixtures freeze all six published scenarios", () => {
  const scenarios = factory("E-04").performance().scenarios;
  assert.deepEqual(Object.keys(scenarios), [
    "multipartEditionPipeline",
    "licenseCheckoutUncertainty",
    "fraudReviewRelease",
    "entitlementReadStorm",
    "royaltyLedgerClose",
    "notificationRecovery",
  ]);
  assert.equal(scenarios.multipartEditionPipeline.assets, 240);
  assert.equal(scenarios.entitlementReadStorm.grants, 20_000);
  assert.equal(scenarios.royaltyLedgerClose.entries, 100_000);
  assert.equal(scenarios.notificationRecovery.notifications, 10_000);
});
