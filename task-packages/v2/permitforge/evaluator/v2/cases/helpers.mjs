import assert from "node:assert/strict";

import {
  assertAggregateSequences,
  assertApprovedPermit,
  assertApplicationRevision,
  assertNoSecrets,
  assertOpenApiDocument,
  assertPermitApplication,
  assertPublicError,
  assertReviewClaim,
  assertReviewDecision,
  assertReviewStage,
  assertStageEvidence,
  assertSnapshot,
  canonicalJson,
  exactKeys,
} from "../oracles/index.mjs";
import { CaseExcluded } from "../lib/execution.mjs";

export function blocked(assertionId, blockedBy) {
  return Object.freeze({ assertionId, blockedBy, policy: "fail-closed-diagnostic" });
}

export function defineCase(id, fixtureFamily, action, oracle, seams, operation, blockedAssertions = []) {
  const diagnostics = Object.freeze(blockedAssertions.map((item) => Object.freeze({ ...item })));
  return Object.freeze({
    id,
    taskId: "permitforge",
    fixtureFamily,
    action,
    oracle,
    seams: Object.freeze([...seams]),
    blockedAssertions: diagnostics,
    async run(ctx) {
      const result = await operation(ctx);
      return diagnostics.length ? { ...result, diagnostics } : result;
    },
  });
}

export function caseResult(ctx, details = {}) {
  return ctx.pass({ evidence: [{ taskId: "permitforge", caseId: ctx.caseId, ...details }] });
}

export function findDeep(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeep(item, key);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === "object") {
    if (Object.hasOwn(value, key)) return value[key];
    for (const item of Object.values(value)) {
      const found = findDeep(item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function findObject(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, key);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    if (Object.hasOwn(value, key)) return value;
    for (const item of Object.values(value)) {
      const found = findObject(item, key);
      if (found) return found;
    }
  }
  return undefined;
}

export function findObjects(value, key, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) findObjects(item, key, found);
  } else if (value && typeof value === "object") {
    if (Object.hasOwn(value, key)) found.push(value);
    for (const item of Object.values(value)) findObjects(item, key, found);
  }
  return found;
}

export function requireStatus(ctx, response, expected, label = "request", options = {}) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  ctx.ok(statuses.includes(response.status), `${label} expected ${statuses.join("/")}, got ${response.status}: ${response.text}`, options);
  if (options.json !== false) ctx.ok(response.json !== undefined, `${label} returns JSON`, options);
  return response.json;
}

export function expectError(ctx, response, status, code, options = {}) {
  ctx.assert(`${code} exact public error`, () => assertPublicError(response, status, code), options);
  return response;
}

export async function mutate(ctx, baseUrl, path, label, body = {}, options = {}) {
  const response = await ctx.mutate(baseUrl, path, options.key ?? ctx.key(label), body, { method: options.method ?? "POST", admin: options.admin, headers: options.headers, timeoutMs: options.timeoutMs, contractExpectation: options.contractExpectation });
  if (options.expected) requireStatus(ctx, response, options.expected, label, options.assertionOptions);
  return response;
}

export async function boot(ctx, options = {}) {
  if (options.install) await ctx.command("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
  if (options.migrate !== false) await ctx.migrate({ timeoutMs: 300_000 });
  if (options.build) await ctx.npm("build", [], { timeoutMs: 600_000 });
  const family = options.family ?? ctx.fixtures.main();
  if (options.seed !== false) await ctx.seed(options.seed ?? family.seed, { timeoutMs: options.seedTimeoutMs ?? 300_000 });
  const apis = [];
  for (let index = 0; index < (options.apiCount ?? 1); index += 1) apis.push(await ctx.startApi({ healthTimeoutMs: 60_000 }));
  return { family, apis, api: apis[0] };
}

export async function snapshot(ctx, baseUrl, options = {}) {
  const value = await ctx.snapshot(baseUrl, options);
  ctx.assert("exact point-in-time PermitForge snapshot", () => assertSnapshot(value, { final: options.final ?? true }), options.assertionOptions);
  return value;
}

export function stableSnapshot(value) {
  const { asOf: _asOf, ...stable } = value;
  return stable;
}

function canonicalOrder(values) {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(canonicalJson(left)), Buffer.from(canonicalJson(right))));
}

