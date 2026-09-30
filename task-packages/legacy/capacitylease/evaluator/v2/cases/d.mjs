import assert from "node:assert/strict";

import Ajv2020 from "ajv/dist/2020.js";
import { chromium } from "playwright-core";

import { EvaluationInfrastructureError } from "../lib/runtime.mjs";
import {
  EVENT_KEYS,
  LEASE_KEYS,
  MEMBER_KEYS,
  assertFinalSnapshot,
  createLease,
  emptySeed,
  gangRequest,
  leaseIdentity,
  leaseRequest,
  prepare,
  requireStatus,
  result,
} from "./helpers.mjs";

const SLICE_KEYS = [
  "activeUnits", "availableUnits", "capacityUnits", "confirmedUnits", "endAt", "heldUnits", "poolId", "startAt",
];
const ADMISSION_KEYS = [
  "admissionEntryId", "endAt", "ownerId", "poolId", "priority", "promotedLeaseId", "requestedAt", "startAt", "state", "terminalAt", "units",
];

async function guarded(operation) {
  try {
    return await operation();
  } catch (error) {
    error.failureCodeSuffix ??= "PUBLIC_CONTRACT_FAILED";
    throw error;
  }
}

async function setup(ctx, label, options = {}) {
  const fixture = emptySeed(ctx, label, {
    poolCount: options.poolCount ?? 3,
    capacityUnits: options.capacityUnits ?? 10,
  });
  const api = await prepare(ctx, { seed: fixture.seed, install: false });
  return { ...fixture, api };
}

async function withBrowser(baseUrl, operation, options = {}) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (cause) {
    throw new EvaluationInfrastructureError("EVALUATOR_CHROMIUM_LAUNCH_FAILED", "failed to launch the Harness-owned Chromium", { cause });
  }
  let operationError;
  try {
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1440, height: 1000 },
      baseURL: baseUrl,
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    return await operation({ browser, context, page });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await browser.close();
    } catch (cause) {
      if (!operationError) {
        throw new EvaluationInfrastructureError("EVALUATOR_CHROMIUM_CLOSE_FAILED", "failed to close the Harness-owned Chromium", { cause });
      }
    }
  }
}

async function firstVisible(locators, label) {
  for (const locator of locators) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  assert.fail(`no visible ${label}`);
}

async function control(page, pattern, label) {
  return firstVisible([
    page.getByLabel(pattern),
    page.getByRole("textbox", { name: pattern }),
    page.getByRole("combobox", { name: pattern }),
    page.getByRole("spinbutton", { name: pattern }),
  ], label);
}

async function setControl(locator, value) {
  try {
    await locator.selectOption({ value: String(value) });
    return;
  } catch {}
  try {
    await locator.selectOption({ label: String(value) });
    return;
  } catch {}
  await locator.fill(String(value));
}

async function openLeaseForm(page) {
  if (await page.getByLabel(/owner/i).count()) return;
  const create = await firstVisible([
    page.getByRole("button", { name: /create.*lease|new.*lease/i }),
    page.getByRole("link", { name: /create.*lease|new.*lease/i }),
  ], "Create Lease control");
  await create.click();
  await firstVisible([page.getByLabel(/owner/i)], "Owner control");
}

function localTimestamp(value) {
  return value.replace(/Z$/u, "").slice(0, 16);
}

async function fillBaseLeaseForm(page, fixture, overrides = {}) {
  await openLeaseForm(page);
  await setControl(await control(page, /owner/i, "Owner"), fixture.ids.ownerId);
  await setControl(await control(page, /start/i, "startAt"), localTimestamp(overrides.startAt ?? fixture.startAt));
  await setControl(await control(page, /end/i, "endAt"), localTimestamp(overrides.endAt ?? fixture.endAt));
  const priority = await page.getByLabel(/priority/i).first();
  if (await priority.count()) await setControl(priority, overrides.priority ?? 0);
  const holdSeconds = await page.getByLabel(/hold.*seconds|hold.*duration/i).first();
  if (await holdSeconds.count()) await setControl(holdSeconds, overrides.holdSeconds ?? 120);
}

async function fillLegacyLeaseForm(page, fixture, overrides = {}) {
  await fillBaseLeaseForm(page, fixture, overrides);
  await setControl(await control(page, /^pool|capacity pool/i, "Pool"), overrides.poolId ?? fixture.ids.poolIds[0]);
  await setControl(await control(page, /units/i, "units"), overrides.units ?? 2);
  const wait = page.getByLabel(/allow.*wait|wait.*capacity/i).first();
  if (await wait.count()) {
    const desired = overrides.allowWait ?? false;
    if ((await wait.isChecked()) !== desired) await wait.click();
  }
}

async function submitLeaseForm(page) {
  const submit = await firstVisible([
    page.getByRole("button", { name: /create|submit|request/i }),
  ], "Lease submit button");
  await submit.click();
}

async function expectState(page, state) {
  await page.getByText(new RegExp(`\\b${state}\\b`, "i")).first().waitFor({ state: "visible", timeout: 15_000 });
}

function operation(document, path, method) {
  const normalizedPath = path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, "{$1}");
  const selected = document.paths?.[normalizedPath]?.[method.toLowerCase()];
  assert.ok(selected, `OpenAPI is missing ${method.toUpperCase()} ${path}`);
  assert.ok(selected.responses && typeof selected.responses === "object", `${method.toUpperCase()} ${path} has no responses`);
  return selected;
}

