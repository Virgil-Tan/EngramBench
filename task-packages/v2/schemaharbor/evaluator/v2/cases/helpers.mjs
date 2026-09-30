import assert from "node:assert/strict";

import { chromium } from "playwright-core";

import { assertGaplessVersions, canonical, canonicalDigest, sha256 } from "../lib/oracle.mjs";
import { emptySeed, field, recordSchema } from "../lib/fixtures.mjs";

export const SUBJECT_KEYS = ["compatibilityMode", "createdAt", "headVersion", "modeRevision", "name", "subjectId"];
export const DRAFT_KEYS = ["canonicalDigest", "compatibilityMode", "createdAt", "dependencies", "draftId", "expectedHeadVersion", "findings", "modeRevision", "schema", "state", "subjectId"];
export const VERSION_KEYS = ["canonicalDigest", "compatibilityMode", "dependencies", "modeRevision", "publishedAt", "releaseBundleId", "schema", "schemaVersionId", "sequence", "subjectId", "version"];
export const BUNDLE_KEYS = ["canonicalDigest", "catalogSnapshot", "createdAt", "findings", "members", "publishedAt", "releaseBundleId", "sequence", "state"];
export const EVENT_KEYS = ["aggregateId", "eventId", "occurredAt", "payload", "schemaVersion", "sequence", "type"];
export const WORK_KEYS = ["aggregateId", "attempt", "kind", "leaseExpiresAt", "leaseOwner", "state", "terminal", "workId"];
export const BUNDLE_MEMBER_KEYS = ["draftId", "prospectiveVersion", "subjectId"];
export const CATALOG_ENTRY_KEYS = ["headVersion", "modeRevision", "subjectId"];
export const FINDING_KEYS = ["code", "message", "path"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function result(evidence, extra = {}) { return { evidence, ...extra }; }

export function guarded(hardCapIds, operation) {
  return Promise.resolve().then(operation).catch((error) => {
    error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
    throw error;
  });
}

export function requireStatus(response, expected, label = "request") {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses.join("/")}, got ${response.status}: ${response.text}`);
  assert.notEqual(response.json, undefined, `${label}: response is not JSON`);
  return response.json;
}

export function assertExactError(response, status, code) {
  requireStatus(response, status, code);
  assert.deepEqual(Object.keys(response.json), ["error"]);
  assert.deepEqual(Object.keys(response.json.error).sort(), ["code", "details", "message"]);
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details));
}

export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has wrong keys`);
}

export function eventFor(snapshot, aggregateId, type) {
  return snapshot.events.filter((event) => event.aggregateId === aggregateId && event.type === type);
}

export function stableSnapshot(value) {
  const { asOf: _asOf, ...stable } = value;
  return stable;
}

export function assertNoPrivateFields(value, path = "snapshot") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoPrivateFields(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, /Token$/u, `${path}.${key} exposes a token`);
    assert.doesNotMatch(key, /^(?:idempotencyKey|rawWebhook|privatePath|secret)$/iu, `${path}.${key} exposes private data`);
    assertNoPrivateFields(entry, `${path}.${key}`);
  }
}

