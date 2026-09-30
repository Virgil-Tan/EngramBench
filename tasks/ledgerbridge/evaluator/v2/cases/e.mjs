import assert from "node:assert/strict";

import { performanceContract, performanceSeed } from "../lib/fixtures.mjs";
import { assertStatementPage, assertTransfer, canonical, compareUtf8, percentile, reconcileSnapshot } from "../lib/oracle.mjs";
import { EvaluationInfrastructureError } from "../lib/runtime.mjs";
import {
  defineCase,
  postingsFor,
  requireTransfer,
  snapshot,
  transferFrom,
  waitForTransfer,
  workFor,
} from "./helpers.mjs";

function perfScale() {
  const value = Number(process.env.BENCH_PERF_SCALE ?? "1");
  if (!(value > 0 && value <= 1)) throw new EvaluationInfrastructureError("EVALUATOR_INVALID_PERF_SCALE", "BENCH_PERF_SCALE must be in (0,1]");
  return value;
}

async function installPerfSeed(ctx, scale) {
  const seed = performanceSeed(ctx.fixtures, scale);
  await ctx.seed(seed, { timeoutMs: 1_800_000 });
  return seed;
}

async function closedLoop(durationSeconds, concurrency, operation) {
  const deadline = performance.now() + durationSeconds * 1_000;
  let ordinal = 0;
  const samples = [];
  await Promise.all(Array.from({ length: concurrency }, async (_, client) => {
    while (performance.now() < deadline) {
      const index = ordinal++;
      const result = await operation(index, client);
      samples.push(result);
    }
  }));
  return samples;
}

async function finiteLoad(durationSeconds, concurrency, schedule, operation) {
  const startedAt = performance.now();
  const deadline = startedAt + durationSeconds * 1_000;
  let next = 0;
  const samples = [];
  await Promise.all(Array.from({ length: concurrency }, async (_, client) => {
    while (performance.now() < deadline) {
      const index = next++;
      if (index >= schedule.length) break;
      samples.push(await operation(schedule[index], index, client));
    }
  }));
  const remaining = deadline - performance.now();
  if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
  return samples;
}

function legacyProjection(transfer) {
  return Object.fromEntries(Object.entries(transfer).filter(([key]) => key !== "legs"));
}

