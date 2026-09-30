import {
  COMPARISON_RESULT_KEYS,
  COMPARISON_RUN_KEYS,
  EVALUATION_KEYS,
  REPLAY_KEYS,
  SNAPSHOT_RESOURCE_KEYS,
  assertEvaluationOracle,
  assertEventLedger,
  byId,
  canonicalJson,
  coreFixture,
  createComparison,
  createEvaluation,
  createReplay,
  exactKeys,
  expectError,
  expectStatus,
  finalEvidence,
  firstVisible,
  guardedCase,
  launchBrowser,
  noSensitiveText,
  resource,
  setNamedField,
  sha256Canonical,
  startComparison,
  startPreparedApi,
  visibleControl,
  waitForComparison,
  waitForEvaluation,
  waitForReplay,
  waitForVisibleText,
} from "./helpers.mjs";

const HTTP_PATHS = Object.freeze({
  "/api/v1/tenants": ["post"],
  "/api/v1/rule-sets": ["post"],
  "/api/v1/rule-sets/{ruleSetId}/versions": ["post"],
  "/api/v1/rule-set-versions/{versionId}/validate": ["post"],
  "/api/v1/rule-set-versions/{versionId}/publish": ["post"],
  "/api/v1/rule-set-versions/{versionId}/conflicts": ["get"],
  "/api/v1/evaluations": ["post"],
  "/api/v1/evaluations/{evaluationId}": ["get"],
  "/api/v1/evaluations/{evaluationId}/explanation": ["get"],
  "/api/v1/evaluations/{evaluationId}/replay": ["post"],
  "/api/v1/replay-runs/{replayRunId}": ["get"],
  "/api/v1/verification-snapshot": ["get"],
  "/api/v1/comparison-runs": ["post"],
  "/api/v1/comparison-runs/{comparisonRunId}/start": ["post"],
  "/api/v1/comparison-runs/{comparisonRunId}/cancel": ["post"],
  "/api/v1/comparison-runs/{comparisonRunId}/promote": ["post"],
  "/api/v1/comparison-runs/{comparisonRunId}": ["get"],
});

function appendTenant(ctx, fixture) {
  const tenantId = ctx.uuid("d01-second-tenant");
  fixture.seed.tenants.push({ tenantId, name: "Isolated Tenant" });
  return tenantId;
}

function recursiveSensitive(value, path = "$", findings = []) {
  if (Array.isArray(value)) value.forEach((item, index) => recursiveSensitive(item, `${path}[${index}]`, findings));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/^(facts|authorization|credentials?|password|secret|.*token|database(?:url)?|private(?:path)?|environment)$/iu.test(key)) findings.push(`${path}.${key}`);
      recursiveSensitive(child, `${path}.${key}`, findings);
    }
  }
  return findings;
}

