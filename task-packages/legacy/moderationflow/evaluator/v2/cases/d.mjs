import assert from "node:assert/strict";

import { assertAuditChain, canonical, exactKeys } from "../oracles/index.mjs";
import {
  activatePolicyVersion, claimStage, createContent, createPolicyVersion, createRecall, defineCase, expectError,
  finalEvidence, getRecall, prepare, resource, snapshot, stopAll, waitSnapshot, waitStage, withPage,
} from "./helpers.mjs";

const RESOURCE_KEYS = Object.freeze([
  "appeals", "auditCheckpoints", "auditEntries", "contentItems", "evidenceVersions", "moderationCases",
  "moderationDecisions", "policies", "policyRecallRuns", "policyVersions", "reconsiderations", "reviewStages", "tenants",
]);
const ROUTES = Object.freeze([
  ["/api/v1/tenants", "post"], ["/api/v1/policies", "post"], ["/api/v1/policies/{policyId}/versions", "post"],
  ["/api/v1/policy-versions/{policyVersionId}/activate", "post"], ["/api/v1/content-items", "post"],
  ["/api/v1/content-items/{contentItemId}/evidence-versions", "post"], ["/api/v1/moderation-cases/{caseId}", "get"],
  ["/api/v1/review-stages", "get"], ["/api/v1/review-stages/{stageId}/claim", "post"],
  ["/api/v1/review-stages/{stageId}/decisions", "post"], ["/api/v1/moderation-cases/{caseId}/appeals", "post"],
  ["/api/v1/appeals/{appealId}/decision", "post"], ["/api/v1/audit/verify", "get"], ["/api/v1/audit", "get"],
  ["/api/v1/verification-snapshot", "get"], ["/api/v1/policy-recall-runs", "post"],
  ["/api/v1/policy-recall-runs/{runId}", "get"], ["/api/v1/policy-recall-runs/{runId}/cancel", "post"],
]);

function stableState(value) {
  const clone = structuredClone(value);
  delete clone.asOf;
  return canonical(clone);
}

function recursivelyRejectSecrets(ctx, value, path = "response") {
  if (Array.isArray(value)) { for (const [index, child] of value.entries()) recursivelyRejectSecrets(ctx, child, `${path}[${index}]`); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    ctx.ok(!/^(?:idempotencyKey|leaseToken|rawEvidence|privatePath|secret|credential)$/iu.test(key), `${path}.${key} is not a private field`);
    recursivelyRejectSecrets(ctx, child, `${path}.${key}`);
  }
}

