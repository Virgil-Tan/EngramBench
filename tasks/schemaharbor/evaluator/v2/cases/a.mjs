import assert from "node:assert/strict";

import {
  assertDependencyCatalog,
  assertGaplessVersions,
  compatibilityFindings,
  expectedCatalogSnapshot,
  releaseBundleOracle,
} from "../lib/oracle.mjs";
import {
  BUNDLE_KEYS,
  assertExactError,
  assertSnapshotClosure,
  canonical,
  createBundle,
  createDraft,
  exactKeys,
  field,
  findBy,
  getBundle,
  guarded,
  prepare,
  recordSchema,
  requireStatus,
  result,
  seedWithHistories,
  stableSnapshot,
  waitBundle,
  waitDraft,
} from "./helpers.mjs";

function headOf(seed, subjectId) {
  return seed.publishedVersions.filter((version) => version.subjectId === subjectId).length || null;
}

function catalogSubjects(seed) {
  return seed.subjects.map((subject) => ({ ...subject, headVersion: headOf(seed, subject.subjectId) }));
}

async function assertNoEffect(ctx, api, before, operation) {
  await operation();
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), before);
}

async function a01(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    const ids = Object.fromEntries(["target", "dep-a", "dep-b", "self", "cycle-a", "cycle-b"].map((name) => [name, ctx.uuid(`a01-${name}`)]));
    const base = recordSchema("Base", { id: field("STRING", true) });
    const seed = seedWithHistories(ctx, "a01", [
      { subjectId: ids.target, name: "A01 Target", schemas: [] },
      { subjectId: ids["dep-a"], name: "A01 Dependency A", schemas: [base] },
      { subjectId: ids["dep-b"], name: "A01 Dependency B", schemas: [base] },
      { subjectId: ids.self, name: "A01 Self", schemas: [base] },
      {
        subjectId: ids["cycle-a"], name: "A01 Cycle A", schemas: [base],
        dependencies: [[{ subjectId: ids["cycle-b"], version: 1 }]],
      },
      { subjectId: ids["cycle-b"], name: "A01 Cycle B", schemas: [base] },
    ]);
    assertDependencyCatalog({ publishedVersions: seed.publishedVersions });
    const { api, worker } = await prepare(ctx, seed, { worker: true });
    const schema = recordSchema("OrderInvariant", {
      enabled: field("BOOLEAN"),
      id: field("STRING", true),
      quantity: field("INTEGER"),
    });
    const dependencies = [
      { subjectId: ids["dep-b"], version: 1 },
      { subjectId: ids["dep-a"], version: 1 },
    ];
    assertDependencyCatalog({
      publishedVersions: seed.publishedVersions,
      additions: [{ subjectId: ids.target, dependencies }],
    });
    const created = await createDraft(ctx, api, ids.target, "a01-valid", {
      schema: { fields: Object.fromEntries(Object.entries(schema.fields).reverse()), name: schema.name },
      dependencies,
      expectedHeadVersion: null,
    });
    let snapshot = await waitDraft(ctx, api, created.draft.draftId, "VALID", { processes: [worker] });
    const draft = findBy(snapshot.resources.schemaDrafts, "draftId", created.draft.draftId);
    assert.equal(draft.canonicalDigest, created.draft.canonicalDigest);
    assert.deepEqual(draft.dependencies, [...dependencies].sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId))));
    assert.equal(snapshot.work.filter(({ aggregateId }) => aggregateId === draft.draftId).length, 1);

    const beforeInvalid = stableSnapshot(snapshot);
    const invalidSchemas = [
      { ...schema, unknown: true },
      recordSchema("Nested", { id: { ...field("STRING", true), nested: {} } }),
      recordSchema("BadName", { Invalid: field("STRING", true) }),
      recordSchema("BadType", { id: field("NUMBER", true) }),
    ];
    for (const [index, invalidSchema] of invalidSchemas.entries()) {
      await assertNoEffect(ctx, api, beforeInvalid, async () => {
        const response = await ctx.mutate(api.baseUrl, `/api/v1/subjects/${ids.target}/schema-drafts`, ctx.key(`a01-invalid-${index}`), {
          schema: invalidSchema, dependencies: [], expectedHeadVersion: null,
        });
        assertExactError(response, 400, "INVALID_RECORD_SCHEMA");
      });
    }

    await assertNoEffect(ctx, api, beforeInvalid, async () => {
      const response = await ctx.request(api.baseUrl, `/api/v1/subjects/${ids.target}/schema-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ctx.key("a01-duplicate-field") },
        raw: `{"schema":{"name":"Duplicate","fields":{"id":{"type":"STRING","required":true},"id":{"type":"INTEGER","required":true}}},"dependencies":[],"expectedHeadVersion":null}`,
      });
      assertExactError(response, 400, "INVALID_RECORD_SCHEMA");
    });

    for (const [label, subjectId, dependency] of [
      ["self", ids.self, { subjectId: ids.self, version: 1 }],
      ["cross", ids["cycle-b"], { subjectId: ids["cycle-a"], version: 1 }],
    ]) {
      await assertNoEffect(ctx, api, beforeInvalid, async () => {
        const response = await ctx.mutate(api.baseUrl, `/api/v1/subjects/${subjectId}/schema-drafts`, ctx.key(`a01-${label}-cycle`), {
          schema: recordSchema(`Cycle${label}`, { id: field("STRING", true), next: field("BOOLEAN") }),
          dependencies: [dependency],
          expectedHeadVersion: 1,
        });
        assertExactError(response, 409, "DEPENDENCY_CYCLE");
      });
    }
    return result([
      "independent RFC 8785/SHA-256 oracle matches permuted fields and normalized published pins",
      "unknown/nested/duplicate dialect members and self/cross-Subject cycles leave Draft, Work, and Event ledgers unchanged",
    ]);
  });
}

async function a02(ctx) {
  const old = recordSchema("Account", { id: field("STRING", true), legacy: field("BOOLEAN") });
  const scenarios = [
    { mode: "BACKWARD", history: [old], prospective: recordSchema("Account", { id: field("STRING"), legacy: field("BOOLEAN"), note: field("STRING") }) },
    { mode: "BACKWARD", history: [old], prospective: recordSchema("Account", { id: field("INTEGER", true), legacy: field("BOOLEAN") }) },
    { mode: "FORWARD", history: [old], prospective: recordSchema("Account", { id: field("STRING", true), added: field("INTEGER", true) }) },
    { mode: "FORWARD", history: [old], prospective: recordSchema("Account", { legacy: field("BOOLEAN") }) },
    { mode: "FULL", history: [old], prospective: recordSchema("Account", { id: field("STRING", true), legacy: field("BOOLEAN"), added: field("INTEGER", true) }) },
    { mode: "FULL", history: [old], prospective: recordSchema("Account", { id: field("STRING", true), legacy: field("BOOLEAN"), added: field("INTEGER") }) },
    {
      mode: "FULL",
      history: [old, recordSchema("Account", { id: field("STRING", true) })],
      versionModes: ["BACKWARD", "FORWARD"],
      versionModeRevisions: [1, 2],
      modeRevision: 3,
      prospective: recordSchema("Account", { id: field("STRING", true) }),
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    if (index > 0) await ctx.resetDatabase();
    const oracle = compatibilityFindings(scenario.mode, scenario.history, scenario.prospective);
    const seed = seedWithHistories(ctx, `a02-${index}`, [{
      compatibilityMode: scenario.mode,
      modeRevision: scenario.modeRevision ?? 1,
      schemas: scenario.history,
      versionModes: scenario.versionModes,
      versionModeRevisions: scenario.versionModeRevisions,
    }]);
    const subject = seed.subjects[0];
    const { api, worker } = await prepare(ctx, seed, { worker: true, build: index === 0 });
    const created = await createDraft(ctx, api, subject.subjectId, `a02-${index}`, {
      schema: scenario.prospective,
      dependencies: [],
      expectedHeadVersion: scenario.history.length,
    });
    const expectedState = oracle.length === 0 ? "VALID" : "REJECTED";
    const snapshot = await waitDraft(ctx, api, created.draft.draftId, expectedState, { processes: [worker] });
    const draft = findBy(snapshot.resources.schemaDrafts, "draftId", created.draft.draftId);
    assert.equal(draft.state, expectedState);
    assert.equal(draft.findings.length === 0, oracle.length === 0);
    assert.deepEqual(draft.findings, [...draft.findings].sort((left, right) => Buffer.from(left.field ?? "").compare(Buffer.from(right.field ?? "")) || left.code.localeCompare(right.code)));
    for (const fieldName of new Set(oracle.map(({ field: name }) => name))) {
      assert.ok(draft.findings.some(({ field: name }) => name === fieldName), `missing finding for ${fieldName}`);
    }
    assert.deepEqual((await ctx.snapshot(api.baseUrl)).resources.schemaDrafts.find(({ draftId }) => draftId === draft.draftId).findings, draft.findings);
    assert.equal(snapshot.resources.schemaVersions.length, scenario.history.length);
    const work = snapshot.work.filter(({ aggregateId }) => aggregateId === draft.draftId);
    assert.equal(work.length, 1);
    assert.equal(work[0].terminal, true);
    if (expectedState === "REJECTED") {
      assert.equal(snapshot.events.filter(({ type }) => type === "schema.rejected").length, 1);
      assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 0);
    }
  }
  return result(["independent all-history interpreter covers required/type/add/remove boundaries for BACKWARD, FORWARD, and FULL"]);
}

async function a03(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    let build = true;
    const setup = async (label, definitions) => {
      if (!build) await ctx.resetDatabase();
      const seed = seedWithHistories(ctx, label, definitions);
      const running = await prepare(ctx, seed, { worker: true, build });
      build = false;
      return { seed, ...running };
    };

    {
      const { seed, api, worker } = await setup("a03-mode", [{ schemas: [] }]);
      const subject = seed.subjects[0];
      const candidate = await createDraft(ctx, api, subject.subjectId, "a03-mode");
      await waitDraft(ctx, api, candidate.draft.draftId, "VALID", { processes: [worker] });
      requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/subjects/${subject.subjectId}/compatibility-mode`, ctx.key("a03-mode-change"), {
        mode: "BACKWARD", expectedRevision: 1,
      }), 200, "mode drift");
      assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${candidate.draft.draftId}/publish`, ctx.key("a03-mode-publish"), {}), 409, "SCHEMA_VALIDATION_STALE");
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.equal(findBy(snapshot.resources.schemaDrafts, "draftId", candidate.draft.draftId).state, "STALE");
      assert.equal(snapshot.resources.schemaVersions.length, 0);
      assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 0);
    }

    {
      const { seed, api, worker } = await setup("a03-head", [{ schemas: [] }]);
      const subject = seed.subjects[0];
      const candidates = await Promise.all(["stale", "winner"].map((label) => createDraft(ctx, api, subject.subjectId, `a03-head-${label}`, {
        schema: recordSchema(`Head${label}`, { id: field("STRING", true), [label]: field("BOOLEAN") }),
      })));
      for (const candidate of candidates) await waitDraft(ctx, api, candidate.draft.draftId, "VALID", { processes: [worker] });
      requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${candidates[1].draft.draftId}/publish`, ctx.key("a03-head-winner"), {}), 201, "head winner");
      assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${candidates[0].draft.draftId}/publish`, ctx.key("a03-head-stale"), {}), 409, "SCHEMA_VALIDATION_STALE");
      const snapshot = await ctx.snapshot(api.baseUrl);
      assertGaplessVersions(snapshot.resources.schemaVersions);
      assert.deepEqual(snapshot.resources.schemaVersions.map(({ version }) => version), [1]);
      assert.equal(findBy(snapshot.resources.schemaDrafts, "draftId", candidates[0].draft.draftId).state, "STALE");
    }

    {
      const base = recordSchema("Dependency", { id: field("STRING", true) });
      const { seed, api, worker } = await setup("a03-dependency", [{ schemas: [] }, { schemas: [base] }]);
      const [target, dependency] = seed.subjects;
      const candidate = await createDraft(ctx, api, target.subjectId, "a03-dependency-target", {
        dependencies: [{ subjectId: dependency.subjectId, version: 1 }],
      });
      const dependencyDraft = await createDraft(ctx, api, dependency.subjectId, "a03-dependency-head", {
        schema: recordSchema("Dependency", { id: field("STRING", true), note: field("STRING") }),
        expectedHeadVersion: 1,
      });
      await waitDraft(ctx, api, candidate.draft.draftId, "VALID", { processes: [worker] });
      await waitDraft(ctx, api, dependencyDraft.draft.draftId, "VALID", { processes: [worker] });
      requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${dependencyDraft.draft.draftId}/publish`, ctx.key("a03-dependency-winner"), {}), 201, "dependency head winner");
      assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${candidate.draft.draftId}/publish`, ctx.key("a03-dependency-stale"), {}), 409, "SCHEMA_VALIDATION_STALE");
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.equal(findBy(snapshot.resources.schemaDrafts, "draftId", candidate.draft.draftId).state, "STALE");
      assert.equal(snapshot.resources.schemaVersions.filter(({ subjectId }) => subjectId === target.subjectId).length, 0);
    }

    {
      const { seed, api, worker } = await setup("a03-control", [{ schemas: [] }]);
      const subject = seed.subjects[0];
      const candidate = await createDraft(ctx, api, subject.subjectId, "a03-control");
      await waitDraft(ctx, api, candidate.draft.draftId, "VALID", { processes: [worker] });
      const published = await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${candidate.draft.draftId}/publish`, ctx.key("a03-control-publish"), {});
      requireStatus(published, 201, "matching publication");
      assert.deepEqual(Object.keys(published.json).sort(), ["draft", "version"]);
      assert.equal(published.json.version.version, 1);
      const snapshot = await ctx.snapshot(api.baseUrl);
      assertGaplessVersions(snapshot.resources.schemaVersions);
      assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 1);
    }
    return result(["head, modeRevision, and dependency-head drift each stale the frozen Draft without a version; an unchanged snapshot assigns exactly head + 1"]);
  });
}

