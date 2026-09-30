// Policy revision: learning-final-system-2026-09-08.1. One FINAL submission; current public operations, persistence and restart recovery, not a historical binary upgrade.
import assert from "node:assert/strict";

import { CaseExcluded } from "../lib/execution.mjs";
import { assertGaplessVersions, canonicalDigest } from "../lib/oracle.mjs";
import {
  SUBJECT_KEYS,
  VERSION_KEYS,
  assertFinalSnapshot,
  assertSnapshotClosure,
  canonical,
  closedLoop,
  createDraft,
  createSubject,
  exactKeys,
  field,
  guarded,
  percentile,
  prepare,
  publishedVersion,
  recordSchema,
  requireStatus,
  result,
  sameJson,
  seedWithHistories,
  stableSnapshot,
  waitDraft,
  waitSnapshot,
} from "./helpers.mjs";
import { emptySeed } from "../lib/fixtures.mjs";

function performanceSeed(ctx) {
  const seed = emptySeed(ctx.fixtures, "perf-v1");
  seed.seedVersion = "perf-v1";
  for (let subjectIndex = 0; subjectIndex < 2_000; subjectIndex += 1) {
    const subject = {
      subjectId: ctx.uuid(`perf-subject-${subjectIndex}`),
      name: `Performance Subject ${String(subjectIndex).padStart(4, "0")}`,
      compatibilityMode: "BACKWARD",
      modeRevision: 1,
    };
    seed.subjects.push(subject);
    for (let version = 1; version <= 10; version += 1) {
      const fields = { id: field("STRING", true) };
      for (let index = 1; index < version; index += 1) fields[`optional${index}`] = field("INTEGER");
      seed.publishedVersions.push(publishedVersion(ctx, subject, `perf-${subjectIndex}`, version, recordSchema(`Perf${subjectIndex}`, fields)));
    }
  }
  return seed;
}

