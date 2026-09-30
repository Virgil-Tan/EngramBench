import { candidateAssert as assert } from "../lib/execution.mjs";
import { chmod, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const { uniqueUiTarget, scopeUiAction, captureBrowserResponse, assertUiEvidence, navigateReadView } = await import(new URL('browser.mjs', process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL('../../../../../src/task-evaluator-v2/', import.meta.url)));

import { beneficiaryRequest, fundedRequest, makeEmptySeed, makeEscrowFixture } from "../fixtures/index.mjs";
import { isMissingV1CheckpointOutcome, MISSING_V1_CHECKPOINT_REASON } from "../lib/execution.mjs";
import { assertDetail, assertDispute, assertEscrow, assertEscrowGuardOpenApi, assertEvents, assertMilestone, assertRelease, assertSnapshot, canonicalJson } from "../oracles/index.mjs";
import { assertNoPrivatePaths, browserMutation, observeBrowserWait, createEscrow, defineCase, fillControl, finalEvidence, getDetail, identityPattern, keyboardFill, launchBrowser, openDispute, prepare, queryEvents, resolveDispute, resources, semanticError, submitViaBrowser, successful, tabTo, visibleControl, visibleField, waitForEscrow } from "./helpers.mjs";

function options(ctx) { return { evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime }; }
async function openEscrow(ctx, page, escrowId) { const identity = page.getByText(escrowId, { exact: false }).first(); assert.ok(await identity.count(), `visible Escrow ${escrowId}`); await identity.click(); await page.waitForLoadState("networkidle"); ctx.mark("layer.ui", { escrowId }); }
async function reloadEscrow(ctx, page, escrowId) {
  await page.reload({ waitUntil: 'networkidle' });
  // A page reload may return to the list. Selection persistence is not a
  // published UI contract; re-enter the target using its visible identity.
  await openEscrow(ctx, page, escrowId);
}
async function fillNamed(page, names, value) { return fillControl(await visibleField(page, names), value); }
// A missing widget is not itself a business verdict. Fill available semantic
// controls, then compare the request actually emitted by the UI to the chosen
// public business input. This also detects hard-coded one-milestone forms.
async function optionalFill(root, names, value) {
  const targets = names.map(name => root.getByLabel(name)).reduce((a, b) => a.or(b));
  const visible = targets.filter({ visible: true });
  if (!await visible.count()) return false;
  await fillControl(await uniqueUiTarget(visible, 'Escrow input ' + names.join(' or ')), value); return true;
}
async function addMilestone(page, { title, amountMinor, beneficiaries = [] }, index) {
  if (index > 0) {
    const add = page.getByRole('button', { name: /add.*milestone|new.*milestone/i });
    if (!await add.count()) return;
    await (await uniqueUiTarget(add, 'add milestone')).click();
  }
  const titles = page.getByLabel(/milestone.*title|^title$|^milestone$/i);
  const amounts = page.getByLabel(/milestone.*amount|^amount.*minor$/i);
  if (await titles.count() > index) await fillControl(titles.nth(index), title);
  if (await amounts.count() > index) await fillControl(amounts.nth(index), amountMinor);
  for (let i = 0; i < beneficiaries.length; i++) {
    if (i > 0) {
      const add = page.getByRole('button', { name: /add.*beneficiar|add.*share/i });
      if (!await add.count()) break;
      await (await uniqueUiTarget(add, 'add beneficiary')).click();
    }
    const ids = page.getByLabel(/(?:beneficiary|share).*(?:id|party)|beneficiary$/i);
    const amounts = page.getByLabel(/beneficiary.*amount|share.*amount/i);
    if (await ids.count()) await fillControl(ids.last(), beneficiaries[i].beneficiaryId);
    if (await amounts.count()) await fillControl(amounts.last(), beneficiaries[i].amountMinor);
  }
}
async function openCreateForm(page, { keyboard = false } = {}) {
  if (!await page.getByLabel(/^buyer(?: id)?$/i).filter({ visible: true }).count()) {
    const control = await visibleControl(page, ['button', 'link'], [/create.*escrow/i, /new.*escrow/i, /fund.*escrow/i]);
    if (keyboard) { await tabTo(page, control); await page.keyboard.press('Enter'); }
    else await control.click();
  }
  return scopeUiAction(page, /escrow/i, /create|fund|save/i);
}
async function fillKeyboardEscrowForm(page, form, fixture) {
  const fields = [
    [/^buyer(?: id)?$/i, fixture.buyerId, true], [/^seller(?: id)?$/i, fixture.sellerId, true],
    [/^currency$/i, 'USD'], [/^total(?: minor)?$/i, '100', true], [/^expires?(?: at)?$/i, fixture.fixtures.at({ hours: 2 }), true],
    [/^(?:(?:other|second) )?beneficiary(?: id)?$/i, fixture.parties[2].partyId],
    [/^seller share$/i, '50'], [/^other share$/i, '50'],
  ];
  for (const [name, value, required] of fields) {
    const target = form.getByLabel(name).filter({ visible: true });
    if (!required && !await target.count()) continue;
    await keyboardFill(page, await uniqueUiTarget(target, 'funded keyboard input ' + name), value);
  }
  const titles = form.getByLabel(/milestone.*title|title.*milestone|^title$|^milestone$/i).filter({ visible: true });
  const amounts = form.getByLabel(/milestone.*amount|^amount.*minor$/i).filter({ visible: true });
  await keyboardFill(page, await uniqueUiTarget(titles, 'one keyboard Milestone title'), 'Keyboard Milestone');
  // For a single-Milestone form the total may also be its amount. Verify the
  // emitted funded result below rather than requiring a redundant widget.
  if (await amounts.count()) await keyboardFill(page, await uniqueUiTarget(amounts, 'keyboard Milestone amount'), '100');
}
async function createViaBrowser(ctx, baseUrl, body, options = {}) {
  const { page, browserContext } = await launchBrowser(ctx, baseUrl);
  const root = await openCreateForm(page);
  const json = root.getByLabel(/escrow.*json|request.*body/i).filter({ visible: true });
  if (await json.count()) await fillControl(await uniqueUiTarget(json, 'Escrow request JSON'), JSON.stringify(body));
  else {
    for (const [name, value] of [[/^buyer(?: id)?$/i, body.buyerId], [/^seller(?: id)?$/i, body.sellerId], [/^currency$/i, body.currency], [/^total(?: minor)?$/i, body.totalMinor], [/^expires?(?: at)?$/i, body.expiresAt]])
      await optionalFill(root, [name], value);
    for (let index = 0; index < body.milestones.length; index++) await addMilestone(root, body.milestones[index], index);
  }
  if (options.beforeCommit) await options.beforeCommit({ page, browserContext });
  const response = await captureBrowserResponse(page, request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/escrows', async () => {
    await (await uniqueUiTarget(root.getByRole('button', { name: /create|fund|save/i }), 'fund Escrow')).click();
  });
  assert.deepEqual(response.request().postDataJSON(), body, 'UI must preserve the chosen Escrow, Milestones and Beneficiary Shares');
  assert.equal(response.status(), 201, 'browser funded-create status');
  const escrow = assertEscrow(await response.json());
  await page.getByText(escrow.escrowId, { exact: false }).first().waitFor({ state: 'visible' });
  ctx.mark('layer.ui', { escrowId: escrow.escrowId }); return { page, browserContext, escrow };
}
async function browserResponse(response) { const text = await response.text(); let json; try { json = JSON.parse(text); } catch {} return { status: response.status(), text, json, headers: response.headers() }; }
async function disputeViaBrowser(page, reason) {
  return captureBrowserResponse(page, request => request.method() === 'POST' && /\/disputes$/u.test(new URL(request.url()).pathname), async () => {
    await (await visibleControl(page, ['button'], [/^(?:open )?dispute$/i])).click();
    const field = page.getByLabel(/reason/i).filter({ visible: true });
    if (await field.count()) {
      await fillControl(await uniqueUiTarget(field, 'Dispute reason'), reason);
      await (await visibleControl(page, ['button'], [/submit.*dispute/i, /open.*dispute/i])).click();
    }
  });
}
async function resolveViaBrowser(ctx, page, disputeId, decision, { token = ctx.adminToken, expectedStatus = 200, keyboard = false } = {}) {
  if (!await page.getByLabel(/admin.*token|^token$/i).filter({ visible: true }).count())
    await (await visibleControl(page, ['button', 'link'], [/resolve.*dispute/i, /adjudicate/i, /^resolve$/i])).click();
  await fillNamed(page, [/admin.*token/i, /^token$/i], token);
  await optionalFill(page, [/^decision$/i], decision);
  await optionalFill(page, [/^note$/i], 'Visible ' + decision.toLowerCase() + ' resolution');
  const response = await captureBrowserResponse(page, request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/admin/disputes/' + disputeId + '/resolve', async () => {
    const control = await visibleControl(page, ['button'], [new RegExp('resolve.*' + decision, 'i'), /confirm.*resolve/i, /^resolve(?: dispute)?$/i]);
    if (keyboard) { await tabTo(page, control); await page.keyboard.press('Enter'); } else await control.click();
  });
  assert.equal(response.status(), expectedStatus, 'visible ' + decision + ' resolution status'); return browserResponse(response);
}
async function maybeVisible(page, pattern) { const matches = page.getByText(pattern); for (let index = 0; index < await matches.count(); index += 1) if (await matches.nth(index).isVisible().catch(() => false)) return true; return false; }
async function futureFromObservedClock(ctx, baseUrl, milliseconds = 10_000) {
  const snapshot = assertSnapshot(await ctx.snapshot(baseUrl));
  const observed = Date.parse(snapshot.asOf);
  assert.ok(Number.isFinite(observed), "verification snapshot exposes a valid current timestamp");
  return new Date(Math.max(observed, Date.now()) + milliseconds).toISOString();
}
async function requireVisibleEvidence(page, pattern, navigation = []) {
  const matches = page.getByText(pattern); for (let index = 0; index < await matches.count(); index += 1) if (await matches.nth(index).isVisible().catch(() => false)) return matches.nth(index);
  for (const name of navigation) if (await navigateReadView(page, name)) break;
  const refreshed = page.getByText(pattern).filter({ visible: true });
  await assertUiEvidence(refreshed, String(pattern));
  return refreshed.first();
}

function resolveOpenApi(document, value, collection = "schemas", seen = new Set()) {
  if (!value?.$ref) return value;
  const match = value.$ref.match(new RegExp(`^#/components/${collection}/([^/]+)$`, "u")); assert.ok(match, `local OpenAPI ${collection} ref`); assert.ok(!seen.has(value.$ref), `acyclic OpenAPI ${collection} ref`); const resolved = document.components?.[collection]?.[match[1]]; assert.ok(resolved, `resolved OpenAPI ${collection} ref`); return resolveOpenApi(document, resolved, collection, new Set([...seen, value.$ref]));
}
function validateOpenApiValue(document, rawSchema, value, label) {
  const schema = resolveOpenApi(document, rawSchema); assert.ok(schema, `${label} schema exists`);
  if (schema.allOf) { schema.allOf.forEach((branch) => validateOpenApiValue(document, branch, value, label)); return; }
  if (schema.oneOf) { const matches = schema.oneOf.filter((branch) => { try { validateOpenApiValue(document, branch, value, label); return true; } catch { return false; } }); assert.equal(matches.length, 1, `${label} matches exactly one oneOf branch`); return; }
  if (schema.anyOf) { assert.ok(schema.anyOf.some((branch) => { try { validateOpenApiValue(document, branch, value, label); return true; } catch { return false; } }), `${label} matches anyOf`); return; }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) { assert.ok(types.includes("null") || schema.nullable === true, `${label} nullable`); return; }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${label} enum`);
  if (types.includes("object")) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`); for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}.${key} required`); if (schema.additionalProperties === false) assert.ok(Object.keys(value).every((key) => Object.hasOwn(schema.properties ?? {}, key)), `${label} rejects unlisted fields`); for (const [key, property] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) validateOpenApiValue(document, property, value[key], `${label}.${key}`); return; }
  if (types.includes("array")) { assert.ok(Array.isArray(value), `${label} array`); value.forEach((item, index) => validateOpenApiValue(document, schema.items, item, `${label}[${index}]`)); return; }
  if (types.includes("integer")) assert.ok(Number.isSafeInteger(value), `${label} integer`);
  else if (types.includes("number")) assert.equal(typeof value, "number", `${label} number`);
  else if (types.includes("boolean")) assert.equal(typeof value, "boolean", `${label} boolean`);
  else if (types.includes("string")) { assert.equal(typeof value, "string", `${label} string`); if (schema.format === "uuid") assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, `${label} uuid`); if (schema.format === "date-time") assert.equal(new Date(value).toISOString(), value, `${label} timestamp`); }
}
function assertTrafficMatchesOpenApi(document, path, method, response) {
  const operation = document.paths?.[path]?.[method.toLowerCase()]; assert.ok(operation, `${method} ${path} operation`); const described = resolveOpenApi(document, operation.responses?.[String(response.status)], "responses"); assert.ok(described, `${method} ${path} status ${response.status}`); const schema = described.content?.["application/json"]?.schema; assert.ok(schema, `${method} ${path} ${response.status} JSON body schema`); validateOpenApiValue(document, schema, response.json, `${method} ${path} ${response.status}`); return response;
}
function requestSchema(document, path, method = "post") {
  const operation = document.paths?.[path]?.[method];
  assert.ok(operation, `${method.toUpperCase()} ${path} operation`);
  const requestBody = operation.requestBody?.$ref
    ? document.components?.requestBodies?.[operation.requestBody.$ref.split("/").at(-1)]
    : operation.requestBody;
  assert.ok(requestBody?.required, `${method.toUpperCase()} ${path} request body required`);
  const schema = requestBody.content?.["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${path} JSON request schema`);
  return schema;
}
function assertClosedRequestSchema(document, rawSchema, label, opaqueProperties = new Set(), seen = new Set()) {
  const schema = resolveOpenApi(document, rawSchema);
  if (seen.has(schema)) return;
  seen.add(schema);
  for (const keyword of ["allOf", "oneOf", "anyOf"]) for (const branch of schema[keyword] ?? []) assertClosedRequestSchema(document, branch, label, opaqueProperties, seen);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    assert.equal(schema.additionalProperties, false, `${label} object schema is closed`);
    for (const [name, property] of Object.entries(schema.properties ?? {})) if (!opaqueProperties.has(name)) assertClosedRequestSchema(document, property, `${label}.${name}`, opaqueProperties, seen);
  }
  if (types.includes("array") && schema.items) assertClosedRequestSchema(document, schema.items, `${label}[]`, opaqueProperties, seen);
}
function assertRequestMatchesOpenApi(document, path, body, { opaqueProperties = [] } = {}) {
  const schema = requestSchema(document, path);
  assertClosedRequestSchema(document, schema, `POST ${path}`, new Set(opaqueProperties));
  validateOpenApiValue(document, schema, body, `POST ${path} request`);
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) ?? response.headers?.[name.toLowerCase()] ?? response.headers?.[name];
}

function assertJsonTraffic(document, path, method, response) {
  assert.match(responseHeader(response, "content-type") ?? "", /^application\/json(?:\s*;|$)/iu, `${method.toUpperCase()} ${path} ${response.status} Content-Type`);
  return assertTrafficMatchesOpenApi(document, path, method, response);
}

