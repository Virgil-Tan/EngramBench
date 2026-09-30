import { makeComparisonCorpus, makeDepthExpression } from "../fixtures/index.mjs";
import { detectConflicts, sha256Canonical } from "../oracles/index.mjs";
import {
  EVALUATION_KEYS,
  assertComparisonResult,
  assertEvaluationOracle,
  byId,
  clone,
  collection,
  coreFixture,
  createComparison,
  createEvaluation,
  exactKeys,
  expectError,
  expectStatus,
  expectedComparisonResult,
  factsAtCanonicalBytes,
  finalEvidence,
  guardedCase,
  prepare,
  readComparison,
  replaceVersionRules,
  resource,
  rule,
  stableSnapshot,
  startComparison,
  startPreparedApi,
  waitForComparison,
  waitForEvaluation,
} from "./helpers.mjs";

function setRawVersionRules(fixture, versionId, rules, digest = sha256Canonical(rules)) {
  fixture.seed.rules = fixture.seed.rules.filter(({ ruleSetVersionId }) => ruleSetVersionId !== versionId).concat(rules);
  const version = fixture.seed.ruleSetVersions.find(({ ruleSetVersionId }) => ruleSetVersionId === versionId);
  version.rulesDigest = digest;
  return fixture;
}

const a01 = guardedCase({
  id: "A-01",
  fixtureFamily: "RB-F-DSL-BOUNDARIES",
  action: "Run invalid seed transactions plus live validate, publish, and Evaluation HTTP requests at every depth, child, Rule-count, fact-size, float, unsafe-integer, and operator boundary.",
  oracle: "The evaluator-owned grammar and safe-integer canonicalizer decide each boundary, while snapshots prove every rejected input leaves no Version, Evaluation, Work, or Event effect.",
  async run(ctx) {
    await prepare(ctx, { migrate: false });
    const invalidFixtures = [];

    const tooDeep = coreFixture(ctx, { seedVersion: "rb-a01-depth-21" });
    setRawVersionRules(tooDeep, tooDeep.ids.draftVersionId, [rule(ctx, tooDeep.ids.draftVersionId, "depth-21", {
      condition: makeDepthExpression(21), effect: { decision: "ALLOW", tags: [] }, terminal: true,
    })]);
    invalidFixtures.push(["depth-21", tooDeep]);

    const tooWide = coreFixture(ctx, { seedVersion: "rb-a01-children-101" });
    setRawVersionRules(tooWide, tooWide.ids.draftVersionId, [rule(ctx, tooWide.ids.draftVersionId, "children-101", {
      condition: { all: Array.from({ length: 101 }, () => ({ op: "exists", path: "$.value", value: null })) },
      effect: { decision: "ALLOW", tags: [] }, terminal: true,
    })]);
    invalidFixtures.push(["children-101", tooWide]);

    const tooMany = coreFixture(ctx, { seedVersion: "rb-a01-rules-5001" });
    setRawVersionRules(tooMany, tooMany.ids.draftVersionId, Array.from({ length: 5_001 }, (_, index) => rule(ctx, tooMany.ids.draftVersionId, `scale-${index}`, {
      priority: index + 1,
      condition: { op: "eq", path: "$.bucket", value: index },
      effect: { decision: index === 5_000 ? "ALLOW" : null, tags: [] },
      terminal: index === 5_000,
    })));
    invalidFixtures.push(["rules-5001", tooMany]);

    const unknown = coreFixture(ctx, { seedVersion: "rb-a01-unknown-op" });
    setRawVersionRules(unknown, unknown.ids.draftVersionId, [rule(ctx, unknown.ids.draftVersionId, "unknown-op", {
      condition: { op: "execute", path: "$.value", value: "process.exit(0)" },
      effect: { decision: "ALLOW", tags: [] }, terminal: true,
    })]);
    invalidFixtures.push(["unknown-op", unknown]);

    for (const [label, fixture] of invalidFixtures) {
      await ctx.migrate({ timeoutMs: 300_000 });
      const rejected = await ctx.seed(fixture.seed, { allowFailure: true, timeoutMs: 600_000 });
      ctx.ok(rejected.exitCode !== 0, `${label} seed is rejected`, { failureCodeSuffix: "INVALID_DSL_ACCEPTED" });
      const valid = coreFixture(ctx, { seedVersion: `rb-a01-after-${label}` });
      const accepted = await ctx.seed(valid.seed, { allowFailure: true, timeoutMs: 600_000 });
      ctx.equal(accepted.exitCode, 0, `${label} rejection is atomic`);
      const api = await ctx.startApi();
      const snapshot = await ctx.snapshot(api.baseUrl);
      ctx.equal(resource(snapshot, "ruleSetVersions").length, valid.seed.ruleSetVersions.length, `${label} left no partial Version`);
      ctx.equal(snapshot.work.length, 0, `${label} left no Work`);
      ctx.equal(snapshot.events.length, 0, `${label} left no Event`);
      await ctx.stop(api);
      await ctx.resetDatabase();
    }

    await ctx.migrate({ timeoutMs: 300_000 });
    const fixture = coreFixture(ctx, { seedVersion: "rb-a01-valid-boundaries" });
    const boundaryRules = Array.from({ length: 5_000 }, (_, index) => {
      if (index === 0) return rule(ctx, fixture.ids.draftVersionId, "depth-20", {
        priority: 1, condition: makeDepthExpression(20), effect: { decision: null, tags: ["depth-20"] }, terminal: false,
      });
      if (index === 1) return rule(ctx, fixture.ids.draftVersionId, "children-100", {
        priority: 2,
        condition: { all: Array.from({ length: 100 }, (_, child) => ({ op: "eq", path: "$.child", value: child })) },
        effect: { decision: null, tags: ["children-100"] }, terminal: false,
      });
      if (index === 2) return rule(ctx, fixture.ids.draftVersionId, "children-1", {
        priority: 3, condition: { any: [{ op: "exists", path: "$.child", value: null }] },
        effect: { decision: null, tags: ["children-1"] }, terminal: false,
      });
      if (index === 4_999) return rule(ctx, fixture.ids.draftVersionId, "terminal-5000", {
        priority: 5_000, condition: { op: "exists", path: "$.payload", value: null },
        effect: { decision: "ALLOW", tags: ["scale-5000"] }, terminal: true,
      });
      return rule(ctx, fixture.ids.draftVersionId, `valid-scale-${index}`, {
        priority: index + 1, condition: { op: "eq", path: "$.bucket", value: index },
        effect: { decision: null, tags: [] }, terminal: false,
      });
    });
    replaceVersionRules(fixture, fixture.ids.draftVersionId, boundaryRules);
    await ctx.seed(fixture.seed, { timeoutMs: 600_000 });
    const api = await ctx.startApi();
    expectStatus(ctx, await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/validate`, ctx.key("validate-depth-20"), {}), 200, "validate exact depth 20");
    expectStatus(ctx, await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/publish`, ctx.key("publish-depth-20"), { expectedRevision: 4 }), 200, "publish exact depth 20");

    const maximumFacts = factsAtCanonicalBytes(256 * 1024);
    const accepted = await createEvaluation(ctx, api.baseUrl, fixture, maximumFacts, {
      versionId: fixture.ids.draftVersionId, key: ctx.key("facts-256-kib"), label: "256KiB facts",
    });
    ctx.equal(accepted.evaluation.factsDigest, sha256Canonical(maximumFacts), "256KiB canonical facts digest");
    const beforeRejected = await ctx.snapshot(api.baseUrl);
    const oversized = factsAtCanonicalBytes(256 * 1024 + 1);
    expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/evaluations", ctx.key("facts-over-limit"), {
      tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
      ruleSetVersionId: fixture.ids.draftVersionId, facts: oversized,
    }), 400, "FACTS_TOO_LARGE", "256KiB plus one facts");
    for (const [label, facts] of [["float", { value: 1.25 }], ["unsafe integer", { value: Number.MAX_SAFE_INTEGER + 1 }]]) {
      const rejected = await ctx.mutate(api.baseUrl, "/api/v1/evaluations", ctx.key(`invalid-${label}`), {
        tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
        ruleSetVersionId: fixture.ids.draftVersionId, facts,
      });
      ctx.equal(rejected.status, 400, `${label} facts are rejected`);
    }
    const afterRejected = await ctx.snapshot(api.baseUrl);
    ctx.equal(resource(afterRejected, "evaluations").length, resource(beforeRejected, "evaluations").length, "invalid facts create no Evaluation");
    ctx.equal(afterRejected.work.length, beforeRejected.work.length, "invalid facts create no Work");
    ctx.equal(afterRejected.events.length, beforeRejected.events.length, "invalid facts create no Event");
    return finalEvidence(ctx, { invalidDslFamilies: invalidFixtures.length, acceptedRules: boundaryRules.length, acceptedFactsBytes: 256 * 1024 });
  },
}, ["DECLARATIVE_SAFETY"]);

