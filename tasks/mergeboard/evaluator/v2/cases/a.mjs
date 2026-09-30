import assert from "node:assert/strict";

import { applyOperations, documentDiff, documentDigest } from "../oracles/index.mjs";
import {
  applyChange, approveMergeRequest, assertBranch, assertChange, assertDocument, assertMergeRequest, assertRevision,
  createBranch, createDocument, createMergeRequest, defineCase, expectError, expectSuccess, finalEvidence,
  getJson, guardedCase, mergeRequest, prepare, resource, startPreparedApi, waitForDrain,
} from "./helpers.mjs";

const A01 = guardedCase({
  id: "A-01",
  fixtureFamily: "MB-F-DOC-OPS",
  action: "Create bounded Documents and submit each public block operation through legacy HTTP routes.",
  oracle: "Independently replay every operation in array order and recompute the exact RFC8785 revision digest.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const a = ctx.fixtures.block("a01:a", "alpha"); const b = ctx.fixtures.block("a01:b", "beta"); const x = ctx.fixtures.block("a01:x", "inserted");
    const document = await createDocument(ctx, api.baseUrl, { title: "Ordered operations", blocks: [a, b] });
    ctx.equal(document.headRevision, 0, "creation freezes revision zero");
    let blocks = [a, b];
    const operations = [
      { op: "INSERT_AFTER", afterBlockId: a.blockId, block: x },
      { op: "REPLACE", blockId: b.blockId, expectedText: "beta", newText: "beta-2" },
      { op: "MOVE_AFTER", blockId: x.blockId, afterBlockId: b.blockId, expectedAfterBlockId: a.blockId },
      { op: "DELETE", blockId: a.blockId, expectedText: "alpha" },
    ];
    for (const [index, operation] of operations.entries()) {
      const clientId = ctx.fixtures.uuid(`a01:client:${index}`);
      const change = await applyChange(ctx, api.baseUrl, document.documentId, { clientId, clientSequence: 1, baseRevision: index, operations: [operation] });
      ctx.equal(change.revision, index + 1, "each applied Change creates the next revision", { hardCapIds: ["DOCUMENT_ATOMICITY"] });
      blocks = applyOperations(blocks, [operation]).blocks;
      const current = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "read Document"));
      ctx.equal(current.blocks, blocks, "runtime blocks equal independent operation replay", { hardCapIds: ["DOCUMENT_ATOMICITY"] });
      ctx.equal(current.canonicalDigest, documentDigest(document.documentId, index + 1, blocks), "revision digest is canonical", { hardCapIds: ["DOCUMENT_ATOMICITY"] });
    }
    const before = await ctx.snapshot(api.baseUrl);
    const invalid = await createDocument(ctx, api.baseUrl, { title: "duplicate", blocks: [a, a] }, { key: ctx.key("a01:invalid"), allowFailure: true });
    expectError(ctx, invalid, 400, "INVALID_DOCUMENT", "duplicate block creation");
    const after = await ctx.snapshot(api.baseUrl);
    ctx.equal({ resources: after.resources, work: after.work, events: after.events }, { resources: before.resources, work: before.work, events: before.events }, "invalid Document has zero durable effect", { hardCapIds: ["DOCUMENT_ATOMICITY"] });
    return finalEvidence(ctx, { revisions: operations.length + 1, operations: operations.map(({ op }) => op) });
  },
}, ["DOCUMENT_ATOMICITY"]);

