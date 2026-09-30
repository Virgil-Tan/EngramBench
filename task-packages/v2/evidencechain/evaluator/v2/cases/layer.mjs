import assert from "node:assert/strict";

import { baseSeed, groupRequest, intakeBatch, splitRequest } from "../fixtures/index.mjs";
import { canonicalJson } from "../oracles/index.mjs";
import {
  FINAL_RESOURCE_KEYS, MATCH_KEYS, SCAN_KEYS, assertGroup,
  assertSnapshot, assertSplit, assertSplitParent, byId, clickVisible, createGroup, createSplit, defineCase,
  evidence, fillVisible, groupDetail, importBatch, openVisibleUi, prepare, proposeMatch,
  publicVerifiedItem, splitDetail, stableSnapshot, timeline, transferItem,
} from "./helpers.mjs";

function openApiRoutes(document) {
  const expected = {
    "/api/v1/intake-batches": ["post"],
    "/api/v1/custody-matches": ["get", "post"],
    "/api/v1/custody-matches/{matchId}": ["get"],
    "/api/v1/custody-matches/{matchId}/confirm": ["post"],
    "/api/v1/custody-matches/{matchId}/reverse": ["post"],
    "/api/v1/collected-items/{itemId}/transfers": ["post"],
    "/api/v1/collected-items/{itemId}/timeline": ["get"],
    "/api/v1/collected-items/{itemId}/splits": ["post"],
    "/api/v1/item-splits/{splitId}/reverse": ["post"],
    "/api/v1/item-splits/{splitId}": ["get"],
    "/api/v1/custody-match-groups": ["post"],
    "/api/v1/custody-match-groups/{custodyMatchGroupId}": ["get"],
    "/api/v1/aliquots/{aliquotId}/transfers": ["post"],
    "/api/v1/domain-events": ["get"],
    "/api/v1/verification-snapshot": ["get"],
  };
  for (const [path, methods] of Object.entries(expected)) {
    assert.ok(document.paths?.[path], `OpenAPI missing ${path}`);
    for (const method of methods) assert.ok(document.paths[path][method], `OpenAPI missing ${method.toUpperCase()} ${path}`);
  }
}

async function layer01(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1, quantity: 10 }); const batch = intakeBatch(ctx.fixtures, seed, { count: 1 });
  const api = await prepare(ctx, seed); const openapi = await ctx.request(api.baseUrl, "/openapi.json"); assert.equal(openapi.status, 200); assert.match(openapi.json.openapi, /^3\.1(?:\.|$)/u); openApiRoutes(openapi.json);
  const { item } = await publicVerifiedItem(ctx, api, seed, batch, 0, { label: "layer01" });
  const split = (await createSplit(ctx, api, "layer01-split", item.collectedItemId, splitRequest(ctx.fixtures, item, [4, 6], { label: "layer01" }))).json; assertSplit(split, 10);
  const childBatch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 2, items: split.aliquots.map(() => seed.caseManifests[0].items[0]), seals: split.aliquots.map(({ sealCode }) => sealCode), scanIdPrefix: "layer01-child" });
  await importBatch(ctx, api, "layer01-child-batch", childBatch); const snapshot = await ctx.snapshot(api.baseUrl); const scans = childBatch.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId));
  const group = (await createGroup(ctx, api, "layer01-group", groupRequest(split, scans))).json; assertGroup(group, split);
  assert.deepEqual(await groupDetail(ctx, api, group.custodyMatchGroupId), group); const detail = await splitDetail(ctx, api, split.splitId); assert.equal(detail.split.splitId, split.splitId);
  assertSplitParent(detail.parent, detail.split);
  const source = JSON.stringify(openapi.json); for (const code of ["ALIQUOT_QUANTITY_MISMATCH", "SPLIT_NOT_REVERSIBLE", "CUSTODY_MATCH_GROUP_CONFLICT", "IDEMPOTENCY_CONFLICT"]) assert.match(source, new RegExp(code, "u"));
  return evidence("OpenAPI 3.1 publishes base, split, group and published Aliquot transfer routes", "live base, split, complete group and detail response shapes agreed with the published document");
}

