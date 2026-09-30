import assert from "node:assert/strict";

import { ndjsonBytes, rowFixture } from "../lib/fixtures.mjs";
import {
  assertBundle,
  assertBundleMember,
  assertExactKeys,
  assertImportJob,
  assertRecord,
  assertTimestamp,
  canonical,
  modelNdjson,
} from "../lib/oracle.mjs";
import {
  CORRECTNESS_CAP,
  allFindings,
  allRecords,
  assertEventSequences,
  assertModeledFindings,
  assertModeledRecords,
  assertNoSensitiveMaterial,
  assertReport,
  assertUnique,
  commitAndWait,
  createImport,
  createValidatedImport,
  defineCase,
  eventsOf,
  expectBundle,
  expectBundleMember,
  expectImport,
  resource,
  result,
  seedCatalogs,
  startScenario,
  waitForBundle,
  waitForImport,
  waitForReport,
  workOf,
} from "./helpers.mjs";

const SNAPSHOT_RESOURCES = [
  "bundleMembers", "committedRecords", "errorReports", "importBundles", "imports",
  "schemaRevisions", "schemas", "tenants", "uploadChunks", "validationFindings",
];

async function fillSemantic(page, names, value, options = {}) {
  for (const name of names) {
    const labelled = page.getByLabel(name);
    if (await labelled.count()) {
      const control = labelled.first();
      if (options.select) await control.selectOption({ label: value }).catch(() => control.selectOption(value));
      else await control.fill(String(value));
      return control;
    }
  }
  const candidates = page.locator(options.select ? "select" : "input:not([type=file]):not([type=hidden]), textarea");
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    const signature = [
      await candidate.getAttribute("name"), await candidate.getAttribute("id"),
      await candidate.getAttribute("placeholder"), await candidate.getAttribute("aria-label"),
    ].filter(Boolean).join(" ");
    if (names.some((pattern) => pattern.test(signature))) {
      if (options.select) await candidate.selectOption({ label: value }).catch(() => candidate.selectOption(value));
      else await candidate.fill(String(value));
      return candidate;
    }
  }
  if (options.optional) return undefined;
  throw new Error(`no labelled production control for ${names.map(String).join("/")}`);
}

async function clickSemantic(page, names, options = {}) {
  for (const name of names) {
    for (const role of ["button", "link"]) {
      const locator = page.getByRole(role, { name });
      if (await locator.count()) {
        await locator.first().click();
        return locator.first();
      }
    }
  }
  if (options.optional) return undefined;
  throw new Error(`no production action for ${names.map(String).join("/")}`);
}

async function loadImportUi(page, importId) {
  await fillSemantic(page, [/import.*id/iu, /导入.*id/u], importId, { optional: true });
  await clickSemantic(page, [/load|view|inspect|open/iu, /查看|加载|打开/u], { optional: true });
  await page.waitForFunction((id) => document.body.innerText.includes(id), importId, { timeout: 15_000 });
}

function oneMibNdjson() {
  const target = 1024 * 1024;
  const lines = [];
  let length = 0;
  let index = 0;
  const tailObject = rowFixture(9_999_999, { externalId: "ui-tail", email: "tail@example.test" });
  const tail = JSON.stringify(tailObject);
  while (true) {
    const line = Buffer.from(`${JSON.stringify(rowFixture(index, { externalId: `ui-${index}`, email: `ui-${index}@example.test` }))}\n`);
    if (target - (length + line.length) < Buffer.byteLength(tail) + 1) break;
    lines.push(line);
    length += line.length;
    index += 1;
  }
  const padding = target - length - Buffer.byteLength(tail) - 1;
  assert.ok(padding >= 0);
  lines.push(Buffer.from(`${tail}${" ".repeat(padding)}\n`));
  const bytes = Buffer.concat(lines);
  assert.equal(bytes.length, target);
  return bytes;
}

