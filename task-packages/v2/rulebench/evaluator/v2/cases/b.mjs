import {
  assertComparisonResult,
  assertEvaluationOracle,
  byId,
  canonicalJson,
  clone,
  coreFixture,
  createComparison,
  createEvaluation,
  exactKeys,
  expectError,
  expectedComparisonResult,
  finalEvidence,
  guardedCase,
  readEvaluation,
  resource,
  stableSnapshot,
  startComparison,
  startPreparedApi,
  waitForComparison,
  waitForEvaluation,
  waitForWork,
} from "./helpers.mjs";

async function completedCorpus(ctx, baseUrl, fixture, count, options = {}) {
  const worker = options.worker ?? await ctx.startWorker();
  const factsById = new Map();
  const evaluations = [];
  for (let index = 0; index < count; index += 1) {
    const facts = options.facts?.(index) ?? { risk: index % 2 === 0 ? "high" : "low", requestId: `${ctx.caseId}-${index}` };
    const created = await createEvaluation(ctx, baseUrl, fixture, facts, { key: ctx.key(`${options.label ?? "corpus"}-${index}`) });
    evaluations.push(created.evaluation);
    factsById.set(created.evaluation.evaluationId, facts);
  }
  await Promise.all(evaluations.map(({ evaluationId }) => waitForEvaluation(ctx, baseUrl, evaluationId, "COMPLETED", {
    timeoutMs: options.timeoutMs ?? 120_000, processes: [worker],
  })));
  return { evaluations, evaluationIds: evaluations.map(({ evaluationId }) => evaluationId), factsById, worker };
}

const b01 = guardedCase({
  id: "B-01",
  fixtureFamily: "RB-F-IDEMPOTENT-FREEZE",
  action: "Drop an Evaluation response after commit, restart the API, issue twenty canonical-equivalent concurrent replays across two API processes, and then reuse the key with different facts.",
  oracle: "Status, exact saved body, identity, canonical facts digest, frozen Version, one Evaluation, and one Work remain stable; a semantically different body returns IDEMPOTENCY_CONFLICT with zero second effect.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-b01-idempotency" });
    let api = await startPreparedApi(ctx, { seed: fixture.seed });
    const shield = await ctx.responseShield(api.baseUrl);
    const key = ctx.key("unknown-response");
    const facts = { risk: "high", nested: { z: 1, a: 2 }, requestId: "b01" };
    const body = {
      tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
      ruleSetVersionId: fixture.ids.baselineVersionId, facts,
    };
    shield.dropNextMutation();
    let disconnected = false;
    try { await ctx.mutate(shield.baseUrl, "/api/v1/evaluations", key, body); }
    catch { disconnected = true; }
    ctx.ok(disconnected, "client observes unknown Evaluation outcome");
    const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "captured committed Evaluation response" });
    ctx.equal(capture.response.status, 200, "captured Evaluation status");
    const originalBody = JSON.parse(capture.response.body);
    exactKeys(originalBody, [
      "evaluationId", "tenantId", "ruleSetId", "ruleSetVersionId", "factsDigest", "state",
      "decision", "tags", "matchedRuleIds", "explanationDigest", "createdAt", "completedAt", "sequence",
    ], "captured Evaluation");
    await ctx.stop(api);
    const apis = [await ctx.startApi(), await ctx.startApi()];
    const reorderedBody = {
      facts: { requestId: "b01", nested: { a: 2, z: 1 }, risk: "high" },
      ruleSetVersionId: fixture.ids.baselineVersionId, ruleSetId: fixture.ids.ruleSetId, tenantId: fixture.ids.tenantId,
    };
    const replays = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/evaluations", key, reorderedBody));
    for (const replay of replays) {
      ctx.equal(replay.status, capture.response.status, "idempotent replay status");
      ctx.equal(canonicalJson(replay.json), canonicalJson(originalBody), "idempotent replay exact body");
    }
    const conflict = await ctx.mutate(apis[0].baseUrl, "/api/v1/evaluations", key, {
      ...body, facts: { ...facts, risk: "low" },
    });
    expectError(ctx, conflict, 409, "IDEMPOTENCY_CONFLICT", "different canonical Evaluation body");
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const matching = resource(snapshot, "evaluations").filter(({ evaluationId }) => evaluationId === originalBody.evaluationId);
    ctx.equal(matching.length, 1, "one durable Evaluation identity");
    ctx.equal(matching[0].factsDigest, originalBody.factsDigest, "facts digest remains frozen");
    ctx.equal(matching[0].ruleSetVersionId, fixture.ids.baselineVersionId, "RuleSetVersion remains frozen");
    ctx.equal(snapshot.work.filter(({ kind, aggregateId }) => kind === "EVALUATION_EXECUTE" && aggregateId === originalBody.evaluationId).length, 1, "one Evaluation Work effect");
    const worker = await ctx.startWorker();
    await waitForEvaluation(ctx, apis[0].baseUrl, originalBody.evaluationId, "COMPLETED", { processes: [worker] });
    assertEvaluationOracle(ctx, await ctx.snapshot(apis[0].baseUrl), fixture, originalBody.evaluationId, facts);
    return finalEvidence(ctx, { concurrentReplays: replays.length, evaluationId: originalBody.evaluationId });
  },
}, ["DURABLE_IDEMPOTENCY"]);

