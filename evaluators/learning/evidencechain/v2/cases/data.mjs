import assert from "node:assert/strict";

import { baseSeed, groupRequest, intakeBatch, splitRequest } from "../fixtures/index.mjs";
import { rankMatches } from "../oracles/index.mjs";
import {
  assertError, assertGroup, assertSnapshot, assertSplit, byId, clone, createGroup,
  createSplit, evidence, guardedCase, importBatch, prepare, proposeMatch,
  publicVerifiedItem, requireStatus, reverseSplit, sameSemanticResponse, snapshotDigest,
  stableSnapshot, transferItem, waitSnapshot,
} from "./helpers.mjs";

async function data01(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 20 });
  const api1 = await prepare(ctx, seed); const api2 = await ctx.startApi();
  const batch = intakeBatch(ctx.fixtures, seed, { count: 20, batchSequence: 1, scanIdPrefix: "durable" });
  const shield = await ctx.responseShield(api1.baseUrl); shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, "/api/v1/intake-batches", ctx.key("data01-batch"), batch).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.some(({ dropped }) => dropped), { label: "unknown batch response" });
  const dropped = shield.captures.find(({ dropped }) => dropped).response;
  const original = { status: dropped.status, json: JSON.parse(dropped.body) };
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate((index % 2 ? api1 : api2).baseUrl, "/api/v1/intake-batches", ctx.key("data01-batch"), clone(batch))));
  concurrent.forEach((response) => sameSemanticResponse(response, original));
  await ctx.stop(api1); const restarted = await ctx.startApi();
  const afterRestart = await ctx.mutate(restarted.baseUrl, "/api/v1/intake-batches", ctx.key("data01-batch"), clone(batch)); sameSemanticResponse(afterRestart, original);
  const changedKey = await ctx.mutate(restarted.baseUrl, "/api/v1/intake-batches", ctx.key("data01-new-key"), clone(batch)); sameSemanticResponse(changedKey, original);
  const changedBody = clone(batch); changedBody.scans[0].sealCode += "-other";
  assertError(await ctx.mutate(api2.baseUrl, "/api/v1/intake-batches", ctx.key("data01-batch"), changedBody), 409, "IDEMPOTENCY_CONFLICT");
  assertError(await ctx.mutate(api2.baseUrl, "/api/v1/intake-batches", ctx.key("data01-other-body"), changedBody), 409, "INTAKE_BATCH_CONFLICT");
  const beforeInvalid = stableSnapshot(await ctx.snapshot(api2.baseUrl));
  const invalidFinal = intakeBatch(ctx.fixtures, seed, { count: 20, batchSequence: 2, scanIdPrefix: "invalid-final" }); invalidFinal.scans.at(-1).facilityId = ctx.uuid("absent-facility");
  const rejected = await ctx.mutate(api2.baseUrl, "/api/v1/intake-batches", ctx.key("data01-invalid-final"), invalidFinal); assert.ok([400, 409].includes(rejected.status));
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api2.baseUrl)), beforeInvalid);
  const snapshot = assertSnapshot(await ctx.snapshot(api2.baseUrl)); assert.equal(snapshot.resources.intakeScans.length, 20); assert.equal(snapshot.resources.deviceRegistrations[0].lastBatchSequence, 1);
  return evidence("unknown response, twenty concurrent retries and API restart returned one semantic response", "same-key/body conflicts and invalid final member produced no second batch effect");
}

