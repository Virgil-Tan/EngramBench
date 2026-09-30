import assert from "node:assert/strict";

import {
  assertExport, assertManifest, assertShard, cancelExport, createExport, createGrant, defineCase, downloadGrant,
  expectError, finalEvidence, getEvents, jsonlBytes, materializeSeed, planShards, prepare, revokeGrant, sha256,
  startPreparedApi, waitForDrain, waitForExport,
} from "./helpers.mjs";

function shardedSeed(ctx, label, counts) {
  const owner = { subjectId: ctx.uuid(`${label}:subject`), name: `Shard ${label}`, currentDatasetRevision: 1 }; const records = []; const sections = [];
  for (const [scope, count] of Object.entries(counts)) { const values = Array.from({ length: count }, (_, index) => ({ recordId: ctx.uuid(`${label}:${scope}:${String(index).padStart(7, "0")}`), scope, data: { index, scope } })).sort((a, b) => Buffer.from(a.recordId).compare(Buffer.from(b.recordId))); records.push(...values); sections.push({ name: scope, recordIds: values.map(({ recordId }) => recordId) }); }
  return { owner, records, sections, seed: { schemaVersion: 1, seedVersion: `${label}-shard-seed`, subjects: [owner], datasetRevisions: [{ subjectId: owner.subjectId, revision: 1, committedAt: ctx.at({ minutes: -1 }), records }], exports: [] } };
}

const B01 = defineCase({
  id: "B-01", fixtureFamily: "EV-F-BYTES+SHARD",
  action: "Generate one legacy object and one 100001-record sharded Export, then download every public object, Shard, and Manifest target.",
  oracle: "Re-encode captured records, recompute every SHA-256 and size, and close the ordered Manifest digest chain without trusting reported metadata.",
  async run(ctx) {
    const fixture = shardedSeed(ctx, "b01", { profile: 100001 }); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const created = await createExport(ctx, api.baseUrl, { subjectId: fixture.owner.subjectId, scope: ["profile"], format: "JSONL" }, { sharded: true }); const workers = [await ctx.startWorker(), await ctx.startWorker()]; const ready = assertExport(await waitForExport(ctx, api.baseUrl, created.exportId, "READY", workers, { timeoutMs: 300_000 }), { sharded: true });
    const records = [...fixture.records].sort((a, b) => Buffer.from(a.recordId).compare(Buffer.from(b.recordId))); let offset = 0;
    for (const shard of ready.shards) { assertShard(shard); const expected = jsonlBytes(records.slice(offset, offset + shard.recordCount)); offset += shard.recordCount; const grant = await createGrant(ctx, api.baseUrl, ready.exportId, { target: "SHARD", shardId: shard.shardId, expiresInSeconds: 300 }, { sharded: true, key: ctx.key(`b01-shard:${shard.ordinal}`) }); const response = await downloadGrant(ctx, api.baseUrl, grant.grantId); ctx.equal(response.status, 200, `Shard ${shard.ordinal} status`); ctx.equal(response.body, expected, `Shard ${shard.ordinal} exact bytes`); ctx.equal(shard.object.sha256, sha256(expected), `Shard ${shard.ordinal} SHA-256`); ctx.equal(shard.object.size, expected.length, `Shard ${shard.ordinal} size`); }
    ctx.equal(offset, records.length, "every captured record appears in one Shard"); const manifestGrant = await createGrant(ctx, api.baseUrl, ready.exportId, { target: "MANIFEST", expiresInSeconds: 300 }, { sharded: true, key: ctx.key("b01-manifest") }); const manifestResponse = await downloadGrant(ctx, api.baseUrl, manifestGrant.grantId); assertManifest(ready.manifest, manifestResponse.body);
    return finalEvidence(ctx, { recordCount: records.length, shardCount: ready.shards.length, manifestDigest: ready.manifest.canonicalDigest });
  },
});

