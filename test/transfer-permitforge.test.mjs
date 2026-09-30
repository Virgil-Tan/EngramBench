import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import contract from '../contracts/transfer/permitforge.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import * as runtime from '../templates/contract-first/runtime.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { createFixtureFactory } from '../evaluators/transfer/permitforge/v2/fixtures/index.mjs';
import { assertOpenApiDocument, assertApplicationRevision, assertReviewClaim, assertStageEvidence, canonicalJson, sha256 } from '../evaluators/transfer/permitforge/v2/oracles/index.mjs';
import { submitApplication, claimReview, claimResource, exerciseRepeatedReviewerStages } from '../evaluators/transfer/permitforge/v2/cases/helpers.mjs';
import { CASES } from '../evaluators/transfer/permitforge/v2/cases/index.mjs';
const options = { evaluationSeed: 'author-wire-regression', caseId: 'A-03', baseTime: '2026-09-07T00:00:00.000Z' };
const f = createFixtureFactory(options), compile = runtime.validator(contract);

test('Permit confirmed Stage names reject empty/whitespace and allow duplicate nonblank names', () => {
  const check = runtime.requestValidator(contract);
  for (const id of ['create-application', 'replace-revision']) {
    const operation = contract.operations.find(item => item.id === id);
    for (const value of ['', ' ', '\t\n', '\u00a0']) {
      const input = { ...structuredClone(operation.example), hasBody: true };
      input.headers['content-type'] = 'application/json';
      input.body.stages = [{ name: value, reviewPolicy: f.policy }]; delete input.body.reviewPolicy;
      const result = check(operation, input);
      assert.equal(result.valid, false, `${id} rejects ${JSON.stringify(value)}`);
      assert.equal(result.code, 'INVALID_REVIEW_STAGES');
    }
    const input = { ...structuredClone(operation.example), hasBody: true };
    input.body.stages = [{ name: 'Same name', reviewPolicy: f.policy }, { name: 'Same name', reviewPolicy: f.policy }]; delete input.body.reviewPolicy;
    input.headers['content-type'] = 'application/json';
    assert.equal(check(operation, input).valid, true);
  }
});

test('Permit public operations, linked approval seed and captured-clock staged smoke compile', () => {
  assert.deepEqual(validatePublicContract(contract), { operations: 14, probes: 16, schemas: 26 });
  assert.equal(CASES.length, 48);
  assert.equal(CASES.filter(item => item.blockedAssertions.length).length, 22, 'remaining inherited diagnostics stay visible');
  assert.equal(contract.policyRevision, 'permitforge-stage-review-v1');
  const seed = contract.seed.example;
  assert.equal(seed.reviewDecisions[0].applicationId, seed.permitApplications[0].applicationId);
  assert.equal(seed.approvedPermits[0].canonicalDigest, seed.applicationRevisions[0].canonicalDigest);
  assertApplicationRevision(seed.applicationRevisions[0]);
  assert(contract.smoke.some(step => step.body?.deadlineAt === '${publicClock+3600000ms}'));
});

test('Permit hidden OpenAPI oracle accepts the published baseline and rejects schema drift', () => {
  const document = runtime.openApi(contract), author = { contract, runtime };
  assertOpenApiDocument(document, author);
  document.components.schemas.ClaimResponse.additionalProperties = true;
  assert.throws(() => assertOpenApiDocument(document, author));
});

test('Permit actual fixture families and full published performance seed obey public wire', () => {
  const check = compile(contract.seed.schema);
  for (const family of ['main', 'projections', 'pagination', 'changes', 'due', 'event', 'idempotency', 'finalStages', 'migration', 'browser']) assert(check(f[family]().seed), `${family}: ${JSON.stringify(check.errors)}`);
  const performance = f.performance();
  assert.equal(performance.spec.applications, 20000);
  assert(check(performance.buildSeed()), JSON.stringify(check.errors));
});

