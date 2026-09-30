import assert from "node:assert/strict";

import { baseSeed, groupRequest, intakeBatch, splitRequest } from "../fixtures/index.mjs";
import {
  assertSnapshot, byId, createGroup, createSplit, evidence, guardedCase, importBatch,
  prepare, proposeMatch, publicVerifiedItem, stableSnapshot, waitSnapshot,
} from "./helpers.mjs";

async function confirmItems(ctx, api, seed, batch, label) {
  await importBatch(ctx, api, `${label}-batch`, batch);
  let snapshot = await ctx.snapshot(api.baseUrl); const pairs = [];
  for (const [index, scanBody] of batch.scans.entries()) {
    const item = snapshot.resources.collectedItems[index]; const scan = byId(snapshot.resources.intakeScans, "scanId", scanBody.scanId);
    const match = (await proposeMatch(ctx, api, `${label}-propose-${index}`, item.collectedItemId, scan.intakeScanId)).json;
    const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match.matchId}/confirm`, ctx.key(`${label}-confirm-${index}`), { expectedItemRevision: item.revision, expectedScanRevision: scan.revision });
    assert.equal(confirmed.status, 200, confirmed.text); pairs.push({ item, scan, match });
  }
  return pairs;
}

async function recovery01(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 2 }); const batch = intakeBatch(ctx.fixtures, seed, { count: 2, seals: [seed.caseManifests[0].items[0].expectedSealCode, "seal-mismatch"] });
  const api = await prepare(ctx, seed); const pairs = await confirmItems(ctx, api, seed, batch, "recovery01"); const before = await ctx.snapshot(api.baseUrl);
  let holds = 0; const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" && holds++ < 2 });
  const env = { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 1 };
  const workers = [await ctx.startWorker({ env }), await ctx.startWorker({ env })];
  const entries = [];
  for (let index = 0; index < 2; index += 1) entries.push(await barrier.waitFor((entry) => entry.json.point === "worker.claimed" && !entries.includes(entry), { timeoutMs: 20_000 }));
  assert.equal(new Set(entries.map(({ json }) => json.workId)).size, 2); await Promise.all(workers.map((worker) => ctx.kill(worker)));
  const replacements = [await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } }), await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } })];
  const final = await waitSnapshot(ctx, api, (snapshot) => pairs.every(({ item }) => ["VERIFIED", "QUARANTINED"].includes(byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId).state)) && snapshot.work.every(({ aggregateId, terminal }) => !pairs.some(({ item }) => item.collectedItemId === aggregateId) || terminal), "claimed worker recovery", { timeoutMs: 30_000, processes: replacements });
  await Promise.all(replacements.map((worker) => ctx.stop(worker))); assertSnapshot(final);
  assert.deepEqual(pairs.map(({ item }) => byId(final.resources.collectedItems, "collectedItemId", item.collectedItemId).state).sort(), ["QUARANTINED", "VERIFIED"]);
  for (const pair of pairs) {
    const oldScan = byId(before.resources.intakeScans, "intakeScanId", pair.scan.intakeScanId); const newScan = byId(final.resources.intakeScans, "intakeScanId", pair.scan.intakeScanId);
    for (const key of ["label", "sealCode", "deviceId", "batchSequence", "scannedAt"]) assert.equal(newScan[key], oldScan[key]);
    const work = final.work.find(({ aggregateId }) => aggregateId === pair.item.collectedItemId); assert.ok(work.terminal && work.attempt >= 2 && work.leaseOwner === null && work.leaseExpiresAt === null);
  }
  return evidence("two distinct Work leases were observed at the exact claimed barrier and their owners SIGKILLed", "two replacements reclaimed expired leases, retained terminal Work and converged exact/mismatch independently");
}

async function recovery02(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1, quantity: 9 }); const parentBatch = intakeBatch(ctx.fixtures, seed, { count: 1 });
  const api = await prepare(ctx, seed); const { item } = await publicVerifiedItem(ctx, api, seed, parentBatch, 0, { label: "recovery02-parent" });
  const split = (await createSplit(ctx, api, "recovery02-split", item.collectedItemId, splitRequest(ctx.fixtures, item, [2, 3, 4], { label: "recovery02" }))).json;
  const childBatch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 3, items: split.aliquots.map(() => seed.caseManifests[0].items[0]), seals: [split.aliquots[0].sealCode, "mismatch", split.aliquots[2].sealCode], scanIdPrefix: "recovery02-child" });
  await importBatch(ctx, api, "recovery02-child-batch", childBatch); const observed = await ctx.snapshot(api.baseUrl); const scans = childBatch.scans.map(({ scanId }) => byId(observed.resources.intakeScans, "scanId", scanId));
  await createGroup(ctx, api, "recovery02-group", groupRequest(split, scans));
  let holds = 0; const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.effect-complete" && holds++ < 3 }); const env = { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 1 };
  const workers = await Promise.all(Array.from({ length: 3 }, () => ctx.startWorker({ env })));
  const entries = [];
  for (let index = 0; index < 3; index += 1) entries.push(await barrier.waitFor((entry) => entry.json.point === "worker.effect-complete" && !entries.includes(entry), { timeoutMs: 20_000 }));
  assert.equal(new Set(entries.map(({ json }) => json.aggregateId)).size, 3); await Promise.all(workers.map((worker) => ctx.kill(worker)));
  const replacements = await Promise.all(Array.from({ length: 3 }, () => ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } })));
  const final = await waitSnapshot(ctx, api, (snapshot) => split.aliquots.every(({ aliquotId }) => ["VERIFIED", "QUARANTINED"].includes(byId(snapshot.resources.aliquots, "aliquotId", aliquotId).state)) && snapshot.work.filter(({ aggregateId }) => split.aliquots.some(({ aliquotId }) => aliquotId === aggregateId)).every(({ terminal }) => terminal), "child effect recovery", { timeoutMs: 30_000, processes: replacements });
  await Promise.all(replacements.map((worker) => ctx.stop(worker))); assertSnapshot(final);
  assert.deepEqual(split.aliquots.map(({ aliquotId }) => byId(final.resources.aliquots, "aliquotId", aliquotId).state).sort(), ["QUARANTINED", "VERIFIED", "VERIFIED"]);
  assert.equal(byId(final.resources.collectedItems, "collectedItemId", item.collectedItemId).state, "CONSUMED_BY_SPLIT");
  for (const scan of scans) {
    const current = byId(final.resources.intakeScans, "intakeScanId", scan.intakeScanId);
    for (const key of ["label", "sealCode", "deviceId", "batchSequence", "scannedAt"]) assert.equal(current[key], scan[key]);
  }
  return evidence("all three child effects reached an observable effect-complete barrier before SIGKILL", "replacement workers produced two VERIFIED and one QUARANTINED child exactly once without changing parent/group authority");
}

async function reversalSubcase(ctx, point, ordinal) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1 }); const batch = intakeBatch(ctx.fixtures, seed, { count: 1 }); const api = await prepare(ctx, seed);
  const [{ item, match }] = await confirmItems(ctx, api, seed, batch, `recovery03-${ordinal}`);
  const barrier = await ctx.barrier({ hold: ({ point: candidate }) => candidate === point }); const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 1 } });
  const entry = await barrier.waitFor(({ json }) => json.point === point, { timeoutMs: 20_000 });
  const reversed = await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match.matchId}/reverse`, ctx.key(`recovery03-reverse-${ordinal}`), { reason: `reversal at ${point}` }); assert.equal(reversed.status, 200, reversed.text);
  await ctx.kill(worker); barrier.release(entry);
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } });
  const final = await waitSnapshot(ctx, api, (snapshot) => {
    const current = byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId); const work = snapshot.work.find(({ aggregateId }) => aggregateId === item.collectedItemId);
    return current.state === "EXPECTED" && (!work || work.terminal);
  }, `reversal fence ${point}`, { timeoutMs: 20_000, processes: [replacement] });
  await ctx.stop(replacement); const current = byId(final.resources.collectedItems, "collectedItemId", item.collectedItemId); assert.equal(current.state, "EXPECTED"); assert.equal(current.intakeScanId, null); assert.equal(current.currentCustodianId, null);
}