const E01 = defineCase(
  "E-01", "F-V1-FINAL populated ledger, pending Work, unacked Event and saved replay", "Run V1 migrations and public mutations, stop V1, migrate the same PostgreSQL database with FINAL, replay old requests and drain preserved Work", "Byte-compare saved IDs/timestamps/Postings/Statements/Events/replay bodies and require one logical leg without migration side effects",
  async (ctx) => {
    if (!ctx.v1Workspace) throw new EvaluationInfrastructureError("EVALUATOR_V1_WORKSPACE_REQUIRED", "E-01 requires --v1-workspace");
    const catalog = ctx.catalog({ sourceBalance: 1_000, destinationCount: 4 });
    const v1 = ctx.forWorkspace(ctx.v1Workspace);
    await v1.migrate();
    await ctx.seed(ctx.seedFor("v1-final-compat", { catalog }), { workspace: ctx.v1Workspace });
    const v1Api = await v1.startApi();
    const cancelBody = ctx.legacyBody(catalog, 20);
    const cancelKey = ctx.key("v1-cancel-create");
    const v1CancelledCreate = await ctx.createTransfer(v1Api.baseUrl, cancelBody, { key: cancelKey });
    ctx.equal("V1 create returns 202", v1CancelledCreate.status, 202);
    ctx.assert("V1 Transfer keeps exact legacy shape", () => assertTransfer(v1CancelledCreate.json, { final: false }));
    const cancelled = (await ctx.cancelTransfer(v1Api.baseUrl, v1CancelledCreate.json.transferId, { key: ctx.key("v1-cancel") })).json;

    const postedCreate = await ctx.createTransfer(v1Api.baseUrl, ctx.legacyBody(catalog, 30, { destinationAccountId: catalog.destinations[1].accountId }), { key: ctx.key("v1-posted") });
    const v1Worker = await v1.startWorker();
    await ctx.waitFor(async () => {
      const response = await ctx.getTransfer(v1Api.baseUrl, postedCreate.json.transferId);
      return response.json?.state === "POSTED" ? response.json : undefined;
    }, { label: "V1 posted Transfer", processes: [v1Worker] });
    const reversed = (await ctx.reverseTransfer(v1Api.baseUrl, postedCreate.json.transferId, { key: ctx.key("v1-reverse") })).json;
    await ctx.stop(v1Worker);

    const replayBody = ctx.legacyBody(catalog, 40, { destinationAccountId: catalog.destinations[2].accountId });
    const replayKey = ctx.key("saved-replay");
    const savedReplay = await ctx.createTransfer(v1Api.baseUrl, replayBody, { key: replayKey });
    const pending = await ctx.createTransfer(v1Api.baseUrl, ctx.legacyBody(catalog, 50, { destinationAccountId: catalog.destinations[3].accountId }), { key: ctx.key("v1-pending") });
    const v1Snapshot = await ctx.snapshot(v1Api.baseUrl);
    for (const transfer of v1Snapshot.resources.transfers) ctx.assert("V1 snapshot Transfer has exact V1 shape", () => assertTransfer(transfer, { final: false }));
    const savedWork = workFor(v1Snapshot, pending.json.transferId)[0];
    const savedStatements = {};
    for (const account of [catalog.source, ...catalog.destinations]) savedStatements[account.accountId] = (await ctx.getStatement(v1Api.baseUrl, account.accountId, "limit=100")).json;
    await ctx.stop(v1Api);

    await ctx.migrate();
    const finalApi = await ctx.startApi();
    const finalSnapshot = await ctx.snapshot(finalApi.baseUrl);
    ctx.equal("FINAL preserves all Account identities and values", canonical(finalSnapshot.resources.accounts), canonical(v1Snapshot.resources.accounts));
    ctx.equal("FINAL preserves immutable one-leg Postings", canonical(finalSnapshot.resources.postings), canonical(v1Snapshot.resources.postings));
    ctx.equal("FINAL preserves event identities, bodies and sequences", canonical(finalSnapshot.events), canonical(v1Snapshot.events));
    for (const oldTransfer of v1Snapshot.resources.transfers) {
      const upgraded = finalSnapshot.resources.transfers.find(({ transferId }) => transferId === oldTransfer.transferId);
      ctx.equal("FINAL preserves every legacy Transfer field", legacyProjection(upgraded), oldTransfer, { failureCodeSuffix: "MIGRATION_IDENTITY", hardCapIds: ["CORRECTNESS_INVARIANT"] });
      ctx.equal("FINAL logically upgrades one leg", upgraded.legs.length, 1);
      ctx.equal("upgraded leg matches legacy destination and amount", [upgraded.legs[0].destinationAccountId, upgraded.legs[0].amountMinor], [oldTransfer.destinationAccountId, oldTransfer.amountMinor]);
    }
    const replayed = await ctx.createTransfer(finalApi.baseUrl, replayBody, { key: replayKey });
    ctx.equal("saved V1 replay status is unchanged", replayed.status, savedReplay.status);
    ctx.equal("saved V1 replay body is byte-semantic unchanged", canonical(replayed.json), canonical(savedReplay.json), { failureCodeSuffix: "REPLAY_REWRITTEN", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    for (const account of [catalog.source, ...catalog.destinations]) ctx.equal("legacy Statement page is unchanged by migration", canonical((await ctx.getStatement(finalApi.baseUrl, account.accountId, "limit=100")).json), canonical(savedStatements[account.accountId]));
    const preservedWork = workFor(finalSnapshot, pending.json.transferId)[0];
    ctx.equal("pending Settlement Work identity and retry state survive", [preservedWork.workId, preservedWork.attempt, preservedWork.state], [savedWork.workId, savedWork.attempt, savedWork.state]);
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, finalApi.baseUrl, pending.json.transferId, "POSTED", { processes: [worker] });
    const final = await snapshot(ctx, finalApi.baseUrl);
    ctx.equal("preserved pending Work settles exactly once", postingsFor(final, pending.json.transferId).length, 1);
    return { evidence: [cancelled.transferId, reversed.transferId, pending.json.transferId, savedWork.workId] };
  },
);

const E02 = defineCase(
  "E-02", "Public perf-v1 seed with 20,000 Accounts and 102,000 Transfers", "Run the exact 64-client round-robin statement-read warm-up and 60-second measured closed loop against production HTTP", "Validate every complete StatementPage and enforce 150 responses/s, p95 150 ms, zero 5xx, cursor order and post-load ledger conservation",
  async (ctx) => {
    const scale = perfScale();
    const contract = performanceContract(scale).statementRead;
    await installPerfSeed(ctx, scale);
    const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
    const initial = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
    const accountIds = initial.resources.accounts.map(({ accountId }) => accountId).sort(compareUtf8);
    const exercise = async (index) => {
      const response = await ctx.getStatement(api.baseUrl, accountIds[index % accountIds.length], `limit=${contract.limit}`);
      if (response.status === 200) assertStatementPage(response.json);
      return { status: response.status, durationMs: response.durationMs };
    };
    await closedLoop(contract.warmupSeconds, contract.concurrency, exercise);
    const samples = await closedLoop(contract.measureSeconds, contract.concurrency, exercise);
    const success = samples.filter(({ status }) => status === 200);
    const throughput = success.length / contract.measureSeconds;
    const p95 = percentile(success.map(({ durationMs }) => durationMs), 0.95);
    ctx.metric("throughputPerSecond", throughput); ctx.metric("p95Ms", p95); ctx.metric("successfulResponses", success.length);
    ctx.ok("statement-read throughput reaches published target", throughput >= contract.targetPerSecond);
    ctx.ok("statement-read p95 meets published target", p95 <= contract.p95Ms);
    ctx.equal("statement-read unexpected 5xx is zero", samples.filter(({ status }) => status >= 500).length, 0);
    const final = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
    ctx.assert("statement-read post-load ledger reconciles", () => reconcileSnapshot(final), { failureCodeSuffix: "PERF_LEDGER_INVARIANT", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    return { evidence: [{ scale, throughput, p95, samples: samples.length }] };
  },
);

function mutationSchedule(accounts, pending, posted, blockStart, blockCount) {
  const schedule = [];
  for (let block = blockStart; block < blockStart + blockCount; block += 1) {
    schedule.push({ kind: "CREATE", sourceAccountId: accounts[block * 4].accountId, destinationAccountId: accounts[block * 4 + 1].accountId });
    schedule.push({ kind: "CREATE", sourceAccountId: accounts[block * 4 + 2].accountId, destinationAccountId: accounts[block * 4 + 3].accountId });
    schedule.push({ kind: "CANCEL", transferId: pending[block].transferId });
    schedule.push({ kind: "REVERSE", transferId: posted[block].transferId });
  }
  return schedule;
}

const E03 = defineCase(
  "E-03", "Public perf-v1 seed with disjoint warm-up/measured mutation pools", "Run exact CREATE, CREATE, CANCEL, REVERSE selection with 64 clients, fresh keys, ten-second warm-up and sixty-second measured window", "Count only published 2xx terminal bodies and enforce 40/s, p95 500 ms, zero unexpected conflicts/5xx and full post-load ledger reconciliation",
  async (ctx) => {
    const scale = perfScale();
    const contract = performanceContract(scale).mutationMix;
    await installPerfSeed(ctx, scale);
    const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
    const initial = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
    const accounts = [...initial.resources.accounts].sort((a, b) => compareUtf8(a.accountId, b.accountId));
    const pending = initial.resources.transfers.filter(({ state }) => state === "PENDING").sort((a, b) => compareUtf8(a.transferId, b.transferId));
    const posted = initial.resources.transfers.filter(({ state }) => state === "POSTED").sort((a, b) => compareUtf8(a.transferId, b.transferId));
    const warmBlocks = Math.max(1, Math.floor(pending.length / 5));
    const measureBlocks = pending.length - warmBlocks;
    const warm = mutationSchedule(accounts, pending, posted, 0, warmBlocks);
    const measured = mutationSchedule(accounts, pending, posted, warmBlocks, measureBlocks);
    const exercise = async (item, index) => {
      let response;
      if (item.kind === "CREATE") response = await ctx.createTransfer(api.baseUrl, { sourceAccountId: item.sourceAccountId, destinationAccountId: item.destinationAccountId, currency: "USD", amountMinor: 1 }, { key: ctx.key(`perf-create-${index}`) });
      else if (item.kind === "CANCEL") response = await ctx.cancelTransfer(api.baseUrl, item.transferId, { key: ctx.key(`perf-cancel-${index}`) });
      else response = await ctx.reverseTransfer(api.baseUrl, item.transferId, { key: ctx.key(`perf-reverse-${index}`), reason: "perf" });
      return { kind: item.kind, status: response.status, durationMs: response.durationMs };
    };
    await finiteLoad(contract.warmupSeconds, contract.concurrency, warm, exercise);
    const samples = await finiteLoad(contract.measureSeconds, contract.concurrency, measured, exercise);
    const success = samples.filter(({ kind, status }) => status === (kind === "CANCEL" ? 200 : 202));
    const throughput = success.length / contract.measureSeconds;
    const p95 = percentile(success.map(({ durationMs }) => durationMs), 0.95);
    ctx.metric("throughputPerSecond", throughput); ctx.metric("p95Ms", p95); ctx.metric("successfulMutations", success.length);
    ctx.ok("mutation mix throughput reaches published target", throughput >= contract.targetPerSecond);
    ctx.ok("mutation mix p95 meets published target", p95 <= contract.p95Ms);
    ctx.equal("mutation mix has no unexpected conflicts", samples.filter(({ status }) => status === 409).length, 0);
    ctx.equal("mutation mix has no unexpected 5xx", samples.filter(({ status }) => status >= 500).length, 0);
    const final = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
    ctx.assert("mutation mix post-load ledger reconciles", () => reconcileSnapshot(final), { failureCodeSuffix: "PERF_LEDGER_INVARIANT", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    return { evidence: [{ scale, throughput, p95, samples: samples.length, order: contract.order }] };
  },
);

const E04 = defineCase(
  "E-04", "Public perf-v1 2,000 pending Settlement Tasks", "Start two workers, hold both at worker.claimed, SIGKILL, wait for both leases, then time two replacement workers until one snapshot proves drain", "Enforce 45 seconds, exactly one Posting per pending Transfer, no nonterminal Work/stale commit/unexpected worker failure, conservation and contiguous Events",
  async (ctx) => {
    const scale = perfScale();
    const contract = performanceContract(scale).settlementRecovery;
    const seed = await installPerfSeed(ctx, scale);
    const pendingIds = seed.transfers.filter(({ state }) => state === "PENDING").map(({ transferId }) => transferId);
    ctx.equal("settlement recovery seed has exact pending count", pendingIds.length, contract.transferCount);
    const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
    let heldCount = 0;
    const barrier = await ctx.workerBarrier("worker.claimed", ({ aggregateId }) => pendingIds.includes(aggregateId) && heldCount++ < 2);
    const staleWorkers = [await ctx.startWorkerAtBarrier(barrier), await ctx.startWorkerAtBarrier(barrier)];
    await ctx.waitFor(() => barrier.ledger.length >= 2 ? barrier.ledger.slice(0, 2) : undefined, { timeoutMs: 60_000, label: "both performance workers claimed", processes: staleWorkers });
    await Promise.all(staleWorkers.map((worker) => ctx.kill(worker)));
    await ctx.sleep(3_200);
    const startedAt = performance.now();
    const replacements = [await ctx.startWorker(), await ctx.startWorker()];
    const drained = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
      return value.work.length >= pendingIds.length && !value.work.some(({ terminal }) => !terminal) ? value : undefined;
    }, { timeoutMs: contract.maximumSeconds * 1_000, intervalMs: 250, label: "two-thousand Settlement drain", processes: replacements });
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    ctx.metric("drainSeconds", elapsedSeconds); ctx.metric("transferCount", pendingIds.length);
    ctx.ok("replacement drain meets published 45-second gate", elapsedSeconds <= contract.maximumSeconds);
    ctx.assert("settlement recovery post-load ledger reconciles", () => reconcileSnapshot(drained), { failureCodeSuffix: "PERF_LEDGER_INVARIANT", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    for (const transferId of pendingIds) {
      ctx.equal("performance pending Transfer posts exactly once", transferFrom(drained, transferId).state, "POSTED");
      ctx.equal("performance pending Transfer has exactly one Posting", postingsFor(drained, transferId).length, 1, { failureCodeSuffix: "PERF_DUPLICATE_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    }
    ctx.equal("performance backlog has no nonterminal Work", drained.work.filter(({ terminal }) => !terminal).length, 0);
    return { evidence: [{ scale, elapsedSeconds, transferCount: pendingIds.length }] };
  },
);

export const E_CASES = [E01, E02, E03, E04];
