import { assertLiveSchema } from '../oracles/openapi.mjs';
import assert from "node:assert/strict";

import { assertDockChainOpenApi, dockChainOpenApiRoutes } from "../oracles/index.mjs";

import {
  assertCapacityConservation, assertMovement, assertPortCall, assertSnapshot, browserMutation, confirmPortCall,
  createPortCall, defineCase, exactKeys, expectError, expectSuccess, finalEvidence, getPortCall, launchBrowser,
  movementAction, prepare, startDockWorker, visibleControl, visibleField, waitForCallState, waitForMovementState,
} from "./helpers.mjs";

async function fill(field, value) { const tag = await field.evaluate((element) => element.tagName.toLowerCase()); if (tag === "select") await field.selectOption(String(value)); else await field.fill(String(value)); }
async function keyboardFill(page, field, value) { const tag = await field.evaluate((element) => element.tagName.toLowerCase()); await field.focus(); if (tag === "select") { const option = field.locator("option:not([disabled]):not([value=''])").first(); const label = await option.innerText(); await page.keyboard.type(label); await page.keyboard.press("Enter"); return; } const type = await field.getAttribute("type"); const text = type === "datetime-local" ? String(value).replace(/Z$/u, "").slice(0, 16) : String(value); await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A"); await page.keyboard.insertText(text); }
async function keyboardMutation(page, roles, names, pathPattern) { const response = page.waitForResponse((value) => value.request().method() === "POST" && pathPattern.test(new URL(value.url()).pathname), { timeout: 30_000 }); const control = await visibleControl(page, roles, names); await control.focus(); await page.keyboard.press("Enter"); return response; }
async function publicRequests(page) { const values = []; page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) values.push({ method: request.method(), path, headers: request.headers() }); }); return values; }

