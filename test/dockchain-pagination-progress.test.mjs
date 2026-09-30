import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/dockchain.mjs';
import { A_CASES } from '../evaluators/transfer/dockchain/v2/cases/a.mjs';
import { createFixtureFactory } from '../evaluators/transfer/dockchain/v2/fixtures/index.mjs';
import { CaseFailure } from '../evaluators/transfer/dockchain/v2/lib/execution.mjs';

function runCase(caseId, pages) {
  const fixtures = createFixtureFactory({ evaluationSeed: 'pagination-progress', caseId, baseTime: '2026-09-08T00:00:00.000Z' });
  const fixture = fixtures.portCall();
  const created = [], requested = [];
  const windows = Array.from({ length: 35 }, (_, index) => ({
    arrivalAt: fixture.at({ days: 2, minutes: index * 15 }),
    departureAt: fixture.at({ days: 2, minutes: index * 15 + 120 }),
    berthId: fixture.berths[0].berthId, tugPoolId: fixture.tugPools[0].tugPoolId, yardWindowId: fixture.yardWindows[0].yardWindowId,
  }));
  const ctx = {
    fixtures, key: fixtures.key, workspace: `pagination-${caseId}`, mark() {},
    forWorkspace() { return this; }, async npm() {}, async migrate() {}, async seed() {},
    async startApi() { return { baseUrl: 'http://pagination.test' }; },
    equal: assert.deepEqual,
    ok(value, label) { if (!value) throw new CaseFailure(label); },
    pass(value) { return { status: 'passed', ...value }; },
    async mutate(_base, _path, _key, body) {
      const call = fixture.v1Call(`created-${created.length}`, body);
      created.push(call);
      return { status: 201, json: call };
    },
    async request(base, path) {
      const url = new URL(path, base);
      if (url.pathname.startsWith('/api/v1/port-calls/')) return { status: 200, json: created[0] };
      if (url.pathname.endsWith('/schedule')) return { status: 200, json: {} };
      const index = requested.length;
      assert(index < pages.length, 'test sentinel: evaluator continued beyond the supplied pagination sequence');
      assert.equal(url.searchParams.get('cursor'), index ? pages[index - 1].cursor : null);
      requested.push(url.href);
      const rows = caseId === 'A-06' ? created : windows;
      return { status: 200, json: { items: pages[index].indices.map(index => structuredClone(rows[index])), nextCursor: pages[index].cursor } };
    },
    async snapshot() {
      return { asOf: fixture.at(), resources: Object.fromEntries(Object.keys(contract.schemas.SnapshotResources.properties).map(name => [name, []])), work: [], events: [] };
    },
  };
  return { run: () => A_CASES.find(item => item.id === caseId).run(ctx), requested };
}

for (const caseId of ['A-06', 'A-07']) {
  test(`${caseId}: actual author case accepts complete distinct pagination`, async () => {
    const limit = caseId === 'A-06' ? 37 : 17, count = caseId === 'A-06' ? 111 : 35;
    const pages = Array.from({ length: Math.ceil(count / limit) }, (_, page) => ({
      indices: Array.from({ length: Math.min(limit, count - page * limit) }, (_, index) => page * limit + index),
      cursor: (page + 1) * limit < count ? `opaque-${page + 1}` : null,
    }));
    const harness = runCase(caseId, pages);
    assert.equal((await harness.run()).status, 'passed');
    assert.equal(harness.requested.length, pages.length);
  });

  for (const [name, pages, expected] of [
    ['repeated cursor with new records', [{ indices: [0], cursor: 'same' }, { indices: [1], cursor: 'same' }], /pagination cursor must not repeat/],
    ['cursor cycle', [{ indices: [0], cursor: 'a' }, { indices: [1], cursor: 'b' }, { indices: [2], cursor: 'a' }], /pagination cursor must not repeat/],
    ['repeated record with a new cursor', [{ indices: [0], cursor: 'a' }, { indices: [0], cursor: 'b' }], /pagination item must not repeat/],
    ['repeated record on a terminal page', [{ indices: [0], cursor: 'a' }, { indices: [0], cursor: null }], /pagination item must not repeat/],
    ['duplicate records in one page', [{ indices: [0, 0], cursor: null }], /pagination item must not repeat/],
  ]) {
    test(`${caseId}: actual author case rejects ${name}`, async () => {
      const harness = runCase(caseId, pages);
      await assert.rejects(harness.run(), error => error instanceof CaseFailure && error.origin === 'candidate' && expected.test(error.message));
      assert.equal(harness.requested.length, pages.length);
    });
  }
}
