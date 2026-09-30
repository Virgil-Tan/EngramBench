import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CASES } from '../evaluators/learning/routeweave/v2/cases/index.mjs';
import { createCaseContext } from '../evaluators/learning/routeweave/v2/lib/runtime.mjs';

// These are evaluator fault-injection tests, not executions of a candidate.
async function runRestartOracle(t, fault) {
  const ctx = await createCaseContext({ caseId: 'E-01', workspace: resolve(import.meta.dirname, '..'), evaluationSeed: 'restart-oracle', baseTime: '2026-09-08T00:00:00.000Z', manageDatabase: false });
  t.after(() => ctx.teardown());
  const phases = [];
  let state, apiCount = 0, scanCount = 0;
  ctx.migrate = async () => {
    phases.push('initialize');
    if (fault === 'lost-resource' && apiCount === 1) state.resources.shipments = [];
  };
  ctx.seed = async seed => {
    const { schemaVersion, seedVersion: _seedVersion, importedAt, ...resources } = seed;
    state = { schemaVersion, asOf: importedAt, resources: { ...resources, consignments: [], parcelPieces: [], pieceProjections: [] }, work: [], events: [] };
  };
  ctx.startApi = async () => { phases.push('start-api'); return { role: 'api', id: ++apiCount, baseUrl: 'http://127.0.0.1:1' }; };
  ctx.startWorker = async () => { phases.push('start-worker'); return { role: 'worker', child: { exitCode: null } }; };
  ctx.kill = async role => {
    phases.push(`kill-${role.role}`);
    if (fault === 'commit-before-worker-kill' && role.role === 'worker') {
      state.resources.consignments[0].sequence += 1;
      state.work.push({ workId: ctx.uuid('current-projection'), kind: 'CONSIGNMENT_PROJECT', terminal: true });
    }
  };
  ctx.snapshot = async () => {
    if (state.resources.consignments.length && apiCount === 1) {
      assert.ok(phases.includes('kill-worker'), 'persistent baseline is captured only after the worker stops');
    }
    return structuredClone(state);
  };
  ctx.scanShipment = async (_url, body) => {
    scanCount += 1;
    if (scanCount === 1) state.resources.scanEvents.push({ scanEventId: ctx.uuid('scan'), scannerEventId: body.scannerEventId });
    if (fault === 'duplicate-effect' && scanCount === 2) state.events.push({ eventId: ctx.uuid('unexpected-replay-event') });
    return { status: 200, json: { scannerEventId: body.scannerEventId, accepted: fault === 'changed-replay' && scanCount === 2 ? false : true } };
  };
  ctx.createConsignment = async (_url, body) => {
    const consignmentId = ctx.uuid('consignment'), createdAt = ctx.at();
    const consignment = { consignmentId, tenantId: body.tenantId, externalRef: body.externalRef, routePlanId: ctx.uuid('consignment-route'), routePlanRevision: 1, state: 'PLANNED', createdAt, updatedAt: createdAt, sequence: 0 };
    const pieces = body.pieceRefs.map((pieceRef, index) => ({ pieceId: ctx.uuid(`piece-${index}`), consignmentId, pieceRef, legacyShipmentId: null, state: 'PLANNED', createdAt, terminalAt: null }));
    state.resources.consignments.push(consignment); state.resources.parcelPieces.push(...pieces);
    return { status: 200, json: { consignment, pieces } };
  };
  await CASES.find(({ id }) => id === 'E-01').run(ctx);
  assert.deepEqual(phases, ['initialize', 'start-api', 'start-worker', 'kill-worker', 'kill-api', 'initialize', 'initialize', 'start-api']);
  assert.equal(scanCount, 2, 'saved request is actually replayed after restart');
}

test('current persistence oracle accepts stable state only after kill/restart and replay', t => runRestartOracle(t));
test('current persistence oracle includes a lawful final worker commit in its stopped baseline', t => runRestartOracle(t, 'commit-before-worker-kill'));
for (const fault of ['lost-resource', 'changed-replay', 'duplicate-effect']) {
  test(`current persistence oracle rejects ${fault}`, async t => {
    await assert.rejects(runRestartOracle(t, fault), /survive|replay|effect|resources/i);
  });
}