const D01 = defineCase({
  id: "D-01", fixtureFamily: "DC-F-RESOURCE-GRID",
  action: "Validate the FINAL OpenAPI document with evaluator-owned closed schemas while collecting live success and every published error class from V1 and movement routes.",
  oracle: "Live statuses, envelopes and resource bodies match the independent contract, linked legacy fields are required nullable, movements are ordered, and ResourceAllocation exposes no unpublished ownership field.",
  async run(ctx) {
    const fixture = ctx.fixtures.resourceGrid();
    const target = await prepare(ctx, { seed: fixture.seed });
    const api = await target.startApi();
    const openapi = expectSuccess(ctx, await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI");
    ctx.ok(assertDockChainOpenApi(openapi), "task-owned exact OpenAPI contract");
    const traffic = [];
    function record(method, path, response, status) { ctx.equal(response.status, status, `${method} ${path} live status`); assertLiveSchema(openapi, path, method, status, response.json); traffic.push({ method, path, status }); return response; }

    const v1Body = fixture.v1Payload("traffic", { arrivalAt: fixture.at({ days: 20 }), departureAt: fixture.at({ days: 20, hours: 2 }) });
    const created = record("post", "/api/v1/port-calls", await ctx.mutate(api.baseUrl, "/api/v1/port-calls", ctx.key("d01-v1-create"), v1Body), 201);
    const v1 = assertPortCall(expectSuccess(ctx, created, "V1 create", 201), { final: true });
    record("get", "/api/v1/port-calls", await ctx.request(api.baseUrl, "/api/v1/port-calls?limit=10"), 200);
    record("get", "/api/v1/port-calls/{portCallId}", await ctx.request(api.baseUrl, `/api/v1/port-calls/${v1.portCallId}`), 200);
    record("post", "/api/v1/port-calls/{portCallId}/confirm", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${v1.portCallId}/confirm`, ctx.key("d01-v1-confirm"), {}), 200);
    const worker = await startDockWorker(target);
    await waitForCallState(ctx, api.baseUrl, v1.portCallId, "CLEARED", [worker]);
    record("post", "/api/v1/port-calls/{portCallId}/start-service", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${v1.portCallId}/start-service`, ctx.key("d01-v1-start"), {}), 200);
    record("post", "/api/v1/port-calls/{portCallId}/complete", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${v1.portCallId}/complete`, ctx.key("d01-v1-complete"), {}), 200);

    const cancelBody = fixture.v1Payload("traffic-cancel", { arrivalAt: fixture.at({ days: 21 }), departureAt: fixture.at({ days: 21, hours: 2 }) });
    const cancellable = assertPortCall(expectSuccess(ctx, await ctx.mutate(api.baseUrl, "/api/v1/port-calls", ctx.key("d01-cancel-create"), cancelBody), "cancel fixture", 201), { final: true });
    record("post", "/api/v1/port-calls/{portCallId}/cancel", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${cancellable.portCallId}/cancel`, ctx.key("d01-v1-cancel"), { reason: "contract traffic" }), 200);
    record("post", "/api/v1/standby-entries", await ctx.mutate(api.baseUrl, "/api/v1/standby-entries", ctx.key("d01-standby"), ctx.fixtures.standby().standbyPayload("traffic", { arrivalFrom: fixture.at({ days: 22 }), arrivalTo: fixture.at({ days: 22, hours: 8 }) })), 201);
    record("get", "/api/v1/port-resources/feasible-windows", await ctx.request(api.baseUrl, `/api/v1/port-resources/feasible-windows?${new URLSearchParams({ vesselId: fixture.vessels[0].vesselId, arrivalFrom: fixture.at({ days: 23 }), arrivalTo: fixture.at({ days: 24 }), durationMinutes: "120", requiredTugs: "1", containerUnits: "25" })}`), 200);
    record("get", "/api/v1/port-resources/schedule", await ctx.request(api.baseUrl, `/api/v1/port-resources/schedule?from=${encodeURIComponent(fixture.at({ days: 20 }))}&to=${encodeURIComponent(fixture.at({ days: 25 }))}`), 200);
    record("get", "/api/v1/domain-events", await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${v1.portCallId}&afterSequence=0&limit=100`), 200);
    const snapshotResponse = record("get", "/api/v1/verification-snapshot", await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { headers: { authorization: `Bearer ${ctx.adminToken}` } }), 200);
    assertSnapshot(ctx, snapshotResponse.json);

    const linkedBody = fixture.linkedPayload("traffic-linked", { arrival: { ...fixture.linkedPayload("traffic-linked").arrival, startAt: fixture.at({ days: 25, hours: 8 }), endAt: fixture.at({ days: 25, hours: 10 }) }, departure: { ...fixture.linkedPayload("traffic-linked").departure, startAt: fixture.at({ days: 25, hours: 12 }), endAt: fixture.at({ days: 25, hours: 14 }) } });
    const linked = assertPortCall(expectSuccess(ctx, await ctx.mutate(api.baseUrl, "/api/v1/port-calls", ctx.key("d01-linked-create"), linkedBody), "linked create", 201), { final: true });
    linked.movements.forEach(assertMovement);
    const arrival = linked.movements.find(({ type }) => type === "ARRIVAL");
    const departure = linked.movements.find(({ type }) => type === "DEPARTURE");
    record("post", "/api/v1/port-calls/{portCallId}/movements/{movementId}/confirm", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${linked.portCallId}/movements/${arrival.movementId}/confirm`, ctx.key("d01-movement-confirm"), {}), 200);
    await waitForMovementState(ctx, api.baseUrl, arrival.movementId, "CLEARED", [worker]);
    record("post", "/api/v1/port-calls/{portCallId}/movements/{movementId}/start-service", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${linked.portCallId}/movements/${arrival.movementId}/start-service`, ctx.key("d01-movement-start"), {}), 200);
    record("post", "/api/v1/port-calls/{portCallId}/movements/{movementId}/complete", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${linked.portCallId}/movements/${arrival.movementId}/complete`, ctx.key("d01-movement-complete"), {}), 200);
    record("post", "/api/v1/port-calls/{portCallId}/movements/{movementId}/cancel", await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${linked.portCallId}/movements/${departure.movementId}/cancel`, ctx.key("d01-movement-cancel"), { reason: "contract traffic" }), 200);

    const invalid = await ctx.mutate(api.baseUrl, "/api/v1/port-calls", ctx.key("d01-invalid"), { ...v1Body, unknown: true }, {contractExpectation:"invalid"}); expectError(ctx, invalid, 400, "UNKNOWN_FIELD", "live unknown field");
    const denied = record("get", "/api/v1/verification-snapshot", await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { headers: { authorization: "Bearer wrong" } }), 401); expectError(ctx, denied, 401, "ADMIN_AUTH_REQUIRED", "live auth error");
    const absent = await ctx.request(api.baseUrl, `/api/v1/port-calls/${ctx.uuid("missing")}`); expectError(ctx, absent, 404, "NOT_FOUND", "missing live traffic");
    const conflict = await movementAction(ctx, api.baseUrl, linked.portCallId, arrival.movementId, "start-service", { allowFailure: true }); expectError(ctx, conflict, 409, "MOVEMENT_STATE_CONFLICT", "movement state conflict");
    const unsupported = await ctx.request(api.baseUrl, "/api/v1/port-calls", { method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("d01-media") }, contractExpectation:"invalid", raw: "{}" }); expectError(ctx, unsupported, 415, "UNSUPPORTED_MEDIA_TYPE", "live media error");
    const expectedOperations = Object.entries(dockChainOpenApiRoutes()).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method}:${path}`));
    ctx.equal([...new Set(traffic.map(({ method, path }) => `${method}:${path}`))].sort(), expectedOperations.sort(), "every V1 and FINAL route family has live success traffic");
    return finalEvidence(ctx, { v1PortCallId: v1.portCallId, linkedPortCallId: linked.portCallId, liveOperations: expectedOperations.length, liveErrorStatuses: [400, 401, 404, 409, 415] });
  },
});