const a02 = guardedCase({
  id: "A-02",
  fixtureFamily: "RB-F-TYPED-OPERATORS",
  action: "Submit live Evaluations covering missing, JSON null, string, boolean, safe integer, membership, existence, and all four ordering operators, then execute an invalid ordering fact through a real Worker.",
  oracle: "The independent interpreter compares every typed result without coercion and requires an invalid ordering value to terminate as FAILED without a fabricated decision or explanation.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-a02-operators" });
    const versionId = fixture.ids.baselineVersionId;
    const rules = [
      rule(ctx, versionId, "exists", { priority: 1, condition: { op: "exists", path: "$.value", value: null }, effect: { decision: null, tags: ["exists"] } }),
      rule(ctx, versionId, "null", { priority: 2, condition: { op: "eq", path: "$.value", value: null }, effect: { decision: null, tags: ["null"] } }),
      rule(ctx, versionId, "eq-integer", { priority: 3, condition: { op: "eq", path: "$.value", value: 7 }, effect: { decision: null, tags: ["integer-seven"] } }),
      rule(ctx, versionId, "neq-string", { priority: 4, condition: { op: "neq", path: "$.value", value: "7" }, effect: { decision: null, tags: ["not-string-seven"] } }),
      rule(ctx, versionId, "in", { priority: 5, condition: { op: "in", path: "$.value", value: [7, true] }, effect: { decision: null, tags: ["member"] } }),
      rule(ctx, versionId, "lt", { priority: 6, condition: { op: "lt", path: "$.score", value: 8 }, effect: { decision: null, tags: ["lt"] } }),
      rule(ctx, versionId, "lte", { priority: 7, condition: { op: "lte", path: "$.score", value: 7 }, effect: { decision: null, tags: ["lte"] } }),
      rule(ctx, versionId, "gt", { priority: 8, condition: { op: "gt", path: "$.score", value: 6 }, effect: { decision: null, tags: ["gt"] } }),
      rule(ctx, versionId, "gte", { priority: 9, condition: { op: "gte", path: "$.score", value: 7 }, effect: { decision: "REVIEW", tags: ["gte"] } }),
    ];
    replaceVersionRules(fixture, versionId, rules, { defaultDecision: "DENY" });
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const worker = await ctx.startWorker();
    const factsByEvaluation = new Map();
    for (const [label, facts] of [
      ["missing", { score: 7 }],
      ["null", { value: null, score: 7 }],
      ["integer", { value: 7, score: 7 }],
      ["boolean", { value: true, score: 7 }],
    ]) {
      const { evaluation } = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key(label), label });
      factsByEvaluation.set(evaluation.evaluationId, facts);
      await waitForEvaluation(ctx, api.baseUrl, evaluation.evaluationId, "COMPLETED", { processes: [worker] });
    }
    const snapshot = await ctx.snapshot(api.baseUrl);
    for (const [evaluationId, facts] of factsByEvaluation) assertEvaluationOracle(ctx, snapshot, fixture, evaluationId, facts);

    const invalid = await createEvaluation(ctx, api.baseUrl, fixture, { value: 7, score: "7" }, { key: ctx.key("ordering-string"), label: "string ordering fact" });
    const failed = await waitForEvaluation(ctx, api.baseUrl, invalid.evaluation.evaluationId, "FAILED", { processes: [worker] });
    ctx.equal(failed.decision, null, "invalid ordering has no decision");
    ctx.equal(failed.explanationDigest, null, "invalid ordering has no explanation digest");
    const failedSnapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(resource(failedSnapshot, "explanationNodes").filter(({ evaluationId }) => evaluationId === failed.evaluationId).length, 0, "invalid ordering has no pseudo explanation");
    ctx.equal(failedSnapshot.events.filter(({ aggregateId, type }) => aggregateId === failed.evaluationId && type === "evaluation.failed").length, 1, "invalid ordering emits one failure Event");
    return finalEvidence(ctx, { typedEvaluations: factsByEvaluation.size, invalidOrderingState: failed.state });
  },
}, ["DECLARATIVE_SAFETY", "DETERMINISTIC_EVALUATION"]);

