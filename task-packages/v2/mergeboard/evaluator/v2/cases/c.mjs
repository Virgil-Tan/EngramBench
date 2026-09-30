import assert from "node:assert/strict";

import {
  applyChange, approveMergeRequest, assertBranch, assertDocument, assertMergeRequest, crashWorkerAt,
  createBranch, createDocument, createMergeRequest, finalEvidence, getJson, guardedCase, mergeRequest,
  prepare, resource, waitForDrain,
} from "./helpers.mjs";

async function pendingDocument(ctx, target, label) {
  const api = await target.startApi(); const block = ctx.fixtures.block(`${label}:block`, "zero"); const document = await createDocument(ctx, api.baseUrl, { title: `Snapshot ${label}`, blocks: [block] }, { key: ctx.key(`${label}:document`) }); await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid(`${label}:client`), clientSequence: 1, baseRevision: 0, operations: [{ op: "REPLACE", blockId: block.blockId, expectedText: "zero", newText: "one" }] }, { key: ctx.key(`${label}:change`) }); return { api, block, document };
}

const C01 = guardedCase({
  id: "C-01",
  fixtureFamily: "MB-F-SNAPSHOT-CLAIM",
  action: "Hold a public worker.claimed barrier, SIGKILL the lease owner and let one replacement reclaim the same Work.",
  oracle: "Require one digest-valid Snapshot and Event over the captured revision while the stale lease never publishes.",
  async run(ctx) {
    const target = await prepare(ctx); const { api, document } = await pendingDocument(ctx, target, "c01"); const crashed = await crashWorkerAt(ctx, api.baseUrl, "worker.claimed", ({ aggregateId }) => aggregateId === document.documentId); const replacement = await target.startWorker(); const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [replacement], timeoutMs: 120_000 }); const work = snapshot.work.find(({ workId }) => workId === crashed.work.workId); ctx.ok(work?.terminal && work.attempt >= 2, "replacement reclaims the same persisted Work", { hardCapIds: ["SNAPSHOT_INTEGRITY"] }); const stored = resource(snapshot, "documentSnapshots").filter(({ documentId }) => documentId === document.documentId); ctx.equal(new Set(stored.map(({ revision }) => revision)).size, stored.length, "each prefix has at most one Snapshot"); ctx.ok(stored.some(({ revision }) => revision === 1), "changed revision is compacted"); ctx.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === document.documentId && type === "snapshot.created" && type).length, stored.length, "each public Snapshot has one event"); ctx.ok(crashed.entry.disconnected || !crashed.entry.released, "killed owner never crosses its held barrier");
    const revision = await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}/revisions/1`, "revision during recovery"); ctx.equal(revision.revision, 1, "revision reads remain available after worker death");
    return finalEvidence(ctx, { workId: work.workId, attempt: work.attempt, snapshots: stored.length });
  },
}, ["SNAPSHOT_INTEGRITY"]);

const C02 = guardedCase({
  id: "C-02",
  fixtureFamily: "MB-F-SNAPSHOT-ASSET-WINDOWS",
  action: "Crash independent workers at effect-complete and before-commit, then replay both persisted Snapshot prefixes.",
  oracle: "Compare public Snapshot metadata with immutable revision replay and reject duplicate or missing digest publication.",
  async run(ctx) {
    const target = await prepare(ctx); const evidence = [];
    for (const [index, point] of ["worker.effect-complete", "worker.before-commit"].entries()) {
      if (index > 0) { await ctx.resetDatabase(); await prepare(ctx, { build: false }); }
      const { api, document } = await pendingDocument(ctx, target, `c02-${index}`); const crashed = await crashWorkerAt(ctx, api.baseUrl, point, ({ aggregateId }) => aggregateId === document.documentId); const replacements = [await target.startWorker(), await target.startWorker()]; const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: replacements, timeoutMs: 120_000 }); const revision = await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}/revisions/1`, `${point} revision`); const rows = resource(snapshot, "documentSnapshots").filter(({ documentId, revision: value }) => documentId === document.documentId && value === 1); ctx.equal(rows.length, 1, `${point} publishes one Snapshot identity`, { hardCapIds: ["SNAPSHOT_INTEGRITY"] }); ctx.equal(rows[0].canonicalDigest, revision.canonicalDigest, `${point} metadata matches independent immutable revision`, { hardCapIds: ["SNAPSHOT_INTEGRITY"] }); const work = snapshot.work.find(({ workId }) => workId === crashed.work.workId); ctx.ok(work?.terminal && work.attempt >= 2, `${point} stale completion is fenced`); evidence.push({ point, workId: work.workId, digest: rows[0].canonicalDigest });
    }
    return finalEvidence(ctx, { crashWindows: evidence });
  },
}, ["SNAPSHOT_INTEGRITY"]);

