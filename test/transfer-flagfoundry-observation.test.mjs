import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/flagfoundry.mjs';
import { validator, requestValidator, matchOperation, openApi } from '../templates/contract-first/runtime.mjs';
import { assertFlag, assertFlagRevision, assertFlagRule, assertFlagSnapshot, snapshotFromRevision, assertOpenApiDocument } from '../evaluators/transfer/flagfoundry/v2/oracles/index.mjs';
import * as oracle from '../evaluators/transfer/flagfoundry/v2/oracles/index.mjs';
import { createFixtureFactory } from '../evaluators/transfer/flagfoundry/v2/fixtures/index.mjs';
import { checkUnmatchedEvaluation, checkWrongSnapshotOutcome, checkCapturedSchemaRace } from '../evaluators/transfer/flagfoundry/v2/cases/observations.mjs';

const validate = validator(contract);
test('FlagFoundry independent oracles use the published ASCII 1..64 range for every key surface', () => {
  const seed = contract.seed.example;
  for (const key of [' ', 'legal space', '\u0000', '\u007f', 'a'.repeat(64)]) {
    const flag = { ...seed.flags[0], key, createdAt: seed.activeRevisions[0].createdAt };
    const revision = structuredClone(seed.activeRevisions[0]);
    revision.defaultVariant = key; revision.variants[0].key = key;
    revision.rules = [{ ruleId: revision.revisionId, clauses: [{ attribute: key, operator: 'EQUALS', value: 'v' }], variantKey: key }];
    const artifact = snapshotFromRevision(revision, flag, flag.projectId, { ...seed.environments[0], contextAttributes: [key] });
    for (const [schema, value, oracle] of [['Flag', flag, assertFlag], ['FlagRevision', revision, assertFlagRevision], ['FlagRule', revision.rules[0], assertFlagRule], ['FlagSnapshot', artifact, assertFlagSnapshot]]) {
      assert(validate(contract.schemas[schema])(value), `${schema} legal public wire`);
      assert.doesNotThrow(() => oracle(value), `${schema} key ${JSON.stringify(key)}`);
    }
  }
  for (const key of ['', 'a'.repeat(65), 'é', '中']) {
    const flag = { ...seed.flags[0], key, createdAt: seed.activeRevisions[0].createdAt };
    assert.equal(validate(contract.schemas.Flag)(flag), false);
    assert.throws(() => assertFlag(flag));
  }
});

const factory = createFixtureFactory({ evaluationSeed: 'observation-regression', caseId: 'A-11', baseTime: '2032-04-05T06:07:08.000Z' });
const reply = (status, json) => ({ status, json, text: JSON.stringify(json) });
const errorReply = code => reply(409, { error: { code, message: code, details: {} } });
const assertions = { equal: assert.deepEqual, ok: assert.ok, assert: (_label, run) => run(), key: factory.key };
function publicState() {
  const seed = contract.seed.example;
  return { asOf: seed.activeRevisions[0].createdAt, resources: { projects: structuredClone(seed.projects), environments: structuredClone(seed.environments), flags: seed.flags.map(flag => ({ ...flag, createdAt: seed.activeRevisions[0].createdAt })), flagRevisions: structuredClone(seed.activeRevisions), flagSnapshots: [snapshotFromRevision(seed.activeRevisions[0], seed.flags[0], seed.flags[0].projectId, seed.environments[0])], progressiveRollouts: [], evaluationOutcomes: [] }, work: [], events: [] };
}

test('real no-rule helper rejects DEFAULT substitution and accepting unpublished context attributes', async () => {
  const family = factory.evaluation();
  const ctx = { ...assertions, evaluateFlag: async (_base, body) => Object.hasOwn(body.context, 'unpublishedAttribute') ? reply(400, { error: { code: 'INVALID_FLAG_RULE', message: 'unknown attribute', details: {} } }) : reply(200, oracle.expectedEvaluation(family.snapshot(), body)) };
  await checkUnmatchedEvaluation(ctx, 'http://author', family);
  const normal = ctx.evaluateFlag;
  ctx.evaluateFlag = async (base, body) => { const result = await normal(base, body); if (result.status === 200) result.json.reason = 'DEFAULT'; return result; };
  await assert.rejects(() => checkUnmatchedEvaluation(ctx, 'http://author', family));
  ctx.evaluateFlag = async (_base, body) => reply(200, oracle.expectedEvaluation(family.snapshot(), body));
  await assert.rejects(() => checkUnmatchedEvaluation(ctx, 'http://author', family));
});

