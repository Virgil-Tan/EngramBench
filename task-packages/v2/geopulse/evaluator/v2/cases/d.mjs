import Ajv2020 from "ajv/dist/2020.js";

import {
  FINAL_SNAPSHOT_RESOURCES,
  acceptEvent,
  assertEvents,
  assertWorkShape,
  canonicalJson,
  clickControl,
  coreFixture,
  createBundle,
  exactKeys,
  fillField,
  finalEvidence,
  guardedCase,
  launchBrowser,
  publishBundle,
  queryRegions,
  readBundle,
  resource,
  stableSnapshot,
  startPreparedApi,
  waitForDrain,
} from "./helpers.mjs";

const correctness = ["CORRECTNESS_INVARIANT"];

async function openSection(page, names) {
  for (const role of ["link", "button", "tab"]) {
    try { return await clickControl(page, role, names); }
    catch {}
  }
  throw new Error(`production UI has no section control for ${String(names)}`);
}

async function submitFor(page, urlPattern, action) {
  const responsePromise = page.waitForResponse((response) => urlPattern.test(new URL(response.url()).pathname) && response.request().method() === "POST", { timeout: 30_000 });
  await action();
  const response = await responsePromise;
  const body = await response.json().catch(() => undefined);
  if (response.status() !== 200) throw new Error(`UI mutation ${new URL(response.url()).pathname} returned ${response.status()}: ${JSON.stringify(body)}`);
  return body;
}

function localRef(openapi, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) throw new Error(`unsupported OpenAPI reference ${String(reference)}`);
  return reference.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], openapi);
}

function dereference(openapi, value, seen = new Set()) {
  if (Array.isArray(value)) return value.map((item) => dereference(openapi, item, seen));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    if (seen.has(value.$ref)) return {};
    return dereference(openapi, localRef(openapi, value.$ref), new Set([...seen, value.$ref]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dereference(openapi, item, seen)]));
}

function validateOpenApiResponse(openapi, path, method, status, body) {
  const operation = openapi.paths?.[path]?.[method.toLowerCase()];
  if (!operation) throw new Error(`OpenAPI misses ${method.toUpperCase()} ${path}`);
  const response = operation.responses?.[String(status)];
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`OpenAPI misses ${status} application/json schema for ${method.toUpperCase()} ${path}`);
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(dereference(openapi, schema));
  if (!validate(body)) throw new Error(`OpenAPI response mismatch for ${method.toUpperCase()} ${path}: ${ajv.errorsText(validate.errors)}`);
}

function sorted(items, fields) {
  return [...items].sort((left, right) => {
    for (const field of fields) {
      const leftValue = left[field];
      const rightValue = right[field];
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    }
    return 0;
  });
}