test('Permit real helper captures top-level Application, reads Revision, and validates token-only response extension', async () => {
  const family = f.main(), application = family.application, revision = family.revision;
  const claim = { claimId: f.uuid('claim'), applicationId: application.applicationId, revision: 1, reviewerId: family.securityReviewers[0].reviewerId, role: 'security', state: 'LEASED', attempt: 1, leaseExpiresAt: f.at({ days: 1 }) };
  const check = runtime.requestValidator(contract), calls = [];
  const request = async (_base, path, options = {}) => {
    const route = runtime.matchOperation(contract.operations, options.method ?? 'GET', new URL(path, 'http://localhost').pathname);
    assert(route, path);
    const result = check(route.operation, { params: route.params, headers: options.headers, body: options.json, hasBody: options.json !== undefined });
    assert(result.valid, `${path}: ${JSON.stringify(result)}`);
    calls.push(route.operation.id);
    const json = route.operation.id === 'create-application' ? application : route.operation.id === 'claim-review' ? { ...claim, claimToken: 'issued-private-fence' } : revision;
    const responseCheck = compile(route.operation.response); assert(responseCheck(json), JSON.stringify(responseCheck.errors));
    return { status: route.operation.status, json };
  };
  const ctx = { key: f.key, ok: assert.ok, assert: (_label, fn) => fn(), request,
    mutate: (base, path, key, json, options = {}) => request(base, path, { ...options, method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, json }) };
  const created = await submitApplication(ctx, 'http://localhost', f.submissionBody('public-wire'));
  assert.deepEqual(created.revision, revision);
  const claimed = await claimReview(ctx, 'http://localhost', application.applicationId, { reviewerId: claim.reviewerId, role: claim.role });
  assert.deepEqual(claimed.claim, claim);
  assertReviewClaim(claimed.claim);
  assert.throws(() => claimResource({ ...claimed.response.json, secret: 'extra' }), /exact fields/);
  const corruptRevision = { ...revision, canonicalDigest: '0'.repeat(64) };
  assert.throws(() => assertApplicationRevision(corruptRevision), /canonical digest/);
  assert.deepEqual(calls, ['create-application', 'read-revision', 'claim-review']);
});

test('Permit actual invalid-seed case marks only malformed schema variants', async () => {
  const check = compile(contract.seed.schema), calls = [];
  const snapshot = { asOf: f.at(), resources: { applicants: [], reviewers: [], permitApplications: [], applicationRevisions: [], reviewClaims: [], reviewDecisions: [], approvedPermits: [], reviewStages: [] }, work: [], events: [] };
  const ctx = { fixtures: f, migrate: async () => {}, startApi: async () => ({ baseUrl: 'http://localhost' }), snapshot: async () => snapshot, assert: (_label, fn) => fn(), equal: assert.deepEqual, ok: assert.ok, pass: value => value,
    seed: async (value, options = {}) => { const valid = check(value); if (options.contractExpectation !== 'invalid') assert(valid, JSON.stringify(check.errors)); calls.push({ version: value.seedVersion, valid, marker: options.contractExpectation }); return { exitCode: calls.length <= 2 ? 0 : 1 }; } };
  await CASES.find(item => item.id === 'A-03').run(ctx);
  assert.deepEqual(calls.filter(c => c.marker).map(c => c.version.split('-').at(-1)), ['unknown', 'time']);
  assert(calls.filter(c => !c.marker).every(c => c.valid));
});