async function a04(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    const definitions = Array.from({ length: 22 }, (_, index) => ({
      name: index === 21 ? "A04 External" : `A04 Member ${index}`,
      compatibilityMode: "FULL",
      schemas: index === 0 || index === 21 ? [recordSchema(`A04Base${index}`, { id: field("STRING", true) })] : [],
    }));
    const seed = seedWithHistories(ctx, "a04", definitions);
    const members20 = seed.subjects.slice(0, 20).map((subject, index) => ({
      subjectId: subject.subjectId,
      expectedHeadVersion: headOf(seed, subject.subjectId),
      schema: recordSchema(`A04Member${index}`, { id: field("STRING", true), optional: field("INTEGER") }),
      dependencies: index === 0
        ? [{ kind: "BUNDLE_MEMBER", subjectId: seed.subjects[1].subjectId }]
        : index === 1
          ? [{ kind: "PUBLISHED", subjectId: seed.subjects[21].subjectId, version: 1 }]
          : [],
    }));
    const referenced = [...members20.map(({ subjectId }) => subjectId), seed.subjects[21].subjectId];
    const expectedCatalog = expectedCatalogSnapshot(catalogSubjects(seed), referenced);
    const oracle = releaseBundleOracle({ members: members20, catalogSnapshot: expectedCatalog, publishedVersions: seed.publishedVersions });
    const { api, worker } = await prepare(ctx, seed, { worker: true });
    const created = await createBundle(ctx, api, "a04-twenty", [...members20].reverse(), 200);
    exactKeys(created.json, BUNDLE_KEYS, "ReleaseBundle create");
    assert.equal(created.json.state, "VALIDATING");
    assert.deepEqual(created.json.catalogSnapshot, oracle.catalogSnapshot);
    assert.deepEqual(created.json.members.map(({ subjectId }) => subjectId), oracle.members.map(({ subjectId }) => subjectId));
    assert.deepEqual(created.json.members.map(({ prospectiveVersion }) => prospectiveVersion), oracle.members.map(({ expectedHeadVersion }) => (expectedHeadVersion ?? 0) + 1));
    assert.equal(new Set(created.json.members.map(({ draftId }) => draftId)).size, 20);
    assert.equal(created.json.canonicalDigest, oracle.canonicalDigest);
    assert.deepEqual(await getBundle(ctx, api, created.json.releaseBundleId), created.json);
    let snapshot = await waitBundle(ctx, api, created.json.releaseBundleId, "READY", { processes: [worker] });
    assert.equal(snapshot.resources.schemaDrafts.length, 20);
    assert.equal(snapshot.work.filter(({ kind, aggregateId }) => kind === "BUNDLE_VALIDATION" && aggregateId === created.json.releaseBundleId).length, 1);

    const singleMember = [{
      subjectId: seed.subjects[20].subjectId,
      expectedHeadVersion: null,
      schema: recordSchema("A04Single", { id: field("STRING", true) }),
      dependencies: [],
    }];
    const single = await createBundle(ctx, api, "a04-single", singleMember, 200);
    await waitBundle(ctx, api, single.json.releaseBundleId, "READY", { processes: [worker] });
    assert.equal(single.json.members.length, 1);

    const beforeRangeFailure = stableSnapshot(await ctx.snapshot(api.baseUrl));
    const members21 = seed.subjects.slice(0, 21).map((subject, index) => ({
      subjectId: subject.subjectId,
      expectedHeadVersion: headOf(seed, subject.subjectId),
      schema: recordSchema(`TooMany${index}`, { id: field("STRING", true) }),
      dependencies: [],
    }));
    await assertNoEffect(ctx, api, beforeRangeFailure, async () => {
      assertExactError(await ctx.mutate(api.baseUrl, "/api/v1/release-bundles", ctx.key("a04-21"), { members: members21 }), 400, "INVALID_REQUEST");
    });

    for (const [label, invalidMembers] of [
      ["cycle", [
        { ...members20[2], dependencies: [{ kind: "BUNDLE_MEMBER", subjectId: members20[3].subjectId }] },
        { ...members20[3], dependencies: [{ kind: "BUNDLE_MEMBER", subjectId: members20[2].subjectId }] },
      ]],
      ["incompatible", [{
        ...members20[0],
        schema: recordSchema("A04Incompatible", { id: field("INTEGER", true) }),
        dependencies: [],
      }]],
    ]) {
      const before = await ctx.snapshot(api.baseUrl);
      const response = await ctx.mutate(api.baseUrl, "/api/v1/release-bundles", ctx.key(`a04-${label}`), { members: invalidMembers });
      requireStatus(response, [200, 409], `${label} bundle`);
      if (response.status === 409) {
        assert.equal(response.json.error.code, "RELEASE_BUNDLE_INCOMPATIBLE");
        assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before));
      } else {
        snapshot = await waitBundle(ctx, api, response.json.releaseBundleId, "REJECTED", { processes: [worker] });
        assert.equal(findBy(snapshot.resources.releaseBundles, "releaseBundleId", response.json.releaseBundleId).findings.length > 0, true);
        assert.equal(snapshot.resources.schemaDrafts.length, before.resources.schemaDrafts.length + invalidMembers.length);
        assert.equal(snapshot.resources.schemaVersions.length, seed.publishedVersions.length);
        assert.equal(snapshot.events.filter(({ type }) => type === "schema.published" || type === "bundle.published").length, 0);
      }
    }
    return result([
      "1/20/21-member public fixtures verify frozen catalog, prospective versions, stable Draft IDs, dependency ordering, and evaluator-owned digest",
      "combined cycles and incompatibility produce one whole rejected aggregate or no aggregate, never partial Drafts or Publications",
    ], { blockedAssertions: [{ assertionId: "incompatible-http-trigger", blockedBy: "SPEC-GAP-SH-02" }] });
  });
}