const D02 = defineCase({
  id: "D-02", fixtureFamily: "DC-F-BROWSER",
  action: "Use production Chromium and visible semantic controls to create a V1 Call, confirm it, observe real asynchronous Clearance, start and complete service, then open schedule and event history and refresh.",
  oracle: "Every primary action issues only the public HTTP route, visible state matches HTTP and PostgreSQL snapshot after refresh, worker progress is real, and no browser-only ownership or mock state supplies correctness.",
  async run(ctx) {
    const fixture = ctx.fixtures.browser(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const worker = await startDockWorker(target); const { page } = await launchBrowser(ctx, api.baseUrl); const observed = await publicRequests(page); const vessel = await visibleField(page, [/vessel|船舶/iu]); await fill(vessel, fixture.vessels[0].vesselId); await fill(await visibleField(page, [/arrival.*time|arrival at|到港时间/iu]), fixture.at({ days: 21, hours: 8 })); await fill(await visibleField(page, [/departure.*time|departure at|离港时间/iu]), fixture.at({ days: 21, hours: 10 })); await fill(await visibleField(page, [/required.*tug|tugs|拖轮/iu]), 1); await fill(await visibleField(page, [/container.*unit|containers|集装箱/iu]), 25); const create = await browserMutation(page, /create|hold|schedule|创建|预留/iu, /^\/api\/v1\/port-calls$/u); ctx.equal(create.status(), 201, "browser creates V1 Call"); const call = assertPortCall(await create.json(), { final: true }); const confirm = await browserMutation(page, /confirm|确认/iu, new RegExp(`^/api/v1/port-calls/${call.portCallId}/confirm$`, "u")); ctx.equal(confirm.status(), 200, "browser confirms V1 Call"); await waitForCallState(ctx, api.baseUrl, call.portCallId, "CLEARED", [worker]); await page.reload({ waitUntil: "networkidle" }); ctx.ok(await page.getByText(/cleared|已通过|已清关/iu).count() > 0, "browser shows cleared state after refresh"); ctx.equal((await browserMutation(page, /start.*service|start|开始服务|开始作业/iu, new RegExp(`^/api/v1/port-calls/${call.portCallId}/start-service$`, "u"))).status(), 200, "browser starts service"); ctx.equal((await browserMutation(page, /complete|完成/iu, new RegExp(`^/api/v1/port-calls/${call.portCallId}/complete$`, "u"))).status(), 200, "browser completes service"); await page.reload({ waitUntil: "networkidle" }); ctx.ok(await page.getByText(/completed|已完成/iu).count() > 0, "browser persists completed state"); await (await visibleControl(page, ["button", "link", "tab"], [/schedule|资源日程|调度/iu])).click(); ctx.ok(await page.getByText(/berth|tug|yard|泊位|拖轮|堆场/iu).count() > 0, "browser opens resource schedule"); await (await visibleControl(page, ["button", "link", "tab"], [/event|history|事件|历史/iu])).click(); ctx.ok(await page.getByText(/held|confirm|clear|complete|预留|确认|完成/iu).count() > 0, "browser opens event history"); ctx.ok(observed.length > 0 && observed.every(({ path }) => !/(?:verification-snapshot|internal|private|admin)/iu.test(path)), "browser uses public non-admin routes"); const snapshot = await ctx.snapshot(api.baseUrl); ctx.equal(snapshot.resources.portCalls.find(({ portCallId }) => portCallId === call.portCallId).state, "COMPLETED", "browser state equals snapshot"); return finalEvidence(ctx, { portCallId: call.portCallId, publicRequests: observed.length, views: ["schedule", "events"] });
  },
});

const D03 = defineCase({
  id: "D-03", fixtureFamily: "DC-F-BROWSER",
  action: "Use production Chromium controls to create and observe V1 Standby promotion, then create one linked Call and independently confirm, start, complete or cancel its ARRIVAL and DEPARTURE movements.",
  oracle: "The UI exposes fair Standby state, two complete movement bundles, each movement lifecycle and aggregate projection from real backend data, while never requiring an unpublished linked Standby request.",
  async run(ctx) {
    const fixture = ctx.fixtures.browser(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const workers = [await startDockWorker(target), await startDockWorker(target)]; const { page } = await launchBrowser(ctx, api.baseUrl); const observed = await publicRequests(page); await (await visibleControl(page, ["button", "link", "tab"], [/standby|候补/iu])).click(); await fill(await visibleField(page, [/vessel|船舶/iu]), fixture.vessels[0].vesselId); await fill(await visibleField(page, [/arrival from|earliest arrival|最早到港/iu]), fixture.at({ days: 22, hours: 8 })); await fill(await visibleField(page, [/arrival to|latest arrival|最晚到港/iu]), fixture.at({ days: 22, hours: 16 })); await fill(await visibleField(page, [/duration|时长/iu]), 120); await fill(await visibleField(page, [/required.*tug|tugs|拖轮/iu]), 1); await fill(await visibleField(page, [/container.*unit|containers|集装箱/iu]), 25); await fill(await visibleField(page, [/priority|优先级/iu]), 10); const standbyResponse = await browserMutation(page, /join|create.*standby|加入候补|创建候补/iu, /^\/api\/v1\/standby-entries$/u); ctx.equal(standbyResponse.status(), 201, "browser creates Standby"); const standby = await standbyResponse.json(); ctx.ok(standby.standbyEntryId, "browser receives Standby identity"); await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(api.baseUrl); return snapshot.resources.standbyEntries.find(({ standbyEntryId }) => standbyEntryId === standby.standbyEntryId)?.state === "PROMOTED"; }, { timeoutMs: 120_000, label: "browser Standby promotion", processes: workers }); await page.reload({ waitUntil: "networkidle" }); ctx.ok(await page.getByText(/promoted|已晋升|已转为预留/iu).count() > 0, "browser observes Standby promotion"); await (await visibleControl(page, ["button", "link", "tab"], [/linked|movements|联动|进出港/iu])).click(); await fill(await visibleField(page, [/vessel|船舶/iu]), fixture.vessels[0].vesselId); for (const [pattern, value] of [[/arrival.*start|到港开始/iu, fixture.at({ days: 23, hours: 8 })], [/arrival.*end|到港结束/iu, fixture.at({ days: 23, hours: 10 })], [/departure.*start|离港开始/iu, fixture.at({ days: 23, hours: 12 })], [/departure.*end|离港结束/iu, fixture.at({ days: 23, hours: 14 })]]) await fill(await visibleField(page, [pattern]), value); const linkedResponse = await browserMutation(page, /create.*linked|create.*call|创建联动|创建港口调用/iu, /^\/api\/v1\/port-calls$/u); ctx.equal(linkedResponse.status(), 201, "browser creates linked Call"); const linked = assertPortCall(await linkedResponse.json(), { final: true }); for (const movement of linked.movements) { const confirm = await browserMutation(page, new RegExp(`confirm.*${movement.type}|${movement.type}.*confirm|确认`, "iu"), new RegExp(`^/api/v1/port-calls/${linked.portCallId}/movements/${movement.movementId}/confirm$`, "u")); ctx.equal(confirm.status(), 200, `${movement.type} browser confirm`); await waitForMovementState(ctx, api.baseUrl, movement.movementId, "CLEARED", workers); await page.reload({ waitUntil: "networkidle" }); } const arrival = linked.movements.find(({ type }) => type === "ARRIVAL"); const departure = linked.movements.find(({ type }) => type === "DEPARTURE"); ctx.equal((await browserMutation(page, /start.*arrival|arrival.*start|开始.*到港/iu, new RegExp(`^/api/v1/port-calls/${linked.portCallId}/movements/${arrival.movementId}/start-service$`, "u"))).status(), 200, "browser starts ARRIVAL"); await page.reload({ waitUntil: "networkidle" }); ctx.equal((await browserMutation(page, /complete.*arrival|arrival.*complete|完成.*到港/iu, new RegExp(`^/api/v1/port-calls/${linked.portCallId}/movements/${arrival.movementId}/complete$`, "u"))).status(), 200, "browser completes ARRIVAL"); await page.reload({ waitUntil: "networkidle" }); ctx.equal((await browserMutation(page, /cancel.*departure|departure.*cancel|取消.*离港/iu, new RegExp(`^/api/v1/port-calls/${linked.portCallId}/movements/${departure.movementId}/cancel$`, "u"))).status(), 200, "browser cancels DEPARTURE"); ctx.ok(observed.every(({ path }) => !/(?:verification-snapshot|internal|private|admin)/iu.test(path)), "linked UI only public routes"); const final = await getPortCall(ctx, api.baseUrl, linked.portCallId, { final: true }); ctx.equal(final.movements.find(({ type }) => type === "ARRIVAL").state, "COMPLETED", "linked UI completes ARRIVAL"); ctx.equal(final.movements.find(({ type }) => type === "DEPARTURE").state, "CANCELLED", "linked UI cancels DEPARTURE"); ctx.equal(final.state, "ARRIVED", "linked UI aggregate projection"); assertCapacityConservation(await ctx.snapshot(api.baseUrl)); return finalEvidence(ctx, { standbyEntryId: standby.standbyEntryId, linkedPortCallId: linked.portCallId, publicRequests: observed.length });
  },
});

