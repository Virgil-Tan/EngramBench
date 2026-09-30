import assert from "node:assert/strict";

import { canonicalDigest, sha256 } from "../lib/oracle.mjs";
import {
  BUNDLE_KEYS,
  DRAFT_KEYS,
  SUBJECT_KEYS,
  VERSION_KEYS,
  assertExactError,
  assertFinalSnapshot,
  assertSnapshotClosure,
  canonical,
  createBundle,
  createDraft,
  createSubject,
  exactKeys,
  field,
  findBy,
  guarded,
  prepare,
  recordSchema,
  requireStatus,
  result,
  seedWithHistories,
  stableSnapshot,
  waitBundle,
  waitDraft,
  waitSnapshot,
  withBrowser,
} from "./helpers.mjs";

function openApiOperation(document, path, method) {
  const operation = document.paths?.[path]?.[method];
  assert.ok(operation, `OpenAPI is missing ${method.toUpperCase()} ${path}`);
  return operation;
}

function schemaByName(document, name) {
  const schema = document.components?.schemas?.[name];
  assert.ok(schema, `OpenAPI is missing ${name}`);
  return schema;
}

function assertClosedSchema(document, name, keys) {
  const schema = schemaByName(document, name);
  assert.equal(schema.type, "object", `${name} must be an object schema`);
  assert.ok(schema.additionalProperties === false || schema.unevaluatedProperties === false, `${name} must reject unknown fields`);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...keys].sort(), `${name} properties`);
  assert.deepEqual([...(schema.required ?? [])].sort(), [...keys].sort(), `${name} required properties`);
}

function collectEnumStrings(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectEnumStrings(item, result);
  } else if (value && typeof value === "object") {
    if (Array.isArray(value.enum)) for (const item of value.enum) if (typeof item === "string") result.add(item);
    if (typeof value.const === "string") result.add(value.const);
    for (const item of Object.values(value)) collectEnumStrings(item, result);
  }
  return result;
}

async function rawMutation(ctx, api, label, raw, contentType = "application/json") {
  return ctx.request(api.baseUrl, "/api/v1/subjects", {
    method: "POST",
    headers: { "content-type": contentType, "idempotency-key": ctx.key(label) },
    raw,
  });
}