const d01 = guardedCase({
  id: "D-01",
  fixtureFamily: "GP-F-UI-TIMELINE",
  action: "Use production Chromium visible controls to create and version a Region, register a Device, ingest observations, inspect Membership, Transition, late and Work state, and run a point batch query.",
  oracle: "Captured real API responses, refreshed DOM, independent snapshot state, keyboard focus and mobile overflow checks require UI timestamps, versions, validation and query results to remain truthful.",
  async run(ctx) {
    const seed = coreFixture(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const worker = await ctx.startWorker();
    const { page } = await launchBrowser(ctx, api.baseUrl);
    ctx.ok(/geopulse/iu.test(await page.locator("body").innerText()), "production UI identifies GeoPulse");

    await openSection(page, [/regions?/iu]);
    await fillField(page, [/tenant id/iu, /^tenant$/iu], seed.tenants[0].tenantId);
    await fillField(page, [/region name/iu, /^name$/iu], "Browser Region");
    const createdRegion = await submitFor(page, /^\/api\/v1\/regions$/u, () => clickControl(page, "button", [/create region/iu, /save region/iu]));
    const regionId = createdRegion.regionId ?? createdRegion.region?.regionId;
    ctx.ok(typeof regionId === "string", "browser Region creation returns a Region identity");

    await fillField(page, [/region id/iu], regionId);
    await fillField(page, [/effective from/iu], ctx.at({ hours: -1 }));
    await fillField(page, [/polygon/iu], JSON.stringify([[1, 1], [1.01, 1], [1.01, 1.01], [1, 1.01], [1, 1]]));
    await fillField(page, [/boundary tolerance/iu, /tolerance/iu], "5");
    await fillField(page, [/dwell/iu], "2");
    const version = await submitFor(page, new RegExp(`^/api/v1/regions/${regionId}/versions$`, "u"), () => clickControl(page, "button", [/create version/iu, /publish version/iu, /save version/iu]));
    const regionVersionId = version.regionVersionId ?? version.version?.regionVersionId;
    ctx.ok(typeof regionVersionId === "string", "browser RegionVersion creation returns its identity");

    await openSection(page, [/devices?/iu]);
    await fillField(page, [/tenant id/iu, /^tenant$/iu], seed.tenants[0].tenantId);
    await fillField(page, [/external ref/iu, /device reference/iu], "browser-device");
    const createdDevice = await submitFor(page, /^\/api\/v1\/devices$/u, () => clickControl(page, "button", [/register device/iu, /create device/iu]));
    const deviceId = createdDevice.deviceId ?? createdDevice.device?.deviceId;
    ctx.ok(typeof deviceId === "string", "browser Device registration returns its identity");

    await openSection(page, [/location/iu, /ingest/iu]);
    const eventId = ctx.uuid("browser-location-event");
    const fields = [
      [[/tenant id/iu], seed.tenants[0].tenantId],
      [[/device id/iu], deviceId],
      [[/event id/iu], eventId],
      [[/device sequence/iu, /^sequence$/iu], "1"],
      [[/observed at/iu], ctx.at({ seconds: 1 })],
      [[/longitude/iu], "1.005"],
      [[/latitude/iu], "1.005"],
      [[/accuracy/iu], "2"],
    ];
    for (const [labels, value] of fields) await fillField(page, labels, value);
    await submitFor(page, /^\/api\/v1\/location-events$/u, () => clickControl(page, "button", [/ingest/iu, /submit event/iu]));
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    ctx.ok(resource(snapshot, "memberships").some(({ deviceId: value, regionVersionId: versionId }) => value === deviceId && versionId === regionVersionId), "browser event produces real Membership");
    ctx.ok(resource(snapshot, "transitions").some(({ sourceEventId }) => sourceEventId === eventId), "browser event produces real Transition");

    await page.reload({ waitUntil: "domcontentloaded" });
    const refreshed = await page.locator("body").innerText();
    ctx.ok(refreshed.includes(deviceId) || refreshed.includes(eventId), "refresh restores server-authoritative browser state");
    await openSection(page, [/quer(?:y|ies)/iu, /point query/iu]);
    await fillField(page, [/tenant id/iu, /^tenant$/iu], seed.tenants[0].tenantId);
    await fillField(page, [/points/iu, /query json/iu], JSON.stringify([{ queryId: "browser-query", longitude: 1.005, latitude: 1.005, at: ctx.at({ seconds: 1 }) }]));
    const query = await submitFor(page, /^\/api\/v1\/regions\/query$/u, () => clickControl(page, "button", [/run query/iu, /query regions/iu]));
    ctx.equal(query.items?.[0]?.queryId, "browser-query", "browser renders real input-ordered query response");

    await page.keyboard.press("Tab");
    ctx.ok(await page.evaluate(() => document.activeElement !== document.body), "primary UI is keyboard focusable");
    await page.setViewportSize({ width: 390, height: 844 });
    ctx.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "mobile UI has no horizontal overflow");
    return finalEvidence(ctx, { browserMutations: 4, refreshRecovered: true, mobileChecked: true });
  },
}, correctness);