const D01 = defineCase("D-01", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("d01");
  const { api } = await prepare(ctx, { seed });
  const openapiResponse = await ctx.request(api.baseUrl, "/openapi.json");
  ctx.equal(openapiResponse.status, 200, "OpenAPI status");
  const document = openapiResponse.json;
  ctx.ok(/^3\.1(?:\.|$)/u.test(document?.openapi ?? ""), "OpenAPI 3.1 is published");
  for (const [path, method] of ROUTES) ctx.ok(document.paths?.[path]?.[method], `OpenAPI publishes ${method.toUpperCase()} ${path}`);
  const source = JSON.stringify(document);
  for (const code of [
    "IDEMPOTENCY_CONFLICT", "EXTERNAL_CONTENT_CONFLICT", "EVIDENCE_HEAD_CHANGED", "REVIEW_LEASE_CONFLICT",
    "APPEAL_ALREADY_EXISTS", "APPEAL_WINDOW_CLOSED", "POLICY_RECALL_VERSION_MISMATCH",
    "POLICY_RECALL_RUN_TERMINAL", "POLICY_RECALL_POLICY_INCOMPATIBLE", "POLICY_RECALL_RANGE_INVALID", "NOT_FOUND",
  ]) ctx.ok(source.includes(code), `OpenAPI publishes ${code}`);

  const before = await snapshot(ctx, api.baseUrl);
  const body = ctx.fixtures.submission(seed, "d01");
  const malformed = await ctx.request(api.baseUrl, "/api/v1/content-items", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("d01-malformed") }, raw: "{",
  });
  ctx.equal(malformed.status, 400, "malformed JSON status");
  ctx.ok(typeof malformed.json?.error?.code === "string", "malformed JSON stable error");
  const media = await ctx.request(api.baseUrl, "/api/v1/content-items", {
    method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("d01-media") }, raw: "x",
  });
  ctx.equal(media.status, 415, "unsupported media type status");
  ctx.ok(typeof media.json?.error?.code === "string", "unsupported media type stable error");
  const unknown = await ctx.mutate(api.baseUrl, "/api/v1/content-items", ctx.key("d01-unknown"), { ...body, evaluatorUnknown: true });
  ctx.equal(unknown.status, 400, "unknown content field status");
  ctx.ok(typeof unknown.json?.error?.code === "string", "unknown content field stable error");
  const missing = await ctx.request(api.baseUrl, `/api/v1/moderation-cases/${ctx.fixtures.uuid("d01-missing")}`);
  expectError(ctx, missing, 404, "NOT_FOUND", "missing ModerationCase");
  const invalidRange = await createRecall(ctx, api.baseUrl, {
    tenantId: seed.tenants[0].tenantId, recalledPolicyVersionId: seed.policyVersions[0].policyVersionId,
    replacementPolicyVersionId: seed.policyVersions[0].policyVersionId,
    decidedFrom: "2035-06-02T00:00:00.000Z", decidedTo: "2035-06-01T00:00:00.000Z",
  }, { allowFailure: true, key: ctx.key("d01-range") });
  expectError(ctx, invalidRange, 400, "POLICY_RECALL_RANGE_INVALID", "invalid Recall range");
  ctx.equal(stableState(await snapshot(ctx, api.baseUrl)), stableState(before), "all rejected HTTP requests are atomic");

  const created = await createContent(ctx, api.baseUrl, body);
  const caseId = resource(created, "caseId");
  const read = await ctx.request(api.baseUrl, `/api/v1/moderation-cases/${caseId}`);
  ctx.equal(read.status, 200, "ModerationCase read status");
  exactKeys(read.json, ["caseId", "contentItemId", "policyVersionId", "evidenceHeadVersion", "state", "finalDecisionId", "createdAt", "decidedAt", "sequence"], "ModerationCase response");
  const stages = await ctx.request(api.baseUrl, "/api/v1/review-stages?state=OPEN&limit=10");
  ctx.equal(stages.status, 200, "ReviewStage collection status");
  exactKeys(stages.json, ["items", "nextCursor"], "ReviewStage collection");
  ctx.ok(Array.isArray(stages.json.items), "ReviewStage collection items");
  recursivelyRejectSecrets(ctx, { document, read: read.json, stages: stages.json });
  return finalEvidence(ctx, { openapiRoutes: ROUTES.length, caseId, rejectedRequests: 5 });
});

async function firstVisible(locators, label) {
  for (const locator of locators) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  throw new Error(`visible ${label} not found`);
}

async function click(page, pattern, label = String(pattern)) {
  const target = await firstVisible([
    page.getByRole("button", { name: pattern }), page.getByRole("link", { name: pattern }),
    page.getByRole("tab", { name: pattern }), page.getByText(pattern, { exact: true }),
  ], label);
  await target.click();
}

async function setField(page, pattern, value, label = String(pattern)) {
  const target = await firstVisible([
    page.getByLabel(pattern), page.getByRole("textbox", { name: pattern }), page.getByRole("combobox", { name: pattern }),
    page.getByRole("spinbutton", { name: pattern }), page.getByPlaceholder(pattern),
  ], label);
  const tag = await target.evaluate((node) => node.tagName.toLowerCase());
  if (tag === "select") {
    await target.selectOption({ value: String(value) }).catch(() => target.selectOption({ label: String(value) }));
  } else {
    const inputType = await target.getAttribute("type");
    const rendered = inputType === "datetime-local" ? String(value).replace(/Z$/u, "").slice(0, 16) : String(value);
    await target.fill(rendered);
  }
}

async function optionalField(page, pattern, value) {
  const target = page.getByLabel(pattern).or(page.getByPlaceholder(pattern)).first();
  if (!await target.count() || !await target.isVisible().catch(() => false)) return;
  const tag = await target.evaluate((node) => node.tagName.toLowerCase());
  if (tag === "select") await target.selectOption({ value: String(value) }).catch(() => target.selectOption({ label: String(value) }));
  else await target.fill(String(value));
}

async function navigate(page, pattern) {
  const target = page.getByRole("link", { name: pattern }).or(page.getByRole("button", { name: pattern })).or(page.getByRole("tab", { name: pattern })).first();
  if (await target.count() && await target.isVisible().catch(() => false)) await target.click();
}