const a03 = guardedCase({
  id: "A-03",
  fixtureFamily: "RB-F-WORKED-ORDER",
  action: "Execute the worked Rule order through public Evaluation HTTP with two canonical-equivalent fact insertion orders, real Workers, Evaluation reads, explanation reads, and the FINAL snapshot.",
  oracle: "The evaluator interpreter fixes priority order, last decision, unique tag production, terminal stop, one later SKIPPED node per Rule, and the canonical explanation digest independent of candidate output.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-a03-worked" });
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const workers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
    const facts = { risk: "high", inserted: { z: 1, a: 2 } };
    const reordered = { inserted: { a: 2, z: 1 }, risk: "high" };
    const first = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key("worked-first") });
    const second = await createEvaluation(ctx, api.baseUrl, fixture, reordered, { key: ctx.key("worked-second") });
    await Promise.all([
      waitForEvaluation(ctx, api.baseUrl, first.evaluation.evaluationId, "COMPLETED", { processes: workers }),
      waitForEvaluation(ctx, api.baseUrl, second.evaluation.evaluationId, "COMPLETED", { processes: workers }),
    ]);
    const snapshot = await ctx.snapshot(api.baseUrl);
    const firstOracle = assertEvaluationOracle(ctx, snapshot, fixture, first.evaluation.evaluationId, facts);
    const secondOracle = assertEvaluationOracle(ctx, snapshot, fixture, second.evaluation.evaluationId, reordered);
    ctx.equal(firstOracle.evaluation.factsDigest, secondOracle.evaluation.factsDigest, "object insertion order does not change facts digest");
    ctx.equal(firstOracle.evaluation.decision, "DENY", "terminal Rule sets DENY");
    ctx.equal(firstOracle.evaluation.tags, ["a", "b"], "tags preserve first producer order");
    ctx.equal(firstOracle.evaluation.matchedRuleIds, [fixture.baselineRules[0].ruleId, fixture.baselineRules[1].ruleId], "matched Rule IDs preserve visit order");
    const skipped = firstOracle.nodes.filter(({ ruleId, result }) => ruleId === fixture.baselineRules[2].ruleId && result === "SKIPPED");
    ctx.equal(skipped.length, 1, "later terminal Rule has one SKIPPED node");
    const explanation = await ctx.request(api.baseUrl, `/api/v1/evaluations/${first.evaluation.evaluationId}/explanation`);
    expectStatus(ctx, explanation, 200, "read explanation");
    ctx.equal(collection(explanation.json, "ExplanationNode collection"), firstOracle.nodes, "HTTP explanation equals snapshot ledger");
    return finalEvidence(ctx, { evaluations: 2, explanationNodes: firstOracle.nodes.length });
  },
}, ["DETERMINISTIC_EVALUATION"]);

