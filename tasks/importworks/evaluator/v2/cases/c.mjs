import assert from "node:assert/strict";

import { ndjsonBytes, rowFixture } from "../lib/fixtures.mjs";
import { assertImportJob, canonical, modelNdjson } from "../lib/oracle.mjs";
import {
  CORRECTNESS_CAP,
  allFindings,
  allRecords,
  assertEventSequences,
  assertModeledFindings,
  assertNoSensitiveMaterial,
  assertReport,
  assertUnique,
  createUploadedImport,
  createValidatedImport,
  defineCase,
  eventsOf,
  expectBundle,
  expectBundleMember,
  expectError,
  expectImport,
  jobResource,
  resource,
  result,
  startScenario,
  waitForBundle,
  waitForImport,
  waitForReport,
  workOf,
} from "./helpers.mjs";

async function leasedWork(ctx, baseUrl, aggregateId, kind) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const work = workOf(snapshot).find((item) => item.aggregateId === aggregateId && item.kind === kind && item.state === "LEASED");
    return work ? { work, snapshot } : undefined;
  }, { timeoutMs: 30_000, intervalMs: 25, label: `${kind} Work to be publicly LEASED` });
}

function assertRecoveredWork(snapshot, aggregateId, kind) {
  const matching = workOf(snapshot).filter((item) => item.aggregateId === aggregateId && item.kind === kind);
  assert.equal(matching.length, 1, `${kind} must have one durable identity`);
  assert.equal(matching[0].state, "SUCCEEDED");
  assert.equal(matching[0].terminal, true);
  assert.ok(matching[0].attempt >= 2, `${kind} recovery must increment attempt`);
  assert.equal(matching[0].leaseOwner, null);
  assert.equal(matching[0].leaseExpiresAt, null);
}

async function c01(ctx) {
  const catalog = ctx.catalog("validation-recovery");
  const { api } = await startScenario(ctx, { catalogs: catalog });
  const bytes = ndjsonBytes([
    rowFixture(1, { externalId: "recover-valid" }),
    rowFixture(2, { externalId: "recover-bad", age: "bad" }),
  ]);
  const model = modelNdjson(bytes, catalog.revision);

  const killed = await createUploadedImport(ctx, api.baseUrl, catalog, bytes, { label: "killed validation" });
  const killedBarrier = await ctx.claimedBarrier();
  const killedWorker = await ctx.startWorkerAtBarrier(killedBarrier);
  const killedClaim = await killedBarrier.waitFor((entry) => !entry.released, { processes: [killedWorker] });
  const killedLease = await leasedWork(ctx, api.baseUrl, killed.job.importId, "IMPORT_VALIDATE");
  ctx.equal("barrier reached only the published claimed point", killedClaim.json.point, "worker.claimed");
  await ctx.kill(killedWorker);
  await ctx.sleep(3_250);
  const replacement = await ctx.startWorker();
  const recovered = await waitForImport(ctx, api.baseUrl, killed.job.importId, "VALIDATED", { processes: [replacement] });
  ctx.assert("replacement uses the same immutable bytes and schema", () => assertImportJob(jobResource(recovered), {
    schemaRevision: catalog.revision.revision,
    expectedSha256: ctx.sha256(bytes),
    totalRows: model.rows.length,
    validRows: model.validRows.length,
    invalidRows: model.invalidRows.length,
  }), CORRECTNESS_CAP);
  const killedFindings = await allFindings(ctx, api.baseUrl, killed.job.importId);
  ctx.assert("recovered findings exactly match the independent model", () => assertModeledFindings(killedFindings, model), CORRECTNESS_CAP);
  await waitForReport(ctx, api.baseUrl, killed.job.importId, ["READY"], { processes: [replacement] });
  await ctx.stop(replacement);

  const stale = await createUploadedImport(ctx, api.baseUrl, catalog, bytes, { label: "stale validation" });
  const staleBarrier = await ctx.claimedBarrier();
  const staleWorker = await ctx.startWorkerAtBarrier(staleBarrier);
  const staleClaim = await staleBarrier.waitFor((entry) => !entry.released, { processes: [staleWorker] });
  await leasedWork(ctx, api.baseUrl, stale.job.importId, "IMPORT_VALIDATE");
  await ctx.sleep(3_250);
  const fencingReplacement = await ctx.startWorker();
  await waitForImport(ctx, api.baseUrl, stale.job.importId, "VALIDATED", { processes: [fencingReplacement] });
  staleBarrier.release(staleClaim);
  await ctx.sleep(250);
  const staleFindings = await allFindings(ctx, api.baseUrl, stale.job.importId);
  ctx.assert("released stale worker cannot duplicate findings", () => assertModeledFindings(staleFindings, model), CORRECTNESS_CAP);
  const snapshot = await ctx.snapshot(api.baseUrl);
  ctx.assert("SIGKILL recovery drains one fenced validation Work", () => assertRecoveredWork(snapshot, killed.job.importId, "IMPORT_VALIDATE"), CORRECTNESS_CAP);
  ctx.assert("lease-expiry takeover drains one fenced validation Work", () => assertRecoveredWork(snapshot, stale.job.importId, "IMPORT_VALIDATE"), CORRECTNESS_CAP);
  ctx.equal("each recovered aggregate has one validated event identity", eventsOf(snapshot).filter(({ aggregateId, type }) => [killed.job.importId, stale.job.importId].includes(aggregateId) && type === "import.validated").length, 2, CORRECTNESS_CAP);
  ctx.blocked("validate-effect-commit-window", "IW-GAP-03");
  return result(ctx, "claimed IMPORT_VALIDATE survived SIGKILL and a released stale lease without duplicate findings or events");
}