const d01 = guardedCase({
  id: "D-01",
  fixtureFamily: "RB-F-LIVE-WIRE-CONTRACT",
  action: "Fetch the running OpenAPI document and exercise successful, malformed, unsupported-media, unknown-field, unpublished-Version, idempotency-conflict, Manager, missing-ID, and cross-tenant HTTP requests.",
  oracle: "Runtime methods, closed response shapes, stable error envelopes, strict JSON, tenant scope, and zero rejected-request mutation must agree with the public V1 plus Comparison contracts.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-d01-http" });
    const secondTenantId = appendTenant(ctx, fixture);
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const openapiResponse = await ctx.request(api.baseUrl, "/openapi.json");
    expectStatus(ctx, openapiResponse, 200, "OpenAPI");
    ctx.ok(openapiResponse.json?.paths && typeof openapiResponse.json.paths === "object", "OpenAPI parses as an object");
    for (const [path, methods] of Object.entries(HTTP_PATHS)) {
      ctx.ok(openapiResponse.json.paths[path], `OpenAPI declares ${path}`);
      methods.forEach((method) => ctx.ok(openapiResponse.json.paths[path][method], `OpenAPI declares ${method.toUpperCase()} ${path}`));
    }
    expectStatus(ctx, await ctx.request(api.baseUrl, "/healthz"), 200, "health");

    const facts = { risk: "high", requestId: "d01" };
    const key = ctx.key("strict-evaluation");
    const validBody = {
      tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
      ruleSetVersionId: fixture.ids.baselineVersionId, facts,
    };
    const created = await ctx.mutate(api.baseUrl, "/api/v1/evaluations", key, validBody);
    expectStatus(ctx, created, 200, "Evaluation success");
    exactKeys(created.json, EVALUATION_KEYS, "Evaluation success body");
    const beforeRejects = await ctx.snapshot(api.baseUrl);
    const media = await ctx.request(api.baseUrl, "/api/v1/evaluations", {
      method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("media") }, raw: "not-json",
    });
    ctx.equal(media.status, 415, "unsupported media type rejects");
    const malformed = await ctx.request(api.baseUrl, "/api/v1/evaluations", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("malformed") }, raw: "{",
    });
    ctx.equal(malformed.status, 400, "malformed JSON rejects");
    const unknown = await ctx.mutate(api.baseUrl, "/api/v1/evaluations", ctx.key("unknown"), { ...validBody, unknown: true });
    ctx.equal(unknown.status, 400, "unknown Evaluation field rejects");
    expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/evaluations", ctx.key("draft"), {
      ...validBody, ruleSetVersionId: fixture.ids.draftVersionId,
    }), 409, "VERSION_NOT_PUBLISHED", "draft Evaluation");
    expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/evaluations", key, {
      ...validBody, facts: { ...facts, risk: "low" },
    }), 409, "IDEMPOTENCY_CONFLICT", "Evaluation key conflict");
    const crossTenant = await ctx.mutate(api.baseUrl, "/api/v1/evaluations", ctx.key("cross-tenant"), {
      ...validBody, tenantId: secondTenantId,
    });
    ctx.ok([400, 404, 409].includes(crossTenant.status), "cross-tenant RuleSet reference rejects");
    const missing = await ctx.request(api.baseUrl, `/api/v1/evaluations/${ctx.uuid("missing-evaluation")}`);
    ctx.equal(missing.status, 404, "unknown Evaluation is not found");
    const afterRejects = await ctx.snapshot(api.baseUrl);
    ctx.equal(resource(afterRejects, "evaluations").length, resource(beforeRejects, "evaluations").length, "rejected HTTP creates no Evaluation");
    ctx.equal(afterRejects.work.length, beforeRejects.work.length, "rejected HTTP creates no Work");
    ctx.equal(afterRejects.events.length, beforeRejects.events.length, "rejected HTTP creates no Event");

    const worker = await ctx.startWorker();
    await waitForEvaluation(ctx, api.baseUrl, created.json.evaluationId, "COMPLETED", { processes: [worker] });
    const comparison = await createComparison(ctx, api.baseUrl, fixture, [created.json.evaluationId], { key: ctx.key("comparison") });
    const managerBefore = await ctx.snapshot(api.baseUrl);
    const badManager = await ctx.mutate(api.baseUrl, "/api/v1/comparison-runs", ctx.key("comparison-unknown"), {
      tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
      baselineVersionId: fixture.ids.baselineVersionId, candidateVersionId: fixture.ids.candidateVersionId,
      evaluationIds: [created.json.evaluationId], unknown: true,
    });
    ctx.equal(badManager.status, 400, "unknown Comparison field rejects");
    const managerAfter = await ctx.snapshot(api.baseUrl);
    ctx.equal(resource(managerAfter, "comparisonRuns").length, resource(managerBefore, "comparisonRuns").length, "rejected Manager request creates no Run");
    ctx.equal(comparison.run.state, "PENDING", "valid Comparison success shape is live");
    const logs = ctx.processes.map(({ logs }) => logs).join("\n");
    ctx.ok(noSensitiveText(logs), "candidate logs contain no facts or credentials");
    return finalEvidence(ctx, { openapiPaths: Object.keys(HTTP_PATHS).length, strictRejects: 8 });
  },
}, ["DECLARATIVE_SAFETY", "DURABLE_IDEMPOTENCY"]);

