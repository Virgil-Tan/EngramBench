import assert from "node:assert/strict";

import { assertGaplessVersions, expectedCatalogSnapshot, releaseBundleOracle } from "../lib/oracle.mjs";
import {
  assertExactError,
  assertSnapshotClosure,
  canonical,
  createBundle,
  createDraft,
  field,
  findBy,
  getSubjectVersions,
  guarded,
  parseCaptured,
  prepare,
  recordSchema,
  requireStatus,
  result,
  sameJson,
  seedWithHistories,
  stableSnapshot,
  waitBundle,
  waitDraft,
} from "./helpers.mjs";

async function c01(ctx) {
  return guarded(["RECOVERY_OR_FENCING"], async () => {
    const seed = seedWithHistories(ctx, "c01", [{ schemas: [] }]);
    const subject = seed.subjects[0];
    const { api } = await prepare(ctx, seed);
    for (const point of ["worker.claimed", "worker.effect-complete"]) {
      const draft = await createDraft(ctx, api, subject.subjectId, `c01-${point}`, {
        schema: recordSchema(`Recovery${point}`, { id: field("STRING", true), recovered: field("BOOLEAN") }),
      });
      const barrier = await ctx.barrier({ hold: (payload) => payload.point === point && payload.aggregateId === draft.draft.draftId && payload.attempt === 1 });
      const firstWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
      const held = await barrier.waitFor((entry) => entry.json?.point === point && entry.json.aggregateId === draft.draft.draftId, { processes: [firstWorker] });
      assert.equal(held.json.processRole, "worker");
      assert.equal(held.json.attempt, 1);
      assert.match(held.json.leaseTokenHash, /^[0-9a-f]{64}$/u);
      await ctx.snapshot(api.baseUrl);
      await ctx.kill(firstWorker);
      const replacement = await ctx.startWorker();
      const snapshot = await waitDraft(ctx, api, draft.draft.draftId, "VALID", { timeoutMs: 90_000, processes: [replacement] });
      const work = snapshot.work.filter(({ aggregateId }) => aggregateId === draft.draft.draftId);
      assert.equal(work.length, 1);
      assert.equal(work[0].state, "SUCCEEDED");
      assert.equal(work[0].terminal, true);
      assert.ok(work[0].attempt >= 2);
      assert.equal(findBy(snapshot.resources.schemaDrafts, "draftId", draft.draft.draftId).findings.length, 0);
      await ctx.stop(replacement);
    }

    const fenced = await createDraft(ctx, api, subject.subjectId, "c01-before-commit", {
      schema: recordSchema("Fence", { id: field("STRING", true), fence: field("BOOLEAN") }),
    });
    const barrier = await ctx.barrier({
      hold: (payload) => payload.point === "worker.before-commit" && payload.aggregateId === fenced.draft.draftId && payload.attempt === 1,
    });
    const staleWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const stale = await barrier.waitFor((entry) => entry.json?.point === "worker.before-commit" && entry.json.aggregateId === fenced.draft.draftId, { processes: [staleWorker] });
    const replacement = await ctx.startWorker();
    let snapshot = await waitDraft(ctx, api, fenced.draft.draftId, "VALID", { timeoutMs: 90_000, processes: [replacement] });
    const beforeRelease = stableSnapshot(snapshot);
    barrier.release(stale);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    snapshot = await ctx.snapshot(api.baseUrl);
    assert.deepEqual(stableSnapshot(snapshot), beforeRelease);
    const work = snapshot.work.filter(({ aggregateId }) => aggregateId === fenced.draft.draftId);
    assert.equal(work.length, 1);
    assert.equal(work[0].state, "SUCCEEDED");
    assert.ok(work[0].attempt >= 2);
    assert.equal(findBy(snapshot.resources.schemaDrafts, "draftId", fenced.draft.draftId).state, "VALID");
    assert.equal(new Set(snapshot.events.map(({ eventId }) => eventId)).size, snapshot.events.length);
    assert.equal(snapshot.events.filter(({ type }) => type === "schema.validation-started").length, 3);
    assert.equal(snapshot.work.some(({ state }) => state === "LEASED"), false);
    return result([
      "claimed and effect-complete SIGKILLs reclaim the same durable Work with incremented attempt",
      "an expired before-commit owner resumes after replacement success but cannot alter Draft, findings, Work, or Event identity",
    ]);
  });
}

