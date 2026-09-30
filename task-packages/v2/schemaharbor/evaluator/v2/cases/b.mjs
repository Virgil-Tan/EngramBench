import assert from "node:assert/strict";

import { assertGaplessVersions } from "../lib/oracle.mjs";
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

async function unknownMutation(ctx, shield, api, path, key, body, expectedStatus) {
  const before = shield.captures.length;
  shield.dropNextMutation();
  await assert.rejects(() => ctx.mutate(shield.baseUrl, path, key, body));
  assert.equal(shield.captures.length, before + 1);
  const original = parseCaptured(shield.captures.at(-1));
  assert.equal(original.status, expectedStatus, original.text);
  const replay = await ctx.mutate(api.baseUrl, path, key, body);
  assert.equal(replay.status, original.status);
  sameJson(replay.json, original.json);
  return original;
}

async function b01(ctx) {
  return guarded(["DURABLE_IDEMPOTENCY"], async () => {
    const seed = seedWithHistories(ctx, "b01", []);
    let { api } = await prepare(ctx, seed);
    const fixedPort = api.port;
    let shield = await ctx.responseShield(api.baseUrl);
    const subjectBody = { name: `B01-${ctx.key("subject")}`, compatibilityMode: "FULL" };
    const subjectKey = ctx.key("b01-subject");
    const originalSubject = await unknownMutation(ctx, shield, api, "/api/v1/subjects", subjectKey, subjectBody, 201);
    const subjectId = originalSubject.json.subjectId;
    const apiTwo = await ctx.startApi();
    const raceBody = { name: `B01-Race-${ctx.key("race")}`, compatibilityMode: "BACKWARD" };
    const raceKey = ctx.key("b01-race-subject");
    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
      index % 2 === 0 ? api.baseUrl : apiTwo.baseUrl,
      "/api/v1/subjects",
      raceKey,
      index % 2 === 0 ? raceBody : { compatibilityMode: "BACKWARD", name: raceBody.name },
    )));
    assert.ok(concurrent.every(({ status }) => status === 201));
    assert.equal(new Set(concurrent.map(({ json }) => canonical(json))).size, 1);
    await ctx.stop(api);
    await api.exited;
    api = await ctx.startApi({ port: fixedPort });
    const restartedSubject = await ctx.mutate(api.baseUrl, "/api/v1/subjects", subjectKey, subjectBody);
    sameJson(restartedSubject.json, originalSubject.json);
    const beforeConflict = stableSnapshot(await ctx.snapshot(api.baseUrl));
    assertExactError(await ctx.mutate(api.baseUrl, "/api/v1/subjects", subjectKey, {
      ...subjectBody, compatibilityMode: "BACKWARD",
    }), 409, "IDEMPOTENCY_CONFLICT");
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeConflict);

    shield = await ctx.responseShield(api.baseUrl);
    const draftBody = { schema: recordSchema("B01", { id: field("STRING", true) }), dependencies: [], expectedHeadVersion: null };
    const draftKey = ctx.key("b01-draft");
    const originalDraft = await unknownMutation(ctx, shield, api, `/api/v1/subjects/${subjectId}/schema-drafts`, draftKey, draftBody, 202);
    assert.equal(originalDraft.json.state, "VALIDATING");
    const beforeDraftConflict = stableSnapshot(await ctx.snapshot(api.baseUrl));
    assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/subjects/${subjectId}/schema-drafts`, draftKey, {
      ...draftBody,
      schema: recordSchema("B01Changed", { id: field("STRING", true) }),
    }), 409, "IDEMPOTENCY_CONFLICT");
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeDraftConflict);

    const worker = await ctx.startWorker();
    await waitDraft(ctx, api, originalDraft.json.draftId, "VALID", { processes: [worker] });
    shield = await ctx.responseShield(api.baseUrl);
    const publishPath = `/api/v1/schema-drafts/${originalDraft.json.draftId}/publish`;
    const originalPublication = await unknownMutation(ctx, shield, api, publishPath, ctx.key("b01-publish"), {}, 201);
    await ctx.stop(api);
    await api.exited;
    api = await ctx.startApi({ port: fixedPort });
    const publicationReplay = await ctx.mutate(api.baseUrl, publishPath, ctx.key("b01-publish"), {});
    sameJson(publicationReplay.json, originalPublication.json);

    shield = await ctx.responseShield(api.baseUrl);
    const modePath = `/api/v1/subjects/${subjectId}/compatibility-mode`;
    const modeBody = { mode: "BACKWARD", expectedRevision: 1 };
    const originalMode = await unknownMutation(ctx, shield, api, modePath, ctx.key("b01-mode"), modeBody, 200);
    await ctx.stop(api);
    await api.exited;
    api = await ctx.startApi({ port: fixedPort });
    sameJson((await ctx.mutate(api.baseUrl, modePath, ctx.key("b01-mode"), modeBody)).json, originalMode.json);

    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    assert.equal(snapshot.resources.subjects.length, 2);
    assert.equal(snapshot.resources.schemaDrafts.length, 1);
    assert.equal(snapshot.resources.schemaVersions.length, 1);
    assert.equal(snapshot.work.filter(({ aggregateId }) => aggregateId === originalDraft.json.draftId).length, 1);
    assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 1);
    assert.equal(snapshot.events.filter(({ type }) => type === "subject.mode-changed").length, 1);
    return result([
      "20 cross-instance identical creates converge on one Subject and exact response",
      "lost Subject, Draft, Publication, and mode-change responses replay across restart while semantic conflicts leave the snapshot unchanged",
    ]);
  });
}

async function b02(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    const seed = seedWithHistories(ctx, "b02", [{ schemas: [recordSchema("B02", { id: field("STRING", true) })] }]);
    const subject = seed.subjects[0];
    const { api } = await prepare(ctx, seed);
    const apiTwo = await ctx.startApi();
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const drafts = await Promise.all(["one", "two"].map((label) => createDraft(ctx, api, subject.subjectId, `b02-${label}`, {
      schema: recordSchema("B02", { id: field("STRING", true), [label]: field("BOOLEAN") }),
      expectedHeadVersion: 1,
    })));
    for (const draft of drafts) await waitDraft(ctx, api, draft.draft.draftId, "VALID", { processes: workers });
    const responses = await Promise.all(drafts.map((draft, index) => ctx.mutate(
      index === 0 ? api.baseUrl : apiTwo.baseUrl,
      `/api/v1/schema-drafts/${draft.draft.draftId}/publish`,
      ctx.key(`b02-publish-${index}`),
      {},
    )));
    assert.equal(responses.filter(({ status }) => status === 201).length, 1);
    const loser = responses.find(({ status }) => status === 409);
    assert.ok(loser);
    assert.equal(loser.json.error.code, "SCHEMA_VALIDATION_STALE");
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    assert.deepEqual(snapshot.resources.schemaVersions.map(({ version }) => version), [1, 2]);
    assert.equal(snapshot.resources.schemaDrafts.filter(({ state }) => state === "PUBLISHED").length, 1);
    assert.equal(snapshot.resources.schemaDrafts.filter(({ state }) => state === "STALE").length, 1);
    assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 1);
    const history = await getSubjectVersions(ctx, api, subject.subjectId);
    assert.deepEqual(history.items.map(({ version }) => version), [1, 2]);
    assert.equal(history.nextCursor, null);
    assertGaplessVersions(history.items);
    return result(["two real API processes and two workers produce one version 2 winner, one exact stale loser, and public history 1..2"]);
  });
}

async function runValidationRace(ctx, { label, seed, mutateDuringHold, build }) {
  const { api } = await prepare(ctx, seed, { build });
  const [target, dependency] = seed.subjects;
  let prerequisite;
  if (label === "head") {
    const worker = await ctx.startWorker();
    prerequisite = await createDraft(ctx, api, target.subjectId, `${label}-winner`, {
      schema: recordSchema("RaceWinner", { id: field("STRING", true), winner: field("BOOLEAN") }),
      expectedHeadVersion: null,
    });
    await waitDraft(ctx, api, prerequisite.draft.draftId, "VALID", { processes: [worker] });
    await ctx.stop(worker);
  } else if (label === "dependency") {
    const worker = await ctx.startWorker();
    prerequisite = await createDraft(ctx, api, dependency.subjectId, `${label}-winner`, {
      schema: recordSchema("Dependency", { id: field("STRING", true), newer: field("BOOLEAN") }),
      expectedHeadVersion: 1,
    });
    await waitDraft(ctx, api, prerequisite.draft.draftId, "VALID", { processes: [worker] });
    await ctx.stop(worker);
  }
  const candidate = await createDraft(ctx, api, target.subjectId, `${label}-candidate`, {
    schema: recordSchema("RaceCandidate", { id: field("STRING", true), candidate: field("BOOLEAN") }),
    dependencies: label === "dependency" ? [{ subjectId: dependency.subjectId, version: 1 }] : [],
    expectedHeadVersion: null,
  });
  const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && payload.aggregateId === candidate.draft.draftId });
  const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const held = await barrier.waitFor((entry) => entry.json?.aggregateId === candidate.draft.draftId && entry.json.point === "worker.before-commit", { processes: [worker] });
  assert.equal(held.json.workId.length > 0, true);
  assert.match(held.json.leaseTokenHash, /^[0-9a-f]{64}$/u);
  requireStatus(await ctx.request(api.baseUrl, "/healthz"), 200, "API while worker is held");
  await ctx.snapshot(api.baseUrl);
  if (mutateDuringHold) await mutateDuringHold({ api, candidate, prerequisite, target, dependency });
  barrier.release(held);
  const expectedState = mutateDuringHold ? "STALE" : "VALID";
  const snapshot = await waitDraft(ctx, api, candidate.draft.draftId, expectedState, { processes: [worker] });
  const persisted = findBy(snapshot.resources.schemaDrafts, "draftId", candidate.draft.draftId);
  assert.equal(persisted.expectedHeadVersion, null);
  assert.equal(persisted.modeRevision, 1);
  assert.equal(persisted.state, expectedState);
  assert.equal(snapshot.resources.schemaVersions.filter(({ subjectId }) => subjectId === target.subjectId).length, label === "head" ? 1 : 0);
  assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, label === "head" || label === "dependency" ? 1 : 0);
  const work = snapshot.work.filter(({ aggregateId }) => aggregateId === candidate.draft.draftId);
  assert.equal(work.length, 1);
  assert.equal(work[0].terminal, true);
}

async function b03(ctx) {
  return guarded(["VERSION_OR_ATOMICITY", "RECOVERY_OR_FENCING"], async () => {
    const scenarios = [
      {
        label: "mode",
        seed: seedWithHistories(ctx, "b03-mode", [{ schemas: [] }]),
        mutateDuringHold: async ({ api, target }) => {
          requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/subjects/${target.subjectId}/compatibility-mode`, ctx.key("b03-mode-change"), {
            mode: "BACKWARD", expectedRevision: 1,
          }), 200, "mode race");
        },
      },
      {
        label: "head",
        seed: seedWithHistories(ctx, "b03-head", [{ schemas: [] }]),
        mutateDuringHold: async ({ api, prerequisite }) => {
          requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${prerequisite.draft.draftId}/publish`, ctx.key("b03-head-publish"), {}), 201, "head race");
        },
      },
      {
        label: "dependency",
        seed: seedWithHistories(ctx, "b03-dependency", [
          { schemas: [] },
          { schemas: [recordSchema("Dependency", { id: field("STRING", true) })] },
        ]),
        mutateDuringHold: async ({ api, prerequisite }) => {
          requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${prerequisite.draft.draftId}/publish`, ctx.key("b03-dependency-publish"), {}), 201, "dependency race");
        },
      },
      { label: "matching", seed: seedWithHistories(ctx, "b03-matching", [{ schemas: [] }]), mutateDuringHold: undefined },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      if (index > 0) await ctx.resetDatabase();
      await runValidationRace(ctx, { ...scenario, build: index === 0 });
    }
    return result(["before-commit barriers independently race mode, head, and dependency CAS; every drift stales and the matching control alone becomes VALID"]);
  });
}

