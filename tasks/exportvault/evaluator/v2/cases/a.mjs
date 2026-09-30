import assert from "node:assert/strict";

import {
  assertExport, assertManifest, assertShard, cancelExport, createExport, createGrant, defineCase, downloadGrant,
  expectError, finalEvidence, generateExport, getEvents, getExport, getSections, jsonlBytes, materializeSeed,
  planShards, prepare, rangeOracle, revokeGrant, sectionOracle, sha256, startPreparedApi, waitForDrain, waitForExport,
} from "./helpers.mjs";

const A01 = defineCase({
  id: "A-01", fixtureFamily: "EV-F-BYTES",
  action: "Import two public Dataset Revisions, create JSONL and CSV Exports through HTTP, run workers, and download both immutable results.",
  oracle: "Independently encode the captured revision in normalized scope and recordId order, then compare every response byte and section boundary.",
  async run(ctx) {
    const fixture = ctx.fixtures.bytes(); const api = await startPreparedApi(ctx, { fixture }); const scope = ["activity", "profile"];
    const jsonCreated = await createExport(ctx, api.baseUrl, { subjectId: fixture.owner.subjectId, scope, format: "JSONL" });
    const csvCreated = await createExport(ctx, api.baseUrl, { subjectId: fixture.owner.subjectId, scope, format: "CSV" }, { key: ctx.key("csv") });
    ctx.equal(jsonCreated.datasetRevision, 2, "JSONL captures current Dataset Revision"); ctx.equal(csvCreated.datasetRevision, 2, "CSV captures current Dataset Revision");
    const workers = [await ctx.startWorker(), await ctx.startWorker()]; const [jsonReady, csvReady] = await Promise.all([waitForExport(ctx, api.baseUrl, jsonCreated.exportId, "READY", workers), waitForExport(ctx, api.baseUrl, csvCreated.exportId, "READY", workers)]);
    const records = fixture.records.filter((record) => scope.includes(record.scope)); const expected = new Map([[jsonReady.exportId, jsonlBytes(records)], [csvReady.exportId, (await import("./helpers.mjs")).csvBytes(records)]]);
    for (const ready of [jsonReady, csvReady]) { assertExport(ready); const grant = await createGrant(ctx, api.baseUrl, ready.exportId, { expiresInSeconds: 300 }, { key: ctx.key(`grant:${ready.exportId}`) }); const response = await downloadGrant(ctx, api.baseUrl, grant.grantId); ctx.equal(response.status, 200, `${ready.format} full download status`); ctx.equal(response.body, expected.get(ready.exportId), `${ready.format} bytes`); ctx.equal(ready.object.sha256, sha256(response.body), `${ready.format} SHA-256`); ctx.equal(ready.object.size, response.body.length, `${ready.format} size`); const sections = await getSections(ctx, api.baseUrl, ready.exportId); const boundaries = sectionOracle(scope, records); ctx.equal(sections.map(({ name, recordCount, firstRecordId, lastRecordId }) => ({ name, recordCount, firstRecordId, lastRecordId })), boundaries.map(({ digest: _digest, ...item }) => item), `${ready.format} section boundaries`); ctx.ok(sections.every(({ state }) => state === "VERIFIED"), `${ready.format} sections verified`); }
    const before = await ctx.snapshot(api.baseUrl); const invalid = await createExport(ctx, api.baseUrl, { subjectId: fixture.owner.subjectId, scope: ["profile", "profile"], format: "JSONL" }, { allowFailure: true, key: ctx.key("invalid") }); expectError(ctx, invalid, 400, "INVALID_EXPORT_SCOPE", "duplicate scope"); const after = await ctx.snapshot(api.baseUrl); ctx.equal(after.resources.exports.length, before.resources.exports.length, "invalid request creates no Export"); ctx.equal(after.work.length, before.work.length, "invalid request creates no Work"); ctx.equal(after.events.length, before.events.length, "invalid request creates no Event");
    return finalEvidence(ctx, { revision: 2, formats: ["JSONL", "CSV"], recordCount: records.length });
  },
});

