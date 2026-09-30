import assert from "node:assert/strict";

import {
  assertError,
  assertEvent,
  assertHold,
  assertOrder,
  assertPage,
  assertWaitlistEntry,
  canonical,
} from "../lib/oracle.mjs";

export const correctnessCap = { hardCapIds: ["CORRECTNESS_INVARIANT"] };

export function result(evidence = []) {
  return { evidence };
}

export async function seedAndStart(ctx, seed, options = {}) {
  await ctx.seed(seed, options.seed);
  return ctx.startApi(options.api);
}

export async function getEvent(ctx, baseUrl, eventId) {
  const response = await ctx.request(baseUrl, `/api/events/${eventId}`);
  ctx.equal("event detail returns 200", response.status, 200);
  ctx.assert("event detail uses the public envelope", () => assertEvent(response.json.event));
  return response.json.event;
}

export async function getHold(ctx, baseUrl, holdId) {
  const response = await ctx.request(baseUrl, `/api/holds/${holdId}`);
  ctx.equal("hold detail returns 200", response.status, 200);
  ctx.assert("hold detail uses the public envelope", () => assertHold(response.json.hold));
  return response.json.hold;
}

export async function getHistory(ctx, baseUrl, customerId, resource, query = "limit=100") {
  const response = await ctx.request(baseUrl, `/api/customers/${customerId}/${resource}?${query}`);
  ctx.assert(`${resource} history uses the public page shape`, () => assertPage(
    response,
    resource === "holds" ? assertHold : assertOrder,
  ));
  return response.json;
}

export function assertPublicError(ctx, label, response, status, code) {
  ctx.assert(label, () => assertError(response, status, code));
}

export function assertSafeError(ctx, label, response, statuses) {
  ctx.assert(label, () => {
    assert.ok(statuses.includes(response.status), `expected one of ${statuses.join(",")}, got ${response.status}`);
    assert.deepEqual(Object.keys(response.json ?? {}), ["error"]);
    assert.equal(typeof response.json.error?.code, "string");
    assert.equal(typeof response.json.error?.message, "string");
    assert.ok(Array.isArray(response.json.error?.details));
    assert.doesNotMatch(response.text, /postgres(?:ql)?:\/\/|select\s|insert\s|\/Users\/|\/workspace\/|admin[_-]?token/iu);
  });
}

export function assertEventEnvelope(ctx, label, response, expected = {}) {
  ctx.equal(`${label} status`, response.status, 201);
  ctx.assert(`${label} exact event envelope`, () => {
    assert.deepEqual(Object.keys(response.json), ["event"]);
    assertEvent(response.json.event, expected);
  });
  return response.json.event;
}

export function assertHoldEnvelope(ctx, label, response, expected = {}) {
  ctx.equal(`${label} status`, response.status, 201);
  ctx.assert(`${label} exact hold envelope`, () => {
    assert.deepEqual(Object.keys(response.json), ["hold"]);
    assertHold(response.json.hold, expected);
  });
  return response.json.hold;
}

export function assertWaitlistEnvelope(ctx, label, response, expected = {}, status = 201) {
  ctx.equal(`${label} status`, response.status, status);
  ctx.assert(`${label} exact waitlist envelope`, () => {
    assert.deepEqual(Object.keys(response.json), ["waitlistEntry"]);
    assertWaitlistEntry(response.json.waitlistEntry, expected);
  });
  return response.json.waitlistEntry;
}

export function assertReplay(ctx, label, response, expected) {
  ctx.equal(`${label} status replay`, response.status, expected.status);
  ctx.equal(`${label} body replay`, canonical(response.json), canonical(expected.json));
}

export async function waitForWaitlist(ctx, baseUrl, eventId, customerId, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const response = await ctx.getWaitlist(baseUrl, eventId, customerId);
    if (response.status < 200 || response.status >= 300) return false;
    return predicate(response.json.waitlistEntry) ? response : false;
  }, { timeoutMs: options.timeoutMs ?? 10_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "waitlist state" });
}

export async function waitForHold(ctx, baseUrl, holdId, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const response = await ctx.request(baseUrl, `/api/holds/${holdId}`);
    if (response.status !== 200) return false;
    return predicate(response.json.hold) ? response : false;
  }, { timeoutMs: options.timeoutMs ?? 10_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "hold state" });
}