const A02 = guardedCase({
  id: "A-02",
  fixtureFamily: "MB-F-OPS-REBASE",
  action: "Advance a head, submit stale non-overlap and all five overlap failures, then resolve a persisted Conflict.",
  oracle: "Evaluate every precondition against independent head blocks and require all conflicts with no partial revision or event.",
  async run(ctx) {
    const api = await startPreparedApi(ctx); const a = ctx.fixtures.block("a02:a", "a"); const b = ctx.fixtures.block("a02:b", "b"); const c = ctx.fixtures.block("a02:c", "c");
    const document = await createDocument(ctx, api.baseUrl, { title: "Rebase", blocks: [a, b, c] });
    await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid("a02:c1"), clientSequence: 1, baseRevision: 0, operations: [{ op: "REPLACE", blockId: a.blockId, expectedText: "a", newText: "a1" }] });
    const rebased = await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid("a02:c2"), clientSequence: 1, baseRevision: 0, operations: [{ op: "REPLACE", blockId: b.blockId, expectedText: "b", newText: "b1" }] });
    ctx.equal(rebased.revision, 2, "non-overlap stale Change rebases to next revision");
    const missing = ctx.uuid("a02:missing"); const headBefore = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "head before conflicts")); const eventsBefore = (await ctx.snapshot(api.baseUrl)).events.length;
    const response = await applyChange(ctx, api.baseUrl, document.documentId, {
      clientId: ctx.uuid("a02:c3"), clientSequence: 1, baseRevision: 0,
      operations: [
        { op: "REPLACE", blockId: a.blockId, expectedText: "a", newText: "wrong" },
        { op: "DELETE", blockId: missing, expectedText: "missing" },
        { op: "INSERT_AFTER", afterBlockId: null, block: { ...b } },
        { op: "MOVE_AFTER", blockId: b.blockId, afterBlockId: a.blockId, expectedAfterBlockId: null },
        { op: "INSERT_AFTER", afterBlockId: missing, block: ctx.fixtures.block("a02:new", "new") },
      ],
    }, { allowFailure: true });
    expectError(ctx, response, 409, "CHANGE_CONFLICT", "overlapping stale Change");
    const snapshot = await ctx.snapshot(api.baseUrl); const conflicted = resource(snapshot, "changes").filter(({ state }) => state === "CONFLICTED").at(-1); assertChange(conflicted);
    ctx.equal(conflicted.conflicts.map(({ operationIndex, code }) => [operationIndex, code]), [[0, "TARGET_CHANGED"], [1, "TARGET_MISSING"], [2, "BLOCK_ID_EXISTS"], [3, "MOVE_BASE_CHANGED"], [4, "ANCHOR_MISSING"]], "all conflicts are deterministic and ordered");
    const unchanged = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "head after conflict"));
    ctx.equal(unchanged, headBefore, "conflicted Change applies no operation", { hardCapIds: ["DOCUMENT_ATOMICITY"] });
    ctx.equal(snapshot.events.length, eventsBefore + 1, "conflict emits only change.conflicted");
    const conflictId = conflicted.conflicts[0].conflictId;
    const staleResolve = await ctx.mutate(api.baseUrl, `/api/v1/documents/${document.documentId}/conflicts/${conflictId}/resolve`, ctx.key("a02:stale-resolve"), { expectedHeadRevision: 1, resolutionOperations: [{ op: "REPLACE", blockId: a.blockId, expectedText: "a1", newText: "resolved" }] });
    expectError(ctx, staleResolve, 409, "HEAD_REVISION_CHANGED", "stale conflict resolution");
    expectSuccess(ctx, await ctx.mutate(api.baseUrl, `/api/v1/documents/${document.documentId}/conflicts/${conflictId}/resolve`, ctx.key("a02:resolve"), { expectedHeadRevision: 2, resolutionOperations: [{ op: "REPLACE", blockId: a.blockId, expectedText: "a1", newText: "resolved" }] }), "resolve Conflict");
    const resolved = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "resolved head")); ctx.equal(resolved.headRevision, 3, "resolve creates one normal next revision");
    return finalEvidence(ctx, { conflictCount: conflicted.conflicts.length, resolvedRevision: resolved.headRevision });
  },
}, ["DOCUMENT_ATOMICITY"]);

const A03 = guardedCase({
  id: "A-03",
  fixtureFamily: "MB-F-OFFLINE-SEQUENCE",
  action: "Replay branch-independent offline sequences across two Documents, two clients, response loss and API restart.",
  oracle: "Count durable Change identity, revisions and events by document plus client sequence rather than HTTP key alone.",
  async run(ctx) {
    const target = await prepare(ctx); let api = await target.startApi(); const block = ctx.fixtures.block("a03:a", "0"); const first = await createDocument(ctx, api.baseUrl, { title: "Offline first", blocks: [block] });
    const body = { clientId: ctx.uuid("a03:client"), clientSequence: 1, baseRevision: 0, operations: [{ op: "REPLACE", blockId: block.blockId, expectedText: "0", newText: "1" }] };
    const applied = await applyChange(ctx, api.baseUrl, first.documentId, body, { key: ctx.key("a03:first") });
    const gap = await applyChange(ctx, api.baseUrl, first.documentId, { ...body, clientSequence: 3, baseRevision: 1 }, { key: ctx.key("a03:gap"), allowFailure: true }); expectError(ctx, gap, 409, "CLIENT_SEQUENCE_GAP", "sequence gap");
    const replay = await applyChange(ctx, api.baseUrl, first.documentId, body, { key: ctx.key("a03:semantic-replay") }); ctx.equal(replay, applied, "new HTTP key replays prior semantic Change", { hardCapIds: ["CLIENT_IDENTITY"] });
    const conflict = await applyChange(ctx, api.baseUrl, first.documentId, { ...body, operations: [{ op: "REPLACE", blockId: block.blockId, expectedText: "0", newText: "different" }] }, { key: ctx.key("a03:semantic-conflict"), allowFailure: true }); expectError(ctx, conflict, 409, "CLIENT_SEQUENCE_CONFLICT", "sequence semantic conflict");
    await ctx.stop(api); api = await target.startApi(); const restarted = await applyChange(ctx, api.baseUrl, first.documentId, body, { key: ctx.key("a03:first") }); ctx.equal(restarted, applied, "restart preserves exact saved response", { hardCapIds: ["CLIENT_IDENTITY"] });
    await applyChange(ctx, api.baseUrl, first.documentId, { ...body, clientId: ctx.uuid("a03:client-two") }, { key: ctx.key("a03:other-client") });
    const otherBlock = ctx.fixtures.block("a03:b", "x"); const second = await createDocument(ctx, api.baseUrl, { title: "Offline second", blocks: [otherBlock] }); await applyChange(ctx, api.baseUrl, second.documentId, { ...body, baseRevision: 0, operations: [{ op: "REPLACE", blockId: otherBlock.blockId, expectedText: "x", newText: "y" }] }, { key: ctx.key("a03:other-document") });
    const snapshot = await ctx.snapshot(api.baseUrl); ctx.equal(resource(snapshot, "changes").filter(({ state }) => state === "APPLIED").length, 3, "only three semantic Changes persist", { hardCapIds: ["CLIENT_IDENTITY"] });
    return finalEvidence(ctx, { stableChangeId: applied.changeId, appliedChanges: 3 });
  },
}, ["CLIENT_IDENTITY"]);