async function data02(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 3, facilityCount: 2, custodianCount: 3, deviceCount: 2 });
  const batchA = intakeBatch(ctx.fixtures, seed, { count: 2, deviceIndex: 0, batchSequence: 1, labels: [seed.caseManifests[0].items[0].expectedLabel, seed.caseManifests[0].items[0].expectedLabel], seals: [seed.caseManifests[0].items[0].expectedSealCode, "mismatch"], scanIdPrefix: "rank-a" });
  const batchB = intakeBatch(ctx.fixtures, seed, { count: 1, deviceIndex: 1, batchSequence: 1, itemOffset: 0, seals: [seed.caseManifests[0].items[0].expectedSealCode], scanIdPrefix: "rank-b", minute: 2 });
  const api1 = await prepare(ctx, seed); const api2 = await ctx.startApi(); await importBatch(ctx, api1, "data02-a", batchA); await importBatch(ctx, api2, "data02-b", batchB);
  let snapshot = await ctx.snapshot(api1.baseUrl);
  const ranked = rankMatches(snapshot.resources.collectedItems, snapshot.resources.intakeScans);
  assert.equal(ranked[0].sealRank, 0); assert.equal(ranked.at(-1).sealRank, 1);
  const item = ranked[0].item; const scans = ranked.filter(({ item: candidate }) => candidate.collectedItemId === item.collectedItemId).map(({ scan }) => scan);
  const proposed = await Promise.all(scans.slice(0, 2).map((scan, index) => proposeMatch(ctx, index ? api2 : api1, `data02-propose-${index}`, item.collectedItemId, scan.intakeScanId)));
  snapshot = await ctx.snapshot(api1.baseUrl); const fresh = byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId);
  const confirmations = await Promise.all(proposed.map((response, index) => ctx.mutate((index ? api2 : api1).baseUrl, `/api/v1/custody-matches/${response.json.matchId}/confirm`, ctx.key(`data02-confirm-${index}`), { expectedItemRevision: fresh.revision, expectedScanRevision: scans[index].revision })));
  assert.equal(confirmations.filter(({ status }) => status === 200).length, 1); confirmations.filter(({ status }) => status !== 200).forEach((response) => assertError(response, 409, "CUSTODY_MATCH_CONFLICT"));
  snapshot = assertSnapshot(await ctx.snapshot(api1.baseUrl));
  assert.equal(snapshot.resources.custodyMatches.filter(({ collectedItemId, state }) => collectedItemId === item.collectedItemId && state === "CONFIRMED").length, 1);
  const received = byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId); const destinationA = seed.custodians[1].custodianId; const destinationB = seed.custodians[2].custodianId;
  const transfers = await Promise.all([
    transferItem(ctx, api1, "data02-transfer-a", item.collectedItemId, { fromCustodianId: received.currentCustodianId, toCustodianId: destinationA, occurredAt: ctx.at({ hours: 1 }) }, [200, 409]),
    transferItem(ctx, api2, "data02-transfer-b", item.collectedItemId, { fromCustodianId: received.currentCustodianId, toCustodianId: destinationB, occurredAt: ctx.at({ hours: 1 }) }, [200, 409]),
  ]);
  assert.equal(transfers.filter(({ status }) => status === 200).length, 1); assert.equal((await ctx.snapshot(api1.baseUrl)).resources.custodyTransfers.length, 1);
  return evidence("independent ranking put exact seals first with deterministic ties", "two API confirmation and transfer races each produced one winner with no double match or owner");
}

async function verifiedFixture(ctx, label) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1, quantity: 10, custodianCount: 2 }); const batch = intakeBatch(ctx.fixtures, seed, { count: 1 });
  const api1 = await prepare(ctx, seed); const verified = await publicVerifiedItem(ctx, api1, seed, batch, 0, { label }); const api2 = await ctx.startApi();
  return { seed, api1, api2, ...verified };
}