async function e01(ctx) {
return guarded(["MIGRATION_COMPATIBILITY"], async () => {
    const seed = seedWithHistories(ctx, "e01", [{
      compatibilityMode: "FULL",
      schemas: [recordSchema("Legacy", { id: field("STRING", true) })],
    }]);
    const seededSubject = seed.subjects[0];
    const legacy = ctx;
    await legacy.command("npm", ["ci"], { timeoutMs: 600_000 });
    await legacy.npm("build", [], { timeoutMs: 600_000 });
    await legacy.migrate();
    const seeded = await legacy.seed(seed, { timeoutMs: 600_000 });
    assert.equal(seeded.exitCode, 0, seeded.stderr || seeded.stdout);
    const oldApi = await legacy.startApi();

    const subjectBody = { name: `Legacy-${ctx.key("e01-subject")}`, compatibilityMode: "BACKWARD" };
    const subjectKey = ctx.key("e01-subject");
    const originalSubject = await ctx.mutate(oldApi.baseUrl, "/api/v1/subjects", subjectKey, subjectBody);
    requireStatus(originalSubject, 201, "legacy saved Subject response");

    const oldWorker = await legacy.startWorker();
    const publishable = await createDraft(ctx, oldApi, seededSubject.subjectId, "e01-publishable", {
      schema: recordSchema("Legacy", { id: field("STRING", true), optional: field("BOOLEAN") }),
      expectedHeadVersion: 1,
    });
    await waitDraft(ctx, oldApi, publishable.draft.draftId, "VALID", { processes: [oldWorker] });
    const publishPath = `/api/v1/schema-drafts/${publishable.draft.draftId}/publish`;
    const publishKey = ctx.key("e01-publish");
    const originalPublication = await ctx.mutate(oldApi.baseUrl, publishPath, publishKey, {});
    requireStatus(originalPublication, 201, "legacy saved Publication response");
    assert.equal(Object.hasOwn(originalPublication.json.version, "releaseBundleId"), false);
    await ctx.stop(oldWorker);

    const pending = await createDraft(ctx, oldApi, originalSubject.json.subjectId, "e01-pending", {
      schema: recordSchema("PendingLegacy", { id: field("STRING", true) }),
      expectedHeadVersion: null,
    });
    const before = await ctx.snapshot(oldApi.baseUrl);
    const pendingWorkBefore = before.work.find(({ aggregateId }) => aggregateId === pending.draft.draftId);
    assert.ok(pendingWorkBefore && pendingWorkBefore.terminal === false);
    await ctx.kill(oldApi);
    await oldApi.exited;

    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
    await ctx.migrate();
    await ctx.migrate();
    const seedReplay = await ctx.seed(seed, { timeoutMs: 600_000 });
    assert.equal(seedReplay.exitCode, 0, seedReplay.stderr || seedReplay.stdout);
    const api = await ctx.startApi();

    const subjectReplay = await ctx.mutate(api.baseUrl, "/api/v1/subjects", subjectKey, subjectBody);
    assert.equal(subjectReplay.status, originalSubject.status);
    sameJson(subjectReplay.json, originalSubject.json);
    const publicationReplay = await ctx.mutate(api.baseUrl, publishPath, publishKey, {});
    assert.equal(publicationReplay.status, originalPublication.status);
    sameJson(publicationReplay.json, originalPublication.json);
    assert.equal(Object.hasOwn(publicationReplay.json.version, "releaseBundleId"), false);

    const retained = await ctx.snapshot(api.baseUrl);
    assertFinalSnapshot(retained);
    assertSnapshotClosure(retained);
    assert.equal(retained.resources.releaseBundles.length, 0);
    assert.deepEqual(retained.resources.subjects, before.resources.subjects);
    assert.deepEqual(retained.resources.schemaDrafts, before.resources.schemaDrafts);
    for (const oldVersion of before.resources.schemaVersions) {
      const current = retained.resources.schemaVersions.find(({ schemaVersionId }) => schemaVersionId === oldVersion.schemaVersionId);
      assert.ok(current, `reinitialization lost ${oldVersion.schemaVersionId}`);
      const { releaseBundleId, ...legacyShape } = current;
      assert.equal(releaseBundleId, null);
      assert.deepEqual(current, oldVersion, "published Version remains exact across restart");
    }
    assert.deepEqual(retained.events, before.events);
    const pendingWorkMigrated = retained.work.find(({ workId }) => workId === pendingWorkBefore.workId);
    assert.deepEqual(pendingWorkMigrated, pendingWorkBefore);

    const finalWorker = await ctx.startWorker();
    const recovered = await waitDraft(ctx, api, pending.draft.draftId, ["VALID", "STALE"], { timeoutMs: 90_000, processes: [finalWorker] });
    assert.equal(recovered.resources.schemaDrafts.find(({ draftId }) => draftId === pending.draft.draftId).state, "VALID");
    const pendingWorkAfter = recovered.work.find(({ workId }) => workId === pendingWorkBefore.workId);
    assert.ok(pendingWorkAfter?.terminal);
    assert.equal(recovered.resources.releaseBundles.length, 0);
    assert.equal(recovered.events.some((event) => !before.events.some(({ eventId }) => eventId === event.eventId) && event.type === "schema.published"), false);
    return result([
      "populated base-system Subject/Draft/Version/digest/dependency/mode/event identities survive two FINAL reinitialization replays with releaseBundleId=null",
      "stored standalone create/publication bodies replay byte-for-byte and pending base-system Work keeps its workId/captured snapshot through FINAL recovery",
    ]);
  });
}