async function optionalNamedField(page, label, value, selectors = []) {
  try { return await setNamedField(page, label, value); }
  catch {
    for (const selector of selectors) {
      const control = await firstVisible(page.locator(selector));
      if (!control) continue;
      const tag = await control.evaluate((element) => element.tagName.toLowerCase());
      if (tag === "select") {
        try { await control.selectOption({ value: String(value) }); }
        catch { await control.selectOption({ label: String(value) }); }
      } else await control.fill(typeof value === "string" ? value : JSON.stringify(value));
      return control;
    }
    throw new Error(`production UI has no semantic field for ${label}`);
  }
}

async function submitEvaluationUi(page, fixture, facts) {
  await optionalNamedField(page, /tenant/i, fixture.ids.tenantId, ['[name*="tenant" i]']);
  await optionalNamedField(page, /rule.?set(?!.*version)/i, fixture.ids.ruleSetId, ['[name*="ruleSetId" i]', '[name="ruleSet"]']);
  await optionalNamedField(page, /version/i, fixture.ids.baselineVersionId, ['[name*="version" i]']);
  await optionalNamedField(page, /facts/i, JSON.stringify(facts), ['textarea[name*="facts" i]', 'textarea']);
  const submit = await firstVisible(page.getByRole("button", { name: /evaluate|run evaluation|submit evaluation|create evaluation/i }))
    ?? await firstVisible(page.locator('form button[type="submit"], form input[type="submit"]'));
  if (!submit) throw new Error("production UI has no visible Evaluation submit control");
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/evaluations", { timeout: 30_000 });
  await submit.click();
  const response = await responsePromise;
  if (response.status() !== 200) throw new Error(`browser Evaluation returned ${response.status()}: ${await response.text()}`);
  return response.json();
}

async function navigateToIdentity(page, identity) {
  const link = await firstVisible(page.getByRole("link", { name: new RegExp(identity, "i") }));
  if (link) { await link.click(); return; }
  const text = await firstVisible(page.getByText(identity, { exact: false }));
  if (text) { await text.click().catch(() => undefined); return; }
  const history = await firstVisible(page.getByRole("link", { name: /evaluations|comparisons|history|runs/i }))
    ?? await firstVisible(page.getByRole("button", { name: /evaluations|comparisons|history|runs/i }));
  if (history) await history.click();
  const after = await firstVisible(page.getByText(identity, { exact: false }));
  if (!after) throw new Error(`production UI does not expose durable identity ${identity}`);
  await after.click().catch(() => undefined);
}