/** Close every resource exposed by aggregate detail against one authoritative snapshot. */
export function assertAggregateDetailAuthority(detail, state, applicationId, options = {}) {
  exactKeys(detail, ["permitApplication", "applicationRevision", "reviewPolicy", "reviewClaims", "reviewDecisions", "approvedPermit"], "Application detail");
  const application = findObjects(detail, "currentRevision").filter((item) => item.applicationId === applicationId && Number.isSafeInteger(item.currentRevision));
  assert.equal(application.length, 1, "detail exposes one Application");
  assertPermitApplication(application[0], { final: options.final ?? true });
  const authoritativeApplication = applicationFrom(state, applicationId);
  assert.deepEqual(application[0], authoritativeApplication, "detail Application equals snapshot");

  const revisions = findObjects(detail, "canonicalDigest").filter((item) => item.applicationId === applicationId && Object.hasOwn(item, "fields"));
  assert.equal(revisions.length, 1, "detail exposes one current Revision");
  assertApplicationRevision(revisions[0]);
  const authoritativeRevision = revisionsFor(state, applicationId).find(({ revision }) => revision === authoritativeApplication.currentRevision);
  assert.deepEqual(revisions[0], authoritativeRevision, "detail current Revision equals snapshot");

  const claims = findObjects(detail, "claimId").filter((item) => item.applicationId === applicationId);
  claims.forEach(assertReviewClaim);
  assert.deepEqual(canonicalOrder(claims), canonicalOrder(claimsFor(state, applicationId)), "detail Claims equal snapshot history");

  const decisions = findObjects(detail, "decisionId").filter((item) => item.applicationId === applicationId);
  decisions.forEach(assertReviewDecision);
  assert.deepEqual(canonicalOrder(decisions), canonicalOrder(decisionsFor(state, applicationId)), "detail Decisions equal snapshot history");

  const permits = findObjects(detail, "permitId").filter((item) => item.applicationId === applicationId);
  permits.forEach(assertApprovedPermit);
  const expectedPermit = permitFor(state, applicationId);
  assert.deepEqual(canonicalOrder(permits), expectedPermit ? [expectedPermit] : [], "detail Permit equals snapshot authority");
  return { application: application[0], revision: revisions[0], claims, decisions, permit: permits[0] };
}

export function assertClaimTuple(claim, expected) {
  assertReviewClaim(claim);
  for (const [field, value] of Object.entries(expected)) assert.deepEqual(claim[field], value, `ReviewClaim ${field}`);
  return true;
}

const RESOURCE_IDENTITIES = Object.freeze({
  applicants: (value) => value.applicantId,
  reviewers: (value) => value.reviewerId,
  permitApplications: (value) => value.applicationId,
  applicationRevisions: (value) => `${value.applicationId}:${value.revision}`,
  reviewClaims: (value) => value.claimId,
  reviewDecisions: (value) => value.decisionId,
  approvedPermits: (value) => value.permitId,
});

/** Prove every pre-migration resource has exactly one equal post-migration identity. */
export function assertV1ResourceBijection(beforeResources, afterResources, options = {}) {
  for (const [name, identity] of Object.entries(RESOURCE_IDENTITIES)) {
    const before = beforeResources[name];
    const after = afterResources[name];
    assert.ok(Array.isArray(before) && Array.isArray(after), `${name} resource arrays`);
    assert.equal(new Set(before.map(identity)).size, before.length, `${name} V1 identities unique`);
    assert.equal(new Set(after.map(identity)).size, after.length, `${name} FINAL identities unique`);
    for (const expected of before) {
      const matches = after.filter((item) => identity(item) === identity(expected));
      assert.equal(matches.length, 1, `${name} ${identity(expected)} exact one-to-one identity`);
      const actual = name === "permitApplications" && options.projectApplication
        ? options.projectApplication(matches[0])
        : matches[0];
      assert.deepEqual(actual, expected, `${name} ${identity(expected)} immutable payload`);
    }
  }
  return true;
}

function responseHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
}

function responseBody(value) {
  if (typeof value?.body === "string") return Buffer.from(value.body);
  if (Buffer.isBuffer(value?.body)) return value.body;
  if (typeof value?.text === "string") return Buffer.from(value.text);
  return Buffer.alloc(0);
}

/** Compare the replay contract without volatile transport headers such as Date or Connection. */
export function assertSavedHttpReplay(saved, replay) {
  assert.equal(replay.status, saved.status, "saved HTTP status");
  assert.deepEqual(responseBody(replay), responseBody(saved), "saved raw response bytes");
  for (const name of ["content-type", "content-length", "etag", "location"]) {
    const expected = responseHeader(saved.headers, name);
    if (expected !== null && expected !== undefined) assert.equal(responseHeader(replay.headers, name), expected, `saved ${name} header`);
  }
  return true;
}

