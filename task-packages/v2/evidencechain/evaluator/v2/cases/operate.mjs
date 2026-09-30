import assert from "node:assert/strict";

import { baseSeed, intakeBatch, invalidSeedFixtures, manifestItems, performanceContract, performanceSeed } from "../fixtures/index.mjs";
import { canonicalDigest } from "../oracles/index.mjs";
import {
  assertSnapshot, byId, clone, closedLoop, evidence, guardedCase, importBatch, prepare,
  proposeMatch, sameSemanticResponse, stableSnapshot, timeline, transferItem, waitSnapshot,
} from "./helpers.mjs";

function formalFactory(ctx) { return performanceSeed(ctx.fixtures); }

async function operate01(ctx) {
  const contract = performanceContract().batch; const seed = formalFactory(ctx); const api = await prepare(ctx, seed); const baseline = await ctx.snapshot(api.baseUrl);
  assert.equal(seed.deviceRegistrations.length, 100); assert.equal(baseline.resources.intakeScans.length, 10_000);
  const states = Array.from({ length: contract.clients }, (_, client) => ({ device: seed.deviceRegistrations[client], sequence: 100, ordinal: 0, last: null, newCount: 0 }));
  const metrics = await closedLoop({ clients: contract.clients, warmupMs: contract.warmupSeconds * 1_000, measureMs: contract.measureSeconds * 1_000, betweenWindows: () => {
    for (const state of states) { state.ordinal = 0; state.last = null; }
  }, operation: async ({ client }) => {
    const state = states[client]; const position = state.ordinal++ % 10;
    if (position === 9) {
      assert.ok(state.last, "formal replay has no preceding batch");
      const response = await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", state.last.key, state.last.body, { timeoutMs: 10_000 });
      sameSemanticResponse(response, state.last.response); return response;
    }
    state.sequence += 1; state.newCount += 1;
    const body = {
      deviceId: state.device.deviceId, batchSequence: state.sequence,
      scans: Array.from({ length: contract.scansPerBatch }, (_, scan) => ({
        scanId: `perf-${client}-${state.sequence}-${scan}`, label: `PERF-LABEL-${client}-${state.sequence}-${scan}`,
        sealCode: `PERF-SEAL-${client}-${state.sequence}-${scan}`, scannedAt: ctx.at({ days: 2, seconds: state.sequence, milliseconds: scan }), facilityId: state.device.facilityId,
      })),
    };
    const key = ctx.key(`operate01-${client}-${state.sequence}`); const response = await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", key, body, { timeoutMs: 10_000 });
    assert.equal(response.status, 202, response.text); state.last = { body, key, response }; return response;
  }});
  assert.equal(metrics.unexpected5xx, 0); assert.ok(metrics.throughput >= contract.minimumThroughput, `throughput ${metrics.throughput} < ${contract.minimumThroughput}`); assert.ok(metrics.p95 <= contract.maximumP95Ms, `p95 ${metrics.p95} > ${contract.maximumP95Ms}`);
  const final = assertSnapshot(await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 })); const expectedNew = states.reduce((sum, state) => sum + state.newCount, 0) * contract.scansPerBatch;
  assert.equal(final.resources.intakeScans.length, 10_000 + expectedNew); for (const state of states) assert.equal(byId(final.resources.deviceRegistrations, "deviceId", state.device.deviceId).lastBatchSequence, state.sequence);
  return evidence(`formal scanner-batch-ingest ran 64 closed-loop clients for 10s warmup + 60s measured: ${metrics.throughput.toFixed(2)}/s, p95 ${metrics.p95.toFixed(2)}ms, 5xx 0`, `post-load snapshot contained exactly ${expectedNew} new scans; every replay, device sequence and atomic invariant reconciled`);
}