async function splitReversalSubcase(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1, quantity: 10 }); const parentBatch = intakeBatch(ctx.fixtures, seed, { count: 1 }); const api = await prepare(ctx, seed);
  const { item } = await publicVerifiedItem(ctx, api, seed, parentBatch, 0, { label: "recovery03-split-parent" });
  const split = (await createSplit(ctx, api, "recovery03-split", item.collectedItemId, splitRequest(ctx.fixtures, item, [4, 6], { label: "recovery03-split" }))).json;
  const childBatch = intakeBatch(ctx.fixtures, seed, { batchSequence: 2, count: 2, items: split.aliquots.map(() => seed.caseManifests[0].items[0]), seals: split.aliquots.map(({ sealCode }) => sealCode), scanIdPrefix: "recovery03-child" });
  await importBatch(ctx, api, "recovery03-child-batch", childBatch); const snapshot = await ctx.snapshot(api.baseUrl); const scans = childBatch.scans.map(({ scanId }) => byId(snapshot.resources.intakeScans, "scanId", scanId)); await createGroup(ctx, api, "recovery03-group", groupRequest(split, scans));
  const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.before-commit" }); const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 1 } }); await barrier.waitFor(({ json }) => json.point === "worker.before-commit", { timeoutMs: 20_000 });
  const reversed = await ctx.mutate(api.baseUrl, `/api/v1/item-splits/${split.splitId}/reverse`, ctx.key("recovery03-split-reverse"), { reason: "before-commit fence" }); assert.equal(reversed.status, 200, reversed.text); await ctx.kill(worker);
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } });
  const final = await waitSnapshot(ctx, api, (value) => byId(value.resources.collectedItems, "collectedItemId", item.collectedItemId).state === "VERIFIED" && value.work.filter(({ aggregateId }) => split.aliquots.some(({ aliquotId }) => aliquotId === aggregateId)).every(({ terminal }) => terminal), "split reversal fence", { timeoutMs: 20_000, processes: [replacement] });
  await ctx.stop(replacement); assert.equal(byId(final.resources.itemSplits, "splitId", split.splitId).state, "REVERSED"); assert.equal(byId(final.resources.collectedItems, "collectedItemId", item.collectedItemId).state, "VERIFIED"); assert.equal(final.events.filter(({ aggregateId, type }) => split.aliquots.some(({ aliquotId }) => aliquotId === aggregateId) && ["item.verified", "item.quarantined"].includes(type)).length, 0);
}

