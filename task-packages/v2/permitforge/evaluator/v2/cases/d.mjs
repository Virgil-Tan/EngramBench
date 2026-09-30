import assert from "node:assert/strict";
import { assertPublishedOpenApi } from "../lib/public-wire.mjs";
import { chmod, readFile, readdir, readlink, writeFile } from "node:fs/promises";

import {
  assertApprovedPermit,
  assertAggregateSequences,
  assertApplicationRevision,
  assertDomainEvent,
  assertExactOpenApiOperation,
  assertOpenApiRequest,
  assertOpenApiValue,
  assertOpenApiResponse,
  assertPermitApplication,
  assertRetryIdentity,
  assertReviewClaim,
  assertReviewDecision,
  assertReviewPolicy,
  assertReviewStage,
  assertSingleAggregateWork,
  assertSnapshot,
  assertStageSet,
  assertWork,
  canonicalJson,
} from "../oracles/index.mjs";
import {
  applicationCurrent,
  applicationDetail,
  applicationFrom,
  assertAggregateDetailAuthority,
  assertExternalSecretBoundary,
  blocked,
  boot,
  captureJsonResponse,
  caseResult,
  clickVisible,
  defineCase,
  domainEvents,
  expectError,
  expectVisibleIdentity,
  findObject,
  claimResource,
  keyboardActivate,
  launchBrowser,
  openApi,
  requireStatus,
  revisionDetail,
  snapshot,
  stableSnapshot,
  stagesDetail,
  submitApplication,
  waitSnapshot,
} from "./helpers.mjs";
import {
  assertPermitForgeEvidenceSummary,
  isMissingV1CheckpointOutcome,
  MISSING_V1_CHECKPOINT_REASON,
} from "../lib/execution.mjs";

async function setVisible(page, patterns, value, options = {}) {
  for (const pattern of patterns) {
    const locator = page.getByLabel(pattern).nth(options.index ?? 0);
    if (await locator.count()) {
      const tag = await locator.evaluate((node) => node.tagName);
      if (tag === "SELECT") await locator.selectOption(String(value));
      else await locator.fill(String(value));
      return locator;
    }
  }
  throw new Error(`visible labeled control not found: ${patterns.join(", ")}`);
}

async function baseForm(page, family, body, options = {}) {
  await setVisible(page, [/applicant/i], body.applicantId);
  await setVisible(page, [/permit.*type/i, /^type$/i], body.permitType);
  await setVisible(page, [/fields/i, /application.*data/i], JSON.stringify(body.fields));
  await setVisible(page, [/deadline/i], body.deadlineAt);
  if (!options.staged) await setVisible(page, [/review.*policy/i, /^policy$/i], JSON.stringify(body.reviewPolicy));
}

function findObjects(value, key, found = []) {
  if (Array.isArray(value)) value.forEach((item) => findObjects(item, key, found));
  else if (value && typeof value === "object") {
    if (Object.hasOwn(value, key)) found.push(value);
    Object.values(value).forEach((item) => findObjects(item, key, found));
  }
  return found;
}

function tokenValues(value, found = []) {
  if (Array.isArray(value)) value.forEach((item) => tokenValues(item, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/Token$/u.test(key) && typeof item === "string") found.push(item);
      tokenValues(item, found);
    }
  }
  return found;
}

function publicClaim(value) {
  return claimResource(value);
}

async function browserSubmitLegacy(ctx, page, family, label) {
  const body = ctx.fixtures.submissionBody(label);
  await baseForm(page, family, body);
  const observed = await captureJsonResponse(page, (url, response) => url.pathname === "/api/v1/permit-applications" && response.request().method() === "POST", () => keyboardActivate(page, [/submit/i, /create.*application/i]));
  ctx.equal(observed.status, 201, "browser submit status");
  const application = findObject(observed.json, "applicationId");
  const revisionResponse = await ctx.request(new URL(page.url()).origin, `/api/v1/permit-applications/${application.applicationId}/revisions/${application.currentRevision}`);
  requireStatus(ctx, revisionResponse, 200, "browser-created Revision read");
  const revision = revisionResponse.json;
  ctx.assert("browser-created Revision exact", () => assertApplicationRevision(revision));
  await expectVisibleIdentity(page, application.applicationId);
  return { body, application, revision, observed };
}

async function browserClaim(ctx, page, applicationId, reviewerId, role, label) {
  const identity = page.getByText(applicationId, { exact: false }).first();
  if (await identity.count()) await identity.click();
  await setVisible(page, [/reviewer/i], reviewerId);
  await setVisible(page, [/role/i], role);
  const observed = await captureJsonResponse(page, (url, response) => url.pathname === `/api/v1/permit-applications/${applicationId}/review-claims` && response.request().method() === "POST", () => keyboardActivate(page, [/claim/i, /start.*review/i]));
  ctx.equal(observed.status, 200, `${label} Claim status`);
  const claim = publicClaim(observed.json);
  ctx.assert(`${label} exact Claim`, () => assertReviewClaim(claim));
  await expectVisibleIdentity(page, claim.claimId);
  return { claim, observed };
}

async function browserSubmitStaged(ctx, page, family, count, label, stages) {
  const body = ctx.fixtures.stagedBody(count, label, stages ? { stages } : {});
  await baseForm(page, family, body, { staged: true });
  let stageNames = page.getByLabel(/stage.*name/i);
  while (await stageNames.count() < count) {
    await clickVisible(page, [/add.*stage/i]);
    stageNames = page.getByLabel(/stage.*name/i);
  }
  for (let index = 0; index < count; index += 1) {
    await setVisible(page, [/stage.*name/i], body.stages[index].name, { index });
    await setVisible(page, [/stage.*policy/i, /review.*policy/i], JSON.stringify(body.stages[index].reviewPolicy), { index });
  }
  const observed = await captureJsonResponse(page, (url, response) => url.pathname === "/api/v1/permit-applications" && response.request().method() === "POST", () => keyboardActivate(page, [/submit/i, /create.*application/i]));
  ctx.equal(observed.status, 201, `${count} Stage browser submit`);
  const application = findObject(observed.json, "applicationId");
  await expectVisibleIdentity(page, application.applicationId);
  return { application, observed, body };
}

async function auditAccessibleViewport(ctx, page, label) {
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const node = document.activeElement;
    const rect = node?.getBoundingClientRect();
    return Boolean(node && node !== document.body && rect && rect.width > 0 && rect.height > 0);
  });
  ctx.ok(focus, `${label} keyboard focus reaches a visible control`);
  const controls = page.locator("input:not([type=hidden]), textarea, select, button");
  const controlCount = await controls.count();
  ctx.ok(controlCount > 0, `${label} semantic controls exist`);
  const unlabeled = await page.locator("input:not([type=hidden]), textarea, select").evaluateAll((nodes) => nodes.filter((node) => {
    const labels = node.labels ? [...node.labels].map((item) => item.textContent ?? "").join("") : "";
    return !labels.trim() && !node.getAttribute("aria-label") && !node.getAttribute("aria-labelledby");
  }).length);
  ctx.equal(unlabeled, 0, `${label} form controls have associated labels`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ctx.equal(overflow, false, `${label} has no horizontal viewport overflow`);
  const contrastFailures = await page.locator("button, label, [role=alert], [role=status]").evaluateAll((nodes) => {
    const rgba = (text) => (text.match(/[\d.]+/gu) ?? []).map(Number);
    const luminance = ([red = 0, green = 0, blue = 0]) => {
      const channels = [red, green, blue].map((value) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const background = (node) => {
      let current = node;
      while (current) {
        const color = rgba(getComputedStyle(current).backgroundColor);
        if ((color[3] ?? 1) > 0) return color;
        current = current.parentElement;
      }
      return [255, 255, 255, 1];
    };
    return nodes.filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0 || !(node.textContent ?? "").trim()) return false;
      const foreground = luminance(rgba(style.color));
      const behind = luminance(background(node));
      const ratio = (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number.parseInt(style.fontWeight, 10) >= 700);
      return ratio < (large ? 3 : 4.5);
    }).map((node) => (node.textContent ?? "").trim().slice(0, 80));
  });
  ctx.equal(contrastFailures, [], `${label} visible controls and states meet WCAG AA contrast`);
  return controlCount;
}

async function collectBrowserSurface(ctx, baseUrl, pages) {
  const html = await Promise.all(pages.map((page) => page.locator("html").innerHTML()));
  const urls = new Set((await Promise.all(pages.map((page) => page.locator("script[src]").evaluateAll((nodes) => nodes.map((node) => node.src))))).flat());
  const bundles = [];
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.origin !== baseUrl) continue;
    const response = await ctx.request(baseUrl, `${parsed.pathname}${parsed.search}`);
    if (response.status === 200) bundles.push(response.text);
  }
  return { html, bundles };
}

async function expectVisibleValues(page, values, label) {
  for (const value of values.filter((item) => item !== null && item !== undefined && String(item).length > 0)) {
    await page.getByText(String(value), { exact: false }).first().waitFor({ state: "visible" });
  }
  return label;
}

function policyDisplayValues(policy) {
  return [
    policy.requiredTotalApprovals,
    ...policy.roles.flatMap(({ eligibleReviewerIds, requiredApprovals, role }) => [role, requiredApprovals, ...eligibleReviewerIds]),
  ];
}

async function expectFocusedFeedback(ctx, page, label) {
  const focused = await page.evaluate(() => {
    const node = document.activeElement;
    const feedback = node?.matches?.("[role=alert], [role=status], [aria-invalid=true]")
      || node?.matches?.(":invalid")
      || node?.closest?.("[role=alert], [role=status]")
      || node?.getAttribute?.("aria-describedby");
    return Boolean(node && node !== document.body && feedback);
  });
  ctx.ok(focused, `${label} moves focus to actionable feedback`);
}

function aggregateResources(state, applicationId) {
  return {
    application: state.resources.permitApplications.filter((item) => item.applicationId === applicationId),
    revisions: state.resources.applicationRevisions.filter((item) => item.applicationId === applicationId),
    claims: state.resources.reviewClaims.filter((item) => item.applicationId === applicationId),
    decisions: state.resources.reviewDecisions.filter((item) => item.applicationId === applicationId),
    permits: state.resources.approvedPermits.filter((item) => item.applicationId === applicationId),
    stages: state.resources.reviewStages.filter((item) => item.applicationId === applicationId),
    work: state.work.filter((item) => item.aggregateId === applicationId),
    events: state.events.filter((item) => item.aggregateId === applicationId),
  };
}

function rowsByIdentity(values, identity) {
  return new Map(values.map((value) => [identity(value), value]));
}

function addedIdentities(before, after, name, identity) {
  const previous = new Set(before[name].map(identity));
  return after[name].filter((item) => !previous.has(identity(item)));
}

function assertSubmitEffect(ctx, beforeState, afterState, applicationId, label) {
  const before = {
    permitApplications: beforeState.resources.permitApplications,
    applicationRevisions: beforeState.resources.applicationRevisions,
    work: beforeState.work,
    events: beforeState.events,
  };
  const after = {
    permitApplications: afterState.resources.permitApplications,
    applicationRevisions: afterState.resources.applicationRevisions,
    work: afterState.work,
    events: afterState.events,
  };
  const applications = addedIdentities(before, after, "permitApplications", (item) => item.applicationId);
  const revisions = addedIdentities(before, after, "applicationRevisions", (item) => `${item.applicationId}:${item.revision}`);
  const work = addedIdentities(before, after, "work", (item) => item.workId);
  const events = addedIdentities(before, after, "events", (item) => item.eventId);
  ctx.equal(applications.length, 1, `${label} creates exactly one Application effect`);
  ctx.equal(revisions.length, 1, `${label} creates exactly one Revision effect`);
  ctx.equal(work.length, 1, `${label} creates exactly one Work effect`);
  ctx.equal(events.length, 1, `${label} creates exactly one Event effect`);
  ctx.equal(applications[0].applicationId, applicationId, `${label} Application identity`);
  ctx.equal(revisions[0].applicationId, applicationId, `${label} Revision identity`);
  ctx.equal(work[0].aggregateId, applicationId, `${label} Work identity`);
  ctx.equal(events[0].aggregateId, applicationId, `${label} Event identity`);
  return { applicationId, revision: revisions[0], work: work[0], event: events[0] };
}

async function fillRevisionForm(ctx, page, family, fields, deadlineAt = ctx.at({ days: 4 })) {
  await setVisible(page, [/expected.*revision/i, /current.*revision/i], "1");
  await setVisible(page, [/fields/i, /application.*data/i], JSON.stringify(fields));
  await setVisible(page, [/deadline/i], deadlineAt);
  await setVisible(page, [/review.*policy/i, /^policy$/i], JSON.stringify(family.policy));
}

function corruptClosedObject(response) {
  const extra = structuredClone(response);
  extra.json = { ...extra.json, evaluatorUnexpectedField: true };
  const missing = structuredClone(response);
  const [first] = Object.keys(missing.json ?? {});
  if (first) delete missing.json[first];
  return [extra, missing];
}

function exactErrorSample(response) {
  const invalid = structuredClone(response);
  delete invalid.json?.error?.details;
  return invalid;
}

function resolveOpenApiSchema(document, raw) {
  if (!raw?.$ref) return raw;
  const resolved = raw.$ref.slice(2).split("/").reduce((value, key) => value?.[key], document);
  const { $ref: _ref, ...siblings } = raw;
  return Object.keys(siblings).length ? { ...resolved, ...siblings } : resolved;
}

function mergedOpenApiSchema(document, raw) {
  const schema = resolveOpenApiSchema(document, raw);
  if (!schema?.allOf) return schema;
  const branches = schema.allOf.map((branch) => mergedOpenApiSchema(document, branch));
  return {
    ...schema,
    allOf: undefined,
    type: "object",
    properties: Object.assign({}, ...branches.map(({ properties = {} }) => properties), schema.properties ?? {}),
    required: [...new Set([...branches.flatMap(({ required = [] }) => required), ...(schema.required ?? [])])],
    additionalProperties: schema.additionalProperties ?? (branches.some(({ additionalProperties, unevaluatedProperties }) => additionalProperties === false || unevaluatedProperties === false) ? false : undefined),
  };
}

function schemaTypes(document, raw) {
  const schema = mergedOpenApiSchema(document, raw);
  const own = Array.isArray(schema?.type) ? schema.type : schema?.type ? [schema.type] : [];
  return new Set([...own, ...(schema?.oneOf ?? []).flatMap((branch) => [...schemaTypes(document, branch)]), ...(schema?.anyOf ?? []).flatMap((branch) => [...schemaTypes(document, branch)])]);
}

function schemaKeyword(document, raw, keyword) {
  const schema = mergedOpenApiSchema(document, raw);
  if (Object.hasOwn(schema ?? {}, keyword)) return schema[keyword];
  for (const branch of [...(schema?.oneOf ?? []), ...(schema?.anyOf ?? [])]) {
    const value = schemaKeyword(document, branch, keyword);
    if (value !== undefined) return value;
  }
  return undefined;
}

const UUID_SCHEMA_FIELDS = new Set([
  "aggregateId", "applicantId", "applicationId", "claimId", "decisionId", "eventId", "permitApplicationId",
  "permitId", "reviewerId", "stageId", "workId",
]);

function namedSchemaField(path) {
  return [...path].reverse().find((item) => item !== "[]");
}

function expectedSchemaEnum(parent, name) {
  if (name === "kind" && parent?.workId) return ["PERMIT_DEADLINE"];
  if (name === "decision" && parent?.decisionId) return ["APPROVE", "REJECT", "REQUEST_CHANGES"];
  if (name === "type" && parent?.eventId) return ["application.submitted", "review.claimed", "review.decided", "application.changes-requested", "application.approved", "application.rejected", "application.expired"];
  if (name !== "state") return undefined;
  if (parent?.stageId) return ["PENDING", "ACTIVE", "COMPLETED", "TERMINAL"];
  if (parent?.claimId) return ["LEASED", "DECIDED", "EXPIRED"];
  if (parent?.workId) return ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"];
  if (parent?.applicationId && Object.hasOwn(parent, "currentRevision")) return ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "CHANGES_REQUIRED", "EXPIRED"];
  return undefined;
}

function assertNoOpenApi30Nullable(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.hasOwn(value, "nullable"), false, "OpenAPI 3.1 schemas must express null through type, not nullable");
  for (const child of Object.values(value)) assertNoOpenApi30Nullable(child, seen);
}

function exactSchemaBranch(document, raw, value, label) {
  const schema = mergedOpenApiSchema(document, raw);
  const kind = schema?.oneOf ? "oneOf" : schema?.anyOf ? "anyOf" : undefined;
  if (!kind) return schema;
  const matches = schema[kind].filter((branch) => {
    try { assertOpenApiValue(document, branch, value, label); return true; } catch { return false; }
  });
  if (kind === "oneOf") assert.equal(matches.length, 1, `${label} exact oneOf branch`);
  else assert.ok(matches.length >= 1, `${label} anyOf branch`);
  return exactSchemaBranch(document, matches[0], value, label);
}