const A04 = guardedCase({
  id: "A-04",
  fixtureFamily: "MB-F-REVISION-DIFF-SNAPSHOT",
  action: "Build a mixed immutable revision timeline, query both diff directions and drain its public Snapshot work.",
  oracle: "Reconstruct every revision and diff from independent blocks then compare Snapshot digest and retained history.",
  async run(ctx) {
    const target = await prepare(ctx); const api = await target.startApi(); const a = ctx.fixtures.block("a04:a", "a"); const b = ctx.fixtures.block("a04:b", "b"); const x = ctx.fixtures.block("a04:x", "x"); const document = await createDocument(ctx, api.baseUrl, { title: "History", blocks: [a, b] });
    const timeline = [[a, b]]; const operations = [{ op: "INSERT_AFTER", afterBlockId: a.blockId, block: x }, { op: "REPLACE", blockId: b.blockId, expectedText: "b", newText: "b2" }, { op: "MOVE_AFTER", blockId: x.blockId, afterBlockId: b.blockId, expectedAfterBlockId: a.blockId }, { op: "DELETE", blockId: a.blockId, expectedText: "a" }];
    for (const [index, operation] of operations.entries()) { await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid(`a04:c${index}`), clientSequence: 1, baseRevision: index, operations: [operation] }); timeline.push(applyOperations(timeline.at(-1), [operation]).blocks); }
    for (const [revision, blocks] of timeline.entries()) { const value = assertRevision(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}/revisions/${revision}`, `revision ${revision}`), { legacy: true }); ctx.equal(value.blocks, blocks, `revision ${revision} blocks are immutable`); }
    for (const [from, to] of [[0, 4], [4, 0]]) { const value = await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}/diff?fromRevision=${from}&toRevision=${to}`, `${from}->${to} diff`); ctx.equal(value.items, documentDiff(timeline[from], timeline[to]), `${from}->${to} diff matches reference`); }
    const worker = await target.startWorker(); const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [worker] }); const stored = resource(snapshot, "documentSnapshots").filter(({ documentId }) => documentId === document.documentId).at(-1); ctx.ok(stored, "Snapshot provenance becomes public"); ctx.equal(stored.canonicalDigest, documentDigest(document.documentId, stored.revision, timeline[stored.revision]), "Snapshot digest covers exact operation prefix", { hardCapIds: ["SNAPSHOT_INTEGRITY"] }); ctx.equal(resource(snapshot, "documentRevisions").filter(({ documentId }) => documentId === document.documentId).length, 5, "compaction retains all revision history");
    return finalEvidence(ctx, { revisions: timeline.length, snapshotRevision: stored.revision });
  },
}, ["SNAPSHOT_INTEGRITY"]);

async function mainBranch(ctx, baseUrl, documentId) { const branches = await getJson(ctx, baseUrl, `/api/v1/documents/${documentId}/branches`, "list Branches"); assert.ok(Array.isArray(branches), "Branch list must be an array"); branches.forEach(assertBranch); assert.equal(branches[0].name, "main"); return branches[0]; }