export async function waitSnapshot(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const value = await ctx.snapshot(baseUrl, { timeoutMs: options.requestTimeoutMs });
    return predicate(value) ? value : undefined;
  }, { timeoutMs: options.timeoutMs ?? 180_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "PermitForge durable state", processes: options.processes ?? [] });
}

export async function submitApplication(ctx, baseUrl, body, label = "submit", options = {}) {
  const response = await mutate(ctx, baseUrl, "/api/v1/permit-applications", label, body, { key: options.key, expected: 201, timeoutMs: options.timeoutMs });
  const application = response.json;
  ctx.assert(`${label} top-level Application`, () => assertPermitApplication(application, { final: Object.hasOwn(application, "stages") }));
  const revisionResponse = await ctx.request(baseUrl, `/api/v1/permit-applications/${application.applicationId}/revisions/${application.currentRevision}`);
  requireStatus(ctx, revisionResponse, 200, `${label} read captured Revision`);
  const revision = revisionResponse.json;
  ctx.assert(`${label} Revision exact public fields`, () => assertApplicationRevision(revision));
  return { response, application, revision };
}

export function claimResource(value) {
  const { claimToken, ...claim } = value;
  assert.ok(typeof claimToken === "string" && claimToken.length > 0, "Claim response exposes claimToken");
  assertReviewClaim(claim);
  return claim;
}

export async function claimReview(ctx, baseUrl, applicationId, body, label = "claim", options = {}) {
  const response = await mutate(ctx, baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, label, body, { key: options.key, expected: options.expected ?? 200 });
  const claim = claimResource(response.json);
  ctx.assert(`${label} ReviewClaim exact public fields`, () => assertReviewClaim(claim));
  return { response, claim };
}

export async function createRevision(ctx, baseUrl, applicationId, body, label = "revision", options = {}) {
  const response = await mutate(ctx, baseUrl, `/api/v1/permit-applications/${applicationId}/revisions`, label, body, { key: options.key, expected: options.expected ?? 200 });
  const revision = findObject(response.json, "canonicalDigest");
  if (revision) ctx.assert(`${label} exact Revision`, () => assertApplicationRevision(revision));
  return { response, revision };
}

export async function applicationDetail(ctx, baseUrl, applicationId, options = {}) {
  const response = await ctx.request(baseUrl, `/api/v1/permit-applications/${applicationId}`, options);
  requireStatus(ctx, response, 200, "Application detail");
  return response;
}

export async function applicationCurrent(ctx, baseUrl, applicationId, options = {}) {
  const response = await ctx.request(baseUrl, `/api/v1/permitApplications/${applicationId}`, options);
  requireStatus(ctx, response, 200, "current Application");
  return response;
}

export async function revisionDetail(ctx, baseUrl, applicationId, revision, options = {}) {
  const response = await ctx.request(baseUrl, `/api/v1/permit-applications/${applicationId}/revisions/${revision}`, options);
  requireStatus(ctx, response, 200, "Revision detail");
  const resource = findObject(response.json, "canonicalDigest") ?? response.json;
  ctx.assert("Revision detail exact", () => assertApplicationRevision(resource));
  return { response, revision: resource };
}

export async function stagesDetail(ctx, baseUrl, applicationId) {
  return (await stageEvidence(ctx, baseUrl, applicationId)).items;
}

export async function stageEvidence(ctx, baseUrl, applicationId, options = {}) {
  const response = await ctx.request(baseUrl, `/api/v1/permit-applications/${applicationId}/stages`);
  requireStatus(ctx, response, 200, "Stages detail");
  return assertStageEvidence(response.json, options);
}

export async function decideReview(ctx, baseUrl, claimed, decision, label, options = {}) {
  const response = await mutate(ctx, baseUrl, `/api/v1/review-claims/${claimed.claim.claimId}/decisions`, label,
    { claimToken: claimed.response.json.claimToken, decision, reason: label }, { key: options.key, expected: 200 });
  assertPermitApplication(response.json, { final: Object.hasOwn(response.json, 'stages') });
  return { response, application: response.json };
}