async function c02(ctx) {
  const catalog = ctx.catalog("commit-report-recovery");
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 1 });
  const validBytes = ndjsonBytes([rowFixture(1, { externalId: "recover-commit" })]);
  const valid = await createValidatedImport(ctx, api.baseUrl, catalog, validBytes, { label: "commit recovery", processes: workers });
  await ctx.stop(workers[0]);
  expectImport(ctx, await ctx.commitImport(api.baseUrl, valid.job.importId), { importId: valid.job.importId }, "enqueue recoverable commit");
  const commitBarrier = await ctx.claimedBarrier();
  const commitWorker = await ctx.startWorkerAtBarrier(commitBarrier);
  const commitClaim = await commitBarrier.waitFor((entry) => !entry.released, { processes: [commitWorker] });
  const commitLease = await leasedWork(ctx, api.baseUrl, valid.job.importId, "IMPORT_COMMIT");
  ctx.equal("commit barrier reached only the published claimed point", commitClaim.json.point, "worker.claimed");
  await ctx.kill(commitWorker);
  await ctx.sleep(3_250);
  const commitReplacement = await ctx.startWorker();
  await waitForImport(ctx, api.baseUrl, valid.job.importId, "COMMITTED", { processes: [commitReplacement] });
  const committedRecords = await allRecords(ctx, api.baseUrl, catalog.tenant.tenantId, catalog.schema.datasetKey);
  ctx.equal("recovered commit publishes one record", committedRecords.filter(({ sourceImportId }) => sourceImportId === valid.job.importId).length, 1, CORRECTNESS_CAP);
  await ctx.stop(commitReplacement);

  const invalidBytes = ndjsonBytes([rowFixture(2, { externalId: "recover-report", email: 42 })]);
  const invalid = await createUploadedImport(ctx, api.baseUrl, catalog, invalidBytes, { label: "report recovery" });
  let claimOrdinal = 0;
  const reportBarrier = await ctx.claimedBarrier(() => {
    claimOrdinal += 1;
    return claimOrdinal === 2;
  });
  const reportWorker = await ctx.startWorkerAtBarrier(reportBarrier);
  await waitForImport(ctx, api.baseUrl, invalid.job.importId, "VALIDATED", { processes: [reportWorker] });
  const reportClaim = await reportBarrier.waitFor((entry) => !entry.released, { processes: [reportWorker] });
  const reportLease = await leasedWork(ctx, api.baseUrl, invalid.job.importId, "ERROR_REPORT");
  ctx.equal("report barrier reached only the published claimed point", reportClaim.json.point, "worker.claimed");
  const beforeKill = await ctx.getErrorReport(api.baseUrl, invalid.job.importId);
  ctx.ok("report is not READY before its leased Work succeeds", beforeKill.status === 404 || beforeKill.json?.state === "PENDING");
  await ctx.kill(reportWorker);
  await ctx.sleep(3_250);
  const reportReplacement = await ctx.startWorker();
  const report = await waitForReport(ctx, api.baseUrl, invalid.job.importId, ["READY"], { processes: [reportReplacement] });
  ctx.assert("recovered report metadata is singular and terminal", () => assertReport(report, {
    importId: invalid.job.importId,
    state: "READY",
    rowCount: 1,
  }), CORRECTNESS_CAP);
  const snapshot = await ctx.snapshot(api.baseUrl);
  ctx.assert("commit Work recovered once", () => assertRecoveredWork(snapshot, valid.job.importId, "IMPORT_COMMIT"), CORRECTNESS_CAP);
  ctx.assert("report Work recovered once", () => assertRecoveredWork(snapshot, invalid.job.importId, "ERROR_REPORT"), CORRECTNESS_CAP);
  ctx.equal("snapshot has one ErrorReport identity", resource(snapshot, "errorReports").filter(({ importId }) => importId === invalid.job.importId).length, 1, CORRECTNESS_CAP);
  ctx.equal("commit aggregate has one terminal event", eventsOf(snapshot).filter(({ aggregateId, type }) => aggregateId === valid.job.importId && type === "import.committed").length, 1, CORRECTNESS_CAP);
  ctx.blocked("commit-report-effect-commit-window", "IW-GAP-03");
  return result(ctx, "claimed commit and report Work recovered after lease expiry with one record, report, and terminal event");
}