export function assertFinalSnapshot(snapshot) {
  exactKeys(snapshot, ["asOf", "resources", "work", "events"], "snapshot");
  exactKeys(snapshot.resources, ["subjects", "schemaDrafts", "schemaVersions", "releaseBundles"], "snapshot resources");
  for (const key of Object.keys(snapshot.resources)) assert.ok(Array.isArray(snapshot.resources[key]), `${key} is not an array`);
  assert.ok(Array.isArray(snapshot.work));
  assert.ok(Array.isArray(snapshot.events));
  assertNoPrivateFields(snapshot);
  assert.match(snapshot.asOf, TIMESTAMP);
  for (const subject of snapshot.resources.subjects) {
    exactKeys(subject, SUBJECT_KEYS, "Subject");
    assert.match(subject.subjectId, UUID);
    assert.match(subject.createdAt, TIMESTAMP);
    assert.ok(["BACKWARD", "FORWARD", "FULL"].includes(subject.compatibilityMode));
    assert.ok(Number.isSafeInteger(subject.modeRevision) && subject.modeRevision > 0);
    assert.ok(subject.headVersion === null || (Number.isSafeInteger(subject.headVersion) && subject.headVersion > 0));
  }
  for (const draft of snapshot.resources.schemaDrafts) {
    exactKeys(draft, DRAFT_KEYS, "SchemaDraft");
    assert.match(draft.draftId, UUID);
    assert.match(draft.subjectId, UUID);
    assert.match(draft.canonicalDigest, SHA256);
    assert.match(draft.createdAt, TIMESTAMP);
    assert.ok(["VALIDATING", "VALID", "PUBLISHED", "REJECTED", "STALE"].includes(draft.state));
    assert.ok(Array.isArray(draft.dependencies) && Array.isArray(draft.findings));
    assert.deepEqual(draft.dependencies, [...draft.dependencies].sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)) || left.version - right.version));
    assert.deepEqual(draft.findings, [...draft.findings].sort((left, right) => Buffer.from(left.field ?? "").compare(Buffer.from(right.field ?? "")) || left.code.localeCompare(right.code)));
  }
  for (const version of snapshot.resources.schemaVersions) {
    exactKeys(version, VERSION_KEYS, "SchemaVersion");
    assert.match(version.schemaVersionId, UUID);
    assert.match(version.subjectId, UUID);
    if (version.releaseBundleId !== null) assert.match(version.releaseBundleId, UUID);
    assert.match(version.canonicalDigest, SHA256);
    assert.match(version.publishedAt, TIMESTAMP);
    assert.ok(Number.isSafeInteger(version.version) && version.version > 0);
    assert.ok(Number.isSafeInteger(version.sequence) && version.sequence > 0);
    assert.equal(version.canonicalDigest, canonicalDigest(version.schema, version.dependencies));
  }
  for (const bundle of snapshot.resources.releaseBundles) {
    exactKeys(bundle, BUNDLE_KEYS, "ReleaseBundle");
    assert.match(bundle.releaseBundleId, UUID);
    assert.match(bundle.canonicalDigest, SHA256);
    assert.match(bundle.createdAt, TIMESTAMP);
    if (bundle.publishedAt !== null) assert.match(bundle.publishedAt, TIMESTAMP);
    assert.ok(["VALIDATING", "READY", "PUBLISHED", "REJECTED", "STALE"].includes(bundle.state));
    assert.ok(Number.isSafeInteger(bundle.sequence) && bundle.sequence > 0);
    for (const member of bundle.members) {
      exactKeys(member, BUNDLE_MEMBER_KEYS, "ReleaseBundle member");
      assert.match(member.draftId, UUID);
      assert.match(member.subjectId, UUID);
      assert.ok(Number.isSafeInteger(member.prospectiveVersion) && member.prospectiveVersion > 0);
    }
    for (const entry of bundle.catalogSnapshot) {
      exactKeys(entry, CATALOG_ENTRY_KEYS, "CatalogSnapshotEntry");
      assert.match(entry.subjectId, UUID);
      assert.ok(entry.headVersion === null || (Number.isSafeInteger(entry.headVersion) && entry.headVersion > 0));
      assert.ok(Number.isSafeInteger(entry.modeRevision) && entry.modeRevision > 0);
    }
    for (const finding of bundle.findings) {
      exactKeys(finding, FINDING_KEYS, "CompilationFinding");
      assert.equal(typeof finding.code, "string");
      assert.equal(typeof finding.path, "string");
      assert.equal(typeof finding.message, "string");
    }
    assert.deepEqual(bundle.members, [...bundle.members].sort((left, right) => bytewise(left.subjectId, right.subjectId)));
    assert.deepEqual(bundle.catalogSnapshot, [...bundle.catalogSnapshot].sort((left, right) => bytewise(left.subjectId, right.subjectId)));
    assert.deepEqual(bundle.findings, [...bundle.findings].sort((left, right) => bytewise(left.path, right.path) || bytewise(left.code, right.code)));
  }
  for (const work of snapshot.work) {
    exactKeys(work, WORK_KEYS, "Work");
    assert.match(work.workId, UUID);
    assert.match(work.aggregateId, UUID);
    assert.ok(["SCHEMA_VALIDATION", "BUNDLE_VALIDATION"].includes(work.kind));
    assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state));
    assert.ok(Number.isSafeInteger(work.attempt) && work.attempt >= 0);
    assert.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state));
    assert.equal(work.leaseOwner === null, work.state !== "LEASED");
    assert.equal(work.leaseExpiresAt === null, work.state !== "LEASED");
    if (work.leaseExpiresAt !== null) assert.match(work.leaseExpiresAt, TIMESTAMP);
  }
  for (const event of snapshot.events) {
    exactKeys(event, EVENT_KEYS, "DomainEvent");
    assert.match(event.eventId, UUID);
    assert.match(event.aggregateId, UUID);
    assert.match(event.occurredAt, TIMESTAMP);
    assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > 0);
    assert.equal(event.schemaVersion, 1);
    assert.equal(canonical(event.payload), "{}");
  }
}

