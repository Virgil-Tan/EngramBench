import assert from "node:assert/strict";

import {
  ndjsonBytes,
  rowFixture,
  schemaFixture,
  splitBytes,
} from "../lib/fixtures.mjs";
import {
  assertBundleMember,
  assertImportJob,
  assembleBytes,
  intervalState,
  modelNdjson,
} from "../lib/oracle.mjs";
import {
  CORRECTNESS_CAP,
  allFindings,
  allRecords,
  assertEventSequences,
  assertModeledFindings,
  assertNoSensitiveMaterial,
  assertUnique,
  commitAndWait,
  createImport,
  createValidatedImport,
  defineCase,
  eventsOf,
  expectBundle,
  expectChunk,
  expectError,
  expectImport,
  expectStatus,
  normalizedRanges,
  publishRevision,
  resource,
  result,
  startScenario,
  waitForBundle,
  waitForImport,
} from "./helpers.mjs";

async function b01(ctx) {
  const firstCatalog = ctx.catalog("identity-first");
  const secondCatalog = ctx.catalog("identity-second");
  const { apis } = await startScenario(ctx, { catalogs: [firstCatalog, secondCatalog], apiCount: 2 });
  const bytes = ndjsonBytes([rowFixture(1)]);
  const [piece] = splitBytes(bytes, 1);
  const created = await createImport(ctx, apis[0].baseUrl, firstCatalog, bytes);
  const key = ctx.key("shielded-chunk");
  const shield = await ctx.responseShield(apis[0].baseUrl);
  shield.dropNextMutation();
  let disconnected = false;
  try { await ctx.putChunk(shield.baseUrl, created.job.importId, bytes.length, piece, { key }); } catch { disconnected = true; }
  ctx.ok("client observes the shielded unknown outcome", disconnected);
  const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped chunk response" });
  const replay = await ctx.putChunk(apis[1].baseUrl, created.job.importId, bytes.length, piece, { key });
  ctx.equal("same key/body replay preserves status", replay.status, capture.response.status);
  ctx.equal("same key/body replay preserves exact response bytes", JSON.stringify(replay.json), capture.response.body);

  const changedBody = Buffer.from(piece.body);
  changedBody[0] ^= 0x01;
  expectError(ctx, await ctx.putChunk(apis[1].baseUrl, created.job.importId, bytes.length, piece, {
    key,
    body: changedBody,
  }), 409, "IDEMPOTENCY_CONFLICT", "same key with different bytes conflicts");
  const semanticReplay = await ctx.putChunk(apis[0].baseUrl, created.job.importId, bytes.length, piece, { key: ctx.key("semantic-replay") });
  ctx.equal("new key with the identical immutable chunk replays", semanticReplay.status, 200);
  ctx.equal("semantic replay returns the original immutable chunk", ctx.canonical(semanticReplay.json), ctx.canonical(replay.json));

  const changedNumber = { ...piece, chunkNumber: 99 };
  expectError(ctx, await ctx.putChunk(apis[0].baseUrl, created.job.importId, bytes.length, changedNumber, {
    key: ctx.key("range-conflict"),
    body: changedBody,
  }), 409, "CHUNK_CONFLICT", "same range with different bytes conflicts");
  const changedRange = {
    chunkNumber: piece.chunkNumber,
    start: 1,
    endExclusive: bytes.length,
    endInclusive: bytes.length - 1,
    body: bytes.subarray(1),
  };
  expectError(ctx, await ctx.putChunk(apis[1].baseUrl, created.job.importId, bytes.length, changedRange, {
    key: ctx.key("number-conflict"),
  }), 409, "CHUNK_CONFLICT", "same chunk number with a different range conflicts");

  const other = await createImport(ctx, apis[1].baseUrl, secondCatalog, bytes, { key: ctx.key("other-create") });
  expectChunk(ctx, await ctx.putChunk(apis[1].baseUrl, other.job.importId, bytes.length, piece, { key }), {
    importId: other.job.importId,
  }, "same idempotency key is isolated by tenant and path");
  await Promise.all(apis.map((api) => ctx.stop(api, "SIGKILL")));
  const restarted = await ctx.startApi();
  const afterRestart = await ctx.putChunk(restarted.baseUrl, created.job.importId, bytes.length, piece, { key });
  ctx.equal("durable replay survives API restart", ctx.canonical(afterRestart.json), ctx.canonical(replay.json));
  const snapshot = await ctx.snapshot(restarted.baseUrl);
  ctx.equal("chunk identity conflicts leave one immutable effect per import", resource(snapshot, "uploadChunks").filter(({ importId }) => importId === created.job.importId).length, 1, CORRECTNESS_CAP);
  ctx.equal("cross-tenant control keeps a separate immutable chunk", resource(snapshot, "uploadChunks").filter(({ importId }) => importId === other.job.importId).length, 1);
  return result(ctx, "idempotency, chunk number/range/byte precedence, restart durability, and tenant scope were exercised");
}

