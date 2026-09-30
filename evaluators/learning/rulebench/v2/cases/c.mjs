import {
  assertComparisonResult,
  assertEvaluationOracle,
  assertEventLedger,
  byId,
  canonicalJson,
  clone,
  coreFixture,
  createComparison,
  createEvaluation,
  expectedComparisonResult,
  finalEvidence,
  guardedCase,
  replaceVersionRules,
  resource,
  rule,
  startComparison,
  startPreparedApi,
  waitForComparison,
  waitForEvaluation,
  waitForReplay,
  waitForWork,
} from "./helpers.mjs";

function longRunningRules(ctx, versionId, count = 5_000) {
  return Array.from({ length: count }, (_, index) => rule(ctx, versionId, `long-${index}`, {
    priority: index + 1,
    condition: index === count - 1
      ? { op: "exists", path: "$.risk", value: true }
      : { op: "eq", path: "$.bucket", value: index + 10_000 },
    effect: index === count - 1 ? { decision: "DENY", tags: ["terminal"] } : { decision: null, tags: [] },
    terminal: index === count - 1,
  }));
}

async function waitPast(ctx, timestamp, label) {
  const deadline = Date.parse(timestamp);
  ctx.ok(Number.isFinite(deadline), `${label} has a public lease expiry`);
  await ctx.waitFor(() => Date.now() > deadline + 25, { timeoutMs: 15_000, intervalMs: 10, label });
}

async function createCompletedInputs(ctx, baseUrl, fixture, count, worker, factsForIndex = (index) => ({ risk: index % 2 === 0 ? "high" : "low", requestId: `recovery-${index}` })) {
  const evaluations = [];
  const factsById = new Map();
  for (let index = 0; index < count; index += 1) {
    const facts = factsForIndex(index);
    const created = await createEvaluation(ctx, baseUrl, fixture, facts, { key: ctx.key(`input-${index}`) });
    evaluations.push(created.evaluation);
    factsById.set(created.evaluation.evaluationId, facts);
  }
  await Promise.all(evaluations.map(({ evaluationId }) => waitForEvaluation(ctx, baseUrl, evaluationId, "COMPLETED", { timeoutMs: 180_000, processes: [worker] })));
  return { evaluationIds: evaluations.map(({ evaluationId }) => evaluationId), factsById };
}

const c01 = guardedCase({
  id: "C-01",
  fixtureFamily: "RB-F-EVALUATION-LEASE-RECOVERY",
  action: "Observe a long Evaluation Work as LEASED in the authorized snapshot, SIGKILL its sole owning Worker, wait only until the published lease expiry, and start a replacement Worker.",
  oracle: "The durable Work attempt is reclaimed and one independent decision, explanation ledger, digest, and completed Event appear atomically; the killed lease cannot strand or duplicate any result.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-c01-evaluation-recovery" });
    replaceVersionRules(fixture, fixture.ids.baselineVersionId, longRunningRules(ctx, fixture.ids.baselineVersionId));
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const facts = { risk: "high", bucket: -1, requestId: "c01" };
    const created = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key("recover") });
    const victim = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "2" } });
    const observed = await waitForWork(ctx, api.baseUrl, ({ kind, aggregateId, state, leaseExpiresAt }) => (
      kind === "EVALUATION_EXECUTE" && aggregateId === created.evaluation.evaluationId && state === "LEASED" && leaseExpiresAt !== null
    ), { processes: [victim], label: "leased Evaluation Work" });
    ctx.ok((await ctx.request(api.baseUrl, "/healthz")).status === 200, "API remains responsive while Work is leased");
    await ctx.kill(victim);
    await waitPast(ctx, observed.work.leaseExpiresAt, "Evaluation Work lease expiry");
    const replacement = await ctx.startWorker();
    await waitForEvaluation(ctx, api.baseUrl, created.evaluation.evaluationId, "COMPLETED", { timeoutMs: 120_000, processes: [replacement] });
    const snapshot = await ctx.snapshot(api.baseUrl);
    const oracle = assertEvaluationOracle(ctx, snapshot, fixture, created.evaluation.evaluationId, facts);
    const work = snapshot.work.filter(({ kind, aggregateId }) => kind === "EVALUATION_EXECUTE" && aggregateId === created.evaluation.evaluationId);
    ctx.equal(work.length, 1, "recovery keeps one Work identity");
    ctx.equal(work[0].state, "SUCCEEDED", "reclaimed Work succeeds");
    ctx.equal(work[0].terminal, true, "reclaimed Work is terminal");
    ctx.ok(work[0].attempt >= observed.work.attempt + 1, "replacement increments Work attempt");
    ctx.equal(snapshot.events.filter(({ type, aggregateId }) => type === "evaluation.completed" && aggregateId === created.evaluation.evaluationId).length, 1, "recovery emits one completion Event");
    ctx.equal(new Set(oracle.nodes.map(({ ordinal }) => ordinal)).size, oracle.nodes.length, "recovery writes one explanation ledger");
    return finalEvidence(ctx, { killedWorkers: 1, attempts: work[0].attempt, explanationNodes: oracle.nodes.length });
  },
}, ["WORK_RECOVERY", "DETERMINISTIC_EVALUATION"]);