function bytewise(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function assertSnapshotClosure(snapshot) {
  assertFinalSnapshot(snapshot);
  const { subjects, schemaDrafts, schemaVersions, releaseBundles } = snapshot.resources;
  assert.deepEqual(subjects.map(({ subjectId }) => subjectId), [...subjects].sort((left, right) => bytewise(left.subjectId, right.subjectId)).map(({ subjectId }) => subjectId));
  assert.deepEqual(schemaDrafts.map(({ draftId }) => draftId), [...schemaDrafts].sort((left, right) => bytewise(left.draftId, right.draftId)).map(({ draftId }) => draftId));
  assert.deepEqual(schemaVersions.map(({ subjectId, version }) => [subjectId, version]), [...schemaVersions]
    .sort((left, right) => bytewise(left.subjectId, right.subjectId) || left.version - right.version)
    .map(({ subjectId, version }) => [subjectId, version]));
  assert.deepEqual(releaseBundles.map(({ releaseBundleId }) => releaseBundleId), [...releaseBundles]
    .sort((left, right) => bytewise(left.releaseBundleId, right.releaseBundleId)).map(({ releaseBundleId }) => releaseBundleId));
  assert.deepEqual(snapshot.work.map(({ workId }) => workId), [...snapshot.work].sort((left, right) => bytewise(left.workId, right.workId)).map(({ workId }) => workId));
  assert.deepEqual(snapshot.events.map(({ aggregateId, sequence, eventId }) => [aggregateId, sequence, eventId]), [...snapshot.events]
    .sort((left, right) => bytewise(left.aggregateId, right.aggregateId) || left.sequence - right.sequence || bytewise(left.eventId, right.eventId))
    .map(({ aggregateId, sequence, eventId }) => [aggregateId, sequence, eventId]));

  assert.equal(new Set(subjects.map(({ subjectId }) => subjectId)).size, subjects.length);
  assert.equal(new Set(schemaDrafts.map(({ draftId }) => draftId)).size, schemaDrafts.length);
  assert.equal(new Set(schemaVersions.map(({ schemaVersionId }) => schemaVersionId)).size, schemaVersions.length);
  assert.equal(new Set(releaseBundles.map(({ releaseBundleId }) => releaseBundleId)).size, releaseBundles.length);
  assert.equal(new Set(snapshot.work.map(({ workId }) => workId)).size, snapshot.work.length);
  assert.equal(new Set(snapshot.events.map(({ eventId }) => eventId)).size, snapshot.events.length);
  assertGaplessVersions(schemaVersions);

  const versionsByPin = new Map(schemaVersions.map((version) => [`${version.subjectId}\0${version.version}`, version]));
  const versionsBySubject = new Map();
  for (const version of schemaVersions) {
    const items = versionsBySubject.get(version.subjectId) ?? [];
    items.push(version);
    versionsBySubject.set(version.subjectId, items);
  }
  for (const subject of subjects) {
    const own = versionsBySubject.get(subject.subjectId) ?? [];
    assert.equal(subject.headVersion, own.length === 0 ? null : Math.max(...own.map(({ version }) => version)));
  }
  for (const version of schemaVersions) {
    for (const dependency of version.dependencies) assert.ok(versionsByPin.has(`${dependency.subjectId}\0${dependency.version}`), "snapshot contains an unresolved Dependency");
  }
  const draftById = new Map(schemaDrafts.map((draft) => [draft.draftId, draft]));
  for (const bundle of releaseBundles) {
    const memberSubjects = bundle.members.map(({ subjectId }) => subjectId);
    assert.equal(new Set(memberSubjects).size, memberSubjects.length);
    if (bundle.state === "PUBLISHED") {
      assert.equal(bundle.publishedAt === null, false);
      for (const member of bundle.members) {
        assert.equal(draftById.get(member.draftId)?.state, "PUBLISHED");
        assert.ok(schemaVersions.some((version) => version.releaseBundleId === bundle.releaseBundleId
          && version.subjectId === member.subjectId && version.version === member.prospectiveVersion));
      }
    } else {
      assert.equal(schemaVersions.some(({ releaseBundleId }) => releaseBundleId === bundle.releaseBundleId), false);
    }
  }
  const eventsByAggregate = new Map();
  for (const event of snapshot.events) {
    const items = eventsByAggregate.get(event.aggregateId) ?? [];
    items.push(event.sequence);
    eventsByAggregate.set(event.aggregateId, items);
  }
  for (const sequences of eventsByAggregate.values()) {
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  }
  return true;
}

export async function prepare(ctx, seed, { build = true, worker = false, dispatcherUrl } = {}) {
  if (build) {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
  }
  await ctx.migrate();
  if (seed) {
    const imported = await ctx.seed(seed, { timeoutMs: 600_000 });
    assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  }
  const api = await ctx.startApi();
  const workerProcess = worker ? await ctx.startWorker() : undefined;
  const dispatcher = dispatcherUrl ? await ctx.startDispatcher({ webhookUrl: dispatcherUrl }) : undefined;
  return { api, worker: workerProcess, dispatcher };
}

export async function createSubject(ctx, api, label, overrides = {}) {
  const body = { name: `${label}-${ctx.key(label)}`.slice(0, 80), compatibilityMode: "FULL", ...overrides };
  const response = await ctx.mutate(api.baseUrl, "/api/v1/subjects", ctx.key(`${label}-subject`), body);
  requireStatus(response, 201, `${label} subject`);
  exactKeys(response.json, SUBJECT_KEYS, "Subject response");
  return response.json;
}

export async function createDraft(ctx, api, subjectId, label, body = {}) {
  const request = {
    schema: recordSchema(`${label}Schema`, { id: field("STRING", true) }),
    dependencies: [],
    expectedHeadVersion: null,
    ...body,
  };
  const response = await ctx.mutate(
    api.baseUrl,
    `/api/v1/subjects/${subjectId}/schema-drafts`,
    ctx.key(`${label}-draft`),
    request,
  );
  requireStatus(response, 202, `${label} draft`);
  assert.equal(response.json.state, "VALIDATING");
  assert.equal(response.json.canonicalDigest, canonicalDigest(request.schema, request.dependencies));
  return { response, request, draft: response.json };
}

export async function waitSnapshot(ctx, api, predicate, label, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return predicate(snapshot) ? snapshot : undefined;
  }, { timeoutMs: 60_000, intervalMs: 50, label, ...options });
}