const A02 = defineCase({
  id: "A-02", fixtureFamily: "EV-F-LIFECYCLE",
  action: "Exercise REQUESTED cancellation, terminal replay, successful worker publication, forbidden READY cancellation, and terminal public reads.",
  oracle: "Compare every observed state against the one-way Export state machine and require one contiguous event sequence with no object after cancellation.",
  async run(ctx) {
    const fixture = ctx.fixtures.bytes(); const api = await startPreparedApi(ctx, { fixture });
    const requested = await createExport(ctx, api.baseUrl, { subjectId: fixture.owner.subjectId, scope: ["profile"], format: "CSV" }); const key = ctx.key("cancel"); const cancelled = await cancelExport(ctx, api.baseUrl, requested.exportId, "owner-cancel", { key }); const replay = await cancelExport(ctx, api.baseUrl, requested.exportId, "owner-cancel", { key }); ctx.equal(replay, cancelled, "cancel replay body"); ctx.equal(cancelled.state, "CANCELLED", "REQUESTED cancel terminal"); ctx.equal(cancelled.object, null, "cancelled Export has no object"); ctx.equal(cancelled.readyAt, null, "cancelled Export has no readyAt");
    const published = await generateExport(ctx, api, { subjectId: fixture.owner.subjectId, scope: ["activity"], format: "JSONL" }, { key: ctx.key("published") }); const denied = await cancelExport(ctx, api.baseUrl, published.ready.exportId, "too-late", { allowFailure: true, key: ctx.key("late-cancel") }); expectError(ctx, denied, 409, "EXPORT_NOT_CANCELLABLE", "READY cancel"); const stable = await getExport(ctx, api.baseUrl, published.ready.exportId); ctx.equal(stable.state, "READY", "publication remains READY"); ctx.ok(stable.object !== null, "READY has complete object");
    const cancelledEvents = await getEvents(ctx, api.baseUrl, requested.exportId); const readyEvents = await getEvents(ctx, api.baseUrl, published.ready.exportId); ctx.equal(cancelledEvents.map(({ type }) => type), ["export.requested", "export.cancelled"], "cancel event sequence"); ctx.equal(readyEvents.map(({ type }) => type), ["export.requested", "export.ready"], "ready event sequence");
    return finalEvidence(ctx, { cancelledSequence: cancelled.sequence, readySequence: stable.sequence });
  },
});

const A03 = defineCase({
  id: "A-03", fixtureFamily: "EV-F-GRANT",
  action: "Create and replay a Download Grant, fetch the immutable object with exact full and single-range requests, then revoke and retry access.",
  oracle: "Slice evaluator-owned bytes for every Range, recompute SHA-256 and ETag stability, and require expired semantics without target disclosure.",
  async run(ctx) {
    const fixture = ctx.fixtures.bytes(); const ranges = ctx.fixtures.grant().ranges; const api = await startPreparedApi(ctx, { fixture }); const generated = await generateExport(ctx, api, { subjectId: fixture.owner.subjectId, scope: ["activity", "profile"], format: "JSONL" }); const key = ctx.key("grant-replay"); const grant = await createGrant(ctx, api.baseUrl, generated.ready.exportId, { expiresInSeconds: 300 }, { key }); const replay = await createGrant(ctx, api.baseUrl, generated.ready.exportId, { expiresInSeconds: 300 }, { key }); ctx.equal(replay, grant, "Grant replay fields");
    const full = await downloadGrant(ctx, api.baseUrl, grant.grantId); ctx.equal(full.status, 200, "full download status"); ctx.equal(sha256(full.body), generated.ready.object.sha256, "full object digest"); const etag = full.headers.get("etag"); ctx.ok(typeof etag === "string" && etag.length > 0, "full response ETag");
    for (const header of ranges.slice(1)) { const expected = rangeOracle(full.body, header); const response = await downloadGrant(ctx, api.baseUrl, grant.grantId, { headers: { range: header } }); ctx.equal(response.status, expected.status, `${header} status`); if (expected.status === 206) { ctx.equal(response.body, expected.body, `${header} bytes`); ctx.equal(response.headers.get("content-range"), `bytes ${expected.start}-${expected.end}/${full.body.length}`, `${header} Content-Range`); ctx.equal(Number(response.headers.get("content-length")), expected.body.length, `${header} Content-Length`); ctx.equal(response.headers.get("etag"), etag, `${header} stable ETag`); } }
    const revokeKey = ctx.key("revoke"); const revoked = await revokeGrant(ctx, api.baseUrl, grant.grantId, "owner", { key: revokeKey }); const revokedReplay = await revokeGrant(ctx, api.baseUrl, grant.grantId, "owner", { key: revokeKey }); ctx.equal(revokedReplay, revoked, "revoke replay body"); const gone = await downloadGrant(ctx, api.baseUrl, grant.grantId); expectError(ctx, gone, 410, "DOWNLOAD_GRANT_EXPIRED", "revoked Grant download");
    const pending = await createExport(ctx, api.baseUrl, { subjectId: fixture.owner.subjectId, scope: ["files"], format: "CSV" }, { key: ctx.key("pending") }); const denied = await createGrant(ctx, api.baseUrl, pending.exportId, { expiresInSeconds: 300 }, { allowFailure: true, key: ctx.key("pending-grant") }); expectError(ctx, denied, 409, "EXPORT_NOT_READY", "Grant before READY");
    return finalEvidence(ctx, { rangeCount: ranges.length - 1, bytes: full.body.length, etag });
  },
});