/** Verify the schema for an observed wire value against PermitForge's independent field semantics. */
export function assertExactPublishedSchema(document, raw, value, label = "published value", path = [], parent = undefined) {
  if (assertPublishedOpenApi(document)) return assertOpenApiValue(document, raw, value, label);
  if (path.length === 0) assertNoOpenApi30Nullable(document);
  const schema = exactSchemaBranch(document, raw, value, label);
  assert.ok(schema && typeof schema === "object", `${label} schema exists`);
  const name = namedSchemaField(path);
  if (name === "fields") {
    assertOpenApiValue(document, schema, value, label);
    return true;
  }
  const types = schemaTypes(document, schema);
  if (value === null) {
    assert.ok(types.has("null"), `${label} required nullable field uses a JSON Schema null union`);
    return true;
  }
  if (Array.isArray(value)) {
    assert.ok(types.has("array"), `${label} array type`);
    assert.ok(schema.items, `${label} array items schema`);
    const arrayBounds = {
      stages: { minItems: 1, maxItems: 5 },
      roles: { minItems: 1, maxItems: 10 },
      eligibleReviewerIds: { minItems: 1, maxItems: 20, uniqueItems: true },
    }[name];
    for (const [keyword, expected] of Object.entries(arrayBounds ?? {})) assert.equal(schemaKeyword(document, schema, keyword), expected, `${label} ${keyword}`);
    for (const item of value.slice(0, 3)) assertExactPublishedSchema(document, schema.items, item, `${label}[]`, [...path, "[]"], value);
    return true;
  }
  if (value && typeof value === "object") {
    assert.ok(types.has("object"), `${label} object type`);
    assert.ok(schema.additionalProperties === false || schema.unevaluatedProperties === false, `${label} closed object`);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), Object.keys(value).sort(), `${label} exact properties`);
    assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(value).sort(), `${label} every field required`);
    for (const [key, child] of Object.entries(value)) {
      assertExactPublishedSchema(document, schema.properties[key], child, `${label}.${key}`, [...path, key], value);
    }
    return true;
  }
  const actualType = Number.isInteger(value) ? "integer" : typeof value;
  assert.ok(types.has(actualType) || (actualType === "integer" && types.has("number")), `${label} ${actualType} type`);
  if (typeof value === "string") {
    const containingField = path.findLast((item) => item !== "[]");
    if (UUID_SCHEMA_FIELDS.has(containingField) || containingField === "eligibleReviewerIds") assert.equal(schemaKeyword(document, schema, "format"), "uuid", `${label} uuid format`);
    if (/At$/u.test(containingField ?? "")) assert.equal(schemaKeyword(document, schema, "format"), "date-time", `${label} date-time format`);
    if (["canonicalDigest", "leaseTokenHash"].includes(containingField)) assert.equal(schemaKeyword(document, schema, "format"), "sha256", `${label} sha256 format`);
  }
  const enumeration = expectedSchemaEnum(parent, name);
  if (enumeration) assert.deepEqual([...(schemaKeyword(document, schema, "enum") ?? [])].sort(), [...enumeration].sort(), `${label} exact enum`);
  if (name === "schemaVersion") assert.equal(schemaKeyword(document, schema, "const"), 1, `${label} schemaVersion const`);
  if (["currentRevision", "decisionRevision", "expectedRevision", "ordinal", "requiredApprovals", "requiredTotalApprovals", "revision", "sequence"].includes(name)) {
    assert.equal(schemaKeyword(document, schema, "minimum"), 1, `${label} positive integer minimum`);
  }
  return true;
}

function exactPublishedRequest(ctx, document, path, method, value, label) {
  const operation = document.paths?.[path]?.[method.toLowerCase()];
  const requestBody = resolveOpenApiSchema(document, operation?.requestBody);
  const schema = requestBody?.content?.["application/json"]?.schema;
  ctx.assert(`${label} exact independent request schema`, () => assertExactPublishedSchema(document, schema, value, `${method.toUpperCase()} ${path} request`));
}

function exactPublishedResponse(ctx, document, path, method, response, label) {
  const operation = document.paths?.[path]?.[method.toLowerCase()];
  const declaration = resolveOpenApiSchema(document, operation?.responses?.[String(response.status)]);
  const schema = declaration?.content?.["application/json"]?.schema;
  ctx.assert(`${label} exact independent response schema`, () => assertExactPublishedSchema(document, schema, response.json, `${method.toUpperCase()} ${path} ${response.status}`));
}

function assertExactComponentObject(ctx, document, raw, fields, label) {
  const schema = mergedOpenApiSchema(document, raw);
  ctx.ok(schema && (schema.type === "object" || schema.properties), `${label} object schema`);
  ctx.ok(schema.additionalProperties === false || schema.unevaluatedProperties === false, `${label} additionalProperties false`);
  ctx.equal(Object.keys(schema.properties ?? {}).sort(), Object.keys(fields).sort(), `${label} exact properties`);
  ctx.equal([...(schema.required ?? [])].sort(), Object.keys(fields).sort(), `${label} every field required including nullable fields`);
  for (const [name, expected] of Object.entries(fields)) {
    const member = mergedOpenApiSchema(document, schema.properties[name]);
    if (expected.type) ctx.ok(schemaTypes(document, member).has(expected.type), `${label}.${name} type ${expected.type}`);
    if (expected.nullable) ctx.ok(schemaTypes(document, member).has("null"), `${label}.${name} nullable through JSON Schema type union`);
    else ctx.equal(schemaTypes(document, member).has("null"), false, `${label}.${name} non-nullable`);
    if (expected.format) ctx.equal(schemaKeyword(document, member, "format"), expected.format, `${label}.${name} format`);
    if (expected.enum) ctx.equal([...(schemaKeyword(document, member, "enum") ?? [])].sort(), [...expected.enum].sort(), `${label}.${name} exact enum`);
    if (Object.hasOwn(expected, "const")) ctx.equal(schemaKeyword(document, member, "const"), expected.const, `${label}.${name} const`);
    for (const bound of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems"]) {
      if (Object.hasOwn(expected, bound)) ctx.equal(schemaKeyword(document, member, bound), expected[bound], `${label}.${name} ${bound}`);
    }
    if (expected.fields) assertExactComponentObject(ctx, document, member, expected.fields, `${label}.${name}`);
    if (expected.items) {
      ctx.ok(schemaTypes(document, member).has("array"), `${label}.${name} array`);
      if (expected.itemFields) assertExactComponentObject(ctx, document, member.items, expected.itemFields, `${label}.${name}[]`);
      if (expected.item) {
        const item = mergedOpenApiSchema(document, member.items);
        ctx.ok(schemaTypes(document, item).has(expected.item.type), `${label}.${name}[] type ${expected.item.type}`);
        if (expected.item.format) ctx.equal(schemaKeyword(document, item, "format"), expected.item.format, `${label}.${name}[] format`);
      }
    }
  }
}

function assertPermitForgeOpenApiComponents(ctx, document) {
  if (assertPublishedOpenApi(document)) return true;
  const uuid = { type: "string", format: "uuid" };
  const timestamp = { type: "string", format: "date-time" };
  const nullableTimestamp = { ...timestamp, nullable: true };
  const integer = { type: "integer" };
  const positiveInteger = { type: "integer", minimum: 1 };
  const nullablePositiveInteger = { type: "integer", minimum: 1, nullable: true };
  const policyFields = {
    roles: {
      type: "array",
      items: true,
      minItems: 1,
      maxItems: 10,
      itemFields: {
        role: { type: "string", minLength: 1 },
        eligibleReviewerIds: { type: "array", items: true, item: uuid, minItems: 1, maxItems: 20, uniqueItems: true },
        requiredApprovals: { type: "integer", minimum: 1 },
        veto: { type: "boolean" },
      },
    },
    requiredTotalApprovals: { type: "integer", minimum: 1 },
  };
  const stageFields = {
    stageId: uuid,
    applicationId: uuid,
    revision: positiveInteger,
    ordinal: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1 },
    state: { type: "string", enum: ["PENDING", "ACTIVE", "COMPLETED", "TERMINAL"] },
    policy: { type: "object", fields: policyFields },
    activatedAt: nullableTimestamp,
    completedAt: nullableTimestamp,
  };
  const contracts = {
    ReviewPolicy: policyFields,
    PermitApplication: {
      applicationId: uuid,
      applicantId: uuid,
      permitType: { type: "string" },
      currentRevision: positiveInteger,
      state: { type: "string", enum: ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "CHANGES_REQUIRED", "EXPIRED"] },
      decisionRevision: nullablePositiveInteger,
      submittedAt: timestamp,
      deadlineAt: timestamp,
      terminalAt: nullableTimestamp,
      sequence: positiveInteger,
      currentStageOrdinal: nullablePositiveInteger,
      stages: { type: "array", items: true, itemFields: stageFields, minItems: 1, maxItems: 5 },
    },
    ApplicationRevision: {
      applicationId: uuid,
      revision: positiveInteger,
      fields: {},
      canonicalDigest: { type: "string", format: "sha256" },
      policy: { type: "object", fields: policyFields },
      createdAt: timestamp,
    },
    ReviewClaim: {
      claimId: uuid,
      applicationId: uuid,
      revision: positiveInteger,
      reviewerId: uuid,
      role: { type: "string" },
      state: { type: "string", enum: ["LEASED", "DECIDED", "EXPIRED"] },
      attempt: integer,
      leaseExpiresAt: nullableTimestamp,
    },
    ReviewDecision: {
      decisionId: uuid,
      applicationId: uuid,
      revision: positiveInteger,
      reviewerId: uuid,
      role: { type: "string" },
      decision: { type: "string", enum: ["APPROVE", "REJECT", "REQUEST_CHANGES"] },
      reason: { type: "string" },
      decidedAt: timestamp,
    },
    ApprovedPermit: {
      permitId: uuid,
      applicationId: uuid,
      revision: positiveInteger,
      canonicalDigest: { type: "string", format: "sha256" },
      issuedAt: timestamp,
    },
    ReviewStage: stageFields,
    Work: {
      workId: uuid,
      kind: { type: "string", enum: ["PERMIT_DEADLINE"] },
      aggregateId: uuid,
      state: { type: "string", enum: ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"] },
      terminal: { type: "boolean" },
      attempt: integer,
      leaseOwner: { type: "string", nullable: true },
      leaseExpiresAt: nullableTimestamp,
    },
    DomainEvent: {
      eventId: uuid,
      aggregateId: uuid,
      sequence: positiveInteger,
      type: { type: "string", enum: ["application.submitted", "review.claimed", "review.decided", "application.changes-requested", "application.approved", "application.rejected", "application.expired"] },
      payload: { type: "object", fields: {} },
      occurredAt: timestamp,
      schemaVersion: { type: "integer", const: 1 },
    },
  };
  for (const [name, fields] of Object.entries(contracts)) assertExactComponentObject(ctx, document, document.components?.schemas?.[name], fields, `component ${name}`);
  return true;
}