async function exerciseV1OpenApiTraffic(ctx, api, document, fixture) {
  const traffic = [];
  const add = (path, method, response) => { traffic.push([path, method, response]); return response; };
  const list = add("/api/v1/escrows", "get", successful(await ctx.request(api.baseUrl, "/api/v1/escrows"), "V1 OpenAPI list", 200));
  assert.deepEqual(Object.keys(list.json ?? {}).sort(), ["items", "nextCursor"], "V1 list exact page"); list.json.items.forEach(assertEscrow);
  const badCursor = add("/api/v1/escrows", "get", await ctx.request(api.baseUrl, "/api/v1/escrows?cursor=broken")); semanticError(badCursor, 400, "INVALID_CURSOR");
  const body = fundedRequest(fixture, [20, 10]); assertRequestMatchesOpenApi(document, "/api/v1/escrows", body);
  const created = add("/api/v1/escrows", "post", await ctx.mutate(api.baseUrl, "/api/v1/escrows", ctx.key("v1-openapi-create"), body)); assertEscrow(successful(created, "V1 OpenAPI create", 201).json);
  const invalidCreate = add("/api/v1/escrows", "post", await ctx.mutate(api.baseUrl, "/api/v1/escrows", ctx.key("v1-openapi-invalid-create"), { ...body, hidden: true }, { contractExpectation: "invalid" })); semanticError(invalidCreate, 400, "UNKNOWN_FIELD");
  const escrowId = created.json.escrowId;
  const detail = add("/api/v1/escrows/{escrowId}", "get", successful(await ctx.request(api.baseUrl, `/api/v1/escrows/${escrowId}`), "V1 detail", 200)); assertDetail(detail.json, { final: false });
  const missingId = fixture.fixtures.uuid("v1-openapi-missing"); const missing = add("/api/v1/escrows/{escrowId}", "get", await ctx.request(api.baseUrl, `/api/v1/escrows/${missingId}`)); semanticError(missing, 404, "NOT_FOUND");
  const { page } = await launchBrowser(ctx, api.baseUrl); await openEscrow(ctx, page, escrowId); const submitted = add("/api/v1/escrows/{escrowId}/milestones/{milestoneId}/submit", "post", await browserResponse(await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u))); successful(submitted, "V1 visible submit", 200); assertEscrow(submitted.json.escrow); assertMilestone(submitted.json.milestone);
  const missingSubmit = add("/api/v1/escrows/{escrowId}/milestones/{milestoneId}/submit", "post", await ctx.mutate(api.baseUrl, `/api/v1/escrows/${missingId}/milestones/${missingId}/submit`, ctx.key("v1-openapi-missing-submit"), { evidence: {} })); semanticError(missingSubmit, 404, "NOT_FOUND");
  const initialDetail = detail.json; const accepted = add("/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept", "post", await ctx.mutate(api.baseUrl, `/api/v1/escrows/${escrowId}/milestones/${initialDetail.milestones[0].milestoneId}/accept`, ctx.key("v1-openapi-accept"), {})); assertRelease(successful(accepted, "V1 accept", 200).json);
  const badAccept = add("/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept", "post", await ctx.mutate(api.baseUrl, `/api/v1/escrows/${escrowId}/milestones/${initialDetail.milestones[1].milestoneId}/accept`, ctx.key("v1-openapi-bad-accept"), {})); semanticError(badAccept, 409, "MILESTONE_NOT_SUBMITTED");
  const disputeEscrow = await createEscrow(ctx, api.baseUrl, fundedRequest(fixture, [10]), { key: ctx.key("v1-openapi-dispute-create") }); const disputeDetail = await getDetail(ctx, api.baseUrl, disputeEscrow.escrowId, { final: false }); const disputePath = `/api/v1/escrows/${disputeEscrow.escrowId}/milestones/${disputeDetail.milestones[0].milestoneId}/disputes`; const disputeBody = { openedBy: "BUYER", reason: "V1 OpenAPI traffic" };
  const badDispute = add("/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes", "post", await ctx.mutate(api.baseUrl, disputePath, ctx.key("v1-openapi-bad-dispute"), disputeBody)); semanticError(badDispute, 409, "MILESTONE_NOT_SUBMITTED");
  await submitViaBrowser(ctx, api.baseUrl, disputeEscrow.escrowId); const opened = add("/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes", "post", await ctx.mutate(api.baseUrl, disputePath, ctx.key("v1-openapi-dispute"), disputeBody)); assertDispute(successful(opened, "V1 dispute", 200).json);
  const resolvePath = `/api/v1/admin/disputes/${opened.json.disputeId}/resolve`, resolveBody = { decision: "REFUND", note: "V1 resolved" };
  const denied = add("/api/v1/admin/disputes/{disputeId}/resolve", "post", await ctx.mutate(api.baseUrl, resolvePath, ctx.key("v1-openapi-denied"), resolveBody, { contractExpectation: "invalid" })); semanticError(denied, 401, "ADMIN_AUTH_REQUIRED");
  const resolved = add("/api/v1/admin/disputes/{disputeId}/resolve", "post", await ctx.mutate(api.baseUrl, resolvePath, ctx.key("v1-openapi-resolve"), resolveBody, { admin: true })); assertDispute(successful(resolved, "V1 resolve", 200).json);
  const events = add("/api/v1/domain-events", "get", successful(await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${escrowId}&limit=100`), "V1 events", 200)); assertEvents(events.json.items);
  const badEvents = add("/api/v1/domain-events", "get", await ctx.request(api.baseUrl, "/api/v1/domain-events?limit=0", { contractExpectation: "invalid" })); semanticError(badEvents, 400, "INVALID_REQUEST");
  const snapshot = add("/api/v1/verification-snapshot", "get", successful(await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { headers: { authorization: `Bearer ${ctx.adminToken}` } }), "V1 snapshot", 200)); assertSnapshot(snapshot.json, { final: false });
  const deniedSnapshot = add("/api/v1/verification-snapshot", "get", await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { contractExpectation: "invalid" })); semanticError(deniedSnapshot, 401, "ADMIN_AUTH_REQUIRED");
  for (const [path, method, response] of traffic) assertJsonTraffic(document, path, method, response);
  assert.equal(traffic.length, 18, "V1 every public route has one live success and one published error");
  return traffic.length;
}

const D01 = defineCase({ id: "D-01", fixtureFamily: "EG-F-OPENAPI", action: "Fetch FINAL and, when supplied, V1 OpenAPI 3.1 documents, independently validate exact resource schemas, paths, methods, statuses, request bodies, idempotency and Bearer contracts, then validate success and error traffic for every route family against that document and the task oracle.", oracle: "Missing or permissive schemas fail closed; V1 and FINAL documents cover every published route; concrete runtime collection, Escrow, lifecycle, Dispute, Event, snapshot and error bodies satisfy both the independent EscrowGuard oracle and their declared OpenAPI schema.", async run(ctx) { const validated = []; let v1LiveTraffic = 0; if (ctx.v1Workspace) { const v1Fixture = makeEscrowFixture(options(ctx), { label: "v1-openapi" }); const v1 = await prepare(ctx, { workspace: ctx.v1Workspace, seed: v1Fixture.seed }); const v1Document = successful(await ctx.request(v1.api.baseUrl, "/openapi.json"), "V1 OpenAPI", 200).json; ctx.ok(assertEscrowGuardOpenApi(v1Document, { final: false }), "V1 exact OpenAPI"); for (const path of Object.keys(v1Document.paths).filter((path) => v1Document.paths[path].post)) assertClosedRequestSchema(v1Document, requestSchema(v1Document, path), `V1 POST ${path}`, path.endsWith("/submit") ? new Set(["evidence"]) : new Set()); v1LiveTraffic = await exerciseV1OpenApiTraffic(ctx, v1.api, v1Document, v1Fixture); validated.push("V1"); await ctx.resetDatabase(); }
    const fixture = makeEscrowFixture(options(ctx), { label: "openapi-final" }); const { api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } }); const document = successful(await ctx.request(api.baseUrl, "/openapi.json"), "FINAL OpenAPI", 200).json; ctx.ok(assertEscrowGuardOpenApi(document), "FINAL exact OpenAPI"); for (const path of Object.keys(document.paths).filter((path) => document.paths[path].post)) assertClosedRequestSchema(document, requestSchema(document, path), `POST ${path}`, path.endsWith("/submit") ? new Set(["evidence"]) : new Set()); const traffic = [];
    const list = successful(await ctx.request(api.baseUrl, "/api/v1/escrows"), "OpenAPI list", 200); assert.deepEqual(Object.keys(list.json ?? {}).sort(), ["items", "nextCursor"], "list exact page"); list.json.items.forEach(assertEscrow); traffic.push(["/api/v1/escrows", "get", list]);
    const badCursor = await ctx.request(api.baseUrl, "/api/v1/escrows?cursor=broken"); semanticError(badCursor, 400, "INVALID_CURSOR"); traffic.push(["/api/v1/escrows", "get", badCursor]);
    const createBody = beneficiaryRequest(fixture, [2, 1]); assertRequestMatchesOpenApi(document, "/api/v1/escrows", createBody); const created = await ctx.mutate(api.baseUrl, "/api/v1/escrows", ctx.key("openapi-create"), createBody); assertEscrow(successful(created, "OpenAPI create", 201).json); traffic.push(["/api/v1/escrows", "post", created]);
    const invalidCreate = await ctx.mutate(api.baseUrl, "/api/v1/escrows", ctx.key("openapi-invalid-create"), { ...createBody, hidden: true }, { contractExpectation: "invalid" }); semanticError(invalidCreate, 400, "UNKNOWN_FIELD"); traffic.push(["/api/v1/escrows", "post", invalidCreate]);
    const escrowId = created.json.escrowId; const detail = await ctx.request(api.baseUrl, `/api/v1/escrows/${escrowId}`); assertDetail(successful(detail, "OpenAPI detail", 200).json); traffic.push(["/api/v1/escrows/{escrowId}", "get", detail]);
    const missingId = fixture.fixtures.uuid("openapi-missing"); const missing = await ctx.request(api.baseUrl, `/api/v1/escrows/${missingId}`); semanticError(missing, 404, "NOT_FOUND"); traffic.push(["/api/v1/escrows/{escrowId}", "get", missing]);
    const initialDetail = detail.json; const { page } = await launchBrowser(ctx, api.baseUrl); await openEscrow(ctx, page, escrowId); const submitBrowser = await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u); const submitted = await browserResponse(submitBrowser); successful(submitted, "visible submit", 200); assert.deepEqual(Object.keys(submitted.json ?? {}).sort(), ["escrow", "milestone"], "submit exact multi-resource body"); assertEscrow(submitted.json.escrow); assertMilestone(submitted.json.milestone); traffic.push(["/api/v1/escrows/{escrowId}/milestones/{milestoneId}/submit", "post", submitted]);
    const missingSubmit = await ctx.mutate(api.baseUrl, `/api/v1/escrows/${missingId}/milestones/${missingId}/submit`, ctx.key("openapi-missing-submit"), { evidence: {} }); semanticError(missingSubmit, 404, "NOT_FOUND"); traffic.push(["/api/v1/escrows/{escrowId}/milestones/{milestoneId}/submit", "post", missingSubmit]);
    const acceptBody = {}; assertRequestMatchesOpenApi(document, "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept", acceptBody); const acceptPath = `/api/v1/escrows/${escrowId}/milestones/${initialDetail.milestones[0].milestoneId}/accept`; const accepted = await ctx.mutate(api.baseUrl, acceptPath, ctx.key("openapi-accept"), acceptBody); assertRelease(successful(accepted, "OpenAPI accept", 200).json, { response: true }); traffic.push(["/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept", "post", accepted]);
    const badAccept = await ctx.mutate(api.baseUrl, `/api/v1/escrows/${escrowId}/milestones/${initialDetail.milestones[1].milestoneId}/accept`, ctx.key("openapi-bad-accept"), {}); semanticError(badAccept, 409, "MILESTONE_NOT_SUBMITTED"); traffic.push(["/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept", "post", badAccept]);
    const disputeBody = { openedBy: "BUYER", reason: "OpenAPI traffic" }; assertRequestMatchesOpenApi(document, "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes", disputeBody); const disputeEscrow = await createEscrow(ctx, api.baseUrl, beneficiaryRequest(fixture, [2]), { key: ctx.key("openapi-dispute-create") }); const disputeInitial = await getDetail(ctx, api.baseUrl, disputeEscrow.escrowId); const disputePath = `/api/v1/escrows/${disputeEscrow.escrowId}/milestones/${disputeInitial.milestones[0].milestoneId}/disputes`; const badDispute = await ctx.mutate(api.baseUrl, disputePath, ctx.key("openapi-bad-dispute"), { openedBy: "BUYER", reason: "before submit" }); semanticError(badDispute, 409, "MILESTONE_NOT_SUBMITTED"); traffic.push(["/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes", "post", badDispute]); const disputePage = await submitViaBrowser(ctx, api.baseUrl, disputeEscrow.escrowId); const opened = await ctx.mutate(api.baseUrl, disputePath, ctx.key("openapi-dispute"), disputeBody); assertDispute(successful(opened, "OpenAPI dispute", 200).json); traffic.push(["/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes", "post", opened]);
    const resolveBody = { decision: "REFUND", note: "resolved" }; assertRequestMatchesOpenApi(document, "/api/v1/admin/disputes/{disputeId}/resolve", resolveBody); const resolvePath = `/api/v1/admin/disputes/${opened.json.disputeId}/resolve`; const denied = await ctx.mutate(api.baseUrl, resolvePath, ctx.key("openapi-denied-resolve"), { decision: "REFUND", note: "denied" }, { contractExpectation: "invalid" }); semanticError(denied, 401, "ADMIN_AUTH_REQUIRED"); traffic.push(["/api/v1/admin/disputes/{disputeId}/resolve", "post", denied]); const resolved = await ctx.mutate(api.baseUrl, resolvePath, ctx.key("openapi-resolve"), resolveBody, { admin: true }); assertDispute(successful(resolved, "OpenAPI resolve", 200).json); traffic.push(["/api/v1/admin/disputes/{disputeId}/resolve", "post", resolved]); const resolvedDetail = await getDetail(ctx, api.baseUrl, disputeEscrow.escrowId); ctx.equal({ state: resolvedDetail.escrow.state, disputeId: resolved.json.disputeId, resolution: resolved.json.state, currentDispute: resolvedDetail.dispute }, { state: "REFUNDED", disputeId: opened.json.disputeId, resolution: "RESOLVED_REFUND", currentDispute: null }, "resolve runtime body corresponds to independently verified aggregate state");
    const events = await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${escrowId}&limit=100`); successful(events, "OpenAPI events", 200); assert.deepEqual(Object.keys(events.json ?? {}).sort(), ["items", "nextCursor"], "event page exact body"); assertEvents(events.json.items); traffic.push(["/api/v1/domain-events", "get", events]); const badEvents = await ctx.request(api.baseUrl, "/api/v1/domain-events?limit=0", { contractExpectation: "invalid" }); semanticError(badEvents, 400, "INVALID_REQUEST"); traffic.push(["/api/v1/domain-events", "get", badEvents]);
    const snapshot = await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { headers: { authorization: `Bearer ${ctx.adminToken}` } }); assertSnapshot(successful(snapshot, "OpenAPI snapshot", 200).json); traffic.push(["/api/v1/verification-snapshot", "get", snapshot]); const deniedSnapshot = await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { contractExpectation: "invalid" }); semanticError(deniedSnapshot, 401, "ADMIN_AUTH_REQUIRED"); traffic.push(["/api/v1/verification-snapshot", "get", deniedSnapshot]);
    for (const [path, method, response] of traffic) assertJsonTraffic(document, path, method, response); ctx.equal(traffic.length, 18, "FINAL every public route has one live success and one published error"); ctx.ok(await disputePage.getByText(identityPattern(disputeEscrow.escrowId)).count() > 0, "visible submit originated in production UI"); validated.push("FINAL"); return finalEvidence(ctx, { validated, paths: Object.keys(document.paths).length, liveTraffic: { V1: v1LiveTraffic, FINAL: traffic.length } }); } });