const D04 = defineCase({
  id: "D-04", fixtureFamily: "DC-F-BROWSER",
  action: "Drive the production UI through empty and loading states, a real bundle conflict, stale detail after another process mutates, browser offline and retry, plus an unauthorized administrative observation.",
  oracle: "Every state is visibly distinguishable and recoverable, retry preserves the same operation identity without duplicate Call or transition, and ADMIN_TOKEN never appears in bundle, page, storage, request or logs.",
  async run(ctx) {
    const fixture = ctx.fixtures.browser(); const seed = { ...fixture.seed, seedVersion: `${fixture.seed.seedVersion}-ui-states`, berths: [fixture.berths[0]], tugPools: [{ ...fixture.tugPools[0], capacity: 1 }], yardWindows: [{ ...fixture.yardWindows[0], capacityUnits: 1 }] }; const target = await prepare(ctx, { seed }); const apis = [await target.startApi(), await target.startApi()]; const { browserContext, page } = await launchBrowser(ctx, apis[0].baseUrl); const observed = await publicRequests(page); ctx.ok(await page.getByText(/empty|no port calls|暂无|没有/iu).count() > 0, "empty state visible"); const occupiedBody = fixture.v1Payload("ui-conflict", { arrivalAt: fixture.at({ days: 24 }), departureAt: fixture.at({ days: 24, hours: 2 }), requiredTugs: 1, containerUnits: 1 }); const occupied = await createPortCall(ctx, apis[1].baseUrl, occupiedBody, { final: true }); await page.reload({ waitUntil: "networkidle" }); await fill(await visibleField(page, [/vessel|船舶/iu]), occupiedBody.vesselId); await fill(await visibleField(page, [/arrival.*time|arrival at|到港时间/iu]), occupiedBody.arrivalAt); await fill(await visibleField(page, [/departure.*time|departure at|离港时间/iu]), occupiedBody.departureAt); await fill(await visibleField(page, [/required.*tug|tugs|拖轮/iu]), occupiedBody.requiredTugs); await fill(await visibleField(page, [/container.*unit|containers|集装箱/iu]), occupiedBody.containerUnits); const conflict = await browserMutation(page, /create|hold|schedule|创建|预留/iu, /^\/api\/v1\/port-calls$/u); ctx.equal(conflict.status(), 409, "real UI bundle conflict"); ctx.ok(await page.getByText(/unavailable|conflict|冲突|不可用/iu).count() > 0, "conflict state visible"); await browserContext.setOffline(true); await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined); ctx.ok(await page.getByText(/offline|network|retry|离线|网络|重试/iu).count() > 0, "offline state visible"); await browserContext.setOffline(false); await (await visibleControl(page, ["button", "link"], [/retry|reload|重试|重新加载/iu])).click(); await page.waitForLoadState("networkidle"); await ctx.mutate(apis[1].baseUrl, `/api/v1/port-calls/${occupied.portCallId}/cancel`, ctx.key("stale-cancel"), { reason: "external change" }); await page.reload({ waitUntil: "networkidle" }); ctx.ok(await page.getByText(/cancelled|stale|已取消|已更新/iu).count() > 0, "external stale change visible after refresh"); const denied = await ctx.request(apis[0].baseUrl, "/api/v1/verification-snapshot", { headers: { authorization: "Bearer wrong" } }); expectError(ctx, denied, 401, "ADMIN_AUTH_REQUIRED", "permission error"); const content = await page.locator("body").innerText(); ctx.ok(!content.includes(ctx.adminToken), "ADMIN_TOKEN absent from page"); ctx.ok(!JSON.stringify(observed).includes(ctx.adminToken), "ADMIN_TOKEN absent from browser requests"); ctx.ok(!apis.map(({ logs }) => logs).join("\n").includes(ctx.adminToken), "ADMIN_TOKEN absent from API logs"); return finalEvidence(ctx, { portCallId: occupied.portCallId, recoveredOffline: true, realConflict: true });
  },
});

