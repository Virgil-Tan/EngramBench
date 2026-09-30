import assert from "node:assert/strict";

import { applyOperations, documentDiff, documentDigest, rebaseOperations } from "../oracles/index.mjs";
import {
  applyChange, approveMergeRequest, assertBranch, assertChange, assertDocument, assertMergeRequest,
  createBranch, createDocument, createMergeRequest, expectError, finalEvidence, getJson, guardedCase,
  mergeRequest, prepare, resource,
} from "./helpers.mjs";

const B01 = guardedCase({
  id: "B-01",
  fixtureFamily: "MB-F-REFERENCE-GRAPH",
  action: "Submit a deterministic saved graph of head and stale-base operations, then query immutable revision pairs.",
  oracle: "Compare each response, Conflict and DocumentDiff with a task-owned operation and digest reference model.",
  async run(ctx) {
    const target = await prepare(ctx); const api = await target.startApi(); const blocks = Array.from({ length: 6 }, (_, index) => ctx.fixtures.block(`b01:${index}`, `v${index}`)); const document = await createDocument(ctx, api.baseUrl, { title: "Reference graph", blocks }); let expected = blocks;
    const operations = [
      { op: "REPLACE", blockId: blocks[1].blockId, expectedText: "v1", newText: "v1x" },
      { op: "MOVE_AFTER", blockId: blocks[4].blockId, afterBlockId: blocks[0].blockId, expectedAfterBlockId: blocks[3].blockId },
      { op: "DELETE", blockId: blocks[2].blockId, expectedText: "v2" },
      { op: "INSERT_AFTER", afterBlockId: blocks[5].blockId, block: ctx.fixtures.block("b01:new", "new") },
    ];
    for (const [index, operation] of operations.entries()) {
      const change = await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid(`b01:client:${index}`), clientSequence: 1, baseRevision: index, operations: [operation] }); expected = applyOperations(expected, [operation]).blocks;
      const current = assertDocument(await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}`, "reference Document")); ctx.equal(current.blocks, expected, `operation ${index} blocks`); ctx.equal(current.canonicalDigest, documentDigest(document.documentId, change.revision, expected), `operation ${index} digest`);
    }
    const failedOperations = [{ op: "REPLACE", blockId: blocks[1].blockId, expectedText: "v1", newText: "stale" }, { op: "DELETE", blockId: blocks[2].blockId, expectedText: "v2" }]; const oracle = rebaseOperations(expected, failedOperations); const failed = await applyChange(ctx, api.baseUrl, document.documentId, { clientId: ctx.uuid("b01:conflict-client"), clientSequence: 1, baseRevision: 0, operations: failedOperations }, { allowFailure: true }); expectError(ctx, failed, 409, "CHANGE_CONFLICT", "reference conflict"); const snapshot = await ctx.snapshot(api.baseUrl); const persisted = resource(snapshot, "changes").filter(({ state }) => state === "CONFLICTED").at(-1); ctx.equal(persisted.conflicts.map(({ operationIndex, code }) => ({ operationIndex, code })), oracle.conflicts.map(({ operationIndex, code }) => ({ operationIndex, code })), "persisted conflicts equal reference model");
    const runtimeDiff = await getJson(ctx, api.baseUrl, `/api/v1/documents/${document.documentId}/diff?fromRevision=0&toRevision=4`, "reference diff"); ctx.equal(runtimeDiff.items, documentDiff(blocks, expected), "DocumentDiff equals independent model");
    return finalEvidence(ctx, { appliedOperations: operations.length, conflicts: oracle.conflicts.length, diffItems: runtimeDiff.items.length });
  },
}, ["DOCUMENT_ATOMICITY"]);

const B02 = guardedCase({
  id: "B-02",
  fixtureFamily: "MB-F-REPLAY-MATRIX",
  action: "Exercise the four HTTP-key and Client-Sequence replay combinations across two APIs and one lost response.",
  oracle: "Count one saved HTTP response and one semantic Change while independently auditing revisions and Events.",
  async run(ctx) {
    const target = await prepare(ctx); let firstApi = await target.startApi(); const secondApi = await target.startApi(); const block = ctx.fixtures.block("b02:block", "before"); const document = await createDocument(ctx, firstApi.baseUrl, { title: "Replay precedence", blocks: [block] }); const body = { clientId: ctx.uuid("b02:client"), clientSequence: 1, baseRevision: 0, operations: [{ op: "REPLACE", blockId: block.blockId, expectedText: "before", newText: "after" }] }; const key = ctx.key("b02:lost");
    const shield = await ctx.responseShield(firstApi.baseUrl); shield.dropNextMutation(); await ctx.mutate(shield.baseUrl, `/api/v1/documents/${document.documentId}/changes`, key, body).catch(() => undefined);
    const recovered = await applyChange(ctx, secondApi.baseUrl, document.documentId, body, { key });
    const exactReplay = await applyChange(ctx, firstApi.baseUrl, document.documentId, body, { key }); ctx.equal(exactReplay, recovered, "same key restores exact status and body", { hardCapIds: ["CLIENT_IDENTITY"] });
    const keyConflict = await applyChange(ctx, firstApi.baseUrl, document.documentId, { ...body, baseRevision: 1 }, { key, allowFailure: true }); expectError(ctx, keyConflict, 409, "IDEMPOTENCY_CONFLICT", "same key different request");
    const semanticReplay = await applyChange(ctx, secondApi.baseUrl, document.documentId, body, { key: ctx.key("b02:new-key") }); ctx.equal(semanticReplay, recovered, "new key same sequence restores semantic Change");
    const semanticConflict = await applyChange(ctx, secondApi.baseUrl, document.documentId, { ...body, operations: [{ op: "REPLACE", blockId: block.blockId, expectedText: "before", newText: "other" }] }, { key: ctx.key("b02:other-semantic"), allowFailure: true }); expectError(ctx, semanticConflict, 409, "CLIENT_SEQUENCE_CONFLICT", "new key different semantic sequence");
    await ctx.stop(firstApi); firstApi = await target.startApi(); const afterRestart = await applyChange(ctx, firstApi.baseUrl, document.documentId, body, { key }); ctx.equal(afterRestart, recovered, "restart does not rewrite saved replay");
    const snapshot = await ctx.snapshot(secondApi.baseUrl); ctx.equal(resource(snapshot, "changes").filter(({ documentId, state }) => documentId === document.documentId && state === "APPLIED").length, 1, "replay matrix creates one Change", { hardCapIds: ["CLIENT_IDENTITY"] }); ctx.equal(resource(snapshot, "documentRevisions").filter(({ documentId }) => documentId === document.documentId).length, 2, "replay matrix creates one next revision", { hardCapIds: ["CLIENT_IDENTITY"] });
    return finalEvidence(ctx, { responseCaptures: shield.captures.length, changeId: recovered.changeId });
  },
}, ["CLIENT_IDENTITY"]);

const B03 = guardedCase({
  id: "B-03",
  fixtureFamily: "MB-F-CONCURRENT-ANCHOR",
  action: "Submit 64 same-anchor inserts through two APIs followed by competing move and delete preconditions.",
  oracle: "Sort applied blocks by committed revision, operation index and blockId and require contiguous revision identities.",
  async run(ctx) {
    const target = await prepare(ctx); const apis = [await target.startApi(), await target.startApi()]; const anchor = ctx.fixtures.block("b03:anchor", "anchor"); const document = await createDocument(ctx, apis[0].baseUrl, { title: "Concurrent anchor", blocks: [anchor] }); const inserted = Array.from({ length: 64 }, (_, index) => ctx.fixtures.block(`b03:insert:${index}`, `insert-${index}`));
    const responses = await ctx.concurrent(inserted, 64, (block, index) => ctx.mutate(apis[index % 2].baseUrl, `/api/v1/documents/${document.documentId}/changes`, ctx.key(`b03:${index}`), { clientId: ctx.uuid(`b03:client:${index}`), clientSequence: 1, baseRevision: 0, operations: [{ op: "INSERT_AFTER", afterBlockId: anchor.blockId, block }] }));
    ctx.ok(responses.every(({ status }) => status === 201), "all non-overlapping inserts apply"); responses.forEach(({ json }) => assertChange(json, { legacy: true }));
    const snapshot = await ctx.snapshot(apis[0].baseUrl); const changes = resource(snapshot, "changes").filter(({ documentId, state }) => documentId === document.documentId && state === "APPLIED").sort((a, b) => a.revision - b.revision); ctx.equal(changes.map(({ revision }) => revision), Array.from({ length: 64 }, (_, index) => index + 1), "concurrent revisions are gapless", { hardCapIds: ["DOCUMENT_ATOMICITY"] });
    const expectedIds = changes.map(({ operations }) => operations[0].block.blockId); const current = assertDocument(await getJson(ctx, apis[1].baseUrl, `/api/v1/documents/${document.documentId}`, "concurrent head")); ctx.equal(current.blocks.slice(1).map(({ blockId }) => blockId), expectedIds, "shared-anchor membership follows committed revision order", { hardCapIds: ["DOCUMENT_ATOMICITY"] }); ctx.equal(new Set(current.blocks.map(({ blockId }) => blockId)).size, 65, "no block is duplicated or lost");
    const first = current.blocks[1]; const last = current.blocks.at(-1); const terminal = await Promise.all([
      applyChange(ctx, apis[0].baseUrl, document.documentId, { clientId: ctx.uuid("b03:move"), clientSequence: 1, baseRevision: 64, operations: [{ op: "MOVE_AFTER", blockId: first.blockId, afterBlockId: last.blockId, expectedAfterBlockId: anchor.blockId }] }, { key: ctx.key("b03:move"), allowFailure: true }),
      applyChange(ctx, apis[1].baseUrl, document.documentId, { clientId: ctx.uuid("b03:delete"), clientSequence: 1, baseRevision: 64, operations: [{ op: "DELETE", blockId: last.blockId, expectedText: last.text }] }, { key: ctx.key("b03:delete"), allowFailure: true }),
    ]); ctx.ok(terminal.every(({ status }) => [201, 409].includes(status)), "terminal precondition race has only published outcomes"); const after = await ctx.snapshot(apis[0].baseUrl); const revisions = resource(after, "documentRevisions").filter(({ documentId }) => documentId === document.documentId).map(({ revision }) => revision); ctx.equal(revisions, Array.from({ length: revisions.length }, (_, index) => index), "post-race revisions remain contiguous", { hardCapIds: ["DOCUMENT_ATOMICITY"] });
    return finalEvidence(ctx, { inserted: 64, postRaceHead: revisions.at(-1) });
  },
}, ["DOCUMENT_ATOMICITY"]);

async function setupReview(ctx, apis, label, requiredApprovals = 3) {
  const a = ctx.fixtures.block(`${label}:a`, "a"); const document = await createDocument(ctx, apis[0].baseUrl, { title: `Review ${label}`, blocks: [a] }, { key: ctx.key(`${label}:document`) }); const branches = await getJson(ctx, apis[0].baseUrl, `/api/v1/documents/${document.documentId}/branches`, "list main Branch"); branches.forEach(assertBranch); const main = branches[0]; const feature = await createBranch(ctx, apis[0].baseUrl, document.documentId, { name: `feature-${label}`, sourceBranchId: main.branchId, sourceRevision: 0 }); const x = ctx.fixtures.block(`${label}:x`, "x"); await applyChange(ctx, apis[0].baseUrl, document.documentId, { clientId: ctx.uuid(`${label}:client`), clientSequence: 1, baseRevision: 0, operations: [{ op: "INSERT_AFTER", afterBlockId: a.blockId, block: x }] }, { branchId: feature.branchId }); const request = await createMergeRequest(ctx, apis[0].baseUrl, document.documentId, { sourceBranchId: feature.branchId, targetBranchId: main.branchId, expectedSourceHeadRevision: 1, expectedTargetHeadRevision: 0, reviewPolicy: { reviewerIds: ctx.fixtures.reviewerIds.slice(0, Math.max(requiredApprovals, 5)), requiredApprovals } }); return { document, main, feature, request, a, x };
}

const B04 = guardedCase({
  id: "B-04",
  fixtureFamily: "MB-F-REVIEW-RACE",
  action: "Race eligible, duplicate and ineligible reviewer approvals across two API processes at the final threshold.",
  oracle: "Audit one frozen policy, one approval per reviewer and exactly one digest-bound approved transition Event.",
  async run(ctx) {
    const target = await prepare(ctx); const apis = [await target.startApi(), await target.startApi()]; const { request } = await setupReview(ctx, apis, "b04", 3); const first = await approveMergeRequest(ctx, apis[0].baseUrl, request.mergeRequestId, ctx.fixtures.reviewerIds[0]); ctx.equal(first.state, "IN_REVIEW", "one of three approvals stays in review");
    const ineligible = await approveMergeRequest(ctx, apis[0].baseUrl, request.mergeRequestId, ctx.uuid("b04:outsider"), { key: ctx.key("b04:outsider"), allowFailure: true }); expectError(ctx, ineligible, 409, "REVIEWER_NOT_ELIGIBLE", "ineligible reviewer");
    const raced = await Promise.all([
      approveMergeRequest(ctx, apis[0].baseUrl, request.mergeRequestId, ctx.fixtures.reviewerIds[1], { key: ctx.key("b04:r1"), allowFailure: true }),
      approveMergeRequest(ctx, apis[1].baseUrl, request.mergeRequestId, ctx.fixtures.reviewerIds[2], { key: ctx.key("b04:r2"), allowFailure: true }),
      approveMergeRequest(ctx, apis[1].baseUrl, request.mergeRequestId, ctx.fixtures.reviewerIds[1], { key: ctx.key("b04:duplicate"), allowFailure: true }),
    ]); ctx.ok(raced.every(({ status }) => [200, 409].includes(status)), "approval race returns only published outcomes"); const current = assertMergeRequest(await getJson(ctx, apis[0].baseUrl, `/api/v1/merge-requests/${request.mergeRequestId}`, "reviewed request")); ctx.equal(current.state, "APPROVED", "simultaneous final approvals cross threshold"); ctx.equal(new Set(current.approvals.map(({ reviewerId }) => reviewerId)).size, 3, "duplicate reviewer counts once"); ctx.ok(current.approvals.every(({ resultDigest }) => resultDigest === current.resultDigest), "all approvals bind one result digest");
    const snapshot = await ctx.snapshot(apis[0].baseUrl); ctx.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === request.mergeRequestId && type === "merge-request.approved").length, 1, "approval threshold emits once");
    return finalEvidence(ctx, { approvals: current.approvals.length, resultDigest: current.resultDigest });
  },
}, ["MERGE_ATOMICITY"]);

const B05 = guardedCase({
  id: "B-05",
  fixtureFamily: "MB-F-MERGE-CAS",
  action: "Race twenty merge calls and then repeat three fixed merge-versus-target-change interleavings across two APIs.",
  oracle: "Require captured source and target heads to create one preview-identical target revision or one zero-effect STALE state.",
  async run(ctx) {
    const target = await prepare(ctx); const apis = [await target.startApi(), await target.startApi()]; let setup = await setupReview(ctx, apis, "b05-main", 1); await approveMergeRequest(ctx, apis[0].baseUrl, setup.request.mergeRequestId, ctx.fixtures.reviewerIds[0]); const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => mergeRequest(ctx, apis[index % 2].baseUrl, setup.request.mergeRequestId, { key: ctx.key(`b05:merge:${index}`), allowFailure: true }))); ctx.ok(responses.some(({ status }) => status === 200), "one merge call succeeds"); const merged = assertMergeRequest(await getJson(ctx, apis[0].baseUrl, `/api/v1/merge-requests/${setup.request.mergeRequestId}`, "merged request")); ctx.equal(merged.state, "MERGED", "CAS winner persists MERGED"); const revisions = resource(await ctx.snapshot(apis[0].baseUrl), "documentRevisions").filter(({ documentId, branchId }) => documentId === setup.document.documentId && branchId === setup.main.branchId); ctx.equal(revisions.filter(({ revision }) => revision === 1).length, 1, "twenty merges create one target revision", { hardCapIds: ["MERGE_ATOMICITY"] });
    const outcomes = [];
    for (let seed = 0; seed < 3; seed += 1) {
      setup = await setupReview(ctx, apis, `b05-${seed}`, 1); await approveMergeRequest(ctx, apis[0].baseUrl, setup.request.mergeRequestId, ctx.fixtures.reviewerIds[0]);
      const targetChange = { clientId: ctx.uuid(`b05:target-client:${seed}`), clientSequence: 1, baseRevision: 0, operations: [{ op: "REPLACE", blockId: setup.a.blockId, expectedText: "a", newText: `target-${seed}` }] };
      const pair = seed % 2 === 0
        ? [mergeRequest(ctx, apis[0].baseUrl, setup.request.mergeRequestId, { key: ctx.key(`b05:cas-merge:${seed}`), allowFailure: true }), applyChange(ctx, apis[1].baseUrl, setup.document.documentId, targetChange, { key: ctx.key(`b05:target:${seed}`), allowFailure: true })]
        : [applyChange(ctx, apis[1].baseUrl, setup.document.documentId, targetChange, { key: ctx.key(`b05:target:${seed}`), allowFailure: true }), mergeRequest(ctx, apis[0].baseUrl, setup.request.mergeRequestId, { key: ctx.key(`b05:cas-merge:${seed}`), allowFailure: true })];
      await Promise.all(pair); const current = assertMergeRequest(await getJson(ctx, apis[0].baseUrl, `/api/v1/merge-requests/${setup.request.mergeRequestId}`, "CAS request")); ctx.ok(["MERGED", "STALE"].includes(current.state), "CAS finishes MERGED or STALE"); const snapshot = await ctx.snapshot(apis[0].baseUrl); const own = resource(snapshot, "documentRevisions").filter(({ documentId, branchId }) => documentId === setup.document.documentId && branchId === setup.main.branchId); if (current.state === "STALE") ctx.ok(!own.some(({ mergeRequestId }) => mergeRequestId === current.mergeRequestId), "STALE creates no target merge revision", { hardCapIds: ["MERGE_ATOMICITY"] }); else ctx.equal(own.filter(({ mergeRequestId }) => mergeRequestId === current.mergeRequestId).length, 1, "MERGED creates one target revision", { hardCapIds: ["MERGE_ATOMICITY"] }); outcomes.push(current.state);
    }
    return finalEvidence(ctx, { twentyWayState: merged.state, interleavings: outcomes });
  },
}, ["MERGE_ATOMICITY"]);

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05]);