const D02 = defineCase({
  id: "D-02",
  fixtureFamily: "EG-F-BROWSER-V1",
  action: "Use only production Chromium visible controls to create a V1 Escrow with multiple Milestones, submit and accept each current Milestone, refresh detail between transitions, and inspect progress, history, Work and Events.",
  oracle: "Every primary mutation originates from visible UI controls, frozen amounts and Fund Position remain server-authoritative after refresh, all Milestones release in order, and EG-GAP-01 is not turned into an expected evidence wire envelope.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx));
    const { target, api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } });
    const worker = await target.startWorker();
    const body = fundedRequest(fixture, [30, 20]);
    const { page, escrow } = await createViaBrowser(ctx, api.baseUrl, body);
    if (!(await maybeVisible(page, identityPattern(escrow.escrowId)))) await openEscrow(ctx, page, escrow.escrowId);
    for (let index = 0; index < 2; index += 1) {
      const submit = await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u);
      ctx.ok(submit.status() >= 200 && submit.status() < 300, `Milestone ${index + 1} visible submit`);
      const accept = await browserMutation(page, [/accept/i, /release/i], /\/milestones\/[^/]+\/accept$/u);
      ctx.equal(accept.status(), 200, `Milestone ${index + 1} visible accept`);
      await page.reload({ waitUntil: "networkidle" });
      const current = await getDetail(ctx, api.baseUrl, escrow.escrowId);
      ctx.equal(current.escrow.releasedMinor, index === 0 ? 30 : 50, `server-authoritative released amount after transition ${index + 1}`);
      for (const milestone of current.milestones.slice(0, index + 1)) {
        await requireVisibleEvidence(page, identityPattern(milestone.title));
        ctx.equal(milestone.state, "RELEASED", `Milestone ${milestone.ordinal} released in ordinal order`);
      }
      await requireVisibleEvidence(page, /released/i);
      await requireVisibleEvidence(page, new RegExp(`(?:released|fund position)[^\\n]{0,40}${current.escrow.releasedMinor}|${current.escrow.releasedMinor}[^\\n]{0,40}(?:released|fund position)`, "i"), [/fund.*position/i, /summary/i]);
    }
    const detail = await getDetail(ctx, api.baseUrl, escrow.escrowId);
    ctx.equal(detail.escrow.state, "RELEASED", "browser lifecycle terminal");
    ctx.equal(detail.escrow.releasedMinor, 50, "browser Fund Position");
    ctx.equal(detail.milestones.map(({ state }) => state), ["RELEASED", "RELEASED"], "browser ordered milestones");
    const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const aggregateEvents = snapshot.events.filter(({ aggregateId }) => aggregateId === escrow.escrowId);
    ctx.equal(aggregateEvents.map(({ type }) => type), ["escrow.funded", "milestone.submitted", "milestone.released", "milestone.submitted", "milestone.released"], "browser lifecycle exact Event history");
    for (const value of [escrow.escrowId, ...detail.milestones.flatMap(({ milestoneId, title }) => [milestoneId, title]), ...detail.releases.map(({ releaseId }) => releaseId)]) await requireVisibleEvidence(page, identityPattern(value));
    const expiryWork = snapshot.work.find(({ aggregateId }) => aggregateId === escrow.escrowId);
    ctx.ok(expiryWork, "browser aggregate has expiry Work");
    await requireVisibleEvidence(page, identityPattern(expiryWork.workId), [/work/i, /task/i, /history/i]);
    for (const event of aggregateEvents) await requireVisibleEvidence(page, identityPattern(event.eventId), [/event/i, /history/i]);
    await ctx.stop(worker);
    return finalEvidence(ctx, { escrowId: escrow.escrowId, milestones: 2, visibleWorkId: expiryWork.workId, visibleEventIds: aggregateEvents.map(({ eventId }) => eventId) });
  },
});

const D03 = defineCase({
  id: "D-03",
  fixtureFamily: "EG-F-BROWSER-DISPUTE",
  action: "Open a seeded current SUBMITTED Escrow in production Chromium, use visible controls to open and resolve a Dispute, then observe a separate near-expiry Escrow through asynchronous progress and terminal refresh states.",
  oracle: "Permission, conflict, Dispute and terminal states are visible; the open Dispute never displays a false refund, authorized resolution agrees with snapshot, and expiry progress eventually reflects the real Worker-owned server state.",
  async run(ctx) {
    const disputed = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING", "PENDING"], label: "ui-dispute" });
    const expiring = makeEscrowFixture(options(ctx), { label: "ui-expiry" });
    const seed = makeEmptySeed(disputed.fixtures, disputed.fixtures.seedVersion("ui-dispute-expiry"));
    for (const fixture of [disputed, expiring]) {
      for (const party of fixture.parties) if (!seed.parties.some(({ partyId }) => partyId === party.partyId)) seed.parties.push(party);
    }
    seed.escrows.push(disputed.escrow);
    seed.milestones.push(...disputed.milestones);
    const { target, api } = await prepare(ctx, { seed });
    const { page, browserContext } = await launchBrowser(ctx, api.baseUrl);
    const stalePage = await browserContext.newPage();
    await openEscrow(ctx, page, disputed.escrowId);
    await stalePage.goto(api.baseUrl, { waitUntil: "networkidle" });
    await openEscrow(ctx, stalePage, disputed.escrowId);

    const openResponse = await disputeViaBrowser(page, "Visible dispute reason");
    ctx.equal(openResponse.status(), 200, 'visible Dispute result');

    const staleResponse = await disputeViaBrowser(stalePage, "Stale visible dispute");
    ctx.equal(staleResponse.status(), 409, 'visible Dispute result');
    await requireVisibleEvidence(stalePage, /conflict|stale|already|409/i);

    await page.reload({ waitUntil: "networkidle" });
    await requireVisibleEvidence(page, /disputed|open/i);
    ctx.equal(await maybeVisible(page, /(?:escrow\s+)?(?:state|status)\s*[:=]?\s*refunded|refunded\s+(?:state|status)/i), false, "open Dispute UI does not display a false REFUNDED state");
    const detail = await getDetail(ctx, api.baseUrl, disputed.escrowId);
    ctx.equal(detail.escrow.refundedMinor, 0, "open Dispute not falsely refunded");
    await requireVisibleEvidence(page, identityPattern(detail.dispute.disputeId));
    const denied = await resolveViaBrowser(ctx, page, detail.dispute.disputeId, "REFUND", { token: "wrong-admin-token", expectedStatus: 401 });
    semanticError(denied, 401, "ADMIN_AUTH_REQUIRED");
    await requireVisibleEvidence(page, /permission|unauthori|admin.*required|401/i);
    ctx.equal((await getDetail(ctx, api.baseUrl, disputed.escrowId)).dispute.state, "OPEN", "permission failure leaves Dispute open");
    const resolution = assertDispute((await resolveViaBrowser(ctx, page, detail.dispute.disputeId, "REFUND")).json);
    await page.reload({ waitUntil: "networkidle" });
    await requireVisibleEvidence(page, /refunded/i);
    const resolved = await getDetail(ctx, api.baseUrl, disputed.escrowId);
    ctx.equal({ disputeId: resolution.disputeId, resolution: resolution.state, escrowState: resolved.escrow.state, currentDispute: resolved.dispute }, { disputeId: detail.dispute.disputeId, resolution: "RESOLVED_REFUND", escrowState: "REFUNDED", currentDispute: null }, "visible resolution agrees with server detail");

    const expiryBody = fundedRequest(expiring, [100], { expiresAt: await futureFromObservedClock(ctx, api.baseUrl) });
    const expiryEscrow = await createEscrow(ctx, api.baseUrl, expiryBody, { key: ctx.key("ui-expiry-create") });
    const expiryBefore = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const expiryWork = expiryBefore.work.find(({ aggregateId }) => aggregateId === expiryEscrow.escrowId);
    ctx.ok(expiryWork && !expiryWork.terminal, "near-expiry Work is observably pending before completion");
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    await openEscrow(ctx, page, expiryEscrow.escrowId);
    await requireVisibleEvidence(page, identityPattern(expiryWork.workId), [/work/i, /task/i, /history/i]);
    await requireVisibleEvidence(page, /pending|scheduled|expiry/i, [/work/i, /task/i, /history/i]);
    const worker = await target.startWorker();
    await waitForEscrow(ctx, api.baseUrl, expiryEscrow.escrowId, "REFUNDED", [worker]);
    await page.reload({ waitUntil: "networkidle" });
    await requireVisibleEvidence(page, /refunded/i);
    const final = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const finalWork = final.work.find(({ workId }) => workId === expiryWork.workId);
    ctx.equal(resources(final).escrows.find(({ escrowId }) => escrowId === expiryEscrow.escrowId).state, "REFUNDED", "visible expiry agrees with snapshot");
    ctx.ok(finalWork?.terminal, "same visible expiry Work reaches a terminal state");
    return finalEvidence(ctx, { disputed: disputed.escrowId, expired: expiryEscrow.escrowId, visibleResolution: true, staleConflict: 409, workId: expiryWork.workId });
  },
});

const D04 = defineCase({ id: "D-04", fixtureFamily: "EG-F-BROWSER-SHARES", action: "Through production Chromium visible controls create legacy, two-Share and twenty-Share Milestones, exercise dynamic add, remove and exact-sum validation, release the legacy and two-Share Milestones, and observe a separate beneficiary Escrow refund.", oracle: "The UI is not fixed to two beneficiaries, exact Share sums reject visibly without persistence, complete Payout identity and amount mapping appears after release, refund exposes no Payout, and refreshed detail matches the public snapshot.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx)); const { target, api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } }); const body = beneficiaryRequest(fixture, [2, 20]); body.milestones.unshift({ title: "Legacy UI", amountMinor: 10 }); body.totalMinor += 10; let invalidAllocationObserved = false; const { page, escrow } = await createViaBrowser(ctx, api.baseUrl, body, { beforeCommit: async ({ page: form }) => { const beneficiaryFields = form.getByLabel(/(?:beneficiary|share).*(?:id|party)|beneficiary$/i), amountFields = form.getByLabel(/beneficiary.*amount|share.*amount/i); const initialCount = await beneficiaryFields.count(); ctx.ok(initialCount >= 22, "twenty-Share form is dynamically represented"); const removeButtons = form.getByRole("button", { name: /remove.*beneficiar|remove.*share|delete.*beneficiar|delete.*share/i }); ctx.ok(await removeButtons.count() > 0, "visible beneficiary remove control"); await removeButtons.last().click(); await ctx.waitFor(async () => await beneficiaryFields.count() === initialCount - 1, { timeoutMs: 5_000, label: "beneficiary removal" }); const removed = body.milestones.at(-1).beneficiaries.at(-1); await (await visibleControl(form, ["button"], [/add.*beneficiar/i, /add.*share/i])).click(); await ctx.waitFor(async () => await beneficiaryFields.count() === initialCount, { timeoutMs: 5_000, label: "beneficiary re-add" }); await fillControl(beneficiaryFields.last(), removed.beneficiaryId); await fillControl(amountFields.last(), removed.amountMinor + 1); const invalidPending = observeBrowserWait(form.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/escrows", { timeout: 30_000 })); await (await visibleControl(form, ["button"], [/create/i, /fund/i, /save/i])).click(); const invalid = await browserResponse(await invalidPending); semanticError(invalid, 400, "INVALID_BENEFICIARY_ALLOCATION"); await requireVisibleEvidence(form, /invalid.*beneficiar|allocation|sum|must.*equal/i); const invalidSnapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); ctx.equal(resources(invalidSnapshot).escrows.length, 0, "invalid UI allocation persisted nothing"); await fillControl(amountFields.last(), removed.amountMinor); invalidAllocationObserved = true; } });
    const captured = await getDetail(ctx, api.baseUrl, escrow.escrowId); ctx.equal(captured.beneficiaryShares.length, 23, "legacy plus 2 plus 20 Shares persisted"); ctx.ok(invalidAllocationObserved, "dynamic exact-sum validation executed before success"); if (!(await maybeVisible(page, identityPattern(escrow.escrowId)))) await openEscrow(ctx, page, escrow.escrowId); for (let index = 0; index < 2; index += 1) { const submit = await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u); ctx.ok(submit.status() >= 200 && submit.status() < 300, `visible Milestone ${index + 1} submit`); const release = await browserMutation(page, [/accept/i, /release/i], /\/milestones\/[^/]+\/accept$/u); ctx.equal(release.status(), 200, `visible Milestone ${index + 1} release`); await page.reload({ waitUntil: "networkidle" }); }
    const released = await getDetail(ctx, api.baseUrl, escrow.escrowId); ctx.equal(released.beneficiaryPayouts.length, 3, "legacy Seller plus two captured beneficiaries paid exactly once"); const secondMilestone = released.milestones[1], secondRelease = released.releases.find(({ milestoneId }) => milestoneId === secondMilestone.milestoneId), secondShares = released.beneficiaryShares.filter(({ milestoneId }) => milestoneId === secondMilestone.milestoneId), secondPayouts = released.beneficiaryPayouts.filter(({ releaseId }) => releaseId === secondRelease.releaseId); ctx.equal(secondPayouts.map(({ beneficiaryShareId }) => beneficiaryShareId), secondShares.map(({ beneficiaryShareId }) => beneficiaryShareId), "visible two-Share Payout mapping follows captured ordinal"); for (const payout of secondPayouts) await requireVisibleEvidence(page, identityPattern(payout.payoutId), [/payout/i, /history/i]); const twentyMilestone = captured.milestones[2], twentyShares = captured.beneficiaryShares.filter(({ milestoneId }) => milestoneId === twentyMilestone.milestoneId); ctx.equal(twentyShares.length, 20, "twenty-Share allocation persisted without a fixed-two UI"); for (const share of twentyShares) { await requireVisibleEvidence(page, identityPattern(share.beneficiaryShareId), [/beneficiar/i, /share/i]); await requireVisibleEvidence(page, identityPattern(share.beneficiaryId), [/beneficiar/i, /share/i]); }
    const refundFixture = makeEscrowFixture(options(ctx), { label: "ui-beneficiary-refund" }); const refundBody = beneficiaryRequest(refundFixture, [2]); const { page: refundPage, escrow: refundEscrow } = await createViaBrowser(ctx, api.baseUrl, refundBody, { beforeCommit: async ({ page: form }) => fillNamed(form, [/expire/i], await futureFromObservedClock(ctx, api.baseUrl)) }); const worker = await target.startWorker(); await waitForEscrow(ctx, api.baseUrl, refundEscrow.escrowId, "REFUNDED", [worker]); await refundPage.reload({ waitUntil: "networkidle" }); await requireVisibleEvidence(refundPage, /refunded/i); const refunded = await getDetail(ctx, api.baseUrl, refundEscrow.escrowId); ctx.equal(refunded.beneficiaryPayouts.length, 0, "beneficiary expiry refund creates no Payout"); for (const share of refunded.beneficiaryShares) await requireVisibleEvidence(refundPage, identityPattern(share.beneficiaryId), [/beneficiar/i, /share/i]); await requireVisibleEvidence(refundPage, /no.*payout|payout.*(?:none|empty|0)/i, [/payout/i, /history/i]); const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); const refundShareIds = new Set(refunded.beneficiaryShares.map(({ beneficiaryShareId }) => beneficiaryShareId)); ctx.equal(resources(snapshot).beneficiaryPayouts.filter(({ beneficiaryShareId }) => refundShareIds.has(beneficiaryShareId)).length, 0, "refunded aggregate Share identities have no hidden Payout in snapshot"); return finalEvidence(ctx, { shares: captured.beneficiaryShares.length, visibleTwentyShares: twentyShares.length, releasedPayouts: released.beneficiaryPayouts.length, refundPayouts: 0, dynamicEdit: true }); } });

