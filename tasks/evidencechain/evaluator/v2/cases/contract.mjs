import assert from "node:assert/strict";

import { baseSeed, groupRequest, intakeBatch, splitRequest } from "../fixtures/index.mjs";
import {
  ALIQUOT_KEYS, GROUP_KEYS, ITEM_KEYS, MATCH_KEYS, SCAN_KEYS, TRANSFER_KEYS,
  assertError, assertExactKeys, assertGroup, assertSnapshot, assertSplit, byId, clone,
  createGroup, createSplit, defineCase, evidence, groupDetail, importBatch, prepare,
  proposeMatch, publicVerifiedItem, requireStatus, reverseMatch, reverseSplit, splitDetail,
  stableSnapshot, timeline, transferItem, waitSnapshot,
} from "./helpers.mjs";

async function contract01(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 4 });
  const api = await prepare(ctx, seed);
  const batch = intakeBatch(ctx.fixtures, seed, { count: 3, batchSequence: 1 });
  const accepted = await importBatch(ctx, api, "contract01-next", batch);
  const initial = await ctx.snapshot(api.baseUrl);
  assert.equal(initial.resources.intakeScans.length, 3);
  initial.resources.intakeScans.forEach((scan) => assertExactKeys(scan, SCAN_KEYS, "IntakeScan"));
  const replay = await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", ctx.key("contract01-next"), clone(batch));
  assert.equal(replay.status, 202); assert.deepEqual(replay.json, accepted.json);
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(initial));

  const gap = intakeBatch(ctx.fixtures, seed, { count: 1, batchSequence: 3, scanIdPrefix: "gap" });
  assertError(await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", ctx.key("contract01-gap"), gap), 409, "DEVICE_SEQUENCE_GAP");
  const changed = clone(batch); changed.scans[0].sealCode += "-changed";
  assertError(await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", ctx.key("contract01-changed"), changed), 409, "INTAKE_BATCH_CONFLICT");
  const invalids = [
    { ...intakeBatch(ctx.fixtures, seed, { batchSequence: 2 }), scans: [] },
    { ...intakeBatch(ctx.fixtures, seed, { batchSequence: 2 }), unknown: true },
    { ...intakeBatch(ctx.fixtures, seed, { batchSequence: 2 }), scans: [{ ...batch.scans[0], facilityId: ctx.uuid("missing-facility") }] },
    { ...intakeBatch(ctx.fixtures, seed, { batchSequence: 2 }), scans: [{ ...batch.scans[0], scannedAt: "not-a-time" }] },
  ];
  for (const [index, invalid] of invalids.entries()) {
    const response = await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", ctx.key(`contract01-invalid-${index}`), invalid);
    assert.ok([400, 409].includes(response.status));
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(initial), `invalid member ${index} changed state`);
  }
  assert.equal(byId((await ctx.snapshot(api.baseUrl)).resources.deviceRegistrations, "deviceId", batch.deviceId).lastBatchSequence, 1);
  return evidence("next sequence accepted atomically and returned stable identifiers", "gap, changed digest, invalid member and unknown field left no effect");
}