/** Actual public workflow: repeated names/reviewer, two explicit Stage identities. */
export async function exerciseRepeatedReviewerStages(ctx, baseUrl, body, label = 'repeated-reviewer') {
  assert.equal(body.stages.length, 2);
  const role = body.stages[0].reviewPolicy.roles[0], reviewerId = role.eligibleReviewerIds[0];
  const created = await submitApplication(ctx, baseUrl, body, `${label}-create`);
  const applicationId = created.application.applicationId;
  const initial = await stageEvidence(ctx, baseUrl, applicationId);
  const [firstStage, secondStage] = initial.items;
  assert.equal(firstStage.name, secondStage.name, 'fixture exercises duplicate display names');
  assert.notEqual(firstStage.stageId, secondStage.stageId, 'duplicate names retain distinct Stage identity');
  const first = await claimReview(ctx, baseUrl, applicationId, { reviewerId, role: role.role }, `${label}-claim-1`);
  const firstDecision = await decideReview(ctx, baseUrl, first, 'APPROVE', `${label}-decision-1`);
  const afterFirst = await snapshot(ctx, baseUrl);
  const firstDecisions = afterFirst.resources.reviewDecisions.filter(item => item.applicationId === applicationId);
  assert.equal(firstDecisions.length, 1, 'Stage 1 commits one Decision');
  const completed = await stageEvidence(ctx, baseUrl, applicationId, { claims: afterFirst.resources.reviewClaims, decisions: afterFirst.resources.reviewDecisions });
  assert.deepEqual(completed.items.map(item => item.state), ['COMPLETED', 'ACTIVE'], 'Stage advancement is atomic');
  assert.deepEqual(completed.evidence[0], { stageId: firstStage.stageId, claimIds: [first.claim.claimId], decisionIds: [firstDecisions[0].decisionId] }, 'first observed Decision is bound to Stage 1');
  const secondRole = body.stages[1].reviewPolicy.roles[0];
  const second = await claimReview(ctx, baseUrl, applicationId, { reviewerId, role: secondRole.role }, `${label}-claim-2`);
  assert.notEqual(second.claim.claimId, first.claim.claimId, 'later Stage creates a distinct Claim identity');
  const beforeReplay = await snapshot(ctx, baseUrl);
  const stale = await mutate(ctx, baseUrl, `/api/v1/review-claims/${first.claim.claimId}/decisions`, `${label}-stale`, { claimToken: first.response.json.claimToken, decision: 'APPROVE', reason: 'old Stage cannot vote in new Stage' });
  expectError(ctx, stale, 409, 'REVIEW_STAGE_CHANGED');
  const replay = await mutate(ctx, baseUrl, `/api/v1/review-claims/${first.claim.claimId}/decisions`, `${label}-decision-1`, { claimToken: first.response.json.claimToken, decision: 'APPROVE', reason: `${label}-decision-1` });
  assertSavedHttpReplay(firstDecision.response, replay);
  assert.deepEqual(stableSnapshot(await snapshot(ctx, baseUrl)), stableSnapshot(beforeReplay), 'stale old token and saved replay add no current-Stage vote or event');
  const approved = await decideReview(ctx, baseUrl, second, 'APPROVE', `${label}-decision-2`);
  assert.equal(approved.application.state, 'APPROVED', 'same Reviewer can approve both Stages');
  const final = await snapshot(ctx, baseUrl);
  const evidence = await stageEvidence(ctx, baseUrl, applicationId, { claims: final.resources.reviewClaims, decisions: final.resources.reviewDecisions, previous: completed });
  assert.deepEqual(evidence.items.map(item => item.state), ['COMPLETED', 'COMPLETED']);
  const decisions = final.resources.reviewDecisions.filter(item => item.applicationId === applicationId);
  assert.equal(decisions.length, 2, 'two separate Stage votes, not one Revision-global vote');
  assert(decisions.every(item => item.reviewerId === reviewerId && item.revision === 1));
  const newDecision = decisions.find(item => item.decisionId !== firstDecisions[0].decisionId);
  assert.deepEqual(evidence.evidence[1], { stageId: secondStage.stageId, claimIds: [second.claim.claimId], decisionIds: [newDecision.decisionId] }, 'second observed Decision is bound to Stage 2');
  return { applicationId, evidence, decisions, claims: final.resources.reviewClaims.filter(item => item.applicationId === applicationId) };
}

export async function domainEvents(ctx, baseUrl, query = {}) {
  const response = await ctx.request(baseUrl, `/api/v1/domain-events?${new URLSearchParams(query)}`);
  requireStatus(ctx, response, 200, "Domain Events");
  exactKeys(response.json, ["items", "nextCursor"], "Domain Event page");
  ctx.assert("Domain Event aggregate sequences", () => assertAggregateSequences(response.json.items));
  return response.json;
}

export async function openApi(ctx, baseUrl) {
  const response = await ctx.request(baseUrl, "/openapi.json");
  requireStatus(ctx, response, 200, "OpenAPI");
  ctx.assert("independent OpenAPI 3.1 contract", () => assertOpenApiDocument(response.json));
  return response.json;
}

