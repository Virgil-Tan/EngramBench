import assert from "node:assert/strict";

import { seedFixture } from "../lib/fixtures.mjs";
import {
  assertError,
  assertEvent,
  assertHold,
  assertOrder,
  assertPage,
  assertWaitlistEntry,
  eventComparator,
} from "../lib/oracle.mjs";
import {
  assertEventEnvelope,
  assertHoldEnvelope,
  assertPublicError,
  assertSafeError,
  correctnessCap,
  getEvent,
  getHistory,
  getHold,
  result,
  waitForHold,
  waitForWaitlist,
} from "./helpers.mjs";

const desktop = { width: 1280, height: 800 };
const mobile = { width: 390, height: 844 };

export function parseOpenApi(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripYamlComment(rawLine);
    if (!line.trim() || /^\s*(?:---|\.\.\.)\s*$/u.test(line)) continue;
    const indent = line.match(/^ */u)[0].length;
    const content = line.slice(indent);
    if (content.startsWith("- ")) continue;
    const separator = yamlSeparator(content);
    if (separator < 0) continue;
    const key = unquoteYaml(content.slice(0, separator).trim());
    const rawValue = content.slice(separator + 1).trim();
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    const value = rawValue === "" ? {} : yamlScalar(rawValue);
    parent[key] = value;
    if (value && typeof value === "object" && !Array.isArray(value)) stack.push({ indent, value });
  }
  return root;
}

function stripYamlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote && line[index - 1] !== "\\") quote = null;
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === "#" && (index === 0 || /\s/u.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function yamlSeparator(value) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
    else if (character === ":" && depth === 0) return index;
  }
  return -1;
}

function unquoteYaml(value) {
  if (value.startsWith("\"") && value.endsWith("\"")) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function yamlScalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return unquoteYaml(value);
  if (value.startsWith("[") && value.endsWith("]")) return splitYamlFlow(value.slice(1, -1)).map(yamlScalar);
  if (value.startsWith("{") && value.endsWith("}")) {
    return Object.fromEntries(splitYamlFlow(value.slice(1, -1)).map((part) => {
      const separator = yamlSeparator(part);
      return [unquoteYaml(part.slice(0, separator).trim()), yamlScalar(part.slice(separator + 1).trim())];
    }));
  }
  return value;
}

function splitYamlFlow(value) {
  const parts = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function exactText(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

async function visible(...locators) {
  for (const locator of locators) {
    if (await locator.count() > 0 && await locator.first().isVisible()) return locator.first();
  }
  throw new Error("required accessible control is not visible");
}

async function setCustomer(page, customerId) {
  const input = await visible(
    page.getByLabel(/customer(?:\s+id|\s+uuid)?/iu),
    page.getByRole("textbox", { name: /customer/iu }),
  );
  await input.fill(customerId);
  await input.press("Tab");
  return input;
}

async function searchAndOpen(page, title) {
  const search = await visible(
    page.getByRole("searchbox"),
    page.getByLabel(/search(?:\s+events)?/iu),
    page.getByRole("textbox", { name: /search/iu }),
  );
  await search.fill(title);
  await search.press("Enter");
  const eventControl = await visible(
    page.getByRole("link", { name: exactText(title) }),
    page.getByRole("button", { name: exactText(title) }),
    page.getByText(title, { exact: true }),
  );
  await eventControl.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: exactText(title) }).waitFor();
}

async function setQuantity(page, quantity) {
  const input = await visible(
    page.getByLabel(/quantity|places|tickets/iu),
    page.getByRole("spinbutton"),
  );
  await input.fill(String(quantity));
  return input;
}

async function activate(page, name) {
  const button = await visible(page.getByRole("button", { name }));
  await button.focus();
  assert.equal(await button.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  return button;
}

async function openEvent(page, customerId, event) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await setCustomer(page, customerId);
  await searchAndOpen(page, event.title);
}

async function createHoldInBrowser(ctx, page, api, event, customer, quantity) {
  await openEvent(page, customer.id, event);
  await setQuantity(page, quantity);
  await activate(page, /create.*hold|reserve|hold.*places/iu);
  const pageResult = await ctx.waitFor(async () => {
    const history = await ctx.request(api.baseUrl, `/api/customers/${customer.id}/holds?limit=100`);
    const hold = history.json?.items?.find((item) => item.eventId === event.id && item.quantity === quantity);
    return hold?.status === "PENDING" ? hold : false;
  }, { timeoutMs: 10_000, label: "browser-created pending hold" });
  await page.getByText(/PENDING/iu).first().waitFor();
  return pageResult;
}