function bundleFixture(ctx, label) {
  const definitions = [
    { name: `${label} A`, schemas: [
      recordSchema("A", { id: field("STRING", true) }),
      recordSchema("A", { id: field("STRING", true), a2: field("INTEGER") }),
    ] },
    { name: `${label} B`, schemas: Array.from({ length: 4 }, (_, index) => {
      const fields = { id: field("STRING", true) };
      for (let fieldIndex = 1; fieldIndex <= index; fieldIndex += 1) fields[`b${fieldIndex}`] = field("INTEGER");
      return recordSchema("B", fields);
    }) },
    { name: `${label} C`, schemas: [recordSchema("C", { id: field("STRING", true) })] },
    ...Array.from({ length: 18 }, (_, index) => ({ name: `${label} Extra ${index}`, schemas: [] })),
  ];
  const seed = seedWithHistories(ctx, label, definitions);
  const [subjectA, subjectB, subjectC, ...extras] = seed.subjects;
  const members = [
    {
      subjectId: subjectA.subjectId,
      expectedHeadVersion: 2,
      schema: recordSchema("A", { id: field("STRING", true), a2: field("INTEGER"), a3: field("BOOLEAN") }),
      dependencies: [{ kind: "BUNDLE_MEMBER", subjectId: subjectB.subjectId }],
    },
    {
      subjectId: subjectB.subjectId,
      expectedHeadVersion: 4,
      schema: recordSchema("B", { id: field("STRING", true), b1: field("INTEGER"), b2: field("INTEGER"), b3: field("INTEGER"), b5: field("BOOLEAN") }),
      dependencies: [{ kind: "PUBLISHED", subjectId: subjectC.subjectId, version: 1 }],
    },
    ...extras.map((subject, index) => ({
      subjectId: subject.subjectId,
      expectedHeadVersion: null,
      schema: recordSchema(`Extra${index}`, { id: field("STRING", true) }),
      dependencies: [],
    })),
  ];
  return { seed, members, subjectA, subjectB, subjectC };
}