function conflictFixture(ctx) {
  const fixture = coreFixture(ctx, { seedVersion: "rb-a04-conflicts" });
  const versionId = fixture.ids.draftVersionId;
  const predicate = { op: "exists", path: "$.risk", value: null };
  const tautologyLeaf = { op: "exists", path: "$.always", value: null };
  const firstId = ctx.uuid("a04-duplicate-id");
  const rules = [
    { ...rule(ctx, versionId, "ambiguous-a", { priority: 1, condition: predicate, effect: { decision: "ALLOW", tags: [] } }), ruleId: firstId },
    rule(ctx, versionId, "ambiguous-b", { priority: 1, condition: predicate, effect: { decision: "DENY", tags: [] } }),
    { ...rule(ctx, versionId, "duplicate-id", { priority: 2, condition: { op: "eq", path: "$.x", value: 1 } }), ruleId: firstId },
    rule(ctx, versionId, "invalid-expression", { priority: 3, condition: { op: "regex", path: "$.x", value: "^unsafe$" }, effect: { decision: "REVIEW", tags: [] } }),
    rule(ctx, versionId, "terminal-null", { priority: 4, condition: { op: "eq", path: "$.x", value: 2 }, effect: { decision: null, tags: [] }, terminal: true }),
    rule(ctx, versionId, "unconditional", { priority: 5, condition: { any: [tautologyLeaf, { not: tautologyLeaf }] }, effect: { decision: "DENY", tags: [] }, terminal: true }),
    rule(ctx, versionId, "unreachable", { priority: 6, condition: { op: "eq", path: "$.mustNotRun", value: true }, effect: { decision: "ALLOW", tags: [] }, terminal: true }),
  ];
  replaceVersionRules(fixture, versionId, rules);
  return { fixture, rules };
}

