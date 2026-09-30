import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { createCaseContext as geoContext, isClaimedWorkerBarrier } from '../evaluators/learning/geopulse/v2/lib/runtime.mjs';
import { killLeasedWork } from '../evaluators/learning/geopulse/v2/cases/helpers.mjs';
import { createCaseContext as importContext } from '../evaluators/learning/importworks/v2/lib/runtime.mjs';
import { createCaseContext as ledgerContext } from '../evaluators/learning/ledgerbridge/v2/lib/runtime.mjs';
import { statementAll } from '../evaluators/learning/ledgerbridge/v2/cases/helpers.mjs';
import { createMergeRequest, getJson, assertChange, assertRevision } from '../evaluators/learning/mergeboard/v2/cases/helpers.mjs';
import { documentDigest } from '../evaluators/learning/mergeboard/v2/oracles/index.mjs';
import { assertReportBytes } from '../evaluators/learning/importworks/v2/cases/helpers.mjs';
import { canonical, sha256 } from '../evaluators/learning/importworks/v2/lib/oracle.mjs';

const root = resolve(import.meta.dirname, '..');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const timestamp = '2026-09-08T00:00:00.000Z';

test('GeoPulse claimed barrier performs authenticated real HTTP hold/release and rejects undeclared fields', async t => {
  const ctx = await geoContext({ caseId: 'C-01', workspace: root, evaluationSeed: 'claimed-regression', manageDatabase: false });
  t.after(() => ctx.teardown());
  const barrier = await ctx.barrier({ hold: () => true });
  const body = { point: 'worker.claimed', workId: id(1), kind: 'LOCATION_EVALUATION', aggregateId: id(2) };
  assert.equal(isClaimedWorkerBarrier(body), true);
  assert.equal(isClaimedWorkerBarrier({ ...body, beforeCommit: true }), false);
  const send = (token, json) => fetch(barrier.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-barrier-token': token }, body: JSON.stringify(json) });
  assert.equal((await send('wrong', body)).status, 401);
  assert.equal((await send(barrier.token, { ...body, hiddenTable: 'work' })).status, 400);
  let returned = false;
  const request = send(barrier.token, body).then(response => { returned = true; return response; });
  const held = await barrier.waitFor(({ json }) => json.workId === body.workId, { timeoutMs: 2_000 });
  await tick();
  assert.equal(returned, false, 'real HTTP response must remain held before worker effects');
  barrier.release(held);
  assert.equal((await request).status, 204);
});

test('GeoPulse recovery helper observes held public Work before SIGKILL, never races a fast effect', async () => {
  const order = [], body = { point: 'worker.claimed', workId: id(1), kind: 'LATE_REPLAY', aggregateId: id(2) };
  const row = { workId: id(1), kind: body.kind, aggregateId: id(2), state: 'LEASED', terminal: false, attempt: 1, leaseOwner: 'worker', leaseExpiresAt: timestamp };
  const ctx = {
    barrier: async () => ({ url: 'http://control.test', token: 'test-token', waitFor: async predicate => { assert.ok(predicate({ json: body })); order.push('held'); return { json: body }; }, release: () => order.push('released') }),
    startWorker: async options => { assert.equal(options.env.TEST_BARRIER_URL, 'http://control.test'); order.push('spawn'); return {}; },
    snapshot: async () => { order.push('snapshot'); return { work: [row] }; },
    waitFor: async operation => { const value = await operation(); assert.ok(value); return value; },
    kill: async () => order.push('kill'), mark: () => {},
    equal: (a, b, label) => assert.deepEqual(a, b, label), ok: (value, label) => assert.ok(value, label),
  };
  await killLeasedWork(ctx, 'http://candidate.test', { kind: body.kind, aggregateId: body.aggregateId });
  assert.deepEqual(order, ['spawn', 'held', 'snapshot', 'kill', 'released', 'snapshot']);
  ctx.snapshot = async () => ({ work: [{ ...row, workId: id(3) }] });
  await assert.rejects(killLeasedWork(ctx, 'http://candidate.test', { kind: body.kind, aggregateId: body.aggregateId }), /held claim corresponds/);
});

for (const [task, createContext, caseId] of [['importworks', importContext, 'A-03'], ['ledgerbridge', ledgerContext, 'A-05']]) {
  test(`${task} successful real assertions no longer require a fake blocked diagnostic at finish`, async t => {
    const ctx = await createContext({ caseId, workspace: root, evaluationSeed: 'no-placeholder', manageDatabase: false });
    t.after(() => ctx.teardown());
    ctx.assert('business assertion was actually evaluated', () => assert.equal(2 + 2, 4));
    const evidence = ctx.evidence.finish();
    assert.equal(evidence.assertions.length, 1);
    assert.equal(Object.hasOwn(evidence, 'blockedAssertions'), false);
  });
}

async function httpPeer(t, select) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const call = { method: request.method, path: request.url, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call); const output = select(call);
    response.writeHead(output.status ?? 200, { 'content-type': 'application/json' }); response.end(JSON.stringify(output.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (base, path, options) => { const response = await fetch(`${base}${path}`, options); return { status: response.status, json: await response.json() }; };
  return { base, calls, request };
}

test('one-leg Statements use the already public legId on actual paginated HTTP reads', async t => {
  let omitId = false;
  const item = { postingId: id(1), transferId: id(2), kind: 'TRANSFER', direction: 'CREDIT', amountMinor: 7, balanceAfterMinor: 7, createdAt: timestamp, legId: id(3) };
  const peer = await httpPeer(t, () => { const row = { ...item }; if (omitId) delete row.legId; return { body: { items: [row], nextCursor: null } }; });
  const ctx = { getStatement: (base, accountId, query) => peer.request(base, `/api/v1/accounts/${accountId}/statement?${query}`), equal: (_label, a, b) => assert.deepEqual(a, b), assert: (_label, check) => check(), ok: (_label, value) => assert.ok(value) };
  assert.deepEqual(await statementAll(ctx, peer.base, id(4), 1), [item]);
  assert.match(peer.calls[0].path, /\/statement\?limit=1$/);
  omitId = true;
  await assert.rejects(statementAll(ctx, peer.base, id(4), 1), /Statement item/);
});

test('MergeBoard real HTTP helper accepts public 200/items, rejects invented 201/bare-array wire', async t => {
  let wrong = false;
  const branch = { branchId: id(1), documentId: id(2), name: 'main', sourceBranchId: null, sourceRevision: 0, headRevision: 0, state: 'ACTIVE', createdAt: timestamp };
  const merge = { mergeRequestId: id(3), documentId: id(2), sourceBranchId: id(4), targetBranchId: id(1), sourceHeadRevision: 1, targetHeadRevision: 0, state: 'IN_REVIEW', reviewPolicy: { reviewerIds: [id(5)], requiredApprovals: 1 }, approvals: [], mergeOperations: [], conflicts: [], resultDigest: 'a'.repeat(64), mergedTargetRevision: null, createdAt: timestamp, terminalAt: null };
  const peer = await httpPeer(t, call => call.method === 'GET' ? { body: wrong ? [branch] : { items: [branch] } } : { status: wrong ? 201 : 200, body: merge });
  const ctx = { key: () => 'public-key', request: peer.request, mutate: (base, path, key, body) => peer.request(base, path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }), equal: (a, b, label) => assert.deepEqual(a, b, label), ok: (value, label) => assert.ok(value, label) };
  assert.deepEqual(await getJson(ctx, peer.base, `/api/v1/documents/${id(2)}/branches`, 'branches'), [branch]);
  assert.deepEqual(await createMergeRequest(ctx, peer.base, id(2), { sourceBranchId: id(4), targetBranchId: id(1), expectedSourceHeadRevision: 1, expectedTargetHeadRevision: 0, reviewPolicy: merge.reviewPolicy }), merge);
  wrong = true;
  await assert.rejects(getJson(ctx, peer.base, `/api/v1/documents/${id(2)}/branches`, 'branches'), /public Branch list/);
  await assert.rejects(createMergeRequest(ctx, peer.base, id(2), {}), /create Merge Request status/);
  assert.ok(peer.calls.some(call => call.method === 'POST'));
});

test('MergeBoard response-only digest/provenance is checked without weakening stored objects', () => {
  const operation = { op: 'DELETE', blockId: id(2), expectedText: 'a' };
  const change = { changeId: id(3), documentId: id(1), clientId: id(4), clientSequence: 1, baseRevision: 0, operations: [operation], state: 'APPLIED', revision: 1, conflicts: [], createdAt: timestamp, canonicalDigest: 'a'.repeat(64) };
  assert.doesNotThrow(() => assertChange(change, { legacy: true, response: true }));
  assert.throws(() => assertChange({ ...change, canonicalDigest: 'wrong' }, { legacy: true, response: true }));
  assert.throws(() => assertChange(change, { legacy: true, response: false }), /fields/);
  const revision = { documentId: id(1), revision: 1, blocks: [], changeId: id(3), canonicalDigest: documentDigest(id(1), 1, []), createdAt: timestamp, provenance: { snapshotRevision: null, changeIds: [id(3)] } };
  assert.doesNotThrow(() => assertRevision(revision, { legacy: true, read: true }));
  assert.throws(() => assertRevision({ ...revision, provenance: { snapshotRevision: 2, changeIds: [] } }, { legacy: true, read: true }));
});

test('download byte oracle rejects plausible metadata with changed bytes or wrong digest', () => {
  const finding = { findingId: id(1), importId: id(2), rowNumber: 1, externalRowId: 'one', field: 'age', code: 'WRONG_TYPE', message: 'Invalid value', valueDigest: 'a'.repeat(64) };
  const bytes = Buffer.from(`${canonical(finding)}\n`);
  const ctx = { equal: (_label, a, b) => assert.deepEqual(a, b), sha256 };
  assert.doesNotThrow(() => assertReportBytes(ctx, bytes, [finding], { sha256: sha256(bytes) }));
  assert.throws(() => assertReportBytes(ctx, Buffer.concat([bytes, Buffer.from(' ')]), [finding], { sha256: sha256(bytes) }));
  assert.throws(() => assertReportBytes(ctx, bytes, [finding], { sha256: '0'.repeat(64) }));
});

test('all four current manifests retain real cases with no latent blocked assertions', async () => {
  for (const task of ['importworks', 'ledgerbridge', 'geopulse', 'mergeboard']) {
    const manifest = JSON.parse(await readFile(resolve(root, `evaluators/learning/${task}/v2/manifest.v2.json`)));
    assert.equal(manifest.cases.length, 22);
    assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
    assert.ok(manifest.cases.every(item => !item.blockedAssertions));
    assert.deepEqual(manifest.specGaps, []);
  }
});