async function driveViewportStates(ctx, api, page, family, fixture, label) {
  const observedKeys = [];
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  const controlCount = await auditAccessibleViewport(ctx, page, `${label} populated`);

  const beforeValidation = await snapshot(ctx, api.baseUrl);
  const submitButton = page.getByRole("button", { name: /submit|create.*application/i }).first();
  ctx.equal(await submitButton.count(), 1, `${label} exposes one primary submit action`);
  await submitButton.focus();
  await page.keyboard.press("Enter");
  await page.locator("[role=alert], [aria-invalid=true]").first().waitFor({ state: "visible" });
  await expectFocusedFeedback(ctx, page, `${label} validation`);
  ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(beforeValidation), `${label} validation has zero server effect`);
  await auditAccessibleViewport(ctx, page, `${label} validation state`);

  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  const loadingBody = ctx.fixtures.submissionBody(`${label}-loading`);
  await baseForm(page, family, loadingBody);
  const beforeLoading = await snapshot(ctx, api.baseUrl);
  let delayed = true;
  await page.route("**/api/v1/permit-applications", async (route) => {
    if (delayed && route.request().method() === "POST") {
      delayed = false;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await route.continue();
  });
  const loadingPending = captureJsonResponse(page, (url, response) => url.pathname === "/api/v1/permit-applications" && response.request().method() === "POST", () => keyboardActivate(page, [/submit/i, /create.*application/i]));
  await page.locator("[aria-busy=true], [role=status]").first().waitFor({ state: "visible" });
  const loadingFocus = await page.evaluate(() => Boolean(document.activeElement?.closest?.("[aria-busy=true], [role=status]") || document.querySelector("[aria-live=polite], [aria-live=assertive]")));
  ctx.ok(loadingFocus, `${label} loading state is announced or focused`);
  const loaded = await loadingPending;
  ctx.equal(loaded.status, 201, `${label} delayed submission succeeds`);
  const loadingApplicationId = findObject(loaded.json, "applicationId").applicationId;
  observedKeys.push(loaded.response.request().headers()["idempotency-key"]);
  await expectVisibleIdentity(page, loadingApplicationId);
  await page.unroute("**/api/v1/permit-applications");
  const afterLoading = await snapshot(ctx, api.baseUrl);
  assertSubmitEffect(ctx, beforeLoading, afterLoading, loadingApplicationId, `${label} loading`);
  const claimSecretProbe = await browserClaim(ctx, page, loadingApplicationId, family.securityReviewers[0].reviewerId, "security", `${label} secret-boundary`);
  observedKeys.push(...tokenValues(claimSecretProbe.observed.json));
  await auditAccessibleViewport(ctx, page, `${label} loading result`);

  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  const offlineBody = ctx.fixtures.submissionBody(`${label}-offline`);
  await baseForm(page, family, offlineBody);
  const offlineRequests = [];
  let failedRequests = 0;
  const requestListener = (request) => {
    if (new URL(request.url()).pathname === "/api/v1/permit-applications" && request.method() === "POST") {
      offlineRequests.push(request.headers()["idempotency-key"]);
    }
  };
  const failedListener = (request) => {
    if (new URL(request.url()).pathname === "/api/v1/permit-applications" && request.method() === "POST") failedRequests += 1;
  };
  page.on("request", requestListener);
  page.on("requestfailed", failedListener);
  const beforeOffline = await snapshot(ctx, api.baseUrl);
  await page.context().setOffline(true);
  await keyboardActivate(page, [/submit/i, /create.*application/i]);
  await page.getByText(/offline|network|retry/i).first().waitFor({ state: "visible" });
  await expectFocusedFeedback(ctx, page, `${label} offline`);
  await page.context().setOffline(false);
  const retried = await captureJsonResponse(page, (url, response) => url.pathname === "/api/v1/permit-applications" && response.request().method() === "POST", () => keyboardActivate(page, [/retry/i]));
  page.off("request", requestListener);
  page.off("requestfailed", failedListener);
  ctx.equal(retried.status, 201, `${label} offline retry succeeds`);
  ctx.ok(failedRequests >= 1, `${label} offline request genuinely failed before retry`);
  const retriedApplicationId = findObject(retried.json, "applicationId").applicationId;
  await expectVisibleIdentity(page, retriedApplicationId);
  ctx.ok(offlineRequests.length >= 2, `${label} captures failed and retried request identities`);
  ctx.equal(new Set(offlineRequests.filter(Boolean)).size, 1, `${label} retry preserves one Idempotency-Key`);
  observedKeys.push(...offlineRequests);
  const afterOffline = await snapshot(ctx, api.baseUrl);
  assertSubmitEffect(ctx, beforeOffline, afterOffline, retriedApplicationId, `${label} offline retry`);
  await auditAccessibleViewport(ctx, page, `${label} offline retry result`);

  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  await expectVisibleIdentity(page, fixture.changes.application.applicationId);
  await page.getByText(fixture.changes.application.applicationId, { exact: false }).first().click();
  await fillRevisionForm(ctx, page, family, { stale: label }, ctx.at({ days: 5 }));
  const concurrentKey = ctx.key(`${label}-concurrent`);
  const winner = await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${fixture.changes.application.applicationId}/revisions`, concurrentKey, { expectedRevision: 1, fields: { winner: label }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: family.policy });
  requireStatus(ctx, winner, 200, `${label} concurrent replacement setup`);
  const beforeStale = await snapshot(ctx, api.baseUrl);
  const stale = await captureJsonResponse(page, (url, response) => url.pathname.endsWith("/revisions") && response.request().method() === "POST", () => keyboardActivate(page, [/create.*revision/i, /submit.*revision/i, /replace/i]));
  ctx.equal(stale.status, 409, `${label} stale UI receives conflict`);
  ctx.equal(stale.json.error.code, "APPLICATION_REVISION_CHANGED", `${label} stale code visible from server`);
  observedKeys.push(concurrentKey, stale.response.request().headers()["idempotency-key"]);
  await page.getByText(/APPLICATION_REVISION_CHANGED|revision.*changed|stale/i).first().waitFor({ state: "visible" });
  await expectFocusedFeedback(ctx, page, `${label} stale conflict`);
  ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(beforeStale), `${label} stale retry has zero effect`);
  await auditAccessibleViewport(ctx, page, `${label} stale conflict state`);

  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  await expectVisibleIdentity(page, fixture.approved.application.applicationId);
  await page.getByText(fixture.approved.application.applicationId, { exact: false }).first().click();
  await page.getByText(/APPROVED|terminal/i).first().waitFor({ state: "visible" });
  const enabledTerminalMutations = await page.getByRole("button").evaluateAll((nodes) => nodes.filter((node) => /claim|decid|revision|replace|request changes|approve|reject/i.test(node.textContent ?? "") && !node.disabled && node.getAttribute("aria-disabled") !== "true").length);
  ctx.equal(enabledTerminalMutations, 0, `${label} terminal state exposes no enabled mutation action`);
  await auditAccessibleViewport(ctx, page, `${label} terminal state`);

  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  const permission = await captureJsonResponse(page, (url) => url.pathname === "/api/v1/verification-snapshot", () => keyboardActivate(page, [/verification.*snapshot/i, /admin.*snapshot/i]));
  ctx.equal(permission.status, 401, `${label} permission UI uses real protected route`);
  ctx.equal(permission.json.error.code, "ADMIN_AUTH_REQUIRED", `${label} permission error code`);
  await page.getByText(/ADMIN_AUTH_REQUIRED|permission|unauthorized/i).first().waitFor({ state: "visible" });
  await expectFocusedFeedback(ctx, page, `${label} permission error`);
  await auditAccessibleViewport(ctx, page, `${label} permission state`);

  return {
    controlCount,
    loadingApplicationId,
    retriedApplicationId,
    observedKeys: observedKeys.filter(Boolean),
    conflictCode: stale.json.error.code,
    permissionCode: permission.json.error.code,
  };
}

function processRows(output) {
  return output.split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

async function inspectHttpSockets(pids) {
  const inodes = new Set();
  for (const pid of pids) {
    const directory = `/proc/${pid}/fd`;
    for (const name of await readdir(directory).catch(() => [])) {
      const target = await readlink(`${directory}/${name}`).catch(() => "");
      const match = target.match(/^socket:\[(\d+)\]$/u);
      if (match) inodes.add(match[1]);
    }
  }
  const sockets = [];
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const table = await readFile(path, "utf8").catch(() => "");
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || !inodes.has(fields[9])) continue;
      const localPort = Number.parseInt(fields[1]?.split(":").at(-1), 16);
      const remotePort = Number.parseInt(fields[2]?.split(":").at(-1), 16);
      if (localPort === 5432 || remotePort === 5432) continue;
      sockets.push({ inode: fields[9], state: fields[3] });
    }
  }
  return {
    listeners: new Set(sockets.filter(({ state }) => state === "0A").map(({ inode }) => inode)).size,
    established: new Set(sockets.filter(({ state }) => state === "01").map(({ inode }) => inode)).size,
  };
}

async function databaseCounters(ctx) {
  const result = await ctx.command("psql", [ctx.databaseUrl, "-At", "-F", "|", "-c", "select coalesce(xact_commit+xact_rollback,0),coalesce(tup_inserted+tup_updated+tup_deleted,0) from pg_stat_database where datname=current_database()"], { allowFailure: true, timeoutMs: 5_000 });
  if (result.exitCode !== 0) return undefined;
  const [transactions, tuplesChanged] = result.stdout.trim().split("|").map(Number);
  return Number.isFinite(transactions) && Number.isFinite(tuplesChanged) ? { transactions, tuplesChanged } : undefined;
}

export function assertProjectGateObservation(observation, requirements = {}) {
  for (const [field, minimum] of Object.entries(requirements)) {
    assert.ok(Number.isFinite(observation?.[field]) && observation[field] >= minimum, `${field} must be >= ${minimum}`);
  }
  return true;
}

const PUBLIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function assertRecoveryBarrierEvidence(ledger, options = {}) {
  assert.ok(Array.isArray(ledger) && ledger.length > 0, "recovery barrier evidence is nonempty");
  const workerEntries = ledger.filter(({ json }) => json?.processRole === "worker");
  const dispatcherEntries = ledger.filter(({ json }) => json?.processRole === "dispatcher" && json?.point === "dispatcher.response-received");
  if (options.requireDispatcher !== false) assert.ok(dispatcherEntries.length > 0, "dispatcher response barrier reached");
  for (const { json } of workerEntries) {
    assert.match(json.workId, PUBLIC_UUID, "barrier Work identity");
    assert.match(json.aggregateId, PUBLIC_UUID, "barrier aggregate identity");
  }
  const claims = workerEntries.filter(({ json }) => json.point === "worker.claimed");
  const byWork = Map.groupBy(claims, ({ json }) => json.workId);
  const recovered = [...byWork.values()].filter((entries) => {
    const aggregates = new Set(entries.map(({ json }) => json.aggregateId));
    const attempts = new Set(entries.map(({ json }) => json.attempt));
    return aggregates.size === 1 && attempts.size >= 2;
  });
  assert.ok(recovered.length >= (options.minimumRecoveredWork ?? 1), `at least ${options.minimumRecoveredWork ?? 1} Work identities expose replacement attempts`);
  return { claimedWorkCount: byWork.size, recoveredWorkCount: recovered.length, dispatcherCount: dispatcherEntries.length };
}

async function runProjectGate(ctx, script, options = {}) {
  const countersBefore = options.observeDatabase ? await databaseCounters(ctx) : undefined;
  const process = await ctx.startProcess(`gate-${script}`, script, { env: options.env ?? {} });
  const startedAt = performance.now();
  const seenApiPids = new Set();
  const seenWorkerPids = new Set();
  const seenChromiumPids = new Set();
  let priorWorkerPids = new Set();
  let observation = {
    databaseConnections: 0,
    databaseTransactionDelta: 0,
    databaseTupleDelta: 0,
    maxApiProcesses: 0,
    maxWorkerProcesses: 0,
    maxChromiumProcesses: 0,
    maxHttpListeners: 0,
    maxHttpEstablished: 0,
    maxDescendants: 0,
    workerPidDisappearances: 0,
    descendantCommands: [],
  };
  let lastSocketSampleAt = 0;
  const deadline = Date.now() + (options.timeoutMs ?? 1_200_000);
  do {
    const tree = await ctx.command("ps", ["-axo", "pid=,ppid=,command="], { allowFailure: true, timeoutMs: 5_000 });
    if (tree.exitCode === 0) {
      const rows = processRows(tree.stdout);
      const descendants = new Set([process.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) {
          if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
            descendants.add(row.pid);
            changed = true;
          }
        }
      }
      const children = rows.filter(({ pid }) => pid !== process.pid && descendants.has(pid));
      const apiRows = children.filter(({ command }) => /(?:start:api|(?:^|[/ ])(?:api|server)(?:\.[cm]?[jt]s)?(?:\s|$))/iu.test(command));
      const workerRows = children.filter(({ command }) => /(?:start:worker|(?:^|[/ ])worker(?:\.[cm]?[jt]s)?(?:\s|$))/iu.test(command));
      const chromiumRows = children.filter(({ command }) => /(?:^|[/ ])chromium(?:-browser)?(?:\s|$)/iu.test(command));
      observation.maxDescendants = Math.max(observation.maxDescendants, children.length);
      observation.descendantCommands = [...new Set([...observation.descendantCommands, ...children.map(({ command }) => command)])];
      observation.maxApiProcesses = Math.max(observation.maxApiProcesses, apiRows.length);
      observation.maxWorkerProcesses = Math.max(observation.maxWorkerProcesses, workerRows.length);
      observation.maxChromiumProcesses = Math.max(observation.maxChromiumProcesses, chromiumRows.length);
      apiRows.forEach(({ pid }) => seenApiPids.add(pid));
      workerRows.forEach(({ pid }) => seenWorkerPids.add(pid));
      chromiumRows.forEach(({ pid }) => seenChromiumPids.add(pid));
      const currentWorkerPids = new Set(workerRows.map(({ pid }) => pid));
      observation.workerPidDisappearances += [...priorWorkerPids].filter((pid) => !currentWorkerPids.has(pid)).length;
      priorWorkerPids = currentWorkerPids;
      if (Date.now() - lastSocketSampleAt >= 500) {
        const sockets = await inspectHttpSockets(children.map(({ pid }) => pid));
        observation.maxHttpListeners = Math.max(observation.maxHttpListeners, sockets.listeners);
        observation.maxHttpEstablished = Math.max(observation.maxHttpEstablished, sockets.established);
        lastSocketSampleAt = Date.now();
      }
    }
    if (options.observeDatabase) {
      const connections = await ctx.command("psql", [ctx.databaseUrl, "-Atc", "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()"], { allowFailure: true, timeoutMs: 5_000 });
      if (connections.exitCode === 0) observation.databaseConnections = Math.max(observation.databaseConnections, Number(connections.stdout.trim()) || 0);
    }
    if (process.child.exitCode === null) {
      if (Date.now() > deadline) {
        await ctx.kill(process);
        ctx.ok(false, `${script} exceeded evaluator gate deadline`);
      }
      await ctx.sleep(100);
    }
  } while (process.child.exitCode === null);
  const [code, signal] = await process.exited;
  ctx.equal(code, 0, `${script} exit`);
  ctx.equal(signal, null, `${script} signal`);
  if (options.observeDatabase) {
    await ctx.sleep(250);
    const countersAfter = await databaseCounters(ctx);
    ctx.ok(countersBefore && countersAfter, `${script} PostgreSQL statistics are observable`);
    observation.databaseTransactionDelta = Math.max(0, countersAfter.transactions - countersBefore.transactions);
    observation.databaseTupleDelta = Math.max(0, countersAfter.tuplesChanged - countersBefore.tuplesChanged);
  }
  observation.uniqueApiProcessCount = seenApiPids.size;
  observation.uniqueWorkerProcessCount = seenWorkerPids.size;
  observation.uniqueChromiumProcessCount = seenChromiumPids.size;
  return { process, observation, durationMs: performance.now() - startedAt };
}

async function runProjectGateFailure(ctx, script, env, label, timeoutMs = 30_000) {
  const process = await ctx.startProcess(`negative-${script}`, script, { env });
  const exited = await Promise.race([
    process.exited.then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
  if (!exited) {
    await ctx.kill(process);
    ctx.ok(false, `${label} did not fail within dependency watchdog`);
  }
  ctx.ok(exited.code !== 0 || exited.signal !== null, `${label} fails nonzero when its external seam is unavailable`);
  return { process, ...exited };
}

export function assertNonzeroTestReport(logs, label = "gate") {
  const rejected = /(?:0\s+(?:tests?|passing|passed)|tests?\s*[:=]?\s*0|no tests?|all tests? skipped|to[d]o only)/iu;
  if (rejected.test(logs)) throw new Error(`${label} reports zero executed tests`);
  const positive = [/#\s*tests\s+([1-9]\d*)/iu, /ℹ\s*tests\s+([1-9]\d*)/iu, /tests?\s*[:=]\s*([1-9]\d*)\s+(?:passed|passing)/iu, /tests?\s+([1-9]\d*)\s+passed/iu, /([1-9]\d*)\s+(?:tests?\s+)?passing/iu, /(?:passed|passing)\s*[:=]?\s*([1-9]\d*)/iu];
  if (!positive.some((pattern) => pattern.test(logs))) throw new Error(`${label} lacks a nonzero executed test count`);
  return true;
}

function reportedMetric(segment, aliases, label) {
  for (const alias of aliases) {
    const pattern = new RegExp(`${alias}\\s*(?:[:=]|\\s)\\s*([0-9]+(?:\\.[0-9]+)?)`, "iu");
    const match = segment.match(pattern);
    if (match) return Number(match[1]);
  }
  throw new Error(`performance report missing ${label}`);
}

function scenarioSegment(logs, scenario, nextScenarios) {
  const start = logs.indexOf(scenario);
  if (start < 0) throw new Error(`performance report missing ${scenario}`);
  const candidates = nextScenarios.map((name) => logs.indexOf(name, start + scenario.length)).filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : logs.length;
  return logs.slice(start, end);
}

export function assertPermitForgePerformanceReport(logs) {
  const scenarios = ["application-current-read", "application-submit", "permit-deadline-recovery"];
  const read = scenarioSegment(logs, scenarios[0], scenarios.slice(1));
  const submit = scenarioSegment(logs, scenarios[1], [scenarios[2]]);
  const recovery = scenarioSegment(logs, scenarios[2], []);
  for (const [label, segment] of [["read", read], ["submit", submit], ["recovery", recovery]]) {
    for (const metric of ["p50", "p95", "p99"]) reportedMetric(segment, [`${metric}(?:[-_ ]?ms)?`], `${label} ${metric}`);
  }
  const normalizeWindow = (value) => value >= 1_000 ? value / 1_000 : value;
  ctxlessEqual(reportedMetric(read, ["clients?", "concurrency"], "read clients"), 64, "read clients");
  ctxlessEqual(normalizeWindow(reportedMetric(read, ["warm[-_ ]?up(?:Seconds|Ms)?", "warmup(?:Seconds|Ms)?"], "read warmup")), 10, "read warmup seconds");
  ctxlessEqual(normalizeWindow(reportedMetric(read, ["measure(?:Seconds|Ms)?", "measurement(?:Seconds|Ms)?"], "read measurement")), 60, "read measurement seconds");
  ctxlessAtLeast(reportedMetric(read, ["throughput", "successfulReadsPerSecond", "requestsPerSecond"], "read throughput"), 350, "read throughput");
  ctxlessAtMost(reportedMetric(read, ["p95(?:[-_ ]?Ms)?"], "read p95"), 120, "read p95");
  ctxlessEqual(reportedMetric(read, ["unexpected[-_ ]?5xx", "unexpected5xx"], "read unexpected 5xx"), 0, "read unexpected 5xx");
  ctxlessEqual(reportedMetric(read, ["mixed[-_ ]?revisions", "mixedRevision"], "mixed revisions"), 0, "read mixed revisions");

  ctxlessEqual(reportedMetric(submit, ["clients?", "concurrency"], "submit clients"), 64, "submit clients");
  ctxlessEqual(normalizeWindow(reportedMetric(submit, ["warm[-_ ]?up(?:Seconds|Ms)?", "warmup(?:Seconds|Ms)?"], "submit warmup")), 10, "submit warmup seconds");
  ctxlessEqual(normalizeWindow(reportedMetric(submit, ["measure(?:Seconds|Ms)?", "measurement(?:Seconds|Ms)?"], "submit measurement")), 60, "submit measurement seconds");
  ctxlessAtLeast(reportedMetric(submit, ["throughput", "successfulApplicationsPerSecond", "requestsPerSecond"], "submit throughput"), 100, "submit throughput");
  ctxlessAtMost(reportedMetric(submit, ["p95(?:[-_ ]?Ms)?"], "submit p95"), 350, "submit p95");
  ctxlessEqual(reportedMetric(submit, ["unexpected[-_ ]?5xx", "unexpected5xx"], "submit unexpected 5xx"), 0, "submit unexpected 5xx");
  ctxlessEqual(reportedMetric(submit, ["partial[-_ ]?revisions", "partialRevision"], "partial revisions"), 0, "submit partial revisions");

  ctxlessEqual(reportedMetric(recovery, ["workers?", "concurrency"], "recovery workers"), 2, "recovery workers");
  ctxlessEqual(reportedMetric(recovery, ["applications?", "dueWork", "dueApplications"], "recovery applications"), 10_000, "recovery applications");
  ctxlessAtMost(normalizeWindow(reportedMetric(recovery, ["drain(?:Seconds|Ms)?", "duration(?:Seconds|Ms)?", "elapsed(?:Seconds|Ms)?"], "recovery drain")), 75, "recovery drain duration seconds");
  ctxlessEqual(reportedMetric(recovery, ["backlog(?:Remaining)?", "nonterminalWork"], "remaining backlog"), 0, "recovery remaining backlog");
  ctxlessEqual(reportedMetric(recovery, ["stale[-_ ]?decisions", "staleDecision"], "stale decisions"), 0, "recovery stale decisions");
  ctxlessEqual(reportedMetric(recovery, ["invented[-_ ]?permits", "inventedPermit"], "invented permits"), 0, "recovery invented permits");

  const seedStart = logs.indexOf("perf-v1");
  if (seedStart < 0) throw new Error("performance report missing perf-v1 seed identity");
  const seedSegment = logs.slice(seedStart);
  ctxlessEqual(reportedMetric(seedSegment, ["applicants"], "seed applicants"), 20_000, "seed applicants");
  ctxlessEqual(reportedMetric(seedSegment, ["reviewers"], "seed reviewers"), 2_000, "seed reviewers");
  ctxlessEqual(reportedMetric(seedSegment, ["permitApplications", "applications"], "seed Applications"), 20_000, "seed Applications");
  ctxlessEqual(reportedMetric(seedSegment, ["applicationRevisions", "revisions"], "seed Revisions"), 20_000, "seed Revisions");
  ctxlessEqual(reportedMetric(seedSegment, ["reviewClaims", "claims"], "seed Claims"), 20_000, "seed Claims");
  ctxlessEqual(reportedMetric(seedSegment, ["dueWork", "due[-_ ]?work"], "seed due Work"), 10_000, "seed due Work");
  if (!/(?:post[-_ ]?load[-_ ]?invariants?|invariants?)\s*(?:[:=]|\s)\s*(?:pass(?:ed)?|true|ok)/iu.test(logs)) throw new Error("performance report lacks passing post-load invariants");
  return true;
}

function ctxlessEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function ctxlessAtLeast(actual, minimum, label) {
  if (actual < minimum) throw new Error(`${label}: expected >= ${minimum}, got ${actual}`);
}

function ctxlessAtMost(actual, maximum, label) {
  if (actual > maximum) throw new Error(`${label}: expected <= ${maximum}, got ${actual}`);
}

export const D07_EVALUATOR_WORKLOAD = Object.freeze({ apiCount: 2, reads: 64, submissions: 16 });

function assertRetainedIdentities(before, after, identity, label) {
  for (const expected of before) {
    const matches = after.filter((item) => identity(item) === identity(expected));
    assert.equal(matches.length, 1, `${label} ${identity(expected)} retained exactly once`);
    assert.deepEqual(matches[0], expected, `${label} ${identity(expected)} unchanged`);
  }
}

export function assertEvaluatorOwnedPerformanceTraffic(before, after, traffic, options = D07_EVALUATOR_WORKLOAD) {
  assertSnapshot(before, { final: true });
  assertSnapshot(after, { final: true });
  const reads = traffic?.reads ?? [];
  const submissions = traffic?.submissions ?? [];
  assert.equal(reads.length, options.reads, "fixed evaluator-owned read count");
  assert.equal(submissions.length, options.submissions, "fixed evaluator-owned submission count");
  const expectedApis = Array.from({ length: options.apiCount }, (_, index) => index);
  assert.deepEqual([...new Set(reads.map(({ apiIndex }) => apiIndex))].sort((left, right) => left - right), expectedApis, "fixed read traffic reaches every API");
  assert.deepEqual([...new Set(submissions.map(({ apiIndex }) => apiIndex))].sort((left, right) => left - right), expectedApis, "fixed submit traffic reaches every API");

  for (const item of reads) {
    assert.equal(item.path, `/api/v1/permit-applications/${item.applicationId}`, "read uses the published performance route");
    assert.equal(item.response?.status, 200, `${item.applicationId} real read status`);
    const authority = assertAggregateDetailAuthority(item.response.json, before, item.applicationId);
    assert.deepEqual(authority.application, applicationFrom(before, item.applicationId), `${item.applicationId} read Application equals pre-load snapshot`);
  }

  const submittedIds = [];
  for (const item of submissions) {
    assert.equal(item.path, "/api/v1/permit-applications", "submit uses the published performance route");
    assert.equal(item.response?.status, 201, "real submit status");
    const responseApplications = findObjects(item.response.json, "currentRevision").filter(({ applicationId, currentRevision }) => typeof applicationId === "string" && Number.isSafeInteger(currentRevision));
    const responseRevisions = after.resources.applicationRevisions.filter(revision => revision.applicationId === item.response.json.applicationId && revision.revision === item.response.json.currentRevision);
    assert.equal(responseApplications.length, 1, "submit response exposes one Application");
    assert.equal(responseRevisions.length, 1, "submitted identity has one authoritative Revision");
    const [application] = responseApplications;
    const [revision] = responseRevisions;
    assertPermitApplication(application, { final: true });
    assertApplicationRevision(revision);
    assert.equal(application.applicationId, revision.applicationId, "submit response Application and Revision identity");
    assert.equal(application.applicantId, item.body.applicantId, "submit Applicant captured");
    assert.equal(application.permitType, item.body.permitType, "submit permit type captured");
    assert.equal(application.deadlineAt, item.body.deadlineAt, "submit deadline captured");
    assert.equal(application.currentRevision, 1, "submit current Revision 1");
    assert.equal(application.currentStageOrdinal, 1, "submit current Stage 1");
    assert.equal(application.state, "SUBMITTED", "submit state");
    assert.deepEqual(revision.fields, item.body.fields, "submit fields captured");
    assert.deepEqual(revision.policy, item.body.reviewPolicy, "submit policy captured");

    const persistedApplication = after.resources.permitApplications.filter(({ applicationId }) => applicationId === application.applicationId);
    const persistedRevision = after.resources.applicationRevisions.filter(({ applicationId }) => applicationId === application.applicationId);
    const persistedStages = after.resources.reviewStages.filter(({ applicationId }) => applicationId === application.applicationId);
    const persistedWork = after.work.filter(({ aggregateId }) => aggregateId === application.applicationId);
    const persistedEvents = after.events.filter(({ aggregateId }) => aggregateId === application.applicationId);
    assert.deepEqual(persistedApplication, [application], `${application.applicationId} response Application equals snapshot`);
    assert.deepEqual(persistedRevision, [revision], `${application.applicationId} response Revision equals snapshot`);
    assert.equal(persistedStages.length, 1, `${application.applicationId} exact one Stage`);
    assertReviewStage(persistedStages[0]);
    assert.equal(persistedStages[0].revision, 1, `${application.applicationId} Stage Revision`);
    assert.equal(persistedStages[0].ordinal, 1, `${application.applicationId} Stage ordinal`);
    assert.equal(persistedStages[0].state, "ACTIVE", `${application.applicationId} Stage active`);
    assert.deepEqual(persistedStages[0].policy, item.body.reviewPolicy, `${application.applicationId} Stage policy`);
    assert.deepEqual(application.stages, persistedStages, `${application.applicationId} embedded Stages equal snapshot`);
    assert.equal(persistedWork.length, 1, `${application.applicationId} exact one Work`);
    assertWork(persistedWork[0]);
    assert.equal(persistedWork[0].state, "PENDING", `${application.applicationId} Deadline Work pending`);
    assert.equal(persistedWork[0].terminal, false, `${application.applicationId} Deadline Work nonterminal`);
    assert.equal(persistedEvents.length, 1, `${application.applicationId} exact one Event`);
    assertDomainEvent(persistedEvents[0]);
    assert.equal(persistedEvents[0].sequence, 1, `${application.applicationId} submitted Event sequence`);
    assert.equal(persistedEvents[0].type, "application.submitted", `${application.applicationId} submitted Event type`);
    assert.equal(after.resources.reviewClaims.filter(({ applicationId }) => applicationId === application.applicationId).length, 0, `${application.applicationId} no partial Claim`);
    assert.equal(after.resources.reviewDecisions.filter(({ applicationId }) => applicationId === application.applicationId).length, 0, `${application.applicationId} no partial Decision`);
    assert.equal(after.resources.approvedPermits.filter(({ applicationId }) => applicationId === application.applicationId).length, 0, `${application.applicationId} no invented Permit`);
    submittedIds.push(application.applicationId);
  }
  assert.equal(new Set(submittedIds).size, submissions.length, "fixed submissions have unique Application identities");

  const addedApplications = after.resources.permitApplications.filter(({ applicationId }) => !before.resources.permitApplications.some((item) => item.applicationId === applicationId));
  assert.deepEqual(addedApplications.map(({ applicationId }) => applicationId).sort(), [...submittedIds].sort(), "only complete evaluator-owned submissions are added");
  for (const [name, expectedDelta] of [["permitApplications", submissions.length], ["applicationRevisions", submissions.length], ["reviewStages", submissions.length]]) {
    assert.equal(after.resources[name].length, before.resources[name].length + expectedDelta, `${name} exact workload delta`);
  }
  assert.equal(after.work.length, before.work.length + submissions.length, "Work exact workload delta");
  assert.equal(after.events.length, before.events.length + submissions.length, "Event exact workload delta");
  for (const name of ["applicants", "reviewers", "reviewClaims", "reviewDecisions", "approvedPermits"]) assert.deepEqual(after.resources[name], before.resources[name], `${name} unchanged by fixed workload`);
  assertRetainedIdentities(before.resources.permitApplications, after.resources.permitApplications, ({ applicationId }) => applicationId, "Application");
  assertRetainedIdentities(before.resources.applicationRevisions, after.resources.applicationRevisions, ({ applicationId, revision }) => `${applicationId}:${revision}`, "Revision");
  assertRetainedIdentities(before.resources.reviewStages, after.resources.reviewStages, ({ stageId }) => stageId, "Stage");
  assertRetainedIdentities(before.work, after.work, ({ workId }) => workId, "Work");
  assertRetainedIdentities(before.events, after.events, ({ eventId }) => eventId, "Event");
  return true;
}

export const D01_FROZEN_ROUTES = Object.freeze([
  "GET /api/v1/permitApplications",
  "GET /api/v1/permitApplications/{permitApplicationId}",
  "POST /api/v1/permit-applications",
  "POST /api/v1/permit-applications/{applicationId}/review-claims",
  "POST /api/v1/review-claims/{claimId}/decisions",
  "POST /api/v1/permit-applications/{applicationId}/revisions",
  "GET /api/v1/permit-applications/{applicationId}",
  "GET /api/v1/permit-applications/{applicationId}/revisions/{revision}",
  "GET /api/v1/permit-applications/{applicationId}/stages",
  "GET /api/v1/domain-events",
  "GET /api/v1/verification-snapshot",
]);

const IDEMPOTENCY_PARAMETER = Object.freeze({ name: "Idempotency-Key", in: "header", required: true, type: "string", minLength: 1, maxLength: 128 });
const APPLICATION_ID_PARAMETER = Object.freeze({ name: "applicationId", in: "path", required: true, type: "string", format: "uuid" });

export const D01_OPERATION_CONTRACTS = Object.freeze({
  "GET /api/v1/permitApplications": Object.freeze({ statuses: Object.freeze(["200", "400"]), parameters: Object.freeze([
    Object.freeze({ name: "limit", in: "query", required: false, type: "integer", minimum: 1, maximum: 100 }),
    Object.freeze({ name: "cursor", in: "query", required: false, type: "string" }),
  ]) }),
  "GET /api/v1/permitApplications/{permitApplicationId}": Object.freeze({ statuses: Object.freeze(["200", "400", "404"]), parameters: Object.freeze([
    Object.freeze({ name: "permitApplicationId", in: "path", required: true, type: "string", format: "uuid" }),
  ]) }),
  "POST /api/v1/permit-applications": Object.freeze({ statuses: Object.freeze(["201", "400", "409", "415"]), parameters: Object.freeze([IDEMPOTENCY_PARAMETER]) }),
  "POST /api/v1/permit-applications/{applicationId}/review-claims": Object.freeze({ statuses: Object.freeze(["200", "400", "404", "409", "415"]), parameters: Object.freeze([APPLICATION_ID_PARAMETER, IDEMPOTENCY_PARAMETER]) }),
  "POST /api/v1/review-claims/{claimId}/decisions": Object.freeze({ statuses: Object.freeze(["200", "400", "404", "409", "415"]), parameters: Object.freeze([
    Object.freeze({ name: "claimId", in: "path", required: true, type: "string", format: "uuid" }),
    IDEMPOTENCY_PARAMETER,
  ]) }),
  "POST /api/v1/permit-applications/{applicationId}/revisions": Object.freeze({ statuses: Object.freeze(["200", "400", "404", "409", "415"]), parameters: Object.freeze([APPLICATION_ID_PARAMETER, IDEMPOTENCY_PARAMETER]) }),
  "GET /api/v1/permit-applications/{applicationId}": Object.freeze({ statuses: Object.freeze(["200", "400", "404"]), parameters: Object.freeze([APPLICATION_ID_PARAMETER]) }),
  "GET /api/v1/permit-applications/{applicationId}/revisions/{revision}": Object.freeze({ statuses: Object.freeze(["200", "400", "404"]), parameters: Object.freeze([
    APPLICATION_ID_PARAMETER,
    Object.freeze({ name: "revision", in: "path", required: true, type: "integer", minimum: 1 }),
  ]) }),
  "GET /api/v1/permit-applications/{applicationId}/stages": Object.freeze({ statuses: Object.freeze(["200", "400", "404"]), parameters: Object.freeze([APPLICATION_ID_PARAMETER]) }),
  "GET /api/v1/domain-events": Object.freeze({ statuses: Object.freeze(["200", "400"]), parameters: Object.freeze([
    Object.freeze({ name: "aggregateId", in: "query", required: true, type: "string", format: "uuid" }),
    Object.freeze({ name: "afterSequence", in: "query", required: true, type: "integer", minimum: 0 }),
    Object.freeze({ name: "limit", in: "query", required: true, type: "integer", minimum: 1, maximum: 100 }),
  ]) }),
  "GET /api/v1/verification-snapshot": Object.freeze({ statuses: Object.freeze(["200", "401"]), parameters: Object.freeze([]) }),
});

export const D05_VIEWPORTS = Object.freeze({ mobile: Object.freeze({ width: 390, height: 844 }), desktop: Object.freeze({ width: 1280, height: 900 }) });
export const D05_STATES = Object.freeze(["empty", "validation", "loading", "stale-conflict", "offline-retry", "terminal", "permission"]);

export const D08_LEDGER_NODES = Object.freeze([
  "migration",
  "seed",
  "production-build",
  "production-boot",
  "collection-read",
  "aggregate-detail",
  "immutable-revision",
  "captured-policy",
  "staged-submit",
  "current-stage-claim",
  "replacement-revision",
  "durable-idempotency",
  "validation-error",
  "deadline-work",
  "transactional-event",
  "dispatcher-delivery",
  "openapi-runtime",
  "browser-authority",
  "verification-snapshot",
  "seeded-decision-history",
  "seeded-permit-history",
]);

export const D08_HIDDEN_CASE_IDS = Object.freeze([
  "A-01", "A-02", "A-03", "A-04", "A-05", "A-06", "A-07", "A-08", "A-09", "A-10", "A-11", "A-12", "A-13", "A-14", "A-15",
  "B-01", "B-02", "B-03", "B-04", "B-05", "B-06", "B-07", "B-08", "B-09", "B-10",
  "C-01", "C-02", "C-03", "C-04", "C-05", "C-06", "C-07", "C-08",
  "D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08",
  "E-01", "E-02", "E-03", "E-04", "E-05", "E-06", "E-07",
]);
export const D08_LEGACY_EXCLUDED_IDS = Object.freeze(["E-01", "E-02", "E-03"]);
const D08_LEGACY_EXCLUDED = new Set(D08_LEGACY_EXCLUDED_IDS);

export function assertExecutableCaseEvidence(outcomes, expectedIds = D08_HIDDEN_CASE_IDS) {
  assert.ok(Array.isArray(outcomes), "D-08 prior Case evidence array");
  const byId = new Map();
  for (const outcome of outcomes) {
    assert.ok(outcome && typeof outcome.id === "string", "D-08 Case evidence id");
    assert.equal(byId.has(outcome.id), false, `D-08 duplicate Case evidence ${outcome.id}`);
    byId.set(outcome.id, outcome);
  }
  const evidence = {};
  for (const id of expectedIds) {
    if (id === "D-08") continue;
    const outcome = byId.get(id);
    assert.ok(outcome, `D-08 prerequisite ${id} is unrun`);
    assert.match(outcome.evidenceDigest ?? "", /^[0-9a-f]{64}$/u, `D-08 prerequisite ${id} has executable evidence`);
    if (outcome.status === "excluded") {
      assert.ok(D08_LEGACY_EXCLUDED.has(id), `D-08 prerequisite ${id} cannot be excluded`);
      assert.equal(outcome.reason, MISSING_V1_CHECKPOINT_REASON, `D-08 prerequisite ${id} exclusion reason`);
      assert.equal(
        isMissingV1CheckpointOutcome({ id, prerequisites: ["V1"] }, outcome),
        true,
        `D-08 prerequisite ${id} has a valid single-route V1 exclusion`,
      );
      evidence[id] = Object.freeze({
        status: "excluded",
        reason: outcome.reason,
        evidenceDigest: outcome.evidenceDigest,
      });
      continue;
    }
    assert.ok(["passed", "diagnostic"].includes(outcome.status), `D-08 prerequisite ${id} is ${outcome.status}`);
    assertPermitForgeEvidenceSummary(outcome.privateEvidenceSummary, id);
    evidence[id] = Object.freeze({
      status: outcome.status,
      evidenceDigest: outcome.evidenceDigest,
      privateEvidenceSummary: structuredClone(outcome.privateEvidenceSummary),
      ...(outcome.status === "diagnostic" ? { diagnostics: structuredClone(outcome.diagnostics ?? []) } : {}),
    });
  }
  return Object.freeze({
    evidence: Object.freeze(evidence),
    passed: Object.values(evidence).filter(({ status }) => status === "passed").length,
    partial: Object.values(evidence).filter(({ status }) => status === "diagnostic").length,
    excluded: Object.values(evidence).filter(({ status }) => status === "excluded").length,
  });
}

export function assertRequirementLayerEvidence(evidence, chains = D08_REQUIREMENT_CHAINS) {
  for (const item of chains) {
    const cited = item.hiddenCases.filter((id) => id !== "D-08").map((id) => evidence[id]);
    assert.ok(cited.length > 0 && cited.every(Boolean), `${item.node} has complete cited Case evidence`);
    const applicable = cited.filter(({ status }) => status !== "excluded");
    assert.ok(applicable.length > 0, `${item.node} has no applicable cited Case evidence`);
    const observed = new Set(applicable.flatMap(({ privateEvidenceSummary }) => Object.keys(privateEvidenceSummary.layers)));
    for (const layer of item.layers.filter((value) => value !== "hidden-case")) {
      assert.ok(observed.has(layer), `${item.node} lacks observed ${layer} evidence from its cited Cases`);
    }
  }
  return true;
}

const chain = (node, requirement, layers, hiddenCases) => Object.freeze({ node, requirement, layers: Object.freeze(layers), hiddenCases: Object.freeze(hiddenCases) });

export const D08_REQUIREMENT_CHAINS = Object.freeze([
  chain("migration", "Forward-only repeatable migration preserves populated V1 identities and saved authority", ["migration", "HTTP", "snapshot", "work", "event", "hidden-case"], ["A-02", "E-01", "E-02", "E-03"]),
  chain("seed", "Strict versioned seed import is atomic and reference-complete", ["seed", "snapshot", "work", "event", "hidden-case"], ["A-03"]),
  chain("production-build", "Published production build and every project-owned gate execute real work", ["build", "PostgreSQL", "HTTP", "Chromium", "hidden-case"], ["D-07", "E-07"]),
  chain("production-boot", "Production API UI Worker and Dispatcher boot with observable operability", ["process", "HTTP", "UI", "work", "event", "hidden-case"], ["A-01", "D-07", "E-07"]),
  chain("collection-read", "Stable paginated collection and current reads expose exact public authority", ["HTTP", "OpenAPI", "snapshot", "hidden-case"], ["A-05", "D-01", "E-04"]),
  chain("aggregate-detail", "Aggregate detail closes Application current Revision policy histories and Permit", ["HTTP", "OpenAPI", "UI", "snapshot", "hidden-case"], ["A-05", "D-01", "D-06", "E-04"]),
  chain("immutable-revision", "Revision 1 and replacement Revision histories are contiguous canonical and immutable", ["HTTP", "OpenAPI", "UI", "snapshot", "event", "hidden-case"], ["A-06", "B-01", "D-01", "D-06", "E-05"]),
  chain("captured-policy", "Captured role quotas and total quorum determine projection from immutable Decisions", ["HTTP", "UI", "snapshot", "hidden-case"], ["A-08", "A-09", "B-02", "D-02"]),
  chain("staged-submit", "One through five ordered Stages are created atomically with per-Stage policies", ["HTTP", "OpenAPI", "UI", "snapshot", "work", "event", "hidden-case"], ["A-13", "B-09", "D-01", "D-04"]),
  chain("current-stage-claim", "Only eligible current-Stage reviewers obtain one fenced Claim", ["HTTP", "OpenAPI", "UI", "snapshot", "event", "hidden-case"], ["A-07", "A-14", "B-03", "B-04", "B-10", "C-06", "D-01", "D-04"]),
  chain("replacement-revision", "CHANGES_REQUIRED replacement serializes against Claim and deadline competitors", ["HTTP", "OpenAPI", "UI", "snapshot", "work", "event", "hidden-case"], ["A-10", "B-05", "B-06", "D-01", "D-03"]),
  chain("durable-idempotency", "Unknown outcomes and multi-API retries replay one saved operation effect", ["HTTP", "snapshot", "work", "event", "hidden-case"], ["B-07", "B-08", "E-02"]),
  chain("validation-error", "Every rejected public request returns the exact error and zero side effects", ["HTTP", "OpenAPI", "UI", "snapshot", "work", "event", "hidden-case"], ["A-04", "D-01", "D-05"]),
  chain("deadline-work", "One retained Deadline Work expires undecided Applications under lease fencing and recovery", ["HTTP", "UI", "snapshot", "work", "event", "hidden-case"], ["A-11", "B-06", "B-10", "C-01", "C-02", "C-03", "C-04", "C-05", "D-03", "E-06"]),
  chain("transactional-event", "Committed transitions emit one gapless Event and rolled-back transitions emit none", ["HTTP", "snapshot", "event", "hidden-case"], ["A-12", "C-08"]),
  chain("dispatcher-delivery", "Dispatcher retries one stable Event identity across unknown ACK and replacement", ["HTTP", "receiver", "snapshot", "event", "hidden-case"], ["C-07", "C-08"]),
  chain("openapi-runtime", "OpenAPI 3.1 exact requests responses headers formats and statuses match live traffic", ["HTTP", "OpenAPI", "hidden-case"], ["D-01"]),
  chain("browser-authority", "Production desktop and mobile Chromium render and mutate server authority accessibly", ["HTTP", "OpenAPI", "UI", "snapshot", "work", "event", "hidden-case"], ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-08"]),
  chain("verification-snapshot", "Point-in-time snapshot closes exact sorted resources Work Events and secret omission", ["HTTP", "snapshot", "work", "event", "hidden-case"], ["A-05", "A-15", "D-06"]),
  chain("seeded-decision-history", "Seeded quorum veto and change histories retain exact Decision authority", ["HTTP", "UI", "snapshot", "event", "hidden-case"], ["A-08", "A-09", "D-02", "E-01"]),
  chain("seeded-permit-history", "Only approved histories expose one canonical Permit across migration and UI", ["HTTP", "UI", "snapshot", "event", "hidden-case"], ["A-08", "A-09", "D-02", "E-01"]),
]);

const d01 = defineCase(
  "D-01",
  "PF-F-FINAL-STAGES OpenAPI traffic corpus",
  "Fetch the FINAL OpenAPI document, execute successful and published-error traffic for each frozen read and non-Decision mutation route and compare closed runtime shapes",
  "OpenAPI is 3.1, publishes closed request and response schemas with actual statuses, and every sampled Application, Revision, Claim, Stage, Event and error wire matches an independent oracle",
  ["OpenAPI HTTP", "live public HTTP", "independent resource oracles", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.finalStages("d01");
    const changes = ctx.fixtures.history("d01-changes", "CHANGES_REQUIRED");
    const claimable = ctx.fixtures.history("d01-claimable", "SUBMITTED");
    const { api } = await boot(ctx, { family, seed: ctx.fixtures.seedFromHistories("d01", [changes, claimable]) });
    const document = await openApi(ctx, api.baseUrl);
    const traffic = new Map();
    const trafficFor = (path, method) => {
      const key = `${method.toUpperCase()} ${path}`;
      if (!traffic.has(key)) traffic.set(key, { validRequests: [], validResponses: [] });
      return traffic.get(key);
    };
    const checkedResponse = (path, method, response, label, expectedStatus) => {
      requireStatus(ctx, response, expectedStatus, label);
      ctx.assert(`${label} matches published response`, () => assertOpenApiResponse(document, path, method, response));
      exactPublishedResponse(ctx, document, path, method, response, label);
      trafficFor(path, method).validResponses.push(response);
      return response;
    };
    const checkedRequest = (path, method, body, label) => {
      ctx.assert(`${label} matches published request`, () => assertOpenApiRequest(document, path, method, body));
      exactPublishedRequest(ctx, document, path, method, body, label);
      trafficFor(path, method).validRequests.push(body);
      return body;
    };
    const rawPost = (path, label, raw = "{}", contentType = "text/plain") => ctx.request(api.baseUrl, path, {
      method: "POST",
      headers: { "content-type": contentType, "idempotency-key": ctx.key(label) },
      raw,
      contractExpectation: "invalid",
    });
    const missingId = ctx.fixtures.uuid("d01-missing");

    const listPath = "/api/v1/permitApplications";
    checkedResponse(listPath, "get", await ctx.request(api.baseUrl, `${listPath}?limit=100`), "camel collection success", 200);
    checkedResponse(listPath, "get", expectError(ctx, await ctx.request(api.baseUrl, `${listPath}?cursor=%25invalid`), 400, "INVALID_CURSOR"), "camel collection error", 400);
    const camelDetailPath = "/api/v1/permitApplications/{permitApplicationId}";
    checkedResponse(camelDetailPath, "get", await ctx.request(api.baseUrl, `/api/v1/permitApplications/${claimable.application.applicationId}`), "camel detail success", 200);
    checkedResponse(camelDetailPath, "get", expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/permitApplications/not-a-uuid", { contractExpectation: "invalid" }), 400, "INVALID_REQUEST"), "camel detail validation error", 400);
    checkedResponse(camelDetailPath, "get", expectError(ctx, await ctx.request(api.baseUrl, `/api/v1/permitApplications/${missingId}`), 404, "NOT_FOUND"), "camel detail error", 404);

    const submitPath = "/api/v1/permit-applications";
    const legacySubmitBody = checkedRequest(submitPath, "post", ctx.fixtures.submissionBody("d01-legacy"), "legacy submit");
    const legacyCreated = await submitApplication(ctx, api.baseUrl, legacySubmitBody, "d01-legacy");
    checkedResponse(submitPath, "post", legacyCreated.response, "legacy submit success", 201);
    ctx.assert("legacy submit Application exact", () => assertPermitApplication(legacyCreated.application, { final: true }));
    ctx.assert("legacy submit Revision exact", () => assertApplicationRevision(legacyCreated.revision));
    const submitBody = checkedRequest(submitPath, "post", ctx.fixtures.stagedBody(2, "d01"), "staged submit");
    const created = await submitApplication(ctx, api.baseUrl, submitBody, "d01-staged");
    checkedResponse(submitPath, "post", created.response, "staged submit success", 201);
    ctx.assert("submit Application exact", () => assertPermitApplication(created.application, { final: true }));
    ctx.assert("submit Revision exact", () => assertApplicationRevision(created.revision));
    const applicationId = created.application.applicationId;
    const submitError = expectError(ctx, await ctx.mutate(api.baseUrl, submitPath, ctx.key("d01-submit-error"), { ...ctx.fixtures.submissionBody("d01-error"), unknown: true }, { contractExpectation: "invalid" }), 400, "UNKNOWN_FIELD");
    checkedResponse(submitPath, "post", submitError, "submit error", 400);
    const submitConflict = expectError(ctx, await ctx.mutate(api.baseUrl, submitPath, ctx.key("d01-staged"), { ...submitBody, permitType: `${submitBody.permitType}-changed` }), 409, "IDEMPOTENCY_CONFLICT");
    checkedResponse(submitPath, "post", submitConflict, "submit idempotency conflict", 409);
    checkedResponse(submitPath, "post", expectError(ctx, await rawPost(submitPath, "d01-submit-media"), 415, "UNSUPPORTED_MEDIA_TYPE"), "submit media error", 415);

    const claimPath = "/api/v1/permit-applications/{applicationId}/review-claims";
    const claimBody = checkedRequest(claimPath, "post", { reviewerId: family.securityReviewers[0].reviewerId, role: "security" }, "Claim");
    const claim = await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("d01-claim"), claimBody);
    requireStatus(ctx, claim, 200, "live Claim");
    const claimResource = publicClaim(claim.json);
    ctx.assert("Claim exact runtime resource", () => assertReviewClaim(claimResource));
    const claimError = expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("d01-claim-error"), { reviewerId: family.securityReviewers[0].reviewerId, role: "legal" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    checkedResponse(claimPath, "post", claimError, "Claim error", 409);
    checkedResponse(claimPath, "post", expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("d01-claim-shape"), { ...claimBody, unknown: true }, { contractExpectation: "invalid" }), 400, "UNKNOWN_FIELD"), "Claim validation error", 400);
    checkedResponse(claimPath, "post", expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${missingId}/review-claims`, ctx.key("d01-claim-missing"), claimBody), 404, "NOT_FOUND"), "Claim missing error", 404);
    checkedResponse(claimPath, "post", expectError(ctx, await rawPost(`/api/v1/permit-applications/${applicationId}/review-claims`, "d01-claim-media"), 415, "UNSUPPORTED_MEDIA_TYPE"), "Claim media error", 415);

    const decisionPath = "/api/v1/review-claims/{claimId}/decisions";
    const decisionBody = checkedRequest(decisionPath, "post", { claimToken: "deliberately-not-the-issued-token", decision: "APPROVE", reason: "OpenAPI error traffic" }, "Decision error");
    const decisionError = expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/review-claims/${claimResource.claimId}/decisions`, ctx.key("d01-decision-error"), decisionBody), 409, "REVIEW_LEASE_LOST");
    checkedResponse(decisionPath, "post", decisionError, "Decision published error", 409);
    checkedResponse(decisionPath, "post", expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/review-claims/${claimResource.claimId}/decisions`, ctx.key("d01-decision-shape"), { ...decisionBody, unknown: true }, { contractExpectation: "invalid" }), 400, "UNKNOWN_FIELD"), "Decision validation error", 400);
    checkedResponse(decisionPath, "post", expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/review-claims/${missingId}/decisions`, ctx.key("d01-decision-missing"), decisionBody), 404, "NOT_FOUND"), "Decision missing error", 404);
    checkedResponse(decisionPath, "post", expectError(ctx, await rawPost(`/api/v1/review-claims/${claimResource.claimId}/decisions`, "d01-decision-media"), 415, "UNSUPPORTED_MEDIA_TYPE"), "Decision media error", 415);

    const revisionPath = "/api/v1/permit-applications/{applicationId}/revisions";
    const replacementBody = checkedRequest(revisionPath, "post", { expectedRevision: 1, fields: { replacement: "d01" }, deadlineAt: ctx.at({ days: 6 }), reviewPolicy: family.policy }, "replacement Revision");
    const replacement = await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${changes.application.applicationId}/revisions`, ctx.key("d01-revision"), replacementBody);
    requireStatus(ctx, replacement, 200, "replacement Revision");
    checkedResponse(revisionPath, "post", replacement, "replacement Revision success", 200);
    const staleReplacement = expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${changes.application.applicationId}/revisions`, ctx.key("d01-revision-stale"), replacementBody), 409, "APPLICATION_REVISION_CHANGED");
    checkedResponse(revisionPath, "post", staleReplacement, "replacement Revision error", 409);
    checkedResponse(revisionPath, "post", expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${changes.application.applicationId}/revisions`, ctx.key("d01-revision-shape"), { ...replacementBody, unknown: true }, { contractExpectation: "invalid" }), 400, "UNKNOWN_FIELD"), "replacement Revision validation error", 400);
    checkedResponse(revisionPath, "post", expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${missingId}/revisions`, ctx.key("d01-revision-missing"), replacementBody), 404, "NOT_FOUND"), "replacement Revision missing error", 404);
    checkedResponse(revisionPath, "post", expectError(ctx, await rawPost(`/api/v1/permit-applications/${changes.application.applicationId}/revisions`, "d01-revision-media"), 415, "UNSUPPORTED_MEDIA_TYPE"), "replacement Revision media error", 415);

    const detailPath = "/api/v1/permit-applications/{applicationId}";
    checkedResponse(detailPath, "get", await applicationDetail(ctx, api.baseUrl, applicationId), "aggregate detail success", 200);
    checkedResponse(detailPath, "get", expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/permit-applications/not-a-uuid", { contractExpectation: "invalid" }), 400, "INVALID_REQUEST"), "aggregate detail validation error", 400);
    checkedResponse(detailPath, "get", expectError(ctx, await ctx.request(api.baseUrl, `/api/v1/permit-applications/${missingId}`), 404, "NOT_FOUND"), "aggregate detail error", 404);
    const revisionDetailPath = "/api/v1/permit-applications/{applicationId}/revisions/{revision}";
    const revisionOne = await revisionDetail(ctx, api.baseUrl, applicationId, 1);
    checkedResponse(revisionDetailPath, "get", revisionOne.response, "Revision detail success", 200);
    checkedResponse(revisionDetailPath, "get", expectError(ctx, await ctx.request(api.baseUrl, `/api/v1/permit-applications/${applicationId}/revisions/0`, { contractExpectation: "invalid" }), 400, "INVALID_REQUEST"), "Revision detail validation error", 400);
    checkedResponse(revisionDetailPath, "get", expectError(ctx, await ctx.request(api.baseUrl, `/api/v1/permit-applications/${applicationId}/revisions/999`), 404, "NOT_FOUND"), "Revision detail error", 404);
    const stagesPath = "/api/v1/permit-applications/{applicationId}/stages";
    const stagesResponse = await ctx.request(api.baseUrl, `/api/v1/permit-applications/${applicationId}/stages`);
    checkedResponse(stagesPath, "get", stagesResponse, "Stages success", 200);
    const stages = await stagesDetail(ctx, api.baseUrl, applicationId);
    ctx.assert("OpenAPI staged response matches runtime", () => assertStageSet(stages, 2));
    checkedResponse(stagesPath, "get", expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/permit-applications/not-a-uuid/stages", { contractExpectation: "invalid" }), 400, "INVALID_REQUEST"), "Stages validation error", 400);
    checkedResponse(stagesPath, "get", expectError(ctx, await ctx.request(api.baseUrl, `/api/v1/permit-applications/${missingId}/stages`), 404, "NOT_FOUND"), "Stages error", 404);
    const eventsPath = "/api/v1/domain-events";
    checkedResponse(eventsPath, "get", await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${applicationId}&afterSequence=0&limit=100`), "Events success", 200);
    await domainEvents(ctx, api.baseUrl, { aggregateId: applicationId, afterSequence: "0", limit: "100" });
    checkedResponse(eventsPath, "get", expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/domain-events?limit=0", { contractExpectation: "invalid" }), 400, "INVALID_REQUEST"), "Events error", 400);
    const snapshotPath = "/api/v1/verification-snapshot";
    const snapshotResponse = await ctx.request(api.baseUrl, snapshotPath, { headers: { authorization: `Bearer ${ctx.adminToken}` } });
    requireStatus(ctx, snapshotResponse, 200, "snapshot success");
    checkedResponse(snapshotPath, "get", snapshotResponse, "snapshot success", 200);
    checkedResponse(snapshotPath, "get", expectError(ctx, await ctx.request(api.baseUrl, snapshotPath, { contractExpectation: "invalid" }), 401, "ADMIN_AUTH_REQUIRED"), "snapshot error", 401);
    const state = await snapshot(ctx, api.baseUrl);
    for (const name of ["PermitApplication", "ApplicationRevision", "ReviewPolicy", "ReviewClaim", "ReviewDecision", "ApprovedPermit", "ReviewStage", "Work", "DomainEvent"]) ctx.ok(document.components.schemas[name], `${name} OpenAPI schema exists`);
    ctx.assert("FINAL OpenAPI exact component fields required nullable enums and formats", () => assertPermitForgeOpenApiComponents(ctx, document));

    const invalidRequests = new Map([
      [submitPath, [
        { ...submitBody, unknown: true },
        { ...submitBody, deadlineAt: "not-a-timestamp" },
        { ...submitBody, reviewPolicy: family.policy },
        Object.fromEntries(Object.entries(submitBody).filter(([key]) => key !== "stages")),
        { ...submitBody, stages: submitBody.stages.map((stage, index) => index === 0 ? { ...stage, unknown: true } : stage) },
        Object.fromEntries(Object.entries(submitBody).filter(([key]) => key !== "applicantId")),
      ]],
      [claimPath, [{ ...claimBody, unknown: true }, { ...claimBody, reviewerId: "not-a-uuid" }, {}]],
      [decisionPath, [{ ...decisionBody, unknown: true }, { ...decisionBody, decision: "MAYBE" }, {}]],
      [revisionPath, [{ ...replacementBody, unknown: true }, { ...replacementBody, expectedRevision: 0 }, {}]],
    ]);
    for (const route of D01_FROZEN_ROUTES) {
      const separator = route.indexOf(" ");
      const method = route.slice(0, separator).toLowerCase();
      const path = route.slice(separator + 1);
      const base = D01_OPERATION_CONTRACTS[route];
      const observed = traffic.get(route) ?? { validRequests: [], validResponses: [] };
      const validResponses = route === `POST ${claimPath}` ? observed.validResponses.filter(({ status }) => status !== 200) : observed.validResponses;
      const invalidResponses = validResponses.flatMap((response) => response.json?.error ? [exactErrorSample(response)] : corruptClosedObject(response));
      ctx.assert(`${route} exact independent OpenAPI operation`, () => assertExactOpenApiOperation(document, path, method, {
        ...base,
        validRequests: observed.validRequests,
        invalidRequests: invalidRequests.get(path) ?? [],
        validResponses,
        invalidResponses,
      }));
    }
    const snapshotOperation = document.paths[snapshotPath].get;
    const securityRequirements = snapshotOperation.security ?? [];
    ctx.equal(securityRequirements.length, 1, "snapshot has exactly one OpenAPI security requirement");
    const [securityName] = Object.keys(securityRequirements[0] ?? {});
    ctx.ok(securityName, "snapshot names a security scheme");
    ctx.equal(securityRequirements[0][securityName], [], "snapshot bearer scheme has no scopes");
    ctx.equal(document.components.securitySchemes[securityName].type, "http", "snapshot security type");
    ctx.equal(document.components.securitySchemes[securityName].scheme, "bearer", "snapshot security scheme");
    return caseResult(ctx, { applicationId, openapi: document.openapi, frozenRoutesExercised: D01_FROZEN_ROUTES.length, eventCount: state.events.filter(({ aggregateId }) => aggregateId === applicationId).length });
  },
  [blocked("PF-D01-CLAIM-SUCCESS-ENVELOPE", "PF-GAP-01")],
);