async function b04(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    const seed = seedWithHistories(ctx, "b04", [
      { name: "B04 A", schemas: [] },
      { name: "B04 B", schemas: [] },
    ]);
    const [subjectA, subjectB] = seed.subjects;
    const { api } = await prepare(ctx, seed);
    const apiTwo = await ctx.startApi();
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const bundle = await createBundle(ctx, api, "b04", [
      { subjectId: subjectA.subjectId, expectedHeadVersion: null, schema: recordSchema("BundleA", { id: field("STRING", true) }), dependencies: [] },
      { subjectId: subjectB.subjectId, expectedHeadVersion: null, schema: recordSchema("BundleB", { id: field("STRING", true) }), dependencies: [] },
    ], 200);
    const standalone = await createDraft(ctx, api, subjectA.subjectId, "b04-standalone", {
      schema: recordSchema("StandaloneA", { id: field("STRING", true), standalone: field("BOOLEAN") }),
    });
    await waitBundle(ctx, api, bundle.json.releaseBundleId, "READY", { processes: workers });
    await waitDraft(ctx, api, standalone.draft.draftId, "VALID", { processes: workers });
    const [bundleResponse, standaloneResponse] = await Promise.all([
      ctx.mutate(api.baseUrl, `/api/v1/release-bundles/${bundle.json.releaseBundleId}/publish`, ctx.key("b04-bundle-publish"), {}),
      ctx.mutate(apiTwo.baseUrl, `/api/v1/schema-drafts/${standalone.draft.draftId}/publish`, ctx.key("b04-standalone-publish"), {}),
    ]);
    assert.equal([bundleResponse, standaloneResponse].filter(({ status }) => status >= 200 && status < 300).length, 1);
    assert.equal([bundleResponse, standaloneResponse].filter(({ status }) => status === 409).length, 1);
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    const bundleVersions = snapshot.resources.schemaVersions.filter(({ releaseBundleId }) => releaseBundleId === bundle.json.releaseBundleId);
    const standaloneVersions = snapshot.resources.schemaVersions.filter(({ releaseBundleId }) => releaseBundleId === null);
    if (bundleResponse.status === 200) {
      assert.equal(bundleResponse.json.state, "PUBLISHED");
      assert.equal(standaloneResponse.json.error.code, "SCHEMA_VALIDATION_STALE");
      assert.equal(findBy(snapshot.resources.schemaDrafts, "draftId", standalone.draft.draftId).state, "STALE");
      assert.equal(bundleVersions.length, 2);
      assert.equal(standaloneVersions.length, 0);
      assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 2);
      assert.equal(snapshot.events.filter(({ type }) => type === "bundle.published").length, 1);
    } else {
      assert.equal(bundleResponse.json.error.code, "RELEASE_BUNDLE_STALE");
      assert.equal(standaloneResponse.status, 201);
      assert.equal(findBy(snapshot.resources.releaseBundles, "releaseBundleId", bundle.json.releaseBundleId).state, "STALE");
      assert.equal(bundleVersions.length, 0);
      assert.equal(standaloneVersions.length, 1);
      assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 1);
      assert.equal(snapshot.events.filter(({ type }) => type === "bundle.published").length, 0);
    }
    assert.equal(snapshot.resources.schemaVersions.filter(({ subjectId }) => subjectId === subjectA.subjectId).length, 1);
    assertGaplessVersions(snapshot.resources.schemaVersions);
    return result(["two APIs race Bundle A/B against standalone A and produce exactly one documented winner with no A/B partial mix"]);
  });
}