async function data03(ctx) {
  const { seed, api1, api2, item } = await verifiedFixture(ctx, "data03");
  const split = (await createSplit(ctx, api1, "data03-split", item.collectedItemId, splitRequest(ctx.fixtures, item, [Number.MAX_SAFE_INTEGER - 2, 1, 1], { label: "overflow" }), [400, 409])).json;
  assert.equal(split?.error !== undefined, true, "unsafe sum split should fail");
  const legal = (await createSplit(ctx, api1, "data03-legal", item.collectedItemId, splitRequest(ctx.fixtures, item, [2, 3, 5], { label: "legal" }))).json; assertSplit(legal, item.quantity);
  const childBatch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 3, items: legal.aliquots.map(() => seed.caseManifests[0].items[0]), seals: legal.aliquots.map(({ sealCode }) => sealCode), scanIdPrefix: "data03-child" });
  await importBatch(ctx, api1, "data03-child-batch", childBatch); let snapshot = await ctx.snapshot(api1.baseUrl); const scans = childBatch.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId));
  const before = snapshotDigest(snapshot);
  const groupBody = groupRequest(legal, scans);
  const [reverse, group, parentTransfer] = await Promise.all([
    ctx.mutate(api1.baseUrl, `/api/v1/item-splits/${legal.splitId}/reverse`, ctx.key("data03-reverse"), { reason: "race" }),
    ctx.mutate(api2.baseUrl, "/api/v1/custody-match-groups", ctx.key("data03-group"), groupBody),
    ctx.mutate(api2.baseUrl, `/api/v1/collected-items/${item.collectedItemId}/transfers`, ctx.key("data03-parent-transfer"), { fromCustodianId: seed.custodians[0].custodianId, toCustodianId: seed.custodians[1].custodianId, occurredAt: ctx.at({ hours: 2 }) }),
  ]);
  assert.ok([reverse.status, group.status].filter((status) => [200, 201].includes(status)).length === 1, "reverse/group race had no single winner");
  assert.equal(parentTransfer.status, 409, "consumed parent transferred independently");
  snapshot = assertSnapshot(await ctx.snapshot(api1.baseUrl));
  const active = snapshot.resources.itemSplits.find(({ splitId }) => splitId === legal.splitId)?.state === "ACTIVE";
  if (active) assertGroup(byId(snapshot.resources.custodyMatchGroups, "splitId", legal.splitId), legal);
  else { assert.equal(byId(snapshot.resources.itemSplits, "splitId", legal.splitId).state, "REVERSED"); assert.equal(byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId).state, "VERIFIED"); }
  assert.notEqual(snapshotDigest(snapshot), before, "winning race produced no public state transition");
  return evidence("unsafe BigInt boundary rejected and legal 2/3/5 split conserved immutable quantity", "group/reverse race chose one legal authority and parent transfer could not coexist");
}

async function data04(ctx) {
  const { seed, api1, api2, item } = await verifiedFixture(ctx, "data04");
  const split = (await createSplit(ctx, api1, "data04-split", item.collectedItemId, splitRequest(ctx.fixtures, item, [2, 3, 5], { label: "group" }))).json;
  const childBatch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 3, items: split.aliquots.map(() => seed.caseManifests[0].items[0]), seals: [split.aliquots[0].sealCode, "mismatch", split.aliquots[2].sealCode], scanIdPrefix: "data04-child" });
  await importBatch(ctx, api1, "data04-child-batch", childBatch); let snapshot = await ctx.snapshot(api1.baseUrl); const scans = childBatch.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId));
  const bodyA = groupRequest(split, scans); const bodyB = clone(bodyA); bodyB.members.reverse();
  const incomplete = clone(bodyA); incomplete.members.pop(); assertError(await ctx.mutate(api1.baseUrl, "/api/v1/custody-match-groups", ctx.key("data04-incomplete"), incomplete), 409, "CUSTODY_MATCH_GROUP_CONFLICT");
  const shared = clone(bodyA); shared.members[1].intakeScanId = shared.members[0].intakeScanId; assertError(await ctx.mutate(api2.baseUrl, "/api/v1/custody-match-groups", ctx.key("data04-shared"), shared), 409, "CUSTODY_MATCH_GROUP_CONFLICT");
  const raced = await Promise.all([
    ctx.mutate(api1.baseUrl, "/api/v1/custody-match-groups", ctx.key("data04-group-a"), bodyA),
    ctx.mutate(api2.baseUrl, "/api/v1/custody-match-groups", ctx.key("data04-group-b"), bodyB),
  ]);
  assert.equal(raced.filter(({ status }) => status === 201).length, 1); raced.filter(({ status }) => status !== 201).forEach((response) => assertError(response, 409, "CUSTODY_MATCH_GROUP_CONFLICT"));
  snapshot = await ctx.snapshot(api1.baseUrl); assert.equal(snapshot.work.filter(({ aggregateId, terminal }) => split.aliquots.some(({ aliquotId }) => aliquotId === aggregateId) && !terminal).length, 3);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  snapshot = await waitSnapshot(ctx, api1, (value) => split.aliquots.every(({ aliquotId }) => ["VERIFIED", "QUARANTINED"].includes(byId(value.resources.aliquots, "aliquotId", aliquotId).state)), "all child verification", { processes: workers });
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  assert.deepEqual(split.aliquots.map(({ aliquotId }) => byId(snapshot.resources.aliquots, "aliquotId", aliquotId).state).sort(), ["QUARANTINED", "VERIFIED", "VERIFIED"]);
  assert.equal(snapshot.work.filter(({ aggregateId, terminal }) => split.aliquots.some(({ aliquotId }) => aliquotId === aggregateId) && terminal).length, 3);
  return evidence("invalid incomplete/shared-scan groups failed before any child mutation", "two-API complete-group race committed exactly one all-member group and three independent terminal results");
}