function coverageState(total, ranges) {
  return intervalState(total, normalizedRanges(ranges).map(([start, endExclusive]) => ({ start, endExclusive })));
}

async function b02(ctx) {
  const catalog = ctx.catalog("interval-hotspot");
  const { apis } = await startScenario(ctx, { catalogs: catalog, apiCount: 2 });
  const bytes = Buffer.alloc(64 * 128);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 17) % 251;
  const natural = splitBytes(bytes, 64);
  const pieces = [...natural.filter((_, index) => index % 2 === 1).reverse(), ...natural.filter((_, index) => index % 2 === 0).reverse()];
  const created = await createImport(ctx, apis[0].baseUrl, catalog, bytes);
  const keys = new Map(pieces.map((piece) => [piece.chunkNumber, ctx.key(`hot-${piece.chunkNumber}`)]));
  const accepted = await ctx.concurrent(pieces, 64, async (piece, index) => ctx.putChunk(
    apis[index % 2].baseUrl,
    created.job.importId,
    bytes.length,
    piece,
    { key: keys.get(piece.chunkNumber) },
  ));
  ctx.ok("all 64 adjacent ranges are accepted", accepted.every(({ status }) => status === 200));
  const replays = await ctx.concurrent(pieces, 64, (piece, index) => ctx.putChunk(
    apis[(index + 1) % 2].baseUrl,
    created.job.importId,
    bytes.length,
    piece,
    { key: keys.get(piece.chunkNumber) },
  ));
  ctx.ok("all cross-API duplicate deliveries replay", replays.every(({ status }) => status === 200));
  ctx.assert("every duplicate response is byte-stable", () => {
    for (let index = 0; index < accepted.length; index += 1) assert.equal(ctx.canonical(replays[index].json), ctx.canonical(accepted[index].json));
  });

  const overlaps = natural.slice(0, 16).map((piece, index) => ({
    chunkNumber: 1_000 + index,
    start: piece.start + 1,
    endExclusive: piece.endExclusive,
    endInclusive: piece.endInclusive,
    body: bytes.subarray(piece.start + 1, piece.endExclusive),
  }));
  const overlapResponses = await ctx.concurrent(overlaps, 16, (piece, index) => ctx.putChunk(
    apis[index % 2].baseUrl, created.job.importId, bytes.length, piece, { key: ctx.key(`overlap-${index}`) },
  ));
  for (const response of overlapResponses) expectError(ctx, response, 409, "CHUNK_CONFLICT", "overlap loser has semantic conflict");

  const detail = expectStatus(ctx, await ctx.getImport(apis[0].baseUrl, created.job.importId), 200, "read concurrent coverage");
  ctx.equal("receivedBytes equals the exact interval union", detail.receivedBytes, bytes.length, CORRECTNESS_CAP);
  ctx.equal("received ranges have no holes after normalization", coverageState(bytes.length, detail.receivedRanges).missing, []);
  ctx.equal("missing range set is empty", normalizedRanges(detail.missingRanges), []);
  ctx.equal("independent arrival-order assembly has the source digest", ctx.sha256(assembleBytes(bytes.length, pieces)), ctx.sha256(bytes));
  expectImport(ctx, await ctx.completeImport(apis[1].baseUrl, created.job.importId), {
    importId: created.job.importId,
    receivedBytes: bytes.length,
    expectedSha256: ctx.sha256(bytes),
  }, "complete hotspot upload");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const durable = resource(snapshot, "uploadChunks").filter(({ importId }) => importId === created.job.importId);
  ctx.equal("only the 64 accepted immutable intervals are durable", durable.length, 64, CORRECTNESS_CAP);
  ctx.equal("durable chunk numbers are unique", new Set(durable.map(({ chunkNumber }) => chunkNumber)).size, 64, CORRECTNESS_CAP);
  return result(ctx, "two APIs conserved 64 adjacent ranges under replay and overlapping losers, then completed by source order");
}