test('real wrong-Snapshot helper verifies exact error and complete rollback; outcome IDs retain ordinary string syntax', async () => {
  const family = factory.rollout(), state = publicState(), rollout = { rolloutId: factory.uuid('rollout') };
  const values = ['', 'contains space', '标识', 'x'.repeat(257)].map((outcomeId, i) => family.outcome(i, { outcomeId }));
  const operation = contract.operations.find(op => op.id === 'outcome-batch');
  assert(validate(operation.request)({ outcomes: values }));
  let reads = 0, mutateState = false;
  const ctx = { ...assertions, snapshot: async () => { reads++; const value = structuredClone(state); if (mutateState && reads === 2) value.resources.projects[0].name = 'invalid partial effect'; return value; }, outcomeBatch: async (_base, id, body) => { assert.equal(id, rollout.rolloutId); assert.equal(body.outcomes.length, 2); assert.deepEqual(body.outcomes[0], values[0]); return errorReply('SNAPSHOT_MISMATCH'); } };
  await checkWrongSnapshotOutcome(ctx, 'http://author', family, rollout, values);
  reads = 0; mutateState = true;
  await assert.rejects(() => checkWrongSnapshotOutcome(ctx, 'http://author', family, rollout, values));
  mutateState = false; ctx.outcomeBatch = async () => errorReply('ROLLOUT_STALE');
  await assert.rejects(() => checkWrongSnapshotOutcome(ctx, 'http://author', family, rollout, values));
});

// Deterministic author-protocol simulation, not a reference submission or live business certification.
function schemaProtocol(fault) {
  const family = factory.contention(), state = publicState(), env = structuredClone(family.environment);
  state.resources = { projects: [family.project], environments: [env], flags: [{ ...family.stringFlag, createdAt: family.stringActive.createdAt }], flagRevisions: [structuredClone(family.stringActive)], flagSnapshots: [family.snapshot()], progressiveRollouts: [], evaluationOutcomes: [] };
  const captured = new Map(), replay = new Map(), trace = [];
  const ctx = { ...assertions, snapshot: async () => structuredClone(state), stop: async () => {}, waitFor: async predicate => { const value = await predicate(); assert(value, 'required observed state'); return value; },
    createRevision: async (_base, flagId, body) => {
      assert.equal(flagId, family.stringFlag.flagId);
      const revision = { ...structuredClone(family.stringActive), revisionId: factory.uuid(`schema-${state.resources.flagRevisions.length}`), revision: state.resources.flagRevisions.length + 1, ...body, state: 'COMPILING', snapshotDigest: null, activatedAt: null };
      delete revision.expectedActiveRevision;
      captured.set(revision.revisionId, structuredClone(env)); state.resources.flagRevisions.push(revision); trace.push('create'); return reply(202, structuredClone(revision));
    },
    startWorker: async () => {
      for (const revision of state.resources.flagRevisions.filter(row => row.state === 'COMPILING')) {
        if (captured.get(revision.revisionId).schemaRevision !== env.schemaRevision && fault !== 'stale-compiles') revision.state = 'REJECTED';
        else { revision.state = 'READY'; const artifact = snapshotFromRevision(revision, family.stringFlag, family.project.projectId, captured.get(revision.revisionId)); revision.snapshotDigest = oracle.snapshotDigest(artifact); state.resources.flagSnapshots.push(artifact); }
      }
      return {};
    },
    mutate: async (_base, path, key, body, options) => {
      trace.push('schema'); assert(options.admin); assert.match(path, /\/context-schema$/);
      const route = matchOperation(contract.operations, 'POST', path);
      assert(requestValidator(contract)(route.operation, { params: route.params, query: {}, headers: { authorization: 'Bearer public', 'idempotency-key': key, 'content-type': 'application/json' }, body, hasBody: true }).valid);
      if (!replay.has(key)) { env.contextAttributes = [...body.contextAttributes]; env.schemaRevision++; replay.set(key, structuredClone(env)); }
      return reply(200, replay.get(key));
    },
    activateRevision: async () => fault === 'stale-activates' ? reply(200, {}) : errorReply('ACTIVE_REVISION_CHANGED'),
    request: async (_base, path) => {
      assert.match(path, /\/findings$/); const revision = state.resources.flagRevisions.find(row => path.includes(row.revisionId));
      return reply(200, revision.state === 'REJECTED' && fault !== 'no-findings' ? [{ code: 'STALE_CONTEXT_SCHEMA', path: '/environment', message: 'Captured schema changed' }] : []);
    },
  };
  return { ctx, family, trace };
}
test('real schema-race helper mutates published Environment after capture and rejects stale publication or missing findings', async () => {
  const good = schemaProtocol();
  const result = await checkCapturedSchemaRace(good.ctx, 'http://author', good.family, 'regression');
  assert.equal(result.schemaRevision, good.family.environment.schemaRevision + 1);
  assert.deepEqual(good.trace.slice(0, 3), ['create', 'create', 'schema']);
  for (const fault of ['stale-compiles', 'stale-activates', 'no-findings']) {
    const bad = schemaProtocol(fault);
    await assert.rejects(() => checkCapturedSchemaRace(bad.ctx, 'http://author', bad.family, 'regression'), fault);
  }
});