async function c03(ctx) {
  const catalog = ctx.catalog("bundle-recovery");
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 1 });
  const sources = [];
  for (let index = 0; index < 3; index += 1) {
    sources.push(await createValidatedImport(ctx, api.baseUrl, catalog, ndjsonBytes([
      rowFixture(index, { externalId: `recover-bundle-${index}` }),
    ]), { label: `bundle recovery member ${index}`, processes: workers }));
  }
  await ctx.stop(workers[0]);
  const bundle = expectBundle(ctx, await ctx.createBundle(api.baseUrl, catalog.tenant.tenantId, "Recoverable Bundle"), { state: "DRAFT" }, "create recoverable Bundle");
  for (const [index, source] of sources.entries()) {
    expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, source.job.importId), {
      importId: source.job.importId,
      position: index + 1,
    }, `add recovery member ${index + 1}`);
  }
  expectBundle(ctx, await ctx.stageBundle(api.baseUrl, bundle.bundleId), { state: "STAGED" }, "stage recoverable Bundle");
  const publishKey = ctx.key("recover-publish");
  const firstPublish = expectBundle(ctx, await ctx.publishBundle(api.baseUrl, bundle.bundleId, publishKey), { bundleId: bundle.bundleId }, "enqueue Bundle publish");
  const barrier = await ctx.claimedBarrier();
  const worker = await ctx.startWorkerAtBarrier(barrier);
  const claim = await barrier.waitFor((entry) => !entry.released, { processes: [worker] });
  const lease = await leasedWork(ctx, api.baseUrl, bundle.bundleId, "BUNDLE_PUBLISH");
  ctx.equal("Bundle barrier reached only the published claimed point", claim.json.point, "worker.claimed");
  const replayWhileLeased = expectBundle(ctx, await ctx.publishBundle(api.baseUrl, bundle.bundleId, publishKey), { bundleId: bundle.bundleId }, "publish replay while leased");
  ctx.equal("publish replay preserves operation identity", canonical(replayWhileLeased), canonical(firstPublish));
  const preKill = await ctx.snapshot(api.baseUrl);
  ctx.equal("no member records are visible at the claimed checkpoint", resource(preKill, "committedRecords").filter(({ sourceImportId }) => sources.some((source) => source.job.importId === sourceImportId)).length, 0, CORRECTNESS_CAP);
  await ctx.kill(worker);
  await ctx.sleep(3_250);
  const replacement = await ctx.startWorker();
  const recovered = await waitForBundle(ctx, api.baseUrl, bundle.bundleId, "PUBLISHED");
  const records = resource(recovered.snapshot, "committedRecords").filter(({ sourceImportId }) => sources.some((source) => source.job.importId === sourceImportId));
  ctx.equal("recovered Bundle exposes all member records together", records.length, 3, CORRECTNESS_CAP);
  ctx.assert("recovered Bundle Work is singular and fenced", () => assertRecoveredWork(recovered.snapshot, bundle.bundleId, "BUNDLE_PUBLISH"), CORRECTNESS_CAP);
  ctx.equal("member ImportJob histories are not rewritten", resource(recovered.snapshot, "imports").filter(({ importId }) => sources.some((source) => source.job.importId === importId)).map(({ state }) => state), ["VALIDATED", "VALIDATED", "VALIDATED"], CORRECTNESS_CAP);
  ctx.assert("recovered publication has unique record and event identities", () => {
    assertUnique(records, ({ recordId }) => recordId, "Bundle records");
    const aggregateEvents = eventsOf(recovered.snapshot).filter(({ aggregateId }) => aggregateId === bundle.bundleId);
    assertEventSequences(aggregateEvents);
    assertUnique(aggregateEvents, ({ eventId }) => eventId, "Bundle events");
  }, CORRECTNESS_CAP);
  ctx.blocked("bundle-effect-commit-window", "IW-GAP-03");
  return result(ctx, "claimed BUNDLE_PUBLISH survived SIGKILL and exposed the whole frozen cohort only after recovery");
}