async function exerciseEventPagination(page, expectedTitle) {
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    if (await page.getByText(expectedTitle, { exact: true }).count() > 0) return;
    const control = await visible(
      page.getByRole("button", { name: /load more|next/iu }),
      page.getByRole("link", { name: /next/iu }),
    );
    await control.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
  }
  throw new Error("browser cursor pagination did not expose the next event page");
}

async function d01(ctx) {
  const events = [ctx.event("browser-confirm-desktop", { capacity: 4 }), ctx.event("browser-confirm-mobile", { capacity: 4 })];
  const fillerEvents = Array.from({ length: 25 }, (_, index) => ctx.event(`browser-page-${index}`, { capacity: 4 }));
  const customers = [ctx.customer("browser-confirm-desktop"), ctx.customer("browser-confirm-mobile")];
  await ctx.seed(seedFixture([...events, ...fillerEvents], customers));
  const api = await ctx.startApi({ ttl: 120 });

  for (const [index, viewport] of [desktop, mobile].entries()) {
    await ctx.withPage(api, viewport, async (page) => {
      if (index === 0) {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await setCustomer(page, customers[index].id);
        const ordered = [...events, ...fillerEvents].sort(eventComparator);
        await exerciseEventPagination(page, ordered[20].title);
      }
      const hold = await createHoldInBrowser(ctx, page, api, events[index], customers[index], 2);
      ctx.equal(`browser ${viewport.width}px hold reserves capacity`, (await getEvent(ctx, api.baseUrl, events[index].id)).availableCapacity, 2, correctnessCap);
      await activate(page, /confirm/iu);
      const confirmed = await ctx.waitFor(async () => {
        const response = await ctx.request(api.baseUrl, `/api/holds/${hold.id}`);
        return response.json?.hold?.status === "CONFIRMED" ? response.json.hold : false;
      }, { timeoutMs: 10_000, label: "browser confirmation" });
      ctx.equal(`browser ${viewport.width}px confirms the public hold`, confirmed.status, "CONFIRMED");
      const orders = await getHistory(ctx, api.baseUrl, customers[index].id, "orders");
      ctx.equal(`browser ${viewport.width}px creates one order`, orders.items.filter(({ holdId }) => hold.id).length, 1, correctnessCap);
      await page.getByText(/CONFIRMED|order/iu).first().waitFor();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText(/CONFIRMED|order/iu).first().waitFor();
      ctx.ok(`browser ${viewport.width}px has a meaningful live status region`, await page.getByRole("status").count() > 0);
      const body = await page.content();
      ctx.ok(`browser ${viewport.width}px never renders ADMIN_TOKEN`, !body.includes(ctx.adminToken));
    });
  }
  return result(["desktop and mobile production Chromium completed browse, hold, confirm, order, and refresh"]);
}