function resolveDocumentReference(document, value) {
  let resolved = value;
  const seen = new Set();
  while (resolved?.$ref) {
    assert.match(resolved.$ref, /^#\//u, `external OpenAPI reference ${resolved.$ref} is not self-contained`);
    assert.equal(seen.has(resolved.$ref), false, `cyclic OpenAPI reference ${resolved.$ref}`);
    seen.add(resolved.$ref);
    resolved = resolved.$ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((current, part) => current?.[part], document);
    assert.ok(resolved, `OpenAPI reference ${[...seen].at(-1)} does not resolve`);
  }
  return resolved;
}

function compileObservedSchema(document, schema, label) {
  assert.ok(schema && typeof schema === "object", `${label} has no JSON schema`);
  const root = { ...schema, components: document.components, $defs: document.$defs };
  try {
    return new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(root);
  } catch (cause) {
    assert.fail(`${label} schema cannot compile: ${cause.message ?? String(cause)}`);
  }
}

function observedObjectPaths(value, path = [], output = []) {
  if (Array.isArray(value)) {
    if (value.length > 0) observedObjectPaths(value[0], [...path, 0], output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  output.push(path);
  for (const [key, child] of Object.entries(value)) observedObjectPaths(child, [...path, key], output);
  return output;
}

function valueAtPath(value, path) {
  return path.reduce((current, part) => current[part], value);
}

function assertObservedSchema(document, schema, value, label, { requireObservedKeys = true } = {}) {
  const validate = compileObservedSchema(document, schema, label);
  assert.equal(validate(value), true, `${label} does not validate live traffic: ${JSON.stringify(validate.errors)}`);
  for (const path of observedObjectPaths(value)) {
    const withUnknown = structuredClone(value);
    valueAtPath(withUnknown, path).__evaluatorUnexpected = true;
    assert.equal(validate(withUnknown), false, `${label} schema accepts an unknown field at ${path.join(".") || "<root>"}`);
    if (!requireObservedKeys) continue;
    for (const key of Object.keys(valueAtPath(value, path))) {
      const withoutRequired = structuredClone(value);
      delete valueAtPath(withoutRequired, path)[key];
      assert.equal(validate(withoutRequired), false, `${label} schema does not require ${[...path, key].join(".")}`);
    }
  }
}

function documentedResponseSchema(document, path, method, status) {
  const selected = operation(document, path, method);
  const declared = resolveDocumentReference(document, selected.responses[String(status)]);
  assert.ok(declared, `OpenAPI does not document live ${status} for ${method.toUpperCase()} ${path}`);
  return declared.content?.["application/json"]?.schema;
}

function assertDocumentedRequest(document, path, method, body) {
  const selected = operation(document, path, method);
  const requestBody = resolveDocumentReference(document, selected.requestBody);
  assert.equal(requestBody?.required, true, `${method.toUpperCase()} ${path} requestBody is not required`);
  assertObservedSchema(
    document,
    requestBody?.content?.["application/json"]?.schema,
    body,
    `${method.toUpperCase()} ${path} request`,
    { requireObservedKeys: false },
  );
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has the wrong public shape`);
}

function assertLease(value, label, holdToken = false) {
  exactKeys(value, holdToken ? [...LEASE_KEYS, "holdToken"] : LEASE_KEYS, label);
  assert.equal(typeof value.leaseId, "string");
  assert.equal(typeof value.ownerId, "string");
  assert.ok(Number.isSafeInteger(value.revision));
  assert.ok(Number.isSafeInteger(value.sequence));
  assert.ok(Array.isArray(value.members));
  if (holdToken) assert.equal(typeof value.holdToken, "string");
}

function assertPage(value, itemValidator, label) {
  exactKeys(value, ["items", "nextCursor"], label);
  assert.ok(Array.isArray(value.items), `${label}.items is not an array`);
  assert.ok(value.nextCursor === null || typeof value.nextCursor === "string");
  value.items.forEach((item, index) => itemValidator(item, `${label}.items[${index}]`));
}

function assertLiveContract(path, method, response) {
  if (response.status >= 400) {
    exactKeys(response.json, ["error"], `${method} ${path} error`);
    exactKeys(response.json.error, ["code", "details", "message"], `${method} ${path} error.error`);
    assert.equal(typeof response.json.error.code, "string");
    assert.equal(typeof response.json.error.message, "string");
    assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details));
    return;
  }
  if (response.status === 204) {
    assert.equal(response.text, "");
    return;
  }
  if (path === "/api/v1/capacityLeases") {
    assertPage(response.json, (item, label) => assertLease(item, label), "Capacity Lease collection");
  } else if (path === "/api/v1/capacityLeases/:capacityLeaseId" || (path === "/api/v1/capacity-leases/:leaseId" && method === "GET")) {
    assertLease(response.json, "Capacity Lease detail");
  } else if (path === "/api/v1/capacity-leases" && method === "POST") {
    if (response.status === 201) assertLease(response.json, "Create Hold response", response.json.state === "HELD");
    else if (response.status === 202) exactKeys(response.json, ADMISSION_KEYS, "Create WAITING response");
  } else if (/\/(?:confirm|renew|release)$/u.test(path)) {
    assertLease(response.json, `${method} ${path} response`);
  } else if (path === "/api/v1/capacity-pools/:poolId/timeline") {
    const slices = Array.isArray(response.json) ? response.json : response.json?.items;
    assert.ok(Array.isArray(slices), "timeline does not return Capacity Slices");
    slices.forEach((slice, index) => exactKeys(slice, SLICE_KEYS, `timeline[${index}]`));
  } else if (path === "/api/v1/domain-events") {
    assertPage(response.json, (event, label) => exactKeys(event, EVENT_KEYS, label), "Domain Event collection");
  } else if (path === "/api/v1/capacity-leases/:leaseId/members") {
    exactKeys(response.json, ["items"], "Gang Member collection");
    assert.ok(Array.isArray(response.json.items));
    response.json.items.forEach((member, index) => exactKeys(member, MEMBER_KEYS, `members[${index}]`));
  } else if (path === "/api/v1/verification-snapshot") {
    assertFinalSnapshot(response.json);
  } else if (path === "/api/v1/admission-entries/:admissionEntryId" && response.status === 200) {
    exactKeys(response.json, ADMISSION_KEYS, "cancel Admission response");
  }
}

function assertDocumentedResponse(document, path, method, response) {
  const schema = documentedResponseSchema(document, path, method, response.status);
  if (response.status !== 204) {
    assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:\s*;|$)/iu, `live ${method.toUpperCase()} ${path} is not JSON`);
    assert.notEqual(response.json, undefined, `live ${method.toUpperCase()} ${path} response is not JSON`);
    assertObservedSchema(document, schema, response.json, `${method.toUpperCase()} ${path} response ${response.status}`);
  }
  assertLiveContract(path, method.toUpperCase(), response);
}

function privateUuid(ctx, label) {
  return ctx.uuid(`missing-${label}`);
}

async function runD01(ctx) {
  const { api, ids } = await setup(ctx, "d01");
  const openapiResponse = await ctx.request(api.baseUrl, "/openapi.json");
  requireStatus(openapiResponse, 200, "OpenAPI");
  const document = openapiResponse.json;
  assert.match(document.openapi, /^3\.1(?:\.\d+)?$/u);

  const heldRequest = leaseRequest(ctx, ids, "d01-held", { holdSeconds: 120 });
  const held = await createLease(ctx, api, "d01-held", heldRequest, 201);
  const leaseId = leaseIdentity(held.json);
  const interactions = [];
  const capture = async (path, method = "GET", options = {}, contractPath = path.split("?")[0]) => {
    const response = await ctx.request(api.baseUrl, path, { method, ...options });
    assert.equal(response.status, 200, `${method} ${contractPath} returned ${response.status}: ${response.text}`);
    interactions.push({ path: contractPath, method, response });
    return response;
  };

  await capture("/api/v1/capacityLeases");
  await capture(`/api/v1/capacityLeases/${leaseId}`, "GET", {}, "/api/v1/capacityLeases/:capacityLeaseId");
  await capture(`/api/v1/capacity-leases/${leaseId}`, "GET", {}, "/api/v1/capacity-leases/:leaseId");
  await capture(
    `/api/v1/capacity-pools/${ids.poolIds[0]}/timeline?from=${encodeURIComponent(ctx.at({ hours: 1 }))}&to=${encodeURIComponent(ctx.at({ hours: 4 }))}`,
    "GET",
    {},
    "/api/v1/capacity-pools/:poolId/timeline",
  );
  await capture("/api/v1/domain-events?limit=100");
  await capture(`/api/v1/capacity-leases/${leaseId}/members`, "GET", {}, "/api/v1/capacity-leases/:leaseId/members");
  await capture("/api/v1/verification-snapshot", "GET", { headers: { authorization: `Bearer ${ctx.adminToken}` } });

  const confirmRequest = {
    holdToken: held.json.holdToken,
    expectedRevision: held.json.revision,
  };
  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("d01-confirm"), confirmRequest);
  interactions.push({ path: "/api/v1/capacity-leases/:leaseId/confirm", method: "POST", response: confirmed });
  requireStatus(confirmed, 200, "confirm");
  const renewRequest = {
    expectedRevision: confirmed.json.revision,
    endAt: ctx.at({ hours: 4 }),
  };
  const renewed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/renew`, ctx.key("d01-renew"), renewRequest);
  interactions.push({ path: "/api/v1/capacity-leases/:leaseId/renew", method: "POST", response: renewed });
  requireStatus(renewed, 200, "renew");
  const releaseRequest = {
    expectedRevision: renewed.json.revision,
    reason: "done",
  };
  const released = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/release`, ctx.key("d01-release"), releaseRequest);
  interactions.push({ path: "/api/v1/capacity-leases/:leaseId/release", method: "POST", response: released });
  requireStatus(released, 200, "release");

  const blocker = await createLease(ctx, api, "d01-blocker", leaseRequest(ctx, ids, "d01-blocker", {
    startAt: ctx.at({ hours: 5 }), endAt: ctx.at({ hours: 6 }), units: 10, holdSeconds: 120,
  }), 201);
  assert.equal(blocker.status, 201);
  const waiting = await createLease(ctx, api, "d01-waiting", leaseRequest(ctx, ids, "d01-waiting", {
    startAt: ctx.at({ hours: 5 }), endAt: ctx.at({ hours: 6 }), units: 1, allowWait: true,
  }), 202);
  interactions.push({ path: "/api/v1/capacity-leases", method: "POST", response: waiting });
  const unavailable = await ctx.mutate(api.baseUrl, "/api/v1/capacity-leases", ctx.key("d01-unavailable"), leaseRequest(ctx, ids, "d01-unavailable", {
    startAt: ctx.at({ hours: 5 }), endAt: ctx.at({ hours: 6 }), units: 1, allowWait: false,
  }));
  requireStatus(unavailable, 409, "unavailable create");
  interactions.push({ path: "/api/v1/capacity-leases", method: "POST", response: unavailable });
  const deleted = await ctx.request(api.baseUrl, `/api/v1/admission-entries/${waiting.json.admissionEntryId}`, {
    method: "DELETE", headers: { "idempotency-key": ctx.key("d01-cancel") },
  });
  interactions.push({ path: "/api/v1/admission-entries/:admissionEntryId", method: "DELETE", response: deleted });
  assert.ok([200, 204].includes(deleted.status));

  const createdPath = "/api/v1/capacity-leases";
  assertDocumentedRequest(document, createdPath, "POST", heldRequest);
  assertDocumentedRequest(document, "/api/v1/capacity-leases/:leaseId/confirm", "POST", confirmRequest);
  assertDocumentedRequest(document, "/api/v1/capacity-leases/:leaseId/renew", "POST", renewRequest);
  assertDocumentedRequest(document, "/api/v1/capacity-leases/:leaseId/release", "POST", releaseRequest);
  assertDocumentedResponse(document, createdPath, "POST", held);
  for (const item of interactions) assertDocumentedResponse(document, item.path.split("?")[0], item.method, item.response);

  const publishedErrors = [
    ["/api/v1/capacityLeases?cursor=not-a-cursor", "/api/v1/capacityLeases", "GET"],
    [`/api/v1/capacityLeases/${privateUuid(ctx, "lease")}`, "/api/v1/capacityLeases/:capacityLeaseId", "GET"],
    [`/api/v1/capacity-leases/${privateUuid(ctx, "lease-hyphen")}`, "/api/v1/capacity-leases/:leaseId", "GET"],
    [`/api/v1/capacity-pools/${privateUuid(ctx, "pool")}/timeline?from=${encodeURIComponent(ctx.at())}&to=${encodeURIComponent(ctx.at({ hours: 1 }))}`, "/api/v1/capacity-pools/:poolId/timeline", "GET"],
    [`/api/v1/capacity-leases/${privateUuid(ctx, "members")}/members`, "/api/v1/capacity-leases/:leaseId/members", "GET"],
    [`/api/v1/admission-entries/${privateUuid(ctx, "admission")}`, "/api/v1/admission-entries/:admissionEntryId", "DELETE"],
  ];
  for (const [livePath, contractPath, method] of publishedErrors) {
    const response = await ctx.request(api.baseUrl, livePath, {
      method,
      headers: method === "DELETE" ? { "idempotency-key": ctx.key(`d01-${contractPath}`) } : {},
    });
    assert.ok(response.status >= 400 && response.status < 500, `${method} ${contractPath} did not produce a published error`);
    assertDocumentedResponse(document, contractPath, method, response);
  }
  const unauthorized = await ctx.request(api.baseUrl, "/api/v1/verification-snapshot");
  assert.equal(unauthorized.status, 401);
  assertDocumentedResponse(document, "/api/v1/verification-snapshot", "GET", unauthorized);
  return result([{ kind: "openapi-live-traffic", operations: interactions.length + publishedErrors.length + 2 }]);
}

async function runD02(ctx) {
  const fixture = await setup(ctx, "d02");
  fixture.startAt = ctx.at({ hours: 2 });
  fixture.endAt = ctx.at({ hours: 3 });
  return withBrowser(fixture.api.baseUrl, async ({ page }) => {
    await fillLegacyLeaseForm(page, fixture, { units: 2 });
    await submitLeaseForm(page);
    await expectState(page, "HELD");
    await (await firstVisible([page.getByRole("button", { name: /confirm/i })], "Confirm button")).click();
    await expectState(page, "CONFIRMED");
    const originalEndAt = fixture.endAt;
    const renewEnd = page.getByLabel(/renew.*end|new.*end|end at/i).last();
    if (await renewEnd.count()) await setControl(renewEnd, localTimestamp(ctx.at({ hours: 4 })));
    await (await firstVisible([page.getByRole("button", { name: /renew/i })], "Renew button")).click();
    const reason = page.getByLabel(/release.*reason|reason/i).first();
    if (await reason.count()) await reason.fill("completed");
    await (await firstVisible([page.getByRole("button", { name: /release/i })], "Release button")).click();
    await expectState(page, "RELEASED");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectState(page, "RELEASED");
    await page.getByText(/event|history/i).first().waitFor({ state: "visible" });
    await page.getByText(/timeline/i).first().waitFor({ state: "visible" });
    const snapshot = await ctx.snapshot(fixture.api.baseUrl);
    assertFinalSnapshot(snapshot);
    assert.equal(snapshot.resources.capacityLeases.length, 1, "UI lifecycle did not create exactly one Lease");
    const lease = snapshot.resources.capacityLeases[0];
    assert.equal(lease.state, "RELEASED");
    assert.ok(Date.parse(lease.endAt) > Date.parse(originalEndAt), "UI Renew did not extend endAt");
    assert.deepEqual(snapshot.events.filter((event) => event.aggregateId === lease.leaseId).map(({ type }) => type), [
      "lease.held", "lease.confirmed", "lease.renewed", "lease.released",
    ]);
    return result([{ kind: "production-browser-v1-lifecycle", states: 4, refreshed: true }]);
  });
}

async function runD03(ctx) {
  const fixture = await setup(ctx, "d03");
  fixture.startAt = ctx.at({ hours: 4 });
  fixture.endAt = ctx.at({ hours: 5 });
  await createLease(ctx, fixture.api, "d03-blocker", leaseRequest(ctx, fixture.ids, "d03-blocker", {
    startAt: fixture.startAt, endAt: fixture.endAt, units: 10, holdSeconds: 120,
  }), 201);
  return withBrowser(fixture.api.baseUrl, async ({ page }) => {
    await fillLegacyLeaseForm(page, fixture, { units: 1, allowWait: true });
    await submitLeaseForm(page);
    await expectState(page, "WAITING");
    await (await firstVisible([page.getByRole("button", { name: /cancel/i })], "Cancel Admission button")).click();
    await expectState(page, "CANCELLED");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectState(page, "CANCELLED");
    await page.getByText(/event|history|progress/i).first().waitFor({ state: "visible" });
    const snapshot = await ctx.snapshot(fixture.api.baseUrl);
    assertFinalSnapshot(snapshot);
    assert.ok(snapshot.resources.admissionEntries.some((entry) => entry.state === "CANCELLED"));
    return result([{ kind: "production-browser-admission", states: ["WAITING", "CANCELLED"], refreshed: true }]);
  });
}

async function runD04(ctx) {
  const fixture = await setup(ctx, "d04", { poolCount: 10, capacityUnits: 20 });
  fixture.startAt = ctx.at({ hours: 2 });
  fixture.endAt = ctx.at({ hours: 3 });
  return withBrowser(fixture.api.baseUrl, async ({ page }) => {
    for (const memberCount of [2, 3, 10]) {
      await page.goto(fixture.api.baseUrl, { waitUntil: "domcontentloaded" });
      await openLeaseForm(page);
      const gangMode = page.getByRole("button", { name: /gang/i }).or(page.getByLabel(/gang/i)).first();
      if (await gangMode.count()) await gangMode.click();
      await fillBaseLeaseForm(page, fixture, {
        startAt: ctx.at({ hours: 2 + memberCount }),
        endAt: ctx.at({ hours: 3 + memberCount }),
      });
      let poolControls = page.getByLabel(/pool/i);
      while (await poolControls.count() < memberCount) {
        await (await firstVisible([page.getByRole("button", { name: /add.*member/i })], "Add Member button")).click();
        poolControls = page.getByLabel(/pool/i);
      }
      if (memberCount === 3) {
        const beforeRemove = await poolControls.count();
        const remove = await firstVisible([page.getByRole("button", { name: /remove.*member/i })], "Remove Member button");
        await remove.click();
        assert.equal(await page.getByLabel(/pool/i).count(), beforeRemove - 1, "Remove Member did not remove one visible row");
        await (await firstVisible([page.getByRole("button", { name: /add.*member/i })], "Add Member button")).click();
        poolControls = page.getByLabel(/pool/i);
        assert.equal(await poolControls.count(), beforeRemove, "Add Member did not restore the removed row");
      }
      const unitControls = page.getByLabel(/units/i);
      assert.ok(await unitControls.count() >= memberCount, `UI cannot express ${memberCount} Member units`);
      for (let index = 0; index < memberCount; index += 1) {
        await setControl(poolControls.nth(index), fixture.ids.poolIds[index]);
        await setControl(unitControls.nth(index), 1);
      }
      await submitLeaseForm(page);
      await expectState(page, "HELD");
      for (const poolId of fixture.ids.poolIds.slice(0, memberCount)) {
        const poolName = fixture.seed.capacityPools.find((pool) => pool.poolId === poolId).name;
        await page.getByText(new RegExp(`${poolId}|${poolName}`, "i")).first().waitFor({ state: "visible" });
      }
      await page.getByText(/timeline/i).first().waitFor({ state: "visible" });
      if (memberCount === 2) {
        await (await firstVisible([page.getByRole("button", { name: /confirm/i })], "Gang Confirm button")).click();
        await expectState(page, "CONFIRMED");
        const reason = page.getByLabel(/release.*reason|reason/i).first();
        if (await reason.count()) await reason.fill("completed");
        await (await firstVisible([page.getByRole("button", { name: /release/i })], "Gang Release button")).click();
        await expectState(page, "RELEASED");
      }
    }
    await page.goto(fixture.api.baseUrl, { waitUntil: "domcontentloaded" });
    await fillLegacyLeaseForm(page, fixture, {
      startAt: ctx.at({ hours: 20 }), endAt: ctx.at({ hours: 21 }), poolId: fixture.ids.poolIds[0], units: 1,
    });
    await submitLeaseForm(page);
    await expectState(page, "HELD");
    const snapshot = await ctx.snapshot(fixture.api.baseUrl);
    assertFinalSnapshot(snapshot);
    const gangs = snapshot.resources.capacityLeases.filter((lease) => lease.poolId === null);
    assert.deepEqual(gangs.map((lease) => lease.members.length).sort((a, b) => a - b), [2, 3, 10]);
    assert.ok(snapshot.resources.capacityLeases.some((lease) => lease.poolId === fixture.ids.poolIds[0] && lease.members.length === 1), "legacy one-Member UI no longer works");
    return result([{ kind: "dynamic-gang-ui", memberCounts: [2, 3, 10], removeMember: true, aggregateActions: true, legacy: true }]);
  });
}

async function runD05(ctx) {
  const fixture = await setup(ctx, "d05");
  fixture.startAt = ctx.at({ hours: 2 });
  fixture.endAt = ctx.at({ hours: 3 });
  return withBrowser(fixture.api.baseUrl, async ({ context, page }) => {
    await page.getByText(/empty|no .*lease|no .*admission/i).first().waitFor({ state: "visible" });

    await page.route("**/api/v1/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(/loading|refreshing/i).first().waitFor({ state: "visible" });
    await page.unroute("**/api/v1/**");

    await page.route("**/api/v1/**", (route) => route.abort("internetdisconnected"));
    const refresh = page.getByRole("button", { name: /refresh|retry/i }).first();
    if (await refresh.count()) await refresh.click();
    else await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.getByText(/offline|unavailable|retry|connection/i).first().waitFor({ state: "visible" });
    await page.unroute("**/api/v1/**");
    if (await refresh.count()) await refresh.click();

    await openLeaseForm(page);
    await fillLegacyLeaseForm(page, fixture);
    await page.route("**/api/v1/capacity-leases", (route) => route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "CAPACITY_UNAVAILABLE", message: "capacity unavailable", details: {} } }),
    }), { times: 1 });
    await submitLeaseForm(page);
    await page.getByText(/capacity|unavailable|conflict/i).first().waitFor({ state: "visible" });

    await submitLeaseForm(page);
    await expectState(page, "HELD");
    await (await firstVisible([page.getByRole("button", { name: /confirm/i })], "Confirm button")).click();
    await expectState(page, "CONFIRMED");
    const renewEnd = page.getByLabel(/renew.*end|new.*end|end at/i).last();
    if (await renewEnd.count()) await setControl(renewEnd, localTimestamp(ctx.at({ hours: 4 })));
    await page.route("**/api/v1/capacity-leases/*/renew", (route) => route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "LEASE_REVISION_CHANGED", message: "stale revision", details: {} } }),
    }), { times: 1 });
    await (await firstVisible([page.getByRole("button", { name: /renew/i })], "Renew button")).click();
    await page.getByText(/stale|revision/i).first().waitFor({ state: "visible" });
    const reason = page.getByLabel(/release.*reason|reason/i).first();
    if (await reason.count()) await reason.fill("completed");
    await (await firstVisible([page.getByRole("button", { name: /release/i })], "Release button")).click();
    await expectState(page, "RELEASED");

    await page.route("**/api/v1/**", (route) => route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "ADMIN_AUTH_REQUIRED", message: "permission required", details: {} } }),
    }));
    if (await refresh.count()) await refresh.click();
    else await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(/permission|unauthorized|admin|sign in/i).first().waitFor({ state: "visible" });
    await page.unroute("**/api/v1/**");

    const scriptLocators = page.locator("script[src]");
    for (let index = 0; index < await scriptLocators.count(); index += 1) {
      const url = await scriptLocators.nth(index).getAttribute("src");
      if (!url) continue;
      const asset = await ctx.request(fixture.api.baseUrl, new URL(url, fixture.api.baseUrl).pathname);
      assert.doesNotMatch(asset.text ?? "", new RegExp(ctx.adminToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }
    assert.doesNotMatch(await page.locator("body").innerText(), new RegExp(ctx.adminToken, "u"));
    await context.setOffline(false);
    return result([{ kind: "production-ui-failure-states", states: ["empty", "loading", "offline", "conflict", "stale", "terminal", "permission"], secretLeak: false }]);
  });
}

function parseRgb(value) {
  const match = /^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[, /]+([\d.]+))?\)$/u.exec(value.trim());
  if (!match || Number(match[4] ?? 1) === 0) return undefined;
  return match.slice(1, 4).map(Number);
}

function luminance([red, green, blue]) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(left, right) {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

async function assertComputedContrast(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await session.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "button,a[href]" });
  const computed = async (nodeId) => {
    const { computedStyle } = await session.send("CSS.getComputedStyleForNode", { nodeId });
    return Object.fromEntries(computedStyle.map(({ name, value }) => [name, value]));
  };
  const opaqueBackground = async (nodeId) => {
    let current = nodeId;
    for (let depth = 0; current && depth < 12; depth += 1) {
      const background = parseRgb((await computed(current))["background-color"] ?? "");
      if (background) return background;
      const described = await session.send("DOM.describeNode", { nodeId: current });
      current = described.node.parentId;
    }
    return undefined;
  };
  let checked = 0;
  for (const nodeId of nodeIds) {
    let style;
    try {
      style = await computed(nodeId);
      await session.send("DOM.getBoxModel", { nodeId });
    } catch {
      continue;
    }
    const foreground = parseRgb(style.color ?? "");
    const background = await opaqueBackground(nodeId);
    if (!foreground || !background) continue;
    checked += 1;
    assert.ok(contrast(foreground, background) >= 4.5, `visible primary control contrast is below WCAG AA`);
  }
  assert.ok(checked > 0, "no visible primary control had a deterministic opaque contrast pair");
  await session.detach();
  return checked;
}

async function accessibilityViewport(baseUrl, viewport) {
  return withBrowser(baseUrl, async ({ page }) => {
    const controls = page.locator("button,input,select,textarea,a[href]");
    const count = await controls.count();
    assert.ok(count > 0, "production UI has no interactive controls");
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      const item = controls.nth(index);
      if (!(await item.isVisible())) continue;
      visible += 1;
      const box = await item.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1, "visible control is outside the viewport");
      const aria = await item.getAttribute("aria-label");
      const id = await item.getAttribute("id");
      const labelled = id ? await page.locator(`label[for=${JSON.stringify(id)}]`).count() : 0;
      const nested = await item.locator("xpath=ancestor::label").count();
      const text = (await item.innerText().catch(() => "")).trim();
      assert.ok(aria?.trim() || labelled || nested || text, "visible control has no accessible name or associated label");
    }
    assert.ok(visible > 0);
    for (let index = 0; index < Math.min(visible, 12); index += 1) {
      await page.keyboard.press("Tab");
      assert.equal(await page.locator(":focus").isVisible(), true, "keyboard focus is not visible on a reachable control");
    }
    const contrastChecks = await assertComputedContrast(page);
    return { visible, contrastChecks };
  }, { viewport });
}

async function runD06(ctx) {
  const { api } = await setup(ctx, "d06");
  const desktop = await accessibilityViewport(api.baseUrl, { width: 1440, height: 1000 });
  const mobile = await accessibilityViewport(api.baseUrl, { width: 390, height: 844 });
  return result([{ kind: "production-ui-accessibility", desktop, mobile }]);
}

async function processTable(ctx) {
  const processes = await ctx.command("ps", ["-eo", "pid=,args="], { allowFailure: true });
  return processes.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), args: match[2] }] : [];
  });
}

async function observeRoleProcesses(ctx, commandPromise, minimum, beforePids) {
  let settled = false;
  commandPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  return ctx.waitFor(async () => {
    const lines = (await processTable(ctx)).filter(({ pid }) => !beforePids.has(pid));
    const apiCount = lines.filter(({ args }) => /npm run start:api|start:api/u.test(args)).length;
    const workerCount = lines.filter(({ args }) => /npm run start:worker|start:worker/u.test(args)).length;
    if (apiCount >= minimum.api && workerCount >= minimum.worker) return { apiCount, workerCount };
    if (settled) assert.fail(`project gate ended before exposing ${minimum.api} APIs and ${minimum.worker} Workers`);
    return undefined;
  }, { label: "project gate public process topology", timeoutMs: 120_000, intervalMs: 100 });
}

async function runD07(ctx) {
  return guarded(async () => {
    const integration = await ctx.npm("test:integration", [], { timeoutMs: 600_000 });
    assert.equal(integration.exitCode, 0);
    const poisonedIntegration = await ctx.npm("test:integration", [], {
      allowFailure: true,
      timeoutMs: 120_000,
      env: {
        DATABASE_URL: "postgresql://127.0.0.1:1/unreachable",
        TEST_DATABASE_URL: "postgresql://127.0.0.1:1/unreachable",
      },
    });
    assert.notEqual(poisonedIntegration.exitCode, 0, "integration gate is fake green without PostgreSQL");

    const e2e = await ctx.npm("test:e2e", [], { timeoutMs: 600_000 });
    assert.equal(e2e.exitCode, 0);
    const poisonedE2e = await ctx.npm("test:e2e", [], {
      allowFailure: true,
      timeoutMs: 120_000,
      env: { CHROMIUM_PATH: ctx.tempPath("missing-chromium") },
    });
    assert.notEqual(poisonedE2e.exitCode, 0, "E2E gate is fake green without Chromium");

    const beforePids = new Set((await processTable(ctx)).map(({ pid }) => pid));
    const concurrencyPromise = ctx.npm("test:concurrency", [], { timeoutMs: 600_000 });
    const topology = await observeRoleProcesses(ctx, concurrencyPromise, { api: 2, worker: 2 }, beforePids);
    assert.equal((await concurrencyPromise).exitCode, 0);

    let heldOnce = false;
    const barrier = await ctx.barrier({ hold: () => !heldOnce && (heldOnce = true) });
    const recoveryPromise = ctx.npm("test:recovery", [], {
      timeoutMs: 600_000,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const entry = await barrier.waitFor(() => barrier.ledger[0], { timeoutMs: 120_000 });
    assert.ok(["worker", "dispatcher"].includes(entry.json.processRole));
    barrier.releaseAll();
    assert.equal((await recoveryPromise).exitCode, 0);
    return result([{ kind: "project-owned-gates", topology, barrierObserved: true, poisonedGatesRejected: 2 }]);
  });
}

async function runD08(ctx) {
  const fixture = await setup(ctx, "d08", { poolCount: 3, capacityUnits: 10 });
  const openapi = await ctx.request(fixture.api.baseUrl, "/openapi.json");
  requireStatus(openapi, 200, "OpenAPI");
  const ledger = [];
  const record = (requirement, nodes) => {
    const required = ["http", "openapi", "snapshot", "hiddenEvidence"];
    for (const key of required) assert.equal(nodes[key], true, `${requirement} has no ${key} evidence`);
    ledger.push({ requirement, ...nodes });
  };

  const held = await createLease(ctx, fixture.api, "d08-held", leaseRequest(ctx, fixture.ids, "d08-held", { holdSeconds: 120 }), 201);
  assertDocumentedResponse(openapi.json, "/api/v1/capacity-leases", "POST", held);
  const leaseId = leaseIdentity(held.json);
  const snapshotHeld = await ctx.snapshot(fixture.api.baseUrl);
  assertFinalSnapshot(snapshotHeld);
  record("V1 Lease creation", {
    http: true,
    openapi: true,
    snapshot: snapshotHeld.resources.capacityLeases.some((lease) => lease.leaseId === leaseId),
    hiddenEvidence: snapshotHeld.events.some((event) => event.aggregateId === leaseId),
    uiApplicable: true,
  });

  const confirmed = await ctx.mutate(fixture.api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("d08-confirm"), {
    holdToken: held.json.holdToken,
    expectedRevision: held.json.revision,
  });
  requireStatus(confirmed, 200, "confirm");
  assertDocumentedResponse(openapi.json, "/api/v1/capacity-leases/:leaseId/confirm", "POST", confirmed);
  const renewed = await ctx.mutate(fixture.api.baseUrl, `/api/v1/capacity-leases/${leaseId}/renew`, ctx.key("d08-renew"), {
    expectedRevision: confirmed.json.revision,
    endAt: ctx.at({ hours: 4 }),
  });
  requireStatus(renewed, 200, "renew");
  assertDocumentedResponse(openapi.json, "/api/v1/capacity-leases/:leaseId/renew", "POST", renewed);
  const released = await ctx.mutate(fixture.api.baseUrl, `/api/v1/capacity-leases/${leaseId}/release`, ctx.key("d08-release"), {
    expectedRevision: renewed.json.revision,
    reason: "cross-layer acceptance",
  });
  requireStatus(released, 200, "release");
  assertDocumentedResponse(openapi.json, "/api/v1/capacity-leases/:leaseId/release", "POST", released);
  const snapshotLifecycle = await ctx.snapshot(fixture.api.baseUrl);
  assertFinalSnapshot(snapshotLifecycle);
  record("V1 transition lifecycle", {
    http: true,
    openapi: true,
    snapshot: snapshotLifecycle.resources.capacityLeases.find((lease) => lease.leaseId === leaseId)?.state === "RELEASED",
    hiddenEvidence: snapshotLifecycle.events.filter((event) => event.aggregateId === leaseId).length === 4,
    uiApplicable: true,
  });

  await createLease(ctx, fixture.api, "d08-wait-blocker", leaseRequest(ctx, fixture.ids, "d08-wait-blocker", {
    startAt: ctx.at({ hours: 8 }), endAt: ctx.at({ hours: 9 }), units: 10, holdSeconds: 120,
  }), 201);
  const waiting = await createLease(ctx, fixture.api, "d08-waiting", leaseRequest(ctx, fixture.ids, "d08-waiting", {
    startAt: ctx.at({ hours: 8 }), endAt: ctx.at({ hours: 9 }), units: 1, allowWait: true,
  }), 202);
  const admissionId = waiting.json.admissionEntryId;
  const cancelled = await ctx.request(fixture.api.baseUrl, `/api/v1/admission-entries/${admissionId}`, {
    method: "DELETE",
    headers: { "idempotency-key": ctx.key("d08-cancel") },
  });
  assert.ok([200, 204].includes(cancelled.status));
  assertDocumentedResponse(openapi.json, "/api/v1/admission-entries/:admissionEntryId", "DELETE", cancelled);
  const snapshotCancelled = await ctx.snapshot(fixture.api.baseUrl);
  assertFinalSnapshot(snapshotCancelled);
  record("Admission waiting and cancellation", {
    http: true,
    openapi: true,
    snapshot: snapshotCancelled.resources.admissionEntries.find((entry) => entry.admissionEntryId === admissionId)?.state === "CANCELLED",
    hiddenEvidence: snapshotCancelled.work.filter((work) => work.aggregateId === admissionId).length > 0,
    uiApplicable: true,
  });

  const expiring = await createLease(ctx, fixture.api, "d08-expiring", leaseRequest(ctx, fixture.ids, "d08-expiring", {
    startAt: ctx.at({ hours: 10 }), endAt: ctx.at({ hours: 11 }), units: 10, holdSeconds: 1,
  }), 201);
  const expiringId = leaseIdentity(expiring.json);
  const promotable = await createLease(ctx, fixture.api, "d08-promotable", leaseRequest(ctx, fixture.ids, "d08-promotable", {
    startAt: ctx.at({ hours: 10 }), endAt: ctx.at({ hours: 11 }), units: 1, allowWait: true,
  }), 202);
  const promotableId = promotable.json.admissionEntryId;
  const worker = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "1" } });
  const snapshotAsync = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(fixture.api.baseUrl);
    const lease = snapshot.resources.capacityLeases.find((item) => item.leaseId === expiringId);
    const admission = snapshot.resources.admissionEntries.find((item) => item.admissionEntryId === promotableId);
    return lease?.state === "EXPIRED" && admission?.state === "PROMOTED" ? snapshot : undefined;
  }, { label: "cross-layer expiry and Promotion", timeoutMs: 30_000 });
  assertFinalSnapshot(snapshotAsync);
  record("Asynchronous expiry and Promotion", {
    http: true,
    openapi: operation(openapi.json, "/api/v1/capacity-leases", "POST") != null,
    snapshot: true,
    hiddenEvidence: snapshotAsync.events.some((event) => event.aggregateId === expiringId && event.type === "lease.expired")
      && snapshotAsync.events.some((event) => event.aggregateId === promotableId && event.type === "admission.promoted"),
    uiApplicable: true,
  });
  await ctx.stop(worker);

  const gang = await createLease(ctx, fixture.api, "d08-gang", gangRequest(ctx, fixture.ids, "d08-gang", 3, {
    startAt: ctx.at({ hours: 5 }), endAt: ctx.at({ hours: 6 }),
  }), 201);
  const gangId = leaseIdentity(gang.json);
  const members = await ctx.request(fixture.api.baseUrl, `/api/v1/capacity-leases/${gangId}/members`);
  requireStatus(members, 200, "Gang members");
  assertDocumentedResponse(openapi.json, "/api/v1/capacity-leases/:leaseId/members", "GET", members);
  const snapshotGang = await ctx.snapshot(fixture.api.baseUrl);
  assertFinalSnapshot(snapshotGang);
  record("FINAL Gang Lease", {
    http: true,
    openapi: true,
    snapshot: snapshotGang.resources.gangLeaseMembers.filter((member) => member.leaseId === gangId).length === 3,
    hiddenEvidence: members.json.items?.length === 3,
    uiApplicable: true,
  });

  const timeline = await ctx.request(
    fixture.api.baseUrl,
    `/api/v1/capacity-pools/${fixture.ids.poolIds[0]}/timeline?from=${encodeURIComponent(ctx.at({ hours: 1 }))}&to=${encodeURIComponent(ctx.at({ hours: 7 }))}`,
  );
  requireStatus(timeline, 200, "timeline");
  assertDocumentedResponse(openapi.json, "/api/v1/capacity-pools/:poolId/timeline", "GET", timeline);
  record("Timeline and evidence reads", {
    http: true,
    openapi: true,
    snapshot: true,
    hiddenEvidence: Array.isArray(timeline.json.items ?? timeline.json),
    uiApplicable: true,
  });

  const uiEvidence = await withBrowser(fixture.api.baseUrl, async ({ page }) => {
    await expectState(page, "RELEASED");
    await expectState(page, "CANCELLED");
    await expectState(page, "EXPIRED");
    await expectState(page, "PROMOTED");
    const leaseSurfaceVisible = await page.getByText(/capacity lease|lease detail/i).first().isVisible();
    const poolVisible = await page.getByText(new RegExp(fixture.seed.capacityPools[0].name, "i")).first().isVisible();
    const gangMembersVisible = (await Promise.all(fixture.seed.capacityPools.slice(0, 3).map(async (pool) => (
      page.getByText(new RegExp(`${pool.poolId}|${pool.name}`, "i")).first().isVisible()
    )))).every(Boolean);
    const eventVisible = await page.getByText(/event|history/i).first().isVisible();
    const timelineVisible = await page.getByText(/timeline/i).first().isVisible();
    return {
      "V1 Lease creation": leaseSurfaceVisible && poolVisible,
      "V1 transition lifecycle": eventVisible,
      "Admission waiting and cancellation": await page.getByText(/CANCELLED/i).first().isVisible(),
      "Asynchronous expiry and Promotion": await page.getByText(/EXPIRED/i).first().isVisible()
        && await page.getByText(/PROMOTED/i).first().isVisible(),
      "FINAL Gang Lease": gangMembersVisible,
      "Timeline and evidence reads": eventVisible && timelineVisible,
    };
  });
  for (const entry of ledger) entry.ui = uiEvidence[entry.requirement] === true;
  assert.ok(ledger.every((entry) => entry.http && entry.openapi && entry.snapshot && entry.ui && entry.hiddenEvidence));
  return result([{ kind: "readme-cross-layer-ledger", requirements: ledger.length, passing: ledger.length }]);
}

export const D_CASES = [
  { id: "D-01", run: (ctx) => guarded(() => runD01(ctx)) },
  { id: "D-02", run: (ctx) => guarded(() => runD02(ctx)) },
  { id: "D-03", run: (ctx) => guarded(() => runD03(ctx)) },
  { id: "D-04", run: (ctx) => guarded(() => runD04(ctx)) },
  { id: "D-05", run: (ctx) => guarded(() => runD05(ctx)) },
  { id: "D-06", run: (ctx) => guarded(() => runD06(ctx)) },
  { id: "D-07", run: (ctx) => runD07(ctx) },
  { id: "D-08", run: (ctx) => guarded(() => runD08(ctx)) },
];