const d02 = defineCase(
  "D-02",
  "PF-F-BROWSER V1 authority histories",
  "Use only visible keyboard controls in the production UI to submit a V1 Application and claim it, then inspect seeded quorum, terminal, Decision, Permit and Revision histories after refresh",
  "The browser exposes the concrete server-issued Application, Revision and Claim IDs and displays seeded immutable authority rather than browser-local projections",
  ["production build", "system Chromium", "visible labeled controls", "real API and PostgreSQL"],
  async (ctx) => {
    const family = ctx.fixtures.projections();
    const { api } = await boot(ctx, { family, build: true });
    const { page } = await launchBrowser(ctx, api);
    const submitted = await browserSubmitLegacy(ctx, page, family, "d02-browser");
    const securityReviewer = family.reviewers.find(({ roles }) => roles.includes("security"));
    const claim = await browserClaim(ctx, page, submitted.application.applicationId, securityReviewer.reviewerId, "security", "d02");
    await page.reload({ waitUntil: "networkidle" });
    await expectVisibleIdentity(page, submitted.application.applicationId);
    await expectVisibleIdentity(page, claim.claim.claimId);
    const state = await snapshot(ctx, api.baseUrl);
    const submittedAuthority = aggregateResources(state, submitted.application.applicationId);
    ctx.equal(submittedAuthority.application.length, 1, "browser-created Application has one snapshot authority");
    ctx.equal(submittedAuthority.revisions, [submitted.revision], "browser-created Revision is snapshot authority");
    ctx.equal(submittedAuthority.claims, [claim.claim], "browser-created Claim is snapshot authority");
    ctx.assert("browser-created policy exact", () => assertReviewPolicy(submittedAuthority.revisions[0].policy));
    await expectVisibleValues(page, [
      submittedAuthority.application[0].state,
      submittedAuthority.application[0].currentRevision,
      submitted.revision.canonicalDigest,
      claim.claim.claimId,
      claim.claim.reviewerId,
      claim.claim.role,
      ...policyDisplayValues(submitted.revision.policy),
    ], "browser-created authority");
    for (const history of family.histories) {
      await page.goto(api.baseUrl, { waitUntil: "networkidle" });
      await expectVisibleIdentity(page, history.application.applicationId);
      const identity = page.getByText(history.application.applicationId, { exact: false }).first();
      if (await identity.count()) await identity.click();
      const authority = aggregateResources(state, history.application.applicationId);
      ctx.equal(authority.application.length, 1, `${history.application.applicationId} one Application authority`);
      ctx.equal(authority.revisions.length, 1, `${history.application.applicationId} one immutable Revision`);
      ctx.equal(authority.revisions[0], history.revision, `${history.application.applicationId} Revision payload preserved`);
      ctx.equal(rowsByIdentity(authority.claims, ({ claimId }) => claimId), rowsByIdentity(history.claims, ({ claimId }) => claimId), `${history.application.applicationId} Claim history preserved`);
      ctx.equal(rowsByIdentity(authority.decisions, ({ decisionId }) => decisionId), rowsByIdentity(history.decisions, ({ decisionId }) => decisionId), `${history.application.applicationId} Decision history preserved`);
      ctx.equal(rowsByIdentity(authority.permits, ({ permitId }) => permitId), rowsByIdentity(history.permits, ({ permitId }) => permitId), `${history.application.applicationId} Permit history preserved`);
      ctx.assert(`${history.application.applicationId} exact policy`, () => assertReviewPolicy(authority.revisions[0].policy));
      authority.claims.forEach((item) => ctx.assert(`${item.claimId} exact Claim`, () => assertReviewClaim(item)));
      authority.decisions.forEach((item) => ctx.assert(`${item.decisionId} exact Decision`, () => assertReviewDecision(item)));
      authority.permits.forEach((item) => ctx.assert(`${item.permitId} exact Permit`, () => assertApprovedPermit(item)));
      await expectVisibleValues(page, [
        authority.application[0].state,
        authority.application[0].currentRevision,
        authority.revisions[0].canonicalDigest,
        ...policyDisplayValues(authority.revisions[0].policy),
        ...authority.claims.flatMap((item) => [item.claimId, item.reviewerId, item.role, item.state]),
        ...authority.decisions.flatMap((item) => [item.decisionId, item.decision, item.reason]),
        ...authority.permits.flatMap((item) => [item.permitId, item.canonicalDigest]),
      ], `${history.application.applicationId} visible authority`);
      await page.reload({ waitUntil: "networkidle" });
      await expectVisibleValues(page, [authority.application[0].state, authority.revisions[0].canonicalDigest], `${history.application.applicationId} refresh authority`);
    }
    ctx.ok(state.resources.permitApplications.some(({ applicationId }) => applicationId === submitted.application.applicationId), "browser submission persisted");
    return caseResult(ctx, { applicationId: submitted.application.applicationId, claimId: claim.claim.claimId, seededHistories: family.histories.length });
  },
  [blocked("PF-D02-DECISION-UI", "PF-GAP-01")],
);