const a04 = guardedCase({
  id: "A-04",
  fixtureFamily: "RB-F-CONFLICT-LEDGER",
  action: "Validate, read, retry, and attempt to publish a draft containing every static conflict family, then publish a clean draft and retry publication through the public API.",
  oracle: "An independent static checker fixes the sorted conflict projection; conflict retries cannot rewrite the report, and a successfully published Version plus its Rules and digest never changes.",
  async run(ctx) {
    const { fixture, rules } = conflictFixture(ctx);
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const validate = await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/validate`, ctx.key("validate-conflicts"), {});
    ctx.ok([200, 409].includes(validate.status), "conflict validation returns a published success/conflict status");
    if (validate.status === 409) expectError(ctx, validate, 409, "RULE_CONFLICT", "validate conflicting draft");
    const reportResponse = await ctx.request(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/conflicts`);
    expectStatus(ctx, reportResponse, 200, "read conflicts");
    const reports = collection(reportResponse.json, "ConflictReport collection");
    const projection = (value) => ({ priority: value.priority, ruleId: value.ruleId, code: value.code });
    ctx.equal(reports.map(projection), detectConflicts(rules), "deterministic ConflictReport projection");
    const beforeRetry = stableSnapshot(await ctx.snapshot(api.baseUrl));
    const retry = await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/validate`, ctx.key("validate-conflicts-retry"), {});
    ctx.equal(retry.status, validate.status, "validation retry status is stable");
    expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/publish`, ctx.key("publish-conflicts"), { expectedRevision: 4 }), 409, "RULE_CONFLICT", "publish conflicting draft");
    const afterRetry = stableSnapshot(await ctx.snapshot(api.baseUrl));
    ctx.equal(resource(afterRetry, "ruleSetVersions").find(({ ruleSetVersionId }) => ruleSetVersionId === fixture.ids.draftVersionId)?.state, "DRAFT", "conflicting Version remains DRAFT");
    ctx.equal(resource(afterRetry, "conflictReports"), resource(beforeRetry, "conflictReports"), "conflict report is immutable across retry");
    ctx.equal(afterRetry.work, beforeRetry.work, "conflict operations create no Work");
    ctx.equal(afterRetry.events, beforeRetry.events, "conflict operations create no Event");

    await ctx.resetDatabase();
    const clean = coreFixture(ctx, { seedVersion: "rb-a04-clean-publication" });
    await ctx.migrate({ timeoutMs: 300_000 });
    await ctx.seed(clean.seed, { timeoutMs: 600_000 });
    const cleanApi = await ctx.startApi();
    expectStatus(ctx, await ctx.mutate(cleanApi.baseUrl, `/api/v1/rule-set-versions/${clean.ids.draftVersionId}/validate`, ctx.key("validate-clean"), {}), 200, "validate clean draft");
    expectStatus(ctx, await ctx.mutate(cleanApi.baseUrl, `/api/v1/rule-set-versions/${clean.ids.draftVersionId}/publish`, ctx.key("publish-clean"), { expectedRevision: 4 }), 200, "publish clean draft");
    const published = await ctx.snapshot(cleanApi.baseUrl);
    const frozenVersion = clone(byId(resource(published, "ruleSetVersions"), "ruleSetVersionId", clean.ids.draftVersionId));
    const frozenRules = clone(resource(published, "rules").filter(({ ruleSetVersionId }) => ruleSetVersionId === clean.ids.draftVersionId));
    const repeat = await ctx.mutate(cleanApi.baseUrl, `/api/v1/rule-set-versions/${clean.ids.draftVersionId}/publish`, ctx.key("publish-clean-repeat"), { expectedRevision: 4 });
    ctx.equal(repeat.status, 409, "published Version rejects repeat mutation");
    ctx.ok(["VERSION_IMMUTABLE", "REVISION_CONFLICT"].includes(repeat.json?.error?.code), "repeat publication uses stable immutable/revision error");
    const final = await ctx.snapshot(cleanApi.baseUrl);
    ctx.equal(byId(resource(final, "ruleSetVersions"), "ruleSetVersionId", clean.ids.draftVersionId), frozenVersion, "published Version remains byte-for-byte stable");
    ctx.equal(resource(final, "rules").filter(({ ruleSetVersionId }) => ruleSetVersionId === clean.ids.draftVersionId), frozenRules, "published Rules remain immutable");
    return finalEvidence(ctx, { conflictEntries: reports.length, publishedDigest: frozenVersion.rulesDigest });
  },
}, ["VERSION_IMMUTABILITY", "DECLARATIVE_SAFETY"]);