async function operate02(ctx) {
  const contract = performanceContract().timeline; const seed = formalFactory(ctx); const api = await prepare(ctx, seed); const itemIds = manifestItems(seed).map(({ collectedItemId }) => collectedItemId).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const before = canonicalDigest(stableSnapshot(await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 })));
  const metrics = await closedLoop({ clients: contract.clients, warmupMs: contract.warmupSeconds * 1_000, measureMs: contract.measureSeconds * 1_000, operation: async ({ index }) => {
    const itemId = itemIds[index % itemIds.length]; const body = await timeline(ctx, api, itemId);
    assert.equal(body.item.collectedItemId, itemId); return { status: 200 };
  }});
  assert.equal(metrics.unexpected5xx, 0); assert.ok(metrics.throughput >= contract.minimumThroughput, `throughput ${metrics.throughput} < ${contract.minimumThroughput}`); assert.ok(metrics.p95 <= contract.maximumP95Ms, `p95 ${metrics.p95} > ${contract.maximumP95Ms}`);
  const afterSnapshot = assertSnapshot(await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 })); assert.equal(canonicalDigest(stableSnapshot(afterSnapshot)), before, "timeline load mutated custody");
  for (const itemId of itemIds) assert.equal(afterSnapshot.resources.custodyTransfers.filter(({ collectedItemId }) => collectedItemId === itemId).length, 5);
  return evidence(`formal custody-timeline-read ran 64 closed-loop clients for 10s warmup + 60s measured: ${metrics.throughput.toFixed(2)}/s, p95 ${metrics.p95.toFixed(2)}ms, 5xx 0`, "all 10,000 items retained five-link custody chains and the full snapshot digest was unchanged");
}

async function operate03(ctx) {
  const contract = performanceContract().verification; const seed = formalFactory(ctx); const api = await prepare(ctx, seed); const before = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
  assert.equal(before.work.filter(({ kind, terminal }) => kind === "EVIDENCE_VERIFICATION" && !terminal).length, contract.items);
  const observedDigest = canonicalDigest(before.resources.intakeScans.map(({ intakeScanId, label, sealCode, deviceId, batchSequence, scannedAt }) => ({ intakeScanId, label, sealCode, deviceId, batchSequence, scannedAt })));
  let heldCount = 0; const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" && heldCount++ < contract.killedWorkers }); const env = { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 1 };
  const killed = await Promise.all(Array.from({ length: contract.killedWorkers }, () => ctx.startWorker({ env })));
  const entries = [];
  for (let index = 0; index < contract.killedWorkers; index += 1) entries.push(await barrier.waitFor((entry) => entry.json.point === "worker.claimed" && !entries.includes(entry), { timeoutMs: 20_000 }));
  assert.equal(new Set(entries.map(({ json }) => json.workId)).size, contract.killedWorkers); await Promise.all(killed.map((worker) => ctx.kill(worker)));
  const replacements = await Promise.all(Array.from({ length: contract.replacementWorkers }, () => ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } }))); const startedAt = performance.now();
  const final = await waitSnapshot(ctx, api, (snapshot) => snapshot.work.filter(({ kind }) => kind === "EVIDENCE_VERIFICATION").length === contract.items && snapshot.work.filter(({ kind, terminal }) => kind === "EVIDENCE_VERIFICATION" && !terminal).length === 0 && snapshot.resources.collectedItems.filter(({ state }) => state === "VERIFIED").length === contract.items, "ten-thousand verification drain", { timeoutMs: contract.maximumSeconds * 1_000, intervalMs: 100, processes: replacements });
  const elapsedSeconds = (performance.now() - startedAt) / 1_000; await Promise.all(replacements.map((worker) => ctx.stop(worker))); assert.ok(elapsedSeconds <= contract.maximumSeconds); assertSnapshot(final);
  assert.equal(canonicalDigest(final.resources.intakeScans.map(({ intakeScanId, label, sealCode, deviceId, batchSequence, scannedAt }) => ({ intakeScanId, label, sealCode, deviceId, batchSequence, scannedAt }))), observedDigest);
  assert.equal(final.resources.collectedItems.filter(({ state }) => state === "VERIFIED").length, 10_000); assert.equal(final.resources.collectedItems.filter(({ currentCustodianId }) => currentCustodianId !== null).length, 10_000);
  return evidence(`exactly two claimed workers were SIGKILLed and exactly two replacements drained 10,000 Work in ${elapsedSeconds.toFixed(2)}s`, "all Items verified once, every Work retained terminal, custody stayed exclusive and observed scan evidence was byte-stable");
}