async function c02(ctx) {
  return guarded(["DURABLE_IDEMPOTENCY", "VERSION_OR_ATOMICITY"], async () => {
    const seed = seedWithHistories(ctx, "c02", [{ schemas: [recordSchema("C02", { id: field("STRING", true) })] }]);
    const subject = seed.subjects[0];
    let { api, worker } = await prepare(ctx, seed, { worker: true });
    const fixedPort = api.port;
    const draft = await createDraft(ctx, api, subject.subjectId, "c02", {
      schema: recordSchema("C02", { id: field("STRING", true), next: field("BOOLEAN") }),
      expectedHeadVersion: 1,
    });
    await waitDraft(ctx, api, draft.draft.draftId, "VALID", { processes: [worker] });
    const shield = await ctx.responseShield(api.baseUrl);
    shield.dropNextMutation();
    const path = `/api/v1/schema-drafts/${draft.draft.draftId}/publish`;
    const key = ctx.key("c02-publish");
    await assert.rejects(() => ctx.mutate(shield.baseUrl, path, key, {}));
    const original = parseCaptured(shield.captures.at(-1));
    assert.equal(original.status, 201);
    await ctx.kill(api);
    api = await ctx.startApi({ port: fixedPort });
    const replay = await ctx.mutate(api.baseUrl, path, key, {});
    assert.equal(replay.status, 201);
    sameJson(replay.json, original.json);
    const history = await getSubjectVersions(ctx, api, subject.subjectId);
    assert.deepEqual(history.items.map(({ version }) => version), [1, 2]);
    assert.equal(history.items[1].schemaVersionId, original.json.version.schemaVersionId);
    const latest = await ctx.request(api.baseUrl, `/api/v1/subjects/${subject.subjectId}/versions/latest`);
    requireStatus(latest, 200, "latest after response loss");
    assert.equal(latest.json.subject.headVersion, 2);
    assert.equal(latest.json.version.schemaVersionId, original.json.version.schemaVersionId);
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 1);
    return result(["lost 201 plus API SIGKILL replays the identical version/body; latest and public history remain gapless at head 2"]);
  });
}