async function d01(ctx) {
  const catalog = ctx.catalog("ui-upload");
  await seedCatalogs(ctx, catalog, "ui-upload");
  const build = await ctx.npm("build", [], { timeoutMs: 600_000, allowFailure: true });
  ctx.equal("production build exits zero", build.exitCode, 0, { failureCodeSuffix: "BUILD_FAILED" });
  let dev = await ctx.startDev({ env: { NODE_ENV: "production" } });
  const worker = await ctx.startWorker();
  const bytes = oneMibNdjson();
  let importId;
  const chunkAttempts = [];
  let dropped = false;
  await ctx.withPage(dev, { width: 390, height: 844 }, async (page) => {
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (response.request().method() === "POST" && url.pathname === "/api/v1/imports" && response.status() === 200) {
        importId = (await response.json()).importId;
      }
    });
    await page.route("**/api/v1/imports/*/chunks/*", async (route) => {
      chunkAttempts.push(new URL(route.request().url()).pathname);
      const upstream = await route.fetch();
      if (!dropped) {
        dropped = true;
        await route.abort("connectionreset");
      } else await route.fulfill({ response: upstream });
    });
    await page.goto(dev.baseUrl, { waitUntil: "networkidle" });
    await fillSemantic(page, [/tenant/iu, /租户/u], catalog.tenant.tenantId);
    await fillSemantic(page, [/dataset/iu, /数据集/u], catalog.schema.datasetKey);
    await fillSemantic(page, [/schema.*revision|revision/iu, /版本/u], "1", { optional: true });
    await fillSemantic(page, [/commit.*mode/iu, /提交.*模式/u], "VALID_ROWS", { select: true, optional: true });
    const file = page.locator('input[type="file"]');
    ctx.ok("production UI exposes a file control", await file.count() > 0);
    await file.first().setInputFiles({ name: "ui-resume.ndjson", mimeType: "application/x-ndjson", buffer: bytes });
    await clickSemantic(page, [/create|start.*import|import/iu, /创建|开始.*导入|导入/u]);
    await ctx.waitFor(() => importId, { timeoutMs: 20_000, label: "UI create-import response" });
    await clickSemantic(page, [/upload|resume/iu, /上传|继续/u], { optional: true });
    await ctx.waitFor(() => dropped, { timeoutMs: 20_000, label: "durable chunk with unknown browser outcome" });
    await page.waitForTimeout(100);
    ctx.ok("UI visibly reports an interrupted upload", /error|retry|resume|failed|恢复|重试|失败/iu.test(await page.locator("body").innerText()));

    await ctx.stop(dev, "SIGKILL");
    dev = await ctx.startDev({ port: dev.port, env: { NODE_ENV: "production" } });
    await page.goto(dev.baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload({ waitUntil: "networkidle" });
    await loadImportUi(page, importId);
    const resumedFile = page.locator('input[type="file"]');
    if (await resumedFile.count()) await resumedFile.first().setInputFiles({ name: "ui-resume.ndjson", mimeType: "application/x-ndjson", buffer: bytes });
    await clickSemantic(page, [/resume|upload|continue/iu, /继续|上传|恢复/u], { optional: true });
    await ctx.waitFor(async () => {
      const detail = await ctx.getImport(dev.baseUrl, importId);
      return detail.status === 200 && detail.json.receivedBytes === bytes.length ? detail.json : undefined;
    }, { timeoutMs: 90_000, intervalMs: 100, label: "UI resumable byte coverage", processes: [dev] });
    await clickSemantic(page, [/complete|finish/iu, /完成/u], { optional: true });
    const validated = await waitForImport(ctx, dev.baseUrl, importId, ["UPLOADED", "VALIDATING", "VALIDATED"], { timeoutMs: 90_000, processes: [worker] });
    ctx.equal("browser-upload source digest is exact", validated.expectedSha256, ctx.sha256(bytes), CORRECTNESS_CAP);
    ctx.equal("browser-upload byte coverage is exact", validated.receivedBytes, bytes.length, CORRECTNESS_CAP);
    await loadImportUi(page, importId);
    const text = await page.locator("body").innerText();
    ctx.ok("UI renders public progress/state after recovery", text.includes(String(bytes.length)) || /100\s*%|uploaded|validated|已上传|已验证/iu.test(text));
    await page.keyboard.press("Tab");
    ctx.ok("mobile UI has a keyboard-focusable control", await page.evaluate(() => document.activeElement && document.activeElement !== document.body));
    ctx.equal("UI issued resumable chunk HTTP requests", chunkAttempts.length > 0, true);
  });
  return result(ctx, "production Chromium created a 1 MiB import, survived an unknown chunk response and process restart, resumed and completed with API-consistent progress");
}