const d03 = defineCase(
  "D-03",
  "PF-F-BROWSER changes and due histories",
  "Use visible controls to create Revision 2 for a seeded CHANGES_REQUIRED Application, then run a Worker, observe a separate due Application expire and refresh both details",
  "The UI preserves Revision 1 evidence, shows contiguous Revision 2 and asynchronous EXPIRED authority, and refresh agrees with exact snapshot identities",
  ["production Chromium", "visible Revision controls", "Worker process", "verification snapshot"],
  async (ctx) => {
    const changes = ctx.fixtures.history("d03-changes", "CHANGES_REQUIRED");
    const due = ctx.fixtures.history("d03-due", "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
    const base = ctx.fixtures.browser();
    const family = { ...base, seed: ctx.fixtures.seedFromHistories("d03", [changes, due]) };
    const { api } = await boot(ctx, { family, build: true });
    const before = await snapshot(ctx, api.baseUrl);
    const originalRevision = before.resources.applicationRevisions.find(({ applicationId, revision }) => applicationId === changes.application.applicationId && revision === 1);
    const oldClaims = before.resources.reviewClaims.filter(({ applicationId }) => applicationId === changes.application.applicationId);
    const dueWork = assertSingleAggregateWork(before.work, due.application.applicationId, { terminal: false });
    const { page } = await launchBrowser(ctx, api);
    await expectVisibleIdentity(page, changes.application.applicationId);
    await page.getByText(changes.application.applicationId, { exact: false }).first().click();
    await expectVisibleValues(page, [originalRevision.canonicalDigest, ...oldClaims.map(({ claimId }) => claimId)], "pre-replacement immutable history");
    await fillRevisionForm(ctx, page, family, { revision: 2, browser: true });
    const revised = await captureJsonResponse(page, (url, response) => url.pathname === `/api/v1/permit-applications/${changes.application.applicationId}/revisions` && response.request().method() === "POST", () => keyboardActivate(page, [/create.*revision/i, /submit.*revision/i, /replace/i]));
    ctx.equal(revised.status, 200, "browser replacement status");
    const revision = findObject(revised.json, "canonicalDigest");
    ctx.assert("browser replacement exact Revision", () => assertApplicationRevision(revision));
    await expectVisibleIdentity(page, revision.canonicalDigest);
    await expectVisibleValues(page, [originalRevision.canonicalDigest, ...oldClaims.map(({ claimId }) => claimId)], "old Revision and Claim remain visible");

    await fillRevisionForm(ctx, page, family, { revision: "stale", browser: true }, ctx.at({ days: 5 }));
    const conflict = await captureJsonResponse(page, (url, response) => url.pathname === `/api/v1/permit-applications/${changes.application.applicationId}/revisions` && response.request().method() === "POST", () => keyboardActivate(page, [/create.*revision/i, /submit.*revision/i, /replace/i]));
    ctx.equal(conflict.status, 409, "stale browser replacement status");
    ctx.equal(conflict.json.error.code, "APPLICATION_REVISION_CHANGED", "stale browser replacement code");
    await page.getByText(/APPLICATION_REVISION_CHANGED|revision.*changed|stale/i).first().waitFor({ state: "visible" });
    await expectFocusedFeedback(ctx, page, "stale conflict");

    let holdWorker = true;
    const barrier = await ctx.barrier({ hold: ({ processRole, point, aggregateId }) => holdWorker && processRole === "worker" && point === "worker.claimed" && aggregateId === due.application.applicationId });
    const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor(({ json }) => json.point === "worker.claimed" && json.aggregateId === due.application.applicationId, { timeoutMs: 120_000, processes: [worker] });
    ctx.equal(held.json.workId, dueWork.workId, "browser deadline progress binds published Work identity");
    const leased = await snapshot(ctx, api.baseUrl);
    const leasedWork = assertSingleAggregateWork(leased.work, due.application.applicationId, { terminal: false });
    ctx.equal(leasedWork.state, "LEASED", "deadline progress reaches durable LEASED state");
    ctx.equal(leasedWork.attempt, dueWork.attempt + 1, "deadline progress increments attempt");
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    await expectVisibleIdentity(page, due.application.applicationId);
    await page.getByText(due.application.applicationId, { exact: false }).first().click();
    await expectVisibleValues(page, [dueWork.workId, "LEASED", leasedWork.attempt], "leased Work progress UI");
    await ctx.kill(worker);
    holdWorker = false;
    await ctx.sleep(3_300);
    const replacement = await ctx.startWorker();
    const recovered = await waitSnapshot(ctx, api.baseUrl, (value) => {
      const work = value.work.find(({ workId }) => workId === dueWork.workId);
      return applicationFrom(value, due.application.applicationId)?.state === "EXPIRED" && work?.terminal ? value : undefined;
    }, { label: "browser deadline replacement recovery", processes: [replacement] });
    const recoveredWork = assertSingleAggregateWork(recovered.work, due.application.applicationId, { terminal: true });
    ctx.equal(recoveredWork.workId, dueWork.workId, "recovery retains Work identity");
    ctx.equal(recoveredWork.attempt, leasedWork.attempt + 1, "replacement increments Work attempt once");
    await page.reload({ waitUntil: "networkidle" });
    await expectVisibleValues(page, [due.application.applicationId, "EXPIRED", dueWork.workId, recoveredWork.state, recoveredWork.attempt], "terminal recovery UI");
    await page.reload({ waitUntil: "networkidle" });
    await expectVisibleValues(page, ["EXPIRED", dueWork.workId], "terminal recovery refresh");
    const state = await snapshot(ctx, api.baseUrl);
    const revisionHistory = state.resources.applicationRevisions.filter(({ applicationId }) => applicationId === changes.application.applicationId);
    ctx.equal(revisionHistory.length, 2, "browser persisted two immutable Revisions");
    ctx.equal(revisionHistory[0], originalRevision, "Revision 1 remains byte-identical");
    ctx.equal(revisionHistory[1], revision, "Revision 2 matches browser response");
    ctx.equal(state.resources.reviewClaims.filter(({ applicationId }) => applicationId === changes.application.applicationId), oldClaims, "old Claim history remains immutable");
    ctx.equal(applicationFrom(state, changes.application.applicationId).currentRevision, 2, "replacement is current Revision 2");
    ctx.equal(applicationFrom(state, due.application.applicationId).state, "EXPIRED", "recovered deadline state authority");
    return caseResult(ctx, { changesApplicationId: changes.application.applicationId, dueApplicationId: due.application.applicationId, revisionDigest: revision.canonicalDigest, conflictCode: conflict.json.error.code, workId: dueWork.workId, attempts: recoveredWork.attempt });
  },
);

const d04 = defineCase(
  "D-04",
  "PF-F-BROWSER dynamic FINAL Stages",
  "Use visible keyboard controls to create one, two and five Stage Applications, inspect every dynamic policy and claim the current Stage while a later-Stage-only reviewer is rejected",
  "The UI is not hard-coded to two Stages, concrete server Stage identities remain ordered, only the current Stage is claimable and seeded completed evidence stays visible",
  ["production Chromium", "dynamic Stage controls", "real staged HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.browser();
    const approved = ctx.fixtures.history("d04-approved", "APPROVED");
    const rejected = ctx.fixtures.history("d04-rejected", "VETO_REJECTED");
    const changes = ctx.fixtures.history("d04-changes", "CHANGES_REQUIRED");
    const seededHistories = [approved, rejected, changes];
    const { api } = await boot(ctx, { family, seed: ctx.fixtures.seedFromHistories("d04-seeded-terminal", seededHistories), build: true });
    const { page } = await launchBrowser(ctx, api);
    const created = [];
    for (const count of [1, 2, 5]) {
      await page.goto(api.baseUrl, { waitUntil: "networkidle" });
      const customStages = count === 5 ? [
        { name: "Legal Intake", reviewPolicy: family.strictLegalPolicy },
        { name: "Security", reviewPolicy: family.policy },
        { name: "Technical", reviewPolicy: family.policy },
        { name: "Executive", reviewPolicy: family.strictLegalPolicy },
        { name: "Issue", reviewPolicy: family.policy },
      ] : undefined;
      const item = await browserSubmitStaged(ctx, page, family, count, `d04-${count}`, customStages);
      const stages = await stagesDetail(ctx, api.baseUrl, item.application.applicationId);
      ctx.assert(`${count} dynamic Stage authority`, () => assertStageSet(stages, count), { hardCapIds: ["REVIEW_AUTHORITY"] });
      for (const stage of stages) {
        ctx.assert(`${stage.stageId} exact dynamic Stage`, () => assertReviewStage(stage));
        await expectVisibleValues(page, [stage.stageId, stage.ordinal, stage.name, stage.state, ...policyDisplayValues(stage.policy)], `${count} Stage dynamic policy`);
      }
      created.push({ ...item, stages });
    }
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    const target = created[2];
    await expectVisibleIdentity(page, target.application.applicationId);
    await browserClaim(ctx, page, target.application.applicationId, family.legalReviewers[0].reviewerId, "legal", "d04-current");
    await setVisible(page, [/reviewer/i], family.securityReviewers[0].reviewerId);
    await setVisible(page, [/role/i], "security");
    const laterRole = await captureJsonResponse(page, (url, response) => url.pathname === `/api/v1/permit-applications/${target.application.applicationId}/review-claims` && response.request().method() === "POST", () => keyboardActivate(page, [/claim/i, /start.*review/i]));
    ctx.equal(laterRole.status, 409, "later-Stage-only reviewer rejected");
    ctx.equal(laterRole.json.error.code, "REVIEW_SLOT_UNAVAILABLE", "later Stage eligibility error");
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(state.resources.reviewStages.filter(({ applicationId, state: stageState }) => applicationId === target.application.applicationId && stageState === "ACTIVE").length, 1, "one current ACTIVE Stage");
    const expectedTerminalStage = new Map([
      [approved.application.applicationId, "COMPLETED"],
      [rejected.application.applicationId, "TERMINAL"],
      [changes.application.applicationId, "TERMINAL"],
    ]);
    for (const history of seededHistories) {
      const stages = state.resources.reviewStages.filter(({ applicationId }) => applicationId === history.application.applicationId);
      ctx.equal(stages.length, 1, `${history.application.applicationId} migrated to one retained Stage`);
      ctx.equal(stages[0].ordinal, 1, `${history.application.applicationId} migrated Stage ordinal`);
      ctx.equal(stages[0].state, expectedTerminalStage.get(history.application.applicationId), `${history.application.applicationId} migrated terminal Stage state`);
      ctx.equal(canonicalJson(stages[0].policy), canonicalJson(history.revision.policy), `${history.application.applicationId} migrated Stage policy`);
      ctx.equal(rowsByIdentity(state.resources.reviewDecisions.filter(({ applicationId }) => applicationId === history.application.applicationId), ({ decisionId }) => decisionId), rowsByIdentity(history.decisions, ({ decisionId }) => decisionId), `${history.application.applicationId} Decisions retained`);
      ctx.equal(rowsByIdentity(state.resources.approvedPermits.filter(({ applicationId }) => applicationId === history.application.applicationId), ({ permitId }) => permitId), rowsByIdentity(history.permits, ({ permitId }) => permitId), `${history.application.applicationId} Permit retained`);
      await page.goto(api.baseUrl, { waitUntil: "networkidle" });
      await expectVisibleIdentity(page, history.application.applicationId);
      await page.getByText(history.application.applicationId, { exact: false }).first().click();
      await expectVisibleValues(page, [
        history.application.state,
        stages[0].stageId,
        stages[0].name,
        stages[0].state,
        ...policyDisplayValues(stages[0].policy),
        ...history.decisions.map(({ decisionId }) => decisionId),
        ...history.permits.map(({ permitId }) => permitId),
      ], `${history.application.applicationId} completed/terminal evidence`);
      await page.reload({ waitUntil: "networkidle" });
      await expectVisibleValues(page, [stages[0].stageId, stages[0].state], `${history.application.applicationId} immutable Stage refresh`);
    }
    return caseResult(ctx, { applications: created.map(({ application }) => application.applicationId), stageCounts: [1, 2, 5], seededStageStates: Object.fromEntries(expectedTerminalStage) });
  },
  [blocked("PF-D04-STAGE-COMPLETION", "PF-GAP-01"), blocked("PF-D04-CLAIM-STAGE-ASSOCIATION", "PF-GAP-04")],
);

const d05 = defineCase(
  "D-05",
  "PF-F-BROWSER real failure and accessibility states",
  "Drive empty, validation, delayed loading, stale conflict, offline retry, terminal and permission states with keyboard controls at desktop and mobile widths while observing real HTTP effects",
  "Every state is visible and focusable, retry creates one mutation, labels and viewport remain usable, and no admin token, idempotency key, claim token or private path enters DOM, bundle or logs",
  ["production Chromium", "visible keyboard controls", "real HTTP failure responses", "mobile viewport", "verification snapshot"],
  async (ctx) => {
    const emptyFamily = ctx.fixtures.browser();
    const emptySeed = {
      ...emptyFamily.seed,
      permitApplications: [],
      applicationRevisions: [],
      reviewClaims: [],
      reviewDecisions: [],
      approvedPermits: [],
    };
    const { api: emptyApi } = await boot(ctx, { family: emptyFamily, seed: emptySeed, build: true });
    const { browser: emptyBrowser, page: emptyDesktop } = await launchBrowser(ctx, emptyApi, { viewport: D05_VIEWPORTS.desktop });
    const emptyMobile = await emptyBrowser.newPage({ viewport: D05_VIEWPORTS.mobile });
    await emptyMobile.goto(emptyApi.baseUrl, { waitUntil: "networkidle" });
    for (const [label, page] of [["empty desktop", emptyDesktop], ["empty mobile", emptyMobile]]) {
      await page.getByText(/no (?:permit )?applications|no applications yet|empty/i).first().waitFor({ state: "visible" });
      await auditAccessibleViewport(ctx, page, label);
    }
    const emptySurface = await collectBrowserSurface(ctx, emptyApi.baseUrl, [emptyDesktop, emptyMobile]);
    const emptyLogs = emptyApi.logs;
    await emptyBrowser.close();
    await ctx.resetDatabase();

    const changesMobile = ctx.fixtures.history("d05-changes-mobile", "CHANGES_REQUIRED");
    const changesDesktop = ctx.fixtures.history("d05-changes-desktop", "CHANGES_REQUIRED");
    const approvedMobile = ctx.fixtures.history("d05-approved-mobile", "APPROVED");
    const approvedDesktop = ctx.fixtures.history("d05-approved-desktop", "APPROVED");
    const base = ctx.fixtures.browser();
    const family = { ...base, seed: ctx.fixtures.seedFromHistories("d05", [changesMobile, changesDesktop, approvedMobile, approvedDesktop]) };
    const { api } = await boot(ctx, { family });
    const { browser, page: mobile } = await launchBrowser(ctx, api, { viewport: D05_VIEWPORTS.mobile });
    const desktop = await browser.newPage({ viewport: D05_VIEWPORTS.desktop });
    await desktop.goto(api.baseUrl, { waitUntil: "networkidle" });
    const mobileResult = await driveViewportStates(ctx, api, mobile, family, { changes: changesMobile, approved: approvedMobile }, "mobile");
    const desktopResult = await driveViewportStates(ctx, api, desktop, family, { changes: changesDesktop, approved: approvedDesktop }, "desktop");
    const state = await snapshot(ctx, api.baseUrl);
    for (const [label, result] of [["mobile", mobileResult], ["desktop", desktopResult]]) {
      ctx.equal(state.resources.permitApplications.filter(({ applicationId }) => applicationId === result.loadingApplicationId).length, 1, `${label} loading result retained once`);
      ctx.equal(state.resources.permitApplications.filter(({ applicationId }) => applicationId === result.retriedApplicationId).length, 1, `${label} retry result retained once`);
    }
    const populatedSurface = await collectBrowserSurface(ctx, api.baseUrl, [mobile, desktop]);
    const observedKeys = [...mobileResult.observedKeys, ...desktopResult.observedKeys];
    assertExternalSecretBoundary({ emptySurface, populatedSurface, emptyLogs, populatedLogs: api.logs }, ctx, observedKeys);
    return caseResult(ctx, {
      viewports: D05_VIEWPORTS,
      states: D05_STATES,
      viewportResults: {
        mobile: { ...mobileResult, observedKeys: mobileResult.observedKeys.length },
        desktop: { ...desktopResult, observedKeys: desktopResult.observedKeys.length },
      },
    });
  },
);

const d06 = defineCase(
  "D-06",
  "PF-F-BROWSER complex cross-layer history",
  "Create a replacement Revision and a multi-Stage Application, then read concrete identities through detail, revision, stages, browser, snapshot, Work and aggregate Events",
  "Every layer agrees on Application state, current Revision, Stage ordering, captured policy, Claims, Decisions, Permit, Work and Event identity with exact shapes and secret omission",
  ["public read HTTP", "production Chromium", "verification snapshot", "Domain Event HTTP"],
  async (ctx) => {
    const family = ctx.fixtures.migration();
    const { api } = await boot(ctx, { family, build: true });
    const changes = family.histories.find(({ application }) => application.state === "CHANGES_REQUIRED");
    const approved = family.histories.find(({ application }) => application.state === "APPROVED");
    const revisionResponse = await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${changes.application.applicationId}/revisions`, ctx.key("d06-revision"), { expectedRevision: 1, fields: { crossLayer: true }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: family.policy });
    requireStatus(ctx, revisionResponse, 200, "cross-layer replacement");
    const replacementRevision = findObject(revisionResponse.json, "canonicalDigest");
    ctx.assert("cross-layer replacement exact Revision", () => assertApplicationRevision(replacementRevision));
    const staged = await submitApplication(ctx, api.baseUrl, ctx.fixtures.stagedBody(5, "d06-staged"), "d06-staged");
    const applicationId = staged.application.applicationId;
    const claimResponse = await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("d06-claim"), { reviewerId: family.reviewers.find(({ roles }) => roles.includes("security")).reviewerId, role: "security" });
    requireStatus(ctx, claimResponse, 200, "cross-layer Claim");
    const responseClaim = publicClaim(claimResponse.json);
    const claimId = responseClaim.claimId;
    const detail = await applicationDetail(ctx, api.baseUrl, applicationId);
    const current = await applicationCurrent(ctx, api.baseUrl, applicationId);
    const revision = await revisionDetail(ctx, api.baseUrl, applicationId, 1);
    const stages = await stagesDetail(ctx, api.baseUrl, applicationId);
    const eventPage = await domainEvents(ctx, api.baseUrl, { aggregateId: applicationId, afterSequence: "0", limit: "100" });
    const state = await snapshot(ctx, api.baseUrl);
    const authority = assertAggregateDetailAuthority(detail.json, state, applicationId);
    const currentApplication = findObject(current.json, "applicationId");
    const snapshotApplication = applicationFrom(state, applicationId);
    ctx.equal(currentApplication, snapshotApplication, "camel current Application equals snapshot");
    ctx.equal(authority.application, snapshotApplication, "aggregate detail Application equals snapshot");
    ctx.equal(authority.revision, revision.revision, "aggregate detail and Revision endpoint agree");
    ctx.equal(revision.revision, state.resources.applicationRevisions.find(({ applicationId: id, revision: number }) => id === applicationId && number === 1), "Revision endpoint equals snapshot");
    ctx.equal(revision.revision.policy, staged.revision.policy, "captured policy agrees with submit response");
    ctx.assert("cross-layer captured policy exact", () => assertReviewPolicy(revision.revision.policy));
    const snapshotStages = state.resources.reviewStages.filter(({ applicationId: id }) => id === applicationId);
    ctx.equal(stages, snapshotStages, "Stages endpoint and snapshot agree exactly");
    ctx.equal(stages.map(({ ordinal }) => ordinal), [1, 2, 3, 4, 5], "five Stage order is exact");
    for (const stage of stages) ctx.assert(`${stage.stageId} exact Stage`, () => assertReviewStage(stage));
    const snapshotClaim = state.resources.reviewClaims.find(({ claimId: id }) => id === claimId);
    ctx.equal(responseClaim, snapshotClaim, "Claim response public resource and snapshot agree exactly");
    ctx.equal(authority.claims, [snapshotClaim], "aggregate detail Claim history agrees exactly");
    ctx.assert("cross-layer Claim exact", () => assertReviewClaim(snapshotClaim));
    ctx.equal(eventPage.items, state.events.filter(({ aggregateId }) => aggregateId === applicationId), "Event endpoint and snapshot agree exactly");
    eventPage.items.forEach((event) => ctx.assert(`${event.eventId} exact Event`, () => assertDomainEvent(event)));
    const work = assertSingleAggregateWork(state.work, applicationId, { terminal: false });
    ctx.assert("cross-layer Work exact", () => assertWork(work));
    ctx.equal(snapshotApplication.currentRevision, 1, "all layers bind current Revision 1");
    ctx.equal(snapshotApplication.currentStageOrdinal, 1, "all layers bind current Stage 1");
    ctx.equal(snapshotApplication.stages, stages, "embedded Application Stages equal Stage endpoint");

    const approvedDetail = await applicationDetail(ctx, api.baseUrl, approved.application.applicationId);
    const approvedAuthority = assertAggregateDetailAuthority(approvedDetail.json, state, approved.application.applicationId);
    ctx.equal(approvedAuthority.decisions, state.resources.reviewDecisions.filter(({ applicationId: id }) => id === approved.application.applicationId), "approved Decisions equal snapshot");
    ctx.equal(approvedAuthority.permit, state.resources.approvedPermits.find(({ applicationId: id }) => id === approved.application.applicationId), "approved Permit equals snapshot");
    approvedAuthority.decisions.forEach((decision) => ctx.assert(`${decision.decisionId} exact approved Decision`, () => assertReviewDecision(decision)));
    ctx.assert(`${approvedAuthority.permit.permitId} exact approved Permit`, () => assertApprovedPermit(approvedAuthority.permit));
    const changesAuthority = aggregateResources(state, changes.application.applicationId);
    ctx.equal(changesAuthority.revisions.length, 2, "replacement history has two Revisions");
    ctx.equal(changesAuthority.revisions[1], replacementRevision, "replacement response equals snapshot Revision 2");
    const { page } = await launchBrowser(ctx, api);
    await expectVisibleIdentity(page, applicationId);
    await page.getByText(applicationId, { exact: false }).first().click();
    await expectVisibleValues(page, [
      snapshotApplication.state,
      snapshotApplication.currentRevision,
      snapshotApplication.currentStageOrdinal,
      revision.revision.canonicalDigest,
      ...policyDisplayValues(revision.revision.policy),
      claimId,
      snapshotClaim.reviewerId,
      snapshotClaim.role,
      snapshotClaim.state,
      work.workId,
      work.state,
      work.attempt,
      ...stages.flatMap((stage) => [stage.stageId, stage.ordinal, stage.name, stage.state, ...policyDisplayValues(stage.policy)]),
      ...eventPage.items.flatMap((event) => [event.eventId, event.type, event.sequence]),
    ], "complex staged cross-layer UI");
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    await expectVisibleIdentity(page, approved.application.applicationId);
    await page.getByText(approved.application.applicationId, { exact: false }).first().click();
    await expectVisibleValues(page, [
      approvedAuthority.application.state,
      approvedAuthority.revision.canonicalDigest,
      ...approvedAuthority.decisions.flatMap((decision) => [decision.decisionId, decision.decision, decision.reason]),
      approvedAuthority.permit.permitId,
      approvedAuthority.permit.canonicalDigest,
    ], "approved Decision and Permit UI authority");
    assertExternalSecretBoundary({ detail: detail.json, stage: stages, browser: await page.locator("html").innerHTML(), snapshot: state }, ctx);
    return caseResult(ctx, { applicationId, claimId, workId: work.workId, approvedPermitId: approvedAuthority.permit.permitId, stageIds: stages.map(({ stageId }) => stageId), eventIds: eventPage.items.map(({ eventId }) => eventId) });
  },
);

function d07SubmissionBody(ctx, seed, ordinal) {
  const applicant = seed.applicants[ordinal % seed.applicants.length];
  const reviewer = seed.reviewers[ordinal % seed.reviewers.length];
  return {
    applicantId: applicant.applicantId,
    permitType: "PERF",
    fields: { workload: "d07-evaluator-owned", ordinal },
    deadlineAt: ctx.at({ days: 7, milliseconds: ordinal }),
    reviewPolicy: { roles: [{ role: "reviewer", eligibleReviewerIds: [reviewer.reviewerId], requiredApprovals: 1, veto: false }], requiredTotalApprovals: 1 },
  };
}

async function runEvaluatorOwnedPerformanceTraffic(ctx) {
  const fixture = ctx.fixtures.performance();
  const seed = fixture.buildSeed();
  const family = { fixtureFamily: "PF-F-PERF", seed };
  const { apis } = await boot(ctx, { family, seed, seedTimeoutMs: 900_000, apiCount: D07_EVALUATOR_WORKLOAD.apiCount });
  ctx.equal(apis.length, D07_EVALUATOR_WORKLOAD.apiCount, "evaluator-owned performance environment has exactly two APIs");
  for (const [index, api] of apis.entries()) requireStatus(ctx, await ctx.request(api.baseUrl, "/healthz"), 200, `evaluator-owned API ${index + 1} health`, { json: false });

  const before = await snapshot(ctx, apis[0].baseUrl, { timeoutMs: 60_000 });
  ctx.equal(before.resources.applicants.length, fixture.spec.applicants, "fixed perf Applicant population");
  ctx.equal(before.resources.reviewers.length, fixture.spec.reviewers, "fixed perf Reviewer population");
  ctx.equal(before.resources.permitApplications.length, fixture.spec.applications, "fixed perf Application population");
  ctx.equal(before.resources.applicationRevisions.length, fixture.spec.revisions, "fixed perf Revision population");
  ctx.equal(before.resources.reviewClaims.length, fixture.spec.claims, "fixed perf Claim population");
  const targets = seed.permitApplications.filter(({ deadlineAt }) => Date.parse(deadlineAt) > Date.now()).map(({ applicationId }) => applicationId).sort();
  const dueIds = new Set(seed.permitApplications.filter(({ deadlineAt }) => Date.parse(deadlineAt) < Date.now()).map(({ applicationId }) => applicationId));
  ctx.equal(targets.length, 10_000, "fixed perf stable read targets");
  ctx.equal(dueIds.size, fixture.spec.dueWork, "fixed perf due Application population");
  ctx.equal(before.work.filter(({ aggregateId, terminal }) => dueIds.has(aggregateId) && !terminal).length, fixture.spec.dueWork, "fixed perf due Work population");

  const reads = await Promise.all(Array.from({ length: D07_EVALUATOR_WORKLOAD.reads }, async (_, ordinal) => {
    const apiIndex = ordinal % apis.length;
    const applicationId = targets[ordinal % targets.length];
    const path = `/api/v1/permit-applications/${applicationId}`;
    return { apiIndex, applicationId, path, response: await ctx.request(apis[apiIndex].baseUrl, path, { timeoutMs: 10_000 }) };
  }));
  const submissions = await Promise.all(Array.from({ length: D07_EVALUATOR_WORKLOAD.submissions }, async (_, ordinal) => {
    const apiIndex = ordinal % apis.length;
    const path = "/api/v1/permit-applications";
    const body = d07SubmissionBody(ctx, seed, ordinal);
    const response = await ctx.mutate(apis[apiIndex].baseUrl, path, ctx.key(`d07-evaluator-submit-${ordinal}`), body, { timeoutMs: 10_000 });
    return { apiIndex, path, body, response };
  }));
  const after = await snapshot(ctx, apis[1].baseUrl, { timeoutMs: 60_000 });
  ctx.assert("evaluator-owned fixed route traffic and snapshot postconditions", () => assertEvaluatorOwnedPerformanceTraffic(before, after, { reads, submissions }), { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
  return { apiCount: apis.length, reads: reads.length, submissions: submissions.length };
}

const d07 = defineCase(
  "D-07",
  "PF-F-EMPTY published project gate sensitivity",
  "Run every published test command, externally observe two APIs, two Workers and both recovery barrier roles, then break PostgreSQL, Chromium and barrier dependencies one at a time",
  "Positive gates use real dependencies and fixed performance work while every corresponding negative seam exits nonzero, so zero-test, string-check and swallowed-failure suites cannot pass",
  ["public npm test commands", "PostgreSQL", "system Chromium", "OS process observer", "recovery barrier"],
  async (ctx) => {
    const build = await ctx.npm("build", [], { timeoutMs: 600_000 });
    ctx.equal(build.exitCode, 0, "production build gate exit");
    await ctx.migrate();
    const marker = ctx.tempPath("permitforge-chromium-invocations.log");
    const wrapper = ctx.tempPath("permitforge-chromium-wrapper.sh");
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${marker}'\nexec '${process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"}' "$@"\n`);
    await chmod(wrapper, 0o700);

    const unit = await runProjectGate(ctx, "test:unit", { timeoutMs: 600_000 });
    ctx.assert("unit gate executes nonzero tests", () => assertNonzeroTestReport(unit.process.logs, "unit"));
    ctx.ok(unit.observation.maxDescendants >= 1, "unit gate executes a child test process");
    const integration = await runProjectGate(ctx, "test:integration", { timeoutMs: 1_200_000, observeDatabase: true });
    ctx.assert("integration gate executes nonzero tests", () => assertNonzeroTestReport(integration.process.logs, "integration"));
    ctx.assert("integration exposes real HTTP/PostgreSQL work", () => assertProjectGateObservation(integration.observation, { databaseConnections: 1, databaseTransactionDelta: 2, databaseTupleDelta: 1, maxApiProcesses: 1, maxDescendants: 2, maxHttpListeners: 1, maxHttpEstablished: 1 }));
    const e2e = await runProjectGate(ctx, "test:e2e", { timeoutMs: 1_200_000, env: { CHROMIUM_PATH: wrapper }, observeDatabase: true });
    ctx.assert("E2E gate executes nonzero tests", () => assertNonzeroTestReport(e2e.process.logs, "e2e"));
    const chromiumBytes = await readFile(marker).then((value) => value.byteLength).catch(() => 0);
    ctx.ok(chromiumBytes > 0, "E2E invokes the evaluator-observed production Chromium binary");
    ctx.assert("E2E exposes production Chromium/API/PostgreSQL work", () => assertProjectGateObservation(e2e.observation, { databaseConnections: 1, databaseTransactionDelta: 2, databaseTupleDelta: 1, maxApiProcesses: 1, maxChromiumProcesses: 1, maxHttpListeners: 1, maxHttpEstablished: 1 }));
    ctx.mark("Chromium", { kind: "test:e2e observed production Chromium process" });
    ctx.mark("UI", { kind: "test:e2e observed production browser flow" });

    const concurrency = await runProjectGate(ctx, "test:concurrency", { timeoutMs: 1_200_000, observeDatabase: true });
    ctx.assert("concurrency gate executes nonzero tests", () => assertNonzeroTestReport(concurrency.process.logs, "concurrency"));
    ctx.assert("concurrency exposes real two-API/two-Worker shared-DB work", () => assertProjectGateObservation(concurrency.observation, { databaseConnections: 4, databaseTransactionDelta: 4, databaseTupleDelta: 1, maxApiProcesses: 2, maxWorkerProcesses: 2, uniqueApiProcessCount: 2, uniqueWorkerProcessCount: 2, maxHttpListeners: 2, maxHttpEstablished: 1 }));

    const barrier = await ctx.barrier();
    const recovery = await runProjectGate(ctx, "test:recovery", { timeoutMs: 1_200_000, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token }, observeDatabase: true });
    ctx.assert("recovery gate executes nonzero tests", () => assertNonzeroTestReport(recovery.process.logs, "recovery"));
    ctx.assert("recovery gate barrier identities bind replacement attempts", () => assertRecoveryBarrierEvidence(barrier.ledger));
    ctx.assert("recovery gate has observable killed/replacement Worker processes", () => assertProjectGateObservation(recovery.observation, { databaseConnections: 1, databaseTransactionDelta: 2, databaseTupleDelta: 1, uniqueWorkerProcessCount: 2, workerPidDisappearances: 1 }));

    const allBarrier = await ctx.barrier();
    const beforeAllChromiumBytes = await readFile(marker).then((value) => value.byteLength).catch(() => 0);
    const all = await runProjectGate(ctx, "test:all", { timeoutMs: 10_800_000, env: { CHROMIUM_PATH: wrapper, TEST_BARRIER_URL: allBarrier.url, TEST_BARRIER_TOKEN: allBarrier.token }, observeDatabase: true });
    ctx.assert("all gate executes nonzero tests", () => assertNonzeroTestReport(all.process.logs, "all"));
    const afterAllChromiumBytes = await readFile(marker).then((value) => value.byteLength).catch(() => 0);
    ctx.ok(afterAllChromiumBytes > beforeAllChromiumBytes, "test:all independently invokes production Chromium");
    ctx.assert("test:all reaches recovery barrier identities", () => assertRecoveryBarrierEvidence(allBarrier.ledger));
    ctx.assert("test:all exposes every process and database seam", () => assertProjectGateObservation(all.observation, { databaseConnections: 4, databaseTransactionDelta: 10, databaseTupleDelta: 1, maxApiProcesses: 2, maxWorkerProcesses: 2, maxChromiumProcesses: 1, maxHttpListeners: 2, maxHttpEstablished: 1 }));
    const perfBarrier = await ctx.barrier();
    const perf = await runProjectGate(ctx, "test:perf", { timeoutMs: 7_200_000, env: { TEST_BARRIER_URL: perfBarrier.url, TEST_BARRIER_TOKEN: perfBarrier.token }, observeDatabase: true });
    ctx.ok(perf.durationMs >= 140_000, "test:perf sustains two 10s warm-ups and two 60s HTTP measurements");
    ctx.assert("test:perf performs fixed-scale PostgreSQL/process work in the published two-API environment", () => assertProjectGateObservation(perf.observation, { databaseConnections: 2, databaseTransactionDelta: 20_000, databaseTupleDelta: 20_000, maxApiProcesses: 2, maxWorkerProcesses: 2, maxDescendants: 4, uniqueApiProcessCount: 2, uniqueWorkerProcessCount: 4, workerPidDisappearances: 2, maxHttpListeners: 2, maxHttpEstablished: 1 }));
    ctx.assert("test:perf recovers both held Work identities", () => assertRecoveryBarrierEvidence(perfBarrier.ledger, { minimumRecoveredWork: 2, requireDispatcher: false }));
    ctx.assert("test:perf exact published report", () => assertPermitForgePerformanceReport(perf.process.logs));

    await ctx.resetDatabase();
    const evaluatorOwnedTraffic = await runEvaluatorOwnedPerformanceTraffic(ctx);

    await ctx.resetDatabase();
    const due = ctx.fixtures.history("d07-direct-due", "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
    const family = ctx.fixtures.browser();
    const { apis } = await boot(ctx, { family, seed: ctx.fixtures.seedFromHistories("d07-direct-recovery", [due]), apiCount: 2 });
    for (const [index, api] of apis.entries()) {
      requireStatus(ctx, await ctx.request(api.baseUrl, "/healthz"), 200, `direct API ${index + 1} health`);
      requireStatus(ctx, await ctx.request(api.baseUrl, `/api/v1/permitApplications/${due.application.applicationId}`), 200, `direct API ${index + 1} public read`);
    }
    const beforeRecovery = await snapshot(ctx, apis[0].baseUrl);
    const initialWork = assertSingleAggregateWork(beforeRecovery.work, due.application.applicationId, { terminal: false });
    let hold = true;
    const directBarrier = await ctx.barrier({ hold: ({ processRole, point, workId }) => hold && processRole === "worker" && point === "worker.claimed" && workId === initialWork.workId });
    const staleWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: directBarrier.url, TEST_BARRIER_TOKEN: directBarrier.token } });
    await directBarrier.waitFor(({ json }) => json.point === "worker.claimed" && json.workId === initialWork.workId, { timeoutMs: 120_000, processes: [staleWorker] });
    const leased = await snapshot(ctx, apis[0].baseUrl);
    const leasedWork = assertSingleAggregateWork(leased.work, due.application.applicationId, { terminal: false });
    ctx.equal(leasedWork.state, "LEASED", "direct recovery observes a real durable lease");
    await ctx.kill(staleWorker);
    hold = false;
    await ctx.sleep(3_300);
    const replacement = await ctx.startWorker();
    const recovered = await waitSnapshot(ctx, apis[1].baseUrl, (value) => {
      const work = value.work.find(({ workId }) => workId === initialWork.workId);
      return applicationFrom(value, due.application.applicationId)?.state === "EXPIRED" && work?.terminal ? value : undefined;
    }, { label: "direct SIGKILL replacement recovery", processes: [replacement] });
    const terminalWork = assertSingleAggregateWork(recovered.work, due.application.applicationId, { terminal: true });
    ctx.equal(terminalWork.attempt, leasedWork.attempt + 1, "direct replacement increments one retained Work attempt");
    ctx.equal(recovered.resources.approvedPermits.filter(({ applicationId }) => applicationId === due.application.applicationId).length, 0, "direct recovery invents no Permit");

    await ctx.resetDatabase();
    const unavailableDatabase = `postgresql://postgres@127.0.0.1:${await ctx.freePort()}/permitforge_unavailable`;
    await runProjectGateFailure(ctx, "test:integration", { DATABASE_URL: unavailableDatabase, TEST_DATABASE_URL: unavailableDatabase }, "integration PostgreSQL dependency");
    await runProjectGateFailure(ctx, "test:perf", { DATABASE_URL: unavailableDatabase, TEST_DATABASE_URL: unavailableDatabase }, "performance PostgreSQL dependency");
    await runProjectGateFailure(ctx, "test:e2e", { CHROMIUM_PATH: ctx.tempPath("missing-chromium") }, "E2E Chromium dependency");
    const unavailableBarrier = `http://127.0.0.1:${await ctx.freePort()}/barrier`;
    await runProjectGateFailure(ctx, "test:recovery", { TEST_BARRIER_URL: unavailableBarrier, TEST_BARRIER_TOKEN: ctx.barrierToken }, "recovery barrier dependency");
    await runProjectGateFailure(ctx, "test:all", { DATABASE_URL: unavailableDatabase, TEST_DATABASE_URL: unavailableDatabase }, "all propagates a PostgreSQL sub-gate failure", 600_000);
    return caseResult(ctx, {
      gates: ["unit", "integration", "e2e", "concurrency", "recovery", "all", "perf"],
      chromiumBytes,
      maxDatabaseConnections: Math.max(integration.observation.databaseConnections, concurrency.observation.databaseConnections, recovery.observation.databaseConnections, perf.observation.databaseConnections),
      topology: { apiProcesses: concurrency.observation.maxApiProcesses, workerProcesses: concurrency.observation.maxWorkerProcesses },
      evaluatorOwnedTraffic,
      directRecovery: { applicationId: due.application.applicationId, workId: initialWork.workId, attempts: terminalWork.attempt },
      negativeSeams: ["postgresql-integration", "postgresql-performance", "chromium", "barrier", "all-subgate-propagation"],
    });
  },
);