async function submitContentInUi(ctx, page, seed, label) {
  const body = ctx.fixtures.submission(seed, label);
  await navigate(page, /submit|content|ingest/i);
  await setField(page, /tenant/i, body.tenantId, "Tenant");
  await setField(page, /policy/i, body.policyId, "Policy");
  await setField(page, /external.*content|external.*id/i, body.externalContentId, "External Content ID");
  await setField(page, /content.*type|type/i, body.contentType, "Content Type");
  await setField(page, /body.*digest|content.*digest/i, body.bodyDigest, "Body digest");
  await optionalField(page, /^text|content text/i, body.text);
  await optionalField(page, /evidence.*kind|kind/i, body.initialEvidence.kind);
  await setField(page, /evidence.*digest/i, body.initialEvidence.digest, "Evidence digest");
  await setField(page, /evidence.*summary|summary/i, body.initialEvidence.summary, "Evidence summary");
  await optionalField(page, /created.*by|author/i, body.initialEvidence.createdBy);
  await click(page, /submit|create content|ingest/i, "submit ContentItem");
  await page.getByText(body.externalContentId, { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
  return body;
}

async function appendEvidenceInUi(ctx, page, label) {
  const evidence = ctx.fixtures.evidence(label, 1, { kind: "REPORT" });
  await navigate(page, /evidence|content/i);
  await optionalField(page, /expected.*head|head.*version/i, evidence.expectedHeadVersion);
  await optionalField(page, /evidence.*kind|kind/i, evidence.kind);
  await setField(page, /evidence.*digest|digest/i, evidence.digest, "Evidence digest");
  await setField(page, /evidence.*summary|summary/i, evidence.summary, "Evidence summary");
  await optionalField(page, /created.*by|author/i, evidence.createdBy);
  await click(page, /append evidence|add evidence|save evidence/i, "append EvidenceVersion");
  await page.getByText(evidence.summary, { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
  return evidence;
}

async function claimAndDecideInUi(page, { reviewerId, outcome }) {
  await navigate(page, /queue|review/i);
  await optionalField(page, /reviewer|assignee/i, reviewerId);
  await click(page, /claim/i, "claim ReviewStage");
  await optionalField(page, /outcome|decision/i, outcome);
  await optionalField(page, /category/i, outcome === "ALLOW" ? "SAFE" : "ABUSE");
  await optionalField(page, /reason/i, `browser ${outcome.toLowerCase()}`);
  await click(page, /decide|submit decision|confirm/i, "submit Decision");
}

const D02 = defineCase("D-02", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("d02");
  const { api } = await prepare(ctx, { seed });
  const opener = await ctx.startWorker();
  let body;
  await withPage(ctx, api, { width: 1440, height: 960 }, async (page) => {
    body = await submitContentInUi(ctx, page, seed, "d02-ui");
    const accepted = await waitSnapshot(ctx, api.baseUrl, (value) => value.resources.contentItems.find(({ externalContentId }) => externalContentId === body.externalContentId), { processes: [opener], label: "browser Content acceptance" });
    const content = accepted.resources.contentItems.find(({ externalContentId }) => externalContentId === body.externalContentId);
    const moderationCase = accepted.resources.moderationCases.find(({ contentItemId }) => contentItemId === content.contentItemId);
    await waitStage(ctx, api.baseUrl, ({ caseId, level, state }) => caseId === moderationCase.caseId && level === "LEVEL_1" && state === "OPEN", { processes: [opener] });
    await page.reload({ waitUntil: "networkidle" });
    await appendEvidenceInUi(ctx, page, "d02-ui-late");
    await page.reload({ waitUntil: "networkidle" });
    await claimAndDecideInUi(page, { reviewerId: "d02-browser-reviewer", outcome: "ESCALATE" });
    await waitStage(ctx, api.baseUrl, ({ caseId, level, state }) => caseId === moderationCase.caseId && level === "LEVEL_2" && state === "OPEN", { processes: [opener], label: "browser LEVEL_2 Stage" });
    await page.reload({ waitUntil: "networkidle" });
    await claimAndDecideInUi(page, { reviewerId: "d02-browser-level2", outcome: "REMOVE" });
    await page.reload({ waitUntil: "networkidle" });
    await navigate(page, /appeal|case/i);
    await optionalField(page, /appeal.*reason|reason/i, "browser appeal");
    await click(page, /file appeal|create appeal|appeal/i, "file Appeal");
    await page.reload({ waitUntil: "networkidle" });
    await navigate(page, /appeal|queue|review/i);
    await optionalField(page, /reviewer|assignee/i, "d02-appeal-reviewer");
    const claimAppeal = page.getByRole("button", { name: /claim/i }).first();
    if (await claimAppeal.count() && await claimAppeal.isVisible().catch(() => false)) await claimAppeal.click();
    await optionalField(page, /appeal.*outcome|resolution|outcome/i, "UPHOLD");
    await optionalField(page, /reason/i, "browser appeal resolution");
    await click(page, /resolve|submit decision|confirm/i, "resolve Appeal");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(/UPHELD|OVERTURNED|REJECTED/i).first().waitFor({ state: "visible", timeout: 15_000 });
  });
  await ctx.stop(opener);
  const final = await snapshot(ctx, api.baseUrl);
  const content = final.resources.contentItems.find(({ externalContentId }) => externalContentId === body.externalContentId);
  const moderationCase = final.resources.moderationCases.find(({ contentItemId }) => contentItemId === content.contentItemId);
  const appeal = final.resources.appeals.find(({ caseId }) => caseId === moderationCase.caseId);
  ctx.ok(moderationCase.state === "DECIDED", "browser produces terminal ModerationCase");
  ctx.equal(final.resources.evidenceVersions.filter(({ contentItemId }) => contentItemId === content.contentItemId).length, 2, "browser appends one EvidenceVersion");
  ctx.equal(new Set(final.resources.reviewStages.filter(({ caseId }) => caseId === moderationCase.caseId).map(({ level }) => level)).isSupersetOf(new Set(["LEVEL_1", "LEVEL_2", "APPEAL"])), true, "browser completes multi-level review and Appeal stages");
  ctx.ok(appeal && ["UPHELD", "OVERTURNED", "REJECTED"].includes(appeal.state), "browser resolves one Appeal");
  ctx.equal(final.resources.appeals.filter(({ caseId }) => caseId === moderationCase.caseId).length, 1, "browser creates one Appeal");
  return finalEvidence(ctx, { caseId: moderationCase.caseId, appealId: appeal.appealId, appealState: appeal.state });
});

async function recallInputs(ctx, label) {
  const seed = ctx.fixtures.baseSeed(label, { action: "REMOVE" });
  const { api } = await prepare(ctx, { seed });
  const caseIds = [];
  for (const [suffix, outcome, categoryCode] of [["changed", "REMOVE", "ABUSE"], ["no-change", "ALLOW", "SAFE"]]) {
    const created = await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, `${label}-${suffix}`));
    const caseId = resource(created, "caseId");
    caseIds.push(caseId);
    const worker = await ctx.startWorker();
    const stage = await waitStage(ctx, api.baseUrl, ({ caseId: candidate, state }) => candidate === caseId && state === "OPEN", { processes: [worker] });
    await ctx.stop(worker);
    const reviewerId = `${label}-${suffix}-reviewer`;
    await claimStage(ctx, api.baseUrl, stage.stageId, reviewerId, { leaseSeconds: 10 });
    const decision = await ctx.mutate(api.baseUrl, `/api/v1/review-stages/${stage.stageId}/decisions`, ctx.key(`${label}-${suffix}-decision`), { reviewerId, outcome, categoryCode, reason: "browser recall fixture" });
    assert.ok(decision.status >= 200 && decision.status < 300, decision.text);
  }
  const decided = (await snapshot(ctx, api.baseUrl)).resources.moderationCases.filter(({ caseId }) => caseIds.includes(caseId));
  const replacement = await createPolicyVersion(ctx, api.baseUrl, seed.policies[0].policyId, ctx.fixtures.policyCategories("ALLOW"));
  const replacementPolicyVersionId = resource(replacement, "policyVersionId");
  await activatePolicyVersion(ctx, api.baseUrl, replacementPolicyVersionId, seed.policyVersions[0].policyVersionId);
  return {
    api, caseIds,
    request: {
      tenantId: seed.tenants[0].tenantId, recalledPolicyVersionId: seed.policyVersions[0].policyVersionId,
      replacementPolicyVersionId, decidedFrom: new Date(Math.min(...decided.map(({ decidedAt }) => Date.parse(decidedAt))) - 1_000).toISOString(),
      decidedTo: new Date(Math.max(...decided.map(({ decidedAt }) => Date.parse(decidedAt))) + 1_000).toISOString(),
    },
  };
}

async function fillRecall(page, request) {
  await navigate(page, /recall/i);
  await setField(page, /tenant/i, request.tenantId, "Recall Tenant");
  await setField(page, /recalled.*policy|old.*version/i, request.recalledPolicyVersionId, "recalled PolicyVersion");
  await setField(page, /replacement.*policy|new.*version/i, request.replacementPolicyVersionId, "replacement PolicyVersion");
  await setField(page, /decided.*from|from/i, request.decidedFrom, "decidedFrom");
  await setField(page, /decided.*to|to/i, request.decidedTo, "decidedTo");
  await click(page, /create recall|start recall|submit/i, "create Recall");
}

const D03 = defineCase("D-03", async function run(ctx) {
  const fixture = await recallInputs(ctx, "d03");
  let runId;
  let cancelledRunId;
  await withPage(ctx, fixture.api, { width: 390, height: 844 }, async (page) => {
    await fillRecall(page, fixture.request);
    const cancelledFixture = await waitSnapshot(ctx, fixture.api.baseUrl, (value) => value.resources.policyRecallRuns.at(-1) ?? false, { label: "browser cancellable Recall creation" });
    cancelledRunId = cancelledFixture.resources.policyRecallRuns.at(-1).policyRecallRunId;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(/PENDING|RUNNING/i).first().waitFor({ state: "visible", timeout: 15_000 });
    await click(page, /cancel recall|cancel/i, "cancel Recall");
    await waitSnapshot(ctx, fixture.api.baseUrl, (value) => value.resources.policyRecallRuns.some(({ policyRecallRunId, state }) => policyRecallRunId === cancelledRunId && state === "CANCELLED"), { label: "browser Recall cancellation" });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(/CANCELLED/i).first().waitFor({ state: "visible", timeout: 15_000 });
    await fillRecall(page, fixture.request);
    const created = await waitSnapshot(ctx, fixture.api.baseUrl, (value) => value.resources.policyRecallRuns.find(({ policyRecallRunId }) => policyRecallRunId !== cancelledRunId) ?? false, { label: "browser completing Recall creation" });
    runId = created.resources.policyRecallRuns.find(({ policyRecallRunId }) => policyRecallRunId !== cancelledRunId).policyRecallRunId;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(/PENDING|RUNNING|COMPLETED/i).first().waitFor({ state: "visible", timeout: 15_000 });
    const worker = await ctx.startWorker();
    await waitSnapshot(ctx, fixture.api.baseUrl, (value) => value.resources.policyRecallRuns.some(({ policyRecallRunId, state }) => policyRecallRunId === runId && state === "COMPLETED"), { processes: [worker], timeoutMs: 60_000, label: "browser Recall completion" });
    await ctx.stop(worker);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(/CHANGED/i).first().waitFor({ state: "visible", timeout: 15_000 });
    await page.getByText(/NO_CHANGE|NO CHANGE/i).first().waitFor({ state: "visible", timeout: 15_000 });
    await navigate(page, /reconsideration|difference|changed/i);
    await optionalField(page, /reviewer|assignee/i, "d03-browser-reviewer");
    const claim = page.getByRole("button", { name: /claim/i }).first();
    if (await claim.count() && await claim.isVisible().catch(() => false)) await claim.click();
    await optionalField(page, /outcome|decision/i, "ALLOW");
    await optionalField(page, /reason/i, "human confirmation");
    await click(page, /confirm|submit decision|decide/i, "confirm Reconsideration");
  });
  const detail = await getRecall(ctx, fixture.api.baseUrl, runId);
  ctx.equal(detail.run.totalCount, 2, "UI Recall frozen count");
  ctx.equal(detail.run.changedCount, 1, "UI exposes one changed result");
  ctx.equal(detail.run.noChangeCount, 1, "UI exposes one no-change result");
  ctx.equal(detail.reconsiderations.length, 2, "UI Recall one result per frozen Case");
  const changed = detail.reconsiderations.find(({ outcome }) => outcome === "CHANGED");
  const noChange = detail.reconsiderations.find(({ outcome }) => outcome === "NO_CHANGE");
  ctx.equal(noChange.reconsiderationStageId, null, "UI no-change result owns no Stage");
  const stageId = changed.reconsiderationStageId;
  const final = await snapshot(ctx, fixture.api.baseUrl);
  const stage = final.resources.reviewStages.find(({ stageId: candidate }) => candidate === stageId);
  ctx.equal(stage.level, "RECONSIDERATION", "UI opens Reconsideration Stage");
  ctx.equal(stage.state, "DECIDED", "UI human confirmation decides Stage");
  const decision = final.resources.moderationDecisions.find(({ stageId: candidate }) => candidate === stageId);
  ctx.ok(["ALLOW", "RESTRICT", "REMOVE"].includes(decision.outcome), "UI confirmation uses legal outcome");
  ctx.ok(decision.outcome !== "ESCALATE", "UI cannot present ESCALATE as completed Reconsideration");
  return finalEvidence(ctx, { runId, cancelledRunId, reconsiderationId: changed.reconsiderationId, noChangeReconsiderationId: noChange.reconsiderationId, decisionId: decision.decisionId });
});

function identityKey(name) {
  const values = {
    tenants: "tenantId", policies: "policyId", policyVersions: "policyVersionId", contentItems: "contentItemId",
    evidenceVersions: "evidenceVersionId", moderationCases: "caseId", reviewStages: "stageId",
    moderationDecisions: "decisionId", appeals: "appealId", auditEntries: "auditEntryId",
    auditCheckpoints: "auditCheckpointId", policyRecallRuns: "policyRecallRunId", reconsiderations: "reconsiderationId",
  };
  return values[name];
}

const D04 = defineCase("D-04", async function run(ctx) {
  const seed = ctx.fixtures.baseSeed("d04");
  const { api } = await prepare(ctx, { seed });
  await createContent(ctx, api.baseUrl, ctx.fixtures.submission(seed, "d04"));
  const state = await snapshot(ctx, api.baseUrl);
  exactKeys(state, ["asOf", "resources", "work", "events"], "verification snapshot");
  ctx.equal(Object.keys(state.resources).sort(), [...RESOURCE_KEYS].sort(), "snapshot exact FINAL resource union");
  ctx.ok(typeof state.asOf === "string" && Number.isFinite(Date.parse(state.asOf)), "snapshot has one public as-of timestamp");
  const repeated = await snapshot(ctx, api.baseUrl);
  ctx.equal(canonical(repeated.resources), canonical(state.resources), "unchanged snapshot resource order is deterministic");
  ctx.equal(canonical(repeated.work), canonical(state.work), "unchanged Work order is deterministic");
  ctx.equal(canonical(repeated.events), canonical(state.events), "unchanged Event order is deterministic");
  for (const [name, items] of Object.entries(state.resources)) {
    ctx.ok(Array.isArray(items), `${name} is an array`);
    const key = identityKey(name);
    if (key) ctx.equal(new Set(items.map((item) => item[key])).size, items.length, `${name} identities are unique`);
    const sequenced = items.filter(({ sequence }) => Number.isSafeInteger(sequence));
    if (sequenced.length === items.length && items.length > 1) {
      ctx.equal(items.map(({ sequence }) => sequence), [...items.map(({ sequence }) => sequence)].sort((left, right) => left - right), `${name} public sequence order`);
    }
  }
  ctx.ok(Array.isArray(state.work) && Array.isArray(state.events), "snapshot includes Work and Event arrays");
  recursivelyRejectSecrets(ctx, { snapshot: state, logs: api.logs });
  assertAuditChain(state.resources.auditEntries);
  const verify = await ctx.request(api.baseUrl, "/api/v1/audit/verify", { headers: { authorization: `Bearer ${ctx.adminToken}` } });
  ctx.equal(verify.status, 200, "audit verification status");
  ctx.ok(verify.json && typeof verify.json === "object", "audit verification body");
  const page = await ctx.request(api.baseUrl, "/api/v1/audit?limit=100", { headers: { authorization: `Bearer ${ctx.adminToken}` } });
  ctx.equal(page.status, 200, "audit collection status");
  exactKeys(page.json, ["items", "nextCursor"], "audit collection");
  const repeatedPage = await ctx.request(api.baseUrl, "/api/v1/audit?limit=100", { headers: { authorization: `Bearer ${ctx.adminToken}` } });
  ctx.equal(repeatedPage.json, page.json, "unchanged audit pagination is deterministic");
  const snapshotAudit = new Set(state.resources.auditEntries.map(canonical));
  ctx.ok(page.json.items.every((entry) => snapshotAudit.has(canonical(entry))), "audit collection rows agree with snapshot");
  return finalEvidence(ctx, { asOf: state.asOf, auditEntries: state.resources.auditEntries.length, resources: RESOURCE_KEYS.length });
});

export const D_CASES = Object.freeze([D01, D02, D03, D04]);