const d02 = guardedCase({
  id: "D-02",
  fixtureFamily: "RB-F-PRODUCTION-BROWSER-V1",
  action: "Use production Chromium visible labelled controls to select a RuleSetVersion, submit facts, inspect decision, tags, visited and SKIPPED explanations, start replay, refresh, and repeat inspection at mobile width.",
  oracle: "Every browser-observed identity and result must come from public HTTP and match the independent interpreter; keyboard focus, refresh durability, validation visibility, and non-mocked production data remain observable.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-d02-browser" });
    let api = await startPreparedApi(ctx, { seed: fixture.seed });
    const worker = await ctx.startWorker();
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await page.getByText("Private Decisions", { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.keyboard.press("Tab");
    ctx.equal(await page.locator(":focus").count(), 1, "keyboard establishes visible UI focus");
    const facts = { risk: "high", requestId: "d02-browser" };
    const evaluation = await submitEvaluationUi(page, fixture, facts);
    exactKeys(evaluation, EVALUATION_KEYS, "browser Evaluation response");
    await waitForEvaluation(ctx, api.baseUrl, evaluation.evaluationId, "COMPLETED", { processes: [worker] });
    const snapshot = await ctx.snapshot(api.baseUrl);
    const oracle = assertEvaluationOracle(ctx, snapshot, fixture, evaluation.evaluationId, facts);
    await navigateToIdentity(page, evaluation.evaluationId);
    await waitForVisibleText(page, /DENY/i);
    await waitForVisibleText(page, /a|b/i);
    const explanationControl = await firstVisible(page.getByRole("button", { name: /explanation|details|nodes/i }))
      ?? await firstVisible(page.getByRole("link", { name: /explanation|details|nodes/i }));
    if (explanationControl) await explanationControl.click();
    await waitForVisibleText(page, /SKIPPED/i);
    const replayControl = await firstVisible(page.getByRole("button", { name: /replay/i }))
      ?? await firstVisible(page.getByRole("link", { name: /replay/i }));
    if (!replayControl) throw new Error("production UI has no visible Replay control");
    const replayResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/evaluations/${evaluation.evaluationId}/replay`, { timeout: 30_000 });
    await replayControl.click();
    const replayResponse = await replayResponsePromise;
    ctx.equal(replayResponse.status(), 200, "browser Replay HTTP status");
    const replay = await replayResponse.json();
    exactKeys(replay, REPLAY_KEYS, "browser ReplayRun response");
    await waitForReplay(ctx, api.baseUrl, replay.replayRunId, "MATCHED", { processes: [worker] });
    await waitForVisibleText(page, /MATCHED/i);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(new RegExp(evaluation.evaluationId, "i"), { exact: false }).first().waitFor({ timeout: 30_000 });
    await waitForVisibleText(page, /DENY|MATCHED/i);

    const mobile = await launchBrowser(ctx, api.baseUrl, { viewport: { width: 390, height: 844 } });
    await mobile.page.getByText("Private Decisions", { exact: false }).first().waitFor({ timeout: 30_000 });
    await navigateToIdentity(mobile.page, evaluation.evaluationId);
    await waitForVisibleText(mobile.page, /DENY/i);
    await navigateToIdentity(page, evaluation.evaluationId);
    const offlineReplay = await firstVisible(page.getByRole("button", { name: /replay/i }))
      ?? await firstVisible(page.getByRole("link", { name: /replay/i }));
    if (!offlineReplay) throw new Error("production UI has no Replay control for offline recovery");
    const apiPort = api.port;
    await ctx.stop(api);
    await offlineReplay.click();
    await page.locator('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"]), main').filter({ hasText: /offline|unavailable|network|retry|error/i }).first().waitFor({ timeout: 30_000 });
    api = await ctx.startApi({ port: apiPort });
    await page.reload({ waitUntil: "domcontentloaded" });
    await navigateToIdentity(page, evaluation.evaluationId);
    await waitForVisibleText(page, /DENY/i);
    ctx.equal(oracle.evaluation.decision, "DENY", "browser result equals independent oracle");
    ctx.ok(oracle.nodes.some(({ result }) => result === "SKIPPED"), "browser fixture genuinely contains SKIPPED nodes");
    return finalEvidence(ctx, { evaluationId: evaluation.evaluationId, replayRunId: replay.replayRunId, viewports: 2 });
  },
}, ["DETERMINISTIC_EVALUATION"]);

async function submitComparisonUi(page, fixture, evaluationIds) {
  await optionalNamedField(page, /tenant/i, fixture.ids.tenantId, ['[name*="tenant" i]']);
  await optionalNamedField(page, /rule.?set(?!.*version)/i, fixture.ids.ruleSetId, ['[name*="ruleSetId" i]']);
  await optionalNamedField(page, /baseline/i, fixture.ids.baselineVersionId, ['[name*="baseline" i]']);
  await optionalNamedField(page, /candidate/i, fixture.ids.candidateVersionId, ['[name*="candidate" i]']);
  await optionalNamedField(page, /evaluation|corpus/i, evaluationIds.join("\n"), ['textarea[name*="evaluation" i]', 'textarea[name*="corpus" i]']);
  const submit = await firstVisible(page.getByRole("button", { name: /create comparison|compare|create run/i }))
    ?? await firstVisible(page.locator('form button[type="submit"]'));
  if (!submit) throw new Error("production UI has no visible Comparison create control");
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/comparison-runs", { timeout: 30_000 });
  await submit.click();
  const response = await responsePromise;
  if (response.status() !== 200) throw new Error(`browser Comparison create returned ${response.status()}: ${await response.text()}`);
  return (await response.json()).run;
}

const d03 = guardedCase({
  id: "D-03",
  fixtureFamily: "RB-F-PRODUCTION-BROWSER-MANAGER",
  action: "Use production Chromium controls to create and start a frozen corpus, watch progress and DIFF detail, promote it, navigate to another pending Run and cancel it, then inspect an ERROR Run with no waiver control.",
  oracle: "Visible counts, digests, immutable side results, CAS outcomes, cancellation, publication pointer, and ERROR promotion gate must equal public HTTP and snapshot state after refresh.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-d03-browser-manager" });
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const worker = await ctx.startWorker();
    const factsById = new Map();
    const evaluationIds = [];
    for (let index = 0; index < 3; index += 1) {
      const facts = { risk: index === 1 ? "low" : "high", requestId: `d03-${index}` };
      const created = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key(`evaluation-${index}`) });
      evaluationIds.push(created.evaluation.evaluationId);
      factsById.set(created.evaluation.evaluationId, facts);
    }
    await Promise.all(evaluationIds.map((evaluationId) => waitForEvaluation(ctx, api.baseUrl, evaluationId, "COMPLETED", { processes: [worker] })));
    const { page } = await launchBrowser(ctx, api.baseUrl);
    const comparisonsNavigation = await firstVisible(page.getByRole("link", { name: /comparisons|shadow/i }))
      ?? await firstVisible(page.getByRole("button", { name: /comparisons|shadow/i }));
    if (comparisonsNavigation) await comparisonsNavigation.click();
    const createdRun = await submitComparisonUi(page, fixture, [...evaluationIds].reverse().concat(evaluationIds[0]));
    exactKeys(createdRun, COMPARISON_RUN_KEYS, "browser ComparisonRun");
    await navigateToIdentity(page, createdRun.comparisonRunId);
    const startControl = await visibleControl(page, "button", /start/i);
    const startResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/comparison-runs/${createdRun.comparisonRunId}/start`, { timeout: 30_000 });
    await startControl.click();
    ctx.equal((await startResponsePromise).status(), 200, "browser start status");
    const completed = await waitForComparison(ctx, api.baseUrl, createdRun.comparisonRunId, "COMPLETED", { processes: [worker] });
    await waitForVisibleText(page, /COMPLETED/i);
    await waitForVisibleText(page, /DIFF/i);
    await page.reload({ waitUntil: "domcontentloaded" });
    await navigateToIdentity(page, createdRun.comparisonRunId);
    await waitForVisibleText(page, new RegExp(String(completed.run.resultCounts.DIFF)));
    const promoteControl = await visibleControl(page, "button", /promote/i);
    const promotePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/comparison-runs/${createdRun.comparisonRunId}/promote`, { timeout: 30_000 });
    await promoteControl.click();
    ctx.equal((await promotePromise).status(), 200, "browser promotion status");
    const promotedSnapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(byId(resource(promotedSnapshot, "ruleSets"), "ruleSetId", fixture.ids.ruleSetId).currentPublishedVersionId, fixture.ids.candidateVersionId, "browser promotion changes public pointer");

    const pending = await createComparison(ctx, api.baseUrl, fixture, evaluationIds, { key: ctx.key("pending-cancel") });
    await page.reload({ waitUntil: "domcontentloaded" });
    await navigateToIdentity(page, pending.run.comparisonRunId);
    const cancelControl = await visibleControl(page, "button", /cancel/i);
    const cancelPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/comparison-runs/${pending.run.comparisonRunId}/cancel`, { timeout: 30_000 });
    await cancelControl.click();
    ctx.equal((await cancelPromise).status(), 200, "browser cancel status");
    await waitForVisibleText(page, /CANCELLED/i);

    const errorFacts = { risk: "low", score: "invalid", requestId: "d03-error" };
    const errorEvaluation = await createEvaluation(ctx, api.baseUrl, fixture, errorFacts, { key: ctx.key("error-evaluation") });
    await waitForEvaluation(ctx, api.baseUrl, errorEvaluation.evaluation.evaluationId, "COMPLETED", { processes: [worker] });
    const errorRun = await createComparison(ctx, api.baseUrl, fixture, [errorEvaluation.evaluation.evaluationId], {
      key: ctx.key("error-run"), candidateVersionId: fixture.ids.errorVersionId,
    });
    const errorStarted = await startComparison(ctx, api.baseUrl, errorRun.run, { key: ctx.key("error-start") });
    const errorCompleted = await waitForComparison(ctx, api.baseUrl, errorStarted.run.comparisonRunId, "COMPLETED", { processes: [worker] });
    ctx.equal(errorCompleted.run.resultCounts.ERROR, 1, "ERROR fixture is genuine");
    await page.reload({ waitUntil: "domcontentloaded" });
    await navigateToIdentity(page, errorRun.run.comparisonRunId);
    await waitForVisibleText(page, /ERROR/i);
    ctx.equal(await page.getByRole("button", { name: /waive|ignore error|explain error/i }).count(), 0, "UI exposes no unauthorized ERROR waiver");
    const errorPromote = await firstVisible(page.getByRole("button", { name: /promote/i }));
    if (errorPromote) ctx.ok(await errorPromote.isDisabled(), "ERROR promotion is visibly disabled");
    return finalEvidence(ctx, { comparisonRunId: createdRun.comparisonRunId, diffCount: completed.run.resultCounts.DIFF, errorCount: 1 });
  },
}, ["COMPARISON_ATOMICITY", "VERSION_IMMUTABILITY"]);

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    if (typeof left[index] === "number" && typeof right[index] === "number") return left[index] - right[index];
    return String(left[index]) < String(right[index]) ? -1 : 1;
  }
  return 0;
}

