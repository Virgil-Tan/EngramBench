import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import contract from '../contracts/transfer/flagfoundry.mjs';
import { openApi } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/flagfoundry/v2/fixtures/index.mjs';
import { D_CASES } from '../evaluators/transfer/flagfoundry/v2/cases/d.mjs';
import { expectedEvaluation, canonicalJson } from '../evaluators/transfer/flagfoundry/v2/oracles/index.mjs';
import { CandidateResponseError } from '../src/task-evaluator-v2/runtime.mjs';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';

const response = (status, json) => ({ status, json, text: JSON.stringify(json) });
function environment(caseId) {
  const fixtures = createFixtureFactory({ evaluationSeed: 'owned-rejections', caseId, baseTime: '2026-09-08T00:00:00.000Z' });
  const family = fixtures.browser(), revisions = [];
  const rollout = { rolloutId: fixtures.uuid('rollout'), flagId: family.stringFlag.flagId, environment: family.environment.name,
    priorRevisionId: family.stringActive.revisionId, candidateRevisionId: fixtures.uuid('revision-2'), state: 'RUNNING', currentStepIndex: 0,
    steps: [{ stepIndex: 0, candidateExposureBasisPoints: 10000, minimumEvaluationCount: 2, maximumFailureBasisPoints: 0,
      observationSeconds: 60, successCount: 0, failureCount: 0, state: 'OBSERVING', startedAt: fixtures.at(),
      observationDeadlineAt: fixtures.at({ seconds: 60 }), completedAt: null }], createdAt: fixtures.at(), terminalAt: null };
  const state = () => ({ resources: { flagRevisions: revisions, flagSnapshots: revisions.map(r => family.snapshot(family.stringFlag, r)), progressiveRollouts: [rollout] }, work: [], events: [] });
  const ctx = {
    caseId, fixtures, key: fixtures.key, uuid: fixtures.uuid, adminToken: 'private-test', mark() {},
    async migrate() {}, async seed() {}, async npm() {}, async startApi() { return { baseUrl: 'http://case.invalid' }; },
    async startWorker() { return {}; }, defer() {}, async sleep() { await tick(); },
    equal: assert.deepEqual, ok: assert.ok, assert: (_label, operation) => operation(), canonical: canonicalJson,
    pass: value => ({ status: 'passed', ...value }),
    async openApi() { return response(200, openApi(contract)); },
    async request() { return response(200, {}); },
    async createFlag(_base, body) { return response(201, { ...body, flagId: fixtures.uuid('created-flag'), createdAt: fixtures.at() }); },
    async createRevision() {
      const revision = { ...family.activeRevision(family.stringFlag, { revisionId: fixtures.uuid(`revision-${revisions.length + 1}`), revision: revisions.length + 2 }), state: 'READY', activatedAt: null };
      revisions.push(revision);
      return response(202, { ...revision, state: 'COMPILING', snapshotDigest: null });
    },
    async activateRevision() { return response(200, revisions[0]); },
    async evaluateFlag(_base, body) { return response(200, expectedEvaluation(family.snapshot(), body)); },
    async snapshot() { return state(); }, async waitFor(operation) { const value = await operation(); assert(value, 'test state reached the requested seam'); return value; },
    async revisions() { return response(200, { items: revisions, nextCursor: null }); },
    async revision() { return response(200, revisions[0]); }, async flagRevisions() { return response(200, { items: revisions, nextCursor: null }); },
    async revisionDiff() { return response(200, {}); }, async domainEvents() { return response(200, { items: [], nextCursor: null }); },
    async progressiveActivate() { return response(202, rollout); }, async outcomeBatch() { return response(200, { acceptedIds: [], duplicateIds: [] }); },
    async rollout() { return response(200, rollout); },
  };
  return { ctx, family, fixtures, revisions, rollout, state };
}

async function d01(mode) {
  const { ctx } = environment('D-01');
  const schemaBoundary = new Error('reached unchanged OpenAPI response validation');
  const create = ctx.createFlag;
  let negative = false;
  ctx.createFlag = async (base, body, options) => {
    if (!body.bad) return create(base, body, options);
    negative = true;
    assert.deepEqual(body, { bad: true });
    assert.equal(options.contractExpectation, 'invalid', 'actual D01 negative request must be explicitly marked');
    return response(mode === 'wrong-status' ? 500 : 400, { error: { code: mode === 'wrong-code' ? 'INTERNAL_ERROR' : 'UNKNOWN_FIELD', message: 'unknown field', details: {} } });
  };
  ctx.assert = (label, operation) => {
    if (label.endsWith(' schema')) { assert(negative); throw schemaBoundary; }
    return operation();
  };
  await assert.rejects(D_CASES.find(item => item.id === 'D-01').run(ctx), error => mode === 'valid'
    ? error === schemaBoundary : error !== schemaBoundary && /500|INTERNAL_ERROR/.test(error.message));
  assert(negative);
}