async function c03(ctx) {
  return guarded(["RECOVERY_OR_FENCING", "VERSION_OR_ATOMICITY"], async () => {
    const seed = seedWithHistories(ctx, "c03", Array.from({ length: 20 }, (_, index) => ({ name: `C03 ${index}`, schemas: [] })));
    const members = seed.subjects.map((subject, index) => ({
      subjectId: subject.subjectId,
      expectedHeadVersion: null,
      schema: recordSchema(`C03${index}`, { id: field("STRING", true) }),
      dependencies: index < seed.subjects.length - 1 ? [{ kind: "BUNDLE_MEMBER", subjectId: seed.subjects[index + 1].subjectId }] : [],
    }));
    const catalogSnapshot = expectedCatalogSnapshot(seed.subjects.map((subject) => ({ ...subject, headVersion: null })), seed.subjects.map(({ subjectId }) => subjectId));
    const oracle = releaseBundleOracle({ members, catalogSnapshot, publishedVersions: seed.publishedVersions });
    const { api } = await prepare(ctx, seed);
    const created = await createBundle(ctx, api, "c03", [...members].reverse(), 200);
    assert.equal(created.json.canonicalDigest, oracle.canonicalDigest);
    assert.deepEqual(created.json.catalogSnapshot, oracle.catalogSnapshot);
    const frozen = {
      digest: oracle.canonicalDigest,
      catalog: oracle.catalogSnapshot,
      draftIds: created.json.members.map(({ draftId }) => draftId),
    };

    const claimedBarrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.aggregateId === created.json.releaseBundleId && payload.attempt === 1 });
    const firstWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: claimedBarrier.url, TEST_BARRIER_TOKEN: claimedBarrier.token } });
    await claimedBarrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.aggregateId === created.json.releaseBundleId, { processes: [firstWorker] });
    await ctx.kill(firstWorker);

    const effectBarrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.effect-complete" && payload.aggregateId === created.json.releaseBundleId && payload.attempt === 2 });
    const secondWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: effectBarrier.url, TEST_BARRIER_TOKEN: effectBarrier.token } });
    await effectBarrier.waitFor((entry) => entry.json?.point === "worker.effect-complete" && entry.json.aggregateId === created.json.releaseBundleId, { timeoutMs: 90_000, processes: [secondWorker] });
    await ctx.kill(secondWorker);

    const replacements = [await ctx.startWorker(), await ctx.startWorker()];
    const snapshot = await waitBundle(ctx, api, created.json.releaseBundleId, "READY", { timeoutMs: 90_000, processes: replacements });
    const bundle = findBy(snapshot.resources.releaseBundles, "releaseBundleId", created.json.releaseBundleId);
    assert.equal(bundle.canonicalDigest, frozen.digest);
    assert.deepEqual(bundle.catalogSnapshot, frozen.catalog);
    assert.deepEqual(bundle.members.map(({ draftId }) => draftId), frozen.draftIds);
    assert.deepEqual(bundle.findings, []);
    assert.equal(snapshot.resources.releaseBundles.length, 1);
    assert.equal(snapshot.resources.schemaDrafts.length, 20);
    const work = snapshot.work.filter(({ kind, aggregateId }) => kind === "BUNDLE_VALIDATION" && aggregateId === created.json.releaseBundleId);
    assert.equal(work.length, 1);
    assert.equal(work[0].state, "SUCCEEDED");
    assert.ok(work[0].attempt >= 3);
    assert.equal(snapshot.resources.schemaVersions.length, 0);
    return result(["20-member BUNDLE_VALIDATION survives claimed and effect-complete crashes with the evaluator-owned catalog/digest, one Draft set, and one terminal Work"]);
  });
}