async function d02(ctx) {
  const catalog = ctx.catalog("ui-commit-bundle");
  await seedCatalogs(ctx, catalog, "ui-commit-bundle");
  const build = await ctx.npm("build", [], { timeoutMs: 600_000, allowFailure: true });
  ctx.equal("production build exits zero", build.exitCode, 0, { failureCodeSuffix: "BUILD_FAILED" });
  const dev = await ctx.startDev({ env: { NODE_ENV: "production" } });
  const worker = await ctx.startWorker();
  const sentinel = `IW-UI-RAW-${ctx.key("sentinel")}`;
  const mixed = await createValidatedImport(ctx, dev.baseUrl, catalog, ndjsonBytes([
    rowFixture(1, { externalId: "ui-valid" }),
    rowFixture(2, { externalId: "ui-invalid", email: sentinel, age: "bad" }),
  ]), { label: "UI mixed import", processes: [worker] });
  const report = await waitForReport(ctx, dev.baseUrl, mixed.job.importId, ["READY"], { processes: [worker] });
  const cancellable = await createImport(ctx, dev.baseUrl, catalog, ndjsonBytes([rowFixture(3, { externalId: "ui-cancel" })]), { label: "UI cancel source" });
  const bundleSource = await createValidatedImport(ctx, dev.baseUrl, catalog, ndjsonBytes([
    rowFixture(4, { externalId: "ui-bundle" }),
  ]), { label: "UI Bundle source", processes: [worker] });

  let bundleId;
  await ctx.withPage(dev, { width: 1280, height: 800 }, async (page) => {
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (response.request().method() === "POST" && url.pathname === "/api/v1/import-bundles" && response.status() === 200) {
        bundleId = (await response.json()).bundleId;
      }
    });
    await page.goto(dev.baseUrl, { waitUntil: "networkidle" });
    await loadImportUi(page, mixed.job.importId);
    const mixedText = await page.locator("body").innerText();
    ctx.ok("UI exposes validation totals and finding code", mixedText.includes("WRONG_TYPE") && mixedText.includes(String(mixed.validated.invalidRows)));
    ctx.ok("UI exposes READY ErrorReport metadata", mixedText.includes(report.reportId) || /report.*ready|报告.*就绪/iu.test(mixedText));
    ctx.equal("UI never renders the raw rejected sentinel", mixedText.includes(sentinel), false, CORRECTNESS_CAP);
    const commitResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/imports/${mixed.job.importId}/commit`));
    await clickSemantic(page, [/commit/iu, /提交/u]);
    ctx.equal("UI commit calls the public mutation", (await commitResponse).status(), 200);
    await waitForImport(ctx, dev.baseUrl, mixed.job.importId, "PARTIALLY_COMMITTED", { processes: [worker] });

    await loadImportUi(page, cancellable.job.importId);
    const cancelResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/imports/${cancellable.job.importId}/cancel`));
    await clickSemantic(page, [/cancel|abort/iu, /取消|中止/u]);
    ctx.equal("UI cancel calls the public mutation", (await cancelResponse).status(), 200);
    await waitForImport(ctx, dev.baseUrl, cancellable.job.importId, "CANCELLED");

    await fillSemantic(page, [/bundle.*tenant|tenant/iu, /Bundle.*租户|租户/u], catalog.tenant.tenantId);
    await fillSemantic(page, [/bundle.*name|name/iu, /Bundle.*名称|名称/u], "UI Atomic Bundle");
    await clickSemantic(page, [/create.*bundle|new.*bundle/iu, /创建.*Bundle/u]);
    await ctx.waitFor(() => bundleId, { timeoutMs: 20_000, label: "UI Bundle creation" });
    await fillSemantic(page, [/member.*import|import.*id/iu, /成员.*导入/u], bundleSource.job.importId);
    await clickSemantic(page, [/add.*member/iu, /添加.*成员/u]);
    await clickSemantic(page, [/stage/iu, /暂存|冻结/u]);
    await clickSemantic(page, [/publish/iu, /发布/u]);
    await waitForBundle(ctx, dev.baseUrl, bundleId, "PUBLISHED");
    const body = await page.locator("body").innerText();
    ctx.ok("UI renders the Bundle terminal state", body.includes(bundleId) && /published|已发布/iu.test(body));
    ctx.equal("UI Bundle flow does not reveal private material", body.includes(ctx.managedDataRoot), false, CORRECTNESS_CAP);
  });
  const records = await allRecords(ctx, dev.baseUrl, catalog.tenant.tenantId, catalog.schema.datasetKey);
  ctx.equal("UI commit publishes exactly its one valid row", records.filter(({ sourceImportId }) => sourceImportId === mixed.job.importId).length, 1, CORRECTNESS_CAP);
  ctx.equal("UI Bundle publishes exactly its member row", records.filter(({ sourceImportId }) => sourceImportId === bundleSource.job.importId).length, 1, CORRECTNESS_CAP);
  ctx.blocked("ui-error-report-download-bytes", "IW-GAP-01");
  ctx.blocked("ui-bundle-refresh-history", "IW-GAP-02");
  return result(ctx, "production UI rendered redacted findings/report metadata and drove commit, cancel, and Bundle mutations to durable terminal states");
}