const d02 = guardedCase({
  id: "D-02",
  fixtureFamily: "GP-F-UI-BUNDLE",
  action: "Use production Chromium controls to select duplicate unsorted RegionVersions, publish with expectedRevision, run an immediate point query, roll back to revision one and inspect revision history.",
  oracle: "HTTP captures and refreshed visible revision state require sorted unique composition, one current revision, exact query matches and immutable copied rollback membership without client-side cache fabrication.",
  async run(ctx) {
    const seed = coreFixture(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await openSection(page, [/bundles?/iu, /composition/iu]);
    await fillField(page, [/tenant id/iu, /^tenant$/iu], seed.tenants[0].tenantId);
    await fillField(page, [/bundle name/iu, /^name$/iu], "Browser Bundle");
    const created = await submitFor(page, /^\/api\/v1\/region-bundles$/u, () => clickControl(page, "button", [/create bundle/iu, /save bundle/iu]));
    const bundleId = created.bundle?.bundleId;
    ctx.ok(typeof bundleId === "string", "browser creates a real RegionBundle");

    await fillField(page, [/bundle id/iu], bundleId);
    await fillField(page, [/expected revision/iu], "0");
    await fillField(page, [/effective from/iu], ctx.at({ hours: -1 }));
    const memberText = [seed.regionVersions[1].regionVersionId, seed.regionVersions[0].regionVersionId, seed.regionVersions[1].regionVersionId].join("\n");
    await fillField(page, [/region version ids/iu, /members/iu], memberText);
    const published = await submitFor(page, new RegExp(`^/api/v1/region-bundles/${bundleId}/publish$`, "u"), () => clickControl(page, "button", [/publish/iu]));
    ctx.equal(published.revision?.regionVersionIds, seed.regionVersions.map(({ regionVersionId }) => regionVersionId).sort(), "browser publication sorts and deduplicates members");

    await openSection(page, [/quer(?:y|ies)/iu, /point query/iu]);
    await fillField(page, [/tenant id/iu, /^tenant$/iu], seed.tenants[0].tenantId);
    await fillField(page, [/points/iu, /query json/iu], JSON.stringify([{ queryId: "bundle-browser-query", longitude: 0.005, latitude: 0.005, at: ctx.at({ seconds: 1 }) }]));
    const query = await submitFor(page, /^\/api\/v1\/regions\/query$/u, () => clickControl(page, "button", [/run query/iu, /query regions/iu]));
    ctx.equal(query.bundleRevisionId, published.revision.bundleRevisionId, "browser query uses published revision");

    await openSection(page, [/bundles?/iu, /composition/iu]);
    await fillField(page, [/bundle id/iu], bundleId);
    await fillField(page, [/expected revision/iu], "1");
    await fillField(page, [/target revision/iu], "1");
    await fillField(page, [/effective from/iu], ctx.at({ hours: 1 }));
    const rolledBack = await submitFor(page, new RegExp(`^/api/v1/region-bundles/${bundleId}/rollback$`, "u"), () => clickControl(page, "button", [/roll back/iu, /rollback/iu]));
    ctx.equal(rolledBack.revision?.revision, 2, "browser rollback creates a new revision");
    ctx.equal(rolledBack.revision?.regionVersionIds, published.revision.regionVersionIds, "browser rollback copies revision one members");
    await page.reload({ waitUntil: "domcontentloaded" });
    const body = await page.locator("body").innerText();
    ctx.ok(body.includes(rolledBack.revision.bundleRevisionId) || body.includes("2"), "refresh shows server revision history");
    const detail = await readBundle(ctx, api.baseUrl, bundleId);
    ctx.equal(detail.revisions.length, 2, "browser workflow persisted two immutable revisions");
    return finalEvidence(ctx, { browserBundleMutations: 3, revisions: 2, revisionConsistentQuery: true });
  },
}, correctness);

const d03 = guardedCase({
  id: "D-03",
  fixtureFamily: "GP-F-FINAL-CONTRACT",
  action: "Fetch live OpenAPI, execute the declared Bundle and location routes, then read one populated FINAL verification snapshot over public HTTP.",
  oracle: "Frozen route contract, independent JSON Schema validation, exact point-in-time resource union, published sort keys, Work shape and sensitive-coordinate scan validate the live wire contract.",
  async run(ctx) {
    const seed = coreFixture(ctx, { includeOtherTenant: true });
    const api = await startPreparedApi(ctx, { seed });
    const bundle = await createBundle(ctx, api.baseUrl, seed.tenants[0].tenantId);
    const published = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 0,
      effectiveFrom: ctx.at({ hours: -1 }),
      regionVersionIds: seed.regionVersions.map(({ regionVersionId }) => regionVersionId),
    });
    const event = {
      eventId: ctx.uuid("contract-location"), tenantId: seed.tenants[0].tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 1, observedAt: ctx.at({ seconds: 1 }), longitude: 0.005, latitude: 0.005, accuracyMeters: 2,
    };
    await acceptEvent(ctx, api.baseUrl, event);
    const worker = await ctx.startWorker();
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    const openapiResponse = await ctx.request(api.baseUrl, "/openapi.json");
    ctx.equal(openapiResponse.status, 200, "OpenAPI status");
    const openapi = openapiResponse.json;
    ctx.equal(openapi?.openapi, "3.1.0", "OpenAPI version");
    const routes = [
      ["/api/v1/tenants", "post"], ["/api/v1/devices", "post"], ["/api/v1/regions", "post"],
      ["/api/v1/regions/{regionId}/versions", "post"], ["/api/v1/regions/{regionId}", "get"],
      ["/api/v1/location-events", "post"], ["/api/v1/location-events/batch", "post"],
      ["/api/v1/devices/{deviceId}/memberships", "get"], ["/api/v1/devices/{deviceId}/transitions", "get"],
      ["/api/v1/regions/query", "post"], ["/api/v1/verification-snapshot", "get"],
      ["/api/v1/region-bundles", "post"], ["/api/v1/region-bundles/{bundleId}/publish", "post"],
      ["/api/v1/region-bundles/{bundleId}/rollback", "post"], ["/api/v1/region-bundles/{bundleId}", "get"],
    ];
    for (const [path, method] of routes) ctx.ok(openapi.paths?.[path]?.[method], `OpenAPI publishes ${method.toUpperCase()} ${path}`);
    validateOpenApiResponse(openapi, "/api/v1/region-bundles/{bundleId}", "get", 200, await readBundle(ctx, api.baseUrl, bundle.bundleId));
    validateOpenApiResponse(openapi, "/api/v1/regions/query", "post", 200, await queryRegions(ctx, api.baseUrl, seed.tenants[0].tenantId, [{ queryId: "contract", longitude: 0.005, latitude: 0.005, at: ctx.at({ seconds: 1 }) }]));

    exactKeys(snapshot.resources, FINAL_SNAPSHOT_RESOURCES, "FINAL snapshot resources");
    const sortContract = {
      tenants: ["tenantId"], devices: ["deviceId"], regions: ["regionId"], regionVersions: ["regionVersionId"],
      locationEvents: ["eventId"], memberships: ["tenantId", "deviceId", "regionId"], transitions: ["transitionId"],
      regionBundles: ["bundleId"], regionBundleRevisions: ["bundleRevisionId"],
    };
    for (const [name, fields] of Object.entries(sortContract)) ctx.equal(resource(snapshot, name), sorted(resource(snapshot, name), fields), `${name} uses published snapshot order`);
    assertWorkShape(snapshot);
    assertEvents(ctx, snapshot.events ?? []);
    ctx.ok(resource(snapshot, "memberships").every(({ bundleRevisionId }) => bundleRevisionId === published.revision.bundleRevisionId), "Membership exposes its Bundle revision", { hardCapIds: correctness });
    const retainedEvent = resource(snapshot, "locationEvents").find(item => item.eventId === event.eventId);
    ctx.ok(retainedEvent, "accepted LocationEvent is retained in the public snapshot");
    ctx.equal(retainedEvent.bundleRevisionId, published.revision.bundleRevisionId, "LocationEvent pins the selected public Bundle revision");
    const text = canonicalJson(snapshot);
    ctx.ok(!/(?:authorization|admin[_-]?token|database_url|postgres(?:ql)?:\/\/|private path)/iu.test(text), "snapshot contains no credential or private path");
    return ctx.pass({
      evidence: [{ kind: "geopulse-case-summary", openapiRoutes: routes.length, snapshotResources: Object.keys(snapshot.resources).length }],
    });
  },
}, correctness);