const A04 = defineCase({
  id: "A-04", fixtureFamily: "EV-F-LIFECYCLE",
  action: "Import live and expired READY objects, preserve a live Grant control, run two cleanup workers, and inspect bytes, proofs, state, and events.",
  oracle: "Use retention and active-grant reachability to identify the exact deletion set, then require one proof/event per deletion and byte-readable controls.",
  async run(ctx) {
    const fixture = ctx.fixtures.lifecycle(); const api = await startPreparedApi(ctx, { fixture }); const live = fixture.exports.find((item) => item.retentionUntil > "2030-01-01T00:00:00.000Z"); const expired = fixture.exports.find((item) => item.state === "READY" && item.retentionUntil < "2030-01-01T00:00:00.000Z"); ctx.ok(live && expired, "fixture includes live and expired READY controls"); const grant = await createGrant(ctx, api.baseUrl, live.exportId, { expiresInSeconds: 300 }, { key: ctx.key("live-grant") }); const before = await downloadGrant(ctx, api.baseUrl, grant.grantId); ctx.equal(before.status, 200, "live control readable before cleanup");
    const workers = [await ctx.startWorker(), await ctx.startWorker()]; const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: workers, predicate: ({ kind }) => kind === "EXPORT_CLEANUP" }); const proof = snapshot.resources.deletionProofs.filter((item) => item.exportId === expired.exportId); ctx.equal(proof.length, 1, "expired Export has exactly one proof"); ctx.equal(proof[0].objectSha256, expired.object.sha256, "proof closes deleted digest"); const liveAfter = await downloadGrant(ctx, api.baseUrl, grant.grantId); ctx.equal(liveAfter.status, 200, "live Grant object survives cleanup"); ctx.equal(liveAfter.body, before.body, "live object bytes survive cleanup"); const expiredRead = await getExport(ctx, api.baseUrl, expired.exportId); ctx.equal(expiredRead.state, "EXPIRED", "expired object state"); const events = await getEvents(ctx, api.baseUrl, expired.exportId); ctx.equal(events.filter(({ type }) => type === "export.deleted").length, 1, "one deletion event");
    return finalEvidence(ctx, { deletedExportId: expired.exportId, proofDigest: proof[0].proofDigest, liveControl: live.exportId });
  },
});