async function a05(ctx) {
  return guarded(["VERSION_OR_ATOMICITY", "EVENT_ATOMICITY_OR_IDENTITY"], async () => {
    const successful = bundleFixture(ctx, "a05-success");
    let { api, worker } = await prepare(ctx, successful.seed, { worker: true });
    const created = await createBundle(ctx, api, "a05-success", successful.members, 200);
    await waitBundle(ctx, api, created.json.releaseBundleId, "READY", { processes: [worker] });
    const published = await ctx.mutate(api.baseUrl, `/api/v1/release-bundles/${created.json.releaseBundleId}/publish`, ctx.key("a05-success-publish"), {});
    requireStatus(published, 200, "bundle publish");
    exactKeys(published.json, BUNDLE_KEYS, "published ReleaseBundle");
    assert.equal(published.json.state, "PUBLISHED");
    assert.deepEqual(await getBundle(ctx, api, created.json.releaseBundleId), published.json);
    let snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    const versions = snapshot.resources.schemaVersions.filter(({ releaseBundleId }) => releaseBundleId === created.json.releaseBundleId);
    assert.equal(versions.length, 20);
    assert.deepEqual(versions.map(({ version }) => version).sort((left, right) => left - right), [
      ...Array.from({ length: 18 }, () => 1), 3, 5,
    ].sort((left, right) => left - right));
    for (const member of published.json.members) {
      assert.equal(findBy(snapshot.resources.schemaDrafts, "draftId", member.draftId).state, "PUBLISHED");
      assert.ok(versions.some((version) => version.subjectId === member.subjectId
        && version.version === member.prospectiveVersion && version.releaseBundleId === published.json.releaseBundleId));
    }
    const memberEvents = snapshot.events.filter(({ type }) => type === "schema.published");
    const bundleEvents = snapshot.events.filter(({ type }) => type === "bundle.published");
    assert.equal(memberEvents.length, 20);
    assert.equal(bundleEvents.length, 1);
    assert.equal(new Set([...memberEvents, ...bundleEvents].map(({ eventId }) => eventId)).size, 21);
    assert.ok([...memberEvents, ...bundleEvents].every(({ payload }) => canonical(payload) === "{}"));

    const receiver = await ctx.receiver({ path: "/events" });
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const committed = [...memberEvents, ...bundleEvents];
    await ctx.waitFor(() => committed.every((event) => receiver.ledger.some((entry) => (
      entry.headers["x-schemaharbor-event-id"] === event.eventId
      && entry.headers["x-schemaharbor-event-type"] === event.type
      && canonical(entry.json) === canonical(event)
    ))), { timeoutMs: 90_000, label: "all bundle publication events delivered", processes: [dispatcher] });

    await ctx.resetDatabase();
    const staleFixture = bundleFixture(ctx, "a05-stale");
    ({ api, worker } = await prepare(ctx, staleFixture.seed, { worker: true, build: false }));
    const staleBundle = await createBundle(ctx, api, "a05-stale", staleFixture.members.slice(0, 2), 200);
    await waitBundle(ctx, api, staleBundle.json.releaseBundleId, "READY", { processes: [worker] });
    const standalone = await createDraft(ctx, api, staleFixture.subjectB.subjectId, "a05-standalone-b", {
      schema: recordSchema("B", {
        id: field("STRING", true), b1: field("INTEGER"), b2: field("INTEGER"), b3: field("INTEGER"), standalone: field("BOOLEAN"),
      }),
      expectedHeadVersion: 4,
    });
    await waitDraft(ctx, api, standalone.draft.draftId, "VALID", { processes: [worker] });
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${standalone.draft.draftId}/publish`, ctx.key("a05-standalone-publish"), {}), 201, "standalone drift");
    const beforeStale = await ctx.snapshot(api.baseUrl);
    assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/release-bundles/${staleBundle.json.releaseBundleId}/publish`, ctx.key("a05-stale-publish"), {}), 409, "RELEASE_BUNDLE_STALE");
    snapshot = await ctx.snapshot(api.baseUrl);
    assert.equal(findBy(snapshot.resources.releaseBundles, "releaseBundleId", staleBundle.json.releaseBundleId).state, "STALE");
    assert.equal(snapshot.resources.schemaVersions.length, beforeStale.resources.schemaVersions.length);
    assert.equal(snapshot.resources.schemaVersions.some(({ releaseBundleId }) => releaseBundleId === staleBundle.json.releaseBundleId), false);
    assert.equal(snapshot.events.filter(({ type }) => type === "bundle.published").length, 0);
    assertGaplessVersions(snapshot.resources.schemaVersions);
    return result([
      "20 member Drafts, next versions, releaseBundleId links, and stable event bodies publish in one closed transaction",
      "worked-example dependency-head drift stales the whole Bundle and leaves A untouched while B has only the standalone next version",
    ], { blockedAssertions: [{ assertionId: "cross-aggregate-event-order", blockedBy: "SPEC-GAP-SH-01" }] });
  });
}

export const A_CASES = [a01, a02, a03, a04, a05].map((run, index) => ({ id: `A-${String(index + 1).padStart(2, "0")}`, run }));