async function operate04(ctx) {
  const seed = baseSeed(ctx.fixtures, { itemsPerCase: 1, custodianCount: 2 });
  const api = await prepare(ctx, seed); const batch = intakeBatch(ctx.fixtures, seed, { count: 1 }); const shield = await ctx.responseShield(api.baseUrl); shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, "/api/v1/intake-batches", ctx.key("operate04-batch"), batch).catch(() => undefined); await ctx.waitFor(() => shield.captures.some(({ dropped }) => dropped), { label: "current-system saved replay" });
  const dropped = shield.captures.find(({ dropped }) => dropped).response; const replayReference = { status: dropped.status, json: JSON.parse(dropped.body) };
  const replay = await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", ctx.key("operate04-batch"), clone(batch)); sameSemanticResponse(replay, replayReference);
  let snapshot = await ctx.snapshot(api.baseUrl); const item = snapshot.resources.collectedItems[0]; const scan = byId(snapshot.resources.intakeScans, "scanId", batch.scans[0].scanId);
  const match = (await proposeMatch(ctx, api, "operate04-propose", item.collectedItemId, scan.intakeScanId)).json;
  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match.matchId}/confirm`, ctx.key("operate04-confirm"), { expectedItemRevision: item.revision, expectedScanRevision: scan.revision });
  assert.equal(confirmed.status, 200);
  snapshot = await ctx.snapshot(api.baseUrl); let current = byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId);
  for (let ordinal = 0; ordinal < 50; ordinal += 1) {
    const destination = seed.custodians.find(c => c.custodianId !== current.currentCustodianId).custodianId;
    await transferItem(ctx, api, `operate04-transfer-${ordinal}`, item.collectedItemId, { fromCustodianId: current.currentCustodianId, toCustodianId: destination, occurredAt: ctx.at({ hours: 1, seconds: ordinal }) }); current = byId((await ctx.snapshot(api.baseUrl)).resources.collectedItems, "collectedItemId", item.collectedItemId);
  }
  const before = stableSnapshot(assertSnapshot(await ctx.snapshot(api.baseUrl)));
  assert.equal(before.resources.custodyTransfers.length, 50);
  assert.equal(before.work.filter(({ kind, terminal }) => kind === "EVIDENCE_VERIFICATION" && !terminal).length, 1);
  await ctx.kill(api);
  let finalApi = await ctx.startApi();
  assert.deepEqual(stableSnapshot(assertSnapshot(await ctx.snapshot(finalApi.baseUrl))), before, "API restart changed committed state");
  const finalReplay = await ctx.mutate(finalApi.baseUrl, "/api/v1/intake-batches", ctx.key("operate04-batch"), clone(batch)); sameSemanticResponse(finalReplay, replayReference);
  const worker = await ctx.startWorker();
  const recovered = await waitSnapshot(ctx, finalApi, value => value.work.every(w => w.terminal)
    && byId(value.resources.collectedItems, "collectedItemId", item.collectedItemId).state === "VERIFIED", "pending verification after restart", { processes: [worker] });
  await ctx.stop(worker);
  assert.deepEqual(recovered.resources.custodyTransfers, before.resources.custodyTransfers);
  assert.equal(byId(recovered.resources.collectedItems, "collectedItemId", item.collectedItemId).currentCustodianId, current.currentCustodianId);
  const stable = stableSnapshot(assertSnapshot(await ctx.snapshot(finalApi.baseUrl)));
  const replaySeed = await ctx.seed(seed, { timeoutMs: 300_000 }); assert.equal(replaySeed.exitCode, 0); assert.deepEqual(stableSnapshot(await ctx.snapshot(finalApi.baseUrl)), stable);
  const conflict = clone(seed); conflict.cases[0].caseNumber += "-conflict"; const conflictResult = await ctx.seed(conflict, { timeoutMs: 300_000, allowFailure: true }); assert.notEqual(conflictResult.exitCode, 0); assert.match(`${conflictResult.stdout}\n${conflictResult.stderr}`, /SEED_VERSION_CONFLICT/u);
  for (const invalid of invalidSeedFixtures(ctx.fixtures)) {
    const rejected = await ctx.seed(invalid.value, { timeoutMs: 300_000, allowFailure: true }); assert.notEqual(rejected.exitCode, 0, `${invalid.label} accepted`); assert.deepEqual(stableSnapshot(await ctx.snapshot(finalApi.baseUrl)), stable, `${invalid.label} partially imported`);
  }
  return evidence("fresh current-system Match, 50-transfer chain and saved response survived API SIGKILL and restart", "pending verification recovered without changing custody history; seed replays and rejections remained atomic");
}

export const OPERATE_CASES = Object.freeze([
  guardedCase("OPERATE-01", ["PARTIAL_BATCH_OR_GROUP", "DURABLE_IDEMPOTENCY"], operate01),
  guardedCase("OPERATE-02", [], operate02),
  guardedCase("OPERATE-03", ["OBSERVED_EVIDENCE_REWRITE", "STALE_VERIFICATION_COMMIT", "DOUBLE_MATCH_OR_OWNER"], operate03),
  guardedCase("OPERATE-04", ["MIGRATION_IDENTITY_REWRITE", "DURABLE_IDEMPOTENCY"], operate04),
]);