async function b03(ctx) {
  const catalog = ctx.catalog("commit-contention");
  const { apis, workers } = await startScenario(ctx, { catalogs: catalog, apiCount: 2, workers: 2 });
  const leftBytes = ndjsonBytes([rowFixture(1, { externalId: "hot", email: "left@example.test" })]);
  const rightBytes = ndjsonBytes([rowFixture(1, { externalId: "hot", email: "right@example.test" })]);
  const left = await createImport(ctx, apis[0].baseUrl, catalog, leftBytes, { label: "left contender" });
  const right = await createImport(ctx, apis[1].baseUrl, catalog, rightBytes, { label: "right contender" });
  for (const [candidate, bytes, api] of [[left, leftBytes, apis[0]], [right, rightBytes, apis[1]]]) {
    const pieces = splitBytes(bytes, 4, [3, 1, 0, 2]);
    await ctx.concurrent(pieces, 4, (piece) => ctx.putChunk(api.baseUrl, candidate.job.importId, bytes.length, piece));
    const key = ctx.key(`complete-${candidate.job.importId}`);
    const completes = await Promise.all([
      ctx.completeImport(apis[0].baseUrl, candidate.job.importId, key),
      ctx.completeImport(apis[1].baseUrl, candidate.job.importId, key),
      ctx.completeImport(apis[0].baseUrl, candidate.job.importId, key),
    ]);
    ctx.ok("concurrent complete calls all replay successfully", completes.every(({ status }) => status === 200));
    ctx.assert("concurrent complete returns one saved result", () => assert.equal(new Set(completes.map(({ json }) => ctx.canonical(json))).size, 1));
  }
  await Promise.all([
    waitForImport(ctx, apis[0].baseUrl, left.job.importId, "VALIDATED", { processes: workers }),
    waitForImport(ctx, apis[1].baseUrl, right.job.importId, "VALIDATED", { processes: workers }),
  ]);
  const commitResponses = await Promise.all([
    ctx.commitImport(apis[0].baseUrl, left.job.importId, ctx.key("left-commit")),
    ctx.commitImport(apis[1].baseUrl, right.job.importId, ctx.key("right-commit")),
  ]);
  ctx.ok("commit contention accepts only queued work or the published identity conflict", commitResponses.every(({ status }) => [200, 409].includes(status)) && commitResponses.some(({ status }) => status === 200));
  for (const response of commitResponses.filter(({ status }) => status === 409)) {
    expectError(ctx, response, 409, "ROW_IDENTITY_CONFLICT", "hotspot loser reports identity conflict", CORRECTNESS_CAP);
  }
  const terminals = await Promise.all([
    waitForImport(ctx, apis[0].baseUrl, left.job.importId, ["COMMITTED", "REJECTED"], { processes: workers }),
    waitForImport(ctx, apis[1].baseUrl, right.job.importId, ["COMMITTED", "REJECTED"], { processes: workers }),
  ]);
  ctx.equal("row contention gives both jobs one terminal result", terminals.map(({ state }) => state).sort(), ["COMMITTED", "REJECTED"], CORRECTNESS_CAP);
  const winnerIndex = terminals.findIndex(({ state }) => state === "COMMITTED");
  const winner = winnerIndex === 0 ? left : right;
  const winnerBytes = winnerIndex === 0 ? leftBytes : rightBytes;
  const records = await allRecords(ctx, apis[0].baseUrl, catalog.tenant.tenantId, catalog.schema.datasetKey);
  ctx.equal("external identity has one canonical record", records.filter(({ externalRowId }) => externalRowId === "hot").length, 1, CORRECTNESS_CAP);
  ctx.equal("winner payload is never partially replaced", records.find(({ externalRowId }) => externalRowId === "hot").payload, JSON.parse(winnerBytes.toString("utf8")), CORRECTNESS_CAP);

  const replay = await createValidatedImport(ctx, apis[1].baseUrl, catalog, winnerBytes, { label: "winner replay", processes: workers });
  const replayTerminal = await commitAndWait(ctx, apis[1].baseUrl, replay.job.importId, { processes: workers });
  ctx.equal("identical hot payload converges successfully", replayTerminal.job.state, "COMMITTED");
  const finalSnapshot = await ctx.snapshot(apis[0].baseUrl);
  ctx.equal("complete contention creates one validate Work per job", workOfSnapshot(finalSnapshot).filter(({ kind, aggregateId }) => kind === "IMPORT_VALIDATE" && [left.job.importId, right.job.importId].includes(aggregateId)).length, 2);
  ctx.equal("replay cannot duplicate the canonical external identity", resource(finalSnapshot, "committedRecords").filter(({ externalRowId }) => externalRowId === "hot").length, 1, CORRECTNESS_CAP);
  return result(ctx, "complete replays and competing row payloads converged on one immutable external identity");
}