const b02 = guardedCase({
  id: "B-02",
  fixtureFamily: "RB-F-PUBLICATION-RACE",
  action: "Race two public publication mutations for the same validated draft revision through separate API processes, then retry and inspect the Version, Rules, RuleSet pointer, Work, and Event ledger.",
  oracle: "Exactly one revision transition wins, its independent Rules digest and immutable content persist, while the CAS loser cannot publish, move the pointer, or append a second publication Event.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-b02-publication" });
    await startPreparedApi(ctx, { seed: fixture.seed }).then((record) => ctx.stop(record));
    const apis = [await ctx.startApi(), await ctx.startApi()];
    const validate = await ctx.mutate(apis[0].baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/validate`, ctx.key("validate"), {});
    ctx.equal(validate.status, 200, "draft validation succeeds");
    const before = await ctx.snapshot(apis[0].baseUrl);
    const publications = await Promise.all(apis.map((api, index) => ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/publish`, ctx.key(`publish-${index}`), {})));
    ctx.equal(publications.filter(({ status }) => status === 200).length, 1, "one publication winner");
    ctx.equal(publications.filter(({ status }) => status === 409).length, 1, "one publication CAS loser");
    const loser = publications.find(({ status }) => status === 409);
    ctx.equal(loser.json?.error?.code, "REVISION_CONFLICT", "publication loser revision error");
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const version = byId(resource(snapshot, "ruleSetVersions"), "ruleSetVersionId", fixture.ids.draftVersionId);
    ctx.equal(version.state, "PUBLISHED", "draft has one published state");
    const publishedRules = resource(snapshot, "rules").filter(({ ruleSetVersionId }) => ruleSetVersionId === fixture.ids.draftVersionId);
    ctx.equal(version.rulesDigest, fixture.seed.ruleSetVersions.find(({ ruleSetVersionId }) => ruleSetVersionId === fixture.ids.draftVersionId).rulesDigest, "winner keeps exact independent digest");
    ctx.equal(publishedRules, fixture.draftRules, "winner keeps exact Rules");
    ctx.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === fixture.ids.draftVersionId && type === "rule_version.published").length, 1, "one publication Event");
    ctx.equal(snapshot.work.length, before.work.length, "publication race creates no unrelated Work");
    const frozen = clone({ version, publishedRules });
    const retry = await ctx.mutate(apis[1].baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/publish`, ctx.key("publish-retry"), {});
    ctx.equal(retry.status, 409, "published Version rejects later retry");
    const after = await ctx.snapshot(apis[0].baseUrl);
    ctx.equal({
      version: byId(resource(after, "ruleSetVersions"), "ruleSetVersionId", fixture.ids.draftVersionId),
      publishedRules: resource(after, "rules").filter(({ ruleSetVersionId }) => ruleSetVersionId === fixture.ids.draftVersionId),
    }, frozen, "published ledger stays immutable");
    ctx.equal(after.events.filter(({ aggregateId, type }) => aggregateId === fixture.ids.draftVersionId && type === "rule_version.published").length, 1, "losers append no Event");
    return finalEvidence(ctx, { winnerStatus: 200, loserCode: loser.json.error.code });
  },
}, ["VERSION_IMMUTABILITY"]);

const b03 = guardedCase({
  id: "B-03",
  fixtureFamily: "RB-F-EVALUATION-CONTENTION",
  action: "Accept one frozen Evaluation while four production Workers contend for its durable Work, then read the Evaluation, ExplanationNodes, terminal Work, and completed Event from public surfaces.",
  oracle: "One evaluator-owned decision, tag order, matched Rule order, node ledger, and digest become atomically visible exactly once; no second worker result or completed-without-Event state is allowed.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-b03-worker-contention" });
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const facts = { risk: "high", requestId: "b03-contention" };
    const created = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key("contention") });
    await waitForEvaluation(ctx, api.baseUrl, created.evaluation.evaluationId, "COMPLETED", { processes: workers });
    const snapshot = await ctx.snapshot(api.baseUrl);
    const oracle = assertEvaluationOracle(ctx, snapshot, fixture, created.evaluation.evaluationId, facts);
    const matchingWork = snapshot.work.filter(({ kind, aggregateId }) => kind === "EVALUATION_EXECUTE" && aggregateId === created.evaluation.evaluationId);
    ctx.equal(matchingWork.length, 1, "one Evaluation Work row");
    ctx.equal(matchingWork[0].state, "SUCCEEDED", "Evaluation Work succeeds");
    ctx.equal(matchingWork[0].terminal, true, "Evaluation Work is terminal");
    ctx.equal(snapshot.events.filter(({ type, aggregateId }) => type === "evaluation.completed" && aggregateId === created.evaluation.evaluationId).length, 1, "one completion Event");
    ctx.equal(new Set(oracle.nodes.map(({ ordinal }) => ordinal)).size, oracle.nodes.length, "Explanation ordinals are unique");
    const read = await readEvaluation(ctx, api.baseUrl, created.evaluation.evaluationId);
    ctx.equal(read, oracle.evaluation, "public Evaluation read equals atomic snapshot");
    return finalEvidence(ctx, { workers: workers.length, explanationNodes: oracle.nodes.length });
  },
}, ["DETERMINISTIC_EVALUATION", "WORK_RECOVERY"]);

const b04 = guardedCase({
  id: "B-04",
  fixtureFamily: "RB-F-COMPARISON-CAS",
  action: "Complete a mixed corpus, send twenty concurrent start requests with one expected revision through two APIs, drain with four Workers, and read every immutable Result and count.",
  oracle: "Only one CAS transition creates comparison Work and the started Event; the evaluator recomputes one canonical Result per sorted frozen Evaluation ID and closes counts exactly.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-b04-start-cas" });
    await startPreparedApi(ctx, { seed: fixture.seed }).then((record) => ctx.stop(record));
    const apis = [await ctx.startApi(), await ctx.startApi()];
    const corpus = await completedCorpus(ctx, apis[0].baseUrl, fixture, 12, { label: "b04" });
    await ctx.stop(corpus.worker);
    const comparison = await createComparison(ctx, apis[0].baseUrl, fixture, [...corpus.evaluationIds].reverse(), { key: ctx.key("create") });
    const beforeStart = stableSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const starts = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
      apis[index % 2].baseUrl,
      `/api/v1/comparison-runs/${comparison.run.comparisonRunId}/start`,
      ctx.key(`start-${index}`),
      { expectedRevision: comparison.run.revision },
    ));
    ctx.equal(starts.filter(({ status }) => status === 200).length, 1, "one Comparison start winner");
    ctx.equal(starts.filter(({ status, json }) => status === 409 && json?.error?.code === "COMPARISON_REVISION_CONFLICT").length, 19, "all start CAS losers conflict");
    const startedRun = starts.find(({ status }) => status === 200).json.run;
    const afterStart = await ctx.snapshot(apis[0].baseUrl);
    const newWork = afterStart.work.filter(({ workId }) => !beforeStart.work.some((item) => item.workId === workId));
    ctx.equal(newWork.filter(({ kind, aggregateId }) => kind === "COMPARISON_EXECUTE" && aggregateId === comparison.run.comparisonRunId).length, 1, "one CAS Work effect");
    ctx.equal(afterStart.events.filter(({ type, aggregateId }) => type === "comparison.started" && aggregateId === comparison.run.comparisonRunId).length, 1, "one started Event");
    const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const completed = await waitForComparison(ctx, apis[0].baseUrl, startedRun.comparisonRunId, "COMPLETED", { processes: workers });
    ctx.equal(completed.results.length, corpus.evaluationIds.length, "one Result per corpus item");
    ctx.equal(new Set(completed.results.map(({ evaluationId }) => evaluationId)).size, corpus.evaluationIds.length, "Result Evaluation IDs are unique");
    const results = [...completed.results].sort((left, right) => left.ordinal - right.ordinal);
    results.forEach((actual, index) => assertComparisonResult(ctx, actual, expectedComparisonResult(fixture, actual.evaluationId, index + 1, corpus.factsById.get(actual.evaluationId), {
      comparisonRunId: startedRun.comparisonRunId,
    })));
    const counts = { MATCH: 0, DIFF: 0, ERROR: 0 };
    results.forEach(({ status }) => { counts[status] += 1; });
    ctx.equal(completed.run.resultCounts, counts, "Result counts close corpus size");
    return finalEvidence(ctx, { startAttempts: starts.length, corpusSize: corpus.evaluationIds.length });
  },
}, ["COMPARISON_ATOMICITY"]);

const b05 = guardedCase({
  id: "B-05",
  fixtureFamily: "RB-F-CONTROL-LINEARIZATION",
  action: "Pause a Worker after public lease observation and cancel its Run, then race promotion on a completed DIFF Run and attempt promotion on a completed ERROR Run through two API processes.",
  oracle: "Cancellation durably fences the observed lease, promotion changes only the RuleSet pointer once under revision CAS, and any ERROR count blocks promotion without rewriting Versions, Results, or Evaluations.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-b05-controls" });
    await startPreparedApi(ctx, { seed: fixture.seed }).then((record) => ctx.stop(record));
    const apis = [await ctx.startApi(), await ctx.startApi()];
    const corpus = await completedCorpus(ctx, apis[0].baseUrl, fixture, 64, { label: "b05" });
    const errorFacts = { risk: "low", score: "not-an-integer", requestId: "b05-error" };
    const errorEvaluation = await createEvaluation(ctx, apis[0].baseUrl, fixture, errorFacts, { key: ctx.key("error-evaluation") });
    await waitForEvaluation(ctx, apis[0].baseUrl, errorEvaluation.evaluation.evaluationId, "COMPLETED", { processes: [corpus.worker] });
    await ctx.stop(corpus.worker);

    const cancellable = await createComparison(ctx, apis[0].baseUrl, fixture, corpus.evaluationIds, { key: ctx.key("cancellable") });
    const cancellableStarted = await startComparison(ctx, apis[0].baseUrl, cancellable.run, { key: ctx.key("cancellable-start") });
    const victim = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "2" } });
    const observed = await waitForWork(ctx, apis[0].baseUrl, ({ kind, aggregateId, state }) => kind === "COMPARISON_EXECUTE" && aggregateId === cancellable.run.comparisonRunId && state === "LEASED", {
      processes: [victim], label: "leased cancellable Comparison Work",
    });
    process.kill(-victim.pid, "SIGSTOP");
    const resultsAtFence = resource(observed.snapshot, "comparisonResults").filter(({ comparisonRunId }) => comparisonRunId === cancellable.run.comparisonRunId).length;
    const cancelled = await ctx.mutate(apis[1].baseUrl, `/api/v1/comparison-runs/${cancellable.run.comparisonRunId}/cancel`, ctx.key("cancel"), {
      expectedRevision: cancellableStarted.run.revision,
    });
    ctx.equal(cancelled.status, 200, "cancel wins against leased Worker");
    ctx.equal(cancelled.json?.run?.state, "CANCELLED", "cancel creates durable terminal state");
    await ctx.kill(victim);
    const replacement = await ctx.startWorker();
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const afterCancel = await ctx.snapshot(apis[0].baseUrl);
    ctx.equal(resource(afterCancel, "comparisonResults").filter(({ comparisonRunId }) => comparisonRunId === cancellable.run.comparisonRunId).length, resultsAtFence, "cancelled lease cannot append Results");
    ctx.equal(afterCancel.events.filter(({ type, aggregateId }) => type === "comparison.cancelled" && aggregateId === cancellable.run.comparisonRunId).length, 1, "cancel has one Event");

    const promotable = await createComparison(ctx, apis[0].baseUrl, fixture, corpus.evaluationIds.slice(0, 12), { key: ctx.key("promotable") });
    const promotableStarted = await startComparison(ctx, apis[0].baseUrl, promotable.run, { key: ctx.key("promotable-start") });
    const completed = await waitForComparison(ctx, apis[0].baseUrl, promotableStarted.run.comparisonRunId, "COMPLETED", { processes: [replacement] });
    ctx.equal(completed.run.resultCounts.ERROR, 0, "promotable Run has no ERROR");
    const beforePromotion = await ctx.snapshot(apis[0].baseUrl);
    const pointerBefore = clone(byId(resource(beforePromotion, "ruleSets"), "ruleSetId", fixture.ids.ruleSetId));
    const versionsBefore = clone(resource(beforePromotion, "ruleSetVersions"));
    const resultsBefore = clone(resource(beforePromotion, "comparisonResults").filter(({ comparisonRunId }) => comparisonRunId === completed.run.comparisonRunId));
    const promotions = await Promise.all(apis.map((api, index) => ctx.mutate(api.baseUrl, `/api/v1/comparison-runs/${completed.run.comparisonRunId}/promote`, ctx.key(`promote-${index}`), {
      expectedRevision: completed.run.revision,
    })));
    ctx.equal(promotions.filter(({ status }) => status === 200).length, 1, "one promotion winner");
    ctx.equal(promotions.filter(({ status, json }) => status === 409 && json?.error?.code === "COMPARISON_REVISION_CONFLICT").length, 1, "one promotion CAS loser");
    const promoted = promotions.find(({ status }) => status === 200);
    exactKeys(promoted.json, ["run", "ruleSet"], "promotion response");
    const promotedSnapshot = await ctx.snapshot(apis[0].baseUrl);
    const pointerAfter = byId(resource(promotedSnapshot, "ruleSets"), "ruleSetId", fixture.ids.ruleSetId);
    ctx.equal(pointerAfter.currentPublishedVersionId, fixture.ids.candidateVersionId, "promotion switches only candidate pointer");
    ctx.equal(pointerAfter.publicationRevision, pointerBefore.publicationRevision + 1, "promotion increments publication revision once");
    ctx.equal(resource(promotedSnapshot, "ruleSetVersions"), versionsBefore, "promotion changes no RuleSetVersion");
    ctx.equal(resource(promotedSnapshot, "comparisonResults").filter(({ comparisonRunId }) => comparisonRunId === completed.run.comparisonRunId), resultsBefore, "promotion changes no Result");

    const errorRun = await createComparison(ctx, apis[0].baseUrl, fixture, [errorEvaluation.evaluation.evaluationId], {
      key: ctx.key("error-run"), candidateVersionId: fixture.ids.errorVersionId,
    });
    const errorStarted = await startComparison(ctx, apis[0].baseUrl, errorRun.run, { key: ctx.key("error-start") });
    const errorCompleted = await waitForComparison(ctx, apis[0].baseUrl, errorStarted.run.comparisonRunId, "COMPLETED", { processes: [replacement] });
    ctx.equal(errorCompleted.run.resultCounts.ERROR, 1, "invalid candidate evaluation records ERROR");
    ctx.equal(errorCompleted.results[0].status, "ERROR", "ERROR Result is immutable public state");
    const pointerBeforeBlocked = clone(byId(resource(await ctx.snapshot(apis[0].baseUrl), "ruleSets"), "ruleSetId", fixture.ids.ruleSetId));
    expectError(ctx, await ctx.mutate(apis[1].baseUrl, `/api/v1/comparison-runs/${errorCompleted.run.comparisonRunId}/promote`, ctx.key("error-promote"), {
      expectedRevision: errorCompleted.run.revision,
    }), 409, "COMPARISON_HAS_ERRORS", "ERROR promotion gate");
    const blockedSnapshot = await ctx.snapshot(apis[0].baseUrl);
    ctx.equal(byId(resource(blockedSnapshot, "ruleSets"), "ruleSetId", fixture.ids.ruleSetId), pointerBeforeBlocked, "ERROR promotion has no pointer effect");
    ctx.equal(byId(resource(blockedSnapshot, "evaluations"), "evaluationId", errorEvaluation.evaluation.evaluationId).state, "COMPLETED", "comparison never overwrites original Evaluation");
    return finalEvidence(ctx, { cancelledAtLeaseOwner: observed.work.leaseOwner, promotions: promotions.length, errorCount: 1 });
  },
}, ["COMPARISON_ATOMICITY", "WORK_RECOVERY", "VERSION_IMMUTABILITY"]);

export const B_CASES = Object.freeze([b01, b02, b03, b04, b05]);

export default B_CASES;