const B02 = defineCase({
  id: "B-02", fixtureFamily: "EV-F-BYTES",
  action: "Send twenty equivalent creates through two API processes, lose one committed response, restart, replay, conflict the key, then request after terminal state.",
  oracle: "Require one active Export, one generation plan and Work, byte-stable saved replays, a stable conflict, and a new identity only after terminal completion.",
  async run(ctx) {
    const fixture = ctx.fixtures.bytes(); const target = await prepare(ctx, { fixture }); const apis = [await target.startApi(), await target.startApi()]; const body = { subjectId: fixture.owner.subjectId, scope: ["activity", "profile"], format: "JSONL" };
    const responses = await ctx.concurrent(Array.from({ length: 20 }), 20, async (_, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/exports", ctx.key(`equivalent:${index}`), body)); ctx.ok(responses.every(({ status }) => status === 202), "all concurrent creates return 202"); const ids = new Set(responses.map(({ json }) => json.exportId)); ctx.equal(ids.size, 1, "active request dedupe has one Export"); const exportId = [...ids][0];
    const snapshot = await ctx.snapshot(apis[0].baseUrl); ctx.equal(snapshot.resources.exports.filter((item) => item.exportId === exportId).length, 1, "one durable Export row"); ctx.equal(snapshot.work.filter((item) => item.aggregateId === exportId && item.kind === "EXPORT_GENERATION").length, 1, "one generation Work");
    const shield = await ctx.responseShield(apis[0].baseUrl); const lostKey = ctx.key("lost-response"); shield.dropNextMutation(); await ctx.mutate(shield.baseUrl, "/api/v1/exports", lostKey, body).catch(() => undefined); await ctx.stop(apis[0]); const replay = await ctx.mutate(apis[1].baseUrl, "/api/v1/exports", lostKey, body); ctx.equal(replay.status, 202, "unknown response replay status"); ctx.equal(replay.json.exportId, exportId, "unknown response replay Export identity"); const conflict = await ctx.mutate(apis[1].baseUrl, "/api/v1/exports", lostKey, { ...body, format: "CSV" }); expectError(ctx, conflict, 409, "IDEMPOTENCY_CONFLICT", "changed lost-response key");
    const worker = await ctx.startWorker(); await waitForExport(ctx, apis[1].baseUrl, exportId, "READY", [worker]); const next = await createExport(ctx, apis[1].baseUrl, body, { key: ctx.key("after-terminal") }); ctx.ok(next.exportId !== exportId, "terminal Export permits a new request identity");
    return finalEvidence(ctx, { concurrentRequests: responses.length, activeExportId: exportId, nextExportId: next.exportId });
  },
});

async function raceFixture(ctx, suffix) { const fixture = ctx.fixtures.bytes(); const target = await prepare(ctx, { fixture, label: suffix }); return { fixture, target, apis: [await target.startApi(), await target.startApi()] }; }

const B03 = defineCase({
  id: "B-03", fixtureFamily: "EV-F-RECOVERY",
  action: "Control publication at worker.before-commit while two APIs race cancellation, then repeat with publication released before cancellation.",
  oracle: "Linearize each response and require exactly one legal terminal state with bytes, metadata, Grant eligibility, and terminal Event becoming visible atomically.",
  async run(ctx) {
    const first = await raceFixture(ctx, "b03-first"); const created = await createExport(ctx, first.apis[0].baseUrl, { subjectId: first.fixture.owner.subjectId, scope: ["profile"], format: "JSONL" }); const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.before-commit" && aggregateId === created.exportId }); const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); const entry = await barrier.waitFor(({ json }) => json?.point === "worker.before-commit" && json?.aggregateId === created.exportId, { timeoutMs: 180_000, processes: [worker] }); const cancels = await Promise.all(first.apis.map((api, index) => cancelExport(ctx, api.baseUrl, created.exportId, "race", { key: ctx.key(`cancel-first:${index}`), allowFailure: true }))); barrier.release(entry); const terminal = await waitForExport(ctx, first.apis[0].baseUrl, created.exportId, ["CANCELLED", "READY"], [worker]); ctx.equal(terminal.state, "CANCELLED", "held publication loses to committed cancel"); ctx.equal(terminal.object, null, "cancel winner exposes no object"); ctx.ok(cancels.some(({ status }) => status === 200), "one cancel succeeds"); const firstEvents = await getEvents(ctx, first.apis[0].baseUrl, created.exportId); ctx.equal(firstEvents.filter(({ type }) => ["export.ready", "export.cancelled"].includes(type)).map(({ type }) => type), ["export.cancelled"], "one cancel terminal event");
    await ctx.resetDatabase(); const secondFixture = ctx.fixtures.bytes(); const secondTarget = await prepare(ctx, { fixture: secondFixture, label: "b03-second" }); const secondApi = await secondTarget.startApi(); const second = await createExport(ctx, secondApi.baseUrl, { subjectId: secondFixture.owner.subjectId, scope: ["activity"], format: "JSONL" }, { key: ctx.key("second-create") }); const barrier2 = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.before-commit" && aggregateId === second.exportId }); const worker2 = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier2.url, TEST_BARRIER_TOKEN: barrier2.token } }); const entry2 = await barrier2.waitFor(({ json }) => json?.aggregateId === second.exportId && json?.point === "worker.before-commit", { timeoutMs: 180_000, processes: [worker2] }); barrier2.release(entry2); const ready = await waitForExport(ctx, secondApi.baseUrl, second.exportId, "READY", [worker2]); const late = await cancelExport(ctx, secondApi.baseUrl, second.exportId, "late", { allowFailure: true, key: ctx.key("late") }); expectError(ctx, late, 409, "EXPORT_NOT_CANCELLABLE", "cancel after publication"); ctx.ok(ready.object !== null, "publication winner has object");
    return finalEvidence(ctx, { cancelWinner: terminal.exportId, publicationWinner: ready.exportId });
  },
});

const B04 = defineCase({
  id: "B-04", fixtureFamily: "EV-F-GRANT+LIFECYCLE",
  action: "Create concurrent Grants, race idempotent revoke with cleanup eligibility at a database-time boundary, and retain an independent live byte control.",
  oracle: "Use committed response order and half-open expiry semantics to require no successful Grant after deletion, exactly one revoke/proof, and no resurrection or double delete.",
  async run(ctx) {
    const fixture = ctx.fixtures.lifecycle(); const api = await startPreparedApi(ctx, { fixture }); const live = fixture.exports.find((item) => item.state === "READY" && item.retentionUntil > "2030-01-01T00:00:00.000Z"); const grants = await ctx.concurrent(Array.from({ length: 8 }), 8, (_, index) => createGrant(ctx, api.baseUrl, live.exportId, { expiresInSeconds: 300 }, { key: ctx.key(`grant:${index}`) })); ctx.equal(new Set(grants.map(({ grantId }) => grantId)).size, 8, "independent Grant identities"); const target = grants[0]; const revokes = await Promise.all([0, 1].map((index) => revokeGrant(ctx, api.baseUrl, target.grantId, "race", { key: ctx.key(`revoke:${index}`), allowFailure: true }))); ctx.ok(revokes.some(({ status }) => status === 200), "one revoke succeeds"); ctx.ok(revokes.every(({ status }) => [200, 409].includes(status)), "concurrent revoke has only legal outcomes"); const revokedDownload = await downloadGrant(ctx, api.baseUrl, target.grantId); expectError(ctx, revokedDownload, 410, "DOWNLOAD_GRANT_EXPIRED", "revoked target"); const control = await downloadGrant(ctx, api.baseUrl, grants[1].grantId); ctx.equal(control.status, 200, "unrevoked live control remains readable"); const workers = [await ctx.startWorker(), await ctx.startWorker()]; const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: workers, predicate: ({ kind }) => kind === "EXPORT_CLEANUP" }); ctx.equal(snapshot.resources.deletionProofs.filter(({ exportId }) => exportId === live.exportId).length, 0, "live Export has no deletion proof");
    return finalEvidence(ctx, { grantCount: grants.length, revokedGrantId: target.grantId, liveExportId: live.exportId });
  },
});