async function d07(stage, first) {
  const { ctx, revisions, rollout } = environment('D-07');
  const actionError = new Error(`injected UI action failure ${stage}`);
  const { EventEmitter } = await import('node:events');
  const events = new EventEmitter();
  let waits = 0, pending = false, finished = false;
  const control = {
    first() { return this; }, or() { return this; }, and() { return this; },
    nth() { return this; }, filter() { return this; }, getByRole() { return this; }, getByLabel() { return this; },
    locator() { return this; },
    async count() { return 1; }, async isVisible() { return true; },
    async waitFor() {}, async fill() {}, async innerText() { return 'visible fixture'; },
    async evaluate() { return 'input'; },
    async click() {
      if (!pending) return;
      pending = false;
      const index = waits;
      const path = index === 1 ? `/api/v1/flag-revisions/${revisions[1].revisionId}/progressive-activate`
        : index === 2 ? '/api/v1/evaluations' : `/api/v1/progressive-rollouts/${rollout.rolloutId}/outcome-batches`;
      const request = { method: () => 'POST', url: () => `http://case.invalid${path}`, failure: () => ({ errorText: 'injected network failure' }) };
      events.emit('request', request);
      if (index === stage) {
        finished = true;
        if (first === 'action') {
          queueMicrotask(() => events.emit('requestfailed', request));
          throw actionError;
        }
        events.emit('requestfailed', request); await tick(); return;
      }
      events.emit('response', { request: () => request, status: () => index === 1 ? 202 : 200,
        async json() { return index === 1 ? rollout : index === 2
          ? { rolloutId: rollout.rolloutId, revisionId: revisions[1].revisionId, snapshotDigest: revisions[1].snapshotDigest }
          : { acceptedIds: ['d07-rollout-outcome'] }; } });
    },
  };
  const page = { getByRole: () => control, getByLabel: () => control, locator: () => control, async goto() {}, async waitForLoadState() {},
    on(name, listener) { if (name === 'response') { waits++; pending = true; } events.on(name, listener); },
    off: events.off.bind(events),
  };
  ctx.loadChromium = async () => ({ async launch() { return { async newPage() { return page; }, async close() {} }; } });
  await assert.rejects(D_CASES.find(item => item.id === 'D-07').run(ctx), error => first === 'action'
    ? error === actionError : error.code === 'EVALUATOR_UI_REQUEST_FAILED');
  await tick(); await tick();
  assert.equal(waits, stage); assert(finished);
  assert.deepEqual(events.eventNames(), [], 'all actual D07 observation listeners are removed');
}
async function e04(first) {
  const { ctx, family } = environment('E-04');
  const pair = { project: family.project, flag: family.stringFlag, environment: family.environment, revision: family.stringActive, snapshot: family.snapshot() };
  const monitorError = new CandidateResponseError('verification snapshot returned 500', response(500, { error: { code: 'INTERNAL_ERROR' } }));
  const workloadError = new Error('injected compilation workload failure');
  const completed = new Error('reached post-monitor business assertions');
  let phase = 0, reads = 0, monitorSettled = false, windows = [];
  const perf = await import('../evaluators/transfer/flagfoundry/v2/cases/perf.mjs');
  mock.module(new URL('../evaluators/transfer/flagfoundry/v2/cases/perf.mjs', import.meta.url), { namedExports: {
    ...perf,
    async writePerformanceSeed() { phase++; return { path: 'in-memory-test-seed', pairs: [pair], uuid: ctx.uuid }; },
    async closedLoopWindow(_ctx, values, concurrency, seconds, operation) {
      windows.push([phase, concurrency, seconds]);
      if (phase === 1) { const result = await operation(values[0], 0); return Array(seconds === 60 ? 120000 : 1).fill({ response: result, durationMs: 1 }); }
      if (first === 'workload') throw workloadError;
      await tick();
      const result = await operation(values[0], 0);
      await tick();
      return [{ response: result, durationMs: 1 }];
    },
  } });
  const { E_CASES } = await import('../evaluators/transfer/flagfoundry/v2/cases/e.mjs');
  ctx.seedFile = async () => {};
  ctx.resetDatabase = async () => {};
  ctx.stop = async () => {};
  const state = ctx.snapshot;
  ctx.snapshot = async () => {
    reads++;
    if (reads === 1) { await tick(); monitorSettled = true; if (first === 'monitor') throw monitorError; }
    return state();
  };
  ctx.ok = (value, label) => { if (label === 'Compilation >=100 READY/s') throw completed; assert.ok(value, label); };
  const entry = E_CASES.find(item => item.id === 'E-04');
  const expected = first === 'monitor' ? monitorError : first === 'workload' ? workloadError : completed;
  await assert.rejects(entry.run(ctx), error => error === expected);
  assert(monitorSettled, 'main case must await monitor recovery before returning');
  const readsAtReturn = reads;
  await tick(); await tick();
  assert.equal(reads, readsAtReturn, 'no snapshot monitoring continues after the case returns');
  assert.deepEqual(windows.slice(0, 2), [[1, 64, 10], [1, 64, 60]], 'production load settings are preserved');
  if (first === 'monitor') {
    const result = await executeCase({ definition: { id: 'E-04', dimension: 'E', weight: 1 }, implementation: { async run() { throw monitorError; } },
      withContext: async (_options, operation) => operation({}), contextOptions: {}, failureCodePrefix: 'FF_E_04_' });
    assert.equal(result.status, 'failed'); assert.match(result.privateMessage, /500/);
  }
}

if (process.argv[2] === 'D01') await d01(process.argv[3]);
else if (process.argv[2] === 'D07') await d07(Number(process.argv[3]), process.argv[4]);
else if (process.argv[2] === 'E04') await e04(process.argv[3]);
else {
  for (const mode of ['valid', 'wrong-status', 'wrong-code']) test(`FlagFoundry D01 preserves negative request and response assertions: ${mode}`, () => run('D01', mode));
  for (const stage of [1, 2, 3]) for (const first of ['wait', 'action']) test(`FlagFoundry D07 owns wait ${stage} when ${first} fails first`, () => run('D07', String(stage), first));
  for (const first of ['monitor', 'workload', 'complete']) test(`FlagFoundry E04 owns monitor lifecycle: ${first}`, () => run('E04', first));
}
function run(...args) {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--unhandled-rejections=strict', fileURLToPath(import.meta.url), ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
}