function latencyEvidence(samples) {
  return {
    p50: percentile(samples, 0.50),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

async function e02(ctx) {
  const seed = performanceSeed(ctx);
  const { api } = await prepare(ctx, seed);
  const subjects = [...seed.subjects].sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)));
  const versions = new Map(seed.publishedVersions.filter(({ version }) => version === 10).map((version) => [version.subjectId, version]));
  const before = await ctx.snapshot(api.baseUrl);
  assert.equal(before.resources.subjects.length, 2_000);
  assert.equal(before.resources.schemaVersions.length, 20_000);
  const request = async (ordinal) => {
    const subject = subjects[ordinal % subjects.length];
    const response = await ctx.request(api.baseUrl, `/api/v1/subjects/${subject.subjectId}/versions/latest`);
    return { response, subject };
  };
  await closedLoop({ concurrency: 64, durationMs: 10_000, operation: request });
  const measured = await closedLoop({ concurrency: 64, durationMs: 60_000, operation: request });
  const successes = measured.samples.filter(({ value }) => value.response.status === 200);
  const unexpectedFiveHundreds = measured.samples.filter(({ value }) => value.response.status >= 500);
  assert.equal(unexpectedFiveHundreds.length, 0);
  assert.equal(successes.length, measured.samples.length);
  for (const { value } of successes) {
    const expectedVersion = versions.get(value.subject.subjectId);
    exactKeys(value.response.json.subject, SUBJECT_KEYS, "latest Subject");
    exactKeys(value.response.json.version, VERSION_KEYS, "latest SchemaVersion");
    assert.equal(value.response.json.subject.subjectId, value.subject.subjectId);
    assert.equal(value.response.json.subject.name, value.subject.name);
    assert.equal(value.response.json.subject.compatibilityMode, value.subject.compatibilityMode);
    assert.equal(value.response.json.subject.modeRevision, value.subject.modeRevision);
    assert.equal(value.response.json.subject.headVersion, 10);
    assert.deepEqual(value.response.json.version, { ...expectedVersion, releaseBundleId: null });
  }
  const throughput = successes.length / (measured.elapsedMs / 1_000);
  const latency = latencyEvidence(successes.map(({ durationMs }) => durationMs));
  assert.ok(throughput >= 500, `latest-schema-read throughput ${throughput.toFixed(2)} < 500/s`);
  assert.ok(latency.p95 <= 80, `latest-schema-read p95 ${latency.p95.toFixed(2)}ms > 80ms`);
  const after = await ctx.snapshot(api.baseUrl);
  assertSnapshotClosure(after);
  assert.deepEqual(stableSnapshot(after), stableSnapshot(before));
  return result([`64-client latest-schema-read: ${throughput.toFixed(2)}/s, p50/p95/p99 ${latency.p50.toFixed(2)}/${latency.p95.toFixed(2)}/${latency.p99.toFixed(2)}ms, 0 5xx, exact 2,000×10 immutable dataset`]);
}

