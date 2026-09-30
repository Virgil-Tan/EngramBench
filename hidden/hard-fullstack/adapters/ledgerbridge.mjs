import assert from "node:assert/strict";

import { measuredLoad, performanceScale } from "../performance-runtime.mjs";
import { standardAdapter } from "../standard-adapter.mjs";

const ids = {
  source: "10000000-0000-4000-8000-000000000001",
  destinations: Array.from(
    { length: 20 },
    (_, index) => `10000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
  ),
};
const openingBalance = 1_000_000_000;

const spec = {
  label: "LedgerBridge transfer",
  performanceScenarioIds: ["statement-read", "transfer-mutation-mix", "settlement-recovery"],
  seed: async () => seed(),
  path: "/api/v1/transfers",
  payload: (index) => legacyPayload(index),
  perfPayload: (index) => legacyPayload(index, 1),
  conflictPayload: (index) => ({ ...legacyPayload(index), amountMinor: index + 2 }),
  resource: "transfers",
  identity: (value) => transferOf(value)?.transferId,
  workIdentity: (value) => transferOf(value)?.transferId,
  resourceIdentity: ({ transferId }) => transferId,
  minimumThroughput: 40,
  maximumP95Ms: 500,
  performance: sustainedPerformance,
  cases: {
    "H-03": mainFlow,
    "H-04": atomicRejection,
    "H-06": multiProcessContention,
    "H-09": v1Migration,
    "H-10": multiLegBehavior,
    "H-11": multiLegRecovery,
  },
};

export default standardAdapter(spec);

function seed() {
  return {
    schemaVersion: 1,
    seedVersion: "hidden-ledgerbridge-v1",
    accounts: [
      { accountId: ids.source, currency: "USD", openingBalanceMinor: openingBalance },
      ...ids.destinations.map((accountId) => ({ accountId, currency: "USD", openingBalanceMinor: 0 })),
    ],
    transfers: [],
  };
}

function legacyPayload(index = 0, amountMinor = index + 1) {
  return {
    sourceAccountId: ids.source,
    destinationAccountId: ids.destinations[index % ids.destinations.length],
    currency: "USD",
    amountMinor,
  };
}

function multiLegPayload(amounts = [11, 17, 23]) {
  return {
    sourceAccountId: ids.source,
    currency: "USD",
    legs: amounts.map((amountMinor, index) => ({
      destinationAccountId: ids.destinations[index],
      amountMinor,
    })),
  };
}

function transferOf(value) {
  return value?.transfer ?? value;
}

function withoutAsOf(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

async function setup(ctx, workspace = ctx.workspace) {
  await ctx.prepare(workspace);
  const imported = await ctx.seed(seed(), workspace);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return ctx.startApi(workspace);
}

async function createTransfer(ctx, baseUrl, key, payload = legacyPayload()) {
  const response = await ctx.mutate(baseUrl, "/api/v1/transfers", key, payload);
  assert.equal(response.status, 202, response.text);
  const transfer = transferOf(response.json);
  assert.equal(transfer.state, "PENDING");
  return { response, transfer, payload };
}

async function waitForTransfer(ctx, baseUrl, transferId, state, children = []) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return snapshot.resources.transfers.find((item) => item.transferId === transferId)?.state === state
      ? snapshot
      : undefined;
  }, { timeoutMs: 60_000, label: `Transfer ${transferId} to become ${state}`, children });
}

function account(snapshot, accountId) {
  const value = snapshot.resources.accounts.find((item) => item.accountId === accountId);
  assert.ok(value, `snapshot is missing Account ${accountId}`);
  return value;
}

async function mainFlow(ctx, assertions) {
  const api = await setup(ctx);
  const amountMinor = 137;
  const { transfer } = await createTransfer(ctx, api.baseUrl, "h03-create", legacyPayload(0, amountMinor));
  const pending = await ctx.snapshot(api.baseUrl);
  assert.equal(account(pending, ids.source).reservedMinor, amountMinor);
  assert.equal(account(pending, ids.source).availableMinor, openingBalance - amountMinor);

  const worker = await ctx.startWorker();
  const posted = await waitForTransfer(ctx, api.baseUrl, transfer.transferId, "POSTED", [worker]);
  const posting = posted.resources.postings.find((item) => item.transferId === transfer.transferId && item.kind === "TRANSFER");
  assert.deepEqual(posting.legs.map(({ accountId, direction, amountMinor: amount }) => ({ accountId, direction, amount })), [
    { accountId: ids.source, direction: "DEBIT", amount: amountMinor },
    { accountId: ids.destinations[0], direction: "CREDIT", amount: amountMinor },
  ]);
  assert.equal(account(posted, ids.source).balanceMinor, openingBalance - amountMinor);
  assert.equal(account(posted, ids.source).reservedMinor, 0);
  assert.equal(account(posted, ids.destinations[0]).balanceMinor, amountMinor);

  const statement = await ctx.request(api.baseUrl, `/api/v1/accounts/${ids.source}/statement?limit=50`);
  assert.equal(statement.status, 200, statement.text);
  assert.equal(statement.json.items.some((item) => item.transferId === transfer.transferId && item.direction === "DEBIT"), true);
  const events = posted.events.filter(({ aggregateId }) => aggregateId === transfer.transferId);
  assert.deepEqual(events.map(({ type }) => type), ["transfer.created", "transfer.posted"]);
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2]);
  assertions.push("V1 reservation, balanced posting, statements, work, and events agree end to end");
}

async function atomicRejection(ctx, assertions) {
  const api = await setup(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const invalid = await ctx.mutate(api.baseUrl, "/api/v1/transfers", "h04-invalid", legacyPayload(0, 0));
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(invalid.json?.error?.code, "INVALID_AMOUNT");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));

  const insufficient = await ctx.mutate(api.baseUrl, "/api/v1/transfers", "h04-insufficient", legacyPayload(0, openingBalance + 1));
  assert.equal(insufficient.status, 409, insufficient.text);
  assert.equal(insufficient.json?.error?.code, "INSUFFICIENT_FUNDS");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));
  assertions.push("invalid amounts and insufficient funds leave accounts, transfers, work, and events unchanged");
}

async function multiProcessContention(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const payload = legacyPayload(0, openingBalance);
  const results = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/transfers",
    `h06-${index}`,
    payload,
  ));
  assert.equal(results.filter(({ status }) => status === 202).length, 1);
  assert.equal(results.filter(({ status, json }) => status === 409 && json?.error?.code === "INSUFFICIENT_FUNDS").length, 31);

  const pending = await ctx.snapshot(apiB.baseUrl);
  assert.equal(pending.resources.transfers.length, 1);
  assert.equal(account(pending, ids.source).reservedMinor, openingBalance);
  assert.equal(account(pending, ids.source).availableMinor, 0);
  const transferId = pending.resources.transfers[0].transferId;
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const posted = await waitForTransfer(ctx, apiA.baseUrl, transferId, "POSTED", workers);
  assert.equal(posted.resources.postings.filter((item) => item.transferId === transferId).length, 1);
  assert.equal(account(posted, ids.source).balanceMinor, 0);
  assert.equal(account(posted, ids.source).reservedMinor, 0);
  assertions.push("two APIs and two workers admit one fully funded Transfer without overspending or duplicate posting");
}

async function v1Migration(ctx, assertions) {
  const v1Workspace = await ctx.copyV1Workspace();
  const v1Api = await setup(ctx, v1Workspace);
  const created = await createTransfer(ctx, v1Api.baseUrl, "h09-saved", legacyPayload(1, 73));
  const before = await ctx.snapshot(v1Api.baseUrl);
  const beforeWork = before.work.find(({ aggregateId }) => aggregateId === created.transfer.transferId);
  const beforeEvents = before.events.filter(({ aggregateId }) => aggregateId === created.transfer.transferId);
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/transfers", "h09-saved", created.payload);
  assert.equal(replay.status, created.response.status);
  assert.equal(replay.text, created.response.text);
  const migrated = await ctx.snapshot(finalApi.baseUrl);
  const transfer = migrated.resources.transfers.find(({ transferId }) => transferId === created.transfer.transferId);
  assert.equal(transfer.destinationAccountId, created.payload.destinationAccountId);
  assert.equal(transfer.amountMinor, created.payload.amountMinor);
  assert.equal(transfer.legs.length, 1);
  assert.equal(transfer.legs[0].destinationAccountId, created.payload.destinationAccountId);
  assert.equal(transfer.legs[0].amountMinor, created.payload.amountMinor);
  assert.deepEqual(migrated.work.find(({ aggregateId }) => aggregateId === transfer.transferId), beforeWork);
  assert.deepEqual(migrated.events.filter(({ aggregateId }) => aggregateId === transfer.transferId), beforeEvents);

  const worker = await ctx.startWorker();
  await waitForTransfer(ctx, finalApi.baseUrl, transfer.transferId, "POSTED", [worker]);
  assertions.push("V1 replay bytes, one-leg migration, pending Settlement Work, and event identity survive FINAL migration");
}

async function multiLegBehavior(ctx, assertions) {
  const api = await setup(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const duplicate = await ctx.mutate(api.baseUrl, "/api/v1/transfers", "h10-duplicate", {
    sourceAccountId: ids.source,
    currency: "USD",
    legs: [
      { destinationAccountId: ids.destinations[0], amountMinor: 1 },
      { destinationAccountId: ids.destinations[0], amountMinor: 2 },
    ],
  });
  assert.equal(duplicate.status, 400, duplicate.text);
  assert.equal(duplicate.json?.error?.code, "DUPLICATE_DESTINATION_ACCOUNT");
  const overflow = await ctx.mutate(api.baseUrl, "/api/v1/transfers", "h10-overflow", {
    sourceAccountId: ids.source,
    currency: "USD",
    legs: [
      { destinationAccountId: ids.destinations[0], amountMinor: Number.MAX_SAFE_INTEGER },
      { destinationAccountId: ids.destinations[1], amountMinor: 1 },
    ],
  });
  assert.equal(overflow.status, 400, overflow.text);
  assert.equal(overflow.json?.error?.code, "INVALID_MULTI_LEG_AMOUNT");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));

  const payload = multiLegPayload();
  const total = payload.legs.reduce((sum, { amountMinor }) => sum + amountMinor, 0);
  const { transfer } = await createTransfer(ctx, api.baseUrl, "h10-multi", payload);
  assert.equal(transfer.destinationAccountId, null);
  assert.equal(transfer.amountMinor, null);
  assert.deepEqual(transfer.legs.map(({ destinationAccountId, amountMinor }) => ({ destinationAccountId, amountMinor })), payload.legs);
  assert.equal(new Set(transfer.legs.map(({ legId }) => legId)).size, payload.legs.length);
  assert.equal(account(await ctx.snapshot(api.baseUrl), ids.source).reservedMinor, total);

  const worker = await ctx.startWorker();
  const posted = await waitForTransfer(ctx, api.baseUrl, transfer.transferId, "POSTED", [worker]);
  const stored = posted.resources.transfers.find(({ transferId }) => transferId === transfer.transferId);
  const posting = posted.resources.postings.find((item) => item.transferId === transfer.transferId && item.kind === "TRANSFER");
  assert.deepEqual(posting.legs.map(({ accountId, direction, amountMinor, legId }) => ({ accountId, direction, amountMinor, legId })), [
    { accountId: ids.source, direction: "DEBIT", amountMinor: total, legId: null },
    ...stored.legs.map(({ destinationAccountId, amountMinor, legId }) => ({ accountId: destinationAccountId, direction: "CREDIT", amountMinor, legId })),
  ]);
  assert.deepEqual(stored.legs.map(({ postingLegId }) => postingLegId), posting.legs.slice(1).map(({ postingLegId }) => postingLegId));

  const reversedResponse = await ctx.mutate(api.baseUrl, `/api/v1/transfers/${transfer.transferId}/reverse`, "h10-reverse", { reason: "Harness verification" });
  assert.equal(reversedResponse.status, 202, reversedResponse.text);
  const reversed = await ctx.snapshot(api.baseUrl);
  const reversal = reversed.resources.postings.find((item) => item.transferId === transfer.transferId && item.kind === "REVERSAL");
  assert.deepEqual(reversal.legs.map(({ accountId, direction, amountMinor, legId }) => ({ accountId, direction, amountMinor, legId })), [
    ...stored.legs.map(({ destinationAccountId, amountMinor, legId }) => ({ accountId: destinationAccountId, direction: "DEBIT", amountMinor, legId })),
    { accountId: ids.source, direction: "CREDIT", amountMinor: total, legId: null },
  ]);
  assert.equal(account(reversed, ids.source).balanceMinor, openingBalance);
  assert.equal(payload.legs.every(({ destinationAccountId }) => account(reversed, destinationAccountId).balanceMinor === 0), true);
  const events = reversed.events.filter(({ aggregateId }) => aggregateId === transfer.transferId);
  assert.deepEqual(events.map(({ type }) => type), ["transfer.created", "transfer.posted", "transfer.reversed"]);
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3]);
  assertions.push("multi-leg reservation, posting order, stable leg identity, and full reversal remain atomic and balanced");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function multiLegRecovery(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const payload = multiLegPayload([openingBalance - 1, 1]);
  const results = await ctx.concurrent(Array.from({ length: 24 }), 24, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/transfers",
    `h11-${index}`,
    payload,
  ));
  assert.equal(results.filter(({ status }) => status === 202).length, 1);
  assert.equal(results.filter(({ status, json }) => status === 409 && json?.error?.code === "MULTI_LEG_INSUFFICIENT_FUNDS").length, 23);
  const transferId = transferOf(results.find(({ status }) => status === 202).json).transferId;

  const held = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.before-commit" ? held.promise : { status: 204 });
  const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h11-ledger" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.before-commit" && entry.json?.aggregateId === transferId), {
    timeoutMs: 30_000,
    label: "multi-leg worker before-commit barrier",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  held.resolve({ status: 204 });
  const replacement = await ctx.startWorker();
  const posted = await waitForTransfer(ctx, apiB.baseUrl, transferId, "POSTED", [replacement]);
  const posting = posted.resources.postings.filter((item) => item.transferId === transferId && item.kind === "TRANSFER");
  assert.equal(posting.length, 1);
  assert.equal(posting[0].legs.length, 3);
  assert.equal(account(posted, ids.source).balanceMinor, 0);
  assert.equal(account(posted, ids.source).reservedMinor, 0);
  assert.equal(posted.work.filter(({ aggregateId, terminal }) => aggregateId === transferId && !terminal).length, 0);
  assertions.push("multi-leg funds contention and before-commit SIGKILL recover to one complete posting without partial legs");
}

async function sustainedPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];

  const statementRead = await ledgerPerformanceDatabase(ctx, async ({ apiA, apiB, accountIds }) => {
    let sequence = 0;
    return measuredLoad(ctx, {
      concurrency: 64,
      warmupMs: 10_000 * scale,
      measureMs: 60_000 * scale,
      request: async () => {
        const ordinal = sequence++;
        const response = await ctx.request(
          ordinal % 2 ? apiA.baseUrl : apiB.baseUrl,
          `/api/v1/accounts/${accountIds[ordinal % accountIds.length]}/statement?limit=50`,
        );
        assert.equal(response.status, 200, response.text);
        assert.ok(Array.isArray(response.json?.items));
        for (let index = 1; index < response.json.items.length; index += 1) {
          const before = response.json.items[index - 1];
          const after = response.json.items[index];
          assert.ok(before.createdAt < after.createdAt || (before.createdAt === after.createdAt && before.postingId < after.postingId));
        }
        return response;
      },
    });
  });
  assert.ok(statementRead.throughput >= 150, `statement-read throughput ${statementRead.throughput.toFixed(1)} < 150/s`);
  assert.ok(statementRead.p95 <= 150, `statement-read p95 ${statementRead.p95.toFixed(1)}ms > 150ms`);
  assert.equal(statementRead.statuses[500] ?? 0, 0);
  metrics.push({ scenarioId: "statement-read", ...statementRead });
  assertions.push(`statement-read: ${statementRead.throughput.toFixed(1)}/s, p95 ${statementRead.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const mutationMix = await ledgerPerformanceDatabase(ctx, async ({ apiA, apiB, accountIds, postedIds, pendingIds }) => {
    const ordinals = { warmup: 0, measured: 0 };
    const gates = { warmup: rateGate(45), measured: rateGate(45) };
    const result = await measuredLoad(ctx, {
      concurrency: 64,
      warmupMs: 10_000 * scale,
      measureMs: 60_000 * scale,
      request: async ({ measured }) => {
        const phase = measured ? "measured" : "warmup";
        await gates[phase]();
        const ordinal = ordinals[phase]++;
        const poolOffset = measured ? 500 : 0;
        const accountOffset = measured ? 5_000 : 0;
        const operation = ordinal % 4;
        const api = ordinal % 2 ? apiA : apiB;
        let response;
        if (operation < 2) {
          response = await ctx.mutate(api.baseUrl, "/api/v1/transfers", `perf-${phase}-create-${ordinal}`, {
            sourceAccountId: accountIds[(accountOffset + ordinal * 2) % accountIds.length],
            destinationAccountId: accountIds[(accountOffset + ordinal * 2 + 1) % accountIds.length],
            currency: "USD",
            amountMinor: 1,
          });
        } else {
          const index = poolOffset + Math.floor(ordinal / 4);
          const transferId = operation === 2 ? pendingIds[index] : postedIds[index];
          assert.ok(transferId, `${phase} mutation pool exhausted at ${index}`);
          response = await ctx.mutate(
            api.baseUrl,
            `/api/v1/transfers/${transferId}/${operation === 2 ? "cancel" : "reverse"}`,
            `perf-${phase}-${operation === 2 ? "cancel" : "reverse"}-${ordinal}`,
            operation === 2 ? {} : { reason: "perf" },
          );
        }
        assert.ok(response.status >= 200 && response.status < 300, response.text);
        return response;
      },
    });
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    verifyLedgerSnapshot(snapshot, accountIds.length * openingBalance);
    return result;
  });
  assert.ok(mutationMix.throughput >= 40, `transfer-mutation-mix throughput ${mutationMix.throughput.toFixed(1)} < 40/s`);
  assert.ok(mutationMix.p95 <= 500, `transfer-mutation-mix p95 ${mutationMix.p95.toFixed(1)}ms > 500ms`);
  assert.equal(mutationMix.statuses[500] ?? 0, 0);
  metrics.push({ scenarioId: "transfer-mutation-mix", ...mutationMix });
  assertions.push(`transfer-mutation-mix: ${mutationMix.throughput.toFixed(1)}/s, p95 ${mutationMix.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const recovery = await ledgerPerformanceDatabase(ctx, async ({ apiA, pendingIds }) => {
    const pendingSet = new Set(pendingIds);
    const held = deferred();
    const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held.promise : { status: 204 });
    const killed = [
      await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-ledger" }),
      await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-ledger" }),
    ];
    await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, {
      timeoutMs: 30_000,
      label: "two claimed Settlement Tasks",
      children: killed,
    });
    await Promise.all(killed.map((worker) => ctx.stop(worker, "SIGKILL")));
    held.resolve({ status: 204 });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const startedAt = Date.now();
    const replacements = [await ctx.startWorker(), await ctx.startWorker()];
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(apiA.baseUrl);
      return value.work.some(({ kind, terminal }) => kind === "SETTLEMENT" && !terminal) ? undefined : value;
    }, { timeoutMs: 45_000, label: "2,000 Settlement Tasks to drain", children: replacements });
    const durationMs = Date.now() - startedAt;
    assert.ok(durationMs <= 45_000, `settlement-recovery took ${durationMs}ms`);
    assert.equal(snapshot.resources.transfers.filter(({ transferId, state }) => pendingSet.has(transferId) && state === "POSTED").length, pendingIds.length);
    verifyLedgerSnapshot(snapshot, 20_000 * openingBalance);
    return { completed: pendingIds.length, durationMs, killedWorkers: 2, replacementWorkers: 2 };
  });
  metrics.push({ scenarioId: "settlement-recovery", ...recovery });
  assertions.push(`settlement-recovery: ${recovery.completed} tasks drained in ${recovery.durationMs}ms after two SIGKILLs`);
  return { metrics, fixtureSummary: { accounts: 20_000, transfers: 102_000, postedTransfers: 100_000, pendingTransfers: 2_000 } };
}

function rateGate(ratePerSecond) {
  let nextAt = Date.now();
  return async () => {
    const scheduledAt = nextAt;
    nextAt += 1_000 / ratePerSecond;
    const delayMs = scheduledAt - Date.now();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  };
}

function perfUuid(namespace, ordinal) {
  return `${String(namespace).padStart(8, "0")}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function performanceSeed() {
  const accounts = Array.from({ length: 20_000 }, (_, index) => ({
    accountId: perfUuid(1, index),
    currency: "USD",
    openingBalanceMinor: openingBalance,
  }));
  const posted = Array.from({ length: 100_000 }, (_, index) => ({
    transferId: perfUuid(2, index),
    sourceAccountId: accounts[index % accounts.length].accountId,
    destinationAccountId: accounts[(index + 1) % accounts.length].accountId,
    currency: "USD",
    amountMinor: 1,
    state: "POSTED",
    createdAt: "2026-01-01T00:00:00.000Z",
    terminalAt: "2026-01-01T00:00:01.000Z",
  }));
  const pending = Array.from({ length: 2_000 }, (_, index) => ({
    transferId: perfUuid(3, index),
    sourceAccountId: accounts[index].accountId,
    destinationAccountId: accounts[index + 10_000].accountId,
    currency: "USD",
    amountMinor: 1,
    state: "PENDING",
    createdAt: "2026-01-02T00:00:00.000Z",
    terminalAt: null,
  }));
  return { schemaVersion: 1, seedVersion: "perf-v1", accounts, transfers: [...posted, ...pending] };
}

async function ledgerPerformanceDatabase(ctx, operation) {
  await ctx.prepare();
  const data = performanceSeed();
  const imported = await ctx.seed(data);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  return operation({
    apiA,
    apiB,
    accountIds: data.accounts.map(({ accountId }) => accountId),
    postedIds: data.transfers.slice(0, 100_000).map(({ transferId }) => transferId),
    pendingIds: data.transfers.slice(100_000).map(({ transferId }) => transferId),
  });
}

function verifyLedgerSnapshot(snapshot, expectedBalance) {
  assert.equal(snapshot.resources.accounts.reduce((sum, { balanceMinor }) => sum + balanceMinor, 0), expectedBalance);
  const pendingBySource = new Map();
  for (const transfer of snapshot.resources.transfers) {
    if (transfer.state === "PENDING") {
      pendingBySource.set(transfer.sourceAccountId, (pendingBySource.get(transfer.sourceAccountId) ?? 0) + transfer.amountMinor);
    }
  }
  for (const value of snapshot.resources.accounts) {
    assert.equal(value.reservedMinor, pendingBySource.get(value.accountId) ?? 0);
    assert.equal(value.availableMinor, value.balanceMinor - value.reservedMinor);
    assert.ok(value.balanceMinor >= 0 && value.reservedMinor >= 0 && value.availableMinor >= 0);
  }
}