export function stableResponse(ctx, responses, label, options = {}) {
  ctx.ok(responses.length > 0, `${label} responses`);
  ctx.equal(new Set(responses.map(({ status }) => status)).size, 1, `${label} status`, options);
  ctx.equal(new Set(responses.map(({ json }) => canonicalJson(json))).size, 1, `${label} semantic body`, options);
  return responses[0];
}

export function applicationFrom(state, applicationId) {
  return state.resources.permitApplications.find((item) => item.applicationId === applicationId);
}

export function revisionsFor(state, applicationId) {
  return state.resources.applicationRevisions.filter((item) => item.applicationId === applicationId);
}

export function claimsFor(state, applicationId) {
  return state.resources.reviewClaims.filter((item) => item.applicationId === applicationId);
}

export function decisionsFor(state, applicationId) {
  return state.resources.reviewDecisions.filter((item) => item.applicationId === applicationId);
}

export function permitFor(state, applicationId) {
  return state.resources.approvedPermits.find((item) => item.applicationId === applicationId);
}

export function requireV1Workspace(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  return ctx.forWorkspace(ctx.v1Workspace);
}

export async function publishedGate(ctx, script, timeoutMs = 900_000, options = {}) {
  const result = await ctx.npm(script, [], { timeoutMs, allowFailure: options.allowFailure, env: options.env });
  if (!options.allowFailure) ctx.equal(result.exitCode, 0, `${script} exit`);
  ctx.ok(result.durationMs > 0, `${script} actually ran`);
  return result;
}

export async function launchBrowser(ctx, api, options = {}) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  ctx.mark("Chromium", { kind: "production Chromium launched" });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1280, height: 900 } });
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  ctx.mark("UI", { kind: `production UI ${options.viewport ? "custom" : "desktop"} navigation` });
  return { browser, page };
}

export async function fillVisible(page, patterns, value) {
  for (const pattern of patterns) {
    const locator = page.getByLabel(pattern).first();
    if (await locator.count()) {
      await locator.fill(String(value));
      return locator;
    }
  }
  throw new Error(`visible labeled control not found: ${patterns.join(", ")}`);
}

export async function clickVisible(page, patterns) {
  for (const pattern of patterns) {
    const locator = page.getByRole("button", { name: pattern }).first();
    if (await locator.count()) {
      await locator.click();
      return locator;
    }
  }
  throw new Error(`visible button not found: ${patterns.join(", ")}`);
}

export async function keyboardActivate(page, patterns) {
  for (const pattern of patterns) {
    const locator = page.getByRole("button", { name: pattern }).first();
    if (await locator.count()) {
      await locator.focus();
      await page.keyboard.press("Enter");
      return locator;
    }
  }
  throw new Error(`keyboard action not found: ${patterns.join(", ")}`);
}

export async function expectVisibleIdentity(page, identity) {
  assert.ok(identity, "identity required");
  await page.getByText(String(identity), { exact: false }).first().waitFor({ state: "visible" });
}

export async function captureJsonResponse(page, predicate, action) {
  const pending = page.waitForResponse((response) => predicate(new URL(response.url()), response));
  await action();
  const response = await pending;
  return { status: response.status(), json: await response.json(), response };
}

export async function crashDeadlineAt(ctx, baseUrl, point, options = {}) {
  let armed = true;
  const barrier = await ctx.barrier({ hold: ({ processRole, point: actual, aggregateId }) => armed && processRole === "worker" && actual === point && (!options.applicationId || aggregateId === options.applicationId) });
  const first = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const entry = await barrier.waitFor(({ json }) => json.point === point && (!options.applicationId || json.aggregateId === options.applicationId), { timeoutMs: 120_000, processes: [first] });
  const before = await snapshot(ctx, baseUrl);
  await ctx.kill(first);
  armed = false;
  await ctx.sleep(options.leaseWaitMs ?? 3_300);
  const replacement = await ctx.startWorker();
  const after = await waitSnapshot(ctx, baseUrl, (value) => value.work.some(({ workId, terminal }) => workId === entry.json.workId && terminal), { label: `${point} replacement`, timeoutMs: options.timeoutMs ?? 180_000, processes: [replacement] });
  return { barrier, entry, before, after, first, replacement };
}

export function assertExternalSecretBoundary(value, ctx, extra = []) {
  return ctx.assert("secret and token omission", () => assertNoSecrets(value, [ctx.adminToken, ctx.barrierToken, ctx.databaseUrl, ctx.managedDataRoot, ...extra]));
}

export function assertFinalApplication(ctx, application, options = {}) {
  return ctx.assert(options.label ?? "FINAL Application exact shape", () => assertPermitApplication(application, { final: true }), options.assertionOptions);
}