const c02 = guardedCase({
  id: "C-02",
  fixtureFamily: "RB-F-REPLAY-FROZEN-RECOVERY",
  action: "Complete an Evaluation, publish a different current Version, drop the replay response, restart the API, observe replay Work leased, SIGKILL its Worker, and recover with a replacement.",
  oracle: "Replay recomputes from the original frozen Version and facts to MATCHED, preserves the original Evaluation byte-for-byte, and never substitutes the current publication or repairs its digest.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-c02-replay" });
    replaceVersionRules(fixture, fixture.ids.baselineVersionId, longRunningRules(ctx, fixture.ids.baselineVersionId, 3_000));
    let api = await startPreparedApi(ctx, { seed: fixture.seed });
    const worker = await ctx.startWorker();
    const facts = { risk: "high", bucket: -1, requestId: "c02-original" };
    const created = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key("original") });
    await waitForEvaluation(ctx, api.baseUrl, created.evaluation.evaluationId, "COMPLETED", { timeoutMs: 120_000, processes: [worker] });
    await ctx.stop(worker);
    const originalSnapshot = await ctx.snapshot(api.baseUrl);
    const originalEvaluation = clone(byId(resource(originalSnapshot, "evaluations"), "evaluationId", created.evaluation.evaluationId));
    const originalNodes = clone(resource(originalSnapshot, "explanationNodes").filter(({ evaluationId }) => evaluationId === created.evaluation.evaluationId));
    const publication = await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/publish`, ctx.key("publish-current"), {});
    ctx.equal(publication.status, 200, "different current Version publishes");
    const afterPublication = await ctx.snapshot(api.baseUrl);
    ctx.equal(byId(resource(afterPublication, "ruleSets"), "ruleSetId", fixture.ids.ruleSetId).currentPublishedVersionId, fixture.ids.draftVersionId, "current publication changed after original Evaluation");

    const shield = await ctx.responseShield(api.baseUrl);
    const replayKey = ctx.key("unknown-replay-response");
    shield.dropNextMutation();
    let disconnected = false;
    try { await ctx.mutate(shield.baseUrl, `/api/v1/evaluations/${created.evaluation.evaluationId}/replay`, replayKey, {}); }
    catch { disconnected = true; }
    ctx.ok(disconnected, "replay caller observes unknown outcome");
    const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "captured ReplayRun response" });
    const capturedReplay = JSON.parse(capture.response.body);
    await ctx.stop(api);
    api = await ctx.startApi({ port: api.port });
    const replayedResponse = await ctx.mutate(api.baseUrl, `/api/v1/evaluations/${created.evaluation.evaluationId}/replay`, replayKey, {});
    ctx.equal(replayedResponse.status, capture.response.status, "replay retry status survives API restart");
    ctx.equal(replayedResponse.json, capturedReplay, "replay retry body survives API restart");

    const victim = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "2" } });
    const observed = await waitForWork(ctx, api.baseUrl, ({ kind, aggregateId, state }) => (
      kind === "EVALUATION_REPLAY" && aggregateId === capturedReplay.replayRunId && state === "LEASED"
    ), { processes: [victim], label: "leased Replay Work" });
    await ctx.kill(victim);
    await waitPast(ctx, observed.work.leaseExpiresAt, "Replay Work lease expiry");
    const replacement = await ctx.startWorker();
    const terminal = await waitForReplay(ctx, api.baseUrl, capturedReplay.replayRunId, "MATCHED", { timeoutMs: 120_000, processes: [replacement] });
    ctx.equal(terminal.state, "MATCHED", "recovered ReplayRun matches frozen result");
    ctx.ok(/^[0-9a-f]{64}$/u.test(terminal.resultDigest), "ReplayRun publishes a canonical result digest");
    const finalSnapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(byId(resource(finalSnapshot, "evaluations"), "evaluationId", created.evaluation.evaluationId), originalEvaluation, "Replay does not overwrite original Evaluation");
    ctx.equal(resource(finalSnapshot, "explanationNodes").filter(({ evaluationId }) => evaluationId === created.evaluation.evaluationId), originalNodes, "Replay does not rewrite original ExplanationNodes");
    ctx.equal(byId(resource(finalSnapshot, "evaluations"), "evaluationId", created.evaluation.evaluationId).ruleSetVersionId, fixture.ids.baselineVersionId, "Replay keeps original Version despite new current publication");
    ctx.equal(finalSnapshot.events.filter(({ type, aggregateId }) => type === "replay.matched" && aggregateId === capturedReplay.replayRunId).length, 1, "one replay.matched Event");
    return finalEvidence(ctx, { killedWorkers: 1, originalVersionId: fixture.ids.baselineVersionId, currentVersionId: fixture.ids.draftVersionId });
  },
}, ["WORK_RECOVERY", "VERSION_IMMUTABILITY", "DETERMINISTIC_EVALUATION"]);

const c03 = guardedCase({
  id: "C-03",
  fixtureFamily: "RB-F-COMPARISON-DOUBLE-CRASH",
  action: "Freeze a mixed corpus, observe the same Comparison Work leased by two successive Workers and SIGKILL each owner after expiry-based reclaim, then start four replacements.",
  oracle: "Every frozen ID closes exactly once with evaluator-computed ordinal and digest, counts sum to corpus size, the old leases are fenced, and only one completed Event survives both crashes.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-c03-comparison-recovery" });
    const comparisonRuleIds = [ctx.uuid("c03-shared-rule-1"), ctx.uuid("c03-shared-rule-2"), ctx.uuid("c03-shared-rule-3")];
    const comparisonRules = (versionId, candidate) => [
      { ...rule(ctx, versionId, `c03-${candidate ? "candidate" : "baseline"}-1`, {
        priority: 10, condition: { op: "exists", path: "$.risk", value: true },
        effect: { decision: "REVIEW", tags: ["a", "b"] }, terminal: false,
      }), ruleId: comparisonRuleIds[0] },
      { ...rule(ctx, versionId, `c03-${candidate ? "candidate" : "baseline"}-2`, {
        priority: 20, condition: { op: "eq", path: "$.risk", value: "high" },
        effect: candidate ? { decision: "REVIEW", tags: ["b", "candidate"] } : { decision: "DENY", tags: ["b"] }, terminal: true,
      }), ruleId: comparisonRuleIds[1] },
      { ...rule(ctx, versionId, `c03-${candidate ? "candidate" : "baseline"}-3`, {
        priority: 30, condition: { op: "lt", path: "$.score", value: 0 },
        effect: { decision: "ALLOW", tags: ["negative"] }, terminal: true,
      }), ruleId: comparisonRuleIds[2] },
    ];
    replaceVersionRules(fixture, fixture.ids.candidateVersionId, comparisonRules(fixture.ids.candidateVersionId, false));
    replaceVersionRules(fixture, fixture.ids.errorVersionId, comparisonRules(fixture.ids.errorVersionId, true));
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    const inputWorker = await ctx.startWorker();
    const inputs = await createCompletedInputs(ctx, api.baseUrl, fixture, 128, inputWorker, (index) => ({
      risk: index % 3 === 1 ? "high" : "low",
      score: index % 3 === 2 ? "invalid" : 7,
      requestId: `recovery-${index}`,
    }));
    await ctx.stop(inputWorker);
    const comparison = await createComparison(ctx, api.baseUrl, fixture, [...inputs.evaluationIds].reverse(), {
      key: ctx.key("comparison"), baselineVersionId: fixture.ids.candidateVersionId, candidateVersionId: fixture.ids.errorVersionId,
    });
    const started = await startComparison(ctx, api.baseUrl, comparison.run, { key: ctx.key("start") });
    const observedAttempts = [];
    for (let crash = 0; crash < 2; crash += 1) {
      const victim = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "2" } });
      const observed = await waitForWork(ctx, api.baseUrl, ({ kind, aggregateId, state, attempt }) => (
        kind === "COMPARISON_EXECUTE"
          && aggregateId === started.run.comparisonRunId
          && state === "LEASED"
          && (crash === 0 || attempt > observedAttempts.at(-1))
      ), { timeoutMs: 60_000, processes: [victim], label: `Comparison lease attempt ${crash + 1}` });
      observedAttempts.push(observed.work.attempt);
      await ctx.kill(victim);
      await waitPast(ctx, observed.work.leaseExpiresAt, `Comparison lease ${crash + 1} expiry`);
    }
    const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const completed = await waitForComparison(ctx, api.baseUrl, started.run.comparisonRunId, "COMPLETED", { timeoutMs: 120_000, processes: replacements });
    const results = [...completed.results].sort((left, right) => left.ordinal - right.ordinal);
    ctx.equal(results.length, inputs.evaluationIds.length, "all frozen inputs close");
    ctx.equal(new Set(results.map(({ evaluationId }) => evaluationId)).size, inputs.evaluationIds.length, "no duplicate ComparisonResult");
    results.forEach((actual, index) => assertComparisonResult(ctx, actual, expectedComparisonResult(fixture, actual.evaluationId, index + 1, inputs.factsById.get(actual.evaluationId), {
      comparisonRunId: started.run.comparisonRunId,
      baselineVersionId: fixture.ids.candidateVersionId,
      candidateVersionId: fixture.ids.errorVersionId,
    })));
    const counts = { MATCH: 0, DIFF: 0, ERROR: 0 };
    results.forEach(({ status }) => { counts[status] += 1; });
    ctx.ok(counts.MATCH > 0 && counts.DIFF > 0 && counts.ERROR > 0, "recovered corpus genuinely covers MATCH, DIFF, and ERROR");
    ctx.equal(completed.run.resultCounts, counts, "recovered counts close corpus");
    const snapshot = await ctx.snapshot(api.baseUrl);
    const work = snapshot.work.filter(({ kind, aggregateId }) => kind === "COMPARISON_EXECUTE" && aggregateId === started.run.comparisonRunId);
    ctx.ok(work.length >= 1, "crashes retain durable Comparison Work");
    ctx.ok(work.every(({ terminal }) => terminal), "all recovered Comparison Work is terminal");
    ctx.ok(work.some(({ attempt }) => attempt > observedAttempts.at(-1)), "replacement owns a newer fenced attempt");
    ctx.equal(snapshot.events.filter(({ type, aggregateId }) => type === "comparison.completed" && aggregateId === started.run.comparisonRunId).length, 1, "one comparison.completed Event");
    return finalEvidence(ctx, { killedWorkers: 2, replacements: replacements.length, corpusSize: results.length });
  },
}, ["WORK_RECOVERY", "COMPARISON_ATOMICITY"]);

function hasSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /facts|authorization|credential|token|database|privatePath|environment/iu.test(key) || hasSensitiveKey(child));
}

const c04 = guardedCase({
  id: "C-04",
  fixtureFamily: "RB-F-EVENT-RESTART-LEDGER",
  action: "Publish a Version, complete an Evaluation and Comparison, force rejected control transitions, restart the production Dispatcher twice, and compare authorized Event snapshots before and after each process boundary.",
  oracle: "Published Event types, IDs, canonical bodies, aggregate sequences, and business atomicity remain stable across actual Dispatcher process restarts; no unpublished receiver protocol is assumed.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-c04-events" });
    const api = await startPreparedApi(ctx, { seed: fixture.seed });
    ctx.equal((await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/publish`, ctx.key("publish"), {})).status, 200, "Version publication succeeds");
    const worker = await ctx.startWorker();
    const facts = { risk: "high", requestId: "c04" };
    const evaluation = await createEvaluation(ctx, api.baseUrl, fixture, facts, { key: ctx.key("evaluation") });
    await waitForEvaluation(ctx, api.baseUrl, evaluation.evaluation.evaluationId, "COMPLETED", { processes: [worker] });
    const comparison = await createComparison(ctx, api.baseUrl, fixture, [evaluation.evaluation.evaluationId], { key: ctx.key("comparison") });
    const started = await startComparison(ctx, api.baseUrl, comparison.run, { key: ctx.key("comparison-start") });
    const completed = await waitForComparison(ctx, api.baseUrl, started.run.comparisonRunId, "COMPLETED", { processes: [worker] });
    const beforeRejected = await ctx.snapshot(api.baseUrl);
    const eventCount = beforeRejected.events.length;
    const rejectedCancel = await ctx.mutate(api.baseUrl, `/api/v1/comparison-runs/${completed.run.comparisonRunId}/cancel`, ctx.key("late-cancel"), { expectedRevision: comparison.run.revision });
    ctx.equal(rejectedCancel.status, 409, "stale completed-run cancellation rejects");
    const rejectedPublish = await ctx.mutate(api.baseUrl, `/api/v1/rule-set-versions/${fixture.ids.draftVersionId}/publish`, ctx.key("repeat-publish"), {});
    ctx.equal(rejectedPublish.status, 409, "repeat publication rejects");
    ctx.equal((await ctx.snapshot(api.baseUrl)).events.length, eventCount, "rolled-back transitions append no Event");

    const stableBefore = clone((await ctx.snapshot(api.baseUrl)).events);
    const firstDispatcher = await ctx.startDispatcher();
    await new Promise((resolve) => setTimeout(resolve, 150));
    ctx.equal(firstDispatcher.child.exitCode, null, "Dispatcher remains running without an unpublished receiver contract");
    await ctx.kill(firstDispatcher);
    const secondDispatcher = await ctx.startDispatcher();
    await new Promise((resolve) => setTimeout(resolve, 150));
    ctx.equal(secondDispatcher.child.exitCode, null, "replacement Dispatcher remains running");
    await ctx.stop(secondDispatcher);
    const stableAfter = (await ctx.snapshot(api.baseUrl)).events;
    ctx.equal(stableAfter, stableBefore, "Dispatcher restarts do not rewrite Event ledger");
    const metrics = assertEventLedger(ctx, stableAfter);
    const allowed = new Set([
      "rule_version.published", "evaluation.completed", "evaluation.failed", "replay.matched", "replay.diverged",
      "comparison.started", "comparison.completed", "comparison.cancelled", "comparison.promoted",
    ]);
    ctx.ok(stableAfter.every(({ type }) => allowed.has(type)), "only published Event types exist");
    ctx.ok(stableAfter.every(({ eventId }) => typeof eventId === "string"), "every Event has stable identity");
    ctx.ok(stableAfter.every((event) => !hasSensitiveKey(event)), "Events contain no facts or credentials");
    ctx.ok(stableAfter.every((event) => canonicalJson(event.body ?? event.payload ?? {}).length > 1), "every Event exposes a canonical body");
    return ctx.pass({
      evidence: [{ kind: "rulebench-case-summary", events: stableAfter.length, ...metrics }],
    });
  },
}, ["WORK_RECOVERY"]);

export const C_CASES = Object.freeze([c01, c02, c03, c04]);

export default C_CASES;