async function c04(ctx) {
  return guarded(["EVENT_ATOMICITY_OR_IDENTITY"], async () => {
    const seed = seedWithHistories(ctx, "c04", [
      { name: "C04 A", schemas: [] },
      { name: "C04 B", schemas: [] },
      { name: "C04 C", schemas: [] },
    ]);
    const [subjectA, subjectB, subjectC] = seed.subjects;
    const { api, worker } = await prepare(ctx, seed, { worker: true });

    const standalone = await createDraft(ctx, api, subjectC.subjectId, "c04-standalone");
    await waitDraft(ctx, api, standalone.draft.draftId, "VALID", { processes: [worker] });
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${standalone.draft.draftId}/publish`, ctx.key("c04-standalone-publish"), {}), 201, "standalone publication");

    const bundleMembers = [subjectA, subjectB].map((subject, index) => ({
      subjectId: subject.subjectId,
      expectedHeadVersion: null,
      schema: recordSchema(`C04Bundle${index}`, { id: field("STRING", true) }),
      dependencies: [],
    }));
    const bundle = await createBundle(ctx, api, "c04-bundle", bundleMembers, 200);
    await waitBundle(ctx, api, bundle.json.releaseBundleId, "READY", { processes: [worker] });
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/release-bundles/${bundle.json.releaseBundleId}/publish`, ctx.key("c04-bundle-publish"), {}), 200, "bundle publication");

    const staleBundle = await createBundle(ctx, api, "c04-rollback", [
      {
        subjectId: subjectA.subjectId,
        expectedHeadVersion: 1,
        schema: recordSchema("C04Rollback", { id: field("STRING", true), rollback: field("BOOLEAN") }),
        dependencies: [],
      },
    ], 200);
    await waitBundle(ctx, api, staleBundle.json.releaseBundleId, "READY", { processes: [worker] });
    const drift = await createDraft(ctx, api, subjectA.subjectId, "c04-drift", {
      schema: recordSchema("C04Drift", { id: field("STRING", true), drift: field("BOOLEAN") }),
      expectedHeadVersion: 1,
    });
    await waitDraft(ctx, api, drift.draft.draftId, "VALID", { processes: [worker] });
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${drift.draft.draftId}/publish`, ctx.key("c04-drift-publish"), {}), 201, "rollback drift");
    const beforeRollback = await ctx.snapshot(api.baseUrl);
    const beforePublicationEvents = beforeRollback.events.filter(({ type }) => type === "schema.published" || type === "bundle.published");
    assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/release-bundles/${staleBundle.json.releaseBundleId}/publish`, ctx.key("c04-rollback-publish"), {}), 409, "RELEASE_BUNDLE_STALE");
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    const committed = snapshot.events.filter(({ type }) => type === "schema.published" || type === "bundle.published");
    assert.deepEqual(committed, beforePublicationEvents);
    assert.equal(snapshot.resources.schemaVersions.some(({ releaseBundleId }) => releaseBundleId === staleBundle.json.releaseBundleId), false);
    assert.equal(findBy(snapshot.resources.releaseBundles, "releaseBundleId", staleBundle.json.releaseBundleId).state, "STALE");

    const receiver = await ctx.receiver({
      path: "/events",
      behavior: (entry) => ({ status: entry.attempt === 1 ? 500 : 204 }),
    });
    const shield = await ctx.responseShield(receiver.baseUrl);
    shield.dropNextMutation();
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "dispatcher.response-received" });
    const firstDispatcher = await ctx.startDispatcher({
      webhookUrl: `${shield.baseUrl}/events`,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const held = await barrier.waitFor((entry) => entry.json?.point === "dispatcher.response-received", { timeoutMs: 90_000, processes: [firstDispatcher] });
    assert.ok(receiver.ledger.length >= 2);
    const repeatedId = receiver.ledger[0].headers["x-schemaharbor-event-id"];
    assert.equal(receiver.ledger[1].headers["x-schemaharbor-event-id"], repeatedId);
    assert.equal(canonical(receiver.ledger[1].json), canonical(receiver.ledger[0].json));
    await ctx.kill(firstDispatcher);
    assert.equal(held.disconnected || !held.released, true);
    const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => committed.every((event) => receiver.ledger.some((entry) => (
      entry.headers["x-schemaharbor-event-id"] === event.eventId
      && entry.headers["x-schemaharbor-event-type"] === event.type
      && canonical(entry.json) === canonical(event)
    ))), { timeoutMs: 90_000, label: "all committed publication events redelivered", processes: [replacement] });
    const repeated = receiver.ledger.filter((entry) => entry.headers["x-schemaharbor-event-id"] === repeatedId);
    assert.ok(repeated.length >= 3);
    assert.ok(repeated.every((entry) => entry.method === "POST" && entry.path === "/events" && canonical(entry.json) === canonical(repeated[0].json)));
    for (const aggregateId of new Set(committed.map(({ aggregateId }) => aggregateId))) {
      const expected = committed.filter((event) => event.aggregateId === aggregateId).sort((left, right) => left.sequence - right.sequence).map(({ eventId }) => eventId);
      const observed = receiver.ledger.map((entry) => entry.headers["x-schemaharbor-event-id"]).filter((eventId, index, all) => expected.includes(eventId) && all.indexOf(eventId) === index);
      assert.deepEqual(observed, expected);
    }
    return result([
      "standalone and Bundle commits have exact transactional publication events while a stale rollback adds none",
      "receiver 500, unknown response, response-received SIGKILL, and restart retain event ID/type/body and per-aggregate sequence",
    ]);
  });
}

export const C_CASES = [c01, c02, c03, c04].map((run, index) => ({ id: `C-${String(index + 1).padStart(2, "0")}`, run }));