async function d02(ctx) {
  const events = [
    ctx.event("browser-release", { capacity: 3 }),
    ctx.event("browser-expire", { capacity: 3 }),
    ctx.event("browser-refresh", { capacity: 3 }),
  ];
  const customers = events.map((_, index) => ctx.customer(`browser-terminal-${index}`));
  await ctx.seed(seedFixture(events, customers));
  const api = await ctx.startApi({ ttl: 2 });

  await ctx.withPage(api, mobile, async (page) => {
    const hold = await createHoldInBrowser(ctx, page, api, events[0], customers[0], 2);
    await activate(page, /release|cancel.*hold/iu);
    const released = await waitForHold(ctx, api.baseUrl, hold.id, (value) => value.status === "RELEASED");
    ctx.equal("browser release commits server state", released.json.hold.status, "RELEASED");
    await page.getByText(/RELEASED|released|capacity.*restored/iu).first().waitFor();
    ctx.equal("browser release restores server capacity", (await getEvent(ctx, api.baseUrl, events[0].id)).availableCapacity, 3, correctnessCap);
  });

  await ctx.withPage(api, desktop, async (page) => {
    const hold = await createHoldInBrowser(ctx, page, api, events[1], customers[1], 1);
    await waitForHold(ctx, api.baseUrl, hold.id, (value) => value.status === "EXPIRED", { timeoutMs: 6_000 });
    await page.getByText(/EXPIRED|expired/iu).first().waitFor({ timeout: 6_000 });
    ctx.equal("browser passive expiry reflects restored server capacity", (await getEvent(ctx, api.baseUrl, events[1].id)).availableCapacity, 3, correctnessCap);
  });

  const refreshApi = api;
  await ctx.withPage(refreshApi, mobile, async (page) => {
    const hold = await createHoldInBrowser(ctx, page, refreshApi, events[2], customers[2], 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(/PENDING/iu).first().waitFor();
    await activate(page, /confirm/iu);
    await waitForHold(ctx, refreshApi.baseUrl, hold.id, (value) => value.status === "CONFIRMED");
    await page.getByText(/CONFIRMED|order/iu).first().waitFor();
  });
  return result(["production Chromium released, passively expired, and refreshed a known pending hold"]);
}

async function d03(ctx) {
  const withdrawEvent = ctx.event("browser-waitlist-withdraw", { capacity: 1 });
  const promoteEvent = ctx.event("browser-waitlist-promote", { capacity: 4 });
  const owners = [
    ctx.customer("browser-owner-withdraw"),
    ctx.customer("browser-owner-promote-a"),
    ctx.customer("browser-owner-promote-b"),
  ];
  const waiters = [
    ctx.customer("browser-waiter-withdraw"),
    ctx.customer("browser-waiter-promote-head"),
    ctx.customer("browser-waiter-promote-tail"),
  ];
  await ctx.seed(seedFixture([withdrawEvent, promoteEvent], [...owners, ...waiters]));
  const api = await ctx.startApi({ ttl: 120, waitlistTtl: 10 });
  const sourceOne = assertHoldEnvelope(ctx, "browser waitlist source one", await ctx.createHold(api.baseUrl, {
    eventId: withdrawEvent.id, customerId: owners[0].id, quantity: 1,
  }));
  const sourceTwo = assertHoldEnvelope(ctx, "browser waitlist source two", await ctx.createHold(api.baseUrl, {
    eventId: promoteEvent.id, customerId: owners[1].id, quantity: 2,
  }));
  const sourceThree = assertHoldEnvelope(ctx, "browser waitlist source three", await ctx.createHold(api.baseUrl, {
    eventId: promoteEvent.id, customerId: owners[2].id, quantity: 2,
  }));

  await ctx.withPage(api, mobile, async (page) => {
    await openEvent(page, waiters[0].id, withdrawEvent);
    await setQuantity(page, 1);
    await activate(page, /create.*hold|reserve|hold.*places/iu);
    await activate(page, /join.*waitlist|waitlist/iu);
    const waiting = await waitForWaitlist(ctx, api.baseUrl, withdrawEvent.id, waiters[0].id, (entry) => entry.status === "WAITING");
    ctx.equal("browser displays public 1-based position", waiting.json.waitlistEntry.position, 1);
    await page.getByText(/WAITING/iu).first().waitFor();
    await page.getByText(/position\s*1|#\s*1/iu).first().waitFor();
    await activate(page, /exit.*waitlist|withdraw|leave.*waitlist/iu);
    const withdrawn = await waitForWaitlist(ctx, api.baseUrl, withdrawEvent.id, waiters[0].id, (entry) => entry.status === "WITHDRAWN");
    ctx.equal("browser withdrawal clears position", withdrawn.json.waitlistEntry.position, null);
    await page.getByText(/WITHDRAWN|withdrawn|left.*waitlist/iu).first().waitFor();
  });

  await ctx.withPage(api, desktop, async (page) => {
    await openEvent(page, waiters[1].id, promoteEvent);
    await setQuantity(page, 3);
    await activate(page, /create.*hold|reserve|hold.*places/iu);
    await activate(page, /join.*waitlist|waitlist/iu);
    const head = await waitForWaitlist(ctx, api.baseUrl, promoteEvent.id, waiters[1].id, (entry) => entry.status === "WAITING");
    ctx.equal("browser FIFO head starts at position one", head.json.waitlistEntry.position, 1);
    const tail = await ctx.joinWaitlist(api.baseUrl, promoteEvent.id, waiters[2].id, 1);
    ctx.equal("browser FIFO tail joins behind head", tail.json.waitlistEntry.position, 2);
    await ctx.release(api.baseUrl, sourceTwo.id);
    await ctx.sleep(300);
    const blockedHead = await ctx.getWaitlist(api.baseUrl, promoteEvent.id, waiters[1].id);
    const blockedTail = await ctx.getWaitlist(api.baseUrl, promoteEvent.id, waiters[2].id);
    ctx.equal("browser still shows a blocked FIFO head", blockedHead.json.waitlistEntry.status, "WAITING");
    ctx.equal("browser flow does not bypass the smaller tail", blockedTail.json.waitlistEntry.status, "WAITING", correctnessCap);
    await page.getByText(/WAITING/iu).first().waitFor();
    await page.getByText(/position\s*1|#\s*1/iu).first().waitFor();
    await ctx.release(api.baseUrl, sourceThree.id);
    const promoted = await waitForWaitlist(ctx, api.baseUrl, promoteEvent.id, waiters[1].id, (entry) => entry.status === "PROMOTED");
    await waitForWaitlist(ctx, api.baseUrl, promoteEvent.id, waiters[2].id, (entry) => entry.status === "PROMOTED");
    await page.getByText(/PROMOTED|PENDING/iu).first().waitFor({ timeout: 10_000 });
    await activate(page, /confirm/iu);
    await waitForHold(ctx, api.baseUrl, promoted.json.waitlistEntry.holdId, (hold) => hold.status === "CONFIRMED");
    await page.getByText(/CONFIRMED|order/iu).first().waitFor();
  });
  ctx.equal("withdrawn browser entry never promotes", (await ctx.getWaitlist(api.baseUrl, withdrawEvent.id, waiters[0].id)).json.waitlistEntry.status, "WITHDRAWN", correctnessCap);
  await ctx.release(api.baseUrl, sourceOne.id);
  await ctx.sleep(250);
  ctx.equal("withdrawn entry remains unpromoted after capacity release", (await ctx.getWaitlist(api.baseUrl, withdrawEvent.id, waiters[0].id)).json.waitlistEntry.status, "WITHDRAWN", correctnessCap);
  return result(["production Chromium joined, showed position, withdrew, observed promotion, and confirmed its linked hold"]);
}

function operation(document, path, method) {
  const value = document.paths?.[path]?.[method.toLowerCase()];
  assert.ok(value, `OpenAPI is missing ${method.toUpperCase()} ${path}`);
  return value;
}

function resolveSchema(document, schema) {
  if (!schema?.$ref) return schema;
  const parts = schema.$ref.replace(/^#\//u, "").split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  return parts.reduce((value, part) => value?.[part], document);
}

function assertClosedObjects(document, schema, seen = new Set()) {
  schema = resolveSchema(document, schema);
  if (!schema || typeof schema !== "object" || seen.has(schema)) return;
  seen.add(schema);
  if (schema.type === "object" || schema.properties) {
    assert.ok(schema.additionalProperties === false || schema.unevaluatedProperties === false, "OpenAPI public object schema must be closed");
    for (const child of Object.values(schema.properties ?? {})) assertClosedObjects(document, child, seen);
  }
  if (schema.items) assertClosedObjects(document, schema.items, seen);
  for (const child of schema.allOf ?? []) assertClosedObjects(document, child, seen);
  for (const child of schema.oneOf ?? []) assertClosedObjects(document, child, seen);
}

function assertResponseDocumented(document, path, method, response) {
  const selected = operation(document, path, method).responses?.[String(response.status)];
  assert.ok(selected, `OpenAPI does not publish observed ${response.status} for ${method.toUpperCase()} ${path}`);
  const schema = selected.content?.["application/json"]?.schema;
  if (response.text) {
    assert.ok(schema, `OpenAPI response ${response.status} has no application/json schema`);
    assertClosedObjects(document, schema);
  }
}

async function d04(ctx) {
  const openapiText = await ctx.readOpenApi();
  const document = parseOpenApi(openapiText);
  ctx.equal("OpenAPI version is exactly 3.1.0", document.openapi, "3.1.0");
  const routes = [
    ["/api/health", "get"],
    ["/api/admin/events", "post"],
    ["/api/events", "get"],
    ["/api/events/{eventId}", "get"],
    ["/api/holds", "post"],
    ["/api/holds/{holdId}", "get"],
    ["/api/holds/{holdId}/confirm", "post"],
    ["/api/holds/{holdId}", "delete"],
    ["/api/customers/{customerId}/holds", "get"],
    ["/api/customers/{customerId}/orders", "get"],
    ["/api/events/{eventId}/waitlist", "post"],
    ["/api/events/{eventId}/waitlist/{customerId}", "get"],
    ["/api/events/{eventId}/waitlist/{customerId}", "delete"],
  ];
  ctx.assert("OpenAPI declares every public operation", () => routes.forEach(([path, method]) => operation(document, path, method)));
  ctx.assert("OpenAPI mutation requests and responses use closed object schemas", () => {
    for (const [path, method] of routes) {
      const selected = operation(document, path, method);
      const requestSchema = selected.requestBody?.content?.["application/json"]?.schema;
      if (requestSchema) assertClosedObjects(document, requestSchema);
      for (const response of Object.values(selected.responses ?? {})) {
        const schema = response.content?.["application/json"]?.schema;
        if (schema) assertClosedObjects(document, schema);
      }
    }
  });

  const event = ctx.event("openapi-runtime", { capacity: 2 });
  const lifecycleEvent = ctx.event("openapi-lifecycle", { capacity: 3 });
  const adminEvent = ctx.event("openapi-admin-create", { capacity: 7 });
  const owner = ctx.customer("openapi-owner");
  const waiter = ctx.customer("openapi-waiter");
  const lifecycleCustomer = ctx.customer("openapi-lifecycle");
  await ctx.seed(seedFixture([event, lifecycleEvent], [owner, waiter, lifecycleCustomer]));
  const api = await ctx.startApi({ ttl: 120, waitlistTtl: 60 });
  const health = await ctx.request(api.baseUrl, "/api/health");
  ctx.equal("health exact body", JSON.stringify(health.json), JSON.stringify({ status: "ok" }));
  const createdEvent = await ctx.createEvent(api.baseUrl, adminEvent);
  assertEventEnvelope(ctx, "OpenAPI runtime event create", createdEvent, { slug: adminEvent.slug, capacity: 7 });
  const eventList = await ctx.request(api.baseUrl, "/api/events?limit=100");
  ctx.assert("OpenAPI runtime event list exact page", () => assertPage(eventList, assertEvent));
  const eventDetail = await ctx.request(api.baseUrl, `/api/events/${event.id}`);
  ctx.equal("OpenAPI runtime event detail status", eventDetail.status, 200);
  ctx.assert("OpenAPI runtime event detail exact envelope", () => {
    assert.deepEqual(Object.keys(eventDetail.json), ["event"]);
    assertEvent(eventDetail.json.event, { id: event.id });
  });

  const hold = await ctx.createHold(api.baseUrl, { eventId: event.id, customerId: owner.id, quantity: 2 });
  assertHoldEnvelope(ctx, "OpenAPI runtime hold", hold);
  const holdDetail = await ctx.request(api.baseUrl, `/api/holds/${hold.json.hold.id}`);
  ctx.equal("OpenAPI runtime hold detail status", holdDetail.status, 200);
  ctx.assert("OpenAPI runtime hold detail exact envelope", () => {
    assert.deepEqual(Object.keys(holdDetail.json), ["hold"]);
    assertHold(holdDetail.json.hold, { id: hold.json.hold.id });
  });

  const confirmSource = await ctx.createHold(api.baseUrl, { eventId: lifecycleEvent.id, customerId: lifecycleCustomer.id, quantity: 1 });
  assertHoldEnvelope(ctx, "OpenAPI runtime confirm source", confirmSource);
  const confirmed = await ctx.confirm(api.baseUrl, confirmSource.json.hold.id);
  ctx.equal("OpenAPI runtime confirm status", confirmed.status, 200);
  ctx.assert("OpenAPI runtime confirm exact shape", () => {
    assert.deepEqual(Object.keys(confirmed.json).sort(), ["hold", "order"]);
    assertHold(confirmed.json.hold, { status: "CONFIRMED" });
    assertOrder(confirmed.json.order, { holdId: confirmSource.json.hold.id });
  });
  const releaseSource = await ctx.createHold(api.baseUrl, { eventId: lifecycleEvent.id, customerId: lifecycleCustomer.id, quantity: 1 });
  assertHoldEnvelope(ctx, "OpenAPI runtime release source", releaseSource);
  const released = await ctx.release(api.baseUrl, releaseSource.json.hold.id);
  ctx.equal("OpenAPI runtime release status", released.status, 200);
  ctx.assert("OpenAPI runtime release exact shape", () => {
    assert.deepEqual(Object.keys(released.json), ["hold"]);
    assertHold(released.json.hold, { status: "RELEASED" });
  });
  const holdHistory = await ctx.request(api.baseUrl, `/api/customers/${lifecycleCustomer.id}/holds?limit=100`);
  const orderHistory = await ctx.request(api.baseUrl, `/api/customers/${lifecycleCustomer.id}/orders?limit=100`);
  ctx.assert("OpenAPI runtime hold history exact page", () => assertPage(holdHistory, assertHold));
  ctx.assert("OpenAPI runtime order history exact page", () => assertPage(orderHistory, assertOrder));

  const joined = await ctx.joinWaitlist(api.baseUrl, event.id, waiter.id, 1);
  ctx.equal("OpenAPI runtime waitlist POST status", joined.status, 201);
  ctx.assert("OpenAPI runtime waitlist POST exact envelope", () => assertWaitlistEntry(joined.json.waitlistEntry, { status: "WAITING", position: 1 }));
  const waitGet = await ctx.getWaitlist(api.baseUrl, event.id, waiter.id);
  ctx.ok("waitlist GET runtime succeeds", waitGet.status >= 200 && waitGet.status < 300);
  ctx.assert("waitlist GET runtime exact envelope", () => assertWaitlistEntry(waitGet.json.waitlistEntry, { status: "WAITING", position: 1 }));
  ctx.blocked("openapi-waitlist-get-success-status", "LP-GAP-01");
  const waitDelete = await ctx.withdrawWaitlist(api.baseUrl, event.id, waiter.id);
  ctx.ok("waitlist DELETE runtime succeeds", waitDelete.status >= 200 && waitDelete.status < 300);
  ctx.assert("waitlist DELETE runtime exact envelope", () => assertWaitlistEntry(waitDelete.json.waitlistEntry, { status: "WITHDRAWN", position: null, holdId: null }));
  ctx.blocked("openapi-waitlist-delete-success-status", "LP-GAP-01");

  const malformed = await ctx.request(api.baseUrl, "/api/holds", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("malformed") }, raw: "{",
  });
  assertPublicError(ctx, "malformed JSON runtime contract", malformed, 400, "INVALID_JSON");
  const media = await ctx.request(api.baseUrl, "/api/holds", {
    method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("media") }, raw: "{}",
  });
  assertPublicError(ctx, "unsupported media runtime contract", media, 415, "UNSUPPORTED_MEDIA_TYPE");
  const invalid = await ctx.createHold(api.baseUrl, { eventId: event.id, customerId: owner.id, quantity: 5 });
  assertPublicError(ctx, "schema validation runtime contract", invalid, 422, "VALIDATION_ERROR");
  const cursor = await ctx.request(api.baseUrl, "/api/events?cursor=invalid");
  assertPublicError(ctx, "cursor runtime contract", cursor, 400, "INVALID_CURSOR");
  const unknown = await ctx.request(api.baseUrl, `/api/events/${ctx.uuid("openapi-unknown")}`);
  assertSafeError(ctx, "unknown resource runtime contract", unknown, [404]);

  const observations = [
    ["/api/health", "get", health],
    ["/api/admin/events", "post", createdEvent],
    ["/api/events", "get", eventList],
    ["/api/events/{eventId}", "get", eventDetail],
    ["/api/holds", "post", hold],
    ["/api/holds/{holdId}", "get", holdDetail],
    ["/api/holds", "post", confirmSource],
    ["/api/holds/{holdId}/confirm", "post", confirmed],
    ["/api/holds", "post", releaseSource],
    ["/api/holds/{holdId}", "delete", released],
    ["/api/customers/{customerId}/holds", "get", holdHistory],
    ["/api/customers/{customerId}/orders", "get", orderHistory],
    ["/api/events/{eventId}/waitlist", "post", joined],
    ["/api/events/{eventId}/waitlist/{customerId}", "get", waitGet],
    ["/api/events/{eventId}/waitlist/{customerId}", "delete", waitDelete],
    ["/api/holds", "post", malformed],
    ["/api/holds", "post", media],
    ["/api/holds", "post", invalid],
    ["/api/events", "get", cursor],
    ["/api/events/{eventId}", "get", unknown],
  ];
  ctx.assert("OpenAPI documents every observed runtime status and JSON shape", () => {
    for (const [path, method, response] of observations) assertResponseDocumented(document, path, method, response);
  });
  ctx.ok("OpenAPI contains no submitted administrator credential", !openapiText.includes(ctx.adminToken));
  return result(["OpenAPI 3.1 routes, closed schemas, and a live HTTP boundary matrix agreed"]);
}

export const D_CASES = [
  { id: "D-01", run: d01 },
  { id: "D-02", run: d02 },
  { id: "D-03", run: d03 },
  { id: "D-04", run: d04 },
];