async function b05(ctx) {
  return guarded(["DURABLE_IDEMPOTENCY", "VERSION_OR_ATOMICITY"], async () => {
    const seed = seedWithHistories(ctx, "b05", Array.from({ length: 20 }, (_, index) => ({ name: `B05 ${index}`, schemas: [] })));
    let { api } = await prepare(ctx, seed);
    const fixedPort = api.port;
    let shield = await ctx.responseShield(api.baseUrl);
    const members = seed.subjects.map((subject, index) => ({
      subjectId: subject.subjectId,
      expectedHeadVersion: null,
      schema: recordSchema(`B05${index}`, { id: field("STRING", true) }),
      dependencies: index === 0 ? [{ kind: "BUNDLE_MEMBER", subjectId: seed.subjects[1].subjectId }] : [],
    }));
    const createKey = ctx.key("b05-bundle");
    const original = await unknownMutation(ctx, shield, api, "/api/v1/release-bundles", createKey, { members }, 200);
    const draftIds = original.json.members.map(({ draftId }) => draftId);
    await ctx.stop(api);
    await api.exited;
    api = await ctx.startApi({ port: fixedPort });
    const apiTwo = await ctx.startApi();
    const replays = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
      index % 2 === 0 ? api.baseUrl : apiTwo.baseUrl,
      "/api/v1/release-bundles",
      createKey,
      { members: index % 2 === 0 ? members : [...members].reverse() },
    )));
    assert.ok(replays.every(({ status, json }) => status === 200 && canonical(json) === canonical(original.json)));
    assert.ok(replays.every(({ json }) => canonical(json.members.map(({ draftId }) => draftId)) === canonical(draftIds)));
    const beforeConflict = stableSnapshot(await ctx.snapshot(api.baseUrl));
    const changedMembers = structuredClone(members);
    changedMembers[0].schema.name = "Changed";
    assertExactError(await ctx.mutate(api.baseUrl, "/api/v1/release-bundles", createKey, { members: changedMembers }), 409, "IDEMPOTENCY_CONFLICT");
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeConflict);

    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await waitBundle(ctx, api, original.json.releaseBundleId, "READY", { processes: workers });
    shield = await ctx.responseShield(api.baseUrl);
    const publishPath = `/api/v1/release-bundles/${original.json.releaseBundleId}/publish`;
    const publishKey = ctx.key("b05-publish");
    const publication = await unknownMutation(ctx, shield, api, publishPath, publishKey, {}, 200);
    const committed = await ctx.snapshot(api.baseUrl);
    const versionIds = committed.resources.schemaVersions.map(({ schemaVersionId }) => schemaVersionId);
    await ctx.stop(api);
    await api.exited;
    api = await ctx.startApi({ port: fixedPort });
    const publicationReplays = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
      index % 2 === 0 ? api.baseUrl : apiTwo.baseUrl, publishPath, publishKey, {},
    )));
    assert.ok(publicationReplays.every(({ status, json }) => status === 200 && canonical(json) === canonical(publication.json)));
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    assert.equal(snapshot.resources.releaseBundles.length, 1);
    assert.equal(snapshot.resources.schemaDrafts.length, 20);
    assert.equal(snapshot.resources.schemaVersions.length, 20);
    assert.deepEqual(snapshot.resources.schemaVersions.map(({ schemaVersionId }) => schemaVersionId), versionIds);
    assert.deepEqual(findBy(snapshot.resources.releaseBundles, "releaseBundleId", original.json.releaseBundleId).members.map(({ draftId }) => draftId), draftIds);
    assert.equal(snapshot.work.filter(({ kind }) => kind === "BUNDLE_VALIDATION").length, 1);
    assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 20);
    assert.equal(snapshot.events.filter(({ type }) => type === "bundle.published").length, 1);
    return result(["20-member create/publish response loss, restart, and cross-instance replay preserve the Bundle, every Draft/Version ID, one Work, and one event set"]);
  });
}

export const B_CASES = [b01, b02, b03, b04, b05].map((run, index) => ({ id: `B-${String(index + 1).padStart(2, "0")}`, run }));