async function e03(ctx) {
  const seed = seedWithHistories(ctx, "e03", Array.from({ length: 258 }, (_, index) => ({
    name: `E03 ${index}`,
    compatibilityMode: "BACKWARD",
    schemas: [recordSchema(`E03Base${index}`, { id: field("STRING", true) })],
  })));
  const [dependencyOne, dependencyTwo, ...targets] = seed.subjects;
  const { api } = await prepare(ctx, seed);
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const terminalAt = new Map();
  const startedAt = new Map();
  const expectedDigest = new Map();
  let polling = true;
  let pollError;
  const poller = (async () => {
    try {
      while (polling) {
        const snapshot = await ctx.snapshot(api.baseUrl);
        const now = Date.now();
        for (const draft of snapshot.resources.schemaDrafts) {
          if (["VALID", "REJECTED", "STALE"].includes(draft.state) && startedAt.has(draft.draftId) && !terminalAt.has(draft.draftId)) terminalAt.set(draft.draftId, now);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    } catch (error) {
      pollError = error;
    }
  })();
  const create = async (ordinal, phase) => {
    const subject = targets[ordinal % targets.length];
    const fields = { id: field("STRING", true) };
    for (let index = 1; index < 20; index += 1) fields[`field${index}`] = field("INTEGER");
    const schema = recordSchema(`${phase}${ordinal}`, fields);
    const dependencies = [
      { subjectId: dependencyOne.subjectId, version: 1 },
      { subjectId: dependencyTwo.subjectId, version: 1 },
    ];
    const response = await ctx.mutate(api.baseUrl, `/api/v1/subjects/${subject.subjectId}/schema-drafts`, ctx.key(`e03-${phase}-${ordinal}`), {
      schema,
      dependencies,
      expectedHeadVersion: 1,
    });
    if (response.status === 202) {
      startedAt.set(response.json.draftId, Date.parse(response.json.createdAt));
      expectedDigest.set(response.json.draftId, canonicalDigest(schema, dependencies));
    }
    return response;
  };
  let measured;
  try {
    await closedLoop({ concurrency: 64, durationMs: 10_000, operation: (ordinal) => create(ordinal, "warmup") });
    measured = await closedLoop({ concurrency: 64, durationMs: 60_000, operation: (ordinal) => create(ordinal, "measured") });
    const measuredResponses = measured.samples.map(({ value }) => value);
    assert.equal(measuredResponses.some(({ status }) => status >= 500), false);
    assert.equal(measuredResponses.every(({ status }) => status === 202), true);
    const measuredIds = measuredResponses.map(({ json }) => json.draftId);
    await waitSnapshot(ctx, api, (snapshot) => measuredIds.every((id) => snapshot.resources.schemaDrafts.find((item) => item.draftId === id)?.state === "VALID"), "measured validations drain to VALID", { timeoutMs: 180_000, processes: workers });
    const terminalDeadline = Date.now() + 10_000;
    while (measuredIds.some((id) => !terminalAt.has(id)) && Date.now() < terminalDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    assert.equal(measuredIds.every((id) => terminalAt.has(id)), true);
    const queueLatencies = measuredIds.map((id) => terminalAt.get(id) - startedAt.get(id));
    const throughput = measuredIds.length / (measured.elapsedMs / 1_000);
    const latency = latencyEvidence(queueLatencies);
    assert.ok(throughput >= 50, `schema-validation throughput ${throughput.toFixed(2)} < 50 VALID/s`);
    assert.ok(latency.p95 <= 2_000, `schema-validation terminal p95 ${latency.p95.toFixed(2)}ms > 2000ms`);
    const final = await ctx.snapshot(api.baseUrl);
    assert.equal(measuredIds.every((id) => {
      const draft = final.resources.schemaDrafts.find((item) => item.draftId === id);
      return draft?.state === "VALID" && draft.canonicalDigest === expectedDigest.get(id);
    }), true);
    const measuredIdSet = new Set(measuredIds);
    assert.equal(final.work.filter(({ aggregateId }) => measuredIdSet.has(aggregateId)).some(({ terminal }) => !terminal), false);
    assert.equal(final.resources.schemaVersions.length, seed.publishedVersions.length);
    assertSnapshotClosure(final);
    return result([`64-client schema-validation: ${throughput.toFixed(2)} VALID/s, queue p50/p95/p99 ${latency.p50.toFixed(2)}/${latency.p95.toFixed(2)}/${latency.p99.toFixed(2)}ms, 0 conflicts/5xx, all evaluator digests and Work drain verified`]);
  } finally {
    polling = false;
    await poller;
    if (pollError) throw pollError;
  }
}

function compatiblePerformanceSchema(index) {
  const fields = { id: field("STRING", true) };
  for (let fieldIndex = 1; fieldIndex < 10; fieldIndex += 1) fields[`optional${fieldIndex}`] = field("INTEGER");
  fields[`finalOptional${index}`] = field("BOOLEAN");
  return recordSchema(`Perf${index}`, fields);
}

async function runPublicationWindow(ctx, api, drafts) {
  const startedAt = performance.now();
  const deadline = startedAt + 60_000;
  const samples = [];
  let next = 0;
  await Promise.all(Array.from({ length: 64 }, async () => {
    while (next < drafts.length && performance.now() < deadline) {
      const index = next;
      next += 1;
      const before = performance.now();
      const response = await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${drafts[index].draft.draftId}/publish`, ctx.key(`e04-publish-${index}`), {}, {
        timeoutMs: Math.ceil(Math.max(1_000, deadline - performance.now() + 1_000)),
      });
      samples.push({ index, response, durationMs: performance.now() - before, completedMs: performance.now() - startedAt });
    }
  }));
  return { samples, elapsedMs: performance.now() - startedAt, scheduled: next };
}

async function e04(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    const seed = performanceSeed(ctx);
    const { api } = await prepare(ctx, seed);
    const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const subjects = [...seed.subjects].sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)));
    const created = await ctx.concurrent(subjects, 64, async (subject, index) => createDraft(ctx, api, subject.subjectId, `e04-measured-${index}`, {
      schema: compatiblePerformanceSchema(index),
      expectedHeadVersion: 10,
    }));
    const measuredIds = created.map(({ draft }) => draft.draftId);
    await waitSnapshot(ctx, api, (snapshot) => measuredIds.every((id) => snapshot.resources.schemaDrafts.find((item) => item.draftId === id)?.state === "VALID"), "2,000 measured Drafts validate", { timeoutMs: 300_000, processes: workers });

    const warmSubjects = await ctx.concurrent(Array.from({ length: 256 }), 32, (_, index) => createSubject(ctx, api, `e04-warm-${index}`));
    const warmDrafts = await ctx.concurrent(warmSubjects, 32, (subject, index) => createDraft(ctx, api, subject.subjectId, `e04-warm-${index}`));
    await waitSnapshot(ctx, api, (snapshot) => warmDrafts.every(({ draft }) => snapshot.resources.schemaDrafts.find((item) => item.draftId === draft.draftId)?.state === "VALID"), "warm-up Drafts validate", { timeoutMs: 120_000, processes: workers });
    const warmKeys = warmDrafts.map((_, index) => ctx.key(`e04-warm-publish-${index}`));
    await closedLoop({
      concurrency: 64,
      durationMs: 10_000,
      operation: (ordinal) => {
        const index = ordinal % warmDrafts.length;
        return ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${warmDrafts[index].draft.draftId}/publish`, warmKeys[index], {});
      },
    });

    const measured = await runPublicationWindow(ctx, api, created);
    const onTime = measured.samples.filter(({ completedMs }) => completedMs <= 60_000);
    const unexpectedFiveHundreds = measured.samples.filter(({ response }) => response.status >= 500);
    const conflicts = measured.samples.filter(({ response }) => response.status === 409);
    assert.equal(measured.scheduled, 2_000);
    assert.equal(onTime.length, 2_000, `${onTime.length}/2000 publications completed within 60s`);
    assert.equal(onTime.every(({ response }) => response.status === 201), true);
    assert.equal(unexpectedFiveHundreds.length, 0);
    assert.equal(conflicts.length, 0);
    const latency = latencyEvidence(onTime.map(({ durationMs }) => durationMs));
    const final = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(final);
    const measuredSubjectIds = new Set(subjects.map(({ subjectId }) => subjectId));
    const measuredVersions = final.resources.schemaVersions.filter(({ subjectId, version }) => measuredSubjectIds.has(subjectId) && version === 11);
    assert.equal(measuredVersions.length, 2_000);
    assert.equal(measuredVersions.every(({ releaseBundleId }) => releaseBundleId === null), true);
    const histories = final.resources.schemaVersions.filter(({ subjectId }) => measuredSubjectIds.has(subjectId));
    assert.equal(histories.length, 22_000);
    assertGaplessVersions(histories);
    assert.equal(final.resources.subjects.filter(({ subjectId }) => measuredSubjectIds.has(subjectId)).every(({ headVersion }) => headVersion === 11), true);
    assert.equal(final.events.filter(({ type }) => type === "schema.published").length, 2_256);
    return result([`64-client gapless-publish: exactly 2,000 in ${(Math.max(...onTime.map(({ completedMs }) => completedMs)) / 1_000).toFixed(2)}s, latency p50/p95/p99 ${latency.p50.toFixed(2)}/${latency.p95.toFixed(2)}/${latency.p99.toFixed(2)}ms, 0 conflicts/5xx, all heads 11 and histories gapless`]);
  });
}

export const E_CASES = [e01, e02, e03, e04].map((run, index) => ({ id: `E-${String(index + 1).padStart(2, "0")}`, run }));

export { performanceSeed };