test('CompilationFinding assertions reject missing, unsorted, malformed or changed rejection evidence', () => {
  assert.equal(typeof oracle.assertCompilationFindings, 'function');
  const findings = [{ code: 'STALE', path: '/environment', message: 'Captured schema changed' }];
  assert.doesNotThrow(() => oracle.assertCompilationFindings(findings, { rejected: true }));
  for (const bad of [[], [{ ...findings[0], code: '' }], [{ ...findings[0], extra: true }], [{ ...findings[0], path: 'environment' }], [{ code: 'Z', path: '/z', message: 'z' }, findings[0]]]) {
    assert.throws(() => oracle.assertCompilationFindings(bad, { rejected: true }));
  }
  assert.throws(() => oracle.assertCompilationFindings([{ ...findings[0], message: 'rewritten' }], { rejected: true, previous: findings }));
});

test('legacy activation observation rejects synthetic Manager rows and standalone steps reject even reused V1 events', () => {
  assert.equal(typeof oracle.assertLegacyActivationPersistence, 'function');
  assert.equal(typeof oracle.assertStandaloneRolloutEvents, 'function');
  const before = { resources: { progressiveRollouts: [{ rolloutId: 'existing', state: 'RUNNING' }], evaluationOutcomes: [] }, work: [], events: [] };
  const after = structuredClone(before); after.resources.progressiveRollouts[0].state = 'STALE';
  assert.doesNotThrow(() => oracle.assertLegacyActivationPersistence(before, after));
  for (const mutate of [s => s.resources.progressiveRollouts.push({ rolloutId: 'invented' }), s => s.resources.evaluationOutcomes.push({ outcomeId: 'invented' }), s => s.work.push({ workId: 'invented', kind: 'ROLLOUT_DEADLINE' })]) {
    const bad = structuredClone(after); mutate(bad); assert.throws(() => oracle.assertLegacyActivationPersistence(before, bad));
  }
  assert.doesNotThrow(() => oracle.assertStandaloneRolloutEvents(before, after));
  assert.throws(() => oracle.assertStandaloneRolloutEvents(before, { ...after, events: [{ type: 'flag.revision-activated' }] }));
});

test('FlagFoundry publishes independent findings and Environment-schema mutation without widening resource shapes', () => {
  const findings = contract.operations.find(op => op.id === 'compilation-findings');
  const update = contract.operations.find(op => op.id === 'update-context-schema');
  assert(findings, 'CompilationFinding needs a public observation route');
  assert(update, 'captured schema races need a public mutation route');
  assert.equal(findings.path, '/api/v1/flag-revisions/:revisionId/findings');
  assert.equal(findings.method, 'GET');
  const checkFindings = validate(findings.response);
  assert(checkFindings([{ code: 'STALE', path: '/environment', message: 'Captured Environment schema changed' }]));
  assert.equal(checkFindings({ findings: [] }), false, 'no private envelope');
  assert.equal(checkFindings([{ code: 'STALE', path: '/', message: 'changed', privateToken: 'x' }]), false);
  assert.equal(update.path, '/api/v1/projects/:projectId/environments/:environment/context-schema');
  const path = `/api/v1/projects/${contract.seed.example.projects[0].projectId}/environments/production/context-schema`;
  const route = matchOperation(contract.operations, 'POST', path);
  const request = requestValidator(contract);
  const input = { params: route.params, query: {}, headers: { authorization: 'Bearer test', 'content-type': 'application/json', 'idempotency-key': 'schema-update' }, body: { contextAttributes: ['region', 'subjectKey'] }, hasBody: true };
  assert.equal(request(route.operation, input).valid, true);
  assert.equal(request(route.operation, { ...input, body: { contextAttributes: ['x'], unexpected: true } }).valid, false);
  assert.equal(request(route.operation, { ...input, headers: { 'content-type': 'application/json', 'idempotency-key': 'schema-update' } }).valid, false);
  assert.doesNotThrow(() => assertOpenApiDocument(openApi(contract)));
  const incomplete = openApi(contract); delete incomplete.paths['/api/v1/flag-revisions/{revisionId}/findings'];
  assert.throws(() => assertOpenApiDocument(incomplete), 'public finding route must not disappear');
});