function assertSorted(ctx, values, fields, label) {
  const expected = [...values].sort((left, right) => compareTuple(fields.map((field) => left[field]), fields.map((field) => right[field])) || canonicalJson(left).localeCompare(canonicalJson(right)));
  ctx.equal(values, expected, `${label} public identity order`);
}

const d04 = guardedCase({
  id: "D-04",
  fixtureFamily: "RB-F-FINAL-SNAPSHOT-ORACLE",
  action: "Create terminal Evaluation, ReplayRun, and ComparisonRun state, then read one authorized FINAL verification snapshot and independently validate exact resources, shapes, sorting, redaction, Work, Events, and selected digests.",
  oracle: "One point-in-time ledger contains the exact V1-plus-Manager resource union, complete public identities and terminal Work, no facts or credentials, and canonical digests recomputable without candidate trust.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-d04-snapshot" });
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const worker = await ctx.startWorker();
    const facts = { risk: "high", requestId: "d04" };
    const evaluation = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key("evaluation") });
    await waitForEvaluation(ctx, api.baseUrl, evaluation.evaluation.evaluationId, "COMPLETED", { processes: [worker] });
    const replay = await createReplay(ctx, api.baseUrl, evaluation.evaluation.evaluationId, { key: ctx.key("replay") });
    await waitForReplay(ctx, api.baseUrl, replay.replay.replayRunId, "MATCHED", { processes: [worker] });
    const comparison = await createComparison(ctx, api.baseUrl, fixture, [evaluation.evaluation.evaluationId], { key: ctx.key("comparison") });
    const started = await startComparison(ctx, api.baseUrl, comparison.run, { key: ctx.key("comparison-start") });
    await waitForComparison(ctx, api.baseUrl, started.run.comparisonRunId, "COMPLETED", { processes: [worker] });

    const snapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(Object.keys(snapshot.resources).sort(), [...SNAPSHOT_RESOURCE_KEYS].sort(), "FINAL snapshot exact resource union");
    ctx.ok(typeof snapshot.asOf === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(snapshot.asOf), "snapshot has one UTC millisecond asOf");
    for (const key of SNAPSHOT_RESOURCE_KEYS) ctx.ok(Array.isArray(snapshot.resources[key]), `${key} is a complete array`);
    resource(snapshot, "tenants").forEach((item) => exactKeys(item, ["tenantId", "name"], "Tenant"));
    resource(snapshot, "ruleSets").forEach((item) => exactKeys(item, ["ruleSetId", "tenantId", "name", "currentRevision", "currentPublishedVersionId", "publicationRevision", "createdAt"], "RuleSet"));
    resource(snapshot, "ruleSetVersions").forEach((item) => exactKeys(item, ["ruleSetVersionId", "ruleSetId", "tenantId", "revision", "state", "defaultDecision", "rulesDigest", "publishedAt"], "RuleSetVersion"));
    resource(snapshot, "rules").forEach((item) => exactKeys(item, ["ruleId", "ruleSetVersionId", "priority", "name", "condition", "effect", "terminal"], "Rule"));
    resource(snapshot, "evaluations").forEach((item) => exactKeys(item, EVALUATION_KEYS, "Evaluation"));
    resource(snapshot, "explanationNodes").forEach((item) => exactKeys(item, ["evaluationId", "ordinal", "ruleId", "path", "result", "reason"], "ExplanationNode"));
    resource(snapshot, "replayRuns").forEach((item) => exactKeys(item, REPLAY_KEYS, "ReplayRun"));
    resource(snapshot, "comparisonRuns").forEach((item) => exactKeys(item, COMPARISON_RUN_KEYS, "ComparisonRun"));
    resource(snapshot, "comparisonResults").forEach((item) => exactKeys(item, COMPARISON_RESULT_KEYS, "ComparisonResult"));
    snapshot.work.forEach((item) => exactKeys(item, ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"], "Work"));
    assertSorted(ctx, resource(snapshot, "tenants"), ["tenantId"], "Tenant");
    assertSorted(ctx, resource(snapshot, "ruleSets"), ["ruleSetId"], "RuleSet");
    assertSorted(ctx, resource(snapshot, "ruleSetVersions"), ["ruleSetId", "revision"], "RuleSetVersion");
    assertSorted(ctx, resource(snapshot, "rules"), ["ruleSetVersionId", "priority", "ruleId"], "Rule");
    assertSorted(ctx, resource(snapshot, "evaluations"), ["evaluationId"], "Evaluation");
    assertSorted(ctx, resource(snapshot, "explanationNodes"), ["evaluationId", "ordinal"], "ExplanationNode");
    assertSorted(ctx, resource(snapshot, "replayRuns"), ["replayRunId"], "ReplayRun");
    assertSorted(ctx, resource(snapshot, "conflictReports"), ["ruleSetVersionId", "priority", "ruleId", "code"], "ConflictReport");
    assertSorted(ctx, resource(snapshot, "comparisonRuns"), ["comparisonRunId"], "ComparisonRun");
    assertSorted(ctx, resource(snapshot, "comparisonResults"), ["comparisonRunId", "evaluationId"], "ComparisonResult");
    ctx.equal(recursiveSensitive(snapshot), [], "snapshot recursively redacts facts and credentials");
    ctx.ok(snapshot.work.every(({ terminal }) => terminal), "all created Work is retained terminal");
    const oracle = assertEvaluationOracle(ctx, snapshot, fixture, evaluation.evaluation.evaluationId, facts);
    const result = resource(snapshot, "comparisonResults").find(({ comparisonRunId }) => comparisonRunId === started.run.comparisonRunId);
    const resultProjection = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "resultDigest"));
    ctx.equal(result.resultDigest, sha256Canonical(resultProjection), "snapshot ComparisonResult digest recomputes");
    const eventMetrics = assertEventLedger(ctx, snapshot.events);
    ctx.ok(snapshot.events.every((event) => recursiveSensitive(event).length === 0), "Event ledger is redacted");
    return finalEvidence(ctx, { asOf: snapshot.asOf, explanationNodes: oracle.nodes.length, ...eventMetrics });
  },
}, ["DETERMINISTIC_EVALUATION", "COMPARISON_ATOMICITY"]);

export const D_CASES = Object.freeze([d01, d02, d03, d04]);

export default D_CASES;