function addSecondRuleSet(ctx, fixture) {
  const ruleSetId = ctx.uuid("a05-other-rule-set");
  const versionId = ctx.uuid("a05-other-version");
  const otherRules = [rule(ctx, versionId, "other-terminal", {
    priority: 1, condition: { op: "exists", path: "$.risk", value: null },
    effect: { decision: "ALLOW", tags: ["other"] }, terminal: true,
  })];
  fixture.seed.ruleSets.push({
    ruleSetId, tenantId: fixture.ids.tenantId, name: "Other RuleSet", currentRevision: 1,
    currentPublishedVersionId: versionId, publicationRevision: 1, createdAt: ctx.at({ days: -4 }),
  });
  fixture.seed.ruleSetVersions.push({
    ruleSetVersionId: versionId, ruleSetId, tenantId: fixture.ids.tenantId, revision: 1,
    state: "PUBLISHED", defaultDecision: "DENY", rulesDigest: sha256Canonical(otherRules), publishedAt: ctx.at({ days: -3 }),
  });
  fixture.seed.rules.push(...otherRules);
  return { ruleSetId, versionId };
}

const a05 = guardedCase({
  id: "A-05",
  fixtureFamily: "RB-F-COMPARISON-FREEZE",
  action: "Create completed Evaluations over HTTP, reject pending and cross-RuleSet corpus sentinels, freeze a duplicated out-of-order corpus, execute it with Workers, and read immutable Results.",
  oracle: "Sorted unique UUIDs and both canonical digests come from evaluator-owned code; each stored fact input is evaluated against both frozen published Versions and original Evaluations remain unchanged.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-a05-comparison" });
    const other = addSecondRuleSet(ctx, fixture);
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const worker = await ctx.startWorker();
    const factsList = [
      { risk: "high", requestId: "a05-1" },
      { risk: "low", requestId: "a05-2" },
      { risk: "high", requestId: "a05-3" },
      { risk: "low", requestId: "a05-4" },
    ];
    const created = [];
    for (const [index, facts] of factsList.entries()) {
      const item = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key(`corpus-${index}`) });
      created.push(item.evaluation);
      await waitForEvaluation(ctx, api.baseUrl, item.evaluation.evaluationId, "COMPLETED", { processes: [worker] });
    }
    const crossBody = {
      tenantId: fixture.ids.tenantId, ruleSetId: other.ruleSetId, ruleSetVersionId: other.versionId,
      facts: { risk: "high", requestId: "cross" },
    };
    const crossResponse = await ctx.mutate(api.baseUrl, "/api/v1/evaluations", ctx.key("cross-evaluation"), crossBody);
    expectStatus(ctx, crossResponse, 200, "create cross-RuleSet Evaluation");
    exactKeys(crossResponse.json, EVALUATION_KEYS, "cross-RuleSet Evaluation");
    await waitForEvaluation(ctx, api.baseUrl, crossResponse.json.evaluationId, "COMPLETED", { processes: [worker] });
    await ctx.stop(worker);
    const pending = await createEvaluation(ctx, api.baseUrl, fixture, { risk: "low", requestId: "pending" }, { key: ctx.key("pending") });
    const beforeInvalid = stableSnapshot(await ctx.snapshot(api.baseUrl));
    for (const [label, evaluationIds] of [
      ["pending corpus", [created[0].evaluationId, pending.evaluation.evaluationId]],
      ["cross RuleSet corpus", [created[0].evaluationId, crossResponse.json.evaluationId]],
    ]) {
      const response = await ctx.mutate(api.baseUrl, "/api/v1/comparison-runs", ctx.key(label), {
        tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
        baselineVersionId: fixture.ids.baselineVersionId, candidateVersionId: fixture.ids.candidateVersionId,
        evaluationIds,
      });
      ctx.ok([400, 409].includes(response.status), `${label} is rejected`);
    }
    const afterInvalid = stableSnapshot(await ctx.snapshot(api.baseUrl));
    ctx.equal(resource(afterInvalid, "comparisonRuns"), resource(beforeInvalid, "comparisonRuns"), "invalid corpus leaves no ComparisonRun");
    ctx.equal(afterInvalid.work, beforeInvalid.work, "invalid corpus leaves no Work");
    ctx.equal(afterInvalid.events, beforeInvalid.events, "invalid corpus leaves no Event");

    const supplied = [...created].reverse().map(({ evaluationId }) => evaluationId).concat(created[0].evaluationId, created.at(-1).evaluationId);
    const frozen = makeComparisonCorpus(supplied);
    const originalEvaluations = clone(resource(afterInvalid, "evaluations").filter(({ evaluationId }) => frozen.evaluationIds.includes(evaluationId)));
    const comparison = await createComparison(ctx, api.baseUrl, fixture, supplied, { key: ctx.key("valid-frozen-corpus") });
    ctx.equal(comparison.run.evaluationIds, frozen.evaluationIds, "ComparisonRun freezes sorted unique IDs");
    ctx.equal(comparison.run.corpusDigest, frozen.corpusDigest, "ComparisonRun corpus digest");
    ctx.equal(comparison.run.baselineVersionId, fixture.ids.baselineVersionId, "baseline Version freezes");
    ctx.equal(comparison.run.candidateVersionId, fixture.ids.candidateVersionId, "candidate Version freezes");
    const started = await startComparison(ctx, api.baseUrl, comparison.run);
    const comparisonWorkers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
    const completed = await waitForComparison(ctx, api.baseUrl, started.run.comparisonRunId, "COMPLETED", { processes: comparisonWorkers });
    const results = [...completed.results].sort((left, right) => left.ordinal - right.ordinal);
    ctx.equal(results.map(({ evaluationId }) => evaluationId), frozen.evaluationIds, "Result order closes frozen corpus");
    const factsById = new Map(created.map((evaluation, index) => [evaluation.evaluationId, factsList[index]]));
    results.forEach((actual, index) => assertComparisonResult(ctx, actual, expectedComparisonResult(fixture, actual.evaluationId, index + 1, factsById.get(actual.evaluationId), {
      comparisonRunId: started.run.comparisonRunId,
    })));
    const counts = { MATCH: 0, DIFF: 0, ERROR: 0 };
    for (const result of results) counts[result.status] += 1;
    ctx.equal(completed.run.resultCounts, counts, "ComparisonRun counts close Results");
    const finalSnapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(resource(finalSnapshot, "evaluations").filter(({ evaluationId }) => frozen.evaluationIds.includes(evaluationId)), originalEvaluations, "Comparison does not modify original Evaluations");
    const read = await readComparison(ctx, api.baseUrl, started.run.comparisonRunId);
    ctx.equal(read, completed, "Comparison detail is immutable after completion");
    return finalEvidence(ctx, { frozenCorpus: frozen.evaluationIds.length, resultCounts: counts });
  },
}, ["COMPARISON_ATOMICITY", "DETERMINISTIC_EVALUATION"]);

export const A_CASES = Object.freeze([a01, a02, a03, a04, a05]);

export default A_CASES;