function workOfSnapshot(snapshot) {
  return snapshot.work ?? snapshot.Work ?? snapshot.works ?? [];
}

async function b04(ctx) {
  const catalog = ctx.catalog("schema-race");
  const { apis, workers } = await startScenario(ctx, { catalogs: catalog, apiCount: 2, workers: 2 });
  const bytes = ndjsonBytes([rowFixture(1, { externalId: "schema-race", age: 41 })]);
  const revision2 = schemaFixture(ctx.fixtures, {
    schemaId: catalog.schema.schemaId,
    revision: 2,
    fields: catalog.revision.fields.map((field) => field.name === "age"
      ? { name: field.name, type: "string", required: field.required }
      : field),
  });
  const [created] = await Promise.all([
    createImport(ctx, apis[0].baseUrl, catalog, bytes, { schemaRevision: 1, label: "revision-one race import" }),
    publishRevision(ctx, apis[1].baseUrl, catalog, revision2),
  ]);
  const pieces = splitBytes(bytes, 4, [2, 0, 3, 1]);
  await ctx.concurrent(pieces, 4, (piece, index) => ctx.putChunk(apis[index % 2].baseUrl, created.job.importId, bytes.length, piece));
  expectImport(ctx, await ctx.completeImport(apis[1].baseUrl, created.job.importId), { schemaRevision: 1 }, "complete frozen revision-one import");
  const validated = await waitForImport(ctx, apis[0].baseUrl, created.job.importId, "VALIDATED", { processes: workers });
  const oldModel = modelNdjson(bytes, catalog.revision);
  ctx.assert("revision-one job remains valid under two competing workers", () => assertImportJob(Object.fromEntries([
    ...Object.entries(validated).filter(([key]) => !["receivedRanges", "missingRanges"].includes(key)),
  ]), { schemaRevision: 1, validRows: oldModel.validRows.length, invalidRows: 0 }));
  ctx.equal("revision-one job has no findings", (await allFindings(ctx, apis[0].baseUrl, created.job.importId)).length, 0);

  const current = await createValidatedImport(ctx, apis[1].baseUrl, catalog, bytes, {
    schemaRevision: 2,
    schema: revision2,
    label: "revision-two control",
    processes: workers,
  });
  ctx.equal("revision-two control reaches the opposite result", current.validated.invalidRows, 1);
  const findings = await allFindings(ctx, apis[1].baseUrl, current.job.importId);
  ctx.assert("revision-two findings match its independent frozen model", () => assertModeledFindings(findings, current.model));
  const revision3 = schemaFixture(ctx.fixtures, { schemaId: catalog.schema.schemaId, revision: 3, fields: catalog.revision.fields });
  await publishRevision(ctx, apis[0].baseUrl, catalog, revision3);
  const oldAfter = await ctx.getImport(apis[1].baseUrl, created.job.importId);
  ctx.equal("later schema publication cannot revalidate history", oldAfter.json.validRows, 1);
  ctx.equal("later schema publication cannot create old findings", (await allFindings(ctx, apis[1].baseUrl, created.job.importId)).length, 0);
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  ctx.equal("only one validation Work exists for the frozen race job", workOfSnapshot(snapshot).filter(({ kind, aggregateId }) => kind === "IMPORT_VALIDATE" && aggregateId === created.job.importId).length, 1);
  return result(ctx, "explicit revision capture remained stable across publication and two validation workers");
}