function rgb(value) { const match = value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/u); return match ? match.slice(1).map(Number) : null; }
function luminance(color) { return color.map((value) => { const channel = value / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0); }
function identityPattern(value) { return new RegExp(String(value).slice(0, 12).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"); }

const D05 = defineCase({
  id: "D-05", fixtureFamily: "DC-F-BROWSER",
  action: "Run desktop and mobile production Chromium, complete V1 and linked primary mutations only through keyboard focus and Enter, submit one validation error, and inspect labels, focus, reachable actions and text contrast.",
  oracle: "Every primary control has a semantic accessible name and keyboard focus, validation moves focus to actionable feedback, mobile actions remain inside the viewport, and normal text reaches WCAG AA contrast.",
  async run(ctx) {
    const fixture = ctx.fixtures.browser();
    const target = await prepare(ctx, { seed: fixture.seed });
    const api = await target.startApi();
    const worker = await startDockWorker(target);
    const desktop = await launchBrowser(ctx, api.baseUrl, { width: 1280, height: 800 });
    const desktopPage = desktop.page;
    await keyboardFill(desktopPage, await visibleField(desktopPage, [/vessel|船舶/iu]), fixture.vessels[0].vesselId);
    await keyboardFill(desktopPage, await visibleField(desktopPage, [/arrival.*time|arrival at|到港时间/iu]), fixture.at({ days: 26, hours: 8 }));
    await keyboardFill(desktopPage, await visibleField(desktopPage, [/departure.*time|departure at|离港时间/iu]), fixture.at({ days: 26, hours: 10 }));
    await keyboardFill(desktopPage, await visibleField(desktopPage, [/required.*tug|tugs|拖轮/iu]), 1);
    await keyboardFill(desktopPage, await visibleField(desktopPage, [/container.*unit|containers|集装箱/iu]), 25);
    const create = await keyboardMutation(desktopPage, ["button", "link"], [/create|hold|schedule|创建|预留/iu], /^\/api\/v1\/port-calls$/u);
    ctx.equal(create.status(), 201, "keyboard V1 create");
    const call = assertPortCall(await create.json(), { final: true });
    const confirm = await keyboardMutation(desktopPage, ["button", "link"], [/confirm|确认/iu], new RegExp(`^/api/v1/port-calls/${call.portCallId}/confirm$`, "u"));
    ctx.equal(confirm.status(), 200, "keyboard V1 confirm");
    await waitForCallState(ctx, api.baseUrl, call.portCallId, "CLEARED", [worker]);
    await desktopPage.reload({ waitUntil: "networkidle" });
    ctx.equal((await keyboardMutation(desktopPage, ["button", "link"], [/start.*service|start|开始服务|开始作业/iu], new RegExp(`^/api/v1/port-calls/${call.portCallId}/start-service$`, "u"))).status(), 200, "keyboard V1 start");
    ctx.equal((await keyboardMutation(desktopPage, ["button", "link"], [/complete|完成/iu], new RegExp(`^/api/v1/port-calls/${call.portCallId}/complete$`, "u"))).status(), 200, "keyboard V1 complete");

    const mobile = await launchBrowser(ctx, api.baseUrl, { width: 390, height: 844 });
    const mobilePage = mobile.page;
    const linkedTab = await visibleControl(mobilePage, ["button", "link", "tab"], [/linked|movements|联动|进出港/iu]);
    await linkedTab.focus(); await mobilePage.keyboard.press("Enter");
    await keyboardFill(mobilePage, await visibleField(mobilePage, [/vessel|船舶/iu]), fixture.vessels[0].vesselId);
    for (const [pattern, value] of [[/arrival.*start|到港开始/iu, fixture.at({ days: 27, hours: 8 })], [/arrival.*end|到港结束/iu, fixture.at({ days: 27, hours: 10 })], [/departure.*start|离港开始/iu, fixture.at({ days: 27, hours: 12 })], [/departure.*end|离港结束/iu, fixture.at({ days: 27, hours: 14 })]]) await keyboardFill(mobilePage, await visibleField(mobilePage, [pattern]), value);
    const linkedCreate = await keyboardMutation(mobilePage, ["button", "link"], [/create.*linked|create.*call|创建联动|创建港口调用/iu], /^\/api\/v1\/port-calls$/u);
    ctx.equal(linkedCreate.status(), 201, "keyboard linked create");
    const linked = assertPortCall(await linkedCreate.json(), { final: true });
    const arrival = linked.movements.find(({ type }) => type === "ARRIVAL");
    const departure = linked.movements.find(({ type }) => type === "DEPARTURE");
    ctx.equal((await keyboardMutation(mobilePage, ["button", "link"], [/confirm.*arrival|arrival.*confirm|确认.*到港|到港.*确认/iu], new RegExp(`^/api/v1/port-calls/${linked.portCallId}/movements/${arrival.movementId}/confirm$`, "u"))).status(), 200, "keyboard linked ARRIVAL confirm");
    await waitForMovementState(ctx, api.baseUrl, arrival.movementId, "CLEARED", [worker]);
    await mobilePage.reload({ waitUntil: "networkidle" });
    ctx.equal((await keyboardMutation(mobilePage, ["button", "link"], [/cancel.*departure|departure.*cancel|取消.*离港|离港.*取消/iu], new RegExp(`^/api/v1/port-calls/${linked.portCallId}/movements/${departure.movementId}/cancel$`, "u"))).status(), 200, "keyboard linked DEPARTURE cancel");

    for (const [page, viewport] of [[desktopPage, { width: 1280, height: 800 }], [mobilePage, { width: 390, height: 844 }]]) {
      await page.reload({ waitUntil: "networkidle" });
      const interactive = page.locator("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      const count = await interactive.count(); ctx.ok(count >= 5, "primary semantic controls exist");
      for (let index = 0; index < Math.min(count, 20); index += 1) { await page.keyboard.press("Tab"); const focused = page.locator(":focus"); ctx.ok(await focused.count() === 1, "Tab establishes focus"); const name = await focused.getAttribute("aria-label") ?? await focused.getAttribute("name") ?? await focused.innerText().catch(() => ""); ctx.ok(String(name).trim().length > 0, "focused control has accessible name"); const box = await focused.boundingBox(); if (box) ctx.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, "focused action reachable in viewport"); }
      const text = page.locator("body"); const colors = await text.evaluate((element) => { const style = getComputedStyle(element); return [style.color, style.backgroundColor]; }); const foreground = rgb(colors[0]); const background = rgb(colors[1]); if (foreground && background) { const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a); ctx.ok((light + 0.05) / (dark + 0.05) >= 4.5, "body text WCAG AA contrast"); }
    }
    const validationField = await visibleField(mobilePage, [/vessel|船舶/iu]); await validationField.focus(); await mobilePage.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A"); await mobilePage.keyboard.press("Backspace"); const submit = await visibleControl(mobilePage, ["button"], [/create|submit|创建|提交/iu]); await submit.focus(); await mobilePage.keyboard.press("Enter"); ctx.ok(await mobilePage.getByRole("alert").count() > 0 || await mobilePage.locator(":focus:invalid").count() > 0 || await mobilePage.getByText(/required|invalid|必填|无效/iu).count() > 0, "keyboard validation feedback visible and actionable");
    const snapshot = await ctx.snapshot(api.baseUrl); ctx.equal(snapshot.resources.portCalls.find(({ portCallId }) => portCallId === call.portCallId).state, "COMPLETED", "keyboard V1 flow persisted"); ctx.equal(snapshot.resources.portMovements.find(({ movementId }) => movementId === departure.movementId).state, "CANCELLED", "keyboard linked flow persisted"); return finalEvidence(ctx, { viewports: ["desktop", "mobile"], keyboardOnly: true, v1PortCallId: call.portCallId, linkedPortCallId: linked.portCallId });
  },
});

const D06 = defineCase({
  id: "D-06", fixtureFamily: "DC-F-EMPTY",
  action: "Run every published project verification command from clean state, then repeat stateful and browser gates with deliberately invalid PostgreSQL or Chromium infrastructure to prove failures are not swallowed.",
  oracle: "Unit, real PostgreSQL integration, production Chromium E2E, two-process concurrency, barrier recovery and aggregate gates run nonzero work and exit correctly, while broken infrastructure forces a nonzero exit.",
  async run(ctx) {
    const target = ctx.forWorkspace(ctx.workspace); await target.migrate(); await target.npm("build"); const commands = ["test:unit", "test:integration", "test:e2e", "test:concurrency", "test:recovery", "test:all"]; const evidence = []; for (const command of commands) { const result = await target.npm(command); ctx.ok(`${result.stdout}${result.stderr}`.trim().length > 0, `${command} reports executed work`); evidence.push({ command, durationMs: result.durationMs ?? null }); } await assert.rejects(target.npm("test:integration", [], { env: { TEST_DATABASE_URL: "postgresql://127.0.0.1:1/unreachable" } })); await assert.rejects(target.npm("test:e2e", [], { env: { CHROMIUM_PATH: ctx.tempPath("missing-chromium") } })); return finalEvidence(ctx, { commands: evidence, negativeControls: 2 });
  },
});

const D07 = defineCase({
  id: "D-07", fixtureFamily: "DC-F-BROWSER",
  action: "Execute a frozen requirement ledger across V1 and linked create, lifecycle, OpenAPI, production UI refresh, schedule, public event query and one FINAL point-in-time snapshot.",
  oracle: "Every applicable README node has actual HTTP, OpenAPI, visible UI and durable snapshot, Work or Event evidence; test names and file presence do not count, while all five SPEC-GAP nodes remain diagnostic only.",
  async run(ctx) {
    const fixture = ctx.fixtures.browser(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const worker = await startDockWorker(target); const openapi = expectSuccess(ctx, await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI evidence"); const call = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("ledger", { arrivalAt: fixture.at({ days: 25 }), departureAt: fixture.at({ days: 25, hours: 2 }) }), { final: true }); await confirmPortCall(ctx, api.baseUrl, call.portCallId, { final: true }); await waitForCallState(ctx, api.baseUrl, call.portCallId, "CLEARED", [worker]); const linkedBody = fixture.linkedPayload("ledger"); linkedBody.arrival.startAt = fixture.at({ days: 26, hours: 8 }); linkedBody.arrival.endAt = fixture.at({ days: 26, hours: 10 }); linkedBody.departure.startAt = fixture.at({ days: 26, hours: 12 }); linkedBody.departure.endAt = fixture.at({ days: 26, hours: 14 }); const linked = await createPortCall(ctx, api.baseUrl, linkedBody, { final: true }); const arrival = linked.movements.find(({ type }) => type === "ARRIVAL"); await movementAction(ctx, api.baseUrl, linked.portCallId, arrival.movementId, "confirm"); await waitForMovementState(ctx, api.baseUrl, arrival.movementId, "CLEARED", [worker]); const detail = await getPortCall(ctx, api.baseUrl, linked.portCallId, { final: true }); const eventPage = expectSuccess(ctx, await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${call.portCallId}&afterSequence=0&limit=100`), "event evidence"); const events = eventPage.items ?? eventPage; const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl)); const { page } = await launchBrowser(ctx, api.baseUrl); const observed = await publicRequests(page);

    const callListIdentityVisible = await page.getByText(identityPattern(call.portCallId)).count() > 0; ctx.ok(callListIdentityVisible, "Call list shows exact V1 identity");
    await (await visibleControl(page, ["button", "link", "tab"], [/schedule|资源日程|调度/iu])).click();
    const scheduleIdentityVisible = await page.getByText(identityPattern(call.portCallId)).count() > 0; ctx.ok(scheduleIdentityVisible, "schedule shows the occupied V1 Call identity");
    await (await visibleControl(page, ["button", "link", "tab"], [/linked|movements|联动|进出港/iu])).click();
    const linkedIdentityVisible = await page.getByText(identityPattern(linked.portCallId)).count() > 0; ctx.ok(linkedIdentityVisible, "linked view shows exact Port Call identity"); const visibleMovements = new Set();
    for (const movement of detail.movements) { const movementVisible = await page.getByText(identityPattern(movement.movementId)).count() > 0; ctx.ok(movementVisible, `${movement.type} identity visible`); if (movementVisible) visibleMovements.add(movement.movementId); ctx.ok(await page.getByText(new RegExp(movement.type, "iu")).count() > 0, `${movement.type} label visible`); }
    await (await visibleControl(page, ["button", "link", "tab"], [/event|history|事件|历史/iu])).click();
    const visibleEvents = new Set(); for (const event of events) { const eventVisible = await page.getByText(identityPattern(event.eventId)).count() > 0; ctx.ok(eventVisible, `Event ${event.sequence} identity visible`); if (eventVisible) visibleEvents.add(event.eventId); ctx.ok(await page.getByText(new RegExp(event.type.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu")).count() > 0, `Event ${event.sequence} type visible`); }

    const callWork = snapshot.work.filter(({ aggregateId }) => aggregateId === call.portCallId);
    const movementWork = snapshot.work.filter(({ aggregateId }) => [linked.portCallId, arrival.movementId].includes(aggregateId));
    const ledger = [
      { requirement: "V1 create, schedule and clearance", nodes: { httpIdentity: (await getPortCall(ctx, api.baseUrl, call.portCallId, { final: true })).portCallId === call.portCallId, openapi: Boolean(openapi.paths?.["/api/v1/port-calls"]?.post && openapi.paths?.["/api/v1/port-resources/schedule"]?.get), uiIdentity: callListIdentityVisible && scheduleIdentityVisible, durableResource: snapshot.resources.portCalls.some(({ portCallId }) => portCallId === call.portCallId), durableWork: callWork.some(({ kind, terminal }) => kind === "CLEARANCE" && terminal), durableEvent: events.some(({ aggregateId }) => aggregateId === call.portCallId) } },
      { requirement: "linked movements and Clearance", nodes: { httpIdentity: detail.portCallId === linked.portCallId && detail.movements.map(({ movementId }) => movementId).includes(arrival.movementId), openapi: Boolean(openapi.paths?.["/api/v1/port-calls/{portCallId}/movements/{movementId}/confirm"]?.post), uiIdentity: linkedIdentityVisible && detail.movements.every(({ movementId }) => visibleMovements.has(movementId)), durableResource: detail.movements.every(({ movementId }) => snapshot.resources.portMovements.some((item) => item.movementId === movementId)), durableWork: movementWork.some(({ kind, terminal }) => kind === "CLEARANCE" && terminal), durableEvent: snapshot.events.some(({ aggregateId }) => [linked.portCallId, arrival.movementId].includes(aggregateId)) } },
      { requirement: "event query and visible history", nodes: { httpIdentity: events.length > 0 && events.every(({ aggregateId }) => aggregateId === call.portCallId), openapi: Boolean(openapi.paths?.["/api/v1/domain-events"]?.get), uiIdentity: events.every(({ eventId }) => visibleEvents.has(eventId)), durableEvent: events.every(({ eventId }) => snapshot.events.some((item) => item.eventId === eventId)) } },
    ];
    ctx.ok(ledger.every(({ nodes }) => Object.values(nodes).every(Boolean)), "identity-specific README evidence ledger closes"); ctx.ok(observed.every(({ path }) => !/(?:verification-snapshot|internal|private|admin)/iu.test(path)), "ledger UI uses only public routes"); return ctx.pass({ evidence: [{ kind: "dockchain-requirement-ledger", ledger, identities: { portCallId: call.portCallId, linkedPortCallId: linked.portCallId, movementIds: detail.movements.map(({ movementId }) => movementId), eventIds: events.map(({ eventId }) => eventId) }, specGaps: ["SPEC-GAP-01", "SPEC-GAP-02", "SPEC-GAP-03", "SPEC-GAP-04", "SPEC-GAP-05"], policy: "diagnostic-not-scored" }] });
  },
});

export const D_CASES = Object.freeze([D01, D02, D03, D04, D05, D06, D07]);