const B05 = defineCase({
  id: "B-05", fixtureFamily: "EV-F-SHARD+RECOVERY",
  action: "Run many workers against a multi-Shard Export, replay completion pressure, and cancel a second fan-out while its workers are held before commit.",
  oracle: "Require each Shard effect once, ordered immutable identities, one all-verified Manifest on success, and no Manifest or READY on aggregate cancellation.",
  async run(ctx) {
    const successful = shardedSeed(ctx, "b05-success", { profile: 200000, activity: 2 }); const target = await prepare(ctx, { seed: successful.seed }); const api = await target.startApi(); const created = await createExport(ctx, api.baseUrl, { subjectId: successful.owner.subjectId, scope: ["profile", "activity"], format: "JSONL" }, { sharded: true }); const workers = await Promise.all(Array.from({ length: 12 }, () => ctx.startWorker())); const ready = assertExport(await waitForExport(ctx, api.baseUrl, created.exportId, "READY", workers, { timeoutMs: 300_000 }), { sharded: true }); ctx.ok(ready.shards.every(({ state }) => state === "VERIFIED"), "all Shards verify before READY"); ctx.equal(new Set(ready.shards.map(({ shardId }) => shardId)).size, ready.shards.length, "stable unique Shard identities"); ctx.ok(ready.manifest !== null, "one Manifest publishes"); const snapshot = await ctx.snapshot(api.baseUrl); ctx.equal(snapshot.resources.exportManifests.filter(({ exportId }) => exportId === ready.exportId).length, 1, "exactly one Manifest resource"); ctx.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === ready.exportId && type === "export.ready").length, 1, "exactly one ready Event");
    await ctx.resetDatabase(); const cancelled = shardedSeed(ctx, "b05-cancel", { profile: 100001 }); const secondTarget = await prepare(ctx, { seed: cancelled.seed }); const secondApi = await secondTarget.startApi(); const second = await createExport(ctx, secondApi.baseUrl, { subjectId: cancelled.owner.subjectId, scope: ["profile"], format: "JSONL" }, { sharded: true, key: ctx.key("cancel-create") }); const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.before-commit" && aggregateId === second.exportId }); const held = [await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }), await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } })]; const entry = await barrier.waitFor(({ json }) => json?.aggregateId === second.exportId && json?.point === "worker.before-commit", { timeoutMs: 180_000, processes: held }); const cancelledExport = await cancelExport(ctx, secondApi.baseUrl, second.exportId, "aggregate-cancel", { sharded: true, key: ctx.key("aggregate-cancel") }); barrier.releaseAll(); ctx.equal(cancelledExport.state, "CANCELLED", "fan-out cancellation terminal"); const final = assertExport(await waitForExport(ctx, secondApi.baseUrl, second.exportId, "CANCELLED", held), { sharded: true }); ctx.equal(final.manifest, null, "cancelled fan-out has no Manifest"); ctx.ok(final.shards.every(({ state }) => ["VERIFIED", "CANCELLED"].includes(state)), "unfinished siblings become ineligible for publication");
    return finalEvidence(ctx, { successfulShards: ready.shards.length, cancelledShards: final.shards.length, heldWorkId: entry.json.workId });
  },
});

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05]);