export async function waitDraft(ctx, api, draftId, states, options = {}) {
  const expected = new Set(Array.isArray(states) ? states : [states]);
  return waitSnapshot(ctx, api, (snapshot) => {
    const draft = snapshot.resources.schemaDrafts.find((item) => item.draftId === draftId);
    return draft && expected.has(draft.state) ? snapshot : undefined;
  }, `Draft ${draftId} reaches ${[...expected].join("/")}`, options);
}

export async function waitBundle(ctx, api, releaseBundleId, states, options = {}) {
  const expected = new Set(Array.isArray(states) ? states : [states]);
  return waitSnapshot(ctx, api, (snapshot) => {
    const bundle = snapshot.resources.releaseBundles.find((item) => item.releaseBundleId === releaseBundleId);
    return bundle && expected.has(bundle.state) ? snapshot : undefined;
  }, `Bundle ${releaseBundleId} reaches ${[...expected].join("/")}`, options);
}

export function findBy(items, fieldName, id, label = fieldName) {
  const value = items.find((item) => item[fieldName] === id);
  assert.ok(value, `${label} ${id} is missing`);
  return value;
}

export function publishedVersion(ctx, subject, label, version, schema, overrides = {}) {
  const dependencies = overrides.dependencies ?? [];
  return {
    schemaVersionId: ctx.uuid(`${label}-version-${version}`),
    subjectId: subject.subjectId,
    version,
    compatibilityMode: overrides.compatibilityMode ?? subject.compatibilityMode,
    modeRevision: overrides.modeRevision ?? subject.modeRevision,
    schema,
    canonicalDigest: canonicalDigest(schema, dependencies),
    dependencies,
    publishedAt: ctx.at({ days: -20 + version }),
    sequence: version,
  };
}