const A05 = defineCase({
  id: "A-05", fixtureFamily: "EV-F-SHARD",
  action: "Seed the worked 100003-record dataset, create a sharded Export through the unchanged public request, run concurrent workers, and download every target.",
  oracle: "Recompute non-crossing shard boundaries, ordered Manifest RFC 8785 bytes, both manifest digests, and target-specific immutable grant bytes.",
  async run(ctx) {
    const fixture = ctx.fixtures.shard(); const owner = { subjectId: ctx.uuid("shard-subject"), name: "Sharded Subject", currentDatasetRevision: 1 }; const records = fixture.workedExample.sections.flatMap((section) => section.recordIds.map((recordId, index) => ({ recordId, scope: section.name, data: { index, section: section.name } }))); const seed = { schemaVersion: 1, seedVersion: "a05-shard-worked-example", subjects: [owner], datasetRevisions: [{ subjectId: owner.subjectId, revision: 1, committedAt: ctx.at({ minutes: -1 }), records }], exports: [] };
    const target = await prepare(ctx, { seed }); const api = await target.startApi(); const created = await createExport(ctx, api.baseUrl, { subjectId: owner.subjectId, scope: ["profile", "activity"], format: "JSONL" }, { sharded: true }); const expectedPlan = planShards(fixture.workedExample.sections, 100000); ctx.equal(created.shards.length, expectedPlan.length, "complete shard plan committed with Export");
    for (let index = 0; index < created.shards.length; index += 1) { const actual = assertShard(created.shards[index]); const expected = expectedPlan[index]; ctx.equal({ ordinal: actual.ordinal, section: actual.section, range: actual.range, recordCount: actual.recordCount }, expected, `shard ${index} plan`); }
    ctx.equal(created.object, null, "sharded Export object remains null"); ctx.equal(created.manifest, null, "Manifest absent before all verification"); const premature = await createGrant(ctx, api.baseUrl, created.exportId, { target: "MANIFEST", expiresInSeconds: 300 }, { sharded: true, allowFailure: true, key: ctx.key("premature-manifest") }); expectError(ctx, premature, 409, "EXPORT_SHARD_NOT_READY", "Manifest Grant before ready");
    const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker())); const ready = assertExport(await waitForExport(ctx, api.baseUrl, created.exportId, "READY", workers, { timeoutMs: 300_000 }), { sharded: true }); ctx.ok(ready.shards.every(({ state }) => state === "VERIFIED"), "all shards verified before READY"); ctx.ok(ready.manifest !== null, "READY sharded Export has Manifest");
    const shardBodies = []; for (const shard of ready.shards) { const grant = await createGrant(ctx, api.baseUrl, ready.exportId, { target: "SHARD", shardId: shard.shardId, expiresInSeconds: 300 }, { sharded: true, key: ctx.key(`shard-grant:${shard.ordinal}`) }); const response = await downloadGrant(ctx, api.baseUrl, grant.grantId); ctx.equal(response.status, 200, `Shard ${shard.ordinal} download`); ctx.equal(sha256(response.body), shard.object.sha256, `Shard ${shard.ordinal} digest`); shardBodies.push(response.body.length); }
    const manifestGrant = await createGrant(ctx, api.baseUrl, ready.exportId, { target: "MANIFEST", expiresInSeconds: 300 }, { sharded: true, key: ctx.key("manifest-grant") }); const manifestResponse = await downloadGrant(ctx, api.baseUrl, manifestGrant.grantId); ctx.equal(manifestResponse.status, 200, "Manifest download"); assertManifest(ready.manifest, manifestResponse.body); const badTarget = await createGrant(ctx, api.baseUrl, ready.exportId, { target: "SHARD", shardId: ctx.uuid("unknown-shard"), expiresInSeconds: 300 }, { sharded: true, allowFailure: true, key: ctx.key("bad-target") }); expectError(ctx, badTarget, 400, "INVALID_EXPORT_DOWNLOAD_TARGET", "unknown Shard target");
    return ctx.pass({ blockedAssertions: [{ assertionId: "EV-A05-ZERO-RECORD-MANIFEST", blockedBy: "EV-GAP-02", policy: "fail-closed-diagnostic" }], evidence: [{ kind: "exportvault-case-summary", shardCount: ready.shards.length, shardBodies, manifestDigest: ready.manifest.canonicalDigest }] });
  },
});

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05]);