test('Permit malformed positive seed/request failures are author-origin, not model failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'permit-author-contract-'));
  try {
    await writeFile(join(root, 'contract.json'), JSON.stringify(contract));
    await symlink(new URL('../templates/contract-first/runtime.mjs', import.meta.url).pathname, join(root, 'runtime.mjs'));
    const boundary = await evaluatorContract(root);
    boundary.seed(f.main().seed);
    assert.throws(() => boundary.seed({ ...f.main().seed, extra: [] }), error => error.origin === 'evaluator');
    const request = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': f.key('raw') }, raw: JSON.stringify(f.submissionBody('raw')) };
    boundary.request('/api/v1/permit-applications', request);
    assert.throws(() => boundary.request('/api/v1/permit-applications', { ...request, raw: '{' }), error => error.origin === 'evaluator');
    boundary.request('/api/v1/permit-applications', { ...request, raw: '{', contractExpectation: 'invalid' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Fixed observations for author helper tests, not a candidate server or business implementation.
function repeatedStageTranscript({ wrongBinding = false, replayAddsVote = false } = {}) {
  const fixture = f.repeatedReviewerStages('stage-policy-test'), body = fixture.body;
  const applicationId = f.uuid('observed-application'), reviewerId = fixture.reviewerId, instant = f.at();
  const stages = body.stages.map((item, index) => ({ stageId: f.uuid(`observed-stage-${index}`), applicationId, revision: 1, ordinal: index + 1, name: item.name, policy: item.reviewPolicy, state: index === 0 ? 'ACTIVE' : 'PENDING', activatedAt: index === 0 ? instant : null, completedAt: null }));
  const revision = { ...fixture.revision, applicationId, fields: body.fields, canonicalDigest: sha256(canonicalJson(body.fields)), policy: body.stages[0].reviewPolicy };
  const application = { ...fixture.application, applicationId, applicantId: body.applicantId, deadlineAt: body.deadlineAt, currentStageOrdinal: 1, stages };
  const claim = index => ({ claimId: f.uuid(`observed-claim-${index}`), applicationId, revision: 1, reviewerId, role: 'security', state: 'LEASED', attempt: 1, leaseExpiresAt: f.at({ seconds: 3 }) });
  const claims = [claim(0), claim(1)];
  // Identical timestamps deliberately cannot identify a Stage.
  const decisions = [0, 1].map(index => ({ decisionId: f.uuid(`observed-decision-${index}`), applicationId, revision: 1, reviewerId, role: 'security', decision: 'APPROVE', reason: `stage-policy-test-decision-${index + 1}`, decidedAt: instant }));
  const completed = [{ ...stages[0], state: 'COMPLETED', completedAt: instant }, { ...stages[1], state: 'ACTIVE', activatedAt: instant }];
  const finalStages = [completed[0], { ...completed[1], state: 'COMPLETED', completedAt: instant }];
  const appAfterFirst = { ...application, currentStageOrdinal: 2, state: 'UNDER_REVIEW', stages: completed };
  const appFinal = { ...application, currentStageOrdinal: null, state: 'APPROVED', decisionRevision: 1, terminalAt: instant, stages: finalStages };
  const evidence = (items, count) => ({ items, evidence: items.map((stage, index) => ({ stageId: stage.stageId, claimIds: index < count ? [claims[index].claimId] : [], decisionIds: index < count ? [decisions[index].decisionId] : [] })) });
  const views = [evidence(stages, 0), evidence(completed, 1), evidence(finalStages, 2)];
  const sort = (records, keys) => [...records].sort((left, right) => { for (const key of keys) { const value = typeof left[key] === 'number' ? left[key] - right[key] : String(left[key]).localeCompare(String(right[key])); if (value) return value; } return 0; });
  const state = (app, claims, decisions, permit = []) => ({ asOf: instant, resources: {
    applicants: sort(f.applicants, ['applicantId']), reviewers: f.reviewers,
    permitApplications: [app], applicationRevisions: [revision],
    reviewClaims: sort(claims, ['applicationId', 'revision', 'claimId']),
    reviewDecisions: sort(decisions, ['applicationId', 'revision', 'decidedAt', 'decisionId']), approvedPermits: permit, reviewStages: app.stages,
  }, work: [], events: [] });
  const decided = item => ({ ...item, state: 'DECIDED', leaseExpiresAt: null });
  const afterFirst = state(appAfterFirst, [decided(claims[0])], [decisions[0]]);
  const afterSecondClaim = state(appAfterFirst, [decided(claims[0]), claims[1]], [decisions[0]]);
  const final = state(appFinal, claims.map(decided), decisions, [{ permitId: f.uuid('observed-permit'), applicationId, revision: 1, canonicalDigest: revision.canonicalDigest, issuedAt: instant }]);
  const replayState = structuredClone(afterSecondClaim);
  if (replayAddsVote) replayState.resources.reviewDecisions.push(decisions[1]);
  const lastView = structuredClone(views[2]);
  if (wrongBinding) [lastView.evidence[0].decisionIds, lastView.evidence[1].decisionIds] = [lastView.evidence[1].decisionIds, lastView.evidence[0].decisionIds];
  const queue = [
    ['create-application', 201, application], ['read-revision', 200, revision], ['read-stages', 200, views[0]],
    ['claim-review', 200, { ...claims[0], claimToken: 'stage-one-fence' }], ['decide-review', 200, appAfterFirst],
    ['verification-snapshot', 200, afterFirst], ['read-stages', 200, views[1]],
    ['claim-review', 200, { ...claims[1], claimToken: 'stage-two-fence' }], ['verification-snapshot', 200, afterSecondClaim],
    ['decide-review', 409, { error: { code: 'REVIEW_STAGE_CHANGED', message: 'Old Stage', details: {} } }],
    ['decide-review', 200, appAfterFirst], ['verification-snapshot', 200, replayState],
    ['decide-review', 200, appFinal], ['verification-snapshot', 200, final], ['read-stages', 200, lastView],
  ];
  const calls = [], validate = runtime.requestValidator(contract);
  const request = async (_base, path, options = {}) => {
    const route = runtime.matchOperation(contract.operations, options.method ?? 'GET', new URL(path, 'http://localhost').pathname);
    assert(route, path);
    const headers = { ...(options.json === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers };
    const result = validate(route.operation, { params: route.params, headers, body: options.json, hasBody: options.json !== undefined });
    assert(result.valid, `${route.operation.id}: ${JSON.stringify(result)}`);
    const [id, status, json] = queue.shift() ?? [];
    assert.equal(route.operation.id, id);
    const responseCheck = compile(status < 400 ? route.operation.response : route.operation.errors[status]);
    assert(responseCheck(json), JSON.stringify(responseCheck.errors));
    calls.push({ id, path, options: structuredClone(options) });
    return { status, json: structuredClone(json), text: JSON.stringify(json), headers: { 'content-type': 'application/json' } };
  };
  const ctx = { key: f.key, ok: assert.ok, equal: assert.deepEqual, assert: (_label, fn) => fn(), request,
    mutate: (base, path, key, json, options = {}) => request(base, path, { ...options, method: 'POST', headers: { 'idempotency-key': key }, json }),
    snapshot: async base => (await request(base, '/api/v1/verification-snapshot', { headers: { authorization: 'Bearer author-test' } })).json };
  return { ctx, body, calls, queue, views, final };
}

test('Permit actual private helper approves same Reviewer in same-name Stages through explicit evidence', async () => {
  const transcript = repeatedStageTranscript();
  const result = await exerciseRepeatedReviewerStages(transcript.ctx, 'http://localhost', transcript.body, 'stage-policy-test');
  assert.equal(transcript.queue.length, 0);
  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions[0].decidedAt, result.decisions[1].decidedAt);
  const writes = transcript.calls.filter(call => call.id === 'decide-review');
  assert.equal(writes.length, 4, 'first vote, stale-token rejection, saved replay, second vote');
  assert.deepEqual(writes[0].options.json, writes[2].options.json);
  assert.equal(writes[0].options.headers['idempotency-key'], writes[2].options.headers['idempotency-key']);
  assert.equal(writes[1].options.json.claimToken, writes[0].options.json.claimToken);
  assert.notEqual(writes[3].options.json.claimToken, writes[0].options.json.claimToken);
  assert(writes.every(call => !Object.hasOwn(call.options.json, 'stageId')), 'legacy Decision input stays unchanged');
});

test('Permit actual helper rejects swapped Stage bindings and old replay adding a current Stage vote', async () => {
  for (const fault of [{ wrongBinding: true }, { replayAddsVote: true }]) {
    const transcript = repeatedStageTranscript(fault);
    await assert.rejects(exerciseRepeatedReviewerStages(transcript.ctx, 'http://localhost', transcript.body, 'stage-policy-test'), /same Stage|immutable|add no current-Stage vote/);
  }
});

test('Permit vote oracle rejects a second role vote within one Stage but accepts cross-Stage reuse', () => {
  const { final, views } = repeatedStageTranscript();
  assertStageEvidence(views[2], { claims: final.resources.reviewClaims, decisions: final.resources.reviewDecisions });
  const stage = structuredClone(views[2].items[0]), reviewerId = final.resources.reviewDecisions[0].reviewerId;
  stage.policy.roles = [{ role: 'legal', eligibleReviewerIds: [reviewerId], requiredApprovals: 1, veto: false }, { role: 'security', eligibleReviewerIds: [reviewerId], requiredApprovals: 1, veto: false }];
  stage.policy.requiredTotalApprovals = 2;
  const decisions = final.resources.reviewDecisions.map((item, index) => ({ ...item, role: index === 0 ? 'legal' : 'security' }));
  const value = { items: [stage], evidence: [{ stageId: stage.stageId, claimIds: [], decisionIds: decisions.map(item => item.decisionId).sort() }] };
  assert.throws(() => assertStageEvidence(value, { decisions }), /one Decision per Reviewer per Revision per Stage, across roles/);
});