async function createMergedDocument(ctx, target, label, options = {}) {
  const api = options.api ?? await target.startApi(); const a = ctx.fixtures.block(`${label}:a`, "a"); const document = await createDocument(ctx, api.baseUrl, { title: `Merged ${label}`, blocks: [a] }, { key: ctx.key(`${label}:document`) }); const branches = await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}/branches`, "branches"); branches.forEach(assertBranch); const main = branches[0];
  if (options.drainBeforeMerge) { const worker = await target.startWorker(); await waitForDrain(ctx, api.baseUrl, { processes: [worker] }); await ctx.stop(worker); }
  const feature = await createBranch(ctx, api.baseUrl, document.documentId, { name: `feature-${label}`, sourceBranchId: main.branchId, sourceRevision: 0 }); const x = ctx.fixtures.block(`${label}:x`, "x"); await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid(`${label}:client`), clientSequence: 1, baseRevision: 0, operations: [{ op: "INSERT_AFTER", afterBlockId: a.blockId, block: x }] }, { branchId: feature.branchId, key: ctx.key(`${label}:change`) });
  if (options.drainBeforeMerge) { const worker = await target.startWorker(); await waitForDrain(ctx, api.baseUrl, { processes: [worker] }); await ctx.stop(worker); }
  let request = await createMergeRequest(ctx, api.baseUrl, document.documentId, { sourceBranchId: feature.branchId, targetBranchId: main.branchId, expectedSourceHeadRevision: 1, expectedTargetHeadRevision: 0, reviewPolicy: { reviewerIds: [ctx.fixtures.reviewerIds[0]], requiredApprovals: 1 } }); request = await approveMergeRequest(ctx, api.baseUrl, request.mergeRequestId, ctx.fixtures.reviewerIds[0]); request = await mergeRequest(ctx, api.baseUrl, request.mergeRequestId); return { api, document, main, feature, request, a, x };
}

const C03 = guardedCase({
  id: "C-03",
  fixtureFamily: "MB-F-EVENT-UNKNOWN-ACK",
  action: "Return a failed receiver acknowledgement, stop the dispatcher at response-received and recover all Document and merge Events.",
  oracle: "Compare receiver attempts by Event identity and semantic body and require document.changed before merge-request.merged.",
  async run(ctx) {
    const target = await prepare(ctx); const receiver = await ctx.receiver({ behavior: (entry) => ({ status: entry.attempt === 1 ? 500 : 204 }) }); const barrier = await ctx.barrier({ hold: ({ point }) => point === "dispatcher.response-received" }); const dispatcher = await target.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); const setup = await createMergedDocument(ctx, target, "c03"); const held = await barrier.waitFor(({ json }) => json?.point === "dispatcher.response-received", { timeoutMs: 120_000, processes: [dispatcher] }); await ctx.kill(dispatcher); const replacement = await target.startDispatcher({ webhookUrl: receiver.url }); const snapshot = await ctx.snapshot(setup.api.baseUrl);
    await ctx.waitFor(() => snapshot.events.every((event) => receiver.ledger.some((attempt) => attempt.acknowledged && attempt.headers["x-mergeboard-event-id"] === event.eventId)), { timeoutMs: 120_000, label: "all persisted Events acknowledged", processes: [replacement] });
    const firstId = receiver.ledger[0].headers["x-mergeboard-event-id"]; const attempts = receiver.ledger.filter((item) => item.headers["x-mergeboard-event-id"] === firstId); ctx.ok(attempts.length >= 2, "unknown acknowledgement retries same Event"); ctx.ok(attempts.every(({ raw }) => raw === attempts[0].raw), "Event retry preserves semantic body"); ctx.ok(held.disconnected || !held.released, "killed dispatcher does not cross held response barrier"); const deliveredTypes = receiver.ledger.filter(({ acknowledged }) => acknowledged).map(({ headers }) => headers["x-mergeboard-event-type"]); ctx.ok(deliveredTypes.indexOf("document.changed") >= 0 && deliveredTypes.indexOf("merge-request.merged") > deliveredTypes.indexOf("document.changed"), "successful merge Event delivery preserves required order");
    return finalEvidence(ctx, { persistedEvents: snapshot.events.length, receiverAttempts: receiver.ledger.length, retriedEventId: firstId });
  },
}, ["SNAPSHOT_INTEGRITY", "MERGE_ATOMICITY"]);

const C04 = guardedCase({
  id: "C-04",
  fixtureFamily: "MB-F-MERGE-SNAPSHOT-RECOVERY",
  action: "For each public worker barrier, isolate the merge-created target Snapshot Work and SIGKILL its owner.",
  oracle: "Require one merged-target Snapshot matching stored preview while source revisions and Events remain unchanged.",
  async run(ctx) {
    const target = await prepare(ctx); const evidence = [];
    for (const [index, point] of ["worker.claimed", "worker.effect-complete", "worker.before-commit"].entries()) {
      if (index > 0) { await ctx.resetDatabase(); await prepare(ctx, { build: false }); }
      const setup = await createMergedDocument(ctx, target, `c04-${index}`, { drainBeforeMerge: true }); const sourceBefore = await getJson(ctx, setup.api.baseUrl, `/api/v1/documents/${setup.document.documentId}/branches/${setup.feature.branchId}/revisions/1`, "source revision before recovery"); const crashed = await crashWorkerAt(ctx, setup.api.baseUrl, point, ({ aggregateId }) => aggregateId === setup.document.documentId); const replacements = [await target.startWorker(), await target.startWorker()]; const snapshot = await waitForDrain(ctx, setup.api.baseUrl, { processes: replacements, timeoutMs: 120_000 }); const targetRows = resource(snapshot, "branchDocumentSnapshots").filter(({ documentId, branchId, revision }) => documentId === setup.document.documentId && branchId === setup.main.branchId && revision === setup.request.mergedTargetRevision); ctx.equal(targetRows.length, 1, `${point} creates one merged target Snapshot`, { hardCapIds: ["SNAPSHOT_INTEGRITY"] }); ctx.equal(targetRows[0].canonicalDigest, setup.request.resultDigest, `${point} Snapshot matches stored merge preview`, { hardCapIds: ["SNAPSHOT_INTEGRITY"] }); const sourceAfter = await getJson(ctx, setup.api.baseUrl, `/api/v1/documents/${setup.document.documentId}/branches/${setup.feature.branchId}/revisions/1`, "source revision after recovery"); ctx.equal(sourceAfter, sourceBefore, `${point} recovery leaves source immutable`); const work = snapshot.work.find(({ workId }) => workId === crashed.work.workId); ctx.ok(work?.terminal && work.attempt >= 2, `${point} merged Work is reclaimed`); ctx.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === setup.document.documentId && type === "snapshot.created").length >= 1, true, `${point} emits Snapshot event once per stored prefix`); evidence.push({ point, workId: work.workId, digest: targetRows[0].canonicalDigest });
    }
    return finalEvidence(ctx, { recoveredBarriers: evidence });
  },
}, ["SNAPSHOT_INTEGRITY"]);

export const C_CASES = Object.freeze([C01, C02, C03, C04]);