async function recovery03(ctx) {
  for (const [ordinal, point] of ["worker.claimed", "worker.effect-complete"].entries()) {
    if (ordinal > 0) await ctx.resetDatabase();
    await reversalSubcase(ctx, point, ordinal);
  }
  await ctx.resetDatabase(); await splitReversalSubcase(ctx);
  return evidence("public Match reversal raced claimed/effect-complete and untransferred split reversal raced before-commit", "all stale owners were fenced; reversed Items/split retained legal authority with terminal or cancelled Work and no late verification");
}

async function recovery04(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 2 }); const api = await prepare(ctx, seed); const batch = intakeBatch(ctx.fixtures, seed, { count: 2 }); await importBatch(ctx, api, "recovery04-batch", batch);
  const receiver = await ctx.receiver({ path: "/events", behavior: () => ({ status: 204 }) }); let held = false;
  const barrier = await ctx.barrier({ hold: ({ processRole, point }) => processRole === "dispatcher" && point === "dispatcher.response-received" && !held && (held = true) });
  const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const entry = await barrier.waitFor(({ json }) => json.point === "dispatcher.response-received", { timeoutMs: 20_000 });
  await ctx.waitFor(() => receiver.ledger.length >= 1, { label: "receiver body" }); const first = receiver.ledger[0]; assert.equal(first.responseStatus, 204); await ctx.kill(dispatcher); barrier.release(entry);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => receiver.ledger.some((candidate, index) => index > 0 && candidate.headers["x-evidencechain-event-id"] === first.headers["x-evidencechain-event-id"]), { timeoutMs: 30_000, label: "same event retry", processes: [replacement] });
  await ctx.stop(replacement); const retry = receiver.ledger.find((candidate, index) => index > 0 && candidate.headers["x-evidencechain-event-id"] === first.headers["x-evidencechain-event-id"]);
  assert.deepEqual(retry.json, first.json); assert.equal(retry.headers["x-evidencechain-event-type"], first.headers["x-evidencechain-event-type"]);
  const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  const sequences = new Map(); for (const event of snapshot.events) { const list = sequences.get(event.aggregateId) ?? []; list.push(event.sequence); sequences.set(event.aggregateId, list); }
  for (const values of sequences.values()) assert.deepEqual(values, Array.from({ length: values.length }, (_, index) => index + 1));
  assert.doesNotMatch(JSON.stringify(receiver.ledger), /barrierToken|privatePath|rawWebhook/u);
  return evidence("receiver completed 204 before dispatcher was SIGKILLed at response-received", "replacement retried the same eventId, type and semantic JSON while aggregate sequences remained contiguous");
}

export const RECOVERY_CASES = Object.freeze([
  guardedCase("RECOVERY-01", ["OBSERVED_EVIDENCE_REWRITE", "STALE_VERIFICATION_COMMIT"], recovery01),
  guardedCase("RECOVERY-02", ["OBSERVED_EVIDENCE_REWRITE", "STALE_VERIFICATION_COMMIT"], recovery02),
  guardedCase("RECOVERY-03", ["STALE_VERIFICATION_COMMIT", "ILLEGAL_SPLIT_REVERSAL"], recovery03),
  guardedCase("RECOVERY-04", [], recovery04),
]);