function operation(openapi, method, path) {
  const value = openapi.paths?.[path]?.[method.toLowerCase()];
  assert.ok(value, `OpenAPI is missing ${method} ${path}`);
  return value;
}

function assertSuccessSchema(openapi, operationValue, component) {
  const success = operationValue.responses?.["200"];
  assert.ok(success, "mutation must publish the default 200 success status");
  const schema = success.content?.["application/json"]?.schema;
  assert.ok(schema, "200 response must publish an application/json schema");
  const selected = schema.$ref?.startsWith("#/components/schemas/")
    ? openapi.components.schemas[schema.$ref.split("/").at(-1)]
    : schema;
  const expected = openapi.components?.schemas?.[component];
  assert.ok(expected, `OpenAPI is missing ${component}`);
  assert.deepEqual(Object.keys(selected.properties ?? {}).sort(), Object.keys(expected.properties ?? {}).sort(), `200 response must expose ${component} directly`);
  assert.equal(Object.hasOwn(selected.properties ?? {}, "data") || Object.hasOwn(selected.properties ?? {}, "result"), false, "single-resource response must not be wrapped");
}

function assertSortedAndStable(snapshot) {
  assertExactKeys(snapshot, ["asOf", "resources", "events", "work"], "verification snapshot");
  assertTimestamp(snapshot.asOf, "snapshot.asOf");
  assert.deepEqual(Object.keys(snapshot.resources).sort(), [...SNAPSHOT_RESOURCES].sort());
  for (const key of SNAPSHOT_RESOURCES) assert.ok(Array.isArray(snapshot.resources[key]), `${key} must be an array`);
  assert.ok(Array.isArray(snapshot.events));
  assert.ok(Array.isArray(snapshot.work));
  for (const item of snapshot.work) {
    assertExactKeys(item, ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"], "Work");
  }
  assertEventSequences(snapshot.events);
}

async function d03(ctx) {
  const catalog = ctx.catalog("contract-snapshot");
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 1 });
  const sentinel = `IW-CONTRACT-RAW-${ctx.key("secret")}`;
  const source = await createValidatedImport(ctx, api.baseUrl, catalog, ndjsonBytes([
    rowFixture(1, { externalId: "contract-good" }),
    rowFixture(2, { externalId: "contract-bad", email: sentinel, age: "bad" }),
  ]), { label: "contract source", processes: workers });
  await waitForReport(ctx, api.baseUrl, source.job.importId, ["READY"], { processes: workers });
  const bundle = expectBundle(ctx, await ctx.createBundle(api.baseUrl, catalog.tenant.tenantId, "Contract Bundle"), { state: "DRAFT" }, "contract Bundle");
  expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, source.job.importId), { position: 1 }, "contract Bundle member");
  expectBundle(ctx, await ctx.stageBundle(api.baseUrl, bundle.bundleId), { state: "STAGED" }, "contract Bundle stage");
  expectBundle(ctx, await ctx.publishBundle(api.baseUrl, bundle.bundleId), { bundleId: bundle.bundleId }, "contract Bundle publish");
  await waitForBundle(ctx, api.baseUrl, bundle.bundleId, "PUBLISHED");

  const openapi = await ctx.readOpenApi(api.baseUrl);
  ctx.assert("OpenAPI uses 3.1 and publishes every V1/Bundle route", () => {
    assert.match(openapi.openapi, /^3\.1(?:\.|$)/u);
    const routes = [
      ["post", "/api/v1/tenants"], ["post", "/api/v1/schemas"], ["post", "/api/v1/schemas/{schemaId}/revisions"],
      ["post", "/api/v1/imports"], ["get", "/api/v1/imports/{importId}"], ["put", "/api/v1/imports/{importId}/chunks/{chunkNumber}"],
      ["post", "/api/v1/imports/{importId}/complete"], ["post", "/api/v1/imports/{importId}/commit"], ["post", "/api/v1/imports/{importId}/cancel"],
      ["get", "/api/v1/imports/{importId}/findings"], ["get", "/api/v1/imports/{importId}/error-report"], ["get", "/api/v1/records"],
      ["get", "/api/v1/verification-snapshot"], ["post", "/api/v1/import-bundles"],
      ["post", "/api/v1/import-bundles/{bundleId}/members"], ["post", "/api/v1/import-bundles/{bundleId}/stage"],
      ["post", "/api/v1/import-bundles/{bundleId}/publish"], ["get", "/healthz"], ["get", "/openapi.json"],
    ];
    for (const [method, path] of routes) operation(openapi, method, path);
    assertSuccessSchema(openapi, operation(openapi, "post", "/api/v1/imports"), "ImportJob");
    assertSuccessSchema(openapi, operation(openapi, "put", "/api/v1/imports/{importId}/chunks/{chunkNumber}"), "UploadChunk");
    assertSuccessSchema(openapi, operation(openapi, "post", "/api/v1/import-bundles"), "ImportBundle");
    assertSuccessSchema(openapi, operation(openapi, "post", "/api/v1/import-bundles/{bundleId}/members"), "BundleMember");
    for (const name of ["ImportJob", "UploadChunk", "ValidationFinding", "CommittedRecord", "ErrorReport", "ImportBundle", "BundleMember"]) {
      const schema = openapi.components?.schemas?.[name];
      assert.ok(schema, `missing ${name} component`);
      assert.equal(schema.additionalProperties, false, `${name} must be closed`);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${name} requires every public field`);
    }
  });

  const unauthorized = await ctx.request(api.baseUrl, "/api/v1/verification-snapshot");
  ctx.ok("snapshot requires admin authentication", [401, 403].includes(unauthorized.status));
  const first = await ctx.snapshot(api.baseUrl);
  const second = await ctx.snapshot(api.baseUrl);
  ctx.assert("FINAL snapshot has the exact closed top-level and resource sets", () => assertSortedAndStable(first));
  ctx.assert("repeated snapshot is point-in-time stable apart from asOf", () => {
    const { asOf: _firstAsOf, ...firstStable } = first;
    const { asOf: _secondAsOf, ...secondStable } = second;
    assert.equal(canonical(firstStable), canonical(secondStable));
  });
  ctx.equal("FINAL snapshot contains BUNDLE_PUBLISH Work", workOf(first).filter(({ kind, aggregateId }) => kind === "BUNDLE_PUBLISH" && aggregateId === bundle.bundleId).length, 1);
  ctx.assert("snapshot resources retain their closed public shapes", () => {
    resource(first, "imports").forEach((value) => assertImportJob(value));
    resource(first, "importBundles").forEach((value) => assertBundle(value));
    resource(first, "bundleMembers").forEach((value) => assertBundleMember(value));
  });
  ctx.assert("OpenAPI, snapshot, errors, and logs contain no private artifact or rejected raw value", () => assertNoSensitiveMaterial({
    openapi, snapshot: first, unauthorized: unauthorized.text, logs: [api.logs, ...workers.map(({ logs }) => logs)],
  }, [sentinel]), CORRECTNESS_CAP);
  return result(ctx, "OpenAPI 3.1, closed V1/Bundle schemas, authenticated FINAL snapshot, Work/Event order, and sensitive-data isolation were verified");
}

async function d04(ctx) {
  const catalog = ctx.catalog("row-conservation");
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 2 });
  const sentinel = `IW-ROW-RAW-${ctx.key("bad")}`;
  const mixedBytes = ndjsonBytes([
    rowFixture(1, { externalId: "row-good-a" }),
    rowFixture(2, { externalId: "row-bad", email: sentinel, age: "bad" }),
    rowFixture(3, { externalId: "row-good-b" }),
  ]);
  const sourceModel = modelNdjson(mixedBytes, catalog.revision);
  const aon = await createValidatedImport(ctx, api.baseUrl, catalog, mixedBytes, { commitMode: "ALL_OR_NOTHING", label: "conservation AON", processes: workers });
  const validRows = await createValidatedImport(ctx, api.baseUrl, catalog, mixedBytes, { commitMode: "VALID_ROWS", label: "conservation valid rows", processes: workers });
  const aonTerminal = await commitAndWait(ctx, api.baseUrl, aon.job.importId, { processes: workers });
  const partialTerminal = await commitAndWait(ctx, api.baseUrl, validRows.job.importId, { processes: workers });
  ctx.equal("AON invalid chain rejects", aonTerminal.job.state, "REJECTED", CORRECTNESS_CAP);
  ctx.equal("VALID_ROWS mixed chain partially commits", partialTerminal.job.state, "PARTIALLY_COMMITTED", CORRECTNESS_CAP);
  const aonFindings = await allFindings(ctx, api.baseUrl, aon.job.importId);
  const partialFindings = await allFindings(ctx, api.baseUrl, validRows.job.importId);
  ctx.assert("both imports derive the same redacted findings from source bytes", () => {
    assertModeledFindings(aonFindings, sourceModel);
    assertModeledFindings(partialFindings, sourceModel);
  });
  const records = await allRecords(ctx, api.baseUrl, catalog.tenant.tenantId, catalog.schema.datasetKey);
  ctx.equal("failed AON chain has no records", records.filter(({ sourceImportId }) => sourceImportId === aon.job.importId).length, 0, CORRECTNESS_CAP);
  ctx.assert("selective chain record set and payload digests match source rows", () => assertModeledRecords(records, sourceModel, {
    sourceImportId: validRows.job.importId,
    tenantId: catalog.tenant.tenantId,
    datasetKey: catalog.schema.datasetKey,
  }), CORRECTNESS_CAP);

  const bundleSources = [];
  for (let index = 0; index < 2; index += 1) {
    bundleSources.push(await createValidatedImport(ctx, api.baseUrl, catalog, ndjsonBytes([
      rowFixture(index + 10, { externalId: `row-bundle-${index}` }),
    ]), { label: `conservation Bundle ${index}`, processes: workers }));
  }
  const bundle = expectBundle(ctx, await ctx.createBundle(api.baseUrl, catalog.tenant.tenantId, "Conservation Bundle"), { state: "DRAFT" }, "conservation Bundle");
  for (const [index, source] of bundleSources.entries()) expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, source.job.importId), { position: index + 1 }, `conservation member ${index + 1}`);
  expectBundle(ctx, await ctx.stageBundle(api.baseUrl, bundle.bundleId), { state: "STAGED" }, "conservation stage");
  expectBundle(ctx, await ctx.publishBundle(api.baseUrl, bundle.bundleId), { bundleId: bundle.bundleId }, "conservation publish");
  const published = await waitForBundle(ctx, api.baseUrl, bundle.bundleId, "PUBLISHED");
  const finalRecords = resource(published.snapshot, "committedRecords");
  ctx.equal("Bundle adds exactly its two source records", finalRecords.filter(({ sourceImportId }) => bundleSources.some((source) => source.job.importId === sourceImportId)).length, 2, CORRECTNESS_CAP);
  ctx.assert("row totals conserve at every public ImportJob", () => {
    for (const job of resource(published.snapshot, "imports")) assert.equal(job.totalRows, job.validRows + job.invalidRows);
  }, CORRECTNESS_CAP);
  ctx.assert("record identity/source/digest graph is unique and closed", () => {
    assertUnique(finalRecords, ({ recordId }) => recordId, "record IDs");
    assertUnique(finalRecords, ({ tenantId, datasetKey, externalRowId }) => `${tenantId}\0${datasetKey}\0${externalRowId}`, "external identities");
    for (const record of finalRecords) {
      assertRecord(record);
      assert.equal(record.payloadDigest, ctx.sha256(Buffer.from(JSON.stringify(record.payload))));
      assert.ok(resource(published.snapshot, "imports").some(({ importId }) => importId === record.sourceImportId));
    }
  }, CORRECTNESS_CAP);
  const reports = [
    await waitForReport(ctx, api.baseUrl, aon.job.importId, ["READY"], { processes: workers }),
    await waitForReport(ctx, api.baseUrl, validRows.job.importId, ["READY"], { processes: workers }),
  ];
  ctx.assert("report row counts close over finding rows", () => {
    assertReport(reports[0], { rowCount: aonFindings.length });
    assertReport(reports[1], { rowCount: partialFindings.length });
  });
  ctx.assert("events close over successful and failed publication chains", () => {
    const events = eventsOf(published.snapshot);
    assertEventSequences(events);
    assert.equal(events.some(({ aggregateId, type }) => aggregateId === aon.job.importId && ["import.committed", "import.partially_committed"].includes(type)), false);
    assert.equal(events.filter(({ aggregateId, type }) => aggregateId === validRows.job.importId && type === "import.partially_committed").length, 1);
    assert.ok(events.some(({ aggregateId }) => aggregateId === bundle.bundleId));
  }, CORRECTNESS_CAP);
  ctx.assert("no public layer contains the rejected raw value", () => assertNoSensitiveMaterial({
    findings: [aonFindings, partialFindings], records: finalRecords, snapshot: published.snapshot,
  }, [sentinel]), CORRECTNESS_CAP);
  return result(ctx, "source rows conserved through counts, findings, reports, records, payload digests, Bundle publication, and events");
}

export const D_CASES = Object.freeze([
  defineCase({ id: "D-01", fixtureFamily: "F-UPLOAD 1 MiB production-browser file", action: "production build/Chromium create, unknown chunk response, UI restart/resume/complete", oracle: "public API byte coverage, SHA-256, state, layout and keyboard checks", run: d01 }),
  defineCase({ id: "D-02", fixtureFamily: "F-NDJSON/F-BUNDLE production UI state", action: "browser findings/report, commit, cancel, Bundle create/add/stage/publish", oracle: "HTTP/snapshot terminal state and raw-value isolation", run: d02 }),
  defineCase({ id: "D-03", fixtureFamily: "full FINAL resource state with rejected sentinel", action: "OpenAPI and authenticated snapshot during real Work", oracle: "closed wire shapes, repeated point-in-time projection and artifact scan", run: d03 }),
  defineCase({ id: "D-04", fixtureFamily: "one AON, one VALID_ROWS, one Bundle", action: "HTTP/Worker pipeline from harness-owned NDJSON", oracle: "independent row/finding/record/digest/event conservation graph", run: d04 }),
]);