const d08 = defineCase(
  "D-08",
  "PF-F-FINAL-STAGES executable evidence ledger",
  "Create and Claim a real five-Stage Application, validate OpenAPI, expose its concrete Application, Revision, Claim and Stage IDs in Chromium and cross-check snapshot, Deadline Work and Events",
  "Each applicable README node has identity-consistent executed HTTP, OpenAPI, UI, snapshot, Work, Event and hidden-case evidence; unavailable gap assertions remain explicit diagnostics",
  ["public mutation and read HTTP", "OpenAPI", "production Chromium", "verification snapshot", "Work and Events"],
  async (ctx) => {
    const priorEvidence = ctx.assert("D-08 consumes this runner execution's Case outcomes", () => assertExecutableCaseEvidence(ctx.priorCaseOutcomes));
    ctx.equal(D08_REQUIREMENT_CHAINS.map(({ node }) => node), D08_LEDGER_NODES, "README requirement chain order is frozen");
    const mappedCases = [...new Set(D08_REQUIREMENT_CHAINS.flatMap(({ hiddenCases }) => hiddenCases))].sort();
    ctx.equal(mappedCases, [...D08_HIDDEN_CASE_IDS].sort(), "README ledger maps every frozen hidden Case without omissions");
    for (const item of D08_REQUIREMENT_CHAINS) {
      ctx.ok(item.requirement.length > 20, `${item.node} names a concrete README requirement`);
      ctx.ok(item.layers.includes("hidden-case"), `${item.node} terminates in executable hidden evidence`);
      ctx.ok(item.hiddenCases.some((caseId) => caseId !== "D-08"), `${item.node} cites independently executed evidence outside D-08`);
    }
    ctx.assert("D-08 requirement matrix is closed by observed task-local execution layers", () => assertRequirementLayerEvidence(priorEvidence.evidence));
    const family = ctx.fixtures.finalStages("d08");
    const changes = ctx.fixtures.history("d08-changes", "CHANGES_REQUIRED");
    const due = ctx.fixtures.history("d08-due", "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
    const approved = ctx.fixtures.history("d08-approved", "APPROVED");
    const seed = ctx.fixtures.seedFromHistories("d08", [changes, due, approved]);
    const migration = await ctx.migrate({ timeoutMs: 300_000 });
    const migrationReplay = await ctx.migrate({ timeoutMs: 300_000 });
    const seeded = await ctx.seed(seed, { timeoutMs: 300_000 });
    const built = await ctx.npm("build", [], { timeoutMs: 600_000 });
    for (const [label, result] of [["migration", migration], ["migration replay", migrationReplay], ["seed", seeded], ["production build", built]]) ctx.equal(result.exitCode, 0, `${label} command exit`);
    const apis = [await ctx.startApi(), await ctx.startApi()];
    const api = apis[0];
    const health = await ctx.request(api.baseUrl, "/healthz");
    requireStatus(ctx, health, 200, "production health");
    const document = await openApi(ctx, api.baseUrl);
    const stagedBody = ctx.fixtures.stagedBody(5, "d08");
    const stagedKey = ctx.key("d08-staged");
    const staged = await submitApplication(ctx, api.baseUrl, stagedBody, "d08-staged", { key: stagedKey });
    const applicationId = staged.application.applicationId;
    const replay = await ctx.mutate(apis[1].baseUrl, "/api/v1/permit-applications", stagedKey, stagedBody);
    ctx.equal({ status: replay.status, json: replay.json }, { status: staged.response.status, json: staged.response.json }, "cross-API idempotent replay authority");
    const invalid = expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/permit-applications", ctx.key("d08-invalid"), { ...ctx.fixtures.submissionBody("d08-invalid"), unknown: true }, { contractExpectation: "invalid" }), 400, "UNKNOWN_FIELD");
    const claimResponse = await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("d08-claim"), { reviewerId: family.securityReviewers[0].reviewerId, role: "security" });
    requireStatus(ctx, claimResponse, 200, "ledger Claim");
    const claimId = findObject(claimResponse.json, "claimId").claimId;
    const replacementBody = { expectedRevision: 1, fields: { replacement: "d08" }, deadlineAt: ctx.at({ days: 6 }), reviewPolicy: family.policy };
    const replacementResponse = await ctx.mutate(apis[1].baseUrl, `/api/v1/permit-applications/${changes.application.applicationId}/revisions`, ctx.key("d08-replacement"), replacementBody);
    requireStatus(ctx, replacementResponse, 200, "ledger replacement Revision");
    const replacementRevision = findObject(replacementResponse.json, "canonicalDigest");
    ctx.assert("ledger replacement Revision exact", () => assertApplicationRevision(replacementRevision));
    const collectionResponse = await ctx.request(api.baseUrl, "/api/v1/permitApplications?limit=100");
    requireStatus(ctx, collectionResponse, 200, "ledger collection");
    const camelDetail = await ctx.request(api.baseUrl, `/api/v1/permitApplications/${applicationId}`);
    requireStatus(ctx, camelDetail, 200, "ledger camel detail");
    const aggregateDetail = await applicationDetail(ctx, api.baseUrl, applicationId);
    const approvedDetail = await applicationDetail(ctx, api.baseUrl, approved.application.applicationId);
    const revisionResponse = await revisionDetail(ctx, api.baseUrl, applicationId, 1);
    const stages = await stagesDetail(ctx, api.baseUrl, applicationId);
    const events = await domainEvents(ctx, api.baseUrl, { aggregateId: applicationId, afterSequence: "0", limit: "100" });
    const worker = await ctx.startWorker();
    const workerState = await waitSnapshot(ctx, api.baseUrl, (value) => applicationFrom(value, due.application.applicationId)?.state === "EXPIRED" ? value : undefined, { label: "ledger Deadline Work", processes: [worker] });
    const receiver = await ctx.receiver();
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const delivery = await ctx.waitFor(() => receiver.ledger.find(({ acknowledged, json }) => acknowledged && json?.aggregateId === applicationId), { label: "ledger Event delivery", timeoutMs: 180_000, processes: [dispatcher] });
    ctx.assert("ledger webhook retry identity", () => assertRetryIdentity(receiver.ledger));
    const state = await snapshot(ctx, api.baseUrl);
    const stagedAuthority = assertAggregateDetailAuthority(aggregateDetail.json, state, applicationId);
    const deadlineWork = assertSingleAggregateWork(state.work, applicationId, { terminal: false });
    const dueTerminalWork = assertSingleAggregateWork(state.work, due.application.applicationId, { terminal: true });
    ctx.equal(stagedAuthority.application, applicationFrom(state, applicationId), "ledger detail closes snapshot Application");
    ctx.equal(stagedAuthority.revision, revisionResponse.revision, "ledger detail closes Revision endpoint");
    ctx.equal(stagedAuthority.claims, state.resources.reviewClaims.filter(({ applicationId: id }) => id === applicationId), "ledger detail closes Claim history");
    stages.forEach((stage) => ctx.assert(`${stage.stageId} ledger Stage exact`, () => assertReviewStage(stage)));
    events.items.forEach((event) => ctx.assert(`${event.eventId} ledger Event exact`, () => assertDomainEvent(event)));
    const { page } = await launchBrowser(ctx, api);
    await expectVisibleIdentity(page, applicationId);
    await page.getByText(applicationId, { exact: false }).first().click();
    await expectVisibleValues(page, [
      stagedAuthority.application.state,
      stagedAuthority.application.currentRevision,
      stagedAuthority.application.currentStageOrdinal,
      staged.revision.canonicalDigest,
      ...policyDisplayValues(staged.revision.policy),
      claimId,
      deadlineWork.workId,
      deadlineWork.state,
      ...stages.flatMap((stage) => [stage.stageId, stage.ordinal, stage.name, stage.state, ...policyDisplayValues(stage.policy)]),
      ...events.items.flatMap((event) => [event.eventId, event.type]),
    ], "ledger staged browser authority");
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    await expectVisibleIdentity(page, changes.application.applicationId);
    await page.getByText(changes.application.applicationId, { exact: false }).first().click();
    await expectVisibleIdentity(page, replacementRevision.canonicalDigest);
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    await expectVisibleIdentity(page, approved.application.applicationId);
    await page.getByText(approved.application.applicationId, { exact: false }).first().click();
    await expectVisibleValues(page, [
      approved.application.state,
      approved.revision.canonicalDigest,
      ...policyDisplayValues(approved.revision.policy),
      ...approved.claims.flatMap((claim) => [claim.claimId, claim.reviewerId, claim.role, claim.state]),
      ...approved.decisions.flatMap((decision) => [decision.decisionId, decision.decision, decision.reason]),
      ...approved.permits.flatMap((permit) => [permit.permitId, permit.canonicalDigest]),
    ], "ledger approved browser authority");

    const deliveredEventId = delivery.headers["x-permitforge-event-id"];
    const approvedDetailDecisionIds = new Set(findObjects(approvedDetail.json, "decisionId").map(({ decisionId }) => decisionId));
    const approvedDetailPermitIds = new Set(findObjects(approvedDetail.json, "permitId").map(({ permitId }) => permitId));
    const ledger = {
      migration: migration.exitCode === 0 && migrationReplay.exitCode === 0,
      seed: seeded.exitCode === 0 && state.resources.permitApplications.some(({ applicationId: id }) => id === due.application.applicationId),
      "production-build": built.exitCode === 0 && built.durationMs > 0,
      "production-boot": health.status === 200 && apis.every(({ child }) => child.exitCode === null),
      "collection-read": collectionResponse.json.items.some(({ applicationId: id }) => id === applicationId),
      "aggregate-detail": findObject(camelDetail.json, "applicationId")?.applicationId === applicationId && findObject(aggregateDetail.json, "applicationId")?.applicationId === applicationId,
      "immutable-revision": revisionResponse.revision.canonicalDigest === staged.revision.canonicalDigest && state.resources.applicationRevisions.some(({ applicationId: id, revision, canonicalDigest }) => id === changes.application.applicationId && revision === 2 && canonicalDigest === replacementRevision.canonicalDigest),
      "captured-policy": canonicalJson(revisionResponse.revision.policy) === canonicalJson(staged.revision.policy),
      "staged-submit": staged.response.status === 201 && stages.length === 5 && stages[0].state === "ACTIVE" && stages.slice(1).every(({ state: stageState }) => stageState === "PENDING"),
      "current-stage-claim": claimResponse.status === 200 && state.resources.reviewClaims.some(({ claimId: id }) => id === claimId),
      "replacement-revision": replacementResponse.status === 200 && replacementRevision.revision === 2,
      "durable-idempotency": replay.status === staged.response.status && canonicalJson(replay.json) === canonicalJson(staged.response.json) && state.resources.permitApplications.filter(({ applicationId: id }) => id === applicationId).length === 1,
      "validation-error": invalid.status === 400 && invalid.json.error.code === "UNKNOWN_FIELD",
      "deadline-work": applicationFrom(workerState, due.application.applicationId)?.state === "EXPIRED" && dueTerminalWork.aggregateId === due.application.applicationId && dueTerminalWork.terminal,
      "transactional-event": events.items.some(({ aggregateId, type }) => aggregateId === applicationId && type === "application.submitted") && state.events.some(({ eventId }) => eventId === deliveredEventId),
      "dispatcher-delivery": delivery.acknowledged === true && receiver.ledger.some(({ headers }) => headers["x-permitforge-event-id"] === deliveredEventId),
      "openapi-runtime": ctx.assert("ledger submit exact OpenAPI operation", () => assertExactOpenApiOperation(document, "/api/v1/permit-applications", "post", {
        ...D01_OPERATION_CONTRACTS["POST /api/v1/permit-applications"],
        validRequests: [stagedBody],
        invalidRequests: [{ ...stagedBody, unknown: true }],
        validResponses: [staged.response, invalid],
        invalidResponses: [...corruptClosedObject(staged.response), exactErrorSample(invalid)],
      })),
      "browser-authority": (await page.getByText(approved.application.applicationId, { exact: false }).count()) > 0 && (await page.getByText(approved.permits[0].permitId, { exact: false }).count()) > 0,
      "verification-snapshot": state.resources.reviewStages.filter(({ applicationId: id }) => id === applicationId).length === 5 && deadlineWork.aggregateId === applicationId,
      "seeded-decision-history": approved.decisions.every(({ decisionId }) => state.resources.reviewDecisions.some(({ decisionId: id }) => id === decisionId) && approvedDetailDecisionIds.has(decisionId)),
      "seeded-permit-history": approved.permits.every(({ permitId }) => state.resources.approvedPermits.some(({ permitId: id }) => id === permitId) && approvedDetailPermitIds.has(permitId)),
    };
    ctx.equal(Object.keys(ledger), D08_LEDGER_NODES, "README evidence ledger node order is frozen");
    for (const [node, executed] of Object.entries(ledger)) ctx.ok(executed, `${node} evidence executed`);
    ctx.assert("ledger Event sequence", () => assertAggregateSequences(events.items));
    assertExternalSecretBoundary(
      { state, receiver: receiver.ledger, html: await page.locator("html").innerHTML(), logs: apis.map(({ logs }) => logs) },
      ctx,
      [stagedKey, ctx.key("d08-invalid"), ctx.key("d08-claim"), ctx.key("d08-replacement")],
    );
    return caseResult(ctx, {
      applicationId,
      claimId,
      stageIds: stages.map(({ stageId }) => stageId),
      ledger: Object.fromEntries(D08_REQUIREMENT_CHAINS.map((item) => [item.node, {
        requirement: item.requirement,
        layers: item.layers,
        hiddenCases: item.hiddenCases,
        localExecution: ledger[item.node],
        status: item.hiddenCases.some((id) => id !== "D-08" && priorEvidence.evidence[id]?.status === "diagnostic") ? "partial" : "passed",
        caseEvidence: Object.fromEntries(item.hiddenCases.map((id) => [id, id === "D-08"
          ? { status: "executing", evidenceDigest: null }
            : priorEvidence.evidence[id]])),
      }])),
      prerequisiteEvidence: { passed: priorEvidence.passed, partial: priorEvidence.partial, excluded: priorEvidence.excluded },
    });
  },
  [
    blocked("PF-D08-CLAIM-TOKEN-WIRE", "PF-GAP-01"),
    blocked("PF-D08-LEGACY-MEDIA-TYPE", "PF-GAP-02"),
    blocked("PF-D08-INVALID-ORDINAL", "PF-GAP-03"),
    blocked("PF-D08-CLAIM-STAGE-ASSOCIATION", "PF-GAP-04"),
    blocked("PF-D08-STAGE-NAME-VALIDATION", "PF-GAP-05"),
  ],
);

export const D_CASES = Object.freeze([d01, d02, d03, d04, d05, d06, d07, d08]);