function eventFromReceiver(entry) {
  return entry.json?.event ?? entry.json;
}

function stableHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => (
    name === "content-type" || name === "content-length" || name.startsWith("x-")
  )).sort(([left], [right]) => left.localeCompare(right)));
}

async function c04(ctx) {
  const catalog = ctx.catalog("event-retry");
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 1 });
  const imported = await createValidatedImport(ctx, api.baseUrl, catalog, ndjsonBytes([
    rowFixture(1, { externalId: "event-import" }),
  ]), { label: "event import", processes: workers });
  expectImport(ctx, await ctx.commitImport(api.baseUrl, imported.job.importId), { importId: imported.job.importId }, "enqueue event import commit");
  await waitForImport(ctx, api.baseUrl, imported.job.importId, "COMMITTED", { processes: workers });
  const bundled = await createValidatedImport(ctx, api.baseUrl, catalog, ndjsonBytes([
    rowFixture(2, { externalId: "event-bundle" }),
  ]), { label: "event Bundle member", processes: workers });
  const bundle = expectBundle(ctx, await ctx.createBundle(api.baseUrl, catalog.tenant.tenantId, "Event Bundle"), { state: "DRAFT" }, "create event Bundle");
  expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, bundled.job.importId), { position: 1 }, "add event Bundle member");
  expectBundle(ctx, await ctx.stageBundle(api.baseUrl, bundle.bundleId), { state: "STAGED" }, "stage event Bundle");
  expectBundle(ctx, await ctx.publishBundle(api.baseUrl, bundle.bundleId), { bundleId: bundle.bundleId }, "publish event Bundle");
  await waitForBundle(ctx, api.baseUrl, bundle.bundleId, "PUBLISHED");

  const beforeFailure = await ctx.snapshot(api.baseUrl);
  expectError(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, ctx.uuid("missing-import")), 409, "BUNDLE_FROZEN", "rolled-back Bundle mutation");
  const afterFailure = await ctx.snapshot(api.baseUrl);
  ctx.equal("failed business mutation creates no Event", eventsOf(afterFailure).length, eventsOf(beforeFailure).length);

  let firstRaw;
  const receiver = await ctx.receiver(({ raw }, ledger) => {
    firstRaw ??= raw;
    const attemptsForBody = ledger.filter((entry) => entry.raw === raw).length;
    if (raw === firstRaw) {
      if (attemptsForBody === 1) return { status: 204, delayMs: 4_000 };
      if (attemptsForBody === 2) return { status: 500 };
      if (attemptsForBody === 3) return { disconnect: true };
      return { status: 204 };
    }
    return attemptsForBody === 1 ? { status: 500 } : { status: 204 };
  });
  const firstDispatcher = await ctx.startEventDispatcher(receiver.url);
  await ctx.waitFor(() => receiver.ledger.length >= 1 && receiver.ledger[0].raw.length > 0, {
    timeoutMs: 30_000,
    label: "dispatcher to send a complete event body",
    processes: [firstDispatcher],
  });
  await ctx.kill(firstDispatcher);
  const replacement = await ctx.startEventDispatcher(receiver.url);
  const retried = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const delivery = workOf(snapshot).filter(({ kind }) => kind === "EVENT_DELIVERY");
    const allDrained = delivery.length > 0 && delivery.every(({ terminal, state }) => terminal === true && state === "SUCCEEDED");
    const bundleRetries = receiver.ledger.filter((entry) => eventFromReceiver(entry)?.aggregateId === bundle.bundleId);
    return allDrained && bundleRetries.length >= 2 ? { snapshot, bundleRetries } : undefined;
  }, { timeoutMs: 90_000, intervalMs: 50, label: "unknown-ACK retries and Event Work drain", processes: [replacement] });

  const firstAttempts = receiver.ledger.filter(({ raw }) => raw === firstRaw);
  ctx.ok("killed, 500, disconnected, and acknowledged deliveries all occur", firstAttempts.length >= 4);
  ctx.assert("unknown-ACK retry preserves body and application headers byte-for-byte", () => {
    assert.equal(new Set(firstAttempts.map(({ raw }) => raw)).size, 1);
    assert.equal(new Set(firstAttempts.map(({ headers }) => canonical(stableHeaders(headers)))).size, 1);
    const identities = firstAttempts.map(eventFromReceiver).map(({ eventId, aggregateId, sequence }) => ({ eventId, aggregateId, sequence }));
    assert.equal(new Set(identities.map(canonical)).size, 1);
  }, CORRECTNESS_CAP);
  ctx.assert("Bundle event retry also preserves event identity and bytes", () => {
    assert.equal(new Set(retried.bundleRetries.map(({ raw }) => raw)).size, 1);
    assert.equal(new Set(retried.bundleRetries.map(eventFromReceiver).map(({ eventId }) => eventId)).size, 1);
  }, CORRECTNESS_CAP);
  ctx.assert("business events are ordered and contain no raw artifacts", () => {
    assertEventSequences(eventsOf(retried.snapshot));
    assertNoSensitiveMaterial({ ledger: receiver.ledger, snapshot: retried.snapshot });
  }, CORRECTNESS_CAP);
  ctx.equal("committed import record remains durable with its Event", resource(retried.snapshot, "committedRecords").filter(({ sourceImportId }) => sourceImportId === imported.job.importId).length, 1, CORRECTNESS_CAP);
  ctx.equal("published Bundle record remains durable with its Event", resource(retried.snapshot, "committedRecords").filter(({ sourceImportId }) => sourceImportId === bundled.job.importId).length, 1, CORRECTNESS_CAP);
  return result(ctx, "dispatcher SIGKILL, HTTP 500, and disconnect retried Import/Bundle events with stable bytes and identity");
}

export const C_CASES = Object.freeze([
  defineCase({ id: "C-01", fixtureFamily: "F-RECOVERY invalid validation pairs", action: "claimed barrier, SIGKILL, lease expiry, stale release", oracle: "independent validation model plus Work/Event uniqueness", run: c01 }),
  defineCase({ id: "C-02", fixtureFamily: "F-COMMIT/F-RECOVERY commit and report jobs", action: "claimed barrier SIGKILL for each Work kind", oracle: "one fenced Work, record, report, and terminal event", run: c02 }),
  defineCase({ id: "C-03", fixtureFamily: "F-BUNDLE three-member frozen cohort", action: "claimed BUNDLE_PUBLISH barrier, replay, SIGKILL, replacement", oracle: "all-or-none snapshot visibility and unique identities", run: c03 }),
  defineCase({ id: "C-04", fixtureFamily: "Import and Bundle event ledger", action: "controlled receiver, dispatcher SIGKILL, 500 and disconnect", oracle: "raw body/header equality and aggregate sequence model", run: c04 }),
]);