async function b05(ctx) {
  const catalog = ctx.catalog("bundle-race");
  const { apis, workers } = await startScenario(ctx, { catalogs: catalog, apiCount: 2, workers: 2 });
  const sources = [];
  for (let index = 0; index < 4; index += 1) {
    sources.push(await createValidatedImport(ctx, apis[index % 2].baseUrl, catalog, ndjsonBytes([
      rowFixture(index, { externalId: `cohort-${index}` }),
    ]), { label: `cohort ${index}`, processes: workers }));
  }
  for (const worker of workers) await ctx.stop(worker);
  const bundle = expectBundle(ctx, await ctx.createBundle(apis[0].baseUrl, catalog.tenant.tenantId, "Concurrent cohort"), { state: "DRAFT" }, "create concurrent Bundle");
  const firstKey = ctx.key("same-member-add");
  const sameAdds = await Promise.all(Array.from({ length: 32 }, (_, index) => ctx.addBundleMember(
    apis[index % 2].baseUrl, bundle.bundleId, sources[0].job.importId, firstKey,
  )));
  ctx.ok("same-key concurrent member adds replay", sameAdds.every(({ status }) => status === 200));
  ctx.equal("same-key member response is stable", new Set(sameAdds.map(({ json }) => ctx.canonical(json))).size, 1);
  const firstMember = sameAdds[0].json;
  ctx.assert("first member response is a closed BundleMember", () => assertBundleMember(firstMember, { position: 0 }));

  const otherAdds = await Promise.all(sources.slice(1).map((source, index) => ctx.addBundleMember(
    apis[(index + 1) % 2].baseUrl, bundle.bundleId, source.job.importId, ctx.key(`cohort-add-${index}`),
  )));
  ctx.ok("different members can be added through both APIs", otherAdds.every(({ status }) => status === 200));
  const members = [firstMember, ...otherAdds.map(({ json }) => json)].sort((left, right) => left.position - right.position);
  ctx.assert("one ordered cohort has unique imports and positions", () => {
    members.forEach((member) => assertBundleMember(member, { bundleId: bundle.bundleId }));
    assertUnique(members, ({ importId }) => importId, "Bundle member imports");
    assert.deepEqual(members.map(({ position }) => position), [0, 1, 2, 3]);
  }, CORRECTNESS_CAP);

  const rival = expectBundle(ctx, await ctx.createBundle(apis[1].baseUrl, catalog.tenant.tenantId, "Rival cohort"), { state: "DRAFT" }, "create rival Bundle");
  expectError(ctx, await ctx.addBundleMember(apis[0].baseUrl, rival.bundleId, sources[0].job.importId), 409, "BUNDLE_MEMBER_CONFLICT", "member cannot join two nonterminal Bundles");
  const stageKey = ctx.key("concurrent-stage");
  const stages = await Promise.all(Array.from({ length: 8 }, (_, index) => ctx.stageBundle(apis[index % 2].baseUrl, bundle.bundleId, stageKey)));
  ctx.ok("same-key concurrent stage calls replay", stages.every(({ status }) => status === 200));
  ctx.equal("stage replay freezes one saved response", new Set(stages.map(({ json }) => ctx.canonical(json))).size, 1);
  expectError(ctx, await ctx.addBundleMember(apis[0].baseUrl, bundle.bundleId, ctx.uuid("not-a-member")), 409, "BUNDLE_FROZEN", "stage wins before a later add");

  const shield = await ctx.responseShield(apis[0].baseUrl);
  const publishKey = ctx.key("unknown-publish");
  shield.dropNextMutation();
  let disconnected = false;
  try { await ctx.publishBundle(shield.baseUrl, bundle.bundleId, publishKey); } catch { disconnected = true; }
  ctx.ok("Bundle publisher observes an unknown HTTP outcome", disconnected);
  const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped Bundle publish response" });
  const replay = await ctx.publishBundle(apis[1].baseUrl, bundle.bundleId, publishKey);
  ctx.equal("publish replay preserves status", replay.status, capture.response.status);
  ctx.equal("publish replay preserves saved response", JSON.stringify(replay.json), capture.response.body);
  const publishWorkers = [await ctx.startWorker(), await ctx.startWorker()];
  const published = await waitForBundle(ctx, apis[0].baseUrl, bundle.bundleId, "PUBLISHED");
  const frozen = resource(published.snapshot, "bundleMembers").filter(({ bundleId }) => bundleId === bundle.bundleId).sort((a, b) => a.position - b.position);
  ctx.equal("published cohort is exactly the previously observed set", frozen, members, CORRECTNESS_CAP);
  ctx.equal("publication creates exactly four canonical records", resource(published.snapshot, "committedRecords").filter(({ sourceImportId }) => sources.some((source) => source.job.importId === sourceImportId)).length, 4, CORRECTNESS_CAP);
  ctx.equal("Bundle has one BUNDLE_PUBLISH Work identity", workOfSnapshot(published.snapshot).filter(({ kind, aggregateId }) => kind === "BUNDLE_PUBLISH" && aggregateId === bundle.bundleId).length, 1);
  ctx.assert("Bundle aggregate event sequence is unique and ordered", () => assertEventSequences(eventsOf(published.snapshot).filter(({ aggregateId }) => aggregateId === bundle.bundleId)));
  ctx.assert("concurrency evidence contains no private artifact", () => assertNoSensitiveMaterial({ capture, snapshot: published.snapshot }));
  ctx.ok("both publication workers remain owned until teardown", publishWorkers.every(({ pid }) => Number.isSafeInteger(pid)));
  return result(ctx, "32-path member/stage/replay contention froze one cohort and one atomic Bundle publication");
}

export const B_CASES = Object.freeze([
  defineCase({ id: "B-01", fixtureFamily: "F-UPLOAD identity matrix across two tenants", action: "two APIs, response shield, restart, conflicting PUTs", oracle: "durable request replay and immutable chunk identity precedence", run: b01 }),
  defineCase({ id: "B-02", fixtureFamily: "64 adjacent byte intervals plus replay/overlap losers", action: "two-API concurrent raw chunk PUT and complete", oracle: "independent interval union and source-order SHA-256", run: b02 }),
  defineCase({ id: "B-03", fixtureFamily: "two one-row jobs sharing an external identity", action: "concurrent complete and commit through two APIs", oracle: "one canonical payload and conserved Work/record cardinality", run: b03 }),
  defineCase({ id: "B-04", fixtureFamily: "opposite schema revisions for one source row", action: "schema publication race and two validation workers", oracle: "per-job frozen schema model and stable findings", run: b04 }),
  defineCase({ id: "B-05", fixtureFamily: "four validated jobs and rival Bundles", action: "concurrent add/stage/publish with unknown response", oracle: "unique ordered frozen cohort, saved replay, atomic records/events", run: b05 }),
]);