const A05 = guardedCase({
  id: "A-05",
  fixtureFamily: "MB-F-BRANCH-MERGE-W1",
  action: "Execute the worked Branch preview, captured two-reviewer gate, successful merge and a later stale merge.",
  oracle: "Rebuild source operations over captured target and require one digest-bound target revision or zero stale effects.",
  async run(ctx) {
    const api = await startPreparedApi(ctx); const a = ctx.fixtures.block("a05:a", "a"); const b = ctx.fixtures.block("a05:b", "b"); const x = ctx.fixtures.block("a05:x", "x"); const document = await createDocument(ctx, api.baseUrl, { title: "Merge workflow", blocks: [a, b] }); const main = await mainBranch(ctx, api.baseUrl, document.documentId);
    const feature = await createBranch(ctx, api.baseUrl, document.documentId, { name: "feature", sourceBranchId: main.branchId, sourceRevision: 0 });
    await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid("a05:c1"), clientSequence: 1, baseRevision: 0, operations: [{ op: "INSERT_AFTER", afterBlockId: a.blockId, block: x }] }, { branchId: feature.branchId });
    await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid("a05:c1"), clientSequence: 2, baseRevision: 1, operations: [{ op: "REPLACE", blockId: b.blockId, expectedText: "b", newText: "b2" }] }, { branchId: feature.branchId });
    let request = await createMergeRequest(ctx, api.baseUrl, document.documentId, { sourceBranchId: feature.branchId, targetBranchId: main.branchId, expectedSourceHeadRevision: 2, expectedTargetHeadRevision: 0, reviewPolicy: { reviewerIds: ctx.fixtures.reviewerIds.slice(0, 2), requiredApprovals: 2 } });
    ctx.equal(request.state, "IN_REVIEW", "nonconflicting preview enters review"); ctx.equal(request.mergeOperations.map(({ sourceRevision, sourceOperationIndex }) => [sourceRevision, sourceOperationIndex]), [[1, 0], [2, 0]], "merge operations preserve source order"); ctx.equal(request.resultDigest, documentDigest(document.documentId, 1, [a, x, { ...b, text: "b2" }]), "preview digest binds target next revision");
    request = await approveMergeRequest(ctx, api.baseUrl, request.mergeRequestId, ctx.fixtures.reviewerIds[0]); ctx.equal(request.state, "IN_REVIEW", "first approval stays in review"); request = await approveMergeRequest(ctx, api.baseUrl, request.mergeRequestId, ctx.fixtures.reviewerIds[1]); ctx.equal(request.state, "APPROVED", "threshold approves once"); request = await mergeRequest(ctx, api.baseUrl, request.mergeRequestId); ctx.equal(request.state, "MERGED", "approved request merges"); ctx.equal(request.mergedTargetRevision, 1, "merge creates one target revision", { hardCapIds: ["MERGE_ATOMICITY"] });
    const merged = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "legacy main after merge")); ctx.equal(merged.blocks, [a, x, { ...b, text: "b2" }], "legacy main sees merged blocks");
    const staleBranch = await createBranch(ctx, api.baseUrl, document.documentId, { name: "stale-feature", sourceBranchId: main.branchId, sourceRevision: 1 }); const y = ctx.fixtures.block("a05:y", "y"); await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid("a05:stale-client"), clientSequence: 1, baseRevision: 0, operations: [{ op: "INSERT_AFTER", afterBlockId: x.blockId, block: y }] }, { branchId: staleBranch.branchId }); let stale = await createMergeRequest(ctx, api.baseUrl, document.documentId, { sourceBranchId: staleBranch.branchId, targetBranchId: main.branchId, expectedSourceHeadRevision: 1, expectedTargetHeadRevision: 1, reviewPolicy: { reviewerIds: [ctx.fixtures.reviewerIds[2]], requiredApprovals: 1 } }); stale = await approveMergeRequest(ctx, api.baseUrl, stale.mergeRequestId, ctx.fixtures.reviewerIds[2]);
    await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid("a05:main-client"), clientSequence: 1, baseRevision: 1, operations: [{ op: "REPLACE", blockId: b.blockId, expectedText: "b2", newText: "b3" }] }); const beforeStale = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "head before stale merge")); const staleResponse = await mergeRequest(ctx, api.baseUrl, stale.mergeRequestId, { key: ctx.key("a05:stale-merge"), allowFailure: true }); expectError(ctx, staleResponse, 409, "MERGE_REQUEST_STALE", "stale reviewed merge"); stale = assertMergeRequest(await getJson(ctx, api.baseUrl, `/api/v1/merge-requests/${stale.mergeRequestId}`, "stale Merge Request")); ctx.equal(stale.state, "STALE", "head movement persists STALE"); const afterStale = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "head after stale merge")); ctx.equal(afterStale, beforeStale, "stale merge creates no target revision", { hardCapIds: ["MERGE_ATOMICITY"] });
    return finalEvidence(ctx, { mergedRevision: request.mergedTargetRevision, staleRequest: stale.mergeRequestId }, [{ assertionId: "MB-A05-TERMINAL-STATE", status: "blocked", blockedBy: "MB-GAP-01", policy: "fail-closed-diagnostic" }]);
  },
}, ["MERGE_ATOMICITY"]);

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05]);