const d04 = guardedCase({
  id: "D-04",
  fixtureFamily: "GP-F-CROSS-LAYER-LINEAGE",
  action: "Save an accepted event response, drain its Work, follow LocationEvent, Membership, Transition and Domain Event in the snapshot, then query the same point and append a too-old event.",
  oracle: "Independent identity and geometry lineage requires one tenant/device/region/version/source/sequence chain, one response Bundle revision and no history rewrite or raw-coordinate Event leak.",
  async run(ctx) {
    const seed = coreFixture(ctx);
    const tenantId = seed.tenants[0].tenantId;
    const version = seed.regionVersions[0];
    const api = await startPreparedApi(ctx, { seed });
    const bundle = await createBundle(ctx, api.baseUrl, tenantId);
    const published = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 0, effectiveFrom: ctx.at({ hours: -1 }), regionVersionIds: [version.regionVersionId],
    });
    const event = {
      eventId: ctx.uuid("lineage-event"), tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 1, observedAt: ctx.at({ minutes: 20 }), longitude: 0.005, latitude: 0.005, accuracyMeters: 2,
    };
    await acceptEvent(ctx, api.baseUrl, event);
    const worker = await ctx.startWorker();
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    const stored = resource(snapshot, "locationEvents").find(({ eventId }) => eventId === event.eventId);
    const work = (snapshot.work ?? []).find(({ aggregateId, kind }) => aggregateId === event.eventId && kind === "LOCATION_EVALUATION");
    const membership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === event.deviceId && regionId === version.regionId);
    const transition = resource(snapshot, "transitions").find(({ sourceEventId }) => sourceEventId === event.eventId);
    ctx.ok(stored && work && membership && transition, "all cross-layer records are publicly observable");
    ctx.equal({ tenantId: membership.tenantId, deviceId: membership.deviceId, regionId: membership.regionId, regionVersionId: membership.regionVersionId, bundleRevisionId: membership.bundleRevisionId }, {
      tenantId, deviceId: event.deviceId, regionId: version.regionId, regionVersionId: version.regionVersionId, bundleRevisionId: published.revision.bundleRevisionId,
    }, "Membership lineage", { hardCapIds: correctness });
    ctx.equal({ tenantId: transition.tenantId, deviceId: transition.deviceId, regionId: transition.regionId, regionVersionId: transition.regionVersionId, bundleRevisionId: transition.bundleRevisionId, sourceEventId: transition.sourceEventId, sequence: transition.sequence }, {
      tenantId, deviceId: event.deviceId, regionId: version.regionId, regionVersionId: version.regionVersionId, bundleRevisionId: published.revision.bundleRevisionId, sourceEventId: event.eventId, sequence: 1,
    }, "Transition lineage", { hardCapIds: correctness });
    const query = await queryRegions(ctx, api.baseUrl, tenantId, [{ queryId: "lineage", longitude: event.longitude, latitude: event.latitude, at: event.observedAt }]);
    ctx.equal({ bundleRevisionId: query.bundleRevisionId, matches: query.items[0].matches }, {
      bundleRevisionId: published.revision.bundleRevisionId,
      matches: [{ regionId: version.regionId, regionVersionId: version.regionVersionId }],
    }, "query lineage matches the frozen authority");

    const beforeOld = stableSnapshot(snapshot);
    const tooOld = { ...event, eventId: ctx.uuid("lineage-too-old"), deviceSequence: 2, observedAt: ctx.at() };
    await acceptEvent(ctx, api.baseUrl, tooOld);
    const afterOld = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    ctx.equal(resource(afterOld, "memberships"), beforeOld.resources.memberships, "LATE_IGNORED does not rewrite Membership history", { hardCapIds: correctness });
    ctx.equal(resource(afterOld, "transitions"), beforeOld.resources.transitions, "LATE_IGNORED does not rewrite Transition history", { hardCapIds: correctness });
    ctx.ok((afterOld.events ?? []).some(({ type }) => type === "location.late_ignored"), "lineage includes location.late_ignored Event");
    assertEvents(ctx, afterOld.events ?? []);
    return finalEvidence(ctx, { workId: work.workId, transitionSequence: transition.sequence, lateIgnored: true });
  },
}, correctness);

export const D_CASES = Object.freeze([d01, d02, d03, d04]);