async function data05(ctx) {
  const { seed, api1, api2, item } = await verifiedFixture(ctx, "data05");
  const split = (await createSplit(ctx, api1, "data05-split", item.collectedItemId,
    splitRequest(ctx.fixtures, item, [4, 6], { label: "transfer" }))).json;
  const batch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 2,
    items: split.aliquots.map(() => seed.caseManifests[0].items[0]),
    seals: split.aliquots.map(({ sealCode }) => sealCode), scanIdPrefix: "data05-child" });
  await importBatch(ctx, api1, "data05-child-batch", batch);
  let state = await ctx.snapshot(api1.baseUrl);
  await createGroup(ctx, api1, "data05-group", groupRequest(split,
    batch.scans.map(({ scanId }) => byId(state.resources.intakeScans, "scanId", scanId))));
  const worker = await ctx.startWorker();
  state = await waitSnapshot(ctx, api1, value => split.aliquots.every(({ aliquotId }) =>
    byId(value.resources.aliquots, "aliquotId", aliquotId).state === "VERIFIED"),
  "child verification before custody transfer", { processes: [worker] });
  await ctx.stop(worker);
  const child = byId(state.resources.aliquots, "aliquotId", split.aliquots[0].aliquotId);
  const sibling = clone(byId(state.resources.aliquots, "aliquotId", split.aliquots[1].aliquotId));
  const path = `/api/v1/aliquots/${child.aliquotId}/transfers`;
  const body = { fromCustodianId: child.currentCustodianId,
    toCustodianId: seed.custodians.find(c => c.custodianId !== child.currentCustodianId).custodianId,
    occurredAt: ctx.at({ hours: 3 }) };
  const key = ctx.key("data05-transfer");
  const accepted = await ctx.mutate(api1.baseUrl, path, key, body);
  requireStatus(accepted, 200, "published Aliquot transfer");
  assert.equal(accepted.json.aliquotId, child.aliquotId);
  sameSemanticResponse(await ctx.mutate(api2.baseUrl, path, key, clone(body)), accepted);
  state = assertSnapshot(await ctx.snapshot(api1.baseUrl));
  assert.equal(byId(state.resources.aliquots, "aliquotId", child.aliquotId).currentCustodianId, body.toCustodianId);
  assert.deepEqual(byId(state.resources.aliquots, "aliquotId", sibling.aliquotId), sibling);
  assert.equal(state.resources.custodyTransfers.filter(t => t.aliquotId === child.aliquotId).length, 1);
  const before = stableSnapshot(state);
  assertError(await ctx.mutate(api2.baseUrl, `/api/v1/item-splits/${split.splitId}/reverse`,
    ctx.key("data05-illegal-reverse"), { reason: "child already transferred" }), 409, "SPLIT_NOT_REVERSIBLE");
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api1.baseUrl)), before);
  await ctx.kill(api1); await ctx.kill(api2);
  const restarted = await ctx.startApi();
  sameSemanticResponse(await ctx.mutate(restarted.baseUrl, path, key, clone(body)), accepted);
  assert.deepEqual(stableSnapshot(await ctx.snapshot(restarted.baseUrl)), before);
  return evidence("published child transfer changes only its custodian, replays once and survives restart",
    "transferred-child split reversal is rejected without changing the parent, sibling, Work or Events");
}

export const DATA_CASES = Object.freeze([
  guardedCase("DATA-01", ["DURABLE_IDEMPOTENCY", "PARTIAL_BATCH_OR_GROUP"], data01),
  guardedCase("DATA-02", ["DOUBLE_MATCH_OR_OWNER"], data02),
  guardedCase("DATA-03", ["QUANTITY_NON_CONSERVATION", "ILLEGAL_SPLIT_REVERSAL"], data03),
  guardedCase("DATA-04", ["PARTIAL_BATCH_OR_GROUP", "DOUBLE_MATCH_OR_OWNER"], data04),
  guardedCase("DATA-05", ["ILLEGAL_SPLIT_REVERSAL", "DURABLE_IDEMPOTENCY"], data05),
]);