async function d01(ctx) {
  const first = recordSchema("D01", { id: field("STRING", true) });
  const second = recordSchema("D01", { id: field("STRING", true), optional: field("INTEGER") });
  const seed = seedWithHistories(ctx, "d01", [
    { name: "D01 Published", schemas: [first, second] },
    { name: "D01 Empty", schemas: [] },
  ]);
  const [publishedSubject, emptySubject] = seed.subjects;
  const { api } = await prepare(ctx, seed);
  const openapiResponse = await ctx.request(api.baseUrl, "/openapi.json");
  requireStatus(openapiResponse, 200, "OpenAPI");
  const document = openapiResponse.json;
  assert.match(document.openapi, /^3\.1(?:\.|$)/u);
  const operations = [
    ["/api/v1/subjects", "post", "201"],
    ["/api/v1/subjects/{subjectId}/schema-drafts", "post", "202"],
    ["/api/v1/schema-drafts/{draftId}/publish", "post", "201"],
    ["/api/v1/subjects/{subjectId}/compatibility-mode", "post", "200"],
    ["/api/v1/subjects/{subjectId}/versions/latest", "get", "200"],
    ["/api/v1/subjects/{subjectId}/versions/{version}/diff", "get", "200"],
    ["/api/v1/subjects/{subjectId}/versions", "get", "200"],
    ["/api/v1/schema-versions", "get", "200"],
    ["/api/v1/schema-versions/{schemaVersionId}", "get", "200"],
    ["/api/v1/domain-events", "get", "200"],
    ["/api/v1/verification-snapshot", "get", "200"],
    ["/api/v1/release-bundles", "post", "200"],
    ["/api/v1/release-bundles/{releaseBundleId}", "get", "200"],
    ["/api/v1/release-bundles/{releaseBundleId}/publish", "post", "200"],
    ["/api/v1/subjects/{subjectId}/versions/{version}", "get", "200"],
  ];
  for (const [path, method, successStatus] of operations) {
    const operation = openApiOperation(document, path, method);
    assert.ok(operation.responses?.[successStatus], `${method.toUpperCase()} ${path} omits ${successStatus}`);
  }
  assertClosedSchema(document, "Subject", SUBJECT_KEYS);
  assertClosedSchema(document, "SchemaDraft", DRAFT_KEYS);
  assertClosedSchema(document, "SchemaVersion", VERSION_KEYS);
  assertClosedSchema(document, "ReleaseBundle", BUNDLE_KEYS);
  for (const schemaName of ["CompilationFinding", "BundleDependency", "CatalogSnapshotEntry", "Work", "DomainEvent"]) schemaByName(document, schemaName);
  const stableCodes = collectEnumStrings(document);
  for (const code of [
    "UNSUPPORTED_MEDIA_TYPE", "MALFORMED_JSON", "UNKNOWN_FIELD", "INVALID_REQUEST", "INVALID_CURSOR",
    "INVALID_RECORD_SCHEMA", "SCHEMA_VALIDATION_STALE", "RELEASE_BUNDLE_STALE",
    "RELEASE_BUNDLE_INCOMPATIBLE", "IDEMPOTENCY_CONFLICT", "ADMIN_AUTH_REQUIRED", "NOT_FOUND",
  ]) assert.ok(stableCodes.has(code), `OpenAPI does not publish ${code} as a stable value`);

  const subject = await createSubject(ctx, api, "d01-live");
  exactKeys(subject, SUBJECT_KEYS, "live Subject");
  const beforeErrors = stableSnapshot(await ctx.snapshot(api.baseUrl));
  assertExactError(await ctx.mutate(api.baseUrl, "/api/v1/subjects", ctx.key("d01-unknown"), {
    name: "bad", compatibilityMode: "FULL", extra: true,
  }), 400, "UNKNOWN_FIELD");
  assertExactError(await rawMutation(ctx, api, "d01-media", JSON.stringify({ name: "bad", compatibilityMode: "FULL" }), "text/plain"), 415, "UNSUPPORTED_MEDIA_TYPE");
  assertExactError(await rawMutation(ctx, api, "d01-json", "{"), 400, "MALFORMED_JSON");
  assertExactError(await ctx.request(api.baseUrl, "/api/v1/subjects", {
    method: "POST", headers: { "content-type": "application/json" }, json: { name: "missing-key", compatibilityMode: "FULL" },
  }), 400, "INVALID_REQUEST");
  assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/subjects/${publishedSubject.subjectId}/schema-drafts`, ctx.key("d01-dialect"), {
    schema: { ...first, extra: true }, dependencies: [], expectedHeadVersion: 2,
  }), 400, "INVALID_RECORD_SCHEMA");
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeErrors);
  for (const query of ["cursor=not-opaque", "limit=0", "limit=101", "limit=1.5"]) {
    const response = await ctx.request(api.baseUrl, `/api/v1/schema-versions?${query}`);
    assertExactError(response, 400, query.startsWith("cursor") ? "INVALID_CURSOR" : "INVALID_REQUEST");
  }
  assertExactError(await ctx.request(api.baseUrl, `/api/v1/subjects/${ctx.uuid("missing")}/versions/latest`), 404, "NOT_FOUND");
  assertExactError(await ctx.request(api.baseUrl, "/api/v1/verification-snapshot"), 401, "ADMIN_AUTH_REQUIRED");
  assertExactError(await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { headers: { authorization: "Bearer wrong" } }), 401, "ADMIN_AUTH_REQUIRED");

  const pageOne = await ctx.request(api.baseUrl, "/api/v1/schema-versions?limit=1");
  requireStatus(pageOne, 200, "schema version page 1");
  exactKeys(pageOne.json, ["items", "nextCursor"], "schema version collection");
  assert.equal(pageOne.json.items.length, 1);
  assert.equal(typeof pageOne.json.nextCursor, "string");
  const pageTwo = await ctx.request(api.baseUrl, `/api/v1/schema-versions?limit=1&cursor=${encodeURIComponent(pageOne.json.nextCursor)}`);
  requireStatus(pageTwo, 200, "schema version page 2");
  assert.notEqual(pageTwo.json.items[0].schemaVersionId, pageOne.json.items[0].schemaVersionId);
  for (const version of [...pageOne.json.items, ...pageTwo.json.items]) {
    exactKeys(version, VERSION_KEYS, "public SchemaVersion");
    assert.equal(version.releaseBundleId, null);
    const direct = await ctx.request(api.baseUrl, `/api/v1/schema-versions/${version.schemaVersionId}`);
    requireStatus(direct, 200, "SchemaVersion by id");
    assert.deepEqual(direct.json, version);
  }
  const byNumber = await ctx.request(api.baseUrl, `/api/v1/subjects/${publishedSubject.subjectId}/versions/2`);
  requireStatus(byNumber, 200, "SchemaVersion by Subject/version");
  exactKeys(byNumber.json, VERSION_KEYS, "Manager SchemaVersion");
  const diff = await ctx.request(api.baseUrl, `/api/v1/subjects/${publishedSubject.subjectId}/versions/2/diff?against=1`);
  requireStatus(diff, 200, "SchemaDiff");
  exactKeys(diff.json, ["addedFields", "removedFields", "requiredChanges", "typeChanges"], "SchemaDiff");
  assert.deepEqual(diff.json.addedFields, ["optional"]);

  const bundle = await createBundle(ctx, api, "d01-bundle", [{
    subjectId: emptySubject.subjectId,
    expectedHeadVersion: null,
    schema: recordSchema("D01Bundle", { id: field("STRING", true) }),
    dependencies: [],
  }], 200);
  exactKeys(bundle.json, BUNDLE_KEYS, "live ReleaseBundle");
  const bundleRead = await ctx.request(api.baseUrl, `/api/v1/release-bundles/${bundle.json.releaseBundleId}`);
  requireStatus(bundleRead, 200, "ReleaseBundle read");
  assert.deepEqual(bundleRead.json, bundle.json);
  const events = await ctx.request(api.baseUrl, "/api/v1/domain-events?limit=1");
  requireStatus(events, 200, "Domain Event collection");
  exactKeys(events.json, ["items", "nextCursor"], "Domain Event collection");
  return result([
    "OpenAPI 3.1 structurally publishes closed V1/Manager schemas, operations, statuses, and stable code enums",
    "live HTTP verifies media/JSON/key/range/cursor/auth errors, zero-effect rejection, pagination, exact Version/diff/Bundle reads",
  ]);
}

async function visible(locator, label) {
  const selected = locator.filter({ visible: true }).first();
  assert.ok(await selected.count(), `${label} is not exposed by a visible semantic control`);
  return selected;
}

async function d02(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    let { api, worker } = await prepare(ctx, seedWithHistories(ctx, "d02", []), { worker: true });
    const requestedApiPaths = [];
    await withBrowser(ctx, api, async (page) => {
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/v1/")) requestedApiPaths.push(url.pathname);
      });
      await page.getByRole("heading", { name: /schemaharbor/i }).waitFor();
      const subjectName = `Browser-${ctx.key("d02")}`;
      await (await visible(page.getByLabel(/subject.*name|name.*subject/i), "Subject name")).fill(subjectName);
      await (await visible(page.getByLabel(/compatibility.*mode|mode.*compatibility/i), "Compatibility Mode")).selectOption("FULL");
      await (await visible(page.getByRole("button", { name: /create.*subject|add.*subject/i }), "create Subject")).click();
      await page.getByText(subjectName, { exact: true }).waitFor();

      const schemaEditor = await visible(page.getByLabel(/record.*schema|schema.*json|schema/i), "RecordSchema editor");
      await schemaEditor.fill(JSON.stringify(recordSchema("BrowserSchema", { id: field("STRING", true) })));
      await (await visible(page.getByRole("button", { name: /create.*draft|validate.*schema|submit.*draft/i }), "validate Schema Draft")).click();
      await page.getByText("VALID", { exact: true }).waitFor({ timeout: 60_000 });
      await (await visible(page.getByRole("button", { name: /^publish$|publish.*draft/i }), "publish Draft")).click();
      await page.getByText("PUBLISHED", { exact: true }).waitFor({ timeout: 30_000 });

      await schemaEditor.fill(JSON.stringify(recordSchema("BrowserSchema", { id: field("STRING", true), note: field("STRING") })));
      await (await visible(page.getByRole("button", { name: /create.*draft|validate.*schema|submit.*draft/i }), "validate second Draft")).click();
      await page.getByText("VALID", { exact: true }).waitFor({ timeout: 60_000 });
      await (await visible(page.getByRole("button", { name: /^publish$|publish.*draft/i }), "publish second Draft")).click();
      await page.getByText(/version\s*2|v2/iu).first().waitFor({ timeout: 30_000 });
      const historyControl = await visible(page.getByRole("button", { name: /history|versions/i }).or(page.getByRole("link", { name: /history|versions/i })), "history");
      await historyControl.click();
      const diffControl = await visible(page.getByRole("button", { name: /diff|compare/i }).or(page.getByRole("link", { name: /diff|compare/i })), "diff");
      await diffControl.click();
      await page.getByText(/added.*note|note.*added/iu).first().waitFor();

      await schemaEditor.fill(JSON.stringify(recordSchema("BrowserSchema", { id: field("INTEGER", true), note: field("STRING") })));
      await (await visible(page.getByRole("button", { name: /create.*draft|validate.*schema|submit.*draft/i }), "validate incompatible Draft")).click();
      await page.getByText("REJECTED", { exact: true }).waitFor({ timeout: 60_000 });
      await page.getByText(/id|type|incompatible/iu).first().waitFor();

      await ctx.stop(worker);
      const beforeStale = await ctx.snapshot(api.baseUrl);
      const knownDraftIds = new Set(beforeStale.resources.schemaDrafts.map(({ draftId }) => draftId));
      await schemaEditor.fill(JSON.stringify(recordSchema("BrowserSchema", { id: field("STRING", true), note: field("STRING"), stale: field("BOOLEAN") })));
      await (await visible(page.getByRole("button", { name: /create.*draft|validate.*schema|submit.*draft/i }), "validate stale candidate")).click();
      const validating = await waitSnapshot(ctx, api, (snapshot) => snapshot.resources.schemaDrafts.find(({ draftId, state }) => !knownDraftIds.has(draftId) && state === "VALIDATING"), "browser stale Draft creation");
      const staleDraft = validating.resources.schemaDrafts.find(({ draftId }) => !knownDraftIds.has(draftId));
      const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && payload.aggregateId === staleDraft.draftId });
      worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
      const held = await barrier.waitFor((entry) => entry.json?.aggregateId === staleDraft.draftId && entry.json.point === "worker.before-commit", { processes: [worker] });
      const modeControls = page.getByLabel(/compatibility.*mode|mode.*compatibility/i).filter({ visible: true });
      assert.ok(await modeControls.count() >= 1, "Compatibility Mode mutation is not visible");
      await modeControls.last().selectOption("BACKWARD");
      await (await visible(page.getByRole("button", { name: /update.*mode|change.*mode|save.*mode/i }), "change Compatibility Mode")).click();
      barrier.release(held);
      await page.getByText("STALE", { exact: true }).waitFor({ timeout: 60_000 });

      await page.reload({ waitUntil: "networkidle" });
      await page.getByText(/version\s*2|v2/iu).first().waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("heading", { name: /schemaharbor/i }).waitFor();
      await page.keyboard.press("Tab");
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY");

      await page.route("**/api/v1/**", (route) => route.abort("internetdisconnected"));
      const refresh = await visible(page.getByRole("button", { name: /refresh|reload|retry/i }), "retry control");
      await refresh.click();
      await page.getByText(/offline|network|retry|unavailable/iu).first().waitFor({ timeout: 15_000 });
      await page.unroute("**/api/v1/**");
      await refresh.click();
      await page.getByText(/version\s*2|v2/iu).first().waitFor({ timeout: 15_000 });
    });
    assert.ok(requestedApiPaths.some((path) => path.includes("/subjects")));
    assert.ok(requestedApiPaths.some((path) => path.includes("/schema-drafts")));
    assert.ok(requestedApiPaths.some((path) => path.includes("/versions")));
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    const subject = snapshot.resources.subjects.find(({ name }) => name.startsWith("Browser-"));
    assert.ok(subject);
    const versions = snapshot.resources.schemaVersions.filter(({ subjectId }) => subjectId === subject.subjectId);
    assert.deepEqual(versions.map(({ version }) => version), [1, 2]);
    assert.equal(versions[1].canonicalDigest, canonicalDigest(versions[1].schema, versions[1].dependencies));
    assert.equal(snapshot.resources.schemaDrafts.some(({ subjectId, state }) => subjectId === subject.subjectId && state === "REJECTED"), true);
    assert.equal(snapshot.resources.schemaDrafts.some(({ subjectId, state }) => subjectId === subject.subjectId && state === "STALE"), true);
    assert.equal(subject.modeRevision, 2);
    assert.equal(snapshot.events.filter(({ type }) => type === "schema.published").length, 2);
    return result(["production Chromium visible controls create, validate, publish, diff, show findings, refresh, recover from offline state, and remain keyboard/mobile usable against real HTTP/DB/worker state"]);
  });
}

function browserBundleFixture(ctx) {
  const seed = seedWithHistories(ctx, "d03", [
    { name: "Browser Bundle A", schemas: [
      recordSchema("A", { id: field("STRING", true) }),
      recordSchema("A", { id: field("STRING", true), a2: field("INTEGER") }),
    ] },
    { name: "Browser Bundle B", schemas: Array.from({ length: 4 }, (_, index) => {
      const fields = { id: field("STRING", true) };
      for (let fieldIndex = 1; fieldIndex <= index; fieldIndex += 1) fields[`b${fieldIndex}`] = field("INTEGER");
      return recordSchema("B", fields);
    }) },
    { name: "Browser Bundle C", schemas: [recordSchema("C", { id: field("STRING", true) })] },
  ]);
  const [subjectA, subjectB, subjectC] = seed.subjects;
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
  ];
  return { seed, members };
}

async function d03(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    const fixture = browserBundleFixture(ctx);
    const { api, worker } = await prepare(ctx, fixture.seed, { worker: true });
    let successfulId;
    await withBrowser(ctx, api, async (page) => {
      await page.getByRole("heading", { name: /schemaharbor/i }).waitFor();
      await (await visible(page.getByRole("button", { name: /new.*release.*bundle|create.*bundle/i }), "new Release Bundle")).click();
      const editor = await visible(page.getByLabel(/bundle.*member|member.*schema|release.*bundle.*json/i), "Bundle member editor");
      await editor.fill(JSON.stringify({ members: fixture.members }));
      await (await visible(page.getByRole("button", { name: /validate.*bundle|create.*bundle|submit.*bundle/i }), "validate Bundle")).click();
      await page.getByText("READY", { exact: true }).waitFor({ timeout: 60_000 });
      let snapshot = await ctx.snapshot(api.baseUrl);
      const bundle = snapshot.resources.releaseBundles.find(({ state }) => state === "READY");
      assert.ok(bundle);
      successfulId = bundle.releaseBundleId;
      await page.getByText(bundle.releaseBundleId, { exact: true }).waitFor();
      await page.getByText(bundle.canonicalDigest, { exact: true }).waitFor();
      await (await visible(page.getByRole("button", { name: /publish.*bundle/i }), "publish Bundle")).click();
      await page.getByText("PUBLISHED", { exact: true }).waitFor({ timeout: 30_000 });

      await (await visible(page.getByRole("button", { name: /new.*release.*bundle|create.*bundle/i }), "new rejected Bundle")).click();
      const cycle = {
        members: fixture.members.map((member, index) => ({
          ...member,
          expectedHeadVersion: index === 0 ? 3 : 5,
          dependencies: [{ kind: "BUNDLE_MEMBER", subjectId: fixture.members[index === 0 ? 1 : 0].subjectId }],
        })),
      };
      await editor.fill(JSON.stringify(cycle));
      await (await visible(page.getByRole("button", { name: /validate.*bundle|create.*bundle|submit.*bundle/i }), "validate cycle Bundle")).click();
      await page.getByText(/REJECTED|INCOMPATIBLE/iu).first().waitFor({ timeout: 60_000 });
      await page.getByText(/cycle|dependency/iu).first().waitFor();
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText(successfulId, { exact: true }).waitFor();
      await page.getByText("PUBLISHED", { exact: true }).first().waitFor();
    });
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertSnapshotClosure(snapshot);
    const bundle = findBy(snapshot.resources.releaseBundles, "releaseBundleId", successfulId);
    exactKeys(bundle, BUNDLE_KEYS, "browser-created ReleaseBundle");
    assert.equal(bundle.state, "PUBLISHED");
    assert.deepEqual(bundle.members.map(({ prospectiveVersion }) => prospectiveVersion), [3, 5]);
    assert.equal(snapshot.resources.schemaVersions.filter(({ releaseBundleId }) => releaseBundleId === successfulId).length, 2);
    const rejected = snapshot.resources.releaseBundles.filter(({ state }) => state === "REJECTED");
    assert.ok(rejected.length <= 1);
    if (rejected.length === 1) {
      assert.equal(snapshot.resources.schemaVersions.some(({ releaseBundleId }) => releaseBundleId === rejected[0].releaseBundleId), false);
    } else {
      assert.equal(snapshot.resources.releaseBundles.length, 1, "synchronous incompatible rejection must not leave a second Bundle");
    }
    return result(["production Chromium shows worked-example members/catalog/digest, publishes A@3+B@5 atomically, and retains visible combined-cycle failure evidence after refresh"]);
  });
}

async function d04(ctx) {
  return guarded(["VERSION_OR_ATOMICITY"], async () => {
    const base = recordSchema("D04", { id: field("STRING", true) });
    const seed = seedWithHistories(ctx, "d04", [
      { name: "D04 Published", schemas: [base] },
      { name: "D04 Bundle A", schemas: [] },
      { name: "D04 Bundle B", schemas: [] },
      { name: "D04 Pending", schemas: [] },
    ]);
    const [publishedSubject, subjectA, subjectB, pendingSubject] = seed.subjects;
    const { api } = await prepare(ctx, seed);
    let worker = await ctx.startWorker();

    const valid = await createDraft(ctx, api, publishedSubject.subjectId, "d04-valid", {
      schema: recordSchema("D04", { id: field("STRING", true), valid: field("BOOLEAN") }), expectedHeadVersion: 1,
    });
    await waitDraft(ctx, api, valid.draft.draftId, "VALID", { processes: [worker] });
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${valid.draft.draftId}/publish`, ctx.key("d04-valid-publish"), {}), 201, "D04 standalone publish");
    const rejected = await createDraft(ctx, api, publishedSubject.subjectId, "d04-rejected", {
      schema: recordSchema("D04", { id: field("INTEGER", true), valid: field("BOOLEAN") }), expectedHeadVersion: 2,
    });
    await waitDraft(ctx, api, rejected.draft.draftId, "REJECTED", { processes: [worker] });

    const publishedBundle = await createBundle(ctx, api, "d04-published-bundle", [subjectA, subjectB].map((subject, index) => ({
      subjectId: subject.subjectId, expectedHeadVersion: null,
      schema: recordSchema(`D04Bundle${index}`, { id: field("STRING", true) }), dependencies: [],
    })), 200);
    await waitBundle(ctx, api, publishedBundle.json.releaseBundleId, "READY", { processes: [worker] });
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/release-bundles/${publishedBundle.json.releaseBundleId}/publish`, ctx.key("d04-bundle-publish"), {}), 200, "D04 Bundle publish");

    const staleBundle = await createBundle(ctx, api, "d04-stale-bundle", [subjectA, subjectB].map((subject, index) => ({
      subjectId: subject.subjectId, expectedHeadVersion: 1,
      schema: recordSchema(`D04Stale${index}`, { id: field("STRING", true), stale: field("BOOLEAN") }), dependencies: [],
    })), 200);
    await waitBundle(ctx, api, staleBundle.json.releaseBundleId, "READY", { processes: [worker] });
    const headWinner = await createDraft(ctx, api, subjectA.subjectId, "d04-head-winner", {
      schema: recordSchema("D04HeadWinner", { id: field("STRING", true), winner: field("BOOLEAN") }), expectedHeadVersion: 1,
    });
    await waitDraft(ctx, api, headWinner.draft.draftId, "VALID", { processes: [worker] });
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/schema-drafts/${headWinner.draft.draftId}/publish`, ctx.key("d04-head-winner-publish"), {}), 201, "D04 head drift");
    assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/release-bundles/${staleBundle.json.releaseBundleId}/publish`, ctx.key("d04-stale-bundle-publish"), {}), 409, "RELEASE_BUNDLE_STALE");
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/subjects/${subjectB.subjectId}/compatibility-mode`, ctx.key("d04-mode-change"), {
      mode: "BACKWARD", expectedRevision: 1,
    }), 200, "D04 mode event");

    const readyBundle = await createBundle(ctx, api, "d04-ready-bundle", [{
      subjectId: pendingSubject.subjectId, expectedHeadVersion: null,
      schema: recordSchema("D04Ready", { id: field("STRING", true) }), dependencies: [],
    }], 200);
    await waitBundle(ctx, api, readyBundle.json.releaseBundleId, "READY", { processes: [worker] });
    await ctx.stop(worker);

    const leasedDraft = await createDraft(ctx, api, pendingSubject.subjectId, "d04-leased", {
      schema: recordSchema("D04Leased", { id: field("STRING", true), leased: field("BOOLEAN") }),
    });
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.aggregateId === leasedDraft.draft.draftId });
    worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor((entry) => entry.json?.aggregateId === leasedDraft.draft.draftId && entry.json.point === "worker.claimed", { processes: [worker] });
    const pendingDraft = await createDraft(ctx, api, pendingSubject.subjectId, "d04-pending", {
      schema: recordSchema("D04Pending", { id: field("STRING", true), pending: field("BOOLEAN") }),
    });
    const validatingBundle = await createBundle(ctx, api, "d04-validating-bundle", [{
      subjectId: pendingSubject.subjectId, expectedHeadVersion: null,
      schema: recordSchema("D04ValidatingBundle", { id: field("STRING", true), validating: field("BOOLEAN") }), dependencies: [],
    }], 200);

    const mixed = await ctx.snapshot(api.baseUrl);
    assertFinalSnapshot(mixed);
    assertSnapshotClosure(mixed);
    assert.ok(mixed.work.some(({ aggregateId, state }) => aggregateId === leasedDraft.draft.draftId && state === "LEASED"));
    assert.ok(mixed.work.some(({ aggregateId, state }) => aggregateId === pendingDraft.draft.draftId && state === "PENDING"));
    assert.ok(mixed.work.some(({ state }) => state === "SUCCEEDED"));
    assert.equal(mixed.resources.releaseBundles.some(({ state }) => state === "PUBLISHED"), true);
    assert.equal(mixed.resources.releaseBundles.some(({ state }) => state === "READY"), true);
    assert.equal(mixed.resources.releaseBundles.some(({ state }) => state === "STALE"), true);
    assert.equal(findBy(mixed.resources.releaseBundles, "releaseBundleId", validatingBundle.json.releaseBundleId).state, "VALIDATING");
    assert.equal(mixed.resources.schemaDrafts.some(({ state }) => state === "REJECTED"), true);
    assert.equal(mixed.events.some(({ type }) => type === "subject.mode-changed"), true);
    const mixedDigest = sha256(stableSnapshot(mixed));
    assert.match(mixedDigest, /^[0-9a-f]{64}$/u);

    const retainedWorkIds = new Set(mixed.work.map(({ workId }) => workId));
    barrier.release(held);
    const final = await waitSnapshot(ctx, api, (snapshot) => snapshot.work.every(({ terminal }) => terminal), "FINAL Work backlog drains", { timeoutMs: 90_000, processes: [worker] });
    assertSnapshotClosure(final);
    assert.ok([...retainedWorkIds].every((workId) => final.work.some((work) => work.workId === workId)));
    assert.equal(final.resources.schemaVersions.filter(({ releaseBundleId }) => releaseBundleId === publishedBundle.json.releaseBundleId).length, 2);
    assert.equal(final.resources.schemaVersions.every((version) => version.dependencies.every((dependency) => final.resources.schemaVersions.some((candidate) => candidate.subjectId === dependency.subjectId && candidate.version === dependency.version))), true);
    assert.equal(new Set(final.events.map(({ eventId }) => eventId)).size, final.events.length);
    return result([`authorized FINAL snapshots expose exact sorted/redacted catalog closure across pending/leased/terminal Work and retain all ${retainedWorkIds.size} Work rows after drain (mixed digest ${mixedDigest})`]);
  });
}

export const D_CASES = [d01, d02, d03, d04].map((run, index) => ({ id: `D-${String(index + 1).padStart(2, "0")}`, run }));