async function layer02(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 2, custodianCount: 2 }); const api = await prepare(ctx, seed);
  const item = seed.caseManifests[0].items[0]; const device = seed.deviceRegistrations[0]; const facility = seed.facilities[0];
  const reversibleBatch = intakeBatch(ctx.fixtures, seed, { itemOffset: 1, count: 1, batchSequence: 1, scanIdPrefix: "layer02-reversible" }); await importBatch(ctx, api, "layer02-reversible-batch", reversibleBatch);
  let setup = await ctx.snapshot(api.baseUrl); const reversibleItem = setup.resources.collectedItems[1]; const reversibleScan = byId(setup.resources.intakeScans, "scanId", reversibleBatch.scans[0].scanId); const reversibleMatch = (await proposeMatch(ctx, api, "layer02-reversible-propose", reversibleItem.collectedItemId, reversibleScan.intakeScanId)).json;
  await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${reversibleMatch.matchId}/confirm`, ctx.key("layer02-reversible-confirm"), { expectedItemRevision: reversibleItem.revision, expectedScanRevision: reversibleScan.revision });
  let worker;
  await openVisibleUi(ctx, api, async (page) => {
    await clickVisible(page, [/match/i]); await page.getByText(new RegExp(reversibleMatch.matchId, "i")).first().click(); await clickVisible(page, [/reverse/i]); await fillVisible(page, /reason/i, "visible pre-verification reversal"); await clickVisible(page, [/confirm|reverse/i]); await page.getByText(/reversed/i).first().waitFor();
    await clickVisible(page, [/intake|scanner|batch/i]);
    await fillVisible(page, /device/i, device.deviceId); await fillVisible(page, /batch.*sequence|sequence/i, 2);
    await fillVisible(page, /scan.*id/i, "layer02-visible-scan"); await fillVisible(page, /^label|observed.*label/i, item.expectedLabel);
    await fillVisible(page, /seal/i, item.expectedSealCode); await fillVisible(page, /scanned.*at|timestamp/i, ctx.at({ minutes: 1 })); await fillVisible(page, /facility/i, facility.facilityId);
    await clickVisible(page, [/import|submit|accept/i]); await page.getByText(/accepted|unmatched/i).first().waitFor();
    await clickVisible(page, [/match/i]); await fillVisible(page, /collected.*item|item.*id/i, item.collectedItemId);
    const snapshot = await ctx.snapshot(api.baseUrl); const scan = byId(snapshot.resources.intakeScans, "scanId", "layer02-visible-scan"); await fillVisible(page, /intake.*scan|scan.*id/i, scan.intakeScanId);
    await clickVisible(page, [/propose|create.*match/i]); await page.getByText(/proposed/i).first().waitFor();
    const match = (await ctx.request(api.baseUrl, "/api/v1/custody-matches?limit=100")).json.items.find(({ collectedItemId }) => collectedItemId === item.collectedItemId);
    await fillVisible(page, /item.*revision/i, byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId).revision); await fillVisible(page, /scan.*revision/i, scan.revision);
    await clickVisible(page, [/confirm/i]); worker = await ctx.startWorker(); await page.getByText(/received|verified/i).first().waitFor(); await page.reload({ waitUntil: "networkidle" }); await page.getByText(new RegExp(match.matchId, "i")).first().waitFor();
    await clickVisible(page, [/transfer|custody/i]); const current = byId((await ctx.snapshot(api.baseUrl)).resources.collectedItems, "collectedItemId", item.collectedItemId);
    await fillVisible(page, /from.*custodian/i, current.currentCustodianId); await fillVisible(page, /to.*custodian/i, seed.custodians[1].custodianId); await fillVisible(page, /occurred.*at/i, ctx.at({ hours: 2 })); await clickVisible(page, [/transfer|submit/i]);
    await clickVisible(page, [/timeline|history/i]); await page.getByText(/CUSTODY_TRANSFERRED/i).first().waitFor();
  });
  if (worker) await ctx.stop(worker); const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); const current = byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId); assert.equal(current.currentCustodianId, seed.custodians[1].custodianId); assert.equal(byId(snapshot.resources.custodyMatches, "matchId", reversibleMatch.matchId).state, "REVERSED"); await timeline(ctx, api, item.collectedItemId);
  return evidence("Chromium reversed one pre-verification Match, then imported, matched, verified and transferred another through visible controls", "refresh retained both terminal flows and the visible timeline agreed with API/snapshot custody authority");
}

async function layer03(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1, quantity: 10 }); const batch = intakeBatch(ctx.fixtures, seed, { count: 1 }); const api = await prepare(ctx, seed); const { item } = await publicVerifiedItem(ctx, api, seed, batch, 0, { label: "layer03-parent" });
  const aliquots = [{ aliquotId: ctx.uuid("ui-child-0"), quantity: 4, sealCode: "UI-SEAL-0" }, { aliquotId: ctx.uuid("ui-child-1"), quantity: 6, sealCode: "UI-SEAL-1" }];
  await openVisibleUi(ctx, api, async (page) => {
    await clickVisible(page, [/split|lineage/i]); await fillVisible(page, /parent.*item|collected.*item/i, item.collectedItemId); await fillVisible(page, /expected.*revision|revision/i, item.revision);
    await fillVisible(page, /aliquot|children/i, JSON.stringify(aliquots)); await clickVisible(page, [/create.*split|split/i]); await page.getByText(/CONSUMED_BY_SPLIT|active/i).first().waitFor();
  });
  let snapshot = await ctx.snapshot(api.baseUrl); const split = snapshot.resources.itemSplits.find(({ parentItemId }) => parentItemId === item.collectedItemId); assertSplit(split, 10);
  const childBatch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 2, items: split.aliquots.map(() => seed.caseManifests[0].items[0]), seals: split.aliquots.map(({ sealCode }) => sealCode), scanIdPrefix: "layer03-child" }); await importBatch(ctx, api, "layer03-child-batch", childBatch); snapshot = await ctx.snapshot(api.baseUrl); const scans = childBatch.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId));
  await openVisibleUi(ctx, api, async (page) => {
    await clickVisible(page, [/group|lineage/i]); await fillVisible(page, /split.*id/i, split.splitId); await fillVisible(page, /members|aliquot.*scan/i, JSON.stringify(groupRequest(split, scans).members)); await clickVisible(page, [/confirm.*group|create.*group/i]); await page.getByText(/confirmed/i).first().waitFor();
    await clickVisible(page, [/detail|lineage/i]); await page.getByText(new RegExp(split.aliquots[0].aliquotId, "i")).first().waitFor();
    await clickVisible(page, [/reverse.*split|reverse/i]); await fillVisible(page, /reason/i, "visible untransferred reversal"); await clickVisible(page, [/confirm|reverse/i]); await page.getByText(/reversed|verified/i).first().waitFor();
  });
  snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); assert.equal(byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId).state, "VERIFIED"); assert.equal(byId(snapshot.resources.itemSplits, "splitId", split.splitId).state, "REVERSED");
  return evidence("Chromium created the quantity-conserving split and complete group through visible controls", "visible lineage detail exposed both children and an untransferred reversal restored the parent after refresh");
}

function assertSorted(items, keys) {
  const expected = [...items].sort((left, right) => {
    for (const key of keys) { const compared = Buffer.from(String(left[key] ?? "")).compare(Buffer.from(String(right[key] ?? ""))); if (compared) return compared; }
    return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right)));
  });
  assert.deepEqual(items, expected);
}

async function layer04(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 4, quantity: 10, deviceCount: 2 }); const api1 = await prepare(ctx, seed); const api2 = await ctx.startApi();
  const batch = intakeBatch(ctx.fixtures, seed, { count: 4, batchSequence: 1, scanIdPrefix: "layer04" }); await importBatch(ctx, api1, "layer04-batch", batch); let snapshot = await ctx.snapshot(api1.baseUrl);
  const items = snapshot.resources.collectedItems; const scans = batch.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId));
  const matches = await Promise.all(items.map((item, index) => proposeMatch(ctx, index % 2 ? api2 : api1, `layer04-propose-${index}`, item.collectedItemId, scans[index].intakeScanId)));
  await Promise.all(matches.map((match, index) => ctx.mutate((index % 2 ? api2 : api1).baseUrl, `/api/v1/custody-matches/${match.json.matchId}/confirm`, ctx.key(`layer04-confirm-${index}`), { expectedItemRevision: items[index].revision, expectedScanRevision: scans[index].revision })));
  const worker = await ctx.startWorker(); snapshot = await waitSnapshotForVerified(ctx, api1, items.map(({ collectedItemId }) => collectedItemId), worker); await ctx.stop(worker);
  const parent = byId(snapshot.resources.collectedItems, "collectedItemId", items[0].collectedItemId);
  const operations = [
    (async () => {
      const split = (await createSplit(ctx, api1, "layer04-split", parent.collectedItemId, splitRequest(ctx.fixtures, parent, [5, 5], { label: "layer04" }))).json;
      const childBatch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 2, items: split.aliquots.map(() => seed.caseManifests[0].items[0]), seals: split.aliquots.map(({ sealCode }) => sealCode), scanIdPrefix: "layer04-child" }); await importBatch(ctx, api1, "layer04-child-batch", childBatch);
      const lineageSnapshot = await ctx.snapshot(api1.baseUrl); const childScans = childBatch.scans.map(({ scanId }) => byId(lineageSnapshot.resources.intakeScans, "scanId", scanId)); await createGroup(ctx, api2, "layer04-group", groupRequest(split, childScans));
    })(),
    transferItem(ctx, api2, "layer04-transfer", items[1].collectedItemId, { fromCustodianId: byId(snapshot.resources.collectedItems, "collectedItemId", items[1].collectedItemId).currentCustodianId, toCustodianId: seed.custodians[1].custodianId, occurredAt: ctx.at({ hours: 4 }) }),
  ];
  const observed = [];
  await Promise.all([Promise.all(operations), (async () => { for (let index = 0; index < 12; index += 1) observed.push(assertSnapshot(await ctx.snapshot(index % 2 ? api1.baseUrl : api2.baseUrl))); })()]);
  for (const value of observed) {
    assert.deepEqual(Object.keys(value.resources).sort(), FINAL_RESOURCE_KEYS); assertSorted(value.resources.collectedItems, ["collectedItemId"]); assertSorted(value.resources.intakeScans, ["intakeScanId"]); assertSorted(value.events, ["aggregateId", "sequence", "eventId"]);
    for (const split of value.resources.itemSplits) if (split.state === "ACTIVE") { assert.ok(value.resources.collectedItems.some(({ collectedItemId, state }) => collectedItemId === split.parentItemId && state === "CONSUMED_BY_SPLIT")); split.aliquots.forEach(({ aliquotId }) => assert.ok(value.resources.aliquots.some((entry) => entry.aliquotId === aliquotId))); }
  }
  return evidence("authenticated snapshots remained exact, sorted and recursively redacted during concurrent public mutations", "every observed split, child, parent, match, transfer, Work and event link closed within one asOf snapshot");
}

async function waitSnapshotForVerified(ctx, api, ids, worker) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(api.baseUrl); return ids.every((id) => byId(snapshot.resources.collectedItems, "collectedItemId", id).state === "VERIFIED") ? snapshot : undefined; }, { timeoutMs: 45_000, intervalMs: 75, label: "verified items", processes: [worker] });
}

export const LAYER_CASES = Object.freeze([
  defineCase("LAYER-01", layer01),
  defineCase("LAYER-02", layer02),
  defineCase("LAYER-03", layer03),
  defineCase("LAYER-04", layer04),
]);