export function seedWithHistories(ctx, label, definitions) {
  const seed = emptySeed(ctx.fixtures, label);
  for (const [index, definition] of definitions.entries()) {
    const subject = {
      subjectId: definition.subjectId ?? ctx.uuid(`${label}-subject-${index}`),
      name: definition.name ?? `${label}-Subject-${index}`,
      compatibilityMode: definition.compatibilityMode ?? "FULL",
      modeRevision: definition.modeRevision ?? 1,
    };
    seed.subjects.push(subject);
    for (const [versionIndex, schema] of (definition.schemas ?? []).entries()) {
      seed.publishedVersions.push(publishedVersion(ctx, subject, `${label}-${index}`, versionIndex + 1, schema, {
        compatibilityMode: definition.versionModes?.[versionIndex],
        modeRevision: definition.versionModeRevisions?.[versionIndex],
        dependencies: definition.dependencies?.[versionIndex] ?? [],
      }));
    }
  }
  return seed;
}

export async function createBundle(ctx, api, label, members, expected = 202) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/release-bundles", ctx.key(`${label}-bundle`), { members });
  requireStatus(response, expected, `${label} bundle`);
  return response;
}

export async function getBundle(ctx, api, releaseBundleId) {
  const response = await ctx.request(api.baseUrl, `/api/v1/release-bundles/${releaseBundleId}`);
  requireStatus(response, 200, "ReleaseBundle read");
  exactKeys(response.json, BUNDLE_KEYS, "ReleaseBundle response");
  return response.json;
}

export async function getSubjectVersions(ctx, api, subjectId, query = "") {
  const response = await ctx.request(api.baseUrl, `/api/v1/subjects/${subjectId}/versions${query}`);
  requireStatus(response, 200, "SchemaVersion history");
  exactKeys(response.json, ["items", "nextCursor"], "SchemaVersion collection");
  for (const version of response.json.items) exactKeys(version, VERSION_KEYS, "SchemaVersion response");
  return response.json;
}

export async function withBrowser(ctx, api, operation) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  return operation(page);
}

export function percentile(values, percentileValue) {
  assert.ok(values.length > 0, "percentile requires samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

export async function closedLoop({ concurrency, durationMs, operation }) {
  const startedAt = performance.now();
  const samples = [];
  let ordinal = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() - startedAt < durationMs) {
      const current = ordinal;
      ordinal += 1;
      const before = performance.now();
      const value = await operation(current);
      samples.push({ ordinal: current, durationMs: performance.now() - before, value });
    }
  }));
  return { samples, elapsedMs: performance.now() - startedAt };
}

export function parseCaptured(capture) {
  const response = capture.response ?? capture;
  let json;
  try { json = JSON.parse(response.body ?? response.text ?? ""); } catch {}
  return { status: response.status, json, text: response.body ?? response.text };
}

export function sameJson(left, right) {
  assert.equal(canonical(left), canonical(right));
}

export { canonical, field, recordSchema, sha256 };