async function contract02(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 3 });
  const mismatched = intakeBatch(ctx.fixtures, seed, { count: 3, seals: [seed.caseManifests[0].items[0].expectedSealCode, "wrong-seal", seed.caseManifests[0].items[2].expectedSealCode], labels: [seed.caseManifests[0].items[0].expectedLabel, seed.caseManifests[0].items[1].expectedLabel, seed.caseManifests[0].items[2].expectedLabel.toLowerCase()] });
  const api = await prepare(ctx, seed); await importBatch(ctx, api, "contract02-batch", mismatched);
  let snapshot = await ctx.snapshot(api.baseUrl);
  const [item0, item1, item2] = snapshot.resources.collectedItems;
  const [scan0, scan1, scan2] = mismatched.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId));
  const match0 = (await proposeMatch(ctx, api, "contract02-exact", item0.collectedItemId, scan0.intakeScanId)).json;
  const match1 = (await proposeMatch(ctx, api, "contract02-seal-mismatch", item1.collectedItemId, scan1.intakeScanId)).json;
  [match0, match1].forEach((match) => assertExactKeys(match, MATCH_KEYS, "CustodyMatch"));
  assertError(await ctx.mutate(api.baseUrl, "/api/v1/custody-matches", ctx.key("contract02-missing-item"), { collectedItemId: ctx.uuid("missing-item"), intakeScanId: scan2.intakeScanId }), 404, "NOT_FOUND");
  assertError(await ctx.mutate(api.baseUrl, "/api/v1/custody-matches", ctx.key("contract02-missing-scan"), { collectedItemId: item2.collectedItemId, intakeScanId: ctx.uuid("missing-scan") }), 404, "NOT_FOUND");
  const noCaseFold = await ctx.mutate(api.baseUrl, "/api/v1/custody-matches", ctx.key("contract02-case-sensitive"), { collectedItemId: item2.collectedItemId, intakeScanId: scan2.intakeScanId });
  assert.ok([400, 409].includes(noCaseFold.status), "case-insensitive label was proposed");
  const beforeStale = stableSnapshot(await ctx.snapshot(api.baseUrl));
  const stale = await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match0.matchId}/confirm`, ctx.key("contract02-stale"), { expectedItemRevision: item0.revision + 1, expectedScanRevision: scan0.revision });
  assertError(stale, 409, "CUSTODY_MATCH_CONFLICT"); assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeStale);
  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match0.matchId}/confirm`, ctx.key("contract02-confirm"), { expectedItemRevision: item0.revision, expectedScanRevision: scan0.revision });
  assertExactKeys(requireStatus(confirmed, 200), MATCH_KEYS, "confirmed CustodyMatch");
  snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  const currentItem = byId(snapshot.resources.collectedItems, "collectedItemId", item0.collectedItemId);
  const currentScan = byId(snapshot.resources.intakeScans, "intakeScanId", scan0.intakeScanId);
  assertExactKeys(currentItem, ITEM_KEYS, "CollectedItem"); assert.equal(currentItem.state, "RECEIVED"); assert.equal(currentScan.state, "MATCHED");
  assert.equal(currentItem.currentCustodianId, seed.facilities[0].receivingCustodianId);
  assert.equal(snapshot.work.filter(({ aggregateId, terminal }) => aggregateId === item0.collectedItemId && !terminal).length, 1);
  assertError(await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match1.matchId}/confirm`, ctx.key("contract02-shared-item"), { expectedItemRevision: item0.revision, expectedScanRevision: scan1.revision }), 409, "CUSTODY_MATCH_CONFLICT");
  return evidence("exact and seal-mismatch proposals retain public shapes while case-folded label is rejected", "confirm CAS closes Item, Scan, custodian and one Verification Work atomically");
}

async function contract03(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 3, custodianCount: 3 });
  const batch = intakeBatch(ctx.fixtures, seed, { count: 3, seals: [seed.caseManifests[0].items[0].expectedSealCode, "mismatch", seed.caseManifests[0].items[2].expectedSealCode] });
  const api = await prepare(ctx, seed); await importBatch(ctx, api, "contract03-batch", batch);
  let snapshot = await ctx.snapshot(api.baseUrl);
  const entries = batch.scans.map(({ scanId }, index) => ({ item: snapshot.resources.collectedItems[index], scan: byId(snapshot.resources.intakeScans, "scanId", scanId) }));
  const matches = [];
  for (const [index, entry] of entries.entries()) {
    const match = (await proposeMatch(ctx, api, `contract03-propose-${index}`, entry.item.collectedItemId, entry.scan.intakeScanId)).json;
    await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match.matchId}/confirm`, ctx.key(`contract03-confirm-${index}`), { expectedItemRevision: entry.item.revision, expectedScanRevision: entry.scan.revision });
    matches.push(match);
  }
  const reversed = await reverseMatch(ctx, api, "contract03-early-reverse", matches[2].matchId);
  assert.equal(reversed.json.state, "REVERSED");
  const worker = await ctx.startWorker();
  snapshot = await waitSnapshot(ctx, api, (value) => {
    const states = entries.slice(0, 2).map(({ item }) => byId(value.resources.collectedItems, "collectedItemId", item.collectedItemId).state);
    return states.includes("VERIFIED") && states.includes("QUARANTINED");
  }, "verification terminal states", { processes: [worker] });
  await ctx.stop(worker);
  const verified = byId(snapshot.resources.collectedItems, "collectedItemId", entries[0].item.collectedItemId);
  assertError(await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${matches[0].matchId}/reverse`, ctx.key("contract03-late-reverse"), { reason: "too late" }), 409, "CUSTODY_MATCH_NOT_REVERSIBLE");
  const t1 = (await transferItem(ctx, api, "contract03-transfer-1", verified.collectedItemId, { fromCustodianId: verified.currentCustodianId, toCustodianId: seed.custodians[1].custodianId, occurredAt: ctx.at({ hours: 1 }) })).json;
  const t2 = (await transferItem(ctx, api, "contract03-transfer-2", verified.collectedItemId, { fromCustodianId: seed.custodians[1].custodianId, toCustodianId: seed.custodians[2].custodianId, occurredAt: ctx.at({ hours: 2 }) })).json;
  [t1, t2].forEach((transfer) => assertExactKeys(transfer, TRANSFER_KEYS, "CustodyTransfer")); assert.equal(t2.priorTransferId, t1.transferId);
  const history = await timeline(ctx, api, verified.collectedItemId); assert.equal(history.item.currentCustodianId, seed.custodians[2].custodianId);
  const observation = entries[0].scan; const finalScan = byId((await ctx.snapshot(api.baseUrl)).resources.intakeScans, "intakeScanId", observation.intakeScanId);
  for (const key of ["label", "sealCode", "deviceId", "batchSequence", "scannedAt"]) assert.equal(finalScan[key], observation[key], `Verification changed ${key}`);
  return evidence("exact and mismatch Verification reached VERIFIED and QUARANTINED without rewriting observations", "early reversal restored members; late reversal failed; two transfers form one timeline chain");
}

async function verifiedParent(ctx, label = "parent", quantity = 10) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1, quantity });
  const batch = intakeBatch(ctx.fixtures, seed, { count: 1, batchSequence: 1 });
  const api = await prepare(ctx, seed); const verified = await publicVerifiedItem(ctx, api, seed, batch, 0, { label });
  return { seed, batch, api, ...verified };
}

async function contract04(ctx) {
  const { api, item } = await verifiedParent(ctx, "contract04", 40);
  const baseline = stableSnapshot(await ctx.snapshot(api.baseUrl));
  const invalidRequests = [
    splitRequest(ctx.fixtures, item, [40], { label: "one" }),
    splitRequest(ctx.fixtures, item, [...Array.from({ length: 20 }, () => 1), 20], { label: "twenty-one" }),
    splitRequest(ctx.fixtures, item, [0, 40], { label: "zero" }),
    splitRequest(ctx.fixtures, item, [20, 19], { label: "short" }),
    splitRequest(ctx.fixtures, item, [20, 21], { label: "long" }),
    splitRequest(ctx.fixtures, item, [Number.MAX_SAFE_INTEGER, 1], { label: "unsafe" }),
    splitRequest(ctx.fixtures, item, [20, 20], { label: "stale", expectedRevision: item.revision + 1 }),
  ];
  const duplicate = splitRequest(ctx.fixtures, item, [20, 20], { label: "duplicate" }); duplicate.aliquots[1].aliquotId = duplicate.aliquots[0].aliquotId; invalidRequests.push(duplicate);
  for (const [index, request] of invalidRequests.entries()) {
    const response = await ctx.mutate(api.baseUrl, `/api/v1/collected-items/${item.collectedItemId}/splits`, ctx.key(`contract04-invalid-${index}`), request);
    assert.ok([400, 409].includes(response.status), `invalid split ${index} accepted`);
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), baseline, `invalid split ${index} was partial`);
  }
  const created = (await createSplit(ctx, api, "contract04-create", item.collectedItemId, splitRequest(ctx.fixtures, item, [4, 12, 24], { label: "valid" }))).json;
  assertSplit(created, item.quantity);
  let snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  const parent = byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId);
  assert.equal(parent.state, "CONSUMED_BY_SPLIT"); assert.equal(parent.currentCustodianId, null); assert.equal(parent.intakeScanId, null);
  const detail = await splitDetail(ctx, api, created.splitId); assert.equal(detail.parent.collectedItemId, item.collectedItemId); assert.equal(detail.aliquotTimelines.length, created.aliquots.length);
  const reversed = (await reverseSplit(ctx, api, "contract04-reverse", created.splitId)).json; assert.equal(reversed.state, "REVERSED");
  snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  let restored = byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId); assert.equal(restored.state, "VERIFIED"); assert.equal(restored.quantity, 40);
  assert.equal(byId(snapshot.resources.itemSplits, "splitId", created.splitId).state, "REVERSED", "reverse left active child authority");
  const two = (await createSplit(ctx, api, "contract04-two", restored.collectedItemId, splitRequest(ctx.fixtures, restored, [20, 20], { label: "two" }))).json; assertSplit(two, 40); await reverseSplit(ctx, api, "contract04-two-reverse", two.splitId);
  restored = byId((await ctx.snapshot(api.baseUrl)).resources.collectedItems, "collectedItemId", item.collectedItemId);
  const twenty = (await createSplit(ctx, api, "contract04-twenty", restored.collectedItemId, splitRequest(ctx.fixtures, restored, Array.from({ length: 20 }, () => 2), { label: "twenty" }))).json; assertSplit(twenty, 40); await reverseSplit(ctx, api, "contract04-twenty-reverse", twenty.splitId);
  snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); assert.equal(snapshot.resources.itemSplits.filter(({ parentItemId, state }) => parentItemId === item.collectedItemId && state === "ACTIVE").length, 0);
  return evidence("1/21 child boundaries and stale/duplicate/unsafe quantity requests reject atomically while 2 and 20 are accepted", "valid 3-, 2- and 20-child splits each consumed the parent and untransferred reversal restored it without deleting history");
}

async function contract05(ctx) {
  const { api, item, seed } = await verifiedParent(ctx, "contract05");
  const split = (await createSplit(ctx, api, "contract05-split", item.collectedItemId, splitRequest(ctx.fixtures, item, [2, 3, 5], { label: "group" }))).json;
  const childBatch = intakeBatch(ctx.fixtures, seed, { count: 3, batchSequence: 2, items: split.aliquots.map(() => seed.caseManifests[0].items[0]), seals: split.aliquots.map(({ sealCode }) => sealCode), scanIdPrefix: "aliquot-observation", minute: 10 });
  await importBatch(ctx, api, "contract05-child-batch", childBatch);
  let snapshot = await ctx.snapshot(api.baseUrl); const scans = childBatch.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId));
  const valid = groupRequest(split, scans); const invalids = [
    { ...clone(valid), members: valid.members.slice(0, -1) },
    { ...clone(valid), members: [...valid.members, valid.members[0]] },
    { ...clone(valid), members: valid.members.map((member, index) => index === 1 ? { ...member, intakeScanId: valid.members[0].intakeScanId } : member) },
    { ...clone(valid), members: valid.members.map((member, index) => index === 0 ? { ...member, aliquotId: ctx.uuid("foreign-aliquot") } : member) },
  ];
  const before = stableSnapshot(snapshot);
  for (const [index, request] of invalids.entries()) {
    assertError(await ctx.mutate(api.baseUrl, "/api/v1/custody-match-groups", ctx.key(`contract05-invalid-${index}`), request), 409, "CUSTODY_MATCH_GROUP_CONFLICT");
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), before, `invalid group ${index} was partial`);
  }
  valid.members.reverse(); const group = (await createGroup(ctx, api, "contract05-group", valid)).json; assertGroup(group, split); assertExactKeys(group, GROUP_KEYS, "CustodyMatchGroup");
  assert.deepEqual(await groupDetail(ctx, api, group.custodyMatchGroupId), group);
  snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  for (const aliquot of split.aliquots) {
    const current = byId(snapshot.resources.aliquots, "aliquotId", aliquot.aliquotId); assertExactKeys(current, ALIQUOT_KEYS, "Aliquot"); assert.equal(current.state, "RECEIVED");
    assert.equal(snapshot.work.filter(({ aggregateId, terminal }) => aggregateId === aliquot.aliquotId && !terminal).length, 1);
  }
  const worker = await ctx.startWorker(); snapshot = await waitSnapshot(ctx, api, (value) => split.aliquots.every(({ aliquotId }) => ["VERIFIED", "QUARANTINED"].includes(byId(value.resources.aliquots, "aliquotId", aliquotId).state)), "contract05 child verification", { processes: [worker] }); await ctx.stop(worker);
  const detail = await splitDetail(ctx, api, split.splitId); assert.deepEqual(detail.aliquotTimelines.map(({ aliquotId }) => aliquotId), split.aliquots.map(({ aliquotId }) => aliquotId));
  return evidence("incomplete, duplicate, shared-scan and foreign-member groups left the graph unchanged", "reverse-order valid members committed one sorted complete Group and one independent Work per child");
}

export const CONTRACT_CASES = Object.freeze([
  defineCase("CONTRACT-01", contract01),
  defineCase("CONTRACT-02", contract02),
  defineCase("CONTRACT-03", contract03),
  defineCase("CONTRACT-04", contract04),
  defineCase("CONTRACT-05", contract05),
]);