const D05 = defineCase({ id: "D-05", fixtureFamily: "EG-F-BROWSER-QUALITY", action: "Use keyboard-only navigation in desktop and mobile production Chromium, complete a response-loss funded flow, then trigger real validation, stale conflict, permission, loading, offline and retry states before inspecting DOM, resources and process logs.", oracle: "Every primary control has an associated label and reachable focus, retry reuses the same semantic mutation without duplication, visible errors agree with runtime state, mobile has no unusable overflow, and tokens, keys and private paths never enter bundle, DOM or logs.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx)); const { api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } }); const shield = await ctx.responseShield(api.baseUrl); const { browser, page, browserContext } = await launchBrowser(ctx, shield.baseUrl, { width: 390, height: 844 }); const consoleMessages = []; page.on("console", (message) => consoleMessages.push(message.text())); await requireVisibleEvidence(page, /no.*escrow|empty|nothing.*yet/i); const form = await openCreateForm(page, { keyboard: true }); const buyer = await visibleField(form, [/^buyer(?: id)?$/i]); await keyboardFill(page, buyer, ""); const submit = await visibleControl(form, ["button"], [/create/i, /fund/i, /save/i]); await tabTo(page, submit); await page.keyboard.press("Enter"); await page.waitForLoadState("networkidle"); ctx.ok(await page.locator(":invalid").count() > 0 || await maybeVisible(page, /required|invalid|validation/i), "keyboard empty-submit exposes validation"); await fillKeyboardEscrowForm(page, form, fixture); await tabTo(page, submit); shield.dropNextMutation(); await page.keyboard.press("Enter"); await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { timeoutMs: 30_000, label: "UI funded response loss" }); await requireVisibleEvidence(page, /retry|network|unknown.*outcome|try again/i); const retry = await visibleControl(page, ["button"], [/retry/i, /try again/i, /resubmit/i]); await tabTo(page, retry); const replayPending = observeBrowserWait(page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/escrows", { timeout: 30_000 })); await page.keyboard.press("Enter"); const replayed = await replayPending; ctx.equal(replayed.status(), 201, "keyboard retry replays saved funded result"); const escrow = assertEscrow(await replayed.json()); ctx.equal({ buyerId: escrow.buyerId, sellerId: escrow.sellerId, currency: escrow.currency, totalMinor: escrow.totalMinor }, { buyerId: fixture.buyerId, sellerId: fixture.sellerId, currency: "USD", totalMinor: 100 }, "keyboard form preserves the chosen funded Escrow"); const createCaptures = shield.captures.filter(({ request }) => request.method === "POST" && request.path === "/api/v1/escrows"); ctx.equal(createCaptures.length, 2, "one lost create plus one retry"); ctx.equal({ key: createCaptures[1].request.headers["idempotency-key"], body: createCaptures[1].request.body }, { key: createCaptures[0].request.headers["idempotency-key"], body: createCaptures[0].request.body }, "visible retry preserves key and semantic body");
    const stalePage = await browserContext.newPage(); stalePage.on("console", (message) => consoleMessages.push(message.text())); await stalePage.goto(shield.baseUrl, { waitUntil: "networkidle" }); if (!(await maybeVisible(page, identityPattern(escrow.escrowId)))) { await page.goto(shield.baseUrl, { waitUntil: "networkidle" }); await openEscrow(ctx, page, escrow.escrowId); } await openEscrow(ctx, stalePage, escrow.escrowId); const firstSubmitPending = observeBrowserWait(page.waitForResponse((response) => response.request().method() === "POST" && /\/milestones\/[^/]+\/submit$/u.test(new URL(response.url()).pathname), { timeout: 30_000 })); const firstSubmitControl = await visibleControl(page, ["button"], [/submit/i]); await tabTo(page, firstSubmitControl); await page.keyboard.press("Enter"); const firstSubmit = await firstSubmitPending; ctx.ok(firstSubmit.status() >= 200 && firstSubmit.status() < 300, "first keyboard submit succeeds"); const staleSubmitPending = observeBrowserWait(stalePage.waitForResponse((response) => response.request().method() === "POST" && /\/milestones\/[^/]+\/submit$/u.test(new URL(response.url()).pathname), { timeout: 30_000 })); const staleSubmitControl = await visibleControl(stalePage, ["button"], [/submit/i]); await tabTo(stalePage, staleSubmitControl); await stalePage.keyboard.press("Enter"); const staleSubmit = await staleSubmitPending; ctx.equal(staleSubmit.status(), 409, "stale keyboard submit receives conflict"); await requireVisibleEvidence(stalePage, /conflict|stale|already|409/i); await page.reload({ waitUntil: "networkidle" }); const disputeControl = await visibleControl(page, ["button"], [/dispute/i]); await tabTo(page, disputeControl); await page.keyboard.press("Enter"); await keyboardFill(page, await visibleField(page, [/reason/i]), "Keyboard permission dispute"); const openedPending = observeBrowserWait(page.waitForResponse((response) => response.request().method() === "POST" && /\/disputes$/u.test(new URL(response.url()).pathname), { timeout: 30_000 })); const openButton = await visibleControl(page, ["button"], [/open.*dispute/i, /submit.*dispute/i]); await tabTo(page, openButton); await page.keyboard.press("Enter"); const openedResponse = await openedPending; ctx.equal(openedResponse.status(), 200, "keyboard Dispute open"); const opened = assertDispute(await openedResponse.json()); await page.reload({ waitUntil: "networkidle" }); const denied = await resolveViaBrowser(ctx, page, opened.disputeId, "REFUND", { token: "invalid-token", expectedStatus: 401, keyboard: true }); semanticError(denied, 401, "ADMIN_AUTH_REQUIRED"); await requireVisibleEvidence(page, /permission|unauthori|admin.*required|401/i); await resolveViaBrowser(ctx, page, opened.disputeId, "REFUND", { keyboard: true }); await page.reload({ waitUntil: "networkidle" }); await requireVisibleEvidence(page, /refunded/i);
    await browserContext.setOffline(true); await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); await requireVisibleEvidence(page, /offline|retry|network/i); await browserContext.setOffline(false); await page.reload({ waitUntil: "networkidle" }); const metrics = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth })); ctx.ok(metrics.width <= metrics.viewport + 1, "mobile viewport no horizontal overflow"); const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const desktop = await desktopContext.newPage(); desktop.on("console", (message) => consoleMessages.push(message.text())); let delayed = false; await desktop.route("**/api/v1/escrows**", async (route) => { delayed = true; await new Promise((resolve) => setTimeout(resolve, 250)); await route.continue(); }); const loadingNavigation = observeBrowserWait(desktop.goto(shield.baseUrl, { waitUntil: "networkidle" })); await desktop.getByText(/loading|please wait/i).first().waitFor({ state: "visible", timeout: 2_000 }); await loadingNavigation; ctx.ok(delayed, "desktop loading state is backed by delayed real HTTP"); await openEscrow(ctx, desktop, escrow.escrowId); const desktopMetrics = await desktop.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth })); ctx.ok(desktopMetrics.width <= desktopMetrics.viewport + 1, "desktop viewport no horizontal overflow");
    const assetUrls = await page.evaluate(() => [...new Set(performance.getEntriesByType("resource").map(({ name }) => name).filter((name) => /\.(?:m?js|css)(?:[?#]|$)/iu.test(name)))]); ctx.ok(assetUrls.length > 0, "production UI loaded inspectable JavaScript or CSS assets"); const assetBodies = []; for (const assetUrl of assetUrls) { const asset = await browserContext.request.get(assetUrl); ctx.ok(asset.ok(), `production asset ${new URL(assetUrl).pathname} loads`); assetBodies.push(await asset.text()); } const visibleText = `${await page.locator("body").innerText()}\n${await desktop.locator("body").innerText()}`, html = `${await page.content()}\n${await desktop.content()}`, bundle = assetBodies.join("\n"), logs = `${api.logs ?? ""}\n${consoleMessages.join("\n")}`, idempotencyKey = createCaptures[0].request.headers["idempotency-key"]; for (const secret of [ctx.adminToken, ctx.barrierToken, idempotencyKey]) ctx.ok(!visibleText.includes(secret) && !html.includes(secret) && !bundle.includes(secret) && !logs.includes(secret), "production bundle, UI and logs omit evaluator secret and idempotency key"); assertNoPrivatePaths(`${html}\n${bundle}\n${logs}`, "production bundle, UI and logs"); const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); ctx.equal(resources(snapshot).escrows.filter(({ escrowId }) => escrowId === escrow.escrowId).length, 1, "response-loss retry did not duplicate Escrow"); return finalEvidence(ctx, { escrowId: escrow.escrowId, mobileViewport: metrics.viewport, desktopViewport: desktopMetrics.viewport, retryCaptures: createCaptures.length, inspectedAssets: assetUrls.length, visibleNegativeStates: ["validation", "conflict", "permission", "loading", "offline", "retry", "terminal"] }); } });

const D06 = defineCase({ id: "D-06", fixtureFamily: "EG-F-CROSS-LAYER", action: "Create a two-Milestone FINAL aggregate, release the first captured allocation and dispute the second, then read every concrete Escrow, Milestone, Share, Release, Payout, Dispute, Work and Event identity from detail, production browser, exact OpenAPI, snapshot and aggregate Event query.", oracle: "Amount, state, ordering and every named resource identity map across every applicable layer; each node is backed by an executed public observation, and no generic page string or hard-coded true can close a resource-specific node.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx)); const { api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } }); const escrow = await createEscrow(ctx, api.baseUrl, beneficiaryRequest(fixture, [2, 2]), { key: ctx.key("cross-layer-create") }); const page = await submitViaBrowser(ctx, api.baseUrl, escrow.escrowId); let detail = await getDetail(ctx, api.baseUrl, escrow.escrowId); const firstMilestone = detail.milestones[0]; assertRelease(successful(await ctx.mutate(api.baseUrl, `/api/v1/escrows/${escrow.escrowId}/milestones/${firstMilestone.milestoneId}/accept`, ctx.key("cross-layer-accept"), {}), "cross-layer accept", 200).json, { response: true }); await reloadEscrow(ctx, page, escrow.escrowId); const secondSubmit = await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u); ctx.ok(secondSubmit.status() >= 200 && secondSubmit.status() < 300, "second visible submit"); detail = await getDetail(ctx, api.baseUrl, escrow.escrowId); const secondMilestone = detail.milestones[1]; const dispute = await openDispute(ctx, api.baseUrl, escrow.escrowId, secondMilestone.milestoneId, "SELLER", "Cross-layer dispute"); await page.reload({ waitUntil: "networkidle" }); detail = await getDetail(ctx, api.baseUrl, escrow.escrowId); const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); const data = resources(snapshot), events = await queryEvents(ctx, api.baseUrl, { aggregateId: escrow.escrowId, limit: 100 }), openapi = successful(await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI", 200).json; ctx.ok(assertEscrowGuardOpenApi(openapi), "exact OpenAPI node"); const detailTraffic = successful(await ctx.request(api.baseUrl, `/api/v1/escrows/${escrow.escrowId}`), "cross-layer detail traffic", 200), eventTraffic = successful(await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${escrow.escrowId}&limit=100`), "cross-layer Event traffic", 200); const openapiTraffic = Boolean(assertTrafficMatchesOpenApi(openapi, "/api/v1/escrows/{escrowId}", "get", detailTraffic) && assertTrafficMatchesOpenApi(openapi, "/api/v1/domain-events", "get", eventTraffic)); const aggregateWork = snapshot.work.find(({ aggregateId, kind }) => aggregateId === escrow.escrowId && kind === "ESCROW_EXPIRY"), aggregateEvents = snapshot.events.filter(({ aggregateId }) => aggregateId === escrow.escrowId); ctx.ok(aggregateWork, "concrete expiry Work exists"); ctx.equal(events.items.map(({ eventId }) => eventId), aggregateEvents.map(({ eventId }) => eventId), "aggregate query and snapshot Event identities agree"); ctx.equal(detail.escrow.state, "DISPUTED", "complex aggregate state"); ctx.equal(detail.milestones.map(({ state }) => state), ["RELEASED", "DISPUTED"], "complex Milestone order/state"); ctx.equal(detail.dispute.disputeId, dispute.disputeId, "detail Dispute identity"); ctx.equal(detail.releases.length, 1, "one concrete Release"); ctx.equal(detail.beneficiaryShares.length, 4, "four captured Shares"); ctx.equal(detail.beneficiaryPayouts.length, 2, "only released first allocation paid"); const concreteIds = [detail.escrow.escrowId, ...detail.milestones.map(({ milestoneId }) => milestoneId), ...detail.beneficiaryShares.map(({ beneficiaryShareId }) => beneficiaryShareId), ...detail.releases.map(({ releaseId }) => releaseId), ...detail.beneficiaryPayouts.map(({ payoutId }) => payoutId), detail.dispute.disputeId, aggregateWork.workId, ...aggregateEvents.map(({ eventId }) => eventId)]; const visibleIds = new Set(); for (const identity of concreteIds) { await requireVisibleEvidence(page, identityPattern(identity), [/detail/i, /share|beneficiar/i, /payout|release/i, /dispute/i, /work|task/i, /event|history/i]); visibleIds.add(identity); } const snapshotIds = new Set([data.escrows.find(({ escrowId }) => escrowId === escrow.escrowId)?.escrowId, ...data.milestones.filter(({ escrowId }) => escrowId === escrow.escrowId).map(({ milestoneId }) => milestoneId), ...data.beneficiaryShares.filter(({ milestoneId }) => detail.milestones.some((item) => item.milestoneId === milestoneId)).map(({ beneficiaryShareId }) => beneficiaryShareId), ...data.releases.filter(({ escrowId }) => escrowId === escrow.escrowId).map(({ releaseId }) => releaseId), ...data.beneficiaryPayouts.filter(({ releaseId }) => detail.releases.some((item) => item.releaseId === releaseId)).map(({ payoutId }) => payoutId), ...data.disputes.filter(({ escrowId }) => escrowId === escrow.escrowId).map(({ disputeId }) => disputeId), aggregateWork.workId, ...aggregateEvents.map(({ eventId }) => eventId)]); const nodes = { detail: concreteIds.every((identity) => snapshotIds.has(identity)), browser: concreteIds.every((identity) => visibleIds.has(identity)), snapshot: snapshotIds.size === new Set(concreteIds).size, work: aggregateWork.aggregateId === escrow.escrowId, event: aggregateEvents.length >= 5 && aggregateEvents.every(({ aggregateId }) => aggregateId === escrow.escrowId), openapi: openapiTraffic }; ctx.ok(Object.values(nodes).every(Boolean), `cross-layer concrete closure ${JSON.stringify(nodes)}`); return finalEvidence(ctx, { escrowId: escrow.escrowId, concreteIdentityCount: concreteIds.length, visibleIdentityCount: visibleIds.size, nodes }); } });

function addPidSamples(samples, pids) {
  for (const pid of pids) samples[pid] = (samples[pid] ?? 0) + 1;
}

function ancestorCommands(pid, rowsByPid) {
  const commands = [];
  const visited = new Set();
  let current = rowsByPid.get(pid);
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    commands.push(current.command);
    current = rowsByPid.get(current.ppid);
  }
  return commands.join("\n");
}

function sameProcessBranch(left, right, rowsByPid) {
  const ancestors = (pid) => {
    const values = new Set();
    let current = rowsByPid.get(pid);
    while (current && !values.has(current.pid)) { values.add(current.pid); current = rowsByPid.get(current.ppid); }
    return values;
  };
  const leftAncestors = ancestors(left), rightAncestors = ancestors(right);
  return leftAncestors.has(right) || rightAncestors.has(left);
}

async function processSocketSnapshot(pids, { databasePort, watchedPorts = [] } = {}) {
  const ownersByInode = new Map();
  for (const pid of pids) {
    for (const name of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
      const target = await readlink(`/proc/${pid}/fd/${name}`).catch(() => "");
      const match = /^socket:\[(\d+)\]$/u.exec(target);
      if (!match) continue;
      const owners = ownersByInode.get(match[1]) ?? new Set();
      owners.add(pid);
      ownersByInode.set(match[1], owners);
    }
  }
  const rows = [];
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (await readFile(path, "utf8").catch(() => "")).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || !ownersByInode.has(fields[9])) continue;
      rows.push({
        inode: fields[9],
        state: fields[3],
        localPort: Number.parseInt(fields[1].split(":").at(-1), 16),
        remotePort: Number.parseInt(fields[2].split(":").at(-1), 16),
        owners: ownersByInode.get(fields[9]),
      });
    }
  }
  const listeners = rows.filter(({ state }) => state === "0A" && databasePort !== undefined).filter(({ localPort }) => localPort !== databasePort);
  const established = rows.filter(({ state }) => state === "01");
  const databaseClientPids = new Set(established.filter(({ remotePort }) => remotePort === databasePort).flatMap(({ owners }) => [...owners]));
  const clientsByRemotePort = Object.fromEntries(watchedPorts.map((port) => [port, [...new Set(established.filter(({ remotePort }) => remotePort === port).flatMap(({ owners }) => [...owners]))]]));
  return { listeners, established, databaseClientPids, clientsByRemotePort };
}

function portOf(url) {
  const target = new URL(url);
  return Number(target.port || (target.protocol === "https:" ? 443 : 80));
}

async function createHttpTraceProbe(ctx) {
  const preload = ctx.tempPath("escrowguard-http-trace.cjs");
  await writeFile(preload, `"use strict";
const fs = require("node:fs");
const http = require("node:http");
const marker = Symbol.for("frontal.escrowguard.http.trace");
if (!http.Server.prototype[marker]) {
  Object.defineProperty(http.Server.prototype, marker, { value: true });
  const originalEmit = http.Server.prototype.emit;
  let ordinal = 0;
  http.Server.prototype.emit = function (event, request, response, ...rest) {
    if (event === "request" && request && response) {
      ordinal += 1;
      const sampled = ordinal <= 128 || ordinal % 1000 === 0;
      if (sampled) response.once("finish", () => {
        try {
          const pathname = new URL(request.url || "/", "http://escrowguard.invalid").pathname;
          fs.appendFileSync(process.env.FRONTAL_ESCROWGUARD_HTTP_TRACE, JSON.stringify({ pid: process.pid, method: request.method, path: pathname, status: response.statusCode, userAgent: String(request.headers["user-agent"] || "").slice(0, 256) }) + "\\n", { encoding: "utf8" });
        } catch {}
      });
    }
    return originalEmit.call(this, event, request, response, ...rest);
  };
}
`);
  return preload;
}

function withHttpTrace(environment, preload, tracePath) {
  const nodeOptions = [environment.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
  return { ...environment, NODE_OPTIONS: nodeOptions, FRONTAL_ESCROWGUARD_HTTP_TRACE: tracePath };
}

export async function readHttpTrace(path) {
  const rows = [];
  for (const line of (await readFile(path, "utf8").catch(() => "")).split(/\r?\n/u).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      if (Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.method === "string" && typeof value.path === "string" && Number.isSafeInteger(value.status)) rows.push({ ...value, userAgent: String(value.userAgent ?? "").slice(0, 256) });
    } catch {}
  }
  return rows.slice(0, 16_384);
}

export function assertCandidateBusinessTraffic(observation, { apiCount = 1, label = "project gate", requireIdentity = true, requiredUserAgent } = {}) {
  const traffic = (observation.candidateHttpTraffic ?? []).filter(({ path }) => /^\/api\/v1(?:\/|$)/u.test(path));
  assert.ok(traffic.length > 0, `${label} executes candidate-owned public business HTTP traffic`);
  const successfulMutations = traffic.filter(({ method, status }) => method === "POST" && status >= 200 && status < 300);
  assert.ok(successfulMutations.length > 0, `${label} executes a successful public mutation rather than only health probes`);
  if (requireIdentity) assert.ok(traffic.some(({ path }) => /\/[0-9a-f]{8}-[0-9a-f-]{27,}\b/iu.test(path)), `${label} observes a concrete public resource identity in an HTTP path`);
  const verified = new Set(observation.verifiedApiPids ?? []);
  const verifiedTraffic = traffic.filter(({ pid }) => verified.has(pid));
  assert.ok(new Set(verifiedTraffic.map(({ pid }) => pid)).size >= apiCount, `${label} business traffic reaches ${apiCount} API process authorities independently verified against PostgreSQL`);
  assert.ok(successfulMutations.some(({ pid }) => verified.has(pid)), `${label} successful mutation reaches a PostgreSQL-backed verified API authority`);
  if (requiredUserAgent) assert.ok(successfulMutations.some(({ pid, userAgent }) => verified.has(pid) && userAgent === requiredUserAgent), `${label} successful mutation is issued by evaluator-selected production Chromium`);
  return { traffic: traffic.length, successfulMutations: successfulMutations.length };
}

async function collectUnitCoverage(directory, workspace) {
  const workspaceRoot = resolve(workspace);
  const productionFiles = new Set();
  let executedFunctions = 0;
  let executedBytes = 0;
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    let report;
    try { report = JSON.parse(await readFile(resolve(directory, name), "utf8")); } catch { continue; }
    for (const script of report.result ?? []) {
      if (typeof script.url !== "string" || !script.url.startsWith("file:")) continue;
      let path; try { path = fileURLToPath(script.url); } catch { continue; }
      const local = relative(workspaceRoot, resolve(path)).replaceAll("\\", "/");
      if (local.startsWith("../") || local === ".." || /(?:^|\/)(?:node_modules|coverage|test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(local)) continue;
      let fileExecuted = false;
      for (const fn of script.functions ?? []) {
        if (typeof fn.functionName !== "string" || fn.functionName.trim() === "") continue;
        const range = fn.ranges?.[0];
        if (!range || range.count <= 0) continue;
        fileExecuted = true;
        executedFunctions += 1;
        executedBytes += Math.max(0, range.endOffset - range.startOffset);
      }
      if (fileExecuted) productionFiles.add(local);
    }
  }
  return { unitProductionFiles: [...productionFiles].sort(), unitExecutedFunctions: executedFunctions, unitExecutedBytes: executedBytes };
}

export function assertUnitGateObservation(observation) {
  assert.ok((observation.unitProductionFiles ?? []).length > 0, "unit gate executes Candidate production code, not only a test launcher or sleep");
  assert.ok((observation.unitExecutedFunctions ?? 0) >= 2, "unit gate executes multiple named production functions, not only module import initialization");
  assert.ok((observation.unitExecutedBytes ?? 0) >= 128, "unit gate exercises a non-vacuous production-code boundary");
  return true;
}

async function runGate(ctx, target, script, { env = {}, watchedPorts = [], onSample, httpTrace } = {}) {
  const effectiveEnvironment = httpTrace ? withHttpTrace(env, httpTrace.preload, httpTrace.path) : env;
  const gateProcess = await target.startProcess(`gate-${script}`, script, { env: effectiveEnvironment });
  const observation = {
    maxDescendants: 0,
    maxHttpListeners: 0,
    maxConcurrentApiClients: 0,
    observedApiPorts: [],
    observedApiPids: [],
    verifiedApiPids: [],
    observedWorkerPids: [],
    apiDatabasePids: [],
    databaseClientPidSamples: {},
    workerPidSamples: {},
    httpProbeSuccesses: 0,
    descendantCommands: [],
    evaluatorKills: [],
    evaluatorKilledPidsExited: [],
  };
  const databasePort = portOf(ctx.databaseUrl);
  let lastSocketSampleAt = 0;
  const lastApiProbeAt = new Map();
  while (gateProcess.child.exitCode === null) {
    const tree = await target.command("ps", ["-axo", "pid=,ppid=,command="], { allowFailure: true, timeoutMs: 5_000 });
    if (tree.exitCode === 0) {
      const rows = tree.stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u)).filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
      const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
      const descendants = new Set([gateProcess.pid]);
      let changed = true;
      while (changed) { changed = false; for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
      const childRows = rows.filter(({ pid }) => pid !== gateProcess.pid && descendants.has(pid));
      observation.maxDescendants = Math.max(observation.maxDescendants, childRows.length);
      observation.descendantCommands = [...new Set([...observation.descendantCommands, ...childRows.map(({ command }) => command)])];
      observation.evaluatorKilledPidsExited = observation.evaluatorKills.filter(({ pid }) => !descendants.has(pid)).map(({ pid }) => pid);
      if (Date.now() - lastSocketSampleAt >= 100) {
        const socket = await processSocketSnapshot(childRows.map(({ pid }) => pid), { databasePort, watchedPorts });
        observation.maxHttpListeners = Math.max(observation.maxHttpListeners, socket.listeners.length);
        const listenerPorts = [...new Set(socket.listeners.map(({ localPort }) => localPort))];
        for (const port of listenerPorts) {
          if (observation.observedApiPorts.includes(port) || Date.now() - (lastApiProbeAt.get(port) ?? 0) < 2_000) continue;
          lastApiProbeAt.set(port, Date.now());
          const baseUrl = `http://127.0.0.1:${port}`;
          const health = await ctx.request(baseUrl, "/healthz", { timeoutMs: 300 }).catch(() => undefined);
          const openapi = health?.status === 200 ? await ctx.request(baseUrl, "/openapi.json", { timeoutMs: 500 }).catch(() => undefined) : undefined;
          const collection = openapi?.status === 200 && /^3\.1/u.test(openapi.json?.openapi ?? "") ? await ctx.request(baseUrl, "/api/v1/escrows", { timeoutMs: 1_000 }).catch(() => undefined) : undefined;
          if (collection?.status !== 200 || !Array.isArray(collection.json?.items)) continue;
          observation.observedApiPorts.push(port);
          observation.httpProbeSuccesses += 3;
          const owners = socket.listeners.filter(({ localPort }) => localPort === port).flatMap(({ owners }) => [...owners]);
          observation.observedApiPids = [...new Set([...observation.observedApiPids, ...owners])];
        }
        addPidSamples(observation.databaseClientPidSamples, socket.databaseClientPids);
        const apiPids = new Set(observation.observedApiPids);
        const apiDatabasePids = [...socket.databaseClientPids].filter((pid) => [...apiPids].some((apiPid) => sameProcessBranch(pid, apiPid, rowsByPid)));
        observation.apiDatabasePids = [...new Set([...observation.apiDatabasePids, ...apiDatabasePids])];
        const verifiedApiPids = [...apiPids].filter((apiPid) => [...socket.databaseClientPids].some((databasePid) => sameProcessBranch(databasePid, apiPid, rowsByPid)));
        observation.verifiedApiPids = [...new Set([...observation.verifiedApiPids, ...verifiedApiPids])];
        const workerPids = [...socket.databaseClientPids].filter((pid) => !apiDatabasePids.includes(pid) && /(?:^|[/\s:_-])worker(?:[.\s/_-]|$)|start:worker/iu.test(ancestorCommands(pid, rowsByPid)));
        addPidSamples(observation.workerPidSamples, workerPids);
        observation.observedWorkerPids = [...new Set([...observation.observedWorkerPids, ...workerPids])];
        const apiPorts = new Set(observation.observedApiPorts);
        const clientSockets = new Set(socket.established.filter(({ remotePort }) => apiPorts.has(remotePort)).map(({ inode }) => inode));
        observation.maxConcurrentApiClients = Math.max(observation.maxConcurrentApiClients, clientSockets.size);
        if (onSample) await onSample({ observation, socket, descendants, childRows, rowsByPid, workerPids, gateProcess });
        lastSocketSampleAt = Date.now();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [code, signal] = await gateProcess.exited;
  ctx.equal(code, 0, `${script} exit`);
  ctx.equal(signal, null, `${script} signal`);
  if (httpTrace) observation.candidateHttpTraffic = await readHttpTrace(httpTrace.path);
  return { process: gateProcess, observation, durationMs: performance.now() - gateProcess.spawnedAt };
}
async function runGateFailure(ctx, target, script, env, label) {
  const process = await target.startProcess(`negative-${script}`, script, { env }); const exited = await Promise.race([process.exited.then(([code, signal]) => ({ code, signal })), new Promise((resolve) => setTimeout(() => resolve(undefined), 30_000))]);
  if (!exited) { await ctx.kill(process); ctx.ok(false, `${label} did not fail within the evaluator dependency watchdog`); }
  ctx.ok(exited.code !== 0 || exited.signal !== null, `${label} must fail nonzero when its required external dependency is unavailable`); return { process, ...exited };
}

export function assertHttpDatabaseGateObservation(observation, { apiCount = 1 } = {}) {
  assert.ok(new Set(observation.observedApiPorts ?? []).size >= apiCount, `${apiCount} public API listener(s) answer health, OpenAPI and collection traffic`);
  assert.ok(new Set(observation.observedApiPids ?? []).size >= apiCount, `${apiCount} distinct API process authorities own verified listeners`);
  assert.ok((observation.httpProbeSuccesses ?? 0) >= apiCount * 3, "evaluator completed real health, OpenAPI and collection HTTP responses");
  assert.ok(new Set(observation.apiDatabasePids ?? []).size >= apiCount, "verified API process authorities hold real PostgreSQL connections");
  assert.ok(new Set(observation.verifiedApiPids ?? []).size >= apiCount, "each verified API listener belongs to a process branch with a real PostgreSQL connection");
  if (observation.databaseTransactionDelta !== undefined) assert.ok(observation.databaseTransactionDelta > 1, "the gate causes PostgreSQL transactions beyond the evaluator counter query");
  return true;
}

export function assertConcurrentGateObservation(observation, { apiCount = 2, workerCount = 2 } = {}) {
  assertHttpDatabaseGateObservation(observation, { apiCount });
  assert.ok(new Set(observation.observedWorkerPids ?? []).size >= workerCount, `${workerCount} distinct non-API Worker process authorities connect to PostgreSQL`);
  assert.ok((observation.maxDescendants ?? 0) >= apiCount + workerCount, "concurrency gate exposes independent API and Worker descendants");
  return true;
}

function evaluatorRecoveryKiller(barrier, barrierPort) {
  return async ({ observation, socket, workerPids }) => {
    if (observation.evaluatorKills.length > 0) return;
    const held = barrier.ledger.find(({ json, released, disconnected }) => json?.processRole === "worker" && json.point === "worker.claimed" && !released && !disconnected);
    if (!held) return;
    const clients = new Set(socket.clientsByRemotePort[barrierPort] ?? []);
    const pid = workerPids.find((candidate) => clients.has(candidate));
    if (!pid) return;
    try {
      globalThis.process.kill(pid, "SIGKILL");
      observation.evaluatorKills.push({ pid, workId: held.json.workId, aggregateId: held.json.aggregateId, attempt: held.json.attempt });
    } catch {}
  };
}

function processExists(pid) {
  try { globalThis.process.kill(pid, 0); return true; } catch { return false; }
}

export function assertRecoveryGateObservation(observation) {
  const [killed] = observation.evaluatorKills ?? [];
  assert.ok(killed?.pid > 0 && killed.workId, "evaluator SIGKILLs the exact Worker connected to its held barrier request");
  assert.ok((observation.evaluatorKilledPidsExited ?? []).includes(killed.pid), "evaluator observes the SIGKILLed Worker process disappear");
  const killedEntry = (observation.barrierLedger ?? []).find(({ json }) => json?.processRole === "worker" && json.point === "worker.claimed" && json.workId === killed.workId && json.attempt === killed.attempt);
  assert.ok(killedEntry?.disconnected && !killedEntry.released, "the exact held barrier connection is severed by evaluator SIGKILL");
  const replacement = (observation.barrierLedger ?? []).find(({ json }) => json?.processRole === "worker" && json.point === "worker.claimed" && json.workId === killed.workId && json.attempt > killed.attempt);
  assert.ok(replacement, "a replacement Worker reclaims the evaluator-killed Work at a later attempt");
  assert.ok(new Set(observation.observedWorkerPids ?? []).size >= 2, "recovery exposes original and replacement Worker authorities");
  return { killedPid: killed.pid, workId: killed.workId, replacementAttempt: replacement.json.attempt };
}

async function databaseCounters(ctx, target) {
  const sql = "select coalesce(xact_commit+xact_rollback,0),coalesce(tup_inserted+tup_updated+tup_deleted,0) from pg_stat_database where datname=current_database()";
  const result = await target.command("psql", [ctx.databaseUrl, "-At", "-F", "|", "-c", sql], { timeoutMs: 5_000 });
  ctx.equal(result.exitCode, 0, "PostgreSQL performance counters query");
  const [transactions, tuplesChanged] = result.stdout.trim().split("|").map(Number);
  ctx.ok(Number.isFinite(transactions) && Number.isFinite(tuplesChanged), "PostgreSQL performance counters are numeric");
  return { transactions, tuplesChanged };
}

export function assertFixedPerformanceGateObservation(observation, { dueCount = 5_000 } = {}) {
  assert.ok(observation.durationMs >= 140_000, "fixed performance gate sustains both ten-second warm-ups and sixty-second HTTP windows");
  assert.ok(observation.databaseTransactionDelta >= 22_800, "fixed HTTP workloads execute at least 18,000 reads and 4,800 creates through PostgreSQL");
  assert.ok(observation.databaseTupleDelta >= 100_000, "fixed performance seeds and mutations change at least 100,000 PostgreSQL tuples");
  assertConcurrentGateObservation(observation);
  assertCandidateBusinessTraffic(observation, { apiCount: 2, label: "fixed performance gate" });
  assert.ok(observation.maxConcurrentApiClients >= 64, "evaluator observes the published 64-client closed-loop HTTP concurrency");
  const traffic = observation.candidateHttpTraffic ?? [];
  assert.ok(traffic.some(({ method, path, status }) => method === "GET" && /^\/api\/v1\/escrows\/[0-9a-f-]+$/iu.test(path) && status === 200), "fixed performance gate executes successful concrete Escrow detail reads inside Candidate APIs");
  assert.ok(traffic.some(({ method, path, status }) => method === "POST" && path === "/api/v1/escrows" && status === 201), "fixed performance gate executes successful funded Escrow creates inside Candidate APIs");
  const claims = observation.barrierLedger.filter(({ json }) => json?.processRole === "worker" && json.point === "worker.claimed");
  const byWork = Map.groupBy(claims, ({ json }) => json.workId);
  assert.equal(byWork.size, dueCount, `exactly ${dueCount} fixed due Work identities are claimed`);
  assert.equal(new Set(claims.map(({ json }) => json.aggregateId)).size, dueCount, `exactly ${dueCount} fixed due aggregate identities are claimed`);
  const recovered = [...byWork.values()].filter((entries) => new Set(entries.map(({ json }) => json.attempt)).size >= 2);
  assert.ok(recovered.length >= 2, "the two held Work identities expose replacement attempts after process loss");
  return { claimedWorkCount: byWork.size, recoveredWorkCount: recovered.length };
}

const D07 = defineCase({ id: "D-07", fixtureFamily: "EG-F-PROJECT-GATES", action: "Run every published unit, integration, production-browser E2E, concurrency, recovery, all and performance command while externally observing PostgreSQL, Chromium and barrier activity; then rerun dependency-sensitive gates with unavailable PostgreSQL, Chromium and barrier seams.", oracle: "Every positive gate exits zero only with real external work, each corresponding unavailable dependency makes its gate fail nonzero, concurrency exposes multiple database authorities, recovery reaches public barriers, and performance runs for the fixed HTTP window and reaches the worker seam rather than passing through zero tests, printed strings or swallowed failures.", async run(ctx) {
    const target = ctx.forWorkspace(ctx.workspace);
    await target.npm("build", [], { timeoutMs: 240_000 });
    await target.migrate();
    const marker = ctx.tempPath("chromium-invocations.log"), wrapper = ctx.tempPath("chromium-wrapper.sh"), browserUserAgent = ctx.key("evaluator-browser-authority");
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${marker}'\nexec '${process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"}' '--user-agent=${browserUserAgent}' "$@"\n`);
    await chmod(wrapper, 0o700);
    const httpPreload = await createHttpTraceProbe(ctx);
    const httpTrace = async (label) => {
      const path = ctx.tempPath(`candidate-http-${label}.jsonl`);
      await writeFile(path, "", { mode: 0o600 });
      return { preload: httpPreload, path };
    };

    const unitCoverage = ctx.tempPath("unit-v8-coverage");
    await mkdir(unitCoverage, { recursive: true });
    const unit = await runGate(ctx, target, "test:unit", { env: { NODE_V8_COVERAGE: unitCoverage } });
    Object.assign(unit.observation, await collectUnitCoverage(unitCoverage, ctx.workspace));
    ctx.ok(assertUnitGateObservation(unit.observation), "unit gate executes Candidate production code");

    await ctx.resetDatabase(); await target.migrate();
    const integrationCountersBefore = await databaseCounters(ctx, target);
    const integration = await runGate(ctx, target, "test:integration", { httpTrace: await httpTrace("integration") });
    const integrationCountersAfter = await databaseCounters(ctx, target);
    integration.observation.databaseTransactionDelta = Math.max(0, integrationCountersAfter.transactions - integrationCountersBefore.transactions);
    assertHttpDatabaseGateObservation(integration.observation);
    const integrationTraffic = assertCandidateBusinessTraffic(integration.observation, { label: "integration gate" });

    await ctx.resetDatabase(); await target.migrate();
    const e2eCountersBefore = await databaseCounters(ctx, target);
    const markerBeforeE2e = (await readFile(marker).catch(() => Buffer.alloc(0))).byteLength;
    const e2e = await runGate(ctx, target, "test:e2e", { env: { CHROMIUM_PATH: wrapper }, httpTrace: await httpTrace("e2e") });
    const e2eCountersAfter = await databaseCounters(ctx, target);
    e2e.observation.databaseTransactionDelta = Math.max(0, e2eCountersAfter.transactions - e2eCountersBefore.transactions);
    assertHttpDatabaseGateObservation(e2e.observation);
    const e2eTraffic = assertCandidateBusinessTraffic(e2e.observation, { label: "E2E gate", requiredUserAgent: browserUserAgent });
    const chromiumInvocationBytes = (await readFile(marker).catch(() => Buffer.alloc(0))).byteLength;
    ctx.ok(chromiumInvocationBytes > markerBeforeE2e, "E2E invokes evaluator-selected production Chromium while real API/PostgreSQL traffic is observed");
    ctx.mark("layer.ui", { chromiumInvocationBytes });

    await ctx.resetDatabase(); await target.migrate();
    const concurrency = await runGate(ctx, target, "test:concurrency", { httpTrace: await httpTrace("concurrency") });
    assertConcurrentGateObservation(concurrency.observation);
    const concurrencyTraffic = assertCandidateBusinessTraffic(concurrency.observation, { apiCount: 2, label: "concurrency gate", requireIdentity: false });

    await ctx.resetDatabase(); await target.migrate();
    let recoveryHeldWorkId;
    const barrier = await ctx.barrier({ hold: (payload) => payload.processRole === "worker" && payload.point === "worker.claimed" && (recoveryHeldWorkId === undefined || payload.workId === recoveryHeldWorkId) && (recoveryHeldWorkId ??= payload.workId) === payload.workId && payload.attempt === 1 });
    const barrierPort = portOf(barrier.url);
    const recovery = await runGate(ctx, target, "test:recovery", {
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
      watchedPorts: [barrierPort],
      onSample: evaluatorRecoveryKiller(barrier, barrierPort),
    });
    const killed = recovery.observation.evaluatorKills[0];
    if (killed) {
      await ctx.waitFor(() => barrier.ledger.find(({ json }) => json?.workId === killed.workId && json.attempt === killed.attempt)?.disconnected, { timeoutMs: 5_000, label: "evaluator-killed recovery barrier disconnect" });
      await ctx.waitFor(() => !processExists(killed.pid), { timeoutMs: 5_000, label: "evaluator-killed Worker process exit" });
      if (!recovery.observation.evaluatorKilledPidsExited.includes(killed.pid)) recovery.observation.evaluatorKilledPidsExited.push(killed.pid);
    }
    recovery.observation.barrierLedger = barrier.ledger;
    const recoveryEvidence = assertRecoveryGateObservation(recovery.observation);

    await ctx.resetDatabase(); await target.migrate();
    const allBarrier = await ctx.barrier();
    const markerBeforeAll = chromiumInvocationBytes;
    const all = await runGate(ctx, target, "test:all", { env: { CHROMIUM_PATH: wrapper, TEST_BARRIER_URL: allBarrier.url, TEST_BARRIER_TOKEN: allBarrier.token }, httpTrace: await httpTrace("all") });
    assertConcurrentGateObservation(all.observation);
    const allTraffic = assertCandidateBusinessTraffic(all.observation, { apiCount: 2, label: "all gate", requireIdentity: false });
    const markerAfterAll = (await readFile(marker).catch(() => Buffer.alloc(0))).byteLength;
    ctx.ok(markerAfterAll > markerBeforeAll, "test:all reaches production Chromium again");
    ctx.ok(allBarrier.ledger.some(({ json }) => json?.processRole === "worker"), "test:all reaches the public Worker barrier seam");
    await ctx.resetDatabase(); await target.migrate();
    const perfBarrier = await ctx.barrier();
    const perfCountersBefore = await databaseCounters(ctx, target);
    const perf = await runGate(ctx, target, "test:perf", { env: { TEST_BARRIER_URL: perfBarrier.url, TEST_BARRIER_TOKEN: perfBarrier.token }, httpTrace: await httpTrace("perf") });
    const perfCountersAfter = await databaseCounters(ctx, target);
    const performanceObservation = {
      ...perf.observation,
      durationMs: perf.durationMs,
      databaseTransactionDelta: Math.max(0, perfCountersAfter.transactions - perfCountersBefore.transactions),
      databaseTupleDelta: Math.max(0, perfCountersAfter.tuplesChanged - perfCountersBefore.tuplesChanged),
      barrierLedger: perfBarrier.ledger,
    };
    const barrierEvidence = assertFixedPerformanceGateObservation(performanceObservation);
    ctx.mark("layer.database", { transactions: performanceObservation.databaseTransactionDelta, tuplesChanged: performanceObservation.databaseTupleDelta });
    ctx.mark("layer.work", { claimed: barrierEvidence.claimedWorkCount, recovered: barrierEvidence.recoveredWorkCount });
    const postPerfApis = [await target.startApi(), await target.startApi()];
    const postPerf = assertSnapshot(await ctx.snapshot(postPerfApis[0].baseUrl, { timeoutMs: 180_000 }));
    const postData = resources(postPerf);
    ctx.equal(postData.parties.length, 10_000, "test:perf retains the exact fixed Party set");
    ctx.equal(postData.releases.length, 10_000, "test:perf retains the exact fixed Release set");
    const createdAfterSeed = postData.escrows.length - 20_000;
    ctx.ok(createdAfterSeed === 0 || createdAfterSeed >= 4_800, "the final independent scenario is either an exact fixed seed or persists at least 80/s measured funded creates");
    ctx.equal(postData.milestones.length - 60_000, createdAfterSeed, "every post-seed performance Escrow has the one published create Milestone");
    ctx.equal(postPerf.work.length - 20_000, createdAfterSeed, "every post-seed performance Escrow retains one expiry Work");
    const claimedAggregateIds = new Set(perfBarrier.ledger.filter(({ json }) => json?.processRole === "worker" && json.point === "worker.claimed").map(({ json }) => json.aggregateId));
    const claimedEscrows = postData.escrows.filter(({ escrowId }) => claimedAggregateIds.has(escrowId));
    const claimedWork = postPerf.work.filter(({ aggregateId }) => claimedAggregateIds.has(aggregateId));
    ctx.equal(claimedEscrows.length, 5_000, "all fixed due Escrows remain snapshot-observable");
    const recoveredDue = claimedEscrows.filter(({ state }) => state === "REFUNDED");
    ctx.ok(recoveredDue.length === 0 || recoveredDue.length === 5_000, "an independent later scenario may reset the fixed seed, but expiry recovery never leaves a partial terminal set");
    ctx.ok(recoveredDue.length > 0 ? recoveredDue.every(({ releasedMinor, refundedMinor, totalMinor }) => refundedMinor > 0 && releasedMinor + refundedMinor === totalMinor) : claimedEscrows.every(({ state }) => state === "FUNDED"), "the observable fixed due set is either pristine or fully conserving REFUNDED");
    ctx.equal(claimedWork.length, 5_000, "all fixed due Escrows retain exactly one Work");
    ctx.equal(claimedWork.filter(({ terminal }) => terminal).length, recoveredDue.length, "fixed due Work terminality exactly follows the all-or-none recovery state");
    const refundEventCount = new Map(); for (const { aggregateId, type } of postPerf.events) if (type === "escrow.refunded") refundEventCount.set(aggregateId, (refundEventCount.get(aggregateId) ?? 0) + 1);
    for (const aggregateId of claimedAggregateIds) ctx.equal(refundEventCount.get(aggregateId) ?? 0, recoveredDue.length > 0 ? 1 : 0, `fixed due Escrow ${aggregateId} refund Event matches the observable independent scenario`);
    const sampledIds = [...claimedAggregateIds].sort().slice(0, 64);
    const sampledDetails = await ctx.concurrent(sampledIds, 16, async (escrowId, index) => getDetail(ctx, postPerfApis[index % 2].baseUrl, escrowId));
    ctx.ok(sampledDetails.every(({ escrow, fundPosition }) => escrow.state === (recoveredDue.length > 0 ? "REFUNDED" : "FUNDED") && fundPosition.totalMinor === fundPosition.availableMinor + fundPosition.releasedMinor + fundPosition.refundedMinor), "two public APIs corroborate the exact fixed-workload snapshot authority");
    const unavailableDatabase = `postgresql://postgres@127.0.0.1:${await ctx.freePort()}/escrowguard_unavailable`;
    await runGateFailure(ctx, target, "test:integration", { DATABASE_URL: unavailableDatabase, TEST_DATABASE_URL: unavailableDatabase }, "integration PostgreSQL dependency");
    await runGateFailure(ctx, target, "test:perf", { DATABASE_URL: unavailableDatabase, TEST_DATABASE_URL: unavailableDatabase }, "performance PostgreSQL dependency");
    await runGateFailure(ctx, target, "test:e2e", { CHROMIUM_PATH: ctx.tempPath("missing-chromium") }, "E2E Chromium dependency");
    const unavailableBarrier = `http://127.0.0.1:${await ctx.freePort()}/barrier`;
    await runGateFailure(ctx, target, "test:recovery", { TEST_BARRIER_URL: unavailableBarrier, TEST_BARRIER_TOKEN: ctx.barrierToken }, "recovery barrier dependency");
    const databaseAuthorities = [integration, e2e, concurrency, recovery, all, perf].map(({ observation }) => Object.keys(observation.databaseClientPidSamples).length);
    return finalEvidence(ctx, {
      gates: 7,
      negativeDependencies: 4,
      chromiumInvocationBytes: markerAfterAll,
      maxConnections: Math.max(...databaseAuthorities),
      maxObservedGateDescendants: Math.max(unit.observation.maxDescendants, integration.observation.maxDescendants, e2e.observation.maxDescendants, concurrency.observation.maxDescendants, recovery.observation.maxDescendants, all.observation.maxDescendants, perf.observation.maxDescendants),
      recoveryBarrierHits: barrier.ledger.length,
      evaluatorKilledWorkerPid: recoveryEvidence.killedPid,
      recoveredWorkId: recoveryEvidence.workId,
      perfBarrierHits: perfBarrier.ledger.length,
      perfDurationMs: perf.durationMs,
      maxConcurrentApiClients: perf.observation.maxConcurrentApiClients,
      databaseTransactionDelta: performanceObservation.databaseTransactionDelta,
      databaseTupleDelta: performanceObservation.databaseTupleDelta,
      fixedClaimedWork: barrierEvidence.claimedWorkCount,
      fixedRecoveredWork: barrierEvidence.recoveredWorkCount,
      postPerfHttpSamples: sampledDetails.length,
      unitProductionFiles: unit.observation.unitProductionFiles.length,
      unitExecutedFunctions: unit.observation.unitExecutedFunctions,
      candidateBusinessTraffic: integrationTraffic.traffic + e2eTraffic.traffic + concurrencyTraffic.traffic + allTraffic.traffic + performanceObservation.candidateHttpTraffic.length,
    });
  },
});

const EXPECTED_PRIOR_CASE_IDS = Object.freeze([
  "A-01", "A-02", "A-03", "A-04", "A-05", "A-06", "A-07", "A-08", "A-09", "A-10", "A-11", "A-12", "A-13", "A-14", "A-15",
  "B-01", "B-02", "B-03", "B-04", "B-05", "B-06", "B-07", "B-08", "B-09", "B-10",
  "C-01", "C-02", "C-03", "C-04", "C-05", "C-06", "C-07", "C-08",
  "D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07",
  "E-01", "E-02", "E-03", "E-04", "E-05", "E-06", "E-07",
]);
const LEGACY_EXCLUDED_IDS = new Set(["E-01", "E-02", "E-03"]);

function isLegalLegacyExclusion(outcome) {
  return LEGACY_EXCLUDED_IDS.has(outcome?.id)
    && outcome.status === "excluded"
    && outcome.reason === MISSING_V1_CHECKPOINT_REASON
    && isMissingV1CheckpointOutcome({ id: outcome.id, prerequisites: ["V1_CHECKPOINT"] }, outcome);
}

export const ESCROWGUARD_EVIDENCE_REQUIREMENTS = Object.freeze([
  { id: "clean-delivery-and-production-boot", nodes: { readme: ["A-01"], http: ["A-01"], openapi: ["A-01"], ui: ["D-02"], hidden: ["A-01"] } },
  { id: "repeatable-and-compatible-migration", nodes: { readme: ["A-02", "E-01", "E-02", "E-03"], http: ["A-02", "E-01", "E-02"], snapshot: ["A-02", "E-01", "E-02", "E-03"], work: ["E-03"], event: ["E-02"], hidden: ["A-02", "E-01", "E-02", "E-03"] } },
  { id: "strict-atomic-seed", nodes: { readme: ["A-03"], snapshot: ["A-03"], work: ["A-03"], event: ["A-03"], hidden: ["A-03"] } },
  { id: "http-envelope-and-validation", nodes: { readme: ["A-04"], http: ["A-04"], snapshot: ["A-04"], hidden: ["A-04"] } },
  { id: "pagination-detail-and-snapshot", nodes: { readme: ["A-05"], http: ["A-05"], snapshot: ["A-05"], hidden: ["A-05"] } },
  { id: "funded-escrow-creation", nodes: { readme: ["A-06"], http: ["A-06"], snapshot: ["A-06"], work: ["A-06"], event: ["A-06"], hidden: ["A-06"] } },
  { id: "current-milestone-order", nodes: { readme: ["A-07"], http: ["A-07"], snapshot: ["A-07"], event: ["A-07"], hidden: ["A-07"] } },
  { id: "release-and-beneficiary-payout", nodes: { readme: ["A-08", "A-13", "A-14"], http: ["A-08", "A-13", "A-14"], snapshot: ["A-08", "A-13", "A-14"], event: ["A-08", "A-14"], hidden: ["A-08", "A-13", "A-14"] } },
  { id: "dispute-release", nodes: { readme: ["A-09"], http: ["A-09"], snapshot: ["A-09"], event: ["A-09"], hidden: ["A-09"] } },
  { id: "dispute-refund", nodes: { readme: ["A-10"], http: ["A-10"], snapshot: ["A-10"], event: ["A-10"], hidden: ["A-10"] } },
  { id: "expiry-eligibility", nodes: { readme: ["A-11"], http: ["A-11"], snapshot: ["A-11"], work: ["A-11"], event: ["A-11"], hidden: ["A-11"] } },
  { id: "domain-event-history-and-delivery", nodes: { readme: ["A-12", "C-07", "C-08"], http: ["A-12", "C-07", "C-08"], snapshot: ["A-12", "C-07", "C-08"], event: ["A-12", "C-07", "C-08"], hidden: ["A-12", "C-07", "C-08"] } },
  { id: "final-compatibility", nodes: { readme: ["A-15"], http: ["A-15"], openapi: ["A-15"], snapshot: ["A-15"], hidden: ["A-15"] } },
  { id: "fund-conservation-and-integer-bounds", nodes: { readme: ["B-01"], http: ["B-01"], snapshot: ["B-01"], event: ["B-01"], hidden: ["B-01"] } },
  { id: "terminal-contention", nodes: { readme: ["B-02", "B-03", "B-04", "B-05", "B-08"], http: ["B-02", "B-03", "B-04", "B-05", "B-08"], snapshot: ["B-02", "B-03", "B-04", "B-05", "B-08"], work: ["B-03", "B-05"], event: ["B-02", "B-03", "B-04", "B-05", "B-08"], hidden: ["B-02", "B-03", "B-04", "B-05", "B-08"] } },
  { id: "durable-idempotency", nodes: { readme: ["B-06", "B-07"], http: ["B-06", "B-07"], snapshot: ["B-06", "B-07"], event: ["B-06", "B-07"], hidden: ["B-06", "B-07"] } },
  { id: "beneficiary-concurrency-and-no-refund-payout", nodes: { readme: ["B-09", "B-10"], http: ["B-09", "B-10"], snapshot: ["B-09", "B-10"], work: ["B-10"], event: ["B-09", "B-10"], hidden: ["B-09", "B-10"] } },
  { id: "work-leases-fencing-and-retention", nodes: { readme: ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06"], http: ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06"], snapshot: ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06"], work: ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06"], event: ["C-01", "C-02", "C-03", "C-04", "C-06"], hidden: ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06"] } },
  { id: "exact-openapi-contract", nodes: { readme: ["D-01"], http: ["D-01"], openapi: ["D-01"], hidden: ["D-01"] } },
  { id: "production-ui-flows", nodes: { readme: ["D-02", "D-03", "D-04", "D-05"], http: ["D-02", "D-03", "D-04", "D-05"], openapi: ["D-01"], ui: ["D-02", "D-03", "D-04", "D-05"], snapshot: ["D-02", "D-03", "D-04", "D-05"], hidden: ["D-02", "D-03", "D-04", "D-05"] } },
  { id: "cross-layer-identity", nodes: { readme: ["D-06"], http: ["D-06"], openapi: ["D-06"], ui: ["D-06"], snapshot: ["D-06"], work: ["D-06"], event: ["D-06"], hidden: ["D-06"] } },
  { id: "project-gates-and-fixed-performance", nodes: { readme: ["D-07", "E-04", "E-05", "E-06", "E-07"], http: ["D-07", "E-04", "E-05", "E-06"], ui: ["D-07"], snapshot: ["D-07", "E-04", "E-05", "E-06", "E-07"], work: ["D-07", "E-06"], event: ["D-07", "E-05", "E-06"], hidden: ["D-07", "E-04", "E-05", "E-06", "E-07"] } },
]);

const IDENTITY_NODE_LAYERS = new Set(["http", "ui", "snapshot", "work", "event"]);
const REQUIREMENTS_WITHOUT_RESOURCE_IDENTITY = new Set(["clean-delivery-and-production-boot", "exact-openapi-contract", "project-gates-and-fixed-performance"]);

function boundedObservation(observation) {
  return {
    ...(observation.method ? { method: observation.method } : {}),
    ...(observation.path ? { path: observation.path } : {}),
    ...(Number.isSafeInteger(observation.status) ? { status: observation.status } : {}),
    identityHashes: [...(observation.identityHashes ?? [])].slice(0, 16),
    aggregateHashes: [...(observation.aggregateHashes ?? [])].slice(0, 16),
    workHashes: [...(observation.workHashes ?? [])].slice(0, 16),
    eventHashes: [...(observation.eventHashes ?? [])].slice(0, 16),
    resourceHashes: [...(observation.resourceHashes ?? [])].slice(0, 16),
  };
}

export function connectedIdentityClosures(bindings, requiredLayers, label = "requirement") {
  const required = new Set(requiredLayers);
  if (required.size < 2) return [];
  const byHash = new Map();
  for (const binding of bindings ?? []) {
    if (binding?.kind !== "identity" || typeof binding.hash !== "string") continue;
    const layers = byHash.get(binding.hash) ?? new Set();
    for (const layer of binding.layers ?? []) if (required.has(layer)) layers.add(layer);
    byHash.set(binding.hash, layers);
  }
  const closures = [...byHash].flatMap(([hash, layers]) => [...required].every((layer) => layers.has(layer)) ? [{ kind: "identity", hash, layers: [...layers].sort() }] : []);
  assert.ok(closures.length > 0, `${label} has one hashed resource identity across every applicable executed layer`);
  return closures;
}

export function outcomeEvidenceLedger(outcomes, evidenceSummaries) {
  assert.deepEqual(outcomes.map(({ id }) => id), EXPECTED_PRIOR_CASE_IDS, "D-08 receives all prior outcomes in frozen order");
  const applicableOutcomes = outcomes.filter((outcome) => !isLegalLegacyExclusion(outcome));
  assert.deepEqual(evidenceSummaries.map(({ caseId }) => caseId), applicableOutcomes.map(({ id }) => id), "D-08 receives private actual evidence summaries for every applicable prior Case in frozen order");
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const summariesById = new Map(evidenceSummaries.map((summary) => [summary.caseId, summary]));
  const covered = new Set();
  const ledger = {};
  for (const requirement of ESCROWGUARD_EVIDENCE_REQUIREMENTS) {
    const nodes = {};
    const requirementCaseIds = new Set(Object.values(requirement.nodes).flat());
    for (const [layer, caseIds] of Object.entries(requirement.nodes)) {
      assert.ok(caseIds.length > 0, `${requirement.id}.${layer} has evidence cases`);
      const evidence = caseIds.map((caseId) => {
        covered.add(caseId);
        const outcome = byId.get(caseId);
        assert.ok(outcome, `${requirement.id}.${layer} outcome ${caseId} exists`);
        if (isLegalLegacyExclusion(outcome)) return { caseId, status: "not-applicable", reason: outcome.reason, evidenceDigest: outcome.evidenceDigest };
        assert.equal(outcome.status, "passed", `${requirement.id}.${layer} outcome ${caseId} passed`);
        assert.match(outcome.evidenceDigest, /^[0-9a-f]{64}$/u, `${requirement.id}.${layer} outcome ${caseId} evidence digest`);
        if (layer === "readme") return { caseId, evidenceDigest: outcome.evidenceDigest, mapping: "frozen-case-contract" };
        const summary = summariesById.get(caseId);
        const observations = (summary?.observations ?? []).filter((observation) => observation.layer === layer);
        assert.ok(observations.length > 0, `${requirement.id}.${layer} outcome ${caseId} has actual ${layer} observations`);
        if (["http", "openapi"].includes(layer)) {
          assert.ok(observations.some(({ method, path, status }) => typeof method === "string" && typeof path === "string" && Number.isSafeInteger(status)), `${requirement.id}.${layer} outcome ${caseId} binds method/path/status`);
        }
        return { caseId, evidenceDigest: outcome.evidenceDigest, observations: observations.slice(0, 8).map(boundedObservation) };
      });
      nodes[layer] = { status: evidence.every(({ status }) => status === "not-applicable") ? "not-applicable" : "passing", evidence };
    }
    const requiredIdentityLayers = new Set(Object.entries(requirement.nodes).flatMap(([layer, caseIds]) => IDENTITY_NODE_LAYERS.has(layer) && caseIds.some((caseId) => !isLegalLegacyExclusion(byId.get(caseId))) ? [layer] : []));
    const identityBindings = [...requirementCaseIds].flatMap((caseId) => {
      if (isLegalLegacyExclusion(byId.get(caseId))) return [];
      const allowedLayers = new Set(Object.entries(requirement.nodes).flatMap(([layer, caseIds]) => IDENTITY_NODE_LAYERS.has(layer) && caseIds.includes(caseId) ? [layer] : []));
      return (summariesById.get(caseId)?.bindings ?? [])
        .map((binding) => ({ ...binding, layers: binding.layers.filter((layer) => allowedLayers.has(layer)) }))
        .filter(({ kind, layers }) => kind === "identity" && new Set(layers).size >= 2);
    });
    const identityClosures = REQUIREMENTS_WITHOUT_RESOURCE_IDENTITY.has(requirement.id) ? [] : connectedIdentityClosures(identityBindings, requiredIdentityLayers, requirement.id);
    ledger[requirement.id] = { nodes, identityBindings: identityClosures.slice(0, 32) };
  }
  assert.deepEqual([...covered].sort(), [...EXPECTED_PRIOR_CASE_IDS].sort(), "every prior frozen Case contributes to D-08");
  return ledger;
}

const D08 = defineCase({ id: "D-08", fixtureFamily: "EG-F-EVIDENCE", action: "Execute concrete FINAL funding, beneficiary release, Dispute REFUND, expiry refund and event-history slices, then build a requirement ledger from their actual HTTP, exact OpenAPI, production UI, snapshot, Work, Event and hidden-oracle identities.", oracle: "Each applicable node is bound to the same executed resource identity and may be unrun, empty, failed, partial or passing; every scored requirement closes only when all applicable nodes pass, with no file, test name, route string, self-report or hard-coded true substituting for behavior.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx)); const { target, api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } }); const document = successful(await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI", 200).json; ctx.ok(assertEscrowGuardOpenApi(document), "ledger exact OpenAPI"); const createBody = beneficiaryRequest(fixture, [2, 2]), createKey = ctx.key("ledger-create"); const escrow = await createEscrow(ctx, api.baseUrl, createBody, { key: createKey }); const page = await submitViaBrowser(ctx, api.baseUrl, escrow.escrowId); let detail = await getDetail(ctx, api.baseUrl, escrow.escrowId); const firstMilestone = detail.milestones[0], firstShares = detail.beneficiaryShares.filter(({ milestoneId }) => milestoneId === firstMilestone.milestoneId), acceptKey = ctx.key("ledger-accept"), acceptPath = `/api/v1/escrows/${escrow.escrowId}/milestones/${firstMilestone.milestoneId}/accept`; const acceptTraffic = successful(await ctx.mutate(api.baseUrl, acceptPath, acceptKey, {}), "ledger accept", 200); const release = assertRelease(acceptTraffic.json, { response: true }); await reloadEscrow(ctx, page, escrow.escrowId); const secondSubmit = await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u); ctx.ok(secondSubmit.status() >= 200 && secondSubmit.status() < 300, "ledger second visible submit"); detail = await getDetail(ctx, api.baseUrl, escrow.escrowId); const secondMilestone = detail.milestones[1], secondShares = detail.beneficiaryShares.filter(({ milestoneId }) => milestoneId === secondMilestone.milestoneId), disputeBody = { openedBy: "BUYER", reason: "Ledger refund" }, disputeKey = ctx.key(`dispute:${escrow.escrowId}:${secondMilestone.milestoneId}`), disputePath = `/api/v1/escrows/${escrow.escrowId}/milestones/${secondMilestone.milestoneId}/disputes`; const dispute = await openDispute(ctx, api.baseUrl, escrow.escrowId, secondMilestone.milestoneId, disputeBody.openedBy, disputeBody.reason); const resolveBody = { decision: "REFUND", note: "Ledger refund resolution" }, resolveKey = ctx.key(`resolve:${dispute.disputeId}:REFUND`), resolvePath = `/api/v1/admin/disputes/${dispute.disputeId}/resolve`; await resolveDispute(ctx, api.baseUrl, dispute.disputeId, resolveBody.decision, resolveBody.note); detail = await getDetail(ctx, api.baseUrl, escrow.escrowId); await page.reload({ waitUntil: "networkidle" }); const expiryFixture = makeEscrowFixture(options(ctx), { label: "ledger-expiry" }), expiryBody = beneficiaryRequest(expiryFixture, [2]); expiryBody.expiresAt = await futureFromObservedClock(ctx, api.baseUrl); const expiryEscrow = await createEscrow(ctx, api.baseUrl, expiryBody, { key: ctx.key("ledger-expiry-create") }); const worker = await target.startWorker(); await waitForEscrow(ctx, api.baseUrl, expiryEscrow.escrowId, "REFUNDED", [worker]); const expiryDetail = await getDetail(ctx, api.baseUrl, expiryEscrow.escrowId); const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)), data = resources(snapshot), releaseEvents = await queryEvents(ctx, api.baseUrl, { aggregateId: escrow.escrowId, limit: 100 }), expiryEvents = await queryEvents(ctx, api.baseUrl, { aggregateId: expiryEscrow.escrowId, limit: 100 }); const createTraffic = successful(await ctx.mutate(api.baseUrl, "/api/v1/escrows", createKey, createBody), "ledger create replay", 201); const acceptReplayTraffic = successful(await ctx.mutate(api.baseUrl, acceptPath, acceptKey, {}), "ledger accept replay", 200); ctx.equal({ status: acceptReplayTraffic.status, text: acceptTraffic.text }, { status: acceptTraffic.status, text: acceptTraffic.text }, "ledger accept replay exact saved response"); const disputeTraffic = successful(await ctx.mutate(api.baseUrl, disputePath, disputeKey, disputeBody), "ledger dispute replay", 200); const resolveTraffic = successful(await ctx.mutate(api.baseUrl, resolvePath, resolveKey, resolveBody, { admin: true }), "ledger resolution replay", 200); const primaryDetailTraffic = successful(await ctx.request(api.baseUrl, `/api/v1/escrows/${escrow.escrowId}`), "ledger primary detail", 200); const expiryDetailTraffic = successful(await ctx.request(api.baseUrl, `/api/v1/escrows/${expiryEscrow.escrowId}`), "ledger expiry detail", 200); const releaseEventTraffic = successful(await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${escrow.escrowId}&limit=100`), "ledger event history", 200); await page.goto(api.baseUrl, { waitUntil: "networkidle" }); await openEscrow(ctx, page, escrow.escrowId); const primaryVisible = new Set(); for (const identity of [escrow.escrowId, release.releaseId, ...release.payouts.map(({ payoutId }) => payoutId), dispute.disputeId]) { await requireVisibleEvidence(page, identityPattern(identity), [/payout|release/i, /dispute/i, /history|event/i]); primaryVisible.add(identity); } ctx.mark("layer.ui", { escrowId: escrow.escrowId, releaseId: release.releaseId, disputeId: dispute.disputeId, payouts: release.payouts }); const visiblePrimaryEvents = new Set(); for (const event of releaseEvents.items) { await requireVisibleEvidence(page, identityPattern(event.eventId), [/event|history/i]); visiblePrimaryEvents.add(event.eventId); } ctx.mark("layer.ui", { escrowId: escrow.escrowId, events: releaseEvents.items }); await page.goto(api.baseUrl, { waitUntil: "networkidle" }); await openEscrow(ctx, page, expiryEscrow.escrowId); await requireVisibleEvidence(page, /refunded/i); const expiryVisible = await maybeVisible(page, identityPattern(expiryEscrow.escrowId)); const visibleExpiryEvents = new Set(); for (const event of expiryEvents.items) { await requireVisibleEvidence(page, identityPattern(event.eventId), [/event|history/i]); visibleExpiryEvents.add(event.eventId); } ctx.mark("layer.ui", { escrowId: expiryEscrow.escrowId, events: expiryEvents.items });
    ctx.equal({ status: acceptReplayTraffic.status, text: acceptReplayTraffic.text }, { status: acceptTraffic.status, text: acceptTraffic.text }, "ledger accept replay exact saved response bytes");
    const primaryWork = snapshot.work.filter(({ aggregateId }) => aggregateId === escrow.escrowId), expiryWork = snapshot.work.filter(({ aggregateId }) => aggregateId === expiryEscrow.escrowId), payoutByShare = new Map(detail.beneficiaryPayouts.map((payout) => [payout.beneficiaryShareId, payout])); const status = (passing, evidence) => ({ status: passing ? "passing" : "failed", evidence: passing ? evidence : null }); const ledger = {
      fundingAndReadModel: { readme: status(detail.escrow.totalMinor === 40 && detail.milestones.reduce((sum, item) => sum + item.amountMinor, 0) === 40, { escrowId: escrow.escrowId, totalMinor: 40 }), http: status(detail.escrow.escrowId === escrow.escrowId, { escrowId: detail.escrow.escrowId }), openapi: status(Boolean(assertTrafficMatchesOpenApi(document, "/api/v1/escrows", "post", createTraffic) && assertTrafficMatchesOpenApi(document, "/api/v1/escrows/{escrowId}", "get", primaryDetailTraffic)), { statuses: [createTraffic.status, primaryDetailTraffic.status] }), ui: status(primaryVisible.has(escrow.escrowId), { escrowId: escrow.escrowId }), snapshot: status(data.escrows.some(({ escrowId }) => escrowId === escrow.escrowId), { escrowId: escrow.escrowId }), work: status(primaryWork.length === 1, { workId: primaryWork[0]?.workId }), event: status(releaseEvents.items.some(({ type }) => type === "escrow.funded"), { eventIds: releaseEvents.items.map(({ eventId }) => eventId) }), hidden: status(canonicalJson(detail.fundPosition) === canonicalJson({ totalMinor: 40, availableMinor: 0, releasedMinor: 20, refundedMinor: 20 }), { fundPosition: detail.fundPosition }) },
      beneficiaryRelease: { readme: status(firstShares.length === 2 && release.payouts.length === 2, { milestoneId: firstMilestone.milestoneId }), http: status(release.payouts.every((payout, index) => payout.beneficiaryShareId === firstShares[index].beneficiaryShareId && payout.amountMinor === firstShares[index].amountMinor), { releaseId: release.releaseId, payoutIds: release.payouts.map(({ payoutId }) => payoutId) }), openapi: status(Boolean(assertTrafficMatchesOpenApi(document, "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept", "post", acceptReplayTraffic)), { status: acceptReplayTraffic.status }), ui: status(primaryVisible.has(release.releaseId) && release.payouts.every(({ payoutId }) => primaryVisible.has(payoutId)), { releaseId: release.releaseId }), snapshot: status(data.releases.some(({ releaseId }) => releaseId === release.releaseId) && release.payouts.every(({ payoutId }) => data.beneficiaryPayouts.some((item) => item.payoutId === payoutId)), { releaseId: release.releaseId }), event: status(releaseEvents.items.some(({ type }) => type === "milestone.released"), { aggregateId: escrow.escrowId }), hidden: status(firstShares.every(({ beneficiaryShareId }) => payoutByShare.has(beneficiaryShareId)), { beneficiaryShareIds: firstShares.map(({ beneficiaryShareId }) => beneficiaryShareId) }) },
      disputeRefund: { readme: status(assertDispute(resolveTraffic.json).state === "RESOLVED_REFUND" && resolveTraffic.json.disputeId === dispute.disputeId && detail.dispute === null && detail.milestones[1].state === "REFUNDED", { disputeId: dispute.disputeId }), http: status(disputeTraffic.json.disputeId === dispute.disputeId && detail.escrow.refundedMinor === secondMilestone.amountMinor, { disputeId: dispute.disputeId, refundedMinor: detail.escrow.refundedMinor }), openapi: status(Boolean(assertTrafficMatchesOpenApi(document, "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes", "post", disputeTraffic) && assertTrafficMatchesOpenApi(document, "/api/v1/admin/disputes/{disputeId}/resolve", "post", resolveTraffic) && assertTrafficMatchesOpenApi(document, "/api/v1/escrows/{escrowId}", "get", primaryDetailTraffic)), { statuses: [disputeTraffic.status, resolveTraffic.status, primaryDetailTraffic.status] }), ui: status(primaryVisible.has(dispute.disputeId), { disputeId: dispute.disputeId }), snapshot: status(data.disputes.some(({ disputeId, state }) => disputeId === dispute.disputeId && state === "RESOLVED_REFUND"), { disputeId: dispute.disputeId }), event: status(["dispute.opened", "dispute.resolved", "escrow.refunded"].every((type) => releaseEvents.items.some((event) => event.type === type)), { eventIds: releaseEvents.items.map(({ eventId }) => eventId) }), hidden: status(secondShares.every(({ beneficiaryShareId }) => !payoutByShare.has(beneficiaryShareId)), { unpaidShareIds: secondShares.map(({ beneficiaryShareId }) => beneficiaryShareId) }) },
      expiryRecovery: { readme: status(expiryDetail.escrow.state === "REFUNDED" && expiryDetail.escrow.refundedMinor === expiryDetail.escrow.totalMinor, { escrowId: expiryEscrow.escrowId }), http: status(expiryDetail.escrow.escrowId === expiryEscrow.escrowId, { escrowId: expiryEscrow.escrowId }), openapi: status(Boolean(assertTrafficMatchesOpenApi(document, "/api/v1/escrows/{escrowId}", "get", expiryDetailTraffic)), { status: expiryDetailTraffic.status }), ui: status(expiryVisible, { escrowId: expiryEscrow.escrowId }), snapshot: status(data.escrows.some(({ escrowId, state }) => escrowId === expiryEscrow.escrowId && state === "REFUNDED"), { escrowId: expiryEscrow.escrowId }), work: status(expiryWork.length === 1 && expiryWork[0].terminal, { workId: expiryWork[0]?.workId }), event: status(expiryEvents.items.some(({ type }) => type === "escrow.refunded"), { eventIds: expiryEvents.items.map(({ eventId }) => eventId) }), hidden: status(expiryDetail.beneficiaryPayouts.length === 0, { payoutCount: 0 }) },
      eventHistory: { http: status(releaseEvents.items.length > 0 && expiryEvents.items.length > 0, { aggregates: [escrow.escrowId, expiryEscrow.escrowId] }), openapi: status(Boolean(assertTrafficMatchesOpenApi(document, "/api/v1/domain-events", "get", releaseEventTraffic)), { status: releaseEventTraffic.status }), ui: status(releaseEvents.items.every(({ eventId }) => visiblePrimaryEvents.has(eventId)) && expiryEvents.items.every(({ eventId }) => visibleExpiryEvents.has(eventId)), { eventIds: [...visiblePrimaryEvents, ...visibleExpiryEvents] }), snapshot: status([...releaseEvents.items, ...expiryEvents.items].every(({ eventId }) => snapshot.events.some((event) => event.eventId === eventId)), { snapshotEventCount: snapshot.events.length }), hidden: status([...releaseEvents.items, ...expiryEvents.items].every(({ payload }) => canonicalJson(payload) === "{}"), { payloadShape: {} }) },
      idempotencyReplay: { readme: status(createTraffic.status === 201 && acceptReplayTraffic.status === 200, { keys: [createKey, acceptKey] }), http: status(createTraffic.json.escrowId === escrow.escrowId && acceptReplayTraffic.text === acceptTraffic.text, { escrowId: escrow.escrowId, releaseId: release.releaseId }), openapi: status(Boolean(assertTrafficMatchesOpenApi(document, "/api/v1/escrows", "post", createTraffic) && assertTrafficMatchesOpenApi(document, "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept", "post", acceptReplayTraffic)), { statuses: [createTraffic.status, acceptReplayTraffic.status] }), snapshot: status(data.escrows.filter(({ escrowId }) => escrowId === escrow.escrowId).length === 1 && data.releases.filter(({ releaseId }) => releaseId === release.releaseId).length === 1, { escrowId: escrow.escrowId, releaseId: release.releaseId }), event: status(releaseEvents.items.filter(({ type }) => type === "milestone.released").length === 1, { aggregateId: escrow.escrowId }), hidden: status(acceptReplayTraffic.text === acceptTraffic.text, { savedResponseBytes: Buffer.byteLength(acceptTraffic.text) }) },
    }; for (const [requirement, nodes] of Object.entries(ledger)) ctx.ok(Object.values(nodes).every(({ status: nodeStatus, evidence }) => nodeStatus === "passing" && evidence !== null), `${requirement} executed evidence closure`); const historicalRequirements = outcomeEvidenceLedger(ctx.caseOutcomes, ctx.caseEvidenceSummaries); return finalEvidence(ctx, { requirements: ledger, historicalRequirements, identities: { primaryEscrowId: escrow.escrowId, expiryEscrowId: expiryEscrow.escrowId, releaseId: release.releaseId, disputeId: dispute.disputeId }, policy: "executed-applicable-nodes-and-private-frozen-case-evidence" }); } });

export const D_CASES = Object.freeze([D01, D02, D03, D04, D05, D06, D07, D08]);
